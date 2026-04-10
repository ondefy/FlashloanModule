# Rebalance Algorithm

## How We Decide When to Migrate

Your position has two parts:
- **WETH collateral** — earns interest on Aave, earns **nothing** on Morpho
- **USDC debt** — you pay interest on both protocols

The system checks every 60 seconds: would you save money on the other protocol? If yes, it migrates automatically.

## The Key Insight

**You can't just compare borrow rates.** You also need to count what your collateral earns.

On Aave, your WETH collateral earns supply APY (currently ~1.71%). On Morpho, your WETH collateral earns **0%** — it just sits there as security.

So the real cost on each protocol is:

```
Net cost = What you pay on debt − What you earn on collateral
```

Both amounts must be in **dollars**, because WETH and USDC have different values.

## The Formula

```
Collateral value in USD = WETH amount × ETH price
Debt value in USD       = USDC amount

Yearly earnings = Collateral USD × collateral supply rate
Yearly cost     = Debt USD × borrow rate

Net cost = Yearly cost − Yearly earnings
```

Calculate this for both protocols. Whichever has the lower net cost is cheaper.

## Example: Current Rates (April 10, 2026)

|  | Aave V3 | Morpho Blue |
|--|---------|-------------|
| Collateral supply rate (WETH) | 1.71% | 0% |
| Borrow rate (USDC) | 3.89% | 4.81% |

**Position:** 5 WETH ($10,962), 5,000 USDC debt

### On Aave:
- Earning: $10,962 × 1.71% = **$187/year** from collateral
- Paying: $5,000 × 3.89% = **$195/year** on debt
- **Net cost: $8/year**

### On Morpho:
- Earning: $10,962 × 0% = **$0/year** from collateral
- Paying: $5,000 × 4.81% = **$241/year** on debt
- **Net cost: $241/year**

**Aave is $233/year cheaper.** The collateral earnings ($187/year) nearly wipe out the entire borrow cost.

## When Does Morpho Win?

Morpho wins when Aave's borrow rate spikes high enough to overcome the collateral earnings advantage. This happens during volatile markets.

**Example:** Aave borrow rate jumps to 12%, supply drops to 0.3%. Morpho stays at 4.81%.

Same position (1 WETH, 1,700 USDC debt):

| | Aave (spiked) | Morpho |
|--|---------------|--------|
| Earning from collateral | $7/year | $0/year |
| Paying on debt | $204/year | $82/year |
| **Net cost** | **$197/year** | **$82/year** |

**Morpho saves $115/year.** System migrates automatically.

## Migration Criteria

```
IF   savings > $10/year (or 1% of debt, whichever is more)
AND  health factor > 1.5
AND  last migration was > 6 hours ago
AND  debt > $100
AND  rates have been stable for 1 hour
THEN migrate
```

### Why each rule exists:

| Rule | Reason |
|------|--------|
| Savings > $10/year or 1% of debt | Small differences aren't worth the gas cost |
| Health factor > 1.5 | Position is too close to liquidation — don't touch it |
| 6-hour cooldown | Rates fluctuate — wait for a sustained trend, not a blip |
| Debt > $100 | Tiny positions save pennies — not worth it |
| 1-hour rate stability | Don't react to a 5-minute rate spike |

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

All 6 steps are atomic — if any step fails, the entire transaction reverts and nothing changes.

## ETH Price Matters

Collateral earnings are in WETH. When ETH price goes up, those earnings are worth more in dollars, making Aave more attractive. When ETH price drops, Morpho becomes relatively better.

The system recalculates dollar values every cycle, so this is handled automatically.

## Safety Checks

Before migrating, the system verifies:
- Flashloan module is installed on the user's wallet
- Session key is active
- All operations are whitelisted
- Position matches on-chain state

If anything fails, migration is skipped and an alert is logged.

## Data Sources

| Data | Source |
|------|--------|
| Aave rates | On-chain (`getReserveData`) |
| Morpho rates | Morpho GraphQL API (`blue-api.morpho.org`) |
| ETH/USD price | Morpho oracle |
| All rates in one call | `GET /vault/rates` (public, no auth) |

## Current Implementation Status

| Component | Status |
|-----------|--------|
| Aave to Morpho migration | Built and working |
| Morpho to Aave migration | Built and working |
| Manual trigger (`POST /vault/migrate`) | Built and working |
| Migration preflight diagnostics | Built and working |
| Fetching live rates from Aave and Morpho | Built and working |
| Unified rates API (`GET /vault/rates`) | Built and working |
| Auto-rebalance decision engine | Not built yet |
| Rate smoothing (1-hour average) | Not built yet |
| Rate history storage | Not built yet |
| User notifications on migration | Not built yet |

## What's Next

1. **Wire up the decision engine** — use the formula above in the monitor service
2. **Rate smoothing** — store samples every 60s, average over 1 hour before deciding
3. **Rate snapshot logging** — record rates at time of each migration for audit trail
4. **ETH price guard** — skip decisions if ETH moved >3% in 1 hour
5. **Redis cache** — cache rates across users (60s TTL)
6. **Notifications** — alert users when their position is migrated

## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| Aave V3 Pool | `0xa238dd80c259a72e81d7e4664a9801593f98d1c5` |
| Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| UnifiedFlashloanModule | `0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927` |
| TargetRegistry | `0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8` |
