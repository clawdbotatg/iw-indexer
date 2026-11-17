import { decodeAbiParameters, pad, toEventSelector } from "viem";
import { type ChainCfg, learnSpan } from "./chains.ts";
import type { Db } from "./db.ts";

/**
 * Uniswap v4 pools of a coin against the quote coins. v4 has no getPool: every pool lives in one PoolManager, so they
 * are found from its Initialize events (currency0 and currency1 are indexed). Coins asked for within 100 ms are looked
 * up together, up to 100 per request, over all of v4's blocks at once (the range is split when the node says no).
 * Found or not, kept 6 hours (only coins with no pool elsewhere are looked up: spam, mostly).
 *
 * On a network read from your own node (c.own) every pool is kept instead (v4Sync: ~3 minutes once on a home reth,
 * then the new blocks), and a coin's pools are a database lookup: the per-coin search was ~940 log searches each time.
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

let db: Db | null = null;
const ready = new Set<number>(); // networks whose pools are all kept, up to a recent block

/** Keep every v4 pool of a network read from your own node, from where it got to last time. */
export async function v4Sync(c: ChainCfg, d: Db) {
  if (!c.v4 || !c.own) return;
  db = d;
  const head = await c.client.getBlockNumber();
  let from = BigInt((d.q.v4upto.get(c.id) as any)?.upto ?? c.v4.from - 1) + 1n;
  while (from <= head) {
    // 32 pieces at a time, kept in order: a stop part-way starts again where it got to
    const step = c.span ?? 10_000n;
    const parts: [bigint, bigint][] = [];
    for (let a = from; a <= head && parts.length < 32; a += step) parts.push([a, a + step - 1n < head ? a + step - 1n : head]);
    const got = await Promise.all(parts.map(([a, b]) => logsIn(c, [INIT], a, b)));
    const to = parts[parts.length - 1][1];
    d.db.exec("BEGIN");
    try {
      for (const l of got.flat()) {
        const [fee, spacing, hooks] = decodeAbiParameters([{ type: "uint24" }, { type: "int24" }, { type: "address" }], l.data);
        d.q.addV4.run(c.id, l.topics[1], ("0x" + l.topics[2].slice(26)).toLowerCase(), ("0x" + l.topics[3].slice(26)).toLowerCase(), Number(fee), Number(spacing), String(hooks));
      }
      d.q.setV4upto.run(c.id, Number(to));
      d.db.exec("COMMIT");
    } catch (e) {
      d.db.exec("ROLLBACK");
      throw e;
    }
    from = to + 1n;
  }
  if (!ready.has(c.id)) console.log(`${c.name}: every v4 pool kept`);
  ready.add(c.id);
}

export function v4Pools(c: ChainCfg, t: string, quotes: string[]): Promise<V4Pool[]> {
  if (!c.v4) return Promise.resolve([]);
  if (c.own) {
    // not all kept yet: an error (no price, not kept as "no price"), never "no pools"
    if (!ready.has(c.id) || !db) return Promise.reject(new Error("v4 pools still loading"));
    const qs = new Set([NATIVE, ...quotes.map(q => q.toLowerCase())]);
    const tl = t.toLowerCase();
    const out: V4Pool[] = [];
    for (const r of db.q.v4of.all(c.id, tl, tl) as any[]) {
      const tIs0 = r.c0 === tl && r.c0 !== NATIVE;
      const q = tIs0 ? r.c1 : r.c0;
      if (!qs.has(q)) continue;
      const key = { currency0: r.c0, currency1: r.c1, fee: r.fee, tickSpacing: r.spacing, hooks: r.hooks };
      out.push({ id: r.id, quote: q === NATIVE ? c.wrapped!.toLowerCase() : q, tIs0, key });
    }
    return Promise.resolve(out);
  }
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

/** eth_getLogs over [from, to]: in pieces the node takes (c.span, once it has said), all at once (the node's pace
 * holds them); else split in halves while the node says the range is too much. */
async function logsIn(c: ChainCfg, topics: any[], from: bigint, to: bigint, depth = 0): Promise<any[]> {
  if (c.span !== undefined && to - from + 1n > c.span) {
    const parts: [bigint, bigint][] = [];
    for (let a = from; a <= to; a += c.span) parts.push([a, a + c.span - 1n < to ? a + c.span - 1n : to]);
    return (await Promise.all(parts.map(([a, b]) => logsIn(c, topics, a, b, depth)))).flat();
  }
  try {
    return (await c.logs.request({
      method: "eth_getLogs",
      params: [{ address: c.v4!.poolManager, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16), topics }],
    } as any)) as any[];
  } catch (e) {
    if (learnSpan(c, e)) return logsIn(c, topics, from, to, depth);
    if (depth > 12 || to - from < 1000n) throw e;
    const mid = (from + to) / 2n;
    return [...(await logsIn(c, topics, from, mid, depth + 1)), ...(await logsIn(c, topics, mid + 1n, to, depth + 1))];
  }
}
