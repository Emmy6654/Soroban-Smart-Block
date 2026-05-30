/**
 * Ledger Re-org Detection & Rollback Worker  (Issue #37)
 *
 * Maintains a rolling window of indexed ledger hashes and compares them
 * against the network's consensus state.  When a mismatch is detected the
 * orphaned rows are purged and the cursor is rewound to the fork height so
 * the main indexer loop can re-index from there.
 */

import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ── DB helpers ────────────────────────────────────────────────────────────────

async function ensureLedgerHashTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ledger_hashes (
      ledger     BIGINT PRIMARY KEY,
      hash       TEXT   NOT NULL,
      indexed_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
}

/** Persist the hash we observed for a ledger when we first indexed it. */
export async function recordLedgerHash(ledger, hash) {
  await pool.query(
    `INSERT INTO ledger_hashes (ledger, hash)
     VALUES ($1, $2)
     ON CONFLICT (ledger) DO NOTHING`,
    [ledger, hash]
  );
}

/** Return the last N ledger rows we have on record, newest first. */
async function getRecentLedgerHashes(limit = 20) {
  const { rows } = await pool.query(
    `SELECT ledger, hash FROM ledger_hashes ORDER BY ledger DESC LIMIT $1`,
    [limit]
  );
  return rows; // [{ ledger, hash }, …]
}

/** Delete all events and ledger_hash records at or above forkLedger. */
async function rollback(forkLedger) {
  await pool.query(`DELETE FROM events        WHERE ledger     >= $1`, [forkLedger]);
  await pool.query(`DELETE FROM ledger_hashes WHERE ledger     >= $1`, [forkLedger]);
  console.warn(`[reorg] Rolled back ledger ${forkLedger}+`);
}

// ── Core check ────────────────────────────────────────────────────────────────

/**
 * Compare our stored hashes against the network.
 *
 * @param {import("@stellar/stellar-sdk").SorobanRpc.Server} rpc
 * @returns {Promise<number|null>} fork ledger height, or null if no reorg
 */
export async function checkForReorg(rpc) {
  const stored = await getRecentLedgerHashes(20);
  if (stored.length === 0) return null;

  for (const { ledger, hash } of stored) {
    let networkHash;
    try {
      // getLedger is available on Soroban RPC; fall back gracefully if not.
      const info = await rpc.getLedger(ledger).catch(() => null);
      networkHash = info?.hash ?? null;
    } catch {
      continue; // RPC hiccup — skip this ledger
    }

    if (networkHash && networkHash !== hash) {
      console.warn(
        `[reorg] Mismatch at ledger ${ledger}: stored=${hash} network=${networkHash}`
      );
      return ledger;
    }
  }

  return null; // all hashes match
}

// ── Worker entry-point ────────────────────────────────────────────────────────

/**
 * Start the periodic re-org check.
 *
 * @param {import("@stellar/stellar-sdk").SorobanRpc.Server} rpc
 * @param {{ getCursor: () => number, setCursor: (n: number) => void }} cursorRef
 *   Callbacks to read/write the main indexer's current ledger cursor so we
 *   can rewind it to the fork height after a rollback.
 * @param {number} intervalMs  How often to run the check (default 30 s).
 * @returns {() => void}  Stop function.
 */
export function startReorgWorker(rpc, cursorRef, intervalMs = 30_000) {
  let running = true;

  (async () => {
    await ensureLedgerHashTable();
    console.log("[reorg] Worker started");

    while (running) {
      await new Promise(r => setTimeout(r, intervalMs));
      if (!running) break;

      try {
        const forkLedger = await checkForReorg(rpc);
        if (forkLedger !== null) {
          await rollback(forkLedger);
          cursorRef.setCursor(forkLedger); // rewind main loop
          console.log(`[reorg] Cursor rewound to ${forkLedger}`);
        }
      } catch (err) {
        console.error("[reorg] Check failed:", err.message);
      }
    }
  })();

  return () => { running = false; };
}
