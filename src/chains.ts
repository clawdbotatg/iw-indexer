import { readFileSync } from "node:fs";
import { createPublicClient, custom, decodeFunctionResult, encodeFunctionData, parseAbi, type PublicClient } from "viem";

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
  solidly?: `0x${string}`[]; // Aerodrome, Velodrome: getPool(a, b, stable)
  slipstream?: `0x${string}`[]; // their concentrated pools (Uniswap v3's math): getPool(a, b, tickSpacing)
  v4?: { poolManager: `0x${string}`; stateView: `0x${string}`; quoter: `0x${string}`; from: number }; // Uniswap v4 (from: its first block)
  sameAs?: Record<string, string>; // coins bridged some other way, by hand: this coin = that one on Ethereum
  gasMulticall?: `0x${string}`; // Uniswap's multicall, which caps each call's gas (token reads)
  tokens: Tok[];
  rpc: string;
  client: PublicClient;
  logs: PublicClient; // where log searches go: LOGS_URL_<chainId> if set (a light client answers 512 blocks at a time), else the node
  fromBlock: bigint; // the oldest block a scan goes back to (FROM_BLOCK_<chainId>, else 0)
  own: boolean; // log searches go to your own node (this computer, your home network): no cost to search a lot
  span?: bigint; // the most blocks one log search may cover, once the node has said ("max block range 10000")
  batch: number; // reads per request at most (RPC_BATCH; a node on this computer: 20, a light client proves each one; else no limit)
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
        const req = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? [] });
        const t0 = Date.now();
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: req,
          signal: AbortSignal.timeout(30_000),
        }).catch((e: Error) => ({ ok: false, status: 0, why: e.name }) as const);
        if ("json" in r && r.ok) {
          const j = await r.json();
          if (process.env.DEBUG_RPC) console.log("rpc", url.split("/")[2].split(".")[0], method, req.length, Date.now() - t0, j.error ? "ERR " + String(j.error.message).slice(0, 80) : "");
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

/** Many reads in JSON-RPC batches (RPC_BATCH a request, else 200), all asked at once; the answers in order. A read
 * the node refused throws (a list with a hole would be read as "nothing there"). */
export async function batchRpc(c: ChainCfg, calls: { method: string; params: unknown[] }[]): Promise<any[]> {
  const step = Number.isFinite(c.batch) ? c.batch : 200;
  const parts: (typeof calls)[] = [];
  for (let i = 0; i < calls.length; i += step) parts.push(calls.slice(i, i + step));
  const got = await Promise.all(
    parts.map(async part => {
      const r = await fetch(c.rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(part.map((x, id) => ({ jsonrpc: "2.0", id, ...x }))),
        signal: AbortSignal.timeout(60_000),
      }).then(r => r.json());
      if (!Array.isArray(r)) throw new Error(`batch: ${String(r?.error?.message || "not a batch answer").slice(0, 120)}`);
      const out = new Array(part.length);
      for (const x of r) {
        if (x.error || x.result === undefined) throw new Error(`${part[x.id]?.method}: ${String(x.error?.message || "no answer").slice(0, 120)}`);
        out[x.id] = x.result;
      }
      if (out.some(x => x === undefined)) throw new Error("batch: an answer is missing");
      return out;
    }),
  );
  return got.flat();
}

/** A node's "max block range 10000": kept on the chain (every log search after keeps to it). True when learned. */
export function learnSpan(c: ChainCfg, e: unknown): boolean {
  const m = /block range (?:of |is |limit |exceeded |)?(\d{3,})|range (\d{3,}) block/i.exec(String((e as any)?.message || e));
  if (!m) return false;
  const n = BigInt(m[1] ?? m[2]);
  if (c.span !== undefined && c.span <= n) return false;
  c.span = n;
  console.log(`${c.name}: the node takes ${n} blocks a log search`);
  return true;
}

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const all = JSON.parse(readFileSync(new URL("../data/chains.json", import.meta.url), "utf8")) as Record<string, Omit<ChainCfg, "id" | "rpc" | "client" | "logs" | "fromBlock" | "batch" | "own">>;

/** Every network this indexer knows (data/chains.json): each needs a node to be read. */
export const NETWORKS = Object.keys(all).map(Number);

