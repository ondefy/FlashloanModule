# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Key Project Files

- `PROJECT-PLAN.md` — Full architecture, flows, objectives, what's built, what's next, implementation roadmap
- `supabase-schema.sql` — Complete database schema for Supabase (execute in SQL editor)
- `contango-integration/` — Reference implementation (JWT auth, onboarding, session keys, monitoring)
- `zyfai-executor-module/` — Reference for GuardedExecModule + TargetRegistry (already deployed)

## Build & Test Commands

```bash
# Build contracts (Solidity 0.8.24, Cancun EVM, via-ir enabled)
forge build

# Unit tests (fast, no network dependency)
forge test --match-contract UnifiedFlashloanModuleTest -v

# Fork tests (Base mainnet, requires BASE_RPC_URL or uses public RPC)
forge test --match-contract UnifiedFlashloanModuleForkTest -vv

# All tests
forge test -v

# Single test by name
forge test --match-test test_MorphoFlashloan_Success -vv

# TypeScript scripts (unified-scripts/)
cd unified-scripts && yarn install
yarn create-safe        # Deploy Safe smart account
yarn install-module     # Install module as executor on Safe
yarn swap-collateral    # Execute Aave -> Morpho collateral swap

# Backend (Express + TypeScript)
cd backend && yarn install
yarn dev                # Start dev server with hot reload (port 3001)
yarn start              # Start production server
yarn lint               # Type-check (tsc --noEmit)
```

## Architecture

### Core Contracts (src/)

**UnifiedFlashloanModule** (`src/module/UnifiedFlashloanModule.sol`) — ERC-7579 executor module (type 2) installed on Safe smart wallets. Borrows tokens from Morpho Blue (0% fee) or Aave V3 (0.05% fee), executes a batch of operations on the Safe via `executeFromExecutor`, then repays. UUPS upgradeable with ERC-7201 namespaced storage. Entry point: `initiateFlashloan(provider, token, amount, executions)`.

**TargetRegistry** (`src/registry/TargetRegistry.sol`) — Whitelist of `target + selector` pairs. Every execution inside a flashloan callback is validated against this registry. Also manages allowed ERC20 token recipients. Owner-managed via `addToWhitelist`/`removeFromWhitelist`. Pausable for emergency stops. Two-step ownership transfer.

### Security Model (3 layers)

1. **Session key** — SmartSessions validator authorizes the UserOp
2. **GuardedExecModule** (from zyfai-executor-module) — Validates `initiateFlashloan` selector against TargetRegistry before execution
3. **TargetRegistry** — Validates every inner execution's target+selector inside the flashloan callback

No per-operation signatures. Registry whitelist + session key chain provides security.

### Transaction Flow

```
Safe -> GuardedExecModule -> TargetRegistry (whitelist check) -> UnifiedFlashloanModule.initiateFlashloan
  -> Morpho/Aave sends tokens to Module
  -> Callback: validate executions, transfer tokens to Safe, execute batch, pull tokens back, repay
```

### Backend (backend/)

Express + TypeScript server. Uses Supabase (PostgreSQL) for persistence, Viem for chain interaction, Pimlico for ERC-4337 bundling.

**API Routes:**
- `GET /health` — Health check
- `POST /api/v2/auth/secure` — SIWE login, returns JWT (30-day expiry)
- `GET /api/v2/auth/status` — Auth health check
- `GET /onboarding/status` — Check onboarding progress (steps 0-3)
- `POST /onboarding/deploy-safe/{prepare,submit}` — Safe deployment (EIP-712 sign flow)
- `POST /onboarding/install-module/{prepare,submit}` — Module installation (one module per UserOp)
- `POST /onboarding/create-session/{prepare,submit}` — Session key creation
- `POST /onboarding/register-safe` — Register existing Safe (skip deploy)
- `POST /vault/{deposit,borrow,repay,withdraw}` — Vault operations
- `GET /vault/position` — Current position details
- `GET /positions/` — All active positions
- `GET /positions/history` — Transaction logs (paginated, max 200)

**Service layer** (`backend/src/services/`): auth, onboarding, vault, crypto (AES-256-GCM encryption), session-executor, monitor (health factor daemon).

