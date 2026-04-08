# PROJECT-PLAN.md

Complete architecture, objectives, and implementation roadmap for the Zyfi DeFi Yield Optimization Platform.

---

## 1. Product Objective

A DeFi yield optimization platform on **Base mainnet** where:
- Users deposit collateral (WETH), borrow stablecoins (USDC), and keep the borrowed USDC in their EOA
- Backend autonomously monitors positions and rebalances across Aave V3 / Morpho Blue for best APY
- All position management happens via session keys — no user signatures needed after onboarding
- Flashloan-based atomic collateral swaps ensure zero downtime during migrations

---

## 2. User Flow (End to End)

### 2.1 Onboarding (One-Time, 3 Steps)

```
Step 1: Deploy Safe Smart Wallet
  - Frontend calls POST /onboarding/deploy-safe/prepare
  - User signs EIP-712 typed data via MetaMask
  - Frontend calls POST /onboarding/deploy-safe/submit with signature
  - Safe deployed on Base via Pimlico bundler (ERC-4337 UserOp)

Step 2: Install Modules
  - Install GuardedExecModule (executor, type 2)
  - Install SmartSessions (validator, type 1)
  - Install UnifiedFlashloanModule (executor, type 2)
  - Same prepare/submit pattern with MetaMask EIP-712 signing

Step 3: Create Session Key
  - Server generates ephemeral private key
  - Frontend signs permissionEnableHash via MetaMask (EIP-191)
  - Session key encrypted with AES-256-GCM, stored in Supabase
  - Session key scoped: can ONLY call GuardedExecModule.executeGuardedBatch()
```

### 2.2 Authentication

```
1. Frontend: GET /auth/nonce?address=0x...
   - Server returns: "Sign this message to authenticate...\n\nNonce: {UUID}"
   - Nonce stored in-memory, TTL 5 minutes

2. Frontend: User signs nonce with MetaMask (EIP-191)

3. Frontend: POST /auth/verify { address, signature, nonce }
   - Server verifies via viem.verifyMessage()
   - Creates/updates user in Supabase
   - Returns JWT (24h expiry)

4. All subsequent API calls use: Authorization: Bearer <JWT>
```

### 2.3 Deposit & Position Creation

```
1. User sends WETH to their Safe smart wallet address
2. Backend detects deposit (blockchain listener or frontend POST /vault/deposit)
3. Backend instantly compares Aave vs Morpho supply APY (cached rates)
4. Backend builds supply transaction:
   [WETH.approve(bestPool), pool.supply(WETH, amount)]
5. Session key signs UserOp -> GuardedExecModule -> TargetRegistry check -> execute
6. Position created in DB, monitoring starts immediately
7. Transaction logged in transaction_logs table
```

### 2.4 Borrow

```
1. User calls POST /vault/borrow { amount: "1000" } (USDC)
2. Backend builds borrow transaction:
   [pool.borrow(USDC, amount), USDC.transfer(userEOA, amount)]
3. Executed via session key
4. User receives USDC in their EOA — they can do whatever they want with it
5. Debt tracked in positions table, logged in transaction_logs
```

### 2.5 Autonomous Rebalancing (The Core Value)

```
Rebalance Daemon (runs continuously):
  1. Fetch all active positions from Supabase (batched)
  2. Batch RPC: multicall3 to get health factors for 100-500 positions per call
  3. Fetch current Aave + Morpho rates (cached 30-60s)
  4. For each position, evaluate:
     - Rate differential (is other protocol offering better APY?)
     - Health factor (is position at risk?)
     - Collateral factor changes
     - Gas cost vs savings (is migration worth it?)
  5. If migration is beneficial:
     -> Build flashloan executions (6-step atomic swap)
     -> Session key signs -> GuardedExecModule -> TargetRegistry -> UnifiedFlashloanModule
     -> Flashloan callback: repay old debt, withdraw collateral, supply to new protocol, borrow to repay flashloan
  6. Log everything to transaction_logs with from_protocol, to_protocol in metadata
```

### 2.6 Repay & Withdraw

