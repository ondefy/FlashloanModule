# Rebalance Algorithm

### How the System Decides When to Move Your Position


## 1. What Your Position Contains

Your position has two parts:

- **WETH collateral** — earns interest on Aave, earns nothing on Morpho
- **USDC debt** — you pay interest on both protocols


## 2. Two Reasons to Migrate

The system migrates your position for two reasons:

**Reason 1: Save money** — the other protocol is cheaper (lower net cost).

**Reason 2: Avoid liquidation** — health factor is dropping and the other protocol has a higher liquidation threshold, giving your position more safety room.


## 3. The Cost Formula

You can't just compare borrow rates. You must also count what your collateral earns.

```
Net cost = What you pay on debt - What you earn on collateral
```

Both amounts must be in dollars, because WETH and USDC have different values.

```
Collateral value (USD) = WETH amount x ETH price
Debt value (USD)       = USDC amount

Yearly earnings = Collateral USD x collateral supply rate
Yearly cost     = Debt USD x borrow rate

Net cost = Yearly cost - Yearly earnings
```

Calculate this for both protocols. Whichever has the lower net cost is cheaper.


## 4. The Health Factor Formula

Health factor tells you how close your position is to being liquidated.

```
Health Factor = (Collateral Value x Liquidation Threshold) / Debt Value
```

- HF > 1.0 = safe
- HF = 1.0 = gets liquidated
- HF > 1.5 = comfortable

The key: each protocol has a different liquidation threshold, so the same position has a different health factor on each protocol.


## 5. Liquidation Thresholds

|  | Aave V3 (normal) | Aave V3 (e-mode) | Morpho Blue |
|--|-------------------|-------------------|-------------|
| Max LTV | 80% | 90% | 86% |
| Liquidation threshold | 83% | 93% | 86% |

**E-mode** is an Aave feature that increases the LTV and liquidation threshold for correlated asset pairs (like ETH/USDC). When enabled, Aave becomes the safest protocol for this pair.

What this means in practice:

- Position with HF = 1.05 on Aave (normal) would have HF = ~1.09 on Morpho (86% vs 83% threshold)
- Same position with Aave e-mode enabled would have HF = ~1.18 (93% threshold)

So if a user is close to liquidation, moving to whichever protocol has the higher threshold buys them breathing room without adding collateral.


## 6. Example: Cost-Based Migration

**Current rates** (from live API):

|  | Aave V3 | Morpho Blue |
|--|---------|-------------|
| Collateral supply rate (WETH) | 1.71% | 0% |
| Borrow rate (USDC) | 3.89% | 4.81% |

**Position:** 5 WETH ($10,962), 5,000 USDC debt

On Aave:
- Earning: $10,962 x 1.71% = $187/year from collateral
- Paying: $5,000 x 3.89% = $195/year on debt
- Net cost: $8/year

On Morpho:
- Earning: $0/year from collateral
- Paying: $5,000 x 4.81% = $241/year on debt
- Net cost: $241/year

**Aave is $233/year cheaper.** Stay on Aave.


## 7. Example: When Morpho Wins on Cost

Aave borrow rate spikes to 12%, supply drops to 0.3%. Morpho stays at 4.81%.

Position: 1 WETH ($2,000), 1,700 USDC debt

| | Aave (spiked) | Morpho |
|--|---------------|--------|
| Earning from collateral | $6/year | $0/year |
| Paying on debt | $204/year | $82/year |
| Net cost | $198/year | $82/year |

**Morpho saves $116/year.** System migrates automatically.


## 8. Example: Safety-Based Migration

Position: 1 WETH ($2,000), 1,600 USDC debt. Currently on Aave (normal mode).

```
Aave HF  = ($2,000 x 0.83) / $1,600 = 1.04  (dangerously close to liquidation)
Morpho HF = ($2,000 x 0.86) / $1,600 = 1.075 (slightly safer)
Aave e-mode HF = ($2,000 x 0.93) / $1,600 = 1.16 (much safer)
```

Even though Morpho might be more expensive, moving there raises the health factor from 1.04 to 1.075. Better yet, enabling Aave e-mode raises it to 1.16 without migrating at all.

**The system should:**
1. First try to enable e-mode on Aave if not already enabled (cheapest fix)
2. If already on e-mode and HF is still low, migrate to whichever protocol gives higher HF


## 9. Migration Criteria

The system migrates when ANY of these scenarios is true:

**Scenario A: Cost savings (normal rebalance)**
```
All of these must be true:
- Annual savings > $10 or 1% of debt (whichever is more)
- Health factor > 1.5
- Last migration > 6 hours ago
- Debt > $100
- Rates stable for 1 hour
- Projected HF on target protocol > 1.5
```

**Scenario B: Liquidation protection (safety migration)**
```
All of these must be true:
- Health factor < 1.3 (getting risky)
- Health factor > 1.05 (not yet liquidated)
- Target protocol would give HF at least 0.05 higher
- Last migration > 1 hour ago (shorter cooldown for safety)
```

Safety migrations ignore cost comparison — protecting from liquidation is more important than saving money.


## 10. Why Each Rule Exists

