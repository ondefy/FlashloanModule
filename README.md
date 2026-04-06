# FlashloanModule

ERC-7579 executor module for Safe smart wallets that enables atomic flashloan-based collateral swaps between DeFi lending protocols (Aave V3, Morpho Blue) on Base.

## Repository Structure

```
src/
  interfaces/
    ITargetRegistry.sol        # Whitelist interface
    ISafeWallet.sol            # Safe wallet interface (used by registry)
  module/
    UnifiedFlashloanModule.sol # Production module (v4)
  registry/
    TargetRegistry.sol         # Target+selector whitelist

test/
  mocks/                       # MockAavePool, MockMorphoBlue, MockERC20, MockSmartAccount, MockTargetRegistry
  UnifiedFlashloanModuleTest.t.sol   # Unit tests (48 tests, no network)
  UnifiedFlashloanModuleFork.t.sol   # Fork tests (Base mainnet)

unified-scripts/               # TypeScript scripts for on-chain operations
  src/
    constants.ts               # Addresses, market params, enums
    abis.ts                    # All ABIs
    setup.ts                   # Shared client setup (Safe, Pimlico, viem)
    create-safe.ts             # Deploy Safe smart account
    install-module.ts          # Install module as executor on Safe
    swap-collateral.ts         # Execute Aave->Morpho collateral swap via flashloan
```

## Build & Test

```bash
# Build contracts (Solidity 0.8.24, Cancun EVM, via-ir)
forge build

# Run unit tests (fast, no network)
forge test --match-contract UnifiedFlashloanModuleTest -v

# Run fork tests (Base mainnet — uses public RPC or BASE_RPC_URL env)
forge test --match-contract UnifiedFlashloanModuleForkTest -vv

# Run all tests
forge test -v

# Run a single test by name
forge test --match-test test_MorphoFlashloan_Success -vv
```

## TypeScript Scripts

```bash
cd unified-scripts && yarn install

# Step 1: Deploy a Safe smart account
yarn create-safe

# Step 2: Install UnifiedFlashloanModule as executor on Safe
yarn install-module

# Step 3: Execute Aave -> Morpho collateral swap via flashloan
yarn swap-collateral
```

### Required .env

```env
PRIVATE_KEY=0x...              # Owner private key
BASE_RPC_URL=https://...       # Base RPC endpoint
PIMLICO_API_KEY=...            # Pimlico bundler/paymaster API key
SAFE_ACCOUNT_ADDRESS=0x...     # After create-safe
UNIFIED_MODULE_ADDRESS=0x...   # Deployed module proxy address
```

## UnifiedFlashloanModule v4

### What it does

Enables Safe smart wallets to execute atomic flashloan operations. The module borrows tokens from Morpho Blue (0% fee) or Aave V3 (0.05% fee), executes a batch of arbitrary operations on the Safe, then pulls tokens back to repay the flashloan — all in a single transaction.

### How it works

```
Safe calls initiateFlashloan(provider, token, amount, executions)
  -> Module requests flashloan from Morpho/Aave
  -> Provider sends tokens to Module
  -> Callback fires:
     1. Validate every execution against TargetRegistry whitelist
     2. Transfer tokens to Safe
     3. Execute batch on Safe via executeFromExecutor
     4. Pull tokens back from Safe to Module
     5. Approve repayment to provider
```

### Security model

No per-operation signatures. Security relies on three layers:

1. **Session key** — SmartSessions validator authorizes the UserOp
2. **GuardedExecModule** — Validates `initiateFlashloan` selector against TargetRegistry
3. **TargetRegistry** — Validates every inner execution's target+selector inside the callback

Registry is mandatory. Module reverts with `RegistryNotSet` if registry is `address(0)`.

### Key design decisions

