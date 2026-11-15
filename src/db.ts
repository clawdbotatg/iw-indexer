import { DatabaseSync } from "node:sqlite";

/**
 * One SQLite file. What it keeps:
 *   wallets    each (chain, wallet) being scanned, and how far: down from `top` to `low` (back in time), and up to `head`
 *   seen       every token that ever moved in or out of a wallet (what /portfolio checks besides the well-known list)
 *   transfers  those moves (for /transfers)
 *   tokens     a token's name, symbol and decimals, read once from the chain
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
    addToken: db.prepare("INSERT OR REPLACE INTO tokens (chain, token, symbol, name, decimals) VALUES (?, ?, ?, ?, ?)"),
  };
  return { db, q };
}
