# When to Migrate — Position Migration Guide

## What is Migration?

Your position (WETH collateral + USDC debt) lives on one DeFi protocol at a time — either **Aave V3** or **Morpho Blue**. Both protocols offer the same service but at **different interest rates that change constantly**.

Migration moves your entire position from one protocol to another in a single atomic transaction using a flashloan. No manual steps, no downtime, no risk of partial moves.

## Why Migrate?

To save money. You want to be on whichever protocol charges you less.

### Example

Your position is currently on **Aave**:
- You **earn** 1.71% APY on your WETH collateral (supply rate)
- You **pay** 3.92% APY on your USDC debt (borrow rate)
- **Net cost = 3.92% - 1.71% = 2.21% per year you're paying**

Meanwhile, **Morpho** is currently offering:
- You **earn** 2.50% APY on WETH
- You **pay** 2.80% APY on USDC
- **Net cost = 2.80% - 2.50% = 0.30% per year you're paying**

Morpho is **1.91% cheaper per year**. On a $10,000 position, that's **$191/year saved**.

So the system migrates your position from Aave to Morpho automatically.

A week later, rates shift. Aave is now cheaper. The system migrates back. You always pay the least.

## Migration Criteria (Decision Rules)

```
IF   target protocol net cost is cheaper by > 0.5% (50 basis points)
AND  health factor > 1.5 (position is safe enough to move)
AND  last migration was > 1 hour ago (prevent ping-ponging)
THEN migrate to the cheaper protocol
```

### Why each rule exists:

| Rule | Reason |
|------|--------|
| Rate difference > 0.5% | Small differences aren't worth the gas cost of migrating |
| Health factor > 1.5 | Low HF means you're close to liquidation — don't touch the position |
| 1-hour cooldown | Rates fluctuate — wait for sustained improvement, not momentary blips |

## How Migration Works (Under the Hood)

### Aave to Morpho (6 steps, 1 transaction)

```
1. Flashloan USDC from Morpho (0% fee)
2. Repay all USDC debt on Aave
3. Withdraw all WETH collateral from Aave
4. Supply WETH collateral to Morpho
5. Borrow USDC from Morpho (to repay flashloan)
6. Flashloan repaid — done
```

### Morpho to Aave (6 steps, 1 transaction)

```
1. Flashloan USDC from Morpho (0% fee)
2. Repay all USDC debt on Morpho
3. Withdraw all WETH collateral from Morpho
4. Supply WETH collateral to Aave
5. Borrow USDC from Aave (to repay flashloan)
6. Flashloan repaid — done
```

All 6 steps happen atomically — if any step fails, the entire transaction reverts and nothing changes.

## Current Implementation Status

| Component | Status |
|-----------|--------|
| Aave to Morpho migration | Built and working |
| Morpho to Aave migration | Built and working |
| Manual trigger (`POST /vault/migrate`) | Built and working |
| Frontend "Migrate" button | Built and working |
| Migration preflight diagnostics | Built and working |
| Fetching live rates from Aave and Morpho | Not built yet |
| Auto-comparing rates on each monitor cycle | Not built yet |
| Auto-triggering migration when criteria met | Not built yet |

## What's Next

To enable fully automatic migration:

1. **Rate Service** — Fetch real-time supply/borrow APY from both Aave (on-chain `getReserveData`) and Morpho (API or on-chain)
2. **Rate Comparison** — On each monitor cycle (every 60s), compare net rates
3. **Auto-Trigger** — When criteria are met, call `migratePosition()` automatically
4. **Redis Cache** — Cache rates to avoid redundant RPC calls across users
5. **Notifications** — Alert users when their position is migrated

## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| Aave V3 Pool | `0xa238dd80c259a72e81d7e4664a9801593f98d1c5` |
| Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| UnifiedFlashloanModule | `0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927` |
| TargetRegistry | `0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8` |