- **No signatures** — Removed ERC-1271 signature verification. The TargetRegistry whitelist + session key authorization chain provides equivalent security without the complexity of flashloan hash signing.
- **Registry required** — Unlike v3 where registry was optional, v4 always requires a registry. This prevents the module from being used without a whitelist.
- **Protocol-agnostic** — Inner executions can call any contract/function as long as it's whitelisted. Works with Aave, Morpho, Moonwell, Compound, or any protocol.
- **Dual provider** — Morpho Blue (0% fee, preferred) and Aave V3 (0.05% fee, fallback).

### Flashloan execution flow (6-step collateral swap: Aave -> Morpho)

1. Approve flashloaned USDC to Aave
2. Repay all Aave USDC debt
3. Withdraw all WETH collateral from Aave
4. Approve WETH to Morpho Blue
5. Supply WETH as collateral on Morpho Blue
6. Borrow USDC from Morpho Blue to repay flashloan

When using Aave flashloans, step 6 borrows `flashAmount + premium` to cover the Aave fee.

## Product Objective

### What we're building

A DeFi yield optimization platform where users deposit collateral, borrow stablecoins, and we automatically rebalance their positions across lending protocols for the best APY.

### User flow

1. **Deposit** — User deposits ETH/WETH into their Safe smart wallet, which gets supplied as collateral on Aave or Morpho
2. **Borrow** — User borrows USDC via the Safe, which gets transferred to their EOA (they keep it, spend it however they want)
3. **Rebalance** — Backend daemon monitors rates and autonomously moves collateral between Aave/Morpho using flashloan swaps for better APY
4. **Repay** — User sends USDC to the Safe, backend builds approve+repay batch transaction
5. **Withdraw** — After repaying debt, user withdraws collateral from whichever protocol currently holds it

### Architecture

**Frontend** (already exists) — User-facing dApp for deposit/borrow/repay/withdraw actions

**Backend** (to be built) — Express + SQLite + Viem + Permissionless.js
- JWT auth (nonce-based EIP-191 sign, same pattern as contango-integration)
- 3-step onboarding: Deploy Safe -> Install modules -> Create session key
- Vault operations API: deposit, borrow, repay, withdraw
- Background rebalancer daemon

**On-chain** (this repo) — UnifiedFlashloanModule + TargetRegistry + Safe smart wallets

### Backend architecture (planned)

```
backend/
  src/
    index.ts                    # Express server
    db/database.ts              # SQLite (users, positions)
    middleware/auth.ts           # JWT Bearer auth
    routes/
      auth.routes.ts            # Nonce -> sign -> JWT
      onboarding.routes.ts      # Safe deploy + module install + session key
      vault.routes.ts           # Deposit / Borrow / Repay / Withdraw
      position.routes.ts        # Position health, balances
    services/
      auth.service.ts           # Nonce + JWT
      crypto.service.ts         # AES-256-GCM for session keys
      onboarding.service.ts     # Safe + modules + session key
      vault.service.ts          # Transaction builders for vault ops
      rebalancer.service.ts     # Flashloan-based collateral swap
      monitor.service.ts        # Rate monitor + health check daemon
```

### API endpoints (planned)

| Endpoint | Auth | Description |
|----------|------|-------------|
| `GET /auth/nonce` | No | Get nonce for EIP-191 signing |
| `POST /auth/verify` | No | Verify signature, return JWT |
| `GET /onboarding/status` | JWT | Check onboarding step (0-3) |
| `POST /onboarding/deploy-safe/prepare` | JWT | Prepare Safe deploy UserOp |
| `POST /onboarding/deploy-safe/submit` | JWT | Submit signed Safe deploy |
| `POST /onboarding/install-module/prepare` | JWT | Prepare module install UserOp |
| `POST /onboarding/install-module/submit` | JWT | Submit signed module install |
| `POST /onboarding/create-session/prepare` | JWT | Prepare session key creation |
| `POST /onboarding/create-session/submit` | JWT | Submit session key creation |
| `POST /vault/deposit` | JWT | Deposit WETH -> Safe -> supply to protocol |
| `POST /vault/borrow` | JWT | Borrow USDC via Safe -> transfer to EOA |
| `POST /vault/repay` | JWT | Approve + repay USDC debt |
| `POST /vault/withdraw` | JWT | Withdraw collateral to EOA |
| `GET /vault/position` | JWT | Current collateral, debt, rates, protocol |
| `GET /vault/rates` | No | Aave vs Morpho APY comparison |