| Rule | Reason |
|------|--------|
| Savings > $10 or 1% of debt | Small differences aren't worth gas |
| Health factor > 1.5 for cost migration | Don't move safe positions unnecessarily |
| Health factor < 1.3 for safety migration | Only trigger safety mode when actually at risk |
| 6-hour cooldown (cost) | Wait for sustained rate trend |
| 1-hour cooldown (safety) | Act faster when position is at risk |
| Projected HF on target > 1.5 | Don't migrate into a position that's also risky |
| Rates stable for 1 hour | Don't react to 5-minute rate spikes |


## 11. E-Mode: What It Is and How It Works

Aave's Efficiency Mode (e-mode) increases the LTV and liquidation threshold for correlated asset pairs. For WETH/USDC on Base:

- Normal mode: LTV 80%, liquidation at 83%
- E-mode (category 1): LTV 90%, liquidation at 93%

Enabling e-mode is a single transaction: `setUserEMode(1)` on the Aave Pool contract. It does not move any funds. It just changes the risk parameters for that user.

When to enable:
- User's health factor is dropping (HF < 1.3)
- User is on Aave but not yet in e-mode
- Enabling e-mode would raise HF above 1.3

E-mode is the cheapest intervention — no flashloan needed, just one on-chain call. The system should try this before considering a full migration.


## 12. How Migration Works (Under the Hood)

Everything happens in one transaction.

Aave to Morpho:
1. Take a flash loan (USDC, 0% fee from Morpho)
2. Repay Aave debt
3. Withdraw WETH collateral
4. Supply WETH to Morpho
5. Borrow USDC from Morpho
6. Repay flash loan

Morpho to Aave:
1. Take a flash loan (USDC, 0% fee from Morpho)
2. Repay Morpho debt
3. Withdraw WETH collateral
4. Supply WETH to Aave
5. Borrow USDC from Aave
6. Repay flash loan

If any step fails, the whole transaction is cancelled. Nothing changes.


## 13. Decision Flowchart

```
Every 60 seconds, for each position:

  1. Read health factor from on-chain
  2. Read collateral and debt amounts

  --- Safety check (runs first, higher priority) ---

  3. Is HF < 1.3 and > 1.05?
     Yes:
       a. Is user on Aave without e-mode?
          → Enable e-mode (cheapest fix, just 1 tx)
       b. Would target protocol give HF at least 0.05 higher?
          → Safety migration (1-hour cooldown)
     No:
       Continue to cost check

  --- Cost check ---

  4. Is HF > 1.5?                          No → skip
  5. Enough TWAP samples (10+ min)?         No → skip
  6. ETH price stable (<3% move)?           No → skip
  7. Debt > $100?                           No → skip
  8. Cooldown > 6 hours?                    No → skip
  9. Calculate net cost on both protocols
 10. Savings > threshold?                   No → skip
 11. Projected HF on target > 1.5?         No → skip
 12. Preflight checks pass?                 No → alert
 13. Execute migration
```


## 14. ETH Price Matters

Your earnings come from WETH. When ETH price goes up, your earnings increase, so Aave becomes more attractive. When ETH price goes down, earnings decrease, so Morpho becomes relatively better.

ETH price also directly affects health factor: a price drop reduces collateral value and pushes HF down. This is why the system monitors HF every cycle and can trigger safety migrations during crashes.


## 15. Data Sources

| Data | Source |
|------|--------|
| Aave rates | On-chain (getReserveData) |
| Morpho rates | Morpho GraphQL API |
| ETH/USD price | Morpho oracle |
| Aave health factor | On-chain (getUserAccountData) |
| Aave liquidation threshold | On-chain (getUserAccountData returns it) |
| Morpho liquidation threshold | 86% (from market LLTV, on-chain or API) |
| All rates in one call | GET /vault/rates (public, no auth) |


## 16. Current Implementation Status

| Component | Status |
|-----------|--------|
| Aave to Morpho migration | Built and working |
| Morpho to Aave migration | Built and working |
| Manual trigger (POST /vault/migrate) | Built and working |
| Migration preflight diagnostics | Built and working |
| Rate fetching (Aave + Morpho) | Built and working |
| Unified rates API (GET /vault/rates) | Built and working |
| Cost-based rebalance engine with TWAP | Built and working |
| ETH price volatility guard | Built and working |
| Cooldown check (6h for cost, 1h for safety) | Built (cost), to build (safety) |
| Safety migration (HF-based) | To build |
| E-mode enable for Aave users | To build |
| Projected HF on target protocol | To build |
| Morpho HF reading from on-chain | To build |
| User notifications on migration | To build |


## 17. What's Next

1. Add Aave e-mode support (setUserEMode, getUserEMode)
2. Build safety migration trigger (HF < 1.3 → migrate to higher threshold)
3. Read Morpho health factor from on-chain
4. Project health factor on target protocol before migrating
5. Redis cache for rates
6. User notifications


## Key Addresses (Base Mainnet)

| Contract | Address |
|----------|---------|
| Aave V3 Pool | `0xa238dd80c259a72e81d7e4664a9801593f98d1c5` |
| Morpho Blue | `0xbbbbbbbbbb9cc5e90e3b3af64bdaf62c37eeffcb` |
| UnifiedFlashloanModule | `0x2C75600A65e79aC1DE53d9B815CdaFEBE3089927` |
| TargetRegistry | `0x1c824Fc9D57fFD350a3c8bc3cD66B2a855ebC7f8` |