```
Repay:
  1. User sends USDC to their Safe address
  2. Calls POST /vault/repay { amount: "1000" }
  3. Backend builds: [USDC.approve(pool), pool.repay(USDC, amount)]
  4. Executed via session key on whichever protocol currently holds the position

Withdraw:
  1. After debt is repaid (fully or partially)
  2. Calls POST /vault/withdraw { amount: "1.0", token: "WETH" }
  3. Backend builds: [pool.withdraw(WETH, amount, userEOA)]
  4. WETH sent to user's EOA
```

---

## 3. Transaction Chain (Security Model)

```
User/Backend (with session key)
  │
  ▼
SmartSessions Validator ─── validates UserOp signature (session key scoped)
  │
  ▼
GuardedExecModule.executeGuardedBatch(executions[])
  │
  ▼
TargetRegistry ─── whitelist check: is target+selector allowed?
  │                 ✗ → revert
  ▼                 ✓ → proceed
UnifiedFlashloanModule.initiateFlashloan(provider, token, amount, executions)
  │
  ▼
Morpho Blue (0% fee) or Aave V3 (0.05% fee) ─── sends tokens to Module
  │
  ▼
Flashloan Callback:
  1. Validate EVERY inner execution against TargetRegistry
  2. Transfer borrowed tokens to Safe
  3. Execute batch on Safe via executeFromExecutor
  4. Pull tokens back from Safe to Module
  5. Approve repayment to flashloan provider
```

### Three-Layer Security

| Layer | Component | What it does |
|-------|-----------|-------------|
| 1 | Session Key + SmartSessions | Authorizes WHO can sign UserOps (scoped key, not Safe owner) |
| 2 | GuardedExecModule | Validates WHAT function is being called (initiateFlashloan selector) |
| 3 | TargetRegistry | Validates EVERY inner execution's target+selector inside callback |

### Whitelisted Selectors in TargetRegistry

```
# ERC20 operations
USDC.approve(address,uint256)
WETH.approve(address,uint256)

# Aave V3 operations
AavePool.supply(address,uint256,address,uint16)
AavePool.borrow(address,uint256,uint256,uint16,address)
AavePool.repay(address,uint256,uint256,address)
AavePool.withdraw(address,uint256,address)

# Morpho Blue operations
MorphoBlue.supplyCollateral(MarketParams,uint256,address,bytes)
MorphoBlue.borrow(MarketParams,uint256,uint256,address,address)

# Module entry point (for GuardedExecModule -> Module chain)
UnifiedFlashloanModule.initiateFlashloan(uint8,address,uint256,Execution[])
```

---

## 4. Architecture Overview

```
┌──────────────────────────────────────────────────────────────────┐
│                         FRONTEND (Next.js)                       │
│  MetaMask signing (EIP-712 / EIP-191) | JWT auth | Dashboard     │
└────────────────────────────┬─────────────────────────────────────┘
                             │ REST API (JWT Bearer)
┌────────────────────────────▼─────────────────────────────────────┐
│                      BACKEND (Express + TypeScript)               │
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐  │
│  │ Auth Service │  │  Vault Svc   │  │   Rebalance Daemon      │  │
│  │ Nonce + JWT  │  │ Deposit/Braw │  │   Monitor all positions │  │
│  │ EIP-191      │  │ Repay/Wdrw   │  │   Batch multicall3      │  │
│  └──────┬───────┘  └──────┬───────┘  │   Rate comparison       │  │
│         │                 │          │   Trigger flashloan swap │  │
│  ┌──────▼─────────────────▼───────┐  └────────────┬────────────┘  │
│  │     Session Key Executor       │               │               │
│  │  Decrypt key -> Sign UserOp    │◄──────────────┘               │
│  │  Submit to Pimlico bundler     │                               │
│  └────────────────────────────────┘                               │
│                                                                   │
│  ┌────────────────┐  ┌──────────────────┐                         │
│  │ Redis Cache    │  │ BullMQ Workers   │                         │
│  │ Rate snapshots │  │ Batch migrations │                         │
│  │ Token prices   │  │ 10-20 concurrent │                         │
│  └────────────────┘  └──────────────────┘                         │
└────────────────────────────┬─────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                        SUPABASE (PostgreSQL)                      │
│  users | session_keys | tokens | positions | transaction_logs     │
│  rate_snapshots | RLS enabled | Connection pooling (PgBouncer)    │
└──────────────────────────────────────────────────────────────────┘
                             │
┌────────────────────────────▼─────────────────────────────────────┐
│                     BASE MAINNET (Chain ID 8453)                  │
│                                                                   │
│  Safe Smart Wallet ─► GuardedExecModule ─► TargetRegistry         │
│        │                                        │                 │
│        └── UnifiedFlashloanModule ◄─────────────┘                 │
│                │            │                                     │
│           Morpho Blue    Aave V3                                  │
│           (0% fee)       (0.05% fee)                              │
└──────────────────────────────────────────────────────────────────┘
```

