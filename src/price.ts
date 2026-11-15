import { parseAbi } from "viem";
import { multicall, type ChainCfg } from "./chains.ts";

/**
 * A coin's dollar price, from the chain alone.
 *
 * 1. Pools: the coin against USDC, USDT, DAI (each counted as $1) or the network's wrapped coin (its own price), in
 *    Uniswap v3 (fees 0.01%, 0.05%, 0.3%, 1%) and the v2-style DEXes in data/chains.json (Uniswap v2, SushiSwap...).
 *    The pool holding the most dollars of the other side wins, if that's at least MIN_DEPTH ($10,000): a coin with no
 *    real pool has no price (the wallet treats it as spam, as it does today). A v3 price is the pool's 30-minute
 *    average (observe), so one block can't fake it; a v2 price is its reserves now, from a pool traded in the last 30
 *    days.
 * 2. No pool: a coin that is a claim on another one is priced through it: an Aave aToken or debt token
 *    (UNDERLYING_ASSET_ADDRESS, 1:1), an ERC-4626 vault share (asset, convertToAssets), a Beefy vault (want,
 *    getPricePerFullShare).
 * Kept for a minute.
 */
const MIN_DEPTH = Number(process.env.MIN_DEPTH_USD || 10_000);
// how many coins are priced at once: all of a wallet's, by default. Their reads are merged into a few requests
// (chains.ts multicall), and the connection to the node keeps its own pace (RPC_RPS)
const LIMIT = Number(process.env.PRICE_CONCURRENCY || 100_000);
const FEES = [100, 500, 3000, 10000];
const TWAP = 1800;
const v3f = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const v2f = parseAbi(["function getPair(address,address) view returns (address)"]);
const v3p = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const v2p = parseAbi(["function getReserves() view returns (uint112, uint112, uint32)"]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const wrap = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function asset() view returns (address)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function want() view returns (address)",
  "function getPricePerFullShare() view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLES = /^(USDT|USDT0|USD₮0|DAI)$/;

const cache = new Map<string, { at: number; p: Promise<number | null>; none?: boolean }>();
type Pool = { kind: "v3" | "v2"; addr: string; quote: string };

export function pricer(c: ChainCfg, decimalsOf: (t: string) => Promise<number | null>) {
  const usdc = c.usdc?.toLowerCase();
  const wrapped = c.wrapped?.toLowerCase();
  const stables = [usdc, ...c.tokens.filter(t => STABLES.test(t.symbol)).map(t => t.address.toLowerCase())].filter(Boolean) as string[];
  const quotes = [...stables, ...(wrapped ? [wrapped] : [])];
  const v2s = (c.v2Factories ?? []) as `0x${string}`[];

  /** What one unit of a quote coin is worth in dollars. */
  const quoteUsd = async (q: string) => (stables.includes(q) ? 1 : price(q, true));

  /** The deepest pool against any quote coin: { price, depth in dollars }. */
  async function pools(t: string): Promise<{ p: number; usd: number } | null> {
    const qs = quotes.filter(q => q !== t);
    const asks: { q: string; kind: "v3" | "v2"; call: any }[] = [];
    for (const q of qs) {
      if (c.uniV3Factory) for (const f of FEES) asks.push({ q, kind: "v3", call: { address: c.uniV3Factory, abi: v3f, functionName: "getPool", args: [t, q, f] } });
      for (const f of v2s) asks.push({ q, kind: "v2", call: { address: f, abi: v2f, functionName: "getPair", args: [t, q] } });
    }
    if (!asks.length) return null;
    const found: Pool[] = (await multicall(c, asks.map(a => a.call), "pool"))
      .map((r, i) => (r.status === "success" && r.result !== ZERO ? { kind: asks[i].kind, addr: r.result as string, quote: asks[i].q } : null))
      .filter(Boolean) as Pool[];
    if (!found.length) return null;
    const dt = await decimalsOf(t);
    if (dt === null) return null;
    // v3: the quote coin it holds, slot0, the 30-minute average; v2: its reserves
    const calls = found.map(p =>
      p.kind === "v3"
        ? [
            { address: p.quote, abi: erc20, functionName: "balanceOf", args: [p.addr] },
            { address: p.addr, abi: v3p, functionName: "slot0" },
            { address: p.addr, abi: v3p, functionName: "observe", args: [[TWAP, 0]] },
          ]
        : [{ address: p.addr, abi: v2p, functionName: "getReserves" }],
    );
    const flat = await multicall(c, calls.flat(), "pool");
    const at = calls.map((_, i) => calls.slice(0, i).reduce((s, x) => s + x.length, 0));
    // the quote coins' decimals and dollar price, all at once (awaited one by one, every coin's reads trickled out
    // in hundreds of small requests)
    const qs2 = [...new Set(found.map(p => p.quote))];
    const qi = new Map(await Promise.all(qs2.map(async q => [q, [await decimalsOf(q), await quoteUsd(q)]] as const)));
    let top: { p: number; usd: number } | null = null;
    for (let i = 0; i < found.length; i++) {
      const pl = found[i];
      const [a, b, o] = flat.slice(at[i], at[i] + calls[i].length);
      const [dq, qUsd] = qi.get(pl.quote)!;
      if (dq === null || !qUsd) continue;
      const tIs0 = t < pl.quote;
      let inQuote: number, depth: number;
      if (pl.kind === "v3") {
        if (a.status !== "success" || b.status !== "success") continue;
        depth = Number(a.result as bigint) / 10 ** dq;
        // the tick: the 30-minute average when the pool keeps enough history, else now. tick = log1.0001(token1/token0)
        const cum = o.status === "success" ? ((o.result as any)[0] as bigint[]) : null;
        const tick = cum ? Number((cum[1] - cum[0]) / BigInt(TWAP)) : Number((b.result as any)[1]);
        const raw = 1.0001 ** tick;
        inQuote = (tIs0 ? raw : 1 / raw) * 10 ** (dt - dq);
      } else {
        if (a.status !== "success") continue;
        const [r0, r1, last] = a.result as [bigint, bigint, number];
        const [rt, rq] = tIs0 ? [r0, r1] : [r1, r0];
        // a pool nobody has traded in for 30 days says nothing about today (a 2021 pool priced a dead coin at $850k)
        if (!rt || Date.now() / 1000 - Number(last) > 30 * 86400) continue;
        depth = Number(rq) / 10 ** dq;
        inQuote = Number(rq) / 10 ** dq / (Number(rt) / 10 ** dt);
      }
      const usd = depth * qUsd;
      if (!top || usd > top.usd) top = { p: inQuote * qUsd, usd };
    }
    return top && top.usd >= MIN_DEPTH ? top : null;
  }

  /** A claim on another coin (aToken, vault share): its price through that coin. */
  async function through(t: string): Promise<number | null> {
    const a = t as `0x${string}`;
    const [aave, asset, want, pps] = await multicall(c, [
      { address: a, abi: wrap, functionName: "UNDERLYING_ASSET_ADDRESS" },
      { address: a, abi: wrap, functionName: "asset" },
      { address: a, abi: wrap, functionName: "want" },
      { address: a, abi: wrap, functionName: "getPricePerFullShare" },
    ], "probe");
    const under = (r: typeof aave) => (r.status === "success" && r.result !== ZERO ? String(r.result).toLowerCase() : null);
    if (under(aave)) return price(under(aave)!, true);
    const dt = await decimalsOf(t);
    if (dt === null) return null;
    if (under(asset)) {
      const [r] = await multicall(c, [{ address: a, abi: wrap, functionName: "convertToAssets", args: [10n ** BigInt(dt)] }], "probe");
      const du = await decimalsOf(under(asset)!);
      const p = await price(under(asset)!, true);
      if (r.status !== "success" || du === null || p === null) return null;
      return (Number(r.result as bigint) / 10 ** du) * p;
    }
    if (under(want) && pps.status === "success") {
      const p = await price(under(want)!, true);
      return p === null ? null : (Number(pps.result as bigint) / 1e18) * p;
    }
    return null;
  }

  async function compute(t: string): Promise<number | null> {
    t = t.toLowerCase();
    if (c.nativeIsUsdc && (t === "native" || t === usdc)) return 1;
    if (t === usdc) return 1;
    if (t === "native") return wrapped ? price(wrapped, true) : null;
    const pool = await pools(t);
    if (pool) return pool.p;
    return through(t);
  }

  let running = 0;
  const waiting: (() => void)[] = [];
  const slot = async <T>(f: () => Promise<T>): Promise<T> => {
    if (running >= LIMIT) await new Promise<void>(r => waiting.push(r));
    running++;
    try {
      return await f();
    } finally {
      running--;
      waiting.shift()?.();
    }
  };

  /** `t`: a token address, or "native" for the chain's coin. */
  function price(t: string, inner = false): Promise<number | null> {
    const k = `${c.id}:${t.toLowerCase()}`;
    const hit = cache.get(k);
    // a price for a minute; no price (no pool: spam, mostly) for an hour, so a big wallet's spam isn't looked up again
    // on every ask
    if (hit && Date.now() - hit.at < (hit.none ? 3600_000 : 60_000)) return hit.p;
    // asked from inside another coin's price (its quote coin, what an aToken holds) skips the line: that one already
    // has a place, and waiting again could wait forever
    // 20 s at most (two vaults that point at each other would wait on each other for good)
    const timed = () => Promise.race([compute(t), new Promise<null>(r => setTimeout(() => r(null), 20_000))]);
    const p = (inner ? timed() : slot(timed)).catch(() => null);
    const entry: { at: number; p: Promise<number | null>; none?: boolean } = { at: Date.now(), p };
    p.then(v => v === null && (entry.none = true));
    cache.set(k, entry);
    return p;
  }
  return price;
}
