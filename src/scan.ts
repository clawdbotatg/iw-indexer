import { decodeAbiParameters, toEventSelector } from "viem";
import { type ChainCfg, learnSpan } from "./chains.ts";
import type { Db } from "./db.ts";

/**
 * Reads every ERC-20 Transfer to or from the watched wallets, from your node's logs, and every NFT move (ERC-721
 * Transfer, ERC-1155 TransferSingle / TransferBatch) for src/nft.ts.
 *   back:    from where the wallet was added, back in time to the chain's fromBlock, newest first (recent coins show
 *            up first), one wallet at a time, in ranges that grow while the node keeps up and shrink when it refuses.
 *   forward: every new block, all wallets of a chain in one query each way (in, out). 12 blocks are read again each
 *            time, so a reorg's new logs aren't missed.
 * Balances are never added up from these: /portfolio reads balanceOf live. The logs only say which coins to ask about.
 */
export const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
const SINGLE = toEventSelector("TransferSingle(address,address,address,uint256,uint256)");
const BATCH = toEventSelector("TransferBatch(address,address,address,uint256[],uint256[])");
const pad = (a: string) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const unpad = (t: string) => "0x" + t.slice(26).toLowerCase();
const OVERLAP = 12n;

type Log = { address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string; logIndex: string };

export function scanner(c: ChainCfg, d: Db, log = (..._: unknown[]) => {}) {
  const rpc = <T>(method: string, params: unknown[]) => c.client.request({ method: method as any, params: params as any }) as Promise<T>;
  const head = async () => BigInt(await rpc<string>("eth_blockNumber", []));

  const keep = (logs: Log[], wallets: Set<string>) => {
    for (const l of logs) {
      const at = [c.id, Number(BigInt(l.blockNumber)), l.transactionHash, Number(BigInt(l.logIndex))] as const;
      const token = l.address.toLowerCase();
      if (l.topics[0] === TRANSFER && l.topics.length === 4) {
        // ERC-721: the token id is the third topic
        d.q.nftMove.run(...at, 0, token, unpad(l.topics[1]), unpad(l.topics[2]), BigInt(l.topics[3]).toString(), "1", 721);
        continue;
      }
      if (l.topics[0] === SINGLE || l.topics[0] === BATCH) {
        const src = unpad(l.topics[2]), dst = unpad(l.topics[3]);
        try {
          const [ids, vals] =
            l.topics[0] === SINGLE
              ? decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], l.data as `0x${string}`).map(x => [x as bigint])
              : (decodeAbiParameters([{ type: "uint256[]" }, { type: "uint256[]" }], l.data as `0x${string}`) as unknown as bigint[][]);
          ids.forEach((id, i) => d.q.nftMove.run(...at, i, token, src, dst, id.toString(), (vals[i] ?? 0n).toString(), 1155));
        } catch {} // not what the standard says: not an NFT move
        continue;
      }
      if (l.topics.length !== 3) continue;
      const src = unpad(l.topics[1]), dst = unpad(l.topics[2]);
      for (const w of [src, dst]) if (wallets.has(w)) d.q.see.run(c.id, w, token);
      d.q.move.run(c.id, Number(BigInt(l.blockNumber)), l.transactionHash, Number(BigInt(l.logIndex)), token, src, dst, BigInt(l.data === "0x" ? 0 : l.data).toString());
    }
  };
  const getLogs = <T>(params: unknown[]) => c.logs.request({ method: "eth_getLogs" as any, params: params as any }) as Promise<T>;
  const logs = async (from: bigint, to: bigint, ws: string[]): Promise<Log[]> => {
    // wider than the node takes in one search: in pieces it does, all at once (the node's pace holds them)
    if (c.span !== undefined && to - from + 1n > c.span) {
      const parts: Promise<Log[]>[] = [];
      for (let a = from; a <= to; a += c.span) parts.push(logs(a, a + c.span - 1n < to ? a + c.span - 1n : to, ws));
      return (await Promise.all(parts)).flat();
    }
    const t = ws.map(pad);
    const range = { fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
    const [out, inn, out1155, in1155] = await Promise.all([
      getLogs<Log[]>([{ ...range, topics: [TRANSFER, t] }]),
      getLogs<Log[]>([{ ...range, topics: [TRANSFER, null, t] }]),
      getLogs<Log[]>([{ ...range, topics: [[SINGLE, BATCH], null, t] }]),
      getLogs<Log[]>([{ ...range, topics: [[SINGLE, BATCH], null, null, t] }]),
    ]);
    return [...out, ...inn, ...out1155, ...in1155];
  };

  /** Start watching a wallet here (no-op if it already is). */
  async function watch(wallet: string) {
    const w = wallet.toLowerCase();
    if (d.q.wallet.get(c.id, w)) return;
    const h = await head();
    d.q.addWallet.run(c.id, w, Number(h), Number(h) + 1, Number(h), Date.now());
  }

  // per wallet: its block range going back (adapts to what the node takes), and whose turn it is
  const spans = new Map<string, bigint>();
  let turn = 0;


  /** One step back in time for one wallet not done yet, each in turn (a slow one doesn't hold up the rest).
   * false: nothing left to do. */
  async function back(): Promise<boolean> {
    const rows = (d.q.wallets.all() as any[]).filter(r => r.chain === c.id && BigInt(r.low) > c.fromBlock);
    if (!rows.length) return false;
    const r = rows[turn++ % rows.length];
    const want = spans.get(r.wallet) ?? 100_000n;
    // your own node: 8 of its searches a step, side by side; else what the node is known to take
    const span = c.span === undefined ? want : c.own ? c.span * 8n : want > c.span ? c.span : want;
    const to = BigInt(r.low) - 1n;
    const from = to - span + 1n > c.fromBlock ? to - span + 1n : c.fromBlock;
    try {
      const got = await logs(from, to, [r.wallet]);
      keep(got, new Set([r.wallet]));
      d.q.setLow.run(Number(from), c.id, r.wallet);
      if (got.length < 2000 && span < 5_000_000n) spans.set(r.wallet, span * 2n);
      log(c.name, r.wallet.slice(0, 8), "back to", from, got.length, "logs");
    } catch (e: any) {
      const why = String(e?.shortMessage || e?.message || e).slice(0, 80);
      if (learnSpan(c, e)) {
        // asked again next turn, within what the node takes
      } else if (span > 1n) {
        spans.set(r.wallet, span > 4n ? span / 4n : 1n); // the node refused (too many results, too big): smaller
        log(c.name, r.wallet.slice(0, 8), "smaller range", span, why);
      } else {
        // one block it can't answer: skipped, said, never stuck on
        d.q.setLow.run(Number(from), c.id, r.wallet);
        console.log(`${c.name}: skipped block ${from} for ${r.wallet} (${why})`);
      }
    }
    return true;
  }

  /** New blocks, every wallet on this chain at once. */
  async function forward() {
    const rows = (d.q.wallets.all() as any[]).filter(r => r.chain === c.id);
    if (!rows.length) return;
    const h = await head();
    const from = BigInt(Math.min(...rows.map(r => r.head))) - OVERLAP;
    if (h <= from) return;
    const step = c.span !== undefined && c.span < 2000n ? c.span : 2000n;
    for (let a = from; a <= h; a += step) {
      const b = a + step - 1n < h ? a + step - 1n : h;
      keep(await logs(a, b, rows.map(r => r.wallet)), new Set(rows.map(r => r.wallet)));
    }
    for (const r of rows) d.q.setHead.run(Number(h), c.id, r.wallet);
  }

  return { watch, back, forward };
}