---

## 5. Session Key Security (Supabase)

### Encryption Flow

```
Server generates session key: generatePrivateKey() -> 0xabcdef...
                                    │
                                    ▼
Per-user key derivation:  HKDF(MASTER_ENCRYPTION_KEY, userAddress)
                                    │
                                    ▼
Encrypt:  AES-256-GCM(perUserKey, sessionKeyPlaintext)
          Output: { iv: "hex", authTag: "hex", ciphertext: "hex" }
                                    │
                                    ▼
Store in Supabase:  session_keys.encrypted_key = JSONB blob
                    (Supabase NEVER sees plaintext)
                                    │
                                    ▼
On use:   Read from Supabase -> Derive per-user key -> Decrypt in memory -> Sign UserOp -> Clear from memory
```

### Security Layers

| Layer | What | Where |
|-------|------|-------|
| MASTER_ENCRYPTION_KEY | 256-bit hex (64 chars) | Backend .env ONLY |
| Per-user key derivation | HKDF(master, address) | Backend memory only |
| AES-256-GCM | Authenticated encryption | Encrypts session key |
| Supabase RLS | Row-level security | DB access scoped |
| Separate table | session_keys isolated | Stricter access policies |
| Audit logging | Every decryption logged | transaction_logs |

### Why Per-User Keys?

If one user's encrypted key leaks alongside a compromised master key, only THAT user is affected. Without per-user derivation, all session keys are compromised.

---

## 6. Rebalance Daemon Design

### Tiered Monitoring (10,000+ Users)

Not all positions need the same check frequency:

| Health Factor | Check Interval | Rationale |
|--------------|----------------|-----------|
| HF < 1.3 | Every 15 seconds | Critical — near liquidation |
| HF 1.3 - 1.5 | Every 30 seconds | Elevated risk |
| HF 1.5 - 2.0 | Every 2 minutes | Normal, monitor rate differentials |
| HF > 2.0 | Every 10 minutes | Healthy, only check for better rates |

### Batch RPC via Multicall3

```
10,000 positions / 200 per multicall = 50 RPC calls (instead of 10,000)

Each multicall:
  - getHealthFactor(position) x 200
  - Returns all 200 results in one call
  - ~200ms per multicall on Base RPC
  - Total cycle: ~10 seconds for 10,000 positions
```

### Migration Decision Engine

```
For each position, evaluate:
  1. Rate differential: |aaveAPY - morphoAPY| > MIN_RATE_DIFF (e.g., 0.5%)
  2. Net savings after fee: savings > flashloanFee + gasCost
  3. Position size: larger positions save more, prioritize them
  4. Health factor: don't migrate if HF < 1.5 (too risky)
  5. Cooldown: don't re-migrate within 24h of last migration

Priority queue: sort by net_savings DESC -> migrate highest value first
```

### Batch Migration (1,000 Users at Once)

```
BullMQ job queue:
  - Producer: daemon adds migration jobs to queue
  - Workers: 10-20 concurrent workers
  - Each worker: decrypt session key -> build UserOp -> submit to Pimlico
  - Rate limiting: respect Pimlico API limits (queue handles backpressure)
  - Retry: 3 attempts with exponential backoff
  - Dead letter queue: failed jobs for manual review
```

### Rate Caching (Redis)

```
Key: rates:{protocol}:{token}
Value: { supplyAPY, borrowAPY, collateralFactor, timestamp }
TTL: 30 seconds

Refreshed by background job every 30s:
  - Fetch Aave rates from AavePool.getReserveData()
  - Fetch Morpho rates from MorphoBlue market data
  - Write to Redis
  - Daemon reads from Redis (never direct RPC for rates)
```