export function chains(env = process.env): ChainCfg[] {
  const out: ChainCfg[] = [];
  for (const [id, c] of Object.entries(all)) {
    const rpc = env[`RPC_URL_${id}`];
    if (!rpc) continue;
    // a node on this computer or your home network has no rate limit to keep to: 50 a second, 8 at once (RPC_RPS,
    // RPC_CONCURRENCY set both)
    const mine = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w-]+\.local)[:/]/.test(u);
    // only one on this computer is held to 20 reads a request: a light client proves each one
    const here = (u: string) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(u);
    const make = (u: string) =>
      createPublicClient({
        transport: custom({ request: node(u, Number(env.RPC_CONCURRENCY || (mine(u) ? 8 : 4)), Number(env.RPC_RPS || (mine(u) ? 50 : 5))) }, { retryCount: 0 }),
      }) as PublicClient;
    const client = make(rpc);
    const logsUrl = env[`LOGS_URL_${id}`];
    const batch = Number(env.RPC_BATCH || (here(rpc) ? 20 : 0)) || Infinity;
    out.push({ ...c, id: Number(id), rpc, client, logs: logsUrl ? make(logsUrl) : client, own: mine(logsUrl || rpc), fromBlock: BigInt(env[`FROM_BLOCK_${id}`] || 0), batch });
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
 *     "probe"  is this token a vault, a bridged coin? (most aren't: their failures are real; asked again once, in groups of 50)
 *     "sim"    a simulated sale (v4's Quoter), a vault's convertToAssets: more gas each, never asked again
 */
type Res = { status: "success" | "failure"; result?: any };
export type Kind = "token" | "pool" | "probe" | "sim";
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
const AGAIN: Record<Kind, [number, number][]> = { token: [[50, 5000], [10, 300], [1, 40]], probe: [[50, 5000]], sim: [], pool: [] };

// Uniswap's multicall gives each call its own gas: a spam token that burns its gas takes only its own read down. A
// token read or a getter needs well under 150k (probe: 200k); a simulated sale or a vault's math more (sim: 1M). Each request stays under 45M gas in all (geth's default cap
// for eth_call is 50M)
const ugas = parseAbi([
  "function multicall((address target, uint256 gasLimit, bytes callData)[] calls) view returns (uint256 blockNumber, (bool success, uint256 gasUsed, bytes returnData)[] returnData)",
]);
const GAS: Record<Kind, number> = { token: 150_000, probe: 200_000, sim: 1_000_000, pool: 0 };
async function capped(c: ChainCfg, cs: readonly any[], gas: number): Promise<Res[]> {
  const per = Math.min(Math.floor(45_000_000 / gas), c.batch);
  const parts: Promise<Res[]>[] = [];
  for (let i = 0; i < cs.length; i += per) {
    const part = cs.slice(i, i + per);
    // a call that can't be encoded (an argument out of range) fails alone: it is sent as an empty call
    const enc = (x: any) => {
      try {
        return encodeFunctionData({ abi: x.abi, functionName: x.functionName, args: x.args });
      } catch {
        return null;
      }
    };
    const bodies = part.map(enc);
    const data = encodeFunctionData({
      abi: ugas,
      functionName: "multicall",
      args: [part.map((x, j) => ({ target: bodies[j] ? x.address : MULTICALL3, gasLimit: BigInt(gas), callData: bodies[j] ?? "0x" }))],
    });
    parts.push(
      c.client.call({ to: c.gasMulticall!, data, gas: 50_000_000n }).then(r => {
        const [, out] = decodeFunctionResult({ abi: ugas, functionName: "multicall", data: r.data! }) as any;
        return part.map((x, j): Res => {
          const o = out[j];
          if (!bodies[j] || !o.success || o.returnData === "0x") return { status: "failure" };
          try {
            return { status: "success", result: decodeFunctionResult({ abi: x.abi, functionName: x.functionName, data: o.returnData }) };
          } catch {
            return { status: "failure" };
          }
        });
      }),
    );
  }
  return (await Promise.all(parts)).flat();
}

async function flush(c: ChainCfg, k: string, kind: Kind) {
  const q = queues.get(k)!;
  queues.delete(k);
  if (process.env.DEBUG_FLUSH) console.log("flush", k, q.calls.length);
  if (c.gasMulticall && GAS[kind]) {
    try {
      const out = await capped(c, q.calls, GAS[kind]);
      for (const w of q.waiting) w.ok(out.slice(w.from, w.from + w.n));
    } catch (e) {
      for (const w of q.waiting) w.no(e);
    }
    return;
  }
  const one = (cs: readonly any[]) => c.client.multicall({ multicallAddress: MULTICALL3, allowFailure: true, batchSize: 200_000, contracts: cs as any[] }) as Promise<Res[]>;
  const run = async (cs: readonly any[]): Promise<Res[]> => {
    if (cs.length <= c.batch) return one(cs);
    const parts: Promise<Res[]>[] = [];
    for (let i = 0; i < cs.length; i += c.batch) parts.push(one(cs.slice(i, i + c.batch)));
    return (await Promise.all(parts)).flat();
  };
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
  } catch (e: any) {
    console.error(c.name, kind, q.calls.length, "reads failed:", String(e?.shortMessage || e?.message || e).slice(0, 200));
    for (const w of q.waiting) w.no(e);
  }
}
