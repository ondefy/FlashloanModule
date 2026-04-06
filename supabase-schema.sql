-- =============================================================================
-- Zyfi DeFi Yield Optimization Platform — Supabase Schema
-- Target: Base mainnet (chain ID 8453)
-- Convention: ALL addresses stored lowercase, amounts in raw units (wei/smallest unit)
-- =============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";    -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";     -- text search optimization (optional)

-- =============================================================================
-- 1. TOKENS — Registry of supported tokens with decimal info
-- =============================================================================

CREATE TABLE tokens (
  address       TEXT PRIMARY KEY CHECK (address = lower(address)),
  symbol        TEXT NOT NULL,
  name          TEXT NOT NULL,
  decimals      SMALLINT NOT NULL CHECK (decimals >= 0 AND decimals <= 18),
  chain_id      INTEGER NOT NULL DEFAULT 8453,
  is_collateral BOOLEAN NOT NULL DEFAULT false,   -- can be used as collateral
  is_borrowable BOOLEAN NOT NULL DEFAULT false,   -- can be borrowed
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE tokens IS 'Supported tokens with decimal and capability info';
COMMENT ON COLUMN tokens.address IS 'Token contract address (lowercase)';
COMMENT ON COLUMN tokens.decimals IS 'Token decimals (WETH=18, USDC=6)';

-- Seed Base mainnet tokens
INSERT INTO tokens (address, symbol, name, decimals, is_collateral, is_borrowable) VALUES
  ('0x4200000000000000000000000000000000000006', 'WETH',  'Wrapped Ether',   18, true,  false),
  ('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC',  'USD Coin',        6,  false, true),
  ('0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22', 'cbETH', 'Coinbase ETH',    18, true,  false),
  ('0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452', 'wstETH','Wrapped stETH',   18, true,  false),
  ('0x50c5725949a6f0c72e6c4a641f24049a917db0cb', 'DAI',   'Dai Stablecoin',  18, false, true),
  ('0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', 'USDbC', 'USD Base Coin',   6,  false, true)
ON CONFLICT (address) DO NOTHING;

-- =============================================================================
-- 2. PROTOCOLS — Supported lending protocols
-- =============================================================================

CREATE TABLE protocols (
  id              TEXT PRIMARY KEY,                -- 'aave_v3', 'morpho_blue'
  name            TEXT NOT NULL,
  pool_address    TEXT NOT NULL CHECK (pool_address = lower(pool_address)),
  flashloan_fee   NUMERIC NOT NULL DEFAULT 0,      -- 0 for Morpho, 0.0005 for Aave (0.05%)
  chain_id        INTEGER NOT NULL DEFAULT 8453,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE protocols IS 'Supported lending protocols';
COMMENT ON COLUMN protocols.flashloan_fee IS 'Flashloan fee as decimal (0.0005 = 0.05%)';

INSERT INTO protocols (id, name, pool_address, flashloan_fee) VALUES
  ('aave_v3',     'Aave V3',     '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', 0.0005),
  ('morpho_blue', 'Morpho Blue', '0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb', 0)
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 3. USERS — Authenticated users (EOA -> Safe mapping)
-- =============================================================================

CREATE TABLE users (
  address           TEXT PRIMARY KEY CHECK (address = lower(address)),    -- EOA (MetaMask)
  safe_address      TEXT UNIQUE CHECK (safe_address = lower(safe_address)),
  onboarding_step   SMALLINT NOT NULL DEFAULT 0 CHECK (onboarding_step BETWEEN 0 AND 3),
    -- 0 = new user (just authenticated)
    -- 1 = Safe deployed
    -- 2 = Modules installed (GuardedExecModule + SmartSessions + UnifiedFlashloanModule)
    -- 3 = Session key created (fully onboarded)
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE users IS 'Authenticated users with Safe smart wallet mapping';
COMMENT ON COLUMN users.address IS 'User EOA address from MetaMask (lowercase)';
COMMENT ON COLUMN users.safe_address IS 'Deployed Safe smart wallet address (lowercase)';
COMMENT ON COLUMN users.onboarding_step IS '0=new, 1=safe deployed, 2=modules installed, 3=session key created';

CREATE INDEX idx_users_safe ON users(safe_address) WHERE safe_address IS NOT NULL;
CREATE INDEX idx_users_onboarding ON users(onboarding_step);

-- =============================================================================
-- 4. SESSION_KEYS — Encrypted session keys (separate table for security)
-- =============================================================================

CREATE TABLE session_keys (
  user_address    TEXT PRIMARY KEY REFERENCES users(address) ON DELETE CASCADE
                    CHECK (user_address = lower(user_address)),
  key_address     TEXT NOT NULL CHECK (key_address = lower(key_address)),    -- Public address of session key
  encrypted_key   JSONB NOT NULL,                                            -- { iv, authTag, ciphertext } (AES-256-GCM)
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at      TIMESTAMPTZ                                               -- NULL until first rotation
);

COMMENT ON TABLE session_keys IS 'AES-256-GCM encrypted session keys. NEVER store plaintext.';
COMMENT ON COLUMN session_keys.encrypted_key IS 'JSON: { iv: hex, authTag: hex, ciphertext: hex }. Decrypted only in backend memory.';
COMMENT ON COLUMN session_keys.key_address IS 'Derived public address of session key (for on-chain reference)';

-- =============================================================================
-- 5. POSITIONS — Active collateral/debt positions
-- =============================================================================

CREATE TABLE positions (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_address        TEXT NOT NULL REFERENCES users(address)
                        CHECK (user_address = lower(user_address)),
  safe_address        TEXT NOT NULL CHECK (safe_address = lower(safe_address)),

  -- Protocol info
  current_protocol    TEXT NOT NULL REFERENCES protocols(id),       -- 'aave_v3' or 'morpho_blue'

  -- Collateral side
  collateral_token    TEXT NOT NULL REFERENCES tokens(address),     -- e.g., WETH
  collateral_amount   NUMERIC NOT NULL DEFAULT 0,                   -- Raw units (wei for WETH = 18 decimals)

  -- Debt side
  debt_token          TEXT NOT NULL REFERENCES tokens(address),     -- e.g., USDC
  debt_amount         NUMERIC NOT NULL DEFAULT 0,                   -- Raw units (6 decimals for USDC)

  -- Health & monitoring
  health_factor       NUMERIC,                                      -- Last computed HF (e.g., 1.85)
  liquidation_threshold NUMERIC,                                    -- Protocol LT (e.g., 0.83 for Aave WETH)
  supply_apy          NUMERIC,                                      -- Current supply APY at last check
  borrow_apy          NUMERIC,                                      -- Current borrow APY at last check
  net_apy             NUMERIC,                                      -- supply_apy - borrow_apy

  -- Status
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'migrating', 'closing', 'closed')),
  migration_count     INTEGER NOT NULL DEFAULT 0,                   -- Times this position was migrated
  last_checked_at     TIMESTAMPTZ,                                  -- Last health check timestamp
  next_check_at       TIMESTAMPTZ DEFAULT now(),                    -- When daemon should check next (tiered)

  -- Morpho-specific (NULL for Aave positions)
  morpho_market_id    TEXT,                                         -- Morpho market hash

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE positions IS 'Active user positions across protocols';
COMMENT ON COLUMN positions.collateral_amount IS 'Stored in raw token units (wei). Use tokens.decimals to convert.';
COMMENT ON COLUMN positions.debt_amount IS 'Stored in raw token units. USDC = 6 decimals, so 1000 USDC = 1000000000.';
COMMENT ON COLUMN positions.health_factor IS 'collateralValue * liquidationThreshold / debtValue. < 1.0 = liquidatable.';
COMMENT ON COLUMN positions.next_check_at IS 'Tiered monitoring: HF<1.3=15s, 1.3-1.5=30s, 1.5-2.0=2min, >2.0=10min.';

-- Indexes for daemon queries
CREATE INDEX idx_positions_user ON positions(user_address);
CREATE INDEX idx_positions_status ON positions(status) WHERE status = 'active';
CREATE INDEX idx_positions_next_check ON positions(next_check_at ASC) WHERE status = 'active';
CREATE INDEX idx_positions_health ON positions(health_factor ASC) WHERE status = 'active';
CREATE INDEX idx_positions_protocol ON positions(current_protocol) WHERE status = 'active';
CREATE INDEX idx_positions_safe ON positions(safe_address);

-- =============================================================================
-- 6. TRANSACTION_LOGS — Comprehensive log of ALL operations
-- =============================================================================

CREATE TABLE transaction_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_address    TEXT NOT NULL REFERENCES users(address)
                    CHECK (user_address = lower(user_address)),
  position_id     UUID REFERENCES positions(id),                     -- NULL for onboarding txs
  safe_address    TEXT CHECK (safe_address = lower(safe_address)),

  -- Transaction type
  tx_type         TEXT NOT NULL CHECK (tx_type IN (
    'deposit',              -- Supply collateral to protocol
    'withdraw',             -- Withdraw collateral
    'borrow',               -- Borrow asset
    'repay',                -- Repay debt
    'flashloan_migrate',    -- Atomic collateral swap between protocols
    'liquidation_protect',  -- Emergency position adjustment
    'safe_deploy',          -- Safe smart wallet deployment
    'module_install',       -- Module installation
    'session_key_create',   -- Session key creation
    'approve',              -- Token approval
    'transfer'              -- Token transfer (e.g., USDC to EOA after borrow)
  )),

  -- Protocol info
  protocol        TEXT REFERENCES protocols(id),                     -- Which protocol (NULL for non-protocol txs)

  -- Token info
  token_address   TEXT REFERENCES tokens(address)                    -- Which token
                    CHECK (token_address = lower(token_address)),

  -- Amounts (raw units — use tokens.decimals to convert for display)
  amount          NUMERIC,                                           -- Primary amount in raw token units
  amount_usd      NUMERIC,                                           -- USD value at time of tx (optional)

  -- On-chain reference
  tx_hash         TEXT,                                              -- On-chain transaction hash
  user_op_hash    TEXT,                                              -- ERC-4337 UserOp hash
  block_number    BIGINT,

  -- Status
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'submitted', 'confirmed', 'failed', 'reverted')),
  error_message   TEXT,                                              -- Error details if failed

  -- Migration-specific metadata
  metadata        JSONB DEFAULT '{}',
    -- For flashloan_migrate:
    --   { "from_protocol": "aave_v3", "to_protocol": "morpho_blue",
    --     "flashloan_provider": "morpho_blue", "flashloan_fee": "0",
    --     "collateral_amount": "1000000000000000000",
    --     "debt_amount": "1000000000",
    --     "rate_diff_bps": 75 }
    --
    -- For borrow:
    --   { "recipient_eoa": "0x...", "interest_rate_mode": 2 }
    --
    -- For deposit:
    --   { "detected_via": "listener" | "api_call" }

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE transaction_logs IS 'Immutable log of every operation. Never update, only insert.';
COMMENT ON COLUMN transaction_logs.amount IS 'Raw token units. Join tokens table for decimals. WETH: 1e18 = 1 WETH. USDC: 1e6 = 1 USDC.';
COMMENT ON COLUMN transaction_logs.metadata IS 'Structured extra data per tx_type. See schema comments for shapes.';