---

## 7. Database Schema (Supabase)

See `supabase-schema.sql` for the complete schema. Key design decisions:

### Token Handling

- Dedicated `tokens` table with `decimals`, `symbol`, `name`, `address`
- All amounts stored as `NUMERIC` (arbitrary precision — no floating point loss)
- All amounts stored in **raw units** (wei, 6-decimal USDC) — conversion happens in application
- Token references via address (lowercase), joined when display needed

### Address Convention

- **ALL addresses stored lowercase** in every table
- Enforced by CHECK constraints: `address = lower(address)`
- Application must `toLowerCase()` before any DB operation

### Position Tracking

- Each position tracks: protocol, collateral token, debt token, amounts, health factor
- Status: `active` -> `migrating` -> `closed`
- `current_protocol` field updated on every migration
- Full history in `transaction_logs` with `tx_type = 'flashloan_migrate'`

### Querying Logs for an Address

```sql
-- All logs for a user
SELECT tl.*, t.symbol, t.decimals
FROM transaction_logs tl
JOIN tokens t ON tl.token_address = t.address
WHERE tl.user_address = '0xabc...'
ORDER BY tl.created_at DESC;

-- Migration history for a position
SELECT * FROM transaction_logs
WHERE position_id = 'uuid' AND tx_type = 'flashloan_migrate'
ORDER BY tl.created_at DESC;

-- All deposits across all protocols
SELECT tl.*, t.symbol, t.decimals
FROM transaction_logs tl
JOIN tokens t ON tl.token_address = t.address
WHERE tl.user_address = '0xabc...' AND tl.tx_type = 'deposit'
ORDER BY tl.created_at DESC;
```

---

## 8. Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` |
| Aave V3 Pool | `0xa238dd80c259a72e81d7e4664a9801593f98d1c5` |
| Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| Morpho Oracle | `0xfea2d58cefcb9fcb597723c6bae66ffe4193afe4` |
| Morpho IRM | `0x46415998764c29ab2a25cbea6254146d50d22687` |
| Safe 4337 Module | `0x7579ee8307284f293b1927136486880611f20002` |
| ERC7579 Launchpad | `0x7579011ab74c46090561ea277ba79d510c6c00ff` |

| Token | Decimals | Symbol |
|-------|----------|--------|
| WETH | 18 | WETH |
| USDC | 6 | USDC |

---

## 9. What's Already Built

### On-Chain (This Repo)

| Component | Location | Status |
|-----------|----------|--------|
| UnifiedFlashloanModule v4 | `src/module/UnifiedFlashloanModule.sol` | Done, tested |
| TargetRegistry | `src/registry/TargetRegistry.sol` | Done, tested |
| ITargetRegistry interface | `src/interfaces/ITargetRegistry.sol` | Done |
| ISafeWallet interface | `src/interfaces/ISafeWallet.sol` | Done |
| Unit tests (48) | `test/UnifiedFlashloanModuleTest.t.sol` | Passing |
| Fork tests (Base) | `test/UnifiedFlashloanModuleFork.t.sol` | Passing |
| Mock contracts | `test/mocks/` | Done |
| Create Safe script | `unified-scripts/src/create-safe.ts` | Done |
| Install Module script | `unified-scripts/src/install-module.ts` | Done |
| Swap Collateral script | `unified-scripts/src/swap-collateral.ts` | Done |

### Reference Implementations (Read-Only)

| Component | Location | Use For |
|-----------|----------|---------|
| JWT auth + nonce flow | `contango-integration/api/src/services/auth.service.ts` | Auth pattern |
| 3-step onboarding | `contango-integration/api/src/services/onboarding.service.ts` | Onboarding pattern |
| AES-256-GCM encryption | `contango-integration/api/src/services/crypto.service.ts` | Session key encryption |
| Session key executor | `contango-integration/src/looping/session-executor.ts` | UserOp signing pattern |
| Position monitor daemon | `contango-integration/api/src/services/monitor.service.ts` | Daemon pattern |
| Frontend MetaMask flow | `contango-integration/web/hooks/useAuth.ts` | Auth UI pattern |
| Frontend onboarding | `contango-integration/web/hooks/useOnboarding.ts` | Onboarding UI pattern |
| GuardedExecModule | `zyfai-executor-module/` | Already deployed on Base |

