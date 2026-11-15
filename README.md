# iw-indexer

A wallet's coins, prices and transfers, read from your own Ethereum node. No Alchemy, no API keys.

Built for Instant Wallet (it replaces Alchemy's token balances and prices there), but it's a plain HTTP service any
wallet can use. Open source; run your own. We run one too.

## Run it

Node 22.18 or newer.

    npm install
    RPC_URL_1=http://127.0.0.1:8545 RPC_URL_8453=http://127.0.0.1:8546 npm start

One `RPC_URL_<chainId>` per network you want: your node for that network. It listens on http://127.0.0.1:4100.

| env | |
|---|---|
| `RPC_URL_<chainId>` | your node, per network (1 Ethereum, 8453 Base, 10 Optimism, 42161 Arbitrum, 137 Polygon, ...: `data/chains.json`) |
| `INDEXER_PORT`, `HOST` | where it listens (4100, 127.0.0.1) |
| `DB` | the SQLite file (`indexer.db`) |
| `FROM_BLOCK_<chainId>` | how far back the scan goes (0) |
| `MAX_WALLETS` | wallets it will watch (100) |
| `MIN_DEPTH_USD` | the least a pool must hold for its price to count (10000) |
| `VERBOSE` | log the scan |

Instant Wallet: set `INDEXER_URL=http://127.0.0.1:4100` (its `run-local.sh` does it).

## What it answers

- `GET /portfolio?address=0x…`: `{ totalUsd, assets: [{ chainId, asset, symbol, name, decimals, balance, formatted,
  price, usd }], late? }`, on every network. Asking starts watching that wallet.
- `GET /transfers?address=0x…&chain=8453[&in=1][&limit=50]`: its ERC-20 moves, newest first.
- `GET /status`: each wallet, and how far back its scan has got.

## How

- **Which coins:** the well-known tokens of each network first (`data/chains.json`, so the first answer is instant),
  plus every token that ever moved in or out of the wallet. Those come from your node's logs (`eth_getLogs` for
  `Transfer` to or from the wallet), read back in time from when the wallet was first asked about, then each new block.
- **Balances:** always read live (`balanceOf`, through Multicall3). The logs only say which coins to ask about.
- **Names, symbols, decimals:** asked from each token once, kept in the database.
- **Prices:** from the chain. The coin's Uniswap v3 pool against USDC, or against the network's wrapped coin. Of
  the pools that exist, the one holding the most USDC-or-coin wins, if it holds at least $10,000. The price is the
  pool's 30-minute average, so one block can't fake it. No pool like that: no price (the wallet treats such coins
  as spam). USDC counts as $1.

## Next (once the test suite runs clean)

1. **Activity**: the rows Instant Wallet's Activity shows, from the stored transfers and the Safe's own events,
   including money in before a Safe is deployed (today that's Alchemy's `getAssetTransfers`).
2. **NFTs**: ERC-721 and ERC-1155 transfers (the 4-topic `Transfer`, `TransferSingle`, `TransferBatch`), owners
   checked live, images from the token's own `tokenURI`.
3. **Prices on networks without Uniswap v3 here** (Gnosis, Sonic, HyperEVM, Plasma, Robinhood): their own DEXes
   (Balancer, Curve, Shadow, Hyperswap...) or Chainlink feeds. USDC only, for now.
4. Uniswap v4 pools and Chainlink feeds next to v3, for coins whose deepest pool is there.
5. The network's own coin moving in from a contract (needs traces); `SafeReceived` covers Safes.

Positions (Aave, Morpho...) are a separate repo: `iw-positions`.

## The test suite

`test/wallets.json`: 92 wallets every change is checked against: 32 well-known people (by ENS name) and 15 active
traders on each of Ethereum, Base, Arbitrum and Optimism (`node test/find-wallets.ts` makes the list again).
`node test/suite.ts` asks this indexer and a reference (Instant Wallet's `/api/portfolio`, which reads Alchemy)
about each one and says, per wallet, which coins differ.

## Your node

`eth_getLogs` over wide block ranges: reth, erigon and geth all do it. The scan shrinks its range when the node says
no, and grows it while it says yes. A wallet's history is small, so the scan back takes minutes.

One wallet against a reference: `node test/compare.ts 0xADDRESS`.

MIT.