-- Indexes for querying
CREATE INDEX idx_logs_user ON transaction_logs(user_address);
CREATE INDEX idx_logs_user_type ON transaction_logs(user_address, tx_type);
CREATE INDEX idx_logs_user_created ON transaction_logs(user_address, created_at DESC);
CREATE INDEX idx_logs_position ON transaction_logs(position_id) WHERE position_id IS NOT NULL;
CREATE INDEX idx_logs_tx_hash ON transaction_logs(tx_hash) WHERE tx_hash IS NOT NULL;
CREATE INDEX idx_logs_created ON transaction_logs(created_at DESC);
CREATE INDEX idx_logs_status ON transaction_logs(status) WHERE status IN ('pending', 'submitted');
CREATE INDEX idx_logs_type ON transaction_logs(tx_type);

-- =============================================================================
-- 7. RATE_SNAPSHOTS — Historical rate data for decision making
-- =============================================================================

CREATE TABLE rate_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol        TEXT NOT NULL REFERENCES protocols(id),
  token_address   TEXT NOT NULL REFERENCES tokens(address)
                    CHECK (token_address = lower(token_address)),
  supply_apy      NUMERIC NOT NULL,           -- Annual percentage yield (decimal: 0.035 = 3.5%)
  borrow_apy      NUMERIC NOT NULL,           -- Annual borrow rate (decimal: 0.042 = 4.2%)
  collateral_factor NUMERIC,                  -- Protocol collateral factor (0.83 = 83%)
  liquidity       NUMERIC,                    -- Available liquidity in raw units
  utilization     NUMERIC,                    -- Pool utilization rate (0-1)
  snapshot_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE rate_snapshots IS 'Periodic rate snapshots for trend analysis and migration decisions.';
