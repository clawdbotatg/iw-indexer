// Every wallet in test/wallets.json: this indexer's /portfolio next to a reference one (Instant Wallet's, which reads
// Alchemy), on the networks this indexer runs. Run it after every change.
//
//   node test/suite.ts [indexer url] [reference url]     (defaults: http://127.0.0.1:4100, http://127.0.0.1:3000/api)
//
// 1. asks the indexer about every wallet (that starts its scan), 2. waits for the scans (WAIT_MIN, 30),
// 3. compares. A coin the reference prices that the indexer misses, or a different balance, fails; a price more than
// 5% off fails too, and so does a coin worth $10+ there that has no price here. Unpriced coins (spam, mostly) it misses are counted, not failed. Balances move while a trader
// trades: a difference is asked again once before it counts.
// One wallet at a time, PAUSE_MS (3000) apart: the indexer and the reference may share one node provider.
// The table goes to the screen; every detail to test/results/<date>.json.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const [ix = "http://127.0.0.1:4100", ref = "http://127.0.0.1:3000/api"] = process.argv.slice(2);
const WAIT_MIN = Number(process.env.WAIT_MIN || 30);
const only = process.env.ONLY; // a label or address part: run just those
const { wallets } = JSON.parse(readFileSync(new URL("./wallets.json", import.meta.url), "utf8")) as { wallets: { address: string; label: string }[] };
const list = only ? wallets.filter(w => (w.label + w.address).toLowerCase().includes(only.toLowerCase())) : wallets;
const get = (u: string) => fetch(u, { signal: AbortSignal.timeout(60_000) }).then(r => r.json() as Promise<any>);
const pool = async <T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) => {
  const out: R[] = [];
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
};

// 1. start every scan
const chains = new Set<number>((await get(`${ix}/status`)).chains.map((c: any) => c.id));
console.log(`${list.length} wallets, networks ${[...chains].join(", ")}`);
// one at a time, a pause between: both sides read from the same node provider (Alchemy), and it has limits
const PAUSE = Number(process.env.PAUSE_MS || 3000);
const rest = () => new Promise(r => setTimeout(r, PAUSE));
await pool(list, 1, w => get(`${ix}/portfolio?address=${w.address}`).catch(() => null).then(rest));

// 2. wait for the scans back in time
const t0 = Date.now();
for (;;) {
  const st = await get(`${ix}/status`);
  const want = new Set(list.map(w => w.address.toLowerCase()));
  const rows = st.chains.flatMap((c: any) => c.wallets.filter((w: any) => want.has(w.wallet)));
  const left = rows.filter((w: any) => !w.done).length;
  if (!left) break;
  if (Date.now() - t0 > WAIT_MIN * 60_000) {
    console.log(`still scanning after ${WAIT_MIN} min: ${left} of ${rows.length}; comparing anyway`);
    break;
  }
  process.stdout.write(`\rscanning: ${rows.length - left}/${rows.length} done (${Math.round((Date.now() - t0) / 1000)} s)   `);
  await new Promise(r => setTimeout(r, 10_000));
}
console.log();

