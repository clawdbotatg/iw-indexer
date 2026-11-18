import { decodeFunctionResult, encodeFunctionData } from "viem";
import { type ChainCfg, batchRpc, multicall } from "./chains.ts";
import type { Db } from "./db.ts";

/**
 * A wallet's NFTs, from its NFT moves (src/scan.ts) and the chain:
 *   held      every NFT that ever came in, still its own now: ownerOf (ERC-721), balanceOf (ERC-1155), read live
 *   airdrop   one that came in by a transaction someone else sent to 5 or more wallets at once: spam, not shown
 *             (who sent it and to how many: the transaction's receipt, read once)
 *   metadata  tokenURI / uri, then its JSON (ipfs://, ar://, data:, https://): name and image, read once and kept
 *             (a failed read is asked again after a day). No image: not shown (as Instant Wallet does with Alchemy's).
 * Images on IPFS or Arweave are given as a public gateway's address (IPFS_GATEWAY: your own).
 */
export type Nft = { chainId: number; contract: string; tokenId: string; type: string; balance: string; name: string; collection: string; thumb: string; image: string };

// an IPFS gateway that still answers servers (ipfs.io and dweb.link stopped, 11-2026): IPFS_GATEWAY to use your own
const IPFS = (process.env.IPFS_GATEWAY || "https://ipfs.filebase.io/ipfs/").replace(/\/?$/, "/");
const IPFS_BACKUP = "https://gateway.pinata.cloud/ipfs/";
// a link through any IPFS gateway goes through ours (many stopped answering, others are slow or limit servers)
const DEAD = /^https?:\/\/[^/]+\/ipfs\/(?=Qm[1-9A-HJ-NP-Za-km-z]{44}|bafy)/;
// ENS names (the .eth registrar) have no tokenURI: their name and picture come from ENS's own metadata service
const ENS = "0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85";
const DAY = 86_400_000;
const AIRDROP = 5;

const erc721 = [
  { type: "function", name: "ownerOf", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  { type: "function", name: "tokenURI", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;
const erc1155 = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "uri", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "string" }] },
] as const;

/** A link anyone's browser can open: ipfs:// and ar:// through a public gateway. */
export function web(u: string): string {
  const s = u.trim();
  if (s.startsWith("ipfs://")) return IPFS + s.slice(7).replace(/^ipfs\//, "");
  if (DEAD.test(s)) return s.replace(DEAD, IPFS);
  if (s.startsWith("ar://")) return "https://arweave.net/" + s.slice(5);
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}/.test(s) || /^bafy[a-z2-7]{50,}/.test(s)) return IPFS + s;
  return s;
}

