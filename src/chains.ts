import { readFileSync } from "node:fs";
import { createPublicClient, custom, type PublicClient } from "viem";

/**
 * The networks this indexer reads: every one with an RPC_URL_<chainId> (your node). data/chains.json says what's on
 * each (its USDC, wrapped coin, Uniswap v3 factory, and the well-known tokens checked first).
 */
export type Tok = { address: `0x${string}`; symbol: string; decimals: number };
export type ChainCfg = {
  id: number;
  name: string;
  native: { symbol: string; name: string };
  usdc: `0x${string}` | null;
  nativeIsUsdc: boolean;
  wrapped: `0x${string}` | null;
  uniV3Factory: `0x${string}` | null;
  v2Factories?: `0x${string}`[]; // Uniswap v2 and its copies (getPair), for prices
  tokens: Tok[];
  rpc: string;
  client: PublicClient;
  fromBlock: bigint; // the oldest block a scan goes back to (FROM_BLOCK_<chainId>, else 0)
};

/**
 * The connection to your node, gentle by default: at most `limit` requests at once and `rps` a second (RPC_CONCURRENCY
 * 4, RPC_RPS 5; your own node can take more), a slow-down answer (429, 503) waited out and asked again (up to 5
 * times, longer each time), and short errors. viem's own put the whole request in every error message: under load,
 * hundreds of multi-megabyte messages filled the memory (11-15).
 */
function node(url: string, limit: number, rps: number) {
  let running = 0, id = 0, next = 0;
  const waiting: (() => void)[] = [];
  // each request takes the next free slot in time, 1/rps apart
  const pace = async () => {
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + 1000 / rps;
    if (at > now) await new Promise(r => setTimeout(r, at - now));
  };
  return async ({ method, params }: { method: string; params?: unknown }) => {
    if (running >= limit) await new Promise<void>(r => waiting.push(r));
    running++;
    try {
      for (let attempt = 0; ; attempt++) {
        await pace();
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] }),
          signal: AbortSignal.timeout(30_000),
        }).catch((e: Error) => ({ ok: false, status: 0, why: e.name }) as const);
        if ("json" in r && r.ok) {
          const j = await r.json();
          if (j.error) throw Object.assign(new Error(`${method}: ${String(j.error.message).slice(0, 200)}`), { code: j.error.code, data: j.error.data });
          return j.result;
        }
        const status = r.status;
        if (attempt < 5 && (status === 429 || status === 503 || status === 0)) {
          await new Promise(res => setTimeout(res, 2000 * 2 ** attempt + Math.random() * 1000));
          continue;
        }
        const body = "text" in r ? (await r.text().catch(() => "")).slice(0, 200) : (r as any).why;
        throw new Error(`${method}: HTTP ${status} ${body}`);
      }
    } finally {
      running--;
      waiting.shift()?.();
    }
  };
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const all = JSON.parse(readFileSync(new URL("../data/chains.json", import.meta.url), "utf8")) as Record<string, Omit<ChainCfg, "id" | "rpc" | "client" | "fromBlock">>;

export function chains(env = process.env): ChainCfg[] {
  const out: ChainCfg[] = [];
  for (const [id, c] of Object.entries(all)) {
    const rpc = env[`RPC_URL_${id}`];
    if (!rpc) continue;
    const client = createPublicClient({ transport: custom({ request: node(rpc, Number(env.RPC_CONCURRENCY || 4), Number(env.RPC_RPS || 5)) }, { retryCount: 0 }) }) as PublicClient;
    out.push({ ...c, id: Number(id), rpc, client, fromBlock: BigInt(env[`FROM_BLOCK_${id}`] || 0) });
  }
  return out;
}

/**
 * Multicall3, merged and kept apart.
 *   Merged: every read asked for within 25 ms goes out together, in calls of up to 200 KB each (a wallet's thousand
 *   coins: a handful of requests, not thousands).
 *   Kept apart, by kind, because one call that burns its gas (spam tokens do) leaves 1/64 for the rest of its batch:
 *     "token"  reads of any token a wallet holds (balance, decimals): must not be lost, so what fails is asked
 *              again in groups of 50, 10, then one at a time while few are left
 *     "pool"   DEX factories and pools, and the quote coins' balances in them: never spam, never mixed with it
 *     "probe"  is this token a vault? (most aren't: their failures are real; asked again once, in groups of 50)
 */
type Res = { status: "success" | "failure"; result?: any };
export type Kind = "token" | "pool" | "probe";
const queues = new Map<string, { calls: any[]; waiting: { from: number; n: number; ok: (r: Res[]) => void; no: (e: unknown) => void }[] }>();

export function multicall(c: ChainCfg, contracts: readonly any[], kind: Kind): Promise<Res[]> {
  if (!contracts.length) return Promise.resolve([]);
  const k = `${c.id}:${kind}`;
  return new Promise((ok, no) => {
    let q = queues.get(k);
    if (!q) {
      q = { calls: [], waiting: [] };
      queues.set(k, q);
      setTimeout(() => flush(c, k, kind), 25);
    }
    q.waiting.push({ from: q.calls.length, n: contracts.length, ok, no });
    q.calls.push(...contracts);
  });
}

// asked again after a failure: a token read down to one at a time; a probe once, in groups of 50 (enough to get
// out of a gas-burner's batch); a pool read never
const AGAIN: Record<Kind, [number, number][]> = { token: [[50, 5000], [10, 300], [1, 40]], probe: [[50, 5000]], pool: [] };

async function flush(c: ChainCfg, k: string, kind: Kind) {
  const q = queues.get(k)!;
  queues.delete(k);
  if (process.env.DEBUG_FLUSH) console.log("flush", k, q.calls.length);
  const run = (cs: readonly any[]) => c.client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 200_000, contracts: cs as any[] }) as Promise<Res[]>;
  try {
    const out = await run(q.calls);
    for (const [size, most] of AGAIN[kind]) {
      const bad = out.map((r, i) => (r.status === "success" ? -1 : i)).filter(i => i >= 0);
      if (!bad.length) break;
      if (bad.length > most) continue;
      for (let k = 0; k < bad.length; k += size) {
        const idx = bad.slice(k, k + size);
        const again = await run(idx.map(i => q.calls[i])).catch(() => null);
        if (again) idx.forEach((i, j) => (out[i] = again[j]));
      }
    }
    for (const w of q.waiting) w.ok(out.slice(w.from, w.from + w.n));
  } catch (e) {
    for (const w of q.waiting) w.no(e);
  }
}