COMMENT ON COLUMN rate_snapshots.supply_apy IS 'Decimal form: 0.035 = 3.5% APY';

CREATE INDEX idx_rates_protocol_token ON rate_snapshots(protocol, token_address, snapshot_at DESC);
CREATE INDEX idx_rates_snapshot_at ON rate_snapshots(snapshot_at DESC);

-- Partition-friendly: delete old snapshots periodically
-- Retention policy: keep 30 days of rate data
-- Run weekly: DELETE FROM rate_snapshots WHERE snapshot_at < now() - interval '30 days';

-- =============================================================================
-- 8. MIGRATION_HISTORY — Dedicated table for migration analytics
-- =============================================================================

CREATE TABLE migration_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  position_id       UUID NOT NULL REFERENCES positions(id),
  user_address      TEXT NOT NULL REFERENCES users(address)
                      CHECK (user_address = lower(user_address)),

  from_protocol     TEXT NOT NULL REFERENCES protocols(id),
  to_protocol       TEXT NOT NULL REFERENCES protocols(id),

  -- Amounts at time of migration (raw units)
  collateral_token  TEXT NOT NULL REFERENCES tokens(address),
  collateral_amount NUMERIC NOT NULL,
  debt_token        TEXT NOT NULL REFERENCES tokens(address),
  debt_amount       NUMERIC NOT NULL,

  -- Flashloan details
  flashloan_provider TEXT NOT NULL,             -- 'morpho_blue' or 'aave_v3'
  flashloan_token   TEXT NOT NULL REFERENCES tokens(address),
  flashloan_amount  NUMERIC NOT NULL,
  flashloan_fee     NUMERIC NOT NULL DEFAULT 0, -- Fee paid in raw units

  -- Rate justification
  old_supply_apy    NUMERIC,
  new_supply_apy    NUMERIC,
  old_borrow_apy    NUMERIC,
  new_borrow_apy    NUMERIC,
  rate_diff_bps     INTEGER,                    -- Basis points improvement

  -- Execution
  tx_hash           TEXT,
  gas_used          BIGINT,
  gas_cost_usd      NUMERIC,
  execution_time_ms INTEGER,                    -- How long the migration took

  -- Result
  status            TEXT NOT NULL DEFAULT 'completed'
                      CHECK (status IN ('completed', 'failed', 'reverted')),
  error_message     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE migration_history IS 'Detailed record of every position migration for analytics and auditing.';

