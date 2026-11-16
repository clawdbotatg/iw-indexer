import { decodeAbiParameters, pad, toEventSelector } from "viem";
import type { ChainCfg } from "./chains.ts";

/**
 * Uniswap v4 pools of a coin against the quote coins. v4 has no getPool: every pool lives in one PoolManager, so they
 * are found from its Initialize events (currency0 and currency1 are indexed). Coins asked for within 100 ms are looked
 * up together, up to 100 per request, over all of v4's blocks at once (the range is split when the node says no).
 * Found or not, kept 6 hours (only coins with no pool elsewhere are looked up: spam, mostly).
 */
const INIT = toEventSelector("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)");
const NATIVE = "0x0000000000000000000000000000000000000000";
export type V4Pool = {
  id: `0x${string}`;
  quote: string;
  tIs0: boolean;
  key: { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` };
};
const cache = new Map<string, { at: number; p: Promise<V4Pool[]> }>();
const waiting = new Map<number, { ts: string[]; done: ((m: Map<string, V4Pool[]>) => void)[]; fail: ((e: unknown) => void)[] }>();

export function v4Pools(c: ChainCfg, t: string, quotes: string[]): Promise<V4Pool[]> {
  if (!c.v4) return Promise.resolve([]);
  const k = `${c.id}:${t}`;
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.p;
  const p = new Promise<Map<string, V4Pool[]>>((ok, no) => {
    let w = waiting.get(c.id);
    if (!w) {
      w = { ts: [], done: [], fail: [] };
      waiting.set(c.id, w);
      setTimeout(() => run(c, quotes), 100);
    }
    w.ts.push(t);
    w.done.push(ok);
    w.fail.push(no);
  }).then(m => m.get(t) ?? []);
  const entry = { at: Date.now(), p };
  cache.set(k, entry);
  p.catch(() => cache.get(k) === entry && cache.delete(k)); // a failed lookup isn't kept
  return p;
}

async function run(c: ChainCfg, quotes: string[]) {
  const w = waiting.get(c.id)!;
  waiting.delete(c.id);
  const ts = [...new Set(w.ts)];
  try {
    const head = await c.client.getBlockNumber();
    const out = new Map<string, V4Pool[]>();
    const qs = [NATIVE, ...quotes];
    for (let i = 0; i < ts.length; i += 100) {
      const part = ts.slice(i, i + 100).map(t => pad(t as `0x${string}`));
      const qp = qs.map(q => pad(q as `0x${string}`));
      // the coin as currency0 or as currency1 (the lower address is currency0; native is 0x0, always currency0)
      const logs = [
        ...(await logsIn(c, [INIT, null, part, qp], BigInt(c.v4!.from), head)),
        ...(await logsIn(c, [INIT, null, qp, part], BigInt(c.v4!.from), head)),
      ];
      for (const l of logs) {
        const c0 = ("0x" + l.topics[2].slice(26)).toLowerCase();
        const c1 = ("0x" + l.topics[3].slice(26)).toLowerCase();
        const tIs0 = ts.includes(c0) && c0 !== NATIVE;
        const t = tIs0 ? c0 : c1;
        const q = tIs0 ? c1 : c0;
        // native ETH is priced as the wrapped coin
        const [fee, tickSpacing, hooks] = decodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }], l.data);
        const key = { currency0: c0 as `0x${string}`, currency1: c1 as `0x${string}`, fee: Number(fee), tickSpacing: Number(tickSpacing), hooks: hooks as `0x${string}` };
        const pool = { id: l.topics[1], quote: q === NATIVE ? c.wrapped!.toLowerCase() : q, tIs0, key };
        out.set(t, [...(out.get(t) ?? []), pool]);
      }
    }
    for (const f of w.done) f(out);
  } catch (e: any) {
    console.error(c.name, "v4 lookup failed for", ts.length, "coins:", String(e?.message || e).slice(0, 200));
    for (const f of w.fail) f(e);
  }
}

/** eth_getLogs over [from, to], split in halves while the node says the range is too much. */
async function logsIn(c: ChainCfg, topics: any[], from: bigint, to: bigint, depth = 0): Promise<any[]> {
  try {
    return (await c.logs.request({
      method: "eth_getLogs",
      params: [{ address: c.v4!.poolManager, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics }],
    } as any)) as any[];
  } catch (e) {
    if (depth > 12 || to - from < 1000n) throw e;
    const mid = (from + to) / 2n;
    return [...(await logsIn(c, topics, from, mid, depth + 1)), ...(await logsIn(c, topics, mid + 1n, to, depth + 1))];
  }
}
