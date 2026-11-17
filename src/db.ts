import { DatabaseSync } from "node:sqlite";

/**
 * One SQLite file. What it keeps:
 *   wallets    each (chain, wallet) being scanned, and how far: down from `top` to `low` (back in time), and up to `head`
 *   seen       every token that ever moved in or out of a wallet (what /portfolio checks besides the well-known list)
 *   transfers  those moves (for /transfers)
 *   tokens     a token's name, symbol and decimals, read once from the chain
 *   nodes      the node per network set from Instant Wallet's Settings (POST /node): wins over RPC_URL_<chainId>
 *   v4pools    every Uniswap v4 pool (its Initialize event), on a network read from your own node; v4sync: up to which block
 *   unpriced   coins with no price when last looked up, and when (spam, mostly: looked up again after a day)
 */
export type Db = ReturnType<typeof open>;

export function open(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS wallets (chain INTEGER, wallet TEXT, top INTEGER, low INTEGER, head INTEGER, added INTEGER, PRIMARY KEY (chain, wallet));
    CREATE TABLE IF NOT EXISTS seen (chain INTEGER, wallet TEXT, token TEXT, PRIMARY KEY (chain, wallet, token));
    CREATE TABLE IF NOT EXISTS transfers (chain INTEGER, block INTEGER, tx TEXT, idx INTEGER, token TEXT, src TEXT, dst TEXT, value TEXT, PRIMARY KEY (chain, tx, idx));
    CREATE INDEX IF NOT EXISTS transfers_dst ON transfers (chain, dst, block);
    CREATE INDEX IF NOT EXISTS transfers_src ON transfers (chain, src, block);
    CREATE TABLE IF NOT EXISTS tokens (chain INTEGER, token TEXT, symbol TEXT, name TEXT, decimals INTEGER, PRIMARY KEY (chain, token));
    CREATE TABLE IF NOT EXISTS unpriced (chain INTEGER, token TEXT, at INTEGER, PRIMARY KEY (chain, token));
    CREATE TABLE IF NOT EXISTS nodes (chain INTEGER PRIMARY KEY, url TEXT);
    CREATE TABLE IF NOT EXISTS v4pools (chain INTEGER, id TEXT, c0 TEXT, c1 TEXT, fee INTEGER, spacing INTEGER, hooks TEXT, PRIMARY KEY (chain, id));
    CREATE INDEX IF NOT EXISTS v4pools_c0 ON v4pools (chain, c0);
    CREATE INDEX IF NOT EXISTS v4pools_c1 ON v4pools (chain, c1);
    CREATE TABLE IF NOT EXISTS v4sync (chain INTEGER PRIMARY KEY, upto INTEGER);
    CREATE TABLE IF NOT EXISTS blocks (chain INTEGER, block INTEGER, ts INTEGER, PRIMARY KEY (chain, block));
  `);
  db.exec("DELETE FROM tokens WHERE decimals IS NULL"); // 0.1 kept a failed read as "not a token" for good
  const q = {
    wallet: db.prepare("SELECT * FROM wallets WHERE chain = ? AND wallet = ?"),
    wallets: db.prepare("SELECT * FROM wallets"),
    addWallet: db.prepare("INSERT OR IGNORE INTO wallets (chain, wallet, top, low, head, added) VALUES (?, ?, ?, ?, ?, ?)"),
    setLow: db.prepare("UPDATE wallets SET low = ? WHERE chain = ? AND wallet = ?"),
    setHead: db.prepare("UPDATE wallets SET head = ? WHERE chain = ? AND wallet = ?"),
    see: db.prepare("INSERT OR IGNORE INTO seen (chain, wallet, token) VALUES (?, ?, ?)"),
    seen: db.prepare("SELECT token FROM seen WHERE chain = ? AND wallet = ?"),
    move: db.prepare("INSERT OR IGNORE INTO transfers (chain, block, tx, idx, token, src, dst, value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    movesIn: db.prepare("SELECT * FROM transfers WHERE chain = ? AND dst = ? ORDER BY block DESC, idx DESC LIMIT ?"),
    movesAll: db.prepare("SELECT * FROM transfers WHERE chain = ? AND (dst = ? OR src = ?) ORDER BY block DESC, idx DESC LIMIT ?"),
    token: db.prepare("SELECT * FROM tokens WHERE chain = ? AND token = ?"),
    unpriced: db.prepare("SELECT at FROM unpriced WHERE chain = ? AND token = ?"),
    setUnpriced: db.prepare("INSERT OR REPLACE INTO unpriced (chain, token, at) VALUES (?, ?, ?)"),
    nodes: db.prepare("SELECT * FROM nodes"),
    setNode: db.prepare("INSERT OR REPLACE INTO nodes (chain, url) VALUES (?, ?)"),
    dropNode: db.prepare("DELETE FROM nodes WHERE chain = ?"),
    v4upto: db.prepare("SELECT upto FROM v4sync WHERE chain = ?"),
    setV4upto: db.prepare("INSERT OR REPLACE INTO v4sync (chain, upto) VALUES (?, ?)"),
    addV4: db.prepare("INSERT OR IGNORE INTO v4pools (chain, id, c0, c1, fee, spacing, hooks) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    v4of: db.prepare("SELECT * FROM v4pools WHERE chain = ? AND (c0 = ? OR c1 = ?)"),
    blockTs: db.prepare("SELECT ts FROM blocks WHERE chain = ? AND block = ?"),
    setBlockTs: db.prepare("INSERT OR REPLACE INTO blocks (chain, block, ts) VALUES (?, ?, ?)"),
    addToken: db.prepare("INSERT OR REPLACE INTO tokens (chain, token, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)"),
  };
  return { db, q };
}