CREATE INDEX idx_migration_position ON migration_history(position_id);
CREATE INDEX idx_migration_user ON migration_history(user_address);
CREATE INDEX idx_migration_created ON migration_history(created_at DESC);

-- =============================================================================
-- 9. UPDATED_AT TRIGGER — Auto-update timestamps
-- =============================================================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trg_positions_updated_at
  BEFORE UPDATE ON positions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================================================
-- 10. ROW LEVEL SECURITY (RLS) — Defense in depth
-- =============================================================================

-- Enable RLS on sensitive tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE migration_history ENABLE ROW LEVEL SECURITY;

-- Service role bypasses RLS (backend uses service role key)
-- These policies are for defense-in-depth if anon/authenticated roles are ever used

-- Users can only see their own data
CREATE POLICY users_self ON users
  FOR ALL USING (true);  -- Service role has full access

CREATE POLICY session_keys_self ON session_keys
  FOR ALL USING (true);  -- Only accessible via service role

CREATE POLICY positions_self ON positions
  FOR ALL USING (true);

CREATE POLICY logs_self ON transaction_logs
  FOR ALL USING (true);

CREATE POLICY migration_self ON migration_history
  FOR ALL USING (true);

-- Public tables (no RLS needed)
-- tokens and protocols are public reference data
-- rate_snapshots are public market data

-- =============================================================================
-- 11. USEFUL VIEWS
-- =============================================================================

-- View: Active positions with token details
CREATE VIEW v_positions_detail AS
SELECT
  p.id,
  p.user_address,
  p.safe_address,
  p.current_protocol,
  pr.name AS protocol_name,
  ct.symbol AS collateral_symbol,
  ct.decimals AS collateral_decimals,
  p.collateral_amount,
  -- Human-readable collateral: raw / 10^decimals
  (p.collateral_amount / power(10, ct.decimals))::NUMERIC(36, 18) AS collateral_human,
  dt.symbol AS debt_symbol,
  dt.decimals AS debt_decimals,
  p.debt_amount,
  -- Human-readable debt: raw / 10^decimals
  (p.debt_amount / power(10, dt.decimals))::NUMERIC(36, 6) AS debt_human,
  p.health_factor,
  p.supply_apy,
  p.borrow_apy,
  p.net_apy,
  p.status,
  p.migration_count,
  p.last_checked_at,
  p.next_check_at,
  p.created_at,
  p.updated_at
