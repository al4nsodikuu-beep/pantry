PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS accounts (
  user_id TEXT PRIMARY KEY,
  play_account_id TEXT UNIQUE NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  subscription_status TEXT NOT NULL,
  product_id TEXT NOT NULL,
  base_plan_id TEXT NOT NULL,
  purchase_token BLOB NOT NULL, -- Fernet authenticated encryption; never returned to clients
  subscription_start TEXT,
  subscription_expiry TEXT,
  auto_renewing INTEGER NOT NULL CHECK(auto_renewing IN (0,1)),
  platform TEXT NOT NULL CHECK(platform = 'google_play'),
  acknowledged INTEGER NOT NULL DEFAULT 0,
  replaced_by_hash TEXT,
  last_verified_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS subscription_owner ON subscriptions(user_id);
CREATE TABLE IF NOT EXISTS entitlements (
  user_id TEXT NOT NULL REFERENCES accounts(user_id),
  entitlement TEXT NOT NULL CHECK(entitlement = 'premium'),
  active INTEGER NOT NULL CHECK(active IN (0,1)),
  expires_at TEXT,
  verified_at TEXT NOT NULL,
  PRIMARY KEY(user_id, entitlement)
);
CREATE TABLE IF NOT EXISTS processed_notifications (
  message_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL
);