**Auth flow:** Frontend signs SIWE message → `POST /api/v2/auth/secure` verifies (EOA via ecrecover or EIP-1271 for smart wallets) → JWT issued → subsequent requests use `Authorization: Bearer <token>`. `DEFI_API_JWT_SECRET` must match the old backend's secret for token compatibility.

**Onboarding (3 steps, each uses prepare/submit pattern):**
1. Deploy Safe smart wallet via ERC-4337 UserOp
2. Install modules (GuardedExecModule + UnifiedFlashloanModule + SmartSessions) — one per UserOp, frontend loops
3. Create session key — backend generates ephemeral key, encrypts with AES-256-GCM (HKDF per-user key from `MASTER_ENCRYPTION_KEY`), stores in Supabase

### Reference Implementations (read-only)

- `contango-integration/` — Full backend+frontend reference with JWT auth, Safe deployment, module installation, session key management, and position monitoring. Uses GuardedExecModule only (no flashloans — Contango's Maestro handles those internally).
- `zyfai-executor-module/` — Audited GuardedExecModule + TargetRegistry. Already deployed on Base.

Key difference from Contango: we use GuardedExecModule + UnifiedFlashloanModule (our module handles flashloans directly) and removed ERC-1271 signatures in favor of TargetRegistry-only validation.

### TypeScript Scripts (unified-scripts/)

Uses viem + permissionless.js + Pimlico bundler for ERC-4337 UserOps. Setup in `setup.ts` creates Safe account with OwnableValidator. `swap-collateral.ts` demonstrates the full 6-step atomic collateral swap (repay Aave debt, withdraw collateral, supply to Morpho, borrow to repay flashloan).

## Conventions

- **Target chain**: Base mainnet (chain ID 8453)
- **Solidity**: 0.8.24, Cancun EVM, via-ir, optimizer 200 runs
- **Proxy pattern**: UUPS (ERC1967Proxy) — always interact with proxy, never implementation
- **Storage**: ERC-7201 namespaced storage pattern
- **Test naming**: `test_<Description>` for success, `test_RevertWhen_<Description>` for reverts
- **Package manager**: Yarn for TypeScript
- **Dependencies**: forge-std, openzeppelin-contracts (via git submodules)
- **Address storage**: ALL addresses stored lowercase in Supabase, enforced by CHECK constraints. Always call `.toLowerCase()` before DB operations.
- **Amount storage**: Stored as `NUMERIC` in raw units (wei/smallest unit). Conversion to display units in application layer only.

## Key Environment Variables

Contract addresses for `UNIFIED_MODULE_ADDRESS`, `GUARDED_EXEC_MODULE_ADDRESS`, and `TARGET_REGISTRY_ADDRESS` must be set in `.env` — these are deployment-specific. See `.env.example` (root for Foundry, `backend/.env.example` for backend).

Backend requires: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role, not anon), `DEFI_API_JWT_SECRET`, `MASTER_ENCRYPTION_KEY` (64-char hex for AES-256-GCM), `BASE_RPC_URL`, `PIMLICO_API_KEY`.

## Non-Obvious Patterns

- **Pending ops store**: `onboarding.service.ts` keeps in-memory map of pending UserOps with 5-minute TTL, cleaned on each prepare call
- **Stub owner pattern**: During onboarding, a stub account object throws on signing, forcing MetaMask to sign instead
- **Module install loop**: Only one module installed per UserOp to avoid encoding issues; frontend calls prepare/submit multiple times
- **Per-user encryption**: HKDF derivation from master key ensures single-key compromise doesn't expose all users
- **Tiered health monitoring**: Check intervals scale with risk — 15s (HF < 1.3), 30s (1.3-1.5), 2min (1.5-2.0), 10min (> 2.0)
- **Morpho partial support**: Deposit works, repay/withdraw marked TODO (Aave fully implemented)

## Product Context

DeFi yield optimization platform on Base. Users deposit collateral (WETH), borrow stablecoins (USDC), and the backend autonomously rebalances positions across Aave/Morpho for best APY using flashloan-based collateral swaps.

**User flow**: Deposit WETH -> Borrow USDC (transferred to user's EOA) -> Backend monitors rates -> Auto-rebalance via flashloan swaps -> User repays USDC -> Withdraw WETH.

**Not yet built**: Rate service (Aave/Morpho rate fetching + Redis caching), rebalancer service (migration decision engine), BullMQ worker (batch processing), blockchain event listener (WETH deposit detection), frontend (Next.js).
