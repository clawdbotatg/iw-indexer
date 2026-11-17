import { createServer } from "node:http";
import { isAddress } from "viem";
import { chains } from "./chains.ts";
import { open } from "./db.ts";
import { portfolio, type Asset } from "./portfolio.ts";
import { scanner } from "./scan.ts";

/**
 * iw-indexer: a wallet's coins, prices and transfers from your own node. README.md says how to run it.
 *
 *   GET /portfolio?address=0x…   every chain: { totalUsd, assets: Asset[], late?: chainId[] } (Instant Wallet's shape).
 *                                The first ask starts watching that wallet (MAX_WALLETS, default 100).
 *   GET /transfers?address=0x…&chain=8453[&in=1][&limit=50]   { complete, transfers }: ERC-20 moves, newest first, each
 *                                with its block's time (at) and the token's symbol and decimals; complete once the
 *                                scan has reached the wallet's first block
 *   GET /status                  each chain's wallets and how far back their scan has got
 */
const PORT = Number(process.env.INDEXER_PORT || 4100);
const MAX_WALLETS = Number(process.env.MAX_WALLETS || 100);
const LATE_MS = Number(process.env.LATE_MS || 8000);
const verbose = !!process.env.VERBOSE;
const log = (...a: unknown[]) => verbose && console.log(new Date().toISOString().slice(11, 19), ...a);

// a failure nobody waited for is logged, never the end of the service
process.on("unhandledRejection", e => console.error("unhandled:", String((e as any)?.message || e).slice(0, 300)));
process.on("uncaughtException", e => console.error("uncaught:", String(e?.stack || e).slice(0, 600)));
process.on("exit", code => console.error("exit", code));

const cs = chains();
if (!cs.length) {
  console.error("No networks: set RPC_URL_<chainId>=<your node> (RPC_URL_1, RPC_URL_8453, ...). See README.md.");
  process.exit(1);
}
const d = open(process.env.DB || "indexer.db");
const per = cs.map(c => ({ c, scan: scanner(c, d, log), assets: portfolio(c, d) }));

// the scan: new blocks every 12 s per chain; back in time in between, a step every half second at most
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
for (const p of per) {
  (async () => {
    for (;;) {
      try {
        await p.scan.forward();
        const t = Date.now();
        while (Date.now() - t < 12_000) if (await p.scan.back()) await sleep(500); else await sleep(12_000 - (Date.now() - t));
      } catch (e: any) {
        log(p.c.name, "scan:", String(e?.shortMessage || e?.message || e).slice(0, 120));
        await sleep(12_000);
      }
    }
  })();
}

const watched = () => new Set((d.q.wallets.all() as any[]).map(r => r.wallet)).size;
const json = (res: any, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  const u = new URL(req.url || "/", "http://x");
  try {
    if (u.pathname === "/portfolio") {
      const a = u.searchParams.get("address") || "";
      if (!isAddress(a)) return json(res, 400, { error: "address required" });
      const w = a.toLowerCase();
      if (!(d.q.wallets.all() as any[]).some(r => r.wallet === w) && watched() >= MAX_WALLETS) return json(res, 429, { error: "watching too many wallets (MAX_WALLETS)" });
      for (const p of per) p.scan.watch(w).catch(e => log(p.c.name, "watch:", e?.message));
      const late: number[] = [];
      const lists = await Promise.all(
        per.map(p =>
          Promise.race([p.assets(a), new Promise<null>(r => setTimeout(() => r(null), LATE_MS))])
            .catch(e => (log(p.c.name, "portfolio:", e?.message), null))
            .then(x => (x === null && late.push(p.c.id), x ?? [])),
        ),
      );
      const assets = (lists.flat() as Asset[]).sort((x, y) => (y.usd ?? -1) - (x.usd ?? -1) || Number(y.formatted) - Number(x.formatted));
      const priced = assets.filter(x => x.usd !== null);
      return json(res, 200, { totalUsd: priced.length ? priced.reduce((s, x) => s + (x.usd ?? 0), 0) : null, assets, ...(late.length ? { late } : {}) });
    }
    if (u.pathname === "/transfers") {
      const a = (u.searchParams.get("address") || "").toLowerCase();
      const chain = Number(u.searchParams.get("chain"));
      const limit = Math.min(Number(u.searchParams.get("limit") || 50), 500);
      const p = per.find(p => p.c.id === chain);
      if (!isAddress(a) || !p) return json(res, 400, { error: "address and chain required" });
      const rows = (u.searchParams.get("in") ? d.q.movesIn.all(chain, a, limit) : d.q.movesAll.all(chain, a, a, limit)) as any[];
      // complete: the scan has reached the wallet's first block, so this is its whole history
      const w = d.q.wallet.get(chain, a) as any;
      const complete = !!w && BigInt(w.low) <= p.c.fromBlock;
      // each move with its block's time (asked once, kept) and its token's symbol and decimals
      const times = new Map<number, number>();
      await Promise.all(
        [...new Set(rows.map(r => Number(r.block)))].map(async b => {
          let ts = (d.q.blockTs.get(chain, b) as any)?.ts;
          if (ts == null) {
            ts = Number((await p.c.client.getBlock({ blockNumber: BigInt(b) })).timestamp);
            d.q.setBlockTs.run(chain, b, ts);
          }
          times.set(b, ts);
        }),
      );
      const transfers = rows.map(r => {
        const t = d.q.token.get(chain, r.token) as any;
        return { ...r, at: times.get(Number(r.block)), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null };
      });
      return json(res, 200, { complete, transfers });
    }
    if (u.pathname === "/status") {
      const rows = d.q.wallets.all() as any[];
      return json(res, 200, {
        chains: per.map(p => ({
          id: p.c.id,
          name: p.c.name,
          wallets: rows.filter(r => r.chain === p.c.id).map(r => ({ wallet: r.wallet, head: r.head, backTo: r.low, done: BigInt(r.low) <= p.c.fromBlock })),
        })),
      });
    }
    json(res, 404, { error: "not found" });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message || e) });
  }
}).listen(PORT, process.env.HOST || "127.0.0.1", () => console.log(`iw-indexer on http://127.0.0.1:${PORT} · ${cs.map(c => c.name).join(", ")}`));
