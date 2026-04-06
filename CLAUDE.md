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
```

## Architecture

### Core Contracts (src/)

**UnifiedFlashloanModule** (`src/module/UnifiedFlashloanModule.sol`) — ERC-7579 executor module (type 2) installed on Safe smart wallets. Borrows tokens from Morpho Blue (0% fee) or Aave V3 (0.05% fee), executes a batch of operations on the Safe via `executeFromExecutor`, then repays. UUPS upgradeable with ERC-7201 namespaced storage. Entry point: `initiateFlashloan(provider, token, amount, executions)`.

**TargetRegistry** (`src/registry/TargetRegistry.sol`) — Whitelist of `target + selector` pairs. Every execution inside a flashloan callback is validated against this registry. Also manages allowed ERC20 token recipients. Owner-managed via `addToWhitelist`/`removeFromWhitelist`.

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

## Product Context

DeFi yield optimization platform on Base. Users deposit collateral (WETH), borrow stablecoins (USDC), and the backend autonomously rebalances positions across Aave/Morpho for best APY using flashloan-based collateral swaps.

**User flow**: Deposit WETH -> Borrow USDC (transferred to user's EOA) -> Backend monitors rates -> Auto-rebalance via flashloan swaps -> User repays USDC -> Withdraw WETH.

**Backend (planned)**: Express + SQLite + Viem + Permissionless.js. JWT auth via EIP-191 nonce signing. 3-step onboarding: Deploy Safe -> Install modules (GuardedExecModule + SmartSessions + UnifiedFlashloanModule) -> Create session key. Session key enables server-side autonomous operations without user signatures.
