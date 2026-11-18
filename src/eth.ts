import { type ChainCfg, batchRpc } from "./chains.ts";
import type { Db } from "./db.ts";

/**
 * A wallet's ETH moves, from an archive node of your own: no node keeps a list of them (they aren't logs) and tracing
 * every block is far too slow. Instead: the wallet's balance and send count, read at past blocks, narrowed down to
 * each block where either changed (15 reads a step; ~0.3 s for 200 on a home reth). Each such block is then read
 * (its transactions and receipts) to say what moved:
 *   out       each transaction the wallet sent that went through (any value, as Alchemy's "external" from it)
 *   in        each transaction to it with value that went through ("external" to it)
 *   internal  ETH sent to it by a contract: what's left of the balance change. Which transaction did it isn't known
 *             without a trace: the wallet's own one in that block, else the one whose input names the wallet, else
 *             not known (hash null: the caller asks elsewhere).
 * Newest first: back in time only as far as the moves asked for need. Kept, so the next ask reads only new blocks.
 */
export type EthMove = { dir: "in" | "out"; kind: "external" | "internal"; hash: string | null; from: string; to: string | null; value: string; block: number; ts: number };

const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);

export function ethHistory(c: ChainCfg, d: Db) {
  // an archive node answers a balance at an old block; a full node has dropped that state
  let archive: Promise<boolean> | null = null;
  const isArchive = () => (archive ??= batchRpc(c, [{ method: "eth_getBalance", params: ["0x000000000000000000000000000000000000dEaD", "0x1"] }]).then(() => true, () => false));

  const states = async (w: string, bs: number[]) => {
    const r = await batchRpc(c, bs.flatMap(b => [{ method: "eth_getBalance", params: [w, hex(b)] }, { method: "eth_getTransactionCount", params: [w, hex(b)] }]));
    return bs.map((_, i) => `${BigInt(r[2 * i])}:${BigInt(r[2 * i + 1])}`);
  };

  /** The blocks in (lo, hi] where the wallet's balance or send count changed. */
  async function changes(w: string, lo: number, hi: number): Promise<number[]> {
    if (hi <= lo) return [];
    const [sLo, sHi] = await states(w, [lo, hi]);
    let open = sLo === sHi ? [] : [{ lo, hi, sLo, sHi }];
    const found: number[] = [];
    while (open.length) {
      const plans: { iv: (typeof open)[number]; pts: number[] }[] = [];
      for (const iv of open) {
        if (iv.hi - iv.lo === 1) {
          found.push(iv.hi);
          continue;
        }
        const n = Math.min(15, iv.hi - iv.lo - 1);
        const pts = [...new Set(Array.from({ length: n }, (_, k) => iv.lo + Math.round(((k + 1) * (iv.hi - iv.lo)) / (n + 1))))].filter(p => p > iv.lo && p < iv.hi);
        plans.push({ iv, pts });
      }
      const st = await states(w, plans.flatMap(p => p.pts));
      let i = 0;
      const next: typeof open = [];
      for (const { iv, pts } of plans) {
        const seq = [{ b: iv.lo, s: iv.sLo }, ...pts.map(b => ({ b, s: st[i++] })), { b: iv.hi, s: iv.sHi }];
        for (let k = 1; k < seq.length; k++) if (seq[k - 1].s !== seq[k].s) next.push({ lo: seq[k - 1].b, hi: seq[k].b, sLo: seq[k - 1].s, sHi: seq[k].s });
      }
      open = next;
    }
    return found;
  }

  /** What moved in each of these blocks, kept. */
  async function read(w: string, bs: number[]) {
    for (let i = 0; i < bs.length; i += 20) {
      const part = bs.slice(i, i + 20);
      const r = await batchRpc(
        c,
        part.flatMap(b => [
          { method: "eth_getBlockByNumber", params: [hex(b), true] },
          { method: "eth_getBlockReceipts", params: [hex(b)] },
          { method: "eth_getBalance", params: [w, hex(b - 1)] },
          { method: "eth_getBalance", params: [w, hex(b)] },
        ]),
      );
      part.forEach((b, j) => {
        const [blk, rcpts, before, after] = r.slice(j * 4, j * 4 + 4);
        const rc = new Map<string, any>((rcpts as any[]).map(x => [x.transactionHash.toLowerCase(), x]));
        const ts = Number(blk.timestamp);
        const moves: EthMove[] = [];
        let left = BigInt(before);
        const own: any[] = [];
        for (const tx of blk.transactions as any[]) {
          const from = tx.from.toLowerCase();
          const to = tx.to?.toLowerCase() ?? null;
          const x = rc.get(tx.hash.toLowerCase());
          const ok = x?.status === "0x1";
          const value = ok ? BigInt(tx.value) : 0n;
          if (from === w) {
            own.push(tx);
            const fee = BigInt(x?.gasUsed ?? 0) * BigInt(x?.effectiveGasPrice ?? tx.gasPrice ?? 0) + BigInt(x?.blobGasUsed ?? 0) * BigInt(x?.blobGasPrice ?? 0);
            left -= fee + value;
            // a failed one isn't listed (as Alchemy): nothing moved but its fee
            if (ok) moves.push({ dir: "out", kind: "external", hash: tx.hash.toLowerCase(), from, to, value: hex(BigInt(tx.value)), block: b, ts });
          }
          if (to === w && value > 0n) {
            left += value;
            moves.push({ dir: "in", kind: "external", hash: tx.hash.toLowerCase(), from, to, value: hex(value), block: b, ts });
          }
        }
        for (const wd of (blk.withdrawals ?? []) as any[]) if (wd.address.toLowerCase() === w) left += BigInt(wd.amount) * 10n ** 9n;
        const internal = BigInt(after) - left;
        if (internal > 0n) {
          const named = (blk.transactions as any[]).filter(tx => tx.from.toLowerCase() !== w && String(tx.input).toLowerCase().includes(w.slice(2)));
          const by = own.length ? own[0] : named.length === 1 ? named[0] : null;
          moves.push({ dir: "in", kind: "internal", hash: by ? by.hash.toLowerCase() : null, from: by?.to?.toLowerCase() ?? "", to: w, value: hex(internal), block: b, ts });
        }
        d.q.addEthmoves.run(c.id, w, b, JSON.stringify(moves));
      });
    }
  }

  const all = (w: string) => (d.q.ethmoves.all(c.id, w) as any[]).flatMap(r => JSON.parse(r.moves) as EthMove[]);
  const count = (w: string, dir: "in" | "out") => all(w).filter(m => m.dir === dir).length;

  // one search per wallet at a time: an ask waits for the one before it
  const running = new Map<string, Promise<unknown>>();
  async function moves(wallet: string, dir: "in" | "out", limit: number): Promise<{ moves: EthMove[]; unresolved: boolean } | null> {
    if (!(await isArchive())) return null;
    const w = wallet.toLowerCase();
    const job = (running.get(w) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const head = Number(BigInt((await batchRpc(c, [{ method: "eth_blockNumber", params: [] }]))[0]));
      let row = d.q.ethscan.get(c.id, w) as any;
      if (!row) {
        d.q.setEthscan.run(c.id, w, head, head);
        row = { low: head, high: head };
      }
      let { low, high } = row as { low: number; high: number };
      // new blocks since last time
      if (head > high) {
        await read(w, await changes(w, high, head));
        high = head;
        d.q.setEthscan.run(c.id, w, low, high);
      }
      // back in time, in growing steps, until there are enough moves (or the chain's first block)
      while (low > 0 && count(w, dir) < limit) {
        const from = Math.max(0, low - Math.max(100_000, high - low));
        await read(w, (await changes(w, from, low)).sort((a, b) => b - a));
        low = from;
        d.q.setEthscan.run(c.id, w, low, high);
      }
    });
    running.set(w, job);
    try {
      await job;
    } finally {
      if (running.get(w) === job) running.delete(w);
    }
    const out = all(w)
      .filter(m => m.dir === dir)
      .sort((a, b) => b.block - a.block)
      .slice(0, limit);
    return { moves: out, unresolved: out.some(m => m.hash === null) };
  }
  return { moves };
}
