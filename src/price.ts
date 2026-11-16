import { parseAbi } from "viem";
import { multicall, type ChainCfg } from "./chains.ts";
import { v4Pools } from "./v4.ts";

/**
 * A coin's dollar price, from the chain alone.
 *
 * 1. Pools: the coin against USDC, USDT, DAI (each counted as $1) or the network's wrapped coin (its own price), in
 *    Uniswap v3 (fees 0.01%, 0.05%, 0.3%, 1%), the v2-style DEXes in data/chains.json (Uniswap v2, SushiSwap...),
 *    and Aerodrome / Velodrome (their v2-style pools, volatile and stable, and their v3-style Slipstream pools); with
 *    none of those, Uniswap v4 (v4.ts).
 *    The pool holding the most dollars of the other side wins, if that's at least MIN_DEPTH ($50,000), or if two or more
 *    pools agree on the price within 3% and hold $25,000 between them: a coin with no
 *    real pool has no price (the wallet treats it as spam, as it does today). A v3 price is the pool's 30-minute
 *    average (observe), so one block can't fake it; a v2 price is its reserves now, from a pool traded in the last 30
 *    days.
 * 2. No pool: a coin bridged from Ethereum by the network's official bridge is priced as the original there; a coin
 *    that is a claim on another one is priced through it: an Aave aToken or debt token
 *    (UNDERLYING_ASSET_ADDRESS, 1:1; a debt token: no price), an ERC-4626 vault share (asset, convertToAssets), a Beefy vault (want,
 *    getPricePerFullShare).
 * A price is kept a minute; no price, a day (in the database: a big wallet has thousands of spam coins).
 */