async function json(u: string): Promise<any> {
  if (u.startsWith("data:")) {
    const [head, body] = [u.slice(0, u.indexOf(",")), u.slice(u.indexOf(",") + 1)];
    return JSON.parse(head.includes(";base64") ? Buffer.from(body, "base64").toString("utf8") : decodeURIComponent(body));
  }
  if (!/^https?:\/\//.test(u)) throw new Error("not a link");
  const get = (link: string) => fetch(link, { signal: AbortSignal.timeout(8000), redirect: "follow" }).then(r => (r.ok ? r : Promise.reject(new Error(`HTTP ${r.status}`))));
  const link = web(u);
  // on IPFS: the backup gateway when ours doesn't have it
  const r = await get(link).catch(e => (link.startsWith(IPFS) ? get(IPFS_BACKUP + link.slice(IPFS.length)) : Promise.reject(e)));
  const t = await r.text();
  if (t.length > 2_000_000) throw new Error("too big");
  return JSON.parse(t);
}

export function nfts(c: ChainCfg, d: Db) {
  /** Who sent each of these transactions, and to how many wallets its NFT moves went (kept). */
  async function txs(hashes: string[]) {
    const ask = hashes.filter(h => !d.q.nftTx.get(c.id, h));
    for (let i = 0; i < ask.length; i += 50) {
      const part = ask.slice(i, i + 50);
      const r = await batchRpc(c, part.map(h => ({ method: "eth_getTransactionReceipt", params: [h] })));
      part.forEach((h, j) => {
        const x = r[j];
        if (!x) return;
        const to = new Set<string>();
        for (const l of x.logs as any[]) {
          // ERC-721 Transfer (4 topics): to = topics[2]; ERC-1155 TransferSingle/Batch: to = topics[3]
          if (l.topics.length === 4) to.add(String(l.topics[l.topics[0].startsWith("0xddf252ad") ? 2 : 3]).toLowerCase());
        }
        d.q.setNftTx.run(c.id, h, String(x.from).toLowerCase(), to.size);
      });
    }
  }

  /** Name, collection and image of these NFTs: kept, or read now. */
  async function metas(items: { contract: string; id: string; kind: number }[]) {
    const ask = items.filter(x => {
      const m = d.q.nftMeta.get(c.id, x.contract, x.id) as any;
      return !m || (!m.image && Date.now() - m.at > DAY);
    });
    if (!ask.length) return;
    // one call each, not through Multicall3's gas-capped batches: an on-chain image (Loot, Flipmaps) costs millions
    // of gas to build. A call that fails is a failed read, not a hole in the list.
    const calls = ask.flatMap(x => [
      x.kind === 721
        ? { abi: erc721, functionName: "tokenURI" as const, args: [BigInt(x.id)] as const, address: x.contract }
        : { abi: erc1155, functionName: "uri" as const, args: [BigInt(x.id)] as const, address: x.contract },
      { abi: erc721, functionName: "name" as const, args: [] as const, address: x.contract },
    ]);
    const r = await Promise.all(
      calls.map(k =>
        c.client
          .request({ method: "eth_call", params: [{ to: k.address as `0x${string}`, data: encodeFunctionData(k as any) }, "latest"] } as any)
          .then(data => ({ status: "success" as const, result: decodeFunctionResult({ ...(k as any), data }) as unknown }))
          .catch(() => ({ status: "failure" as const, result: undefined as unknown })),
      ),
    );
    // the JSON of each, 8 at a time
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < ask.length) {
          const i = next++;
          const x = ask[i];
          const [u, n] = [r[2 * i], r[2 * i + 1]];
          const collection = n.status === "success" ? String(n.result) : c.id === 1 && x.contract === ENS ? "ENS" : "";
          let name = "", image = "";
          const ens = c.id === 1 && x.contract === ENS ? `https://metadata.ens.domains/mainnet/${ENS}/${x.id}` : "";
          if (ens || (u.status === "success" && u.result)) {
            // ERC-1155: {id} is the id as 64 hex digits
            const link = (ens || String(u.result)).replace("{id}", BigInt(x.id).toString(16).padStart(64, "0"));
            const j = await json(web(link)).catch(() => null);
            if (j) {
              name = String(j.name ?? "").slice(0, 200);
              const img = j.image || j.image_url || j.imageUrl || "";
              if (typeof img === "string" && img) image = web(img);
              else if (typeof j.image_data === "string" && j.image_data.startsWith("<svg")) image = "data:image/svg+xml;base64," + Buffer.from(j.image_data).toString("base64");
            }
          }
          d.q.setNftMeta.run(c.id, x.contract, x.id, name, collection, image.length > 500_000 ? "" : image, Date.now());
        }
      }),
    );
  }

  return async function held(wallet: string): Promise<Nft[]> {
    const w = wallet.toLowerCase();
    const moves = d.q.nftMoves.all(c.id, w, w) as any[];
    // per NFT: the last move that brought it in, and what the moves add up to (1155: how many)
    const by = new Map<string, { contract: string; id: string; kind: number; net: bigint; lastIn: string }>();
    for (const m of moves) {
      const k = `${m.contract}:${m.id}`;
      const x = by.get(k) ?? { contract: m.contract, id: m.id, kind: m.kind, net: 0n, lastIn: "" };
      if (m.dst === w) (x.net += BigInt(m.amount)), (x.lastIn = m.tx);
      if (m.src === w) x.net -= BigInt(m.amount);
      by.set(k, x);
    }
    const cands = [...by.values()].filter(x => x.lastIn);
    if (!cands.length) return [];
    // still held now, from the chain (the moves only say what to ask about)
    const now = await multicall(
      c,
      cands.map(x =>
        x.kind === 721
          ? { address: x.contract as `0x${string}`, abi: erc721, functionName: "ownerOf", args: [BigInt(x.id)] }
          : { address: x.contract as `0x${string}`, abi: erc1155, functionName: "balanceOf", args: [wallet as `0x${string}`, BigInt(x.id)] },
      ),
      "token",
    );
    const mine = cands
      .map((x, i) => {
        const r = now[i];
        if (r.status !== "success") return null;
        const bal = x.kind === 721 ? (String(r.result).toLowerCase() === w ? 1n : 0n) : (r.result as bigint);
        return bal > 0n ? { ...x, bal } : null;
      })
      .filter(x => x !== null);
    // airdrops: brought in by someone else's transaction to many wallets
    await txs([...new Set(mine.map(x => x.lastIn))]);
    const kept = mine.filter(x => {
      const t = d.q.nftTx.get(c.id, x.lastIn) as any;
      return !t || t.sender === w || t.recipients < AIRDROP;
    });
    await metas(kept);
    const out: Nft[] = [];
    for (const x of kept) {
      const m = d.q.nftMeta.get(c.id, x.contract, x.id) as any;
      if (!m?.image) continue;
      const collection = m.collection || "Unknown";
      out.push({
        chainId: c.id,
        contract: x.contract,
        tokenId: x.id,
        type: x.kind === 721 ? "ERC721" : "ERC1155",
        balance: x.bal.toString(),
        name: m.name || `${collection} #${x.id}`,
        collection,
        thumb: m.image,
        image: m.image,
      });
    }
    return out;
  };
}
