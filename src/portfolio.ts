import { formatUnits, getAddress, hexToString, parseAbi } from "viem";
import { multicall, type ChainCfg } from "./chains.ts";
import type { Db } from "./db.ts";
import { pricer } from "./price.ts";

/**
 * A wallet's coins on one chain: the chain's coin, the well-known tokens (data/chains.json: right away, before any
 * scan) and every token the scan has seen move in or out. Each balance read live (balanceOf), so it's always the
 * chain's number. The same rows as Instant Wallet's /api/portfolio (its lib/types.ts Asset).
 */
export type Asset = { chainId: number; asset: string; symbol: string; name: string; decimals: number; balance: string; formatted: string; price: number | null; usd: number | null; logo?: string };
const ETH = "0x0000000000000000000000000000000000000000";
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);
// a few old tokens (MKR) return bytes32 for symbol/name
const erc20b = parseAbi(["function symbol() view returns (bytes32)", "function name() view returns (bytes32)"]);

export function portfolio(c: ChainCfg, d: Db) {
  const known = new Map(c.tokens.map(t => [t.address.toLowerCase(), t]));
  const notToken = new Map<string, number>(); // no decimals() when last asked, and when

  const cached = (t: string) => {
    const k = known.get(t);
    if (k) return { symbol: k.symbol, name: k.symbol, decimals: k.decimals };
    const row = d.q.token.get(c.id, t) as any;
    return row && row.decimals !== null ? (row as { symbol: string; name: string; decimals: number }) : undefined;
  };

  /** Name, symbol, decimals of many tokens: the list, the database, else the chain, all in one Multicall3 call
   * (then kept). A token whose decimals() fails isn't kept: asked again after an hour (a busy node fails a read for a
   * moment, and a coin must never be lost for good over it). */
  async function metas(ts: string[]) {
    const ask = ts.filter(t => !cached(t) && !(Date.now() - (notToken.get(t) ?? 0) < 3600_000));
    if (ask.length) {
      const r = await multicall(c, ask.flatMap(t => {
          const a = t as `0x${string}`;
          return [
            { address: a, abi: erc20, functionName: "decimals" },
            { address: a, abi: erc20, functionName: "symbol" },
            { address: a, abi: erc20, functionName: "name" },
          ] as const;
        }),
        "token",
      );
      await Promise.all(
        ask.map(async (t, i) => {
          const [dec, sym, nm] = r.slice(i * 3, i * 3 + 3);
          if (dec.status !== "success") return notToken.set(t, Date.now());
          const text = async (x: typeof sym, fn: "symbol" | "name") => {
            if (x.status === "success") return String(x.result);
            const b = await c.client.readContract({ address: t as `0x${string}`, abi: erc20b, functionName: fn }).catch(() => null);
            return b ? hexToString(b as `0x${string}`, { size: 32 }).replace(/\0/g, "") : "";
          };
          d.q.addToken.run(c.id, t, (await text(sym, "symbol")) || "?", await text(nm, "name"), Number(dec.result));
        }),
      );
    }
    return new Map(ts.map(t => [t, cached(t) ?? null]));
  }
  const meta = async (t: string) => (await metas([t.toLowerCase()])).get(t.toLowerCase()) ?? null;
  const price = pricer(c, async t => (await meta(t))?.decimals ?? null);

  // one read per wallet at a time: asking again while it runs gets the same answer
  const running = new Map<string, Promise<Asset[]>>();
  return function assets(wallet: string): Promise<Asset[]> {
    const k = wallet.toLowerCase();
    if (!running.has(k)) running.set(k, read(wallet).finally(() => running.delete(k)));
    return running.get(k)!;
  };

  async function read(wallet: string): Promise<Asset[]> {
    const w = getAddress(wallet);
    const seen = (d.q.seen.all(c.id, w.toLowerCase()) as any[]).map(r => r.token as string);
    const list = [...new Set([...known.keys(), ...seen])];
    const [native, bals] = await Promise.all([
      c.client.getBalance({ address: w }),
      multicall(c, list.map(t => ({ address: t as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [w] }) as const), "token"),
    ]);
    const held: [string, bigint][] = [];
    if (!c.nativeIsUsdc && native > 0n) held.push(["native", native]);
    list.forEach((t, i) => {
      const r = bals[i];
      if (r?.status === "success" && (r.result as bigint) > 0n) held.push([t, r.result as bigint]);
    });
    const info = await metas(held.map(([t]) => t).filter(t => t !== "native")).catch(() => new Map());
    const rows = await Promise.all(
      held.map(async ([t, bal]): Promise<Asset | null> => {
        const m = t === "native" ? { ...c.native, decimals: 18 } : info.get(t);
        if (!m) return null;
        let p = await price(t);
        const formatted = formatUnits(bal, m.decimals);
        // worth more than its pool holds: the pool couldn't pay it, so no price (Alchemy has none for such coins)
        if (p !== null && Number(formatted) * p > price.depth(t)) p = null;
        return {
          chainId: c.id,
          asset: t === "native" ? ETH : getAddress(t),
          symbol: m.symbol,
          name: m.name || m.symbol,
          decimals: m.decimals,
          balance: bal.toString(),
          formatted,
          price: p,
          usd: p === null ? null : Number(formatted) * p,
        };
      }),
    );
    return rows.filter(Boolean) as Asset[];
  }
}
