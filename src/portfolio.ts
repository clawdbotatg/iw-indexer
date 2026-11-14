import { formatUnits, getAddress, hexToString, parseAbi } from "viem";
import { MULTICALL3, type ChainCfg } from "./chains.ts";
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

  /** name, symbol, decimals: the list, the database, else the chain (then kept). null: not a token. */
  async function meta(t: string): Promise<{ symbol: string; name: string; decimals: number } | null> {
    t = t.toLowerCase();
    const k = known.get(t);
    if (k) return { symbol: k.symbol, name: k.symbol, decimals: k.decimals };
    const row = d.q.token.get(c.id, t) as any;
    if (row) return row.decimals === null ? null : row;
    const a = t as `0x${string}`;
    const [dec, sym, nm] = await c.client.multicall({
      multicallAddress: MULTICALL3,
      allowFailure: true,
      contracts: [
        { address: a, abi: erc20, functionName: "decimals" },
        { address: a, abi: erc20, functionName: "symbol" },
        { address: a, abi: erc20, functionName: "name" },
      ],
    });
    if (dec.status !== "success") {
      d.q.addToken.run(c.id, t, null, null, null);
      return null;
    }
    const text = async (r: typeof sym, fn: "symbol" | "name") => {
      if (r.status === "success") return String(r.result);
      const b = await c.client.readContract({ address: a, abi: erc20b, functionName: fn }).catch(() => null);
      return b ? hexToString(b as `0x${string}`, { size: 32 }).replace(/\0/g, "") : "";
    };
    const m = { symbol: (await text(sym, "symbol")) || "?", name: await text(nm, "name"), decimals: Number(dec.result) };
    d.q.addToken.run(c.id, t, m.symbol, m.name, m.decimals);
    return m;
  }
  const price = pricer(c, async t => (await meta(t))?.decimals ?? null);

  return async function assets(wallet: string): Promise<Asset[]> {
    const w = getAddress(wallet);
    const seen = (d.q.seen.all(c.id, w.toLowerCase()) as any[]).map(r => r.token as string);
    const list = [...new Set([...known.keys(), ...seen])];
    const [native, bals] = await Promise.all([
      c.client.getBalance({ address: w }),
      c.client.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: true,
        contracts: list.map(t => ({ address: t as `0x${string}`, abi: erc20, functionName: "balanceOf", args: [w] }) as const),
      }),
    ]);
    const held: [string, bigint][] = [];
    if (!c.nativeIsUsdc && native > 0n) held.push(["native", native]);
    list.forEach((t, i) => {
      const r = bals[i];
      if (r?.status === "success" && (r.result as bigint) > 0n) held.push([t, r.result as bigint]);
    });
    const rows = await Promise.all(
      held.map(async ([t, bal]): Promise<Asset | null> => {
        const m = t === "native" ? { ...c.native, decimals: 18 } : await meta(t).catch(() => null);
        if (!m) return null;
        const p = await price(t);
        const formatted = formatUnits(bal, m.decimals);
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
  };
}
