import { parseAbi } from "viem";
import { MULTICALL3, type ChainCfg } from "./chains.ts";

/**
 * A coin's dollar price, from the chain alone: its Uniswap v3 pool against USDC, or against the wrapped coin (then
 * that coin's own USDC pool). Of the pools that exist (fees 0.01%, 0.05%, 0.3%, 1%), the one holding the most
 * USDC-or-coin wins, and it must hold at least MIN_DEPTH dollars of it: a coin with no real pool has no price (and
 * the wallet treats it as spam, as it does today). The price is the pool's 30-minute average (observe), so one block
 * can't fake it; a pool too new for that uses its current price.
 * Kept for a minute.
 */
const MIN_DEPTH = Number(process.env.MIN_DEPTH_USD || 10_000);
const FEES = [100, 500, 3000, 10000];
const TWAP = 1800;
const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"]);
const ZERO = "0x0000000000000000000000000000000000000000";

const cache = new Map<string, { at: number; p: Promise<number | null> }>();

export function pricer(c: ChainCfg, decimalsOf: (t: string) => Promise<number | null>) {
  const usdc = c.usdc?.toLowerCase();
  const wrapped = c.wrapped?.toLowerCase();

  /** Price of `t` in `quote` units, and how much of `quote` its best pool holds (in quote units). */
  async function best(t: string, quote: string): Promise<{ p: number; depth: number } | null> {
    if (!c.uniV3Factory) return null;
    const pools = (
      await c.client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: true,
        contracts: FEES.map(f => ({ address: c.uniV3Factory!, abi: factoryAbi, functionName: "getPool", args: [t, quote, f] }) as const),
      })
    )
      .map(r => (r.status === "success" ? (r.result as string) : ZERO))
      .filter(a => a !== ZERO);
    if (!pools.length) return null;
    const [dt, dq] = await Promise.all([decimalsOf(t), decimalsOf(quote)]);
    if (dt === null || dq === null) return null;
    const reads = await c.client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: pools.flatMap(p => [
        { address: quote as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [p] },
        { address: p as `0x${string}`, abi: poolAbi, functionName: "slot0" },
        { address: p as `0x${string}`, abi: poolAbi, functionName: "observe", args: [[TWAP, 0]] },
      ]),
    });
    let out: { p: number; depth: number } | null = null;
    pools.forEach((_, i) => {
      const [bal, s0, obs] = reads.slice(i * 3, i * 3 + 3);
      if (bal.status !== "success" || s0.status !== "success") return;
      const depth = Number(bal.result as unknown as bigint) / 10 ** dq;
      // the tick: the 30-minute average when the pool keeps enough history, else now
      const cum = obs.status === "success" ? ((obs.result as any)[0] as bigint[]) : null;
      const tick = cum ? Number((cum[1] - cum[0]) / BigInt(TWAP)) : Number((s0.result as any)[1]);
      // tick = log1.0001(token1 per token0, in base units)
      const raw = 1.0001 ** tick;
      const tIs0 = t.toLowerCase() < quote.toLowerCase();
      const p = (tIs0 ? raw : 1 / raw) * 10 ** (dt - dq);
      if (!out || depth > out.depth) out = { p, depth };
    });
    return out;
  }

  async function compute(t: string): Promise<number | null> {
    t = t.toLowerCase();
    if (c.nativeIsUsdc && (t === "native" || t === usdc)) return 1;
    if (t === usdc) return 1;
    if (t === "native") return wrapped ? price(wrapped) : null;
    if (!usdc) return null;
    const [vsUsdc, vsCoin, coin] = await Promise.all([
      best(t, usdc),
      wrapped && t !== wrapped ? best(t, wrapped) : null,
      wrapped && t !== wrapped ? price(wrapped) : null,
    ]);
    const options = [
      vsUsdc && { p: vsUsdc.p, usd: vsUsdc.depth },
      vsCoin && coin && { p: vsCoin.p * coin, usd: vsCoin.depth * coin },
    ].filter(Boolean) as { p: number; usd: number }[];
    const top = options.sort((a, b) => b.usd - a.usd)[0];
    return top && top.usd >= MIN_DEPTH ? top.p : null;
  }

  /** `t`: a token address, or "native" for the chain's coin. */
  function price(t: string): Promise<number | null> {
    const k = `${c.id}:${t.toLowerCase()}`;
    const hit = cache.get(k);
    if (hit && Date.now() - hit.at < 60_000) return hit.p;
    const p = compute(t).catch(() => null);
    cache.set(k, { at: Date.now(), p });
    return p;
  }
  return price;
}
