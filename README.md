# FlashloanModule

ERC-7579 executor module for Safe smart wallets that enables atomic flashloan-based collateral swaps between DeFi lending protocols (Aave V3, Morpho Blue) on Base.

## Deployed Contracts (Base Mainnet)

| Contract | Address |
|----------|---------|
| GuardedExecModule | `0x2AbE0155cfeE2831db3F8a294Dd0825059e07689` |
| UnifiedFlashloanModule (proxy) | `0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927` |
| UnifiedFlashloanModule (implementation) | `0x0f27999D99e9ffe2387e31F8344A7FAbf5FAe739` |
| TargetRegistry | `0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8` |

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

script/
  Deploy.s.sol                 # Deploy TargetRegistry + Module (impl + proxy)
  SetupWhitelist.s.sol         # Whitelist all selectors in TargetRegistry

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
    install-guarded-module.ts  # Install GuardedExecModule (executor)
    install-unified-module.ts  # Install UnifiedFlashloanModule (executor)
    install-smart-sessions.ts  # Install SmartSessions (validator)
    install-all-modules.ts     # Install all 3 modules at once
    deposit-weth.ts            # Deposit WETH as collateral on Aave
    borrow-usdc.ts             # Borrow USDC from Aave, transfer to EOA
    check-position.ts          # View Safe balances + Aave position
    swap-collateral.ts         # Aave -> Morpho collateral swap via flashloan

backend/                       # Express + TypeScript API server
  src/
    index.ts                   # Server entry
    config/                    # Env validation, contract addresses
    db/supabase.ts             # Supabase client + CRUD operations
    middleware/auth.ts          # JWT Bearer middleware
    routes/                    # Auth, onboarding, vault, position routes
    services/                  # Auth, crypto, onboarding, vault, monitor, session executor
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

## Deploy Contracts

```bash
# Dry run (simulate, no real tx)
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://base-mainnet.g.alchemy.com/v2/<KEY> \
  --private-key <PK> \
  -vvvv

# Deploy for real
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url https://base-mainnet.g.alchemy.com/v2/<KEY> \
  --private-key <PK> \
  --broadcast \
  -vvvv
```

### Verify Contracts

```bash
# Verify UnifiedFlashloanModule implementation (no constructor args)
forge verify-contract <IMPL_ADDRESS> \
  src/module/UnifiedFlashloanModule.sol:UnifiedFlashloanModule \
  --chain base \
  --etherscan-api-key <BASESCAN_API_KEY>

# Verify TargetRegistry (has constructor arg: owner address)
forge verify-contract <REGISTRY_ADDRESS> \
  src/registry/TargetRegistry.sol:TargetRegistry \
  --chain base \
  --constructor-args <ABI_ENCODED_OWNER> \
  --etherscan-api-key <BASESCAN_API_KEY>
```

### Setup TargetRegistry Whitelist

After deploying, set `UNIFIED_MODULE_ADDRESS` and `TARGET_REGISTRY_ADDRESS` in `.env`, then:

```bash
forge script script/SetupWhitelist.s.sol:SetupWhitelistScript \
  --rpc-url https://base-mainnet.g.alchemy.com/v2/<KEY> \
  --private-key <PK> \
  --broadcast \
  -vvvv
```

This whitelists 9 target+selector pairs: USDC.approve, WETH.approve, Aave supply/borrow/repay/withdraw, Morpho supplyCollateral/borrow, Module.initiateFlashloan.

## TypeScript Scripts

```bash
cd unified-scripts && yarn install
```

### Safe & Module Setup

```bash
# Step 1: Deploy a Safe smart account
yarn create-safe

# Step 2: Install modules (run individually)
yarn install-guarded-module      # GuardedExecModule (executor, type 2)
yarn install-unified-module      # UnifiedFlashloanModule (executor, type 2)
yarn install-smart-sessions      # SmartSessions (validator, type 1) — needed for session keys

# Or install all 3 at once
yarn install-all-modules
```

### Vault Operations

```bash
# Check Safe balances + Aave position
yarn check-position

# Deposit WETH as collateral on Aave V3
yarn deposit-weth                        # Deposit all WETH in Safe
yarn deposit-weth -- --amount 0.01       # Deposit specific amount

# Borrow USDC from Aave (transferred to your EOA)
yarn borrow-usdc -- --amount 100         # Borrow 100 USDC
yarn borrow-usdc -- --amount 0.001       # Borrow 0.001 USDC (small test)

# Swap collateral from Aave -> Morpho via flashloan
yarn swap-collateral
```

### Required .env (root)

```env
PRIVATE_KEY=0x...
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<KEY>
BASESCAN_API_KEY=...
PIMLICO_API_KEY=...
SAFE_ACCOUNT_ADDRESS=0x...                          # After create-safe
GUARDED_EXEC_MODULE_ADDRESS=0x2AbE0155cfeE2831db3F8a294Dd0825059e07689
UNIFIED_MODULE_ADDRESS=0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927
UNIFIED_MODULE_IMPLEMENTATION_ADDRESS=0x0f27999D99e9ffe2387e31F8344A7FAbf5FAe739
TARGET_REGISTRY_ADDRESS=0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8
```

## Backend API

```bash
cd backend && yarn install
cp .env.example .env    # Fill in Supabase, JWT, encryption keys
yarn dev                # Start dev server (port 3001)
yarn lint               # Type-check
```

### Backend .env

```env
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...              # Service role key (NOT anon)
JWT_SECRET=<openssl rand -base64 32>
MASTER_ENCRYPTION_KEY=<openssl rand -hex 32>
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<KEY>
PIMLICO_API_KEY=...
UNIFIED_MODULE_ADDRESS=0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927
GUARDED_EXEC_MODULE_ADDRESS=0x2AbE0155cfeE2831db3F8a294Dd0825059e07689
TARGET_REGISTRY_ADDRESS=0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8
PORT=3001
ALLOWED_ORIGINS=http://localhost:3000
LOG_LEVEL=info
```

### API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Health check |
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
| GET | `/positions` | JWT | All active positions |
| GET | `/positions/history` | JWT | Transaction log history |

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

1. **Session key + SmartSessions** — Validator authorizes the UserOp (scoped key)
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
| GuardedExecModule | `0x2AbE0155cfeE2831db3F8a294Dd0825059e07689` |
| UnifiedFlashloanModule (proxy) | `0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927` |
| UnifiedFlashloanModule (impl) | `0x0f27999D99e9ffe2387e31F8344A7FAbf5FAe739` |
| TargetRegistry | `0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8` |

## Conventions

- **Target chain**: Base mainnet (chain ID 8453)
- **Solidity**: 0.8.24, EVM target Cancun, via-ir enabled
- **Proxy**: UUPS (ERC1967Proxy) — interact with proxy, never implementation
- **Storage**: ERC-7201 namespaced storage
- **Test naming**: `test_<Description>` for success, `test_RevertWhen_<Description>` for reverts
- **Package manager**: Yarn for TypeScript
- **Database**: Supabase (PostgreSQL) — schema in `supabase-schema.sql`
- **Session key encryption**: AES-256-GCM + HKDF per-user key derivation