### Onboarding (3-step, prepare/submit pattern)

1. **Deploy Safe** — ERC-4337 UserOp, user signs EIP-712 typed data from frontend
2. **Install modules** — GuardedExecModule (executor) + SmartSessions (validator) + UnifiedFlashloanModule (executor)
3. **Create session key** — Server generates key, user signs permission hash, key encrypted in DB with AES-256-GCM

After onboarding, the server signs all vault operations with the session key. No frontend signature needed for deposit/borrow/repay/withdraw.

### Session key and rebalancing

Session key is used for autonomous rebalancing:

```
Session Key signs UserOp
  -> SmartSessions validates
  -> GuardedExecModule.executeGuardedBatch([
       { target: UnifiedFlashloanModule, callData: initiateFlashloan(...) }
     ])
  -> TargetRegistry validates initiateFlashloan selector
  -> UnifiedFlashloanModule triggers flashloan
  -> Callback validates all inner executions against TargetRegistry
  -> Atomic collateral swap completes
```

Session key is NOT a Safe owner. It's scoped via SmartSessions policies:
- `userOpPolicies` — Controls which UserOps the key can sign
- `actions` — Restricts to GuardedExecModule + `executeGuardedBatch` selector
- `erc1271Policies` — Can be configured with `getUsageLimitPolicy` + `getTimeFramePolicy` for bounded ERC-1271 signing if needed later

### TargetRegistry whitelist

All selectors that the module can execute must be whitelisted:

```
# ERC20 operations
USDC.approve
WETH.approve

# Aave operations
AavePool.supply
AavePool.borrow
AavePool.repay
AavePool.withdraw

# Morpho operations
MorphoBlue.supplyCollateral
MorphoBlue.borrow

# Module entry point (for GuardedExecModule)
UnifiedFlashloanModule.initiateFlashloan
```

### Reference implementation

The contango-integration (separate repo) contains a working reference with:
- JWT auth flow (nonce -> EIP-191 sign -> JWT)
- 3-step onboarding (Safe deploy, module install, session key)
- Session key executor (server-side UserOp signing)
- Position monitoring daemon
- SQLite database with encrypted session key storage (AES-256-GCM)
- Pimlico bundler + Permissionless.js for ERC-4337

Key differences from contango-integration:
- Contango uses GuardedExecModule only (no flashloans) — Contango's Maestro handles flashloans internally
- We use GuardedExecModule + UnifiedFlashloanModule — our module handles flashloans directly
- Contango requires ERC-1271 signatures — we removed them in favor of TargetRegistry-only validation

### Vault operation transaction batches

**Deposit** (user sends ETH/WETH to Safe first):
```
[WETH.deposit() (if ETH), WETH.approve(pool), pool.supply(WETH)]
```

**Borrow**:
```
[pool.borrow(USDC), USDC.transfer(userEOA)]
```

**Repay** (user sends USDC to Safe first):
```
[USDC.approve(pool), pool.repay(USDC)]
```

**Withdraw**:
```
[pool.withdraw(WETH, userEOA)]
```

## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Aave V3 Pool | `0xA238Dd80C259a72e81d7e4664a9801593F98d1c5` |
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` |
| Morpho Oracle | `0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4` |
| Morpho IRM | `0x46415998764C29aB2a25CbeA6254146D50D22687` |
| Morpho USDC/WETH LLTV | `0.86e18` |

## Conventions

- **Target chain**: Base mainnet (chain ID 8453)
- **Solidity**: 0.8.24, EVM target Cancun, via-ir enabled
- **Proxy**: UUPS (ERC1967Proxy) — interact with proxy, never implementation
- **Storage**: ERC-7201 namespaced storage
- **Test naming**: `test_<Description>` for success, `test_RevertWhen_<Description>` for reverts
- **Package manager**: Yarn for TypeScript
