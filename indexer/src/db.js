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

      -- Allowance engine: tracks active third-party token allowance liabilities
      CREATE TABLE IF NOT EXISTS token_allowances (
        id                BIGSERIAL PRIMARY KEY,
        owner             TEXT NOT NULL,
        spender           TEXT NOT NULL,
        token             TEXT NOT NULL,
        amount            TEXT NOT NULL,
        expiration_ledger BIGINT,
        ledger            BIGINT NOT NULL,
        tx_hash           TEXT,
        created_at        TIMESTAMPTZ DEFAULT NOW(),
        updated_at        TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(owner, spender, token)
      );
      CREATE INDEX IF NOT EXISTS idx_allowances_owner   ON token_allowances(owner);
      CREATE INDEX IF NOT EXISTS idx_allowances_spender ON token_allowances(spender);
      CREATE INDEX IF NOT EXISTS idx_allowances_token   ON token_allowances(token);

      -- Allowance history: time-series of changes for plotting
      CREATE TABLE IF NOT EXISTS allowance_history (
        id                BIGSERIAL PRIMARY KEY,
        owner             TEXT NOT NULL,
        spender           TEXT NOT NULL,
        token             TEXT NOT NULL,
        amount            TEXT NOT NULL,
        expiration_ledger BIGINT,
        ledger            BIGINT NOT NULL,
        tx_hash           TEXT,
        recorded_at       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_allowance_history_owner  ON allowance_history(owner);
      CREATE INDEX IF NOT EXISTS idx_allowance_history_token  ON allowance_history(token);
      CREATE INDEX IF NOT EXISTS idx_allowance_history_ledger ON allowance_history(ledger);

      -- TVL indexer: token liquidity pool registry
      CREATE TABLE IF NOT EXISTS liquidity_pools (
        id            TEXT PRIMARY KEY,
        name          TEXT,
        protocol      TEXT NOT NULL DEFAULT 'unknown',
        pool_type     TEXT,
        token_a       TEXT,
        token_b       TEXT,
        active        BOOLEAN DEFAULT TRUE,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_pools_protocol ON liquidity_pools(protocol);

      -- Pool token reserves (current balance snapshots)
      CREATE TABLE IF NOT EXISTS pool_reserves (
        id          BIGSERIAL PRIMARY KEY,
        pool_id     TEXT NOT NULL REFERENCES liquidity_pools(id) ON DELETE CASCADE,
        token       TEXT NOT NULL,
        reserve     TEXT NOT NULL,
        ledger      BIGINT NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(pool_id, token)
      );
      CREATE INDEX IF NOT EXISTS idx_pool_reserves_pool ON pool_reserves(pool_id);

      -- Aggregated TVL snapshots per protocol
      CREATE TABLE IF NOT EXISTS tvl_snapshots (
        id              BIGSERIAL PRIMARY KEY,
        protocol        TEXT NOT NULL,
        tvl_raw         TEXT NOT NULL,
        token_breakdown JSONB,
        pool_count      INT DEFAULT 0,
        ledger          BIGINT NOT NULL,
        timestamp       TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tvl_snapshots_protocol ON tvl_snapshots(protocol);
      CREATE INDEX IF NOT EXISTS idx_tvl_snapshots_ledger   ON tvl_snapshots(ledger);
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

  // ── Allowance engine methods ────────────────────────────────────────────────────

  async upsertAllowance(allowance) {
    await pool.query(
      `INSERT INTO token_allowances (owner, spender, token, amount, expiration_ledger, ledger, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (owner, spender, token) DO UPDATE
         SET amount=$4, expiration_ledger=$5, ledger=$6, tx_hash=$7, updated_at=NOW()`,
      [
        allowance.owner,
        allowance.spender,
        allowance.token,
        allowance.amount,
        allowance.expiration_ledger ?? null,
        allowance.ledger,
        allowance.tx_hash ?? null,
      ]
    );
  },

  async recordAllowanceHistory(allowance) {
    await pool.query(
      `INSERT INTO allowance_history (owner, spender, token, amount, expiration_ledger, ledger, tx_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        allowance.owner,
        allowance.spender,
        allowance.token,
        allowance.amount,
        allowance.expiration_ledger ?? null,
        allowance.ledger,
        allowance.tx_hash ?? null,
      ]
    );
  },

  async removeAllowance(owner, spender, token) {
    await pool.query(
      `DELETE FROM token_allowances WHERE owner = $1 AND spender = $2 AND token = $3`,
      [owner, spender, token]
    );
  },

  async getActiveAllowances(owner) {
    const { rows } = await pool.query(
      `SELECT * FROM token_allowances
       WHERE owner = $1
         AND (expiration_ledger IS NULL OR expiration_ledger > (SELECT COALESCE(MAX(ledger), 0) FROM events))
       ORDER BY token, spender`,
      [owner]
    );
    return rows;
  },

  async getAllowanceLiabilities(owner) {
    const { rows } = await pool.query(
      `SELECT token,
              COUNT(*) AS spender_count,
              SUM(amount::NUMERIC)::TEXT AS total_liability_raw,
              array_agg(spender) AS spenders
       FROM token_allowances
       WHERE owner = $1
         AND (expiration_ledger IS NULL OR expiration_ledger > (SELECT COALESCE(MAX(ledger), 0) FROM events))
       GROUP BY token
       ORDER BY token`,
      [owner]
    );
    return rows;
  },

  async getAllowanceHistory(owner, { token, limit = 100, offset = 0 } = {}) {
    const params = [owner];
    const conditions = ["owner = $1"];
    if (token) {
      params.push(token);
      conditions.push(`token = $${params.length}`);
    }
    const where = conditions.join(" AND ");
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM allowance_history
       WHERE ${where}
       ORDER BY ledger DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    return rows;
  },

  async expireOldAllowances(currentLedger) {
    const { rowCount } = await pool.query(
      `DELETE FROM token_allowances
       WHERE expiration_ledger IS NOT NULL AND expiration_ledger <= $1`,
      [currentLedger]
    );
    return rowCount ?? 0;
  },

  // ── TVL indexer methods ─────────────────────────────────────────────────────────

  async registerPool(pool) {
    await pool.query(
      `INSERT INTO liquidity_pools (id, name, protocol, pool_type, token_a, token_b)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE
         SET name=$2, protocol=$3, pool_type=$4, token_a=$5, token_b=$6, updated_at=NOW()`,
      [pool.id, pool.name ?? null, pool.protocol ?? 'unknown', pool.pool_type ?? null, pool.token_a ?? null, pool.token_b ?? null]
    );
  },

  async unregisterPool(poolId) {
    await pool.query("DELETE FROM liquidity_pools WHERE id = $1", [poolId]);
  },

  async getPools() {
    const { rows } = await pool.query(
      `SELECT lp.*,
        (SELECT ledger FROM pool_reserves WHERE pool_id = lp.id ORDER BY recorded_at DESC LIMIT 1) AS latest_ledger
       FROM liquidity_pools lp WHERE lp.active = TRUE ORDER BY lp.created_at DESC`
    );
    return rows;
  },

  async getPool(poolId) {
    const { rows } = await pool.query(
      `SELECT * FROM liquidity_pools WHERE id = $1`,
      [poolId]
    );
    return rows[0] ?? null;
  },

  async getActivePoolIds() {
    const { rows } = await pool.query("SELECT id FROM liquidity_pools WHERE active = TRUE");
    return rows.map(r => r.id);
  },

  async getPoolsByProtocol(protocol) {
    const { rows } = await pool.query(
      `SELECT * FROM liquidity_pools WHERE protocol = $1 AND active = TRUE`,
      [protocol]
    );
    return rows;
  },

  async getDistinctProtocols() {
    const { rows } = await pool.query(
      `SELECT DISTINCT protocol FROM liquidity_pools WHERE active = TRUE`
    );
    return rows.map(r => r.protocol);
  },

  async upsertPoolReserve(reserve) {
    await pool.query(
      `INSERT INTO pool_reserves (pool_id, token, reserve, ledger)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (pool_id, token) DO UPDATE
         SET reserve=$3, ledger=$4, recorded_at=NOW()`,
      [reserve.pool_id, reserve.token, reserve.reserve, reserve.ledger]
    );
  },

  async getPoolReserves(poolId) {
    const { rows } = await pool.query(
      `SELECT * FROM pool_reserves WHERE pool_id = $1 ORDER BY token`,
      [poolId]
    );
    return rows;
  },

  async upsertTVLSnapshot(snapshot) {
    await pool.query(
      `INSERT INTO tvl_snapshots (protocol, tvl_raw, token_breakdown, pool_count, ledger)
       VALUES ($1,$2,$3,$4,$5)`,
      [snapshot.protocol, snapshot.tvl_raw, snapshot.token_breakdown ?? null, snapshot.pool_count ?? 0, snapshot.ledger]
    );
  },

  async getLatestTVL() {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (protocol) protocol, tvl_raw, token_breakdown, pool_count, ledger, timestamp
       FROM tvl_snapshots
       ORDER BY protocol, ledger DESC`
    );
    return rows;
  },

  async getTVLByProtocol(protocol) {
    const { rows } = await pool.query(
      `SELECT * FROM tvl_snapshots
       WHERE protocol = $1
       ORDER BY ledger DESC LIMIT 1`,
      [protocol]
    );
    return rows[0] ?? null;
  },

  async getTVLHistory(protocol, { limit = 100 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM tvl_snapshots
       WHERE protocol = $1
       ORDER BY ledger DESC LIMIT $2`,
      [protocol, limit]
    );
    return rows;
  },
};
