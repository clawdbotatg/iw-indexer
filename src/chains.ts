import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";

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
  tokens: Tok[];
  rpc: string;
  client: PublicClient;
  fromBlock: bigint; // the oldest block a scan goes back to (FROM_BLOCK_<chainId>, else 0)
};

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;

const all = JSON.parse(readFileSync(new URL("../data/chains.json", import.meta.url), "utf8")) as Record<string, Omit<ChainCfg, "id" | "rpc" | "client" | "fromBlock">>;

export function chains(env = process.env): ChainCfg[] {
  const out: ChainCfg[] = [];
  for (const [id, c] of Object.entries(all)) {
    const rpc = env[`RPC_URL_${id}`];
    if (!rpc) continue;
    const client = createPublicClient({ transport: http(rpc, { batch: { batchSize: 100, wait: 0 }, retryCount: 2, timeout: 30_000 }) }) as PublicClient;
    out.push({ ...c, id: Number(id), rpc, client, fromBlock: BigInt(env[`FROM_BLOCK_${id}`] || 0) });
  }
  return out;
}