---

## 10. What Needs to Be Built

### Backend (Express + TypeScript)

```
backend/
  src/
    index.ts                         # Express server entry
    config.ts                        # Env vars, Zod validation

    db/
      supabase.ts                    # Supabase client init

    middleware/
      auth.ts                        # JWT Bearer validation

    routes/
      auth.routes.ts                 # GET /auth/nonce, POST /auth/verify
      onboarding.routes.ts           # prepare/submit for 3 steps
      vault.routes.ts                # deposit, borrow, repay, withdraw
      position.routes.ts             # position health, history, rates

    services/
      auth.service.ts                # Nonce generation + JWT issuance
      crypto.service.ts              # AES-256-GCM + HKDF per-user keys
      onboarding.service.ts          # Safe deploy + module install + session key
      vault.service.ts               # Transaction builders for vault ops
      session-executor.service.ts    # Decrypt key -> sign UserOp -> submit to Pimlico
      rebalancer.service.ts          # Migration decision engine
      monitor.service.ts             # Position health check daemon
      rate.service.ts                # Aave/Morpho rate fetcher + Redis cache
      listener.service.ts            # Blockchain event listener for deposits

    workers/
      migration.worker.ts            # BullMQ worker for batch migrations

    utils/
      multicall.ts                   # Batch RPC via multicall3
      addresses.ts                   # Contract addresses
      abis.ts                        # ABIs
```

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/auth/nonce` | No | Get nonce for EIP-191 signing |
| POST | `/auth/verify` | No | Verify signature, return JWT |
| GET | `/onboarding/status` | JWT | Check onboarding step (0-3) |
| POST | `/onboarding/deploy-safe/prepare` | JWT | Prepare Safe deploy UserOp |
| POST | `/onboarding/deploy-safe/submit` | JWT | Submit signed Safe deploy |
| POST | `/onboarding/install-module/prepare` | JWT | Prepare module install UserOp |
| POST | `/onboarding/install-module/submit` | JWT | Submit signed module install |
| POST | `/onboarding/create-session/prepare` | JWT | Prepare session key creation |
| POST | `/onboarding/create-session/submit` | JWT | Submit session key creation |
| POST | `/vault/deposit` | JWT | Supply collateral to best protocol |
| POST | `/vault/borrow` | JWT | Borrow USDC, transfer to EOA |
| POST | `/vault/repay` | JWT | Repay USDC debt |
| POST | `/vault/withdraw` | JWT | Withdraw collateral to EOA |
| GET | `/vault/position` | JWT | Current position details |
| GET | `/vault/rates` | No | Aave vs Morpho APY comparison |
| GET | `/vault/history` | JWT | All transaction logs for user |

---

## 11. Implementation Roadmap (Task by Task)

### Phase 1: Foundation (Database + Auth)

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 1.1 | Execute Supabase schema | — | Run `supabase-schema.sql`, seed tokens table |
| 1.2 | Backend scaffold | — | Express + TypeScript + Supabase client + env config |
| 1.3 | Auth service | 1.2 | Nonce generation, EIP-191 verification, JWT issuance |
| 1.4 | Auth middleware | 1.3 | JWT Bearer validation middleware |
| 1.5 | Auth routes | 1.3, 1.4 | `GET /auth/nonce`, `POST /auth/verify` |
| 1.6 | Crypto service | 1.2 | AES-256-GCM encryption + HKDF per-user key derivation |

### Phase 2: Onboarding

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 2.1 | Onboarding service — Deploy Safe | 1.5, 1.6 | Prepare/submit Safe deployment via Pimlico |
| 2.2 | Onboarding service — Install modules | 2.1 | Install GuardedExecModule + SmartSessions + UnifiedFlashloanModule |
| 2.3 | Onboarding service — Session key | 2.2, 1.6 | Generate key, encrypt, store, submit permission grant |
| 2.4 | Onboarding routes | 2.1-2.3 | All 6 prepare/submit endpoints |
| 2.5 | Session executor service | 2.3 | Decrypt session key, sign UserOp, submit to Pimlico |

### Phase 3: Vault Operations

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 3.1 | Vault service — Deposit | 2.5 | Build supply tx, execute via session key, log to DB |
| 3.2 | Vault service — Borrow | 2.5 | Build borrow+transfer tx, execute, log |
| 3.3 | Vault service — Repay | 2.5 | Build approve+repay tx, execute, log |
| 3.4 | Vault service — Withdraw | 2.5 | Build withdraw tx, execute, log |
| 3.5 | Vault routes | 3.1-3.4 | All vault endpoints |
| 3.6 | Position routes | 3.1 | Position details, history, rates |

### Phase 4: Monitoring & Rebalancing

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 4.1 | Rate service | 1.2 | Fetch Aave/Morpho rates, cache in Redis |
| 4.2 | Multicall utility | 1.2 | Batch RPC calls via multicall3 |
| 4.3 | Monitor service | 4.1, 4.2 | Tiered health check daemon, update positions |
| 4.4 | Rebalancer service | 4.3, 2.5 | Migration decision engine, trigger flashloan swaps |
| 4.5 | BullMQ migration worker | 4.4 | Concurrent workers for batch migrations |
| 4.6 | Blockchain listener | 1.2 | Detect WETH deposits to Safe addresses |

### Phase 5: Frontend Integration

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 5.1 | Auth hook (MetaMask) | 1.5 | useAuth — nonce + sign + JWT (follow Contango web/) |
| 5.2 | Onboarding wizard | 2.4 | useOnboarding — 3-step stepper with MetaMask signing |
| 5.3 | Vault dashboard | 3.5, 3.6 | Deposit/borrow/repay/withdraw UI + position display |
| 5.4 | Transaction history | 3.6 | Log viewer with filters |

### Phase 6: Production Hardening

| # | Task | Depends On | Description |
|---|------|-----------|-------------|
| 6.1 | Error handling + retries | All | Graceful failures, dead letter queue |
| 6.2 | Rate limiting | All | API rate limits, bundler rate limits |
| 6.3 | Alerting | 4.3 | Health factor alerts, failed migration alerts |
| 6.4 | Key rotation | 1.6 | Master key rotation without re-deploying session keys |
| 6.5 | Load testing | All | Simulate 10,000 users |

---

## 12. How to Move From Task to Task

1. **Always complete the current phase before starting the next** — Phase 1 must be solid before Phase 2
2. **Test each service in isolation** before integrating — write a quick test script
3. **Reference contango-integration** for every service — the patterns are proven
4. **After each task**: update position in this doc, commit, test
5. **Start each session** by reading this file + CLAUDE.md to restore context
6. **When stuck**: check contango-integration reference for the equivalent service

### Development Commands

```bash
# Solidity (existing)
forge build
forge test -v
forge test --match-test test_Name -vv

# Backend (to be created)
cd backend && yarn install
yarn dev                    # Start Express dev server
yarn test                   # Run tests

# TypeScript scripts (existing)
cd unified-scripts && yarn install
yarn create-safe
yarn install-module
yarn swap-collateral
```

---

## 13. Environment Variables Needed

```env
# Existing (on-chain scripts)
PRIVATE_KEY=0x...
BASE_RPC_URL=https://...
BASESCAN_API_KEY=...
SAFE_ACCOUNT_ADDRESS=0x...
UNIFIED_MODULE_ADDRESS=0x...
PIMLICO_API_KEY=...

# New (backend)
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...        # Service role key (NOT anon key)
JWT_SECRET=...                      # 256-bit random for JWT signing
MASTER_ENCRYPTION_KEY=...           # 64-char hex for AES-256-GCM
REDIS_URL=redis://localhost:6379    # For rate caching + BullMQ
GUARDED_EXEC_MODULE_ADDRESS=0x...   # Deployed GuardedExecModule
TARGET_REGISTRY_ADDRESS=0x...       # Deployed TargetRegistry
MONITOR_INTERVAL_MS=60000           # Daemon check interval
MIN_RATE_DIFF=50                    # Minimum APY diff in basis points to trigger migration
```