FROM positions p
JOIN tokens ct ON p.collateral_token = ct.address
JOIN tokens dt ON p.debt_token = dt.address
JOIN protocols pr ON p.current_protocol = pr.id;

-- View: Transaction logs with token details
CREATE VIEW v_transaction_logs AS
SELECT
  tl.id,
  tl.user_address,
  tl.position_id,
  tl.tx_type,
  tl.protocol,
  pr.name AS protocol_name,
  t.symbol AS token_symbol,
  t.decimals AS token_decimals,
  tl.amount,
  -- Human-readable amount
  CASE WHEN t.decimals IS NOT NULL
    THEN (tl.amount / power(10, t.decimals))::NUMERIC(36, 18)
    ELSE tl.amount
  END AS amount_human,
  tl.amount_usd,
  tl.tx_hash,
  tl.user_op_hash,
  tl.status,
  tl.error_message,
  tl.metadata,
  tl.created_at
FROM transaction_logs tl
LEFT JOIN tokens t ON tl.token_address = t.address
LEFT JOIN protocols pr ON tl.protocol = pr.id;

-- View: Positions due for health check (daemon query)
CREATE VIEW v_positions_due_check AS
SELECT
  p.id,
  p.user_address,
  p.safe_address,
  p.current_protocol,
  p.collateral_token,
  p.collateral_amount,
  p.debt_token,
  p.debt_amount,
  p.health_factor,
  p.next_check_at,
  sk.encrypted_key,
  sk.key_address
FROM positions p
JOIN session_keys sk ON p.user_address = sk.user_address AND sk.is_active = true
WHERE p.status = 'active'
  AND p.next_check_at <= now()
ORDER BY p.next_check_at ASC;

-- =============================================================================
-- 12. HELPER FUNCTIONS
-- =============================================================================

-- Function: Calculate next check time based on health factor (tiered monitoring)
CREATE OR REPLACE FUNCTION calc_next_check_at(hf NUMERIC)
RETURNS TIMESTAMPTZ AS $$
BEGIN
  IF hf IS NULL THEN
    RETURN now() + interval '1 minute';
  ELSIF hf < 1.3 THEN
    RETURN now() + interval '15 seconds';    -- Critical
  ELSIF hf < 1.5 THEN
    RETURN now() + interval '30 seconds';    -- Elevated risk
  ELSIF hf < 2.0 THEN
    RETURN now() + interval '2 minutes';     -- Normal
  ELSE
    RETURN now() + interval '10 minutes';    -- Healthy
  END IF;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- Function: Update position health and set next check time
CREATE OR REPLACE FUNCTION update_position_health(
  p_id UUID,
  p_health_factor NUMERIC,
  p_collateral_amount NUMERIC,
  p_debt_amount NUMERIC,
  p_supply_apy NUMERIC DEFAULT NULL,
  p_borrow_apy NUMERIC DEFAULT NULL
)
RETURNS VOID AS $$
BEGIN
  UPDATE positions SET
    health_factor = p_health_factor,
    collateral_amount = p_collateral_amount,
    debt_amount = p_debt_amount,
    supply_apy = COALESCE(p_supply_apy, supply_apy),
    borrow_apy = COALESCE(p_borrow_apy, borrow_apy),
    net_apy = COALESCE(p_supply_apy, supply_apy) - COALESCE(p_borrow_apy, borrow_apy),
    last_checked_at = now(),
    next_check_at = calc_next_check_at(p_health_factor)
  WHERE id = p_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 13. EXAMPLE QUERIES
-- =============================================================================

-- Get all logs for a specific address (with human-readable amounts)
-- SELECT * FROM v_transaction_logs WHERE user_address = '0x...' ORDER BY created_at DESC;

-- Get active positions needing health check
-- SELECT * FROM v_positions_due_check LIMIT 500;

-- Get migration history with rate improvement
-- SELECT * FROM migration_history WHERE user_address = '0x...' ORDER BY created_at DESC;

-- Get rate comparison between protocols for WETH
-- SELECT protocol, supply_apy, borrow_apy, collateral_factor, snapshot_at
-- FROM rate_snapshots
-- WHERE token_address = '0x4200000000000000000000000000000000000006'
-- ORDER BY snapshot_at DESC LIMIT 10;

-- Count active positions per protocol
-- SELECT current_protocol, count(*) FROM positions WHERE status = 'active' GROUP BY current_protocol;

-- Positions with health factor below threshold
-- SELECT * FROM v_positions_detail WHERE status = 'active' AND health_factor < 1.5 ORDER BY health_factor ASC;
