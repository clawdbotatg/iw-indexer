// Makes test/wallets.json: the wallets every change is checked against (test/suite.ts).
//   - well-known people, by ENS name (resolved on Ethereum)
//   - active traders: who sent swaps through a Universal Router (any address: its execute() call) in the last blocks
//     of each network,
//     people not bots (a normal account, 50 to 20,000 transactions)
//
//   RPC_URL_1=… RPC_URL_8453=… RPC_URL_42161=… RPC_URL_10=… node test/find-wallets.ts
//
// Run again now and then: traders come and go. Every address here is public.
import { writeFileSync } from "node:fs";
import { createPublicClient, http, getAddress, type PublicClient } from "viem";
import { normalize } from "viem/ens";
import { mainnet } from "viem/chains";

const NAMES = [
  "vitalik.eth", "nick.eth", "brantly.eth", "austingriffith.eth", "sassal.eth", "hayden.eth", "stani.eth", "ricmoo.eth",
  "jessepollak.eth", "dwr.eth", "balajis.eth", "coopahtroopa.eth", "punk6529.eth", "pranksy.eth", "dcinvestor.eth",
  "cdixon.eth", "lefteris.eth", "ryansadams.eth", "fredwilson.eth", "beaniemaxi.eth", "cobie.eth", "tim.eth",
  "jefflau.eth", "matoken.eth", "anthonysassano.eth", "tschoerv.eth", "spencernoon.eth", "garypalmerjr.eth",
  "cryptocobain.eth", "loopifyyy.eth", "evanvanness.eth", "trent.eth", "kain.eth", "superphiz.eth",
  "dannyryan.eth", "timbeiko.eth", "jbaylina.eth", "gavofyork.eth", "mrjasonchoi.eth",
];
const ROUTERS: Record<number, string[]> = {
  1: ["0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af", "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD"],
  8453: ["0x6fF5693b99212Da76ad316178A184AB56D299b43", "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD"],
  42161: ["0xA51afAFe0263b40EdaEf0Df8781eA9aa03E381a3", "0x5E325eDA8064b456f4781070C0738d849c824258"],
  10: ["0x851116D9223fabED8E56C0E6b8Ad0c31d98B3507", "0xCb1355ff08Ab38bBCE60111F1bb2B784bE25D7e8"],
};
const BLOCKS: Record<number, number> = { 1: 300, 8453: 900, 42161: 6000, 10: 1800 }; // about the last hour or so
// Universal Router execute(bytes,bytes[],uint256) and execute(bytes,bytes[]): a swap on any of its deployments
const EXECUTE = ["0x3593564c", "0x24856bc3"];
const PER_CHAIN = Number(process.env.PER_CHAIN || 15);

const client = (id: number) => {
  const u = process.env[`RPC_URL_${id}`];
  if (!u) throw new Error(`RPC_URL_${id} needed`);
  return createPublicClient({ chain: id === 1 ? mainnet : undefined, transport: http(u, { batch: { batchSize: 50 } }) }) as PublicClient;
};

type W = { address: string; label: string; source: string };
const out = new Map<string, W>();

// people
const eth = client(1);
for (const n of NAMES) {
  const a = await eth.getEnsAddress({ name: normalize(n) }).catch(() => null);
  if (a) out.set(a.toLowerCase(), { address: getAddress(a), label: n, source: "ens" });
  else console.log("no address:", n);
}
console.log(out.size, "people");

// traders
for (const [id, routers] of Object.entries(ROUTERS).map(([k, v]) => [Number(k), v.map(x => x.toLowerCase())] as const)) {
  const c = client(id);
  const head = await c.getBlockNumber();
  const n = BigInt(BLOCKS[id]);
  const count = new Map<string, number>();
  for (let b = head - n; b <= head; b += 20n) {
    const blocks = await Promise.all(Array.from({ length: 20 }, (_, i) => c.getBlock({ blockNumber: b + BigInt(i), includeTransactions: true }).catch(() => null)));
    for (const bl of blocks) for (const t of (bl?.transactions ?? []) as any[]) if (t.to && (routers.includes(t.to.toLowerCase()) || EXECUTE.some(x => t.input?.startsWith(x)))) count.set(t.from.toLowerCase(), (count.get(t.from.toLowerCase()) ?? 0) + 1);
  }
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]).map(([a]) => a);
  let took = 0;
  for (const a of ranked) {
    if (took >= PER_CHAIN) break;
    if (out.has(a)) continue;
    const [code, nonce] = await Promise.all([c.getCode({ address: a as `0x${string}` }), c.getTransactionCount({ address: a as `0x${string}` })]);
    if ((code && code !== "0x") || nonce < 50 || nonce > 20_000) continue; // a contract, a new account, or a bot
    out.set(a, { address: getAddress(a), label: `trader on ${id} (${nonce} txs)`, source: `router:${id}` });
    took++;
  }
  console.log(id, ranked.length, "swappers seen,", took, "taken");
}

const list = [...out.values()];
writeFileSync(new URL("./wallets.json", import.meta.url), JSON.stringify({ made: new Date().toISOString().slice(0, 10), wallets: list }, null, 1) + "\n");
console.log(list.length, "wallets → test/wallets.json");
