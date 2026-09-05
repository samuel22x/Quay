import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "./schema";
import { encryptSecret, last4 } from "../services/secret-crypto";

export type DB = LibSQLDatabase<typeof schema>;

// CREATE TABLE IF NOT EXISTS so a fresh clone runs with no migration step.
// (drizzle-kit push can manage this instead; see drizzle.config.ts.)
const BOOTSTRAP_SQL = [
  // payout_fields_json included here so fresh databases get the full schema
  // (issue #32). Existing databases are handled by the ALTER TABLE statement
  // in ADDITIVE_MIGRATIONS below.
  `CREATE TABLE IF NOT EXISTS sellers (
     id TEXT PRIMARY KEY, name TEXT NOT NULL, wallet TEXT NOT NULL UNIQUE,
     payout_fields_json TEXT, created_at INTEGER NOT NULL
   )`,
  // New columns (offramp_indicative_rate, offramp_rate, offramp_rate_delta) are
  // included here so fresh databases get the full schema. Existing databases are
  // handled by the ALTER TABLE statements in ADDITIVE_MIGRATIONS below.
  `CREATE TABLE IF NOT EXISTS links (
     id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, seller_id TEXT NOT NULL,
     destination TEXT NOT NULL, muxed_id TEXT, title TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, status TEXT NOT NULL,
     tx_hash TEXT, payer TEXT, paid_amount TEXT, overpaid_amount TEXT,
     offramp_job_id TEXT, offramp_target_currency TEXT, offramp_status TEXT,
     offramp_indicative_rate TEXT, offramp_rate TEXT, offramp_rate_delta TEXT,
     offramp_fee_amount TEXT, offramp_fee_currency TEXT, offramp_fee_source TEXT,
     offramp_net_target_amount TEXT, is_demo INTEGER NOT NULL DEFAULT 0,
     attestation_contract_id TEXT, attestation_tx_hash TEXT,
     attestation_ledger INTEGER, attested_at INTEGER,
     expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  // Cumulative payment ledger (issue 1.4) — one row per payment ever recorded
  // against a link. Unique on (tx_hash, operation_id), not tx_hash alone
  // (issue 4.11): a transaction can carry more than one payment operation to
  // the same link, and each must land its own row rather than being dropped
  // as a false duplicate of the other.
  `CREATE TABLE IF NOT EXISTS link_payments (
     id TEXT PRIMARY KEY, link_id TEXT NOT NULL, tx_hash TEXT NOT NULL,
     operation_id TEXT,
     payer TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, ledger INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS link_payments_link_id_idx ON link_payments (link_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS link_payments_tx_hash_operation_id_unique
     ON link_payments (tx_hash, operation_id)`,
  `CREATE TABLE IF NOT EXISTS webhooks (
     id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, url TEXT NOT NULL,
     secret_encrypted TEXT NOT NULL, secret_last4 TEXT NOT NULL,
     previous_secret_encrypted TEXT, previous_secret_last4 TEXT,
     previous_secret_expires_at INTEGER, deleted_at INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_deliveries (
     id TEXT PRIMARY KEY, webhook_id TEXT NOT NULL, link_id TEXT NOT NULL,
     event TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
     queue_entry_id TEXT,
     status_code INTEGER, ok INTEGER NOT NULL,
     error TEXT, created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_deliveries_webhook_id_created_at_idx
     ON webhook_deliveries (webhook_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS webhook_queue (
     id TEXT PRIMARY KEY,
     webhook_id TEXT NOT NULL,
     link_id TEXT NOT NULL,
     event TEXT NOT NULL,
     payload TEXT NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL,
     status TEXT NOT NULL DEFAULT 'pending',
     last_status_code INTEGER,
     last_error TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Index to make the worker's "claim due rows" query fast.
  `CREATE INDEX IF NOT EXISTS idx_webhook_queue_due
     ON webhook_queue (status, next_attempt_at)`,
  `CREATE TABLE IF NOT EXISTS offramp_quotes (
     quote_id TEXT PRIMARY KEY, link_id TEXT NOT NULL,
     sell_asset_code TEXT NOT NULL, sell_asset_issuer TEXT, sell_amount TEXT NOT NULL,
     buy_currency TEXT NOT NULL, price TEXT NOT NULL,
     expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_jobs (
     job_id TEXT PRIMARY KEY, link_id TEXT NOT NULL, anchor TEXT NOT NULL,
     target_currency TEXT NOT NULL, target_amount TEXT NOT NULL, rate TEXT NOT NULL,
     status TEXT NOT NULL, external_status TEXT, last_error TEXT,
     created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS seller_kyc (
     seller_id TEXT PRIMARY KEY, customer_id TEXT, status TEXT NOT NULL,
     required_fields TEXT NOT NULL, fields_encrypted TEXT NOT NULL,
     message TEXT, last_synced_at INTEGER, updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS watcher_cursors (
     account TEXT PRIMARY KEY, cursor TEXT NOT NULL, updated_at INTEGER NOT NULL
   )`,
  // Watcher dedup ledger (issue 4.11). Keyed on (tx_hash, operation_id), not
  // tx_hash alone: a transaction can carry more than one payment operation,
  // and each must dedupe independently. operation_id NULL (only possible via
  // migrateLegacyProcessedTxTable, never written by new code) means "the
  // whole transaction", preserving old behavior for pre-migration rows.
  `CREATE TABLE IF NOT EXISTS processed_tx (
     tx_hash TEXT NOT NULL, operation_id TEXT, link_id TEXT, created_at INTEGER NOT NULL,
     PRIMARY KEY (tx_hash, operation_id)
   )`,
  `CREATE INDEX IF NOT EXISTS processed_tx_tx_hash_idx ON processed_tx (tx_hash)`,
  `CREATE TABLE IF NOT EXISTS idempotency_keys (
     key TEXT NOT NULL, seller_id TEXT NOT NULL, endpoint TEXT NOT NULL,
     request_hash TEXT NOT NULL, response_status INTEGER NOT NULL,
     response_body TEXT NOT NULL, created_at INTEGER NOT NULL,
     PRIMARY KEY (key, seller_id)
   )`,
  `CREATE TABLE IF NOT EXISTS revoked_tokens (
     jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, revoked_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS offramp_telemetry (
     id TEXT PRIMARY KEY,
     anchor_domain TEXT NOT NULL,
     corridor TEXT NOT NULL,
     sell_asset TEXT NOT NULL,
     sell_amount TEXT NOT NULL,
     indicative_rate TEXT,
     quoted_rate TEXT NOT NULL,
     quoted_at INTEGER NOT NULL,
     initiated_at INTEGER,
     settled_at INTEGER,
     effective_rate TEXT,
     fee_amount TEXT,
     status TEXT NOT NULL,
     failure_reason TEXT
   )`,
  // API keys for programmatic access (issue #40, 6.3).
  // hash = scrypt digest — plaintext is NEVER persisted.
  `CREATE TABLE IF NOT EXISTS api_keys (
     id TEXT PRIMARY KEY,
     seller_id TEXT NOT NULL,
     name TEXT NOT NULL,
     prefix TEXT NOT NULL,
     hash TEXT NOT NULL,
     scopes TEXT NOT NULL,
     last_used_at INTEGER,
     created_at INTEGER NOT NULL,
     revoked_at INTEGER
   )`,
];

// Additive column added after the initial release. `CREATE TABLE IF NOT EXISTS`
// above won't touch an existing table, so add it out-of-band; ignore the
// "duplicate column" error on databases that already have it.
const ADDITIVE_MIGRATIONS = [
  `ALTER TABLE links ADD COLUMN offramp_indicative_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_rate_delta TEXT`,
  `ALTER TABLE links ADD COLUMN overpaid_amount TEXT`,
  `ALTER TABLE links ADD COLUMN muxed_id TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_amount TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_currency TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_fee_source TEXT`,
  `ALTER TABLE links ADD COLUMN offramp_net_target_amount TEXT`,
  `ALTER TABLE links ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0`,
  // #32: store the seller's last-used payout destination (e.g. bank account).
  //      Stored as plaintext JSON — NOT encrypted at rest by libSQL/Turso by
  //      default — so this is treated as sensitive end-to-end: masked to the
  //      last 4 chars in every API response and never logged or webhook'd.
  `ALTER TABLE sellers ADD COLUMN payout_fields_json TEXT`,
  // 9.2: on-chain settlement attestation. Nullable and additive — an old binary
  // talking to this schema simply never reads them, which is the rollback case
  // docs/RUNBOOK.md calls out as safe.
  `ALTER TABLE links ADD COLUMN attestation_contract_id TEXT`,
  `ALTER TABLE links ADD COLUMN attestation_tx_hash TEXT`,
  `ALTER TABLE links ADD COLUMN attestation_ledger INTEGER`,
  `ALTER TABLE links ADD COLUMN attested_at INTEGER`,
  `ALTER TABLE link_payments ADD COLUMN ledger INTEGER`,
  // BUG-4.21: a `sellers` table created before `wallet` gained UNIQUE still has
  // a plain `wallet TEXT NOT NULL`, and CREATE TABLE IF NOT EXISTS never
  // upgrades an existing table. `createIfAbsent` uses ON CONFLICT (wallet),
  // which SQLite rejects outright without a matching constraint — so every
  // wallet login failed with a 500.
  //
  // SQLite cannot ALTER TABLE ADD CONSTRAINT, but a unique index IS a valid
  // ON CONFLICT target, so this is the additive equivalent. On a fresh database
  // the constraint already comes from CREATE TABLE and this is a no-op.
  //
  // Deliberately not swallowed if it fails: the only way it can is duplicate
  // wallets already present, and "logins stay broken forever" is not an
  // acceptable answer to that.
  `CREATE UNIQUE INDEX IF NOT EXISTS sellers_wallet_unique ON sellers (wallet)`,
];

export function createDb(databaseUrl: string, authToken?: string): { db: DB; client: Client } {
  const client = createClient({ url: databaseUrl, authToken });
  const db = drizzle(client, { schema });
  return { db, client };
}

/**
 * Upgrades a `webhooks` table created before the secret-rotation feature
 * (plaintext `secret` column, no lifecycle columns) in place. Only runs its
 * ALTERs if the old shape is actually detected, so it's a no-op on fresh
 * databases (which get the current shape directly from BOOTSTRAP_SQL above)
 * and on databases already upgraded.
 *
 * The plaintext `secret` column is intentionally left in place rather than
 * dropped — DROP COLUMN support varies across older SQLite builds, and
 * leaving an unused column is harmless. New code never reads it.
 */
async function migrateLegacyWebhooksTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(webhooks)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("secret_encrypted")) return; // fresh table, or already migrated

  for (const [name, ddl] of [
    ["secret_encrypted", "ALTER TABLE webhooks ADD COLUMN secret_encrypted TEXT"],
    ["secret_last4", "ALTER TABLE webhooks ADD COLUMN secret_last4 TEXT"],
    ["previous_secret_encrypted", "ALTER TABLE webhooks ADD COLUMN previous_secret_encrypted TEXT"],
    ["previous_secret_last4", "ALTER TABLE webhooks ADD COLUMN previous_secret_last4 TEXT"],
    ["previous_secret_expires_at", "ALTER TABLE webhooks ADD COLUMN previous_secret_expires_at INTEGER"],
    ["deleted_at", "ALTER TABLE webhooks ADD COLUMN deleted_at INTEGER"],
  ] as const) {
    if (!columns.has(name)) await client.execute(ddl);
  }

  if (columns.has("secret")) {
    const rows = await client.execute("SELECT id, secret FROM webhooks WHERE secret_encrypted IS NULL");
    for (const row of rows.rows) {
      const plaintext = String(row.secret ?? "");
      if (!plaintext) continue;
      await client.execute({
        sql: "UPDATE webhooks SET secret_encrypted = ?, secret_last4 = ? WHERE id = ?",
        args: [encryptSecret(plaintext), last4(plaintext), String(row.id)],
      });
    }
  }
}

/**
 * Rebuilds `processed_tx` around (tx_hash, operation_id) instead of tx_hash
 * alone (issue 4.11). SQLite can't ALTER a column into/out of a PRIMARY KEY,
 * and the whole point here is that tx_hash must stop being unique by itself —
 * two payment operations sharing one transaction need two rows — so this is a
 * rename/recreate/copy/drop, not an ADD COLUMN. Legacy rows get
 * operation_id = NULL, which `DrizzleWatcherStateRepository.isProcessed`
 * treats as "the whole transaction was processed", preserving exactly the
 * dedup behavior anything already settled before this migration runs had.
 *
 * No-op on a fresh database (BOOTSTRAP_SQL below creates the current shape
 * directly) and on a database already migrated.
 */
async function migrateLegacyProcessedTxTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(processed_tx)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("operation_id")) return; // fresh table, or already migrated

  await client.execute("ALTER TABLE processed_tx RENAME TO processed_tx_legacy_4_11");
  await client.execute(`CREATE TABLE processed_tx (
     tx_hash TEXT NOT NULL, operation_id TEXT, link_id TEXT, created_at INTEGER NOT NULL,
     PRIMARY KEY (tx_hash, operation_id)
   )`);
  await client.execute("CREATE INDEX IF NOT EXISTS processed_tx_tx_hash_idx ON processed_tx (tx_hash)");
  await client.execute(
    `INSERT INTO processed_tx (tx_hash, operation_id, link_id, created_at)
     SELECT tx_hash, NULL, link_id, created_at FROM processed_tx_legacy_4_11`,
  );
  await client.execute("DROP TABLE processed_tx_legacy_4_11");
}

/**
 * Same rebuild as `migrateLegacyProcessedTxTable`, for `link_payments` (issue
 * 4.11): the unique constraint moves from tx_hash alone to
 * (tx_hash, operation_id), so a split payment's second operation gets its own
 * ledger row instead of being silently dropped by `onConflictDoNothing`.
 * Legacy rows get operation_id = NULL; unlike processed_tx, nothing reads
 * link_payments as a dedup gate, so NULL there carries no special meaning —
 * it just fills the new column on rows written before it existed.
 */
async function migrateLegacyLinkPaymentsTable(client: Client): Promise<void> {
  const info = await client.execute("PRAGMA table_info(link_payments)");
  const columns = new Set(info.rows.map((r) => String(r.name)));
  if (columns.size === 0 || columns.has("operation_id")) return; // fresh table, or already migrated

  // `ledger` (issue 9.2) may or may not be present yet depending on how old
  // this particular database is — don't assume either way, select it if it's
  // there and NULL otherwise, same as `operation_id` always being NULL here.
  const ledgerSelect = columns.has("ledger") ? "ledger" : "NULL";

  await client.execute("ALTER TABLE link_payments RENAME TO link_payments_legacy_4_11");
  await client.execute(`CREATE TABLE link_payments (
     id TEXT PRIMARY KEY, link_id TEXT NOT NULL, tx_hash TEXT NOT NULL,
     operation_id TEXT,
     payer TEXT NOT NULL, amount TEXT NOT NULL,
     asset_code TEXT NOT NULL, asset_issuer TEXT, ledger INTEGER,
     created_at INTEGER NOT NULL
   )`);
  await client.execute("CREATE INDEX IF NOT EXISTS link_payments_link_id_idx ON link_payments (link_id)");
  await client.execute(
    `CREATE UNIQUE INDEX IF NOT EXISTS link_payments_tx_hash_operation_id_unique
       ON link_payments (tx_hash, operation_id)`,
  );
  await client.execute(
    `INSERT INTO link_payments (id, link_id, tx_hash, operation_id, payer, amount, asset_code, asset_issuer, ledger, created_at)
     SELECT id, link_id, tx_hash, NULL, payer, amount, asset_code, asset_issuer, ${ledgerSelect}, created_at
     FROM link_payments_legacy_4_11`,
  );
  await client.execute("DROP TABLE link_payments_legacy_4_11");
}

export async function bootstrap(client: Client): Promise<void> {
  await migrateLegacyWebhooksTable(client);
  await migrateLegacyProcessedTxTable(client);
  await migrateLegacyLinkPaymentsTable(client);
  for (const sql of BOOTSTRAP_SQL) {
    try {
      await client.execute(sql);
    } catch (err) {
      // Tolerate "duplicate column" errors from the ALTER TABLE migration so the
      // bootstrap is idempotent on both fresh and pre-existing databases.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("duplicate column") || msg.includes("already exists")) continue;
      throw err;
    }
  }
  for (const sql of ADDITIVE_MIGRATIONS) {
    try {
      await client.execute(sql);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.toLowerCase().includes("duplicate column")) throw err;
    }
  }
}

export { schema };