const MIN_DEPTH = Number(process.env.MIN_DEPTH_USD || 50_000);
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
// Aerodrome and Velodrome: Uniswap v2-style pools, volatile or stable (stable ones, priced by getAmountOut), and
// Slipstream, their copy of Uniswap v3 (slot0 one field shorter)
const solf = parseAbi(["function getPool(address,address,bool) view returns (address)"]);
const solp = parseAbi(["function getAmountOut(uint256,address) view returns (uint256)", "function getReserves() view returns (uint256, uint256, uint256)"]);
const clf = parseAbi(["function getPool(address,address,int24) view returns (address)"]);
const clp = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const SPACINGS = [1, 50, 100, 200, 2000]; // Slipstream's, against WETH and USDC only (each one more read per coin)
const sv = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
]);
const quoter = parseAbi([
  "struct Key { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct Params { Key poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(Params params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);
const TEST_USD = 5000;
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const wrap = parseAbi([
  "function UNDERLYING_ASSET_ADDRESS() view returns (address)",
  "function asset() view returns (address)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function want() view returns (address)",
  "function getPricePerFullShare() view returns (uint256)",
  "function borrowAllowance(address, address) view returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const STABLES = /^(USDT|USDT0|USD₮0|DAI)$/;

const cache = new Map<string, { at: number; p: Promise<number | null>; none?: boolean }>();
// each network's pricer, for a bridged coin priced as its Ethereum original
const pricers = new Map<number, (t: string, inner?: boolean) => Promise<number | null>>();
// a coin made by the network's official bridge names its Ethereum original. Only the bridge itself can mint it, so
// that is checked: a spam coin can claim to be WETH, but not to be minted by the bridge
const bridged = parseAbi([
  "function REMOTE_TOKEN() view returns (address)",
  "function BRIDGE() view returns (address)",
  "function l1Address() view returns (address)",
  "function l2Gateway() view returns (address)",
  "function l1Token() view returns (address)",
  "function l2Bridge() view returns (address)",
]);
const OP_BRIDGE = "0x4200000000000000000000000000000000000010"; // every OP Stack network (Optimism, Base...)
const ARB_GATEWAYS = new Set([
  "0x09e9222e96e7b4ae2a407b98d48e330053351eee", // the standard ERC-20 gateway
  "0x096760f208390250649e3e8763348e783aef5562", // the custom gateway
  "0x6c411ad3e74de3e7bd422b94a27770f5b86c623b", // WETH's
]);
// how many dollars the deepest pool holds, per coin priced from a pool (a holding worth more than that can't be sold
// for it: spam with a small real pool, airdropped in the millions, priced 22 test wallets at $430k)
const depths = new Map<string, number>();
type Kind = "v3" | "v2" | "cl" | "stable";
type Pool = { kind: Kind; addr: string; quote: string };

/** Where "no price" is remembered (the database): a big wallet's thousands of spam coins are looked up once a day. */
export type Unpriced = { get: (t: string) => number | null; set: (t: string) => void };
const DAY = 86400_000;

export function pricer(c: ChainCfg, decimalsOf: (t: string) => Promise<number | null>, unpriced?: Unpriced) {
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
    const asks: { q: string; kind: Kind; call: any }[] = [];
    for (const q of qs) {
      if (c.uniV3Factory) for (const f of FEES) asks.push({ q, kind: "v3", call: { address: c.uniV3Factory, abi: v3f, functionName: "getPool", args: [t, q, f] } });
      for (const f of v2s) asks.push({ q, kind: "v2", call: { address: f, abi: v2f, functionName: "getPair", args: [t, q] } });
      for (const f of c.solidly ?? []) {
        asks.push({ q, kind: "v2", call: { address: f, abi: solf, functionName: "getPool", args: [t, q, false] } });
        asks.push({ q, kind: "stable", call: { address: f, abi: solf, functionName: "getPool", args: [t, q, true] } });
      }
      if (q === wrapped || q === usdc) for (const f of c.slipstream ?? []) for (const s of SPACINGS) asks.push({ q, kind: "cl", call: { address: f, abi: clf, functionName: "getPool", args: [t, q, s] } });
    }
    if (!asks.length) return null;
    const found: Pool[] = (await multicall(c, asks.map(a => a.call), "pool"))
      .map((r, i) => (r.status === "success" && r.result !== ZERO ? { kind: asks[i].kind, addr: r.result as string, quote: asks[i].q } : null))
      .filter(Boolean) as Pool[];
    if (!found.length) return v4(t);
    const dt = await decimalsOf(t);
    if (dt === null) return null;
    // v3 and Slipstream: the quote coin it holds, slot0, the 30-minute average; v2: its reserves; a stable pool: its
    // reserves and what one coin sells for (its curve is flat near the peg: the reserves' ratio says nothing)
    const calls = found.map(p =>
      p.kind === "v3" || p.kind === "cl"
        ? [
            { address: p.quote, abi: erc20, functionName: "balanceOf", args: [p.addr] },
            { address: p.addr, abi: p.kind === "cl" ? clp : v3p, functionName: "slot0" },
            { address: p.addr, abi: p.kind === "cl" ? clp : v3p, functionName: "observe", args: [[TWAP, 0]] },
          ]
        : p.kind === "stable"
          ? [
              { address: p.addr, abi: solp, functionName: "getReserves" },
              { address: p.addr, abi: solp, functionName: "getAmountOut", args: [10n ** BigInt(dt), t] },
            ]
          : [{ address: p.addr, abi: solp, functionName: "getReserves" }],
    );
    const flat = await multicall(c, calls.flat(), "pool");
    const at = calls.map((_, i) => calls.slice(0, i).reduce((s, x) => s + x.length, 0));
    // the quote coins' decimals and dollar price, all at once (awaited one by one, every coin's reads trickled out
    // in hundreds of small requests)
    const qs2 = [...new Set(found.map(p => p.quote))];
    const qi = new Map(await Promise.all(qs2.map(async q => [q, [await decimalsOf(q), await quoteUsd(q)]] as const)));
    let top: { p: number; usd: number } | null = null;
    const seen: { p: number; usd: number }[] = [];
    for (let i = 0; i < found.length; i++) {
      const pl = found[i];
      const [a, b, o] = flat.slice(at[i], at[i] + calls[i].length);
      const [dq, qUsd] = qi.get(pl.quote)!;
      if (dq === null || !qUsd) continue;
      const tIs0 = t < pl.quote;
      let inQuote: number, depth: number;
      if (pl.kind === "v3" || pl.kind === "cl") {
        if (a.status !== "success" || b.status !== "success") continue;
        depth = Number(a.result as bigint) / 10 ** dq;
        // the tick: the 30-minute average when the pool keeps enough history, else now. tick = log1.0001(token1/token0)
        const cum = o.status === "success" ? ((o.result as any)[0] as bigint[]) : null;
        const tick = cum ? Number((cum[1] - cum[0]) / BigInt(TWAP)) : Number((b.result as any)[1]);
        const raw = 1.0001 ** tick;
        inQuote = (tIs0 ? raw : 1 / raw) * 10 ** (dt - dq);
      } else {
        if (a.status !== "success") continue;
        const [r0, r1, last] = a.result as [bigint, bigint, bigint];
        const [rt, rq] = tIs0 ? [r0, r1] : [r1, r0];
        // a pool nobody has traded in for 30 days says nothing about today (a 2021 pool priced a dead coin at $850k)
        if (!rt || Date.now() / 1000 - Number(last) > 30 * 86400) continue;
        depth = Number(rq) / 10 ** dq;
        if (pl.kind === "stable") {
          if (b.status !== "success") continue;
          inQuote = Number(b.result as bigint) / 10 ** dq;
        } else inQuote = Number(rq) / 10 ** dq / (Number(rt) / 10 ** dt);
      }
      const usd = depth * qUsd;
      seen.push({ p: inQuote * qUsd, usd });
      if (!top || usd > top.usd) top = { p: inQuote * qUsd, usd };
    }
    if (!top) return v4(t);
    // the depth: every pool that agrees with the deepest within 3%
    const agree = seen.filter(x => Math.abs(x.p / top!.p - 1) < 0.03);
    const sum = agree.reduce((s, x) => s + x.usd, 0);
    if (top.usd >= MIN_DEPTH) return { p: top.p, usd: sum };
    // no one deep pool (an L2 coin's money is often split across DEXes: wstETH on Optimism, $32k at most in one):
    // two or more pools that agree and hold half of MIN_DEPTH between them. Spam has one pool, mostly
    return agree.length >= 2 && sum >= MIN_DEPTH / 2 ? { p: top.p, usd: sum } : v4(t);
  }

  /** No pool elsewhere: Uniswap v4 (newer coins, Clanker's and Zora's, live only there). The price is the pool's
   * price now (v4 keeps no history); a pool counts when the quote coin in range at that price (liquidity × √price) is
   * worth MIN_DEPTH and a $5,000 sale through v4's Quoter gets 90% of its worth. */
  async function v4(t: string): Promise<{ p: number; usd: number } | null> {
    if (!c.v4) return null;
    const found = await v4Pools(c, t, quotes);
    if (!found.length) return null;
    const dt = await decimalsOf(t);
    if (dt === null) return null;
    const flat = await multicall(c, found.flatMap(p => [
      { address: c.v4!.stateView, abi: sv, functionName: "getSlot0", args: [p.id] },
      { address: c.v4!.stateView, abi: sv, functionName: "getLiquidity", args: [p.id] },
    ]), "pool");
    const qs = [...new Set(found.map(p => p.quote))];
    const qi = new Map(await Promise.all(qs.map(async q => [q, [await decimalsOf(q), await quoteUsd(q)]] as const)));
    const cands: { pl: (typeof found)[number]; p: number; usd: number; dq: number; qUsd: number }[] = [];
    for (const [i, pl] of found.entries()) {
      const [s0, l] = [flat[2 * i], flat[2 * i + 1]];
      if (s0.status !== "success" || l.status !== "success") continue;
      const [dq, qUsd] = qi.get(pl.quote)!;
      if (dq === null || !qUsd) continue;
      const sqrt = Number((s0.result as any)[0] as bigint) / 2 ** 96; // √(raw currency1 per raw currency0)
      const L = Number(l.result as bigint);
      if (!sqrt || !L) continue;
      const raw = sqrt * sqrt;
      const inQuote = (pl.tIs0 ? raw : 1 / raw) * 10 ** (dt - dq);
      const depth = (pl.tIs0 ? L * sqrt : L / sqrt) / 10 ** dq;
      const usd = depth * qUsd;
      if (usd >= MIN_DEPTH) cands.push({ pl, p: inQuote * qUsd, usd, dq, qUsd });
    }
    // liquidity packed into a narrow band at a made-up price looks deep from slot0 alone (a spam coin's pool said
    // $3,600 a coin): the pool must actually pay for a $5,000 sale, at least 90% of it (the 3 deepest are tried)
    const amount = (x: (typeof cands)[number]) => (TEST_USD / x.p) * 10 ** dt;
    const top3 = cands.filter(x => Number.isFinite(amount(x)) && amount(x) >= 1 && amount(x) < 2 ** 127).sort((a, b) => b.usd - a.usd).slice(0, 3);
    const sells = await multicall(c, top3.map(x => ({
      address: c.v4!.quoter,
      abi: quoter,
      functionName: "quoteExactInputSingle",
      args: [{ poolKey: x.pl.key, zeroForOne: x.pl.tIs0, exactAmount: BigInt(Math.floor(amount(x))), hookData: "0x" }],
    })), "sim");
    for (const [i, x] of top3.entries()) {
      const r = sells[i];
      if (r.status !== "success") continue;
      const got = (Number((r.result as any)[0] as bigint) / 10 ** x.dq) * x.qUsd;
      // what was tested is what's known: a holding worth more than 10 such sales gets no price (the depth cap)
      if (got >= TEST_USD * 0.9) return { p: x.p, usd: TEST_USD * 10 };
    }
    return null;
  }

  /** A claim on another coin (aToken, vault share): its price through that coin. */
  async function through(t: string): Promise<number | null> {
    const a = t as `0x${string}`;
    const [aave, asset, want, pps, remote, bridge, l1, gw, oldRemote, oldBridge, debt] = await multicall(c, [
      { address: a, abi: wrap, functionName: "UNDERLYING_ASSET_ADDRESS" },
      { address: a, abi: wrap, functionName: "asset" },
      { address: a, abi: wrap, functionName: "want" },
      { address: a, abi: wrap, functionName: "getPricePerFullShare" },
      { address: a, abi: bridged, functionName: "REMOTE_TOKEN" },
      { address: a, abi: bridged, functionName: "BRIDGE" },
      { address: a, abi: bridged, functionName: "l1Address" },
      { address: a, abi: bridged, functionName: "l2Gateway" },
      { address: a, abi: bridged, functionName: "l1Token" }, // the older OP bridge token
      { address: a, abi: bridged, functionName: "l2Bridge" },
      { address: a, abi: wrap, functionName: "borrowAllowance", args: [ZERO, ZERO] }, // only Aave's debt tokens
    ], "probe");
    const under = (r: typeof aave) => (r.status === "success" && r.result !== ZERO ? String(r.result).toLowerCase() : null);
    // bridged from Ethereum by the official bridge: the original's price (same decimals: the bridge keeps them)
    const eth = pricers.get(1);
    if (eth && c.id !== 1) {
      if (under(remote) && under(bridge) === OP_BRIDGE) return eth(under(remote)!, true);
      if (under(oldRemote) && under(oldBridge) === OP_BRIDGE) return eth(under(oldRemote)!, true);
      if (under(l1) && ARB_GATEWAYS.has(under(gw) ?? "")) return eth(under(l1)!, true);
    }
    // an Aave debt token is money owed, not owned: no price (as Alchemy; it counted debt as savings, +50% on 8 test
    // wallets). Positions (iw-positions) is where debt shows
    if (under(aave) && debt.status === "success") return null;
    if (under(aave)) return price(under(aave)!, true);
    const dt = await decimalsOf(t);
    if (dt === null) return null;
    if (under(asset)) {
      const [r, held, supply] = await multicall(c, [
        { address: a, abi: wrap, functionName: "convertToAssets", args: [10n ** BigInt(dt)] },
        { address: a, abi: wrap, functionName: "totalAssets" },
        { address: under(asset)! as `0x${string}`, abi: wrap, functionName: "totalSupply" },
      ], "sim");
      const du = await decimalsOf(under(asset)!);
      const p = await price(under(asset)!, true);
      if (r.status !== "success" || du === null || p === null) return null;
      // a vault can't hold more of a coin than there is (a broken Euler vault said 25.7 billion USDC on Arbitrum,
      // with $52 in it: one wallet's share came to $82M)
      if (held.status === "success" && supply.status === "success" && (held.result as bigint) > (supply.result as bigint)) return null;
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
    if (pool) {
      depths.set(`${c.id}:${t}`, pool.usd);
      return pool.p;
    }
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
    // a price for a minute; no price (no pool: spam, mostly) for a day, in the database too, so a big wallet's spam isn't looked up again
    // on every ask
    if (hit && Date.now() - hit.at < (hit.none ? DAY : t.toLowerCase() === wrapped ? 300_000 : 60_000)) return hit.p;
    const lt = t.toLowerCase();
    const was = !hit && unpriced?.get(lt);
    if (was && Date.now() - was < DAY) {
      const p = Promise.resolve(null);
      cache.set(k, { at: was, p, none: true });
      return p;
    }
    // asked from inside another coin's price (its quote coin, what an aToken holds) skips the line: that one already
    // has a place, and waiting again could wait forever
    // 20 s at most (two vaults that point at each other would wait on each other for good)
    // too slow (a wallet with 10,000 coins asks for all their pools at once) or failed: no price this time, and not
    // kept, so the next ask tries again (kept, it hid mainnet ETH's price for an hour)
    const LATE = Symbol();
    const timed = () => Promise.race([compute(t), new Promise<typeof LATE>(r => setTimeout(() => r(LATE), 300_000))]);
    const entry: { at: number; p: Promise<number | null>; none?: boolean } = { at: Date.now(), p: null as any };
    const forget = () => (cache.get(k) === entry && cache.delete(k), null);
    entry.p = (inner ? timed() : slot(timed)).then(v => (v === LATE ? forget() : (v === null && ((entry.none = true), inner || unpriced?.set(lt)), v)), forget);
    cache.set(k, entry);
    return entry.p;
  }
  // the network's wrapped coin prices its own coin and every coin quoted in it: read again every 45 s on its own (and kept 5 minutes), so it is
  // never stuck behind a big wallet's thousands of pool reads
  if (wrapped) {
    // a new price replaces the old one only once it's read: asks in between get the last one
    const warm = () =>
      compute(wrapped).then(v => v !== null && cache.set(`${c.id}:${wrapped}`, { at: Date.now(), p: Promise.resolve(v) }), () => null);
    warm();
    setInterval(warm, 45_000).unref();
  }

  /** The dollars in the coin's pool, or Infinity when its price doesn't come from one pool (USDC, an aToken...). */
  price.depth = (t: string) => depths.get(`${c.id}:${t.toLowerCase()}`) ?? Infinity;
  pricers.set(c.id, price);
  return price;
}
