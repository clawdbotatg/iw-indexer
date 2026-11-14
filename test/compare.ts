// Same coins, same balances? This indexer's /portfolio next to a reference one (Instant Wallet's, which reads
// Alchemy), for the networks this indexer runs.
//
//   node test/compare.ts 0xADDRESS [indexer url] [reference url]
//
// Prices are compared loosely (this one is a 30-minute pool average): within 5%.
const [a, ix = "http://127.0.0.1:4100", ref = "https://instantwallet.io/api"] = process.argv.slice(2);
if (!a) throw new Error("usage: node test/compare.ts 0xADDRESS [indexer url] [reference url]");
const get = (u: string) => fetch(u).then(r => r.json() as Promise<any>);
const [mine, theirs] = await Promise.all([get(`${ix}/portfolio?address=${a}`), get(`${ref}/portfolio?address=${a}`)]);
const chains = new Set((await get(`${ix}/status`)).chains.map((c: any) => c.id));
const key = (x: any) => `${x.chainId}:${x.asset.toLowerCase()}`;
const m = new Map(mine.assets.map((x: any) => [key(x), x]));
const t = new Map(theirs.assets.filter((x: any) => chains.has(x.chainId)).map((x: any) => [key(x), x]));
let fails = 0;
const say = (ok: boolean, s: string) => (console.log(`${ok ? "PASS" : "FAIL"} ${s}`), ok || fails++);
for (const [k, x] of t as Map<string, any>) {
  const y = m.get(k) as any;
  if (!y) say(false, `missing ${x.symbol} (${k})`);
  else if (y.balance !== x.balance) say(false, `${x.symbol} balance ${y.balance} vs ${x.balance}`);
  else if (x.price && y.price && Math.abs(y.price / x.price - 1) > 0.05) say(false, `${x.symbol} price ${y.price} vs ${x.price}`);
}
for (const [k, y] of m as Map<string, any>) if (!t.has(k)) console.log(`note: extra ${y.symbol} (${k}), not in the reference`);
say(fails === 0, `${t.size} coins on ${[...chains].join(", ")}: ${fails ? "differences above" : "same coins, same balances"}`);
process.exit(fails ? 1 : 0);