// 3. compare
type Diff = { kind: "missing" | "balance" | "price" | "no-price" | "missing-unpriced" | "extra"; chain: number; symbol: string; asset: string; mine?: string | number; theirs?: string | number };
const key = (x: any) => `${x.chainId}:${x.asset.toLowerCase()}`;
async function compare(w: { address: string; label: string }) {
  const once = async () => {
    // the reference can be slow (it asks 14 networks): a network either side was late on is left out, and an
    // answer with nothing late but nothing at all while ours has coins is asked again
    let m: any, t: any;
    for (let i = 0; i < 2; i++) {
      [m, t] = await Promise.all([get(`${ix}/portfolio?address=${w.address}`), get(`${ref}/portfolio?address=${w.address}`)]);
      const lateRef = (t.late ?? []).filter((c: number) => chains.has(c)).length;
      if (!lateRef && (t.assets?.length || !m.assets?.length)) break;
      await new Promise(r => setTimeout(r, 10_000));
    }
    const late = new Set<number>([...(t.late ?? []), ...(m.late ?? [])]);
    if (!Array.isArray(t.assets)) throw new Error("no reference answer");
    const mine = new Map<string, any>(m.assets.filter((x: any) => !late.has(x.chainId)).map((x: any) => [key(x), x]));
    const theirs = new Map<string, any>(t.assets.filter((x: any) => chains.has(x.chainId) && !late.has(x.chainId)).map((x: any) => [key(x), x]));
    const diffs: Diff[] = [];
    for (const [k, x] of theirs) {
      const y = mine.get(k);
      const d = { chain: x.chainId, symbol: x.symbol, asset: x.asset };
      if (!y) diffs.push({ ...d, kind: x.usd ? "missing" : "missing-unpriced", theirs: x.formatted });
      // a balance that grows by the block (Aave's aTokens and debt) is the same within 0.001%; an unpriced coin's
      // (spam that fakes balanceOf) isn't checked
      else if (y.balance !== x.balance && x.usd && Math.abs(Number(y.balance) / Number(x.balance) - 1) > 1e-5) diffs.push({ ...d, kind: "balance", mine: y.formatted, theirs: x.formatted });
      else if (x.price && y.price && Math.abs(y.price / x.price - 1) > 0.05) diffs.push({ ...d, kind: "price", mine: y.price, theirs: x.price });
      else if (x.usd >= 10 && y.price === null) diffs.push({ ...d, kind: "no-price", theirs: `$${Math.round(x.usd)}` });
    }
    for (const [k, y] of mine) if (!theirs.has(k) && !(t.late ?? []).includes(y.chainId)) diffs.push({ kind: "extra", chain: y.chainId, symbol: y.symbol, asset: y.asset, mine: y.formatted });
    const usd = (l: Map<string, any>) => [...l.values()].reduce((s, x) => s + (x.usd ?? 0), 0);
    return { coins: theirs.size, diffs, usdMine: usd(mine), usdTheirs: usd(theirs) };
  };
  try {
    let r = await once();
    if (r.diffs.some(d => d.kind === "balance" || d.kind === "missing")) r = await once(); // a trade in between
    const fails = r.diffs.filter(d => d.kind === "missing" || d.kind === "balance" || d.kind === "price" || d.kind === "no-price");
    return { ...w, ...r, fails: fails.length, ok: fails.length === 0 };
  } catch (e: any) {
    return { ...w, coins: 0, diffs: [], usdMine: 0, usdTheirs: 0, fails: 1, ok: false, error: String(e?.message || e) };
  }
}
const results = await pool(list, 1, w => compare(w).then(async r => (await rest(), r)));

const n = (k: Diff["kind"]) => results.reduce((s, r) => s + r.diffs.filter(d => d.kind === k).length, 0);
for (const r of results) {
  const pct = r.usdTheirs ? ((r.usdMine / r.usdTheirs - 1) * 100).toFixed(1) + "%" : "-";
  const fl = r.diffs.filter(d => d.kind !== "missing-unpriced" && d.kind !== "extra").slice(0, 3).map(d => `${d.kind} ${d.symbol}@${d.chain}`).join(", ");
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.label.padEnd(26).slice(0, 26)} ${String(r.coins).padStart(4)} coins  $ ${pct.padStart(7)}  ${(r as any).error ?? fl}`);
}
const ok = results.filter(r => r.ok).length;
console.log(`\n${ok}/${results.length} wallets pass. Coins compared ${results.reduce((s, r) => s + r.coins, 0)}: missing priced ${n("missing")}, balance ${n("balance")}, price ${n("price")}, no price (worth $10+) ${n("no-price")}, missing unpriced ${n("missing-unpriced")}, extra ${n("extra")}`);
mkdirSync(new URL("./results/", import.meta.url), { recursive: true });
const file = new URL(`./results/${new Date().toISOString().slice(0, 16).replace(":", "")}.json`, import.meta.url);
writeFileSync(file, JSON.stringify({ ix, ref, chains: [...chains], results }, null, 1));
console.log(`details: ${file.pathname}`);
process.exit(ok === results.length ? 0 : 1);
