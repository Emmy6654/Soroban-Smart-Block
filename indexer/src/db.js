import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export const db = {
  async init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS events (
        seq              BIGSERIAL PRIMARY KEY,
        contract_id      TEXT NOT NULL,
        function         TEXT NOT NULL,
        ledger           BIGINT NOT NULL,
        tx_hash          TEXT,
        description      TEXT NOT NULL,
        raw_topics       JSONB,
        raw_data         TEXT,
        -- Issue #40: Soroban resource gas costs
        cpu_instructions BIGINT,
        mem_bytes        BIGINT,
        fee_charged      BIGINT,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_events_contract ON events(contract_id);
      CREATE INDEX IF NOT EXISTS idx_events_function ON events(function);
      CREATE INDEX IF NOT EXISTS idx_events_ledger   ON events(ledger);

      CREATE TABLE IF NOT EXISTS contracts (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        functions   JSONB,
        registered_by TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );

      -- Issue #37: ledger hash registry for re-org detection
      CREATE TABLE IF NOT EXISTS ledger_hashes (
        ledger     BIGINT PRIMARY KEY,
        hash       TEXT   NOT NULL,
        indexed_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Vault indexer: yield vault / tokenized treasury registry
      CREATE TABLE IF NOT EXISTS vaults (
        contract_id      TEXT PRIMARY KEY,
        name             TEXT,
        underlying_asset TEXT,
        decimals         INT DEFAULT 7,
        active           BOOLEAN DEFAULT TRUE,
        created_at       TIMESTAMPTZ DEFAULT NOW(),
        updated_at       TIMESTAMPTZ DEFAULT NOW()
      );

      -- Vault snapshots: periodic state captures for ratio computation
      CREATE TABLE IF NOT EXISTS vault_snapshots (
        id            BIGSERIAL PRIMARY KEY,
        contract_id   TEXT NOT NULL REFERENCES vaults(contract_id) ON DELETE CASCADE,
        ledger        BIGINT NOT NULL,
        total_assets  TEXT NOT NULL,
        total_supply  TEXT NOT NULL,
        ratio         NUMERIC(40,20),
        timestamp     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_vault_snapshots_contract ON vault_snapshots(contract_id);
      CREATE INDEX IF NOT EXISTS idx_vault_snapshots_ledger   ON vault_snapshots(ledger);
    `);
  },

  async getMaxLedger() {
    const { rows } = await pool.query("SELECT COALESCE(MAX(ledger), 0) AS max_ledger FROM events");
    return Number(rows[0].max_ledger);
  },

  async upsertEvent(ev) {
    await pool.query(
      `INSERT INTO events
         (contract_id, function, ledger, tx_hash, description, raw_topics, raw_data,
          cpu_instructions, mem_bytes, fee_charged)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [
        ev.contract_id, ev.function, ev.ledger, ev.tx_hash,
        ev.description, JSON.stringify(ev.raw_topics), ev.raw_data,
        ev.cpu_instructions ?? null, ev.mem_bytes ?? null, ev.fee_charged ?? null,
      ]
    );
  },

  async getEvents({ contract, fn, page = 1, limit = 25, type } = {}) {
    const conditions = [];
    const params = [];
    if (contract) { params.push(contract); conditions.push(`contract_id = $${params.length}`); }
    if (fn)       { params.push(fn);       conditions.push(`function = $${params.length}`); }
    // Issue #48: filter by transaction type
    // "soroban"  → contract_id is non-empty (Soroban invocations/deployments)
    // "classic"  → contract_id is empty string or NULL
    if (type === "soroban") { conditions.push(`contract_id IS NOT NULL AND contract_id <> ''`); }
    if (type === "classic") { conditions.push(`(contract_id IS NULL OR contract_id = '')`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM events ${where} ORDER BY ledger DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  },

  async getEvent(seq) {
    const { rows } = await pool.query("SELECT * FROM events WHERE seq = $1", [seq]);
    return rows[0] ?? null;
  },

  async getWalletEvents(address) {
    // Match address appearing anywhere in description or raw_topics
    const { rows } = await pool.query(
      `SELECT * FROM events WHERE description ILIKE $1 OR raw_topics::text ILIKE $1 ORDER BY ledger DESC LIMIT 100`,
      [`%${address}%`]
    );
    return rows;
  },

  async getContractMeta(id) {
    const { rows } = await pool.query("SELECT * FROM contracts WHERE id = $1", [id]);
    return rows[0] ?? null;
  },

  /**
   * Issue #38 — paginated contract transaction history with optional filters.
   * @param {string} contractId
   * @param {{ function_name?: string, start_ledger?: number, end_ledger?: number, page?: number, limit?: number }} opts
   */
  async getContractTransactions(contractId, { function_name, start_ledger, end_ledger, page = 1, limit = 25 } = {}) {
    const params = [contractId];
    const conditions = ["contract_id = $1"];

    if (function_name) { params.push(function_name);  conditions.push(`function = $${params.length}`); }
    if (start_ledger)  { params.push(start_ledger);   conditions.push(`ledger >= $${params.length}`); }
    if (end_ledger)    { params.push(end_ledger);      conditions.push(`ledger <= $${params.length}`); }

    const where  = conditions.join(" AND ");
    const offset = (page - 1) * limit;

    const [{ rows }, { rows: countRows }] = await Promise.all([
      pool.query(
        `SELECT * FROM events WHERE ${where} ORDER BY ledger DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
      pool.query(`SELECT COUNT(*)::INT AS total FROM events WHERE ${where}`, params),
    ]);

    const total = countRows[0].total;
    return {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
        has_next: page * limit < total,
      },
    };
  },

  /**
   * Aggregate transfer volume for a contract over the last 24 hours.
   * Amounts are stored as raw strings in raw_data; we cast via NUMERIC to
   * avoid floating-point errors and return a BigInt-safe string.
   * @param {string} contractId
   * @param {number} decimals  token decimal places (default 7)
   * @returns {Promise<{ volume_raw: string, volume_scaled: string, decimals: number }>}
   */
  async get24hVolume(contractId, decimals = 7) {
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM((raw_data::jsonb->>'amount')::NUMERIC), 0)::TEXT AS volume_raw
       FROM events
       WHERE contract_id = $1
         AND function    = 'transfer'
         AND created_at >= NOW() - INTERVAL '24 hours'`,
      [contractId]
    );
    const raw = rows[0].volume_raw ?? "0";
    // Scale using integer arithmetic via BigInt to avoid float rounding
    const rawBig   = BigInt(raw.split(".")[0]); // NUMERIC may have no decimals
    const divisor  = 10n ** BigInt(decimals);
    const whole    = rawBig / divisor;
    const fraction = rawBig % divisor;
    const volume_scaled = `${whole}.${fraction.toString().padStart(decimals, "0")}`;
    return { volume_raw: raw, volume_scaled, decimals };
  },

  async upsertContractMeta(meta) {
    await pool.query(
      `INSERT INTO contracts (id, name, description, functions, registered_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET name=$2, description=$3, functions=$4`,
      [meta.id, meta.name, meta.description, JSON.stringify(meta.functions), meta.registered_by]
    );
  },

  // ── Vault indexer methods ──────────────────────────────────────────────────────

  async registerVault(vault) {
    await pool.query(
      `INSERT INTO vaults (contract_id, name, underlying_asset, decimals)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (contract_id) DO UPDATE
         SET name=$2, underlying_asset=$3, decimals=$4, updated_at=NOW()`,
      [vault.contract_id, vault.name ?? null, vault.underlying_asset ?? null, vault.decimals ?? 7]
    );
  },

  async unregisterVault(contractId) {
    await pool.query("DELETE FROM vaults WHERE contract_id = $1", [contractId]);
  },

  async getVaults() {
    const { rows } = await pool.query(
      `SELECT v.*,
        (SELECT ratio FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ratio,
        (SELECT ledger FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ledger
       FROM vaults v WHERE v.active = TRUE ORDER BY v.created_at DESC`
    );
    return rows;
  },

  async getVault(contractId) {
    const { rows } = await pool.query(
      `SELECT v.*,
        (SELECT ratio FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ratio,
        (SELECT ledger FROM vault_snapshots WHERE contract_id = v.contract_id ORDER BY ledger DESC LIMIT 1) AS latest_ledger
       FROM vaults v WHERE v.contract_id = $1`,
      [contractId]
    );
    return rows[0] ?? null;
  },

  async getActiveVaultIds() {
    const { rows } = await pool.query("SELECT contract_id FROM vaults WHERE active = TRUE");
    return rows.map(r => r.contract_id);
  },

  async upsertVaultSnapshot(snapshot) {
    await pool.query(
      `INSERT INTO vault_snapshots (contract_id, ledger, total_assets, total_supply, ratio)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        snapshot.contract_id,
        snapshot.ledger,
        snapshot.total_assets,
        snapshot.total_supply,
        snapshot.ratio,
      ]
    );
  },

  async getVaultHistory(contractId, { limit = 100 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM vault_snapshots
       WHERE contract_id = $1
       ORDER BY ledger DESC LIMIT $2`,
      [contractId, limit]
    );
    return rows;
  },
};
