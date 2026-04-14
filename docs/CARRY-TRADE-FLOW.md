# Carry Trade — End-to-End Flow

## 1. Discovery / quote

User (or frontend) asks: "what's my APY if I put 10 WETH to work?"

- Call `/quote` with collateralAmount + LTV
- System fetches: Aave WETH supply APY (on-chain), Aave USDC borrow APY (on-chain), USDC pool opps (Degen API)
- System filters pools (TVL, liquidity, utilization, stability)
- Returns top 3 with net APY breakdown + scenarios

## 2. User picks a pool and commits

User picks pool X. Frontend calls `/execute`.

Backend builds ONE batched UserOp (no flashloan needed):

1. `WETH.approve(aavePool, amount)`
2. `aavePool.supply(WETH, amount, safe)`
3. `aavePool.borrow(USDC, borrowAmount, variable, safe)`
4. `USDC.approve(poolX, borrowAmount)`
5. `poolX.deposit(borrowAmount, safe)`

Signed with session key → submitted via Pimlico → on-chain.

On success: insert `carry_trade_positions` row (user, collateral, borrow, poolX, entry APYs, entry net APY, timestamp).

## 3. Continuous monitoring (every N minutes)

For each active carry position:

**Health Factor check**
- Read Aave `getUserAccountData(safe)` → HF
- If HF < 1.3 → flag, notify
- If HF < 1.1 → trigger emergency exit

**Net APY check**
- Recompute `wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)` using live rates
- If live APY ≤ 0 → auto-exit
- If live APY < 50% of entry APY → flag / consider migration

**Pool stability check (Utkir's existing logic)**
- APY stable 7/10 days? TVL stable? Liquidity OK?
- If not → migrate USDC leg to a better pool

**Better-opportunity check**
- Scan Degen API for new top pool
- If beats current by > threshold → migrate USDC leg

## 4. USDC-leg migration (pool A → pool B, no flashloan)

Triggered by monitoring. Single UserOp:

1. `poolA.withdraw(shares, safe)`
2. `USDC.approve(poolB, amount)`
3. `poolB.deposit(amount, safe)`

Update `carry_trade_positions.pool_address`.

## 5. Collateral-leg migration (Aave → Morpho, needs flashloan)

Rare. Triggered when borrow rate or supply rate makes a venue switch worthwhile. Uses existing UnifiedFlashloanModule. No user action.

## 6. Exit (user-initiated or auto)

`/exit` endpoint. Single UserOp (no flashloan):

1. `poolX.withdraw(shares, safe)` → USDC back to Safe
2. `USDC.approve(aavePool, debtAmount)`
3. `aavePool.repay(USDC, max, variable, safe)`
4. `aavePool.withdraw(WETH, max, safe)`

Mark `carry_trade_positions.status = closed`. Withdraw WETH to user EOA if requested.

## What we actually need to implement

Regardless of which backend owns it:

1. `/quote` endpoint — done
2. `/execute` endpoint (entry UserOp)
3. `/exit` endpoint (exit UserOp)
4. `/migrate-pool` endpoint (USDC leg swap)
5. `carry_trade_positions` DB table
6. Aave `borrow()` + `repay()` calldata builder
7. Per-pool adapter (ERC4626 deposit/withdraw — covers most Morpho vaults)
8. HF monitor cron
9. Net APY monitor cron
10. Session key permission entries for Aave borrow + repay + each pool's deposit/withdraw
11. Auto-exit trigger (when HF critical or APY negative)
