import { createServer } from "node:http";
import { isAddress } from "viem";
import { NETWORKS, chains } from "./chains.ts";
import { open } from "./db.ts";
import { portfolio, type Asset } from "./portfolio.ts";
import { scanner } from "./scan.ts";
import { v4Sync } from "./v4.ts";
import { ethHistory } from "./eth.ts";
import { type Nft, nfts } from "./nft.ts";

/**
 * iw-indexer: a wallet's coins, prices and transfers from your own node. README.md says how to run it.
 *
 *   GET /portfolio?address=0x…   every chain: { totalUsd, assets: Asset[], late?: chainId[] } (Instant Wallet's shape).
 *                                The first ask starts watching that wallet (MAX_WALLETS, default 100).
 *   GET /transfers?address=0x…&chain=8453[&in=1][&limit=50]   { complete, transfers }: ERC-20 moves, newest first, each
 *                                with its block's time (at) and the token's symbol and decimals; complete once the
 *                                scan has reached the wallet's first block
 *   GET /nfts?address=0x…&chain=1   { complete, nfts, progress }: the NFTs it holds (src/nft.ts), once its scan is
 *                                done and each NFT's name and picture read (progress: how far, 0 to 1, until then)
 *   GET /eth?address=0x…&chain=1&dir=in|out[&limit=50]   { moves, unresolved }: its ETH moves, newest first (an
 *                                archive node of your own only: src/eth.ts)
 *   GET /node                    { networks, nodes: { chainId: url } }; POST /node { chain, url } sets one (checked, kept, restarts)
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

const d = open(process.env.DB || "indexer.db");
// the node set in Instant Wallet's Settings (POST /node) wins over RPC_URL_<chainId>; its log searches go to it too
const env: Record<string, string | undefined> = { ...process.env };
for (const n of d.q.nodes.all() as { chain: number; url: string }[]) {
  if (env[`RPC_URL_${n.chain}`] !== n.url) delete env[`LOGS_URL_${n.chain}`];
  env[`RPC_URL_${n.chain}`] = n.url;
}
const cs = chains(env);
if (!cs.length) console.error("No networks yet: set one in Instant Wallet's Settings, or RPC_URL_<chainId>=<your node>. See README.md.");
const per = cs.map(c => ({ c, scan: scanner(c, d, log), assets: portfolio(c, d), eth: ethHistory(c, d), nfts: nfts(c, d) }));

// the scan: new blocks every 12 s per chain; back in time in between, a step every half second at most (your own
// node: no wait)
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
for (const p of per) {
  (async () => {
    for (;;) {
      try {
        await p.scan.forward();
        const t = Date.now();
        while (Date.now() - t < 12_000) if (await p.scan.back()) await sleep(p.c.own ? 0 : 500); else await sleep(12_000 - (Date.now() - t));
      } catch (e: any) {
        log(p.c.name, "scan:", String(e?.shortMessage || e?.message || e).slice(0, 120));
        await sleep(12_000);
      }
    }
  })();
}

// every v4 pool, on a network read from your own node: caught up every 12 s
for (const p of per)
  if (p.c.v4 && p.c.own)
    (async () => {
      for (;;) {
        await v4Sync(p.c, d).catch(e => console.error(p.c.name, "v4 pools:", String(e?.message || e).slice(0, 160)));
        await sleep(12_000);
      }
    })();

// each wallet's NFTs, worked out in the background and kept a minute: the first time takes a while (its whole history
// scanned, then every NFT's name and picture read), so it starts as soon as the scan is done, not when it's asked for
type Job = { at: number; v: Nft[] | null; f: number; run: Promise<void> | null };
const nftJobs = new Map<string, Job>();
const scanned = (p: (typeof per)[number], w: any) => !!w && BigInt(w.low) <= p.c.fromBlock;
function nftJob(p: (typeof per)[number], a: string): Job {
  const k = `${p.c.id}:${a}`;
  let j = nftJobs.get(k);
  if (!j) nftJobs.set(k, (j = { at: 0, v: null, f: 0, run: null }));
  if (!j.run && Date.now() - j.at > 60_000) {
    const job = j;
    job.run = p
      .nfts(a, f => (job.f = f))
      .then(v => {
        job.v = v;
        job.at = Date.now();
      })
      .catch(e => void log(p.c.name, "nfts:", String(e?.message || e).slice(0, 120)))
      .finally(() => {
        job.run = null;
      });
  }
  return j;
}
setInterval(() => {
  for (const w of d.q.wallets.all() as any[]) {
    const p = per.find(p => p.c.id === w.chain);
    if (p && scanned(p, w) && !nftJobs.get(`${p.c.id}:${w.wallet}`)?.v) nftJob(p, w.wallet);
  }
}, 15_000);

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
      const ask: number[] = [];
      for (const b of new Set(rows.map(r => Number(r.block)))) {
        const ts = (d.q.blockTs.get(chain, b) as any)?.ts;
        if (ts == null) ask.push(b);
        else times.set(b, ts);
      }
      // the rest in batches (RPC_BATCH a request; one by one, 500 took over a minute)
      const step = Number.isFinite(p.c.batch) ? p.c.batch : 100;
      await Promise.all(
        Array.from({ length: Math.ceil(ask.length / step) }, (_, i) => ask.slice(i * step, (i + 1) * step)).map(async bs => {
          const r = await fetch(p.c.rpc, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(bs.map((b, id) => ({ jsonrpc: "2.0", id, method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] }))),
          }).then(r => r.json());
          for (const x of Array.isArray(r) ? r : []) {
            const b = bs[x.id];
            if (b === undefined || !x.result?.timestamp) continue;
            const ts = Number(x.result.timestamp);
            d.q.setBlockTs.run(chain, b, ts);
            times.set(b, ts);
          }
        }),
      );
      // a block the node didn't answer: an error, never a list with a move missing
      if (rows.some(r => !times.has(Number(r.block)))) return json(res, 503, { error: "the node didn't give every block's time; ask again" });
      const metas = await p.assets.metas([...new Set(rows.map(r => r.token as string))]).catch(() => new Map());
      const transfers = rows.map(r => {
        const t = metas.get(r.token);
        return { ...r, at: times.get(Number(r.block)), symbol: t?.symbol ?? null, decimals: t?.decimals ?? null };
      });
      return json(res, 200, { complete, transfers });
    }
    if (u.pathname === "/nfts") {
      // a wallet's NFTs (src/nft.ts); complete once its scan has reached its first block and its NFTs are worked out
      const a = (u.searchParams.get("address") || "").toLowerCase();
      const p = per.find(p => p.c.id === Number(u.searchParams.get("chain")));
      if (!isAddress(a) || !p) return json(res, 400, { error: "address and chain required" });
      const w = d.q.wallet.get(p.c.id, a) as any;
      if (!w) p.scan.watch(a).catch(e => log(p.c.name, "watch:", e?.message));
      // the scan is most of the wait (back from today to the network's first block), then the names and pictures
      if (!scanned(p, w)) {
        const f = w ? Number(BigInt(w.top) - BigInt(w.low)) / Math.max(1, Number(BigInt(w.top) - p.c.fromBlock)) : 0;
        return json(res, 200, { complete: false, progress: 0.8 * f, nfts: [] });
      }
      const j = nftJob(p, a);
      if (!j.v && j.run) await Promise.race([j.run, sleep(3_000)]);
      if (!j.v) return json(res, 200, { complete: false, progress: 0.8 + 0.2 * j.f, nfts: [] });
      return json(res, 200, { complete: true, nfts: j.v });
    }
    if (u.pathname === "/eth") {
      // a wallet's ETH moves (src/eth.ts): an archive node of your own only (else 501: ask elsewhere)
      const a = (u.searchParams.get("address") || "").toLowerCase();
      const p = per.find(p => p.c.id === Number(u.searchParams.get("chain")));
      const dir = u.searchParams.get("dir") === "out" ? "out" : "in";
      const limit = Math.min(Number(u.searchParams.get("limit") || 50), 500);
      if (!isAddress(a) || !p) return json(res, 400, { error: "address and chain required" });
      if (!p.c.own) return json(res, 501, { error: "only from a node of your own" });
      const r = await p.eth.moves(a, dir, limit);
      if (!r) return json(res, 501, { error: "not an archive node" });
      return json(res, 200, { complete: true, ...r });
    }
    if (u.pathname === "/node") {
      // a key in the address (…/v2/<key>) never shown
      if (req.method !== "POST") return json(res, 200, { networks: NETWORKS, nodes: Object.fromEntries(cs.map(c => [c.id, c.rpc.replace(/\/v2\/[^/?#]+/, "/v2/…")])) });
      // JSON only: a web page can't send that here without asking first (and this answers no such ask), so no site
      // you visit can point your indexer at its own node
      if (!(req.headers["content-type"] || "").startsWith("application/json")) return json(res, 415, { error: "JSON only" });
      // { chain, url }: this network reads from url (null: back to RPC_URL_<chainId>). Checked first, kept, then the
      // indexer restarts on it (run-local.sh starts it again)
      const b = await new Promise<any>(r => {
        let t = "";
        req.on("data", (x: Buffer) => (t += x));
        req.on("end", () => r((() => { try { return JSON.parse(t); } catch { return {}; } })()));
      });
      const chain = Number(b.chain);
      if (!Number.isInteger(chain) || chain <= 0) return json(res, 400, { error: "chain required" });
      if (b.url) {
        if (!/^https?:\/\/[^\s]+$/.test(b.url)) return json(res, 400, { error: "Not a node address (http://…)." });
        const id = await fetch(b.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(5000) })
          .then(r => r.json())
          .then(j => Number(j.result))
          .catch(() => null);
        if (id === null) return json(res, 400, { error: "That node didn't answer." });
        if (id !== chain) return json(res, 400, { error: `That node is on network ${id}, not ${chain}.` });
        d.q.setNode.run(chain, b.url);
      } else d.q.dropNode.run(chain);
      json(res, 200, { ok: true, restarting: true });
      setTimeout(() => process.exit(0), 200);
      return;
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
