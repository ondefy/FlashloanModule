# Carry Trade Execution Plan

How the carry trade feature plugs into the existing backend: entry, monitoring, migration, exit. Scope: WETH collateral, USDC borrow, USDC redeposit into an external pool (Morpho vault, etc). No wstETH in v1.

## What already exists in the backend

- UnifiedFlashloanModule — atomic multi-step via Morpho/Aave flashloan
- GuardedExecModule + TargetRegistry — whitelist of allowed target + selector pairs
- vault.service.ts — supplyWethToAave, borrow, repay, withdraw, getProtocolRates
- session-executor.service.ts — signs and submits UserOps with session keys
- monitor.service.ts — polls HF per user, triggers migrations
- strategy.service.ts (new) — `/quote` endpoint, calculates net APY
- Supabase `positions` table — tracks user collateral and debt state

## Phase A — Entry and Exit (no flashloan)

No atomic constraint on the 3 legs. Entry and exit are plain batched Safe UserOps.

### Entry endpoint

    POST /api/strategy/carry-trade/execute

Body:

    {
      "collateralAmount": "10000000000000000000",
      "ltv": 0.70,
      "poolAddress": "0xBEEFA7B8..."
    }

Flow:

1. Validate poolAddress is whitelisted in TargetRegistry
2. Re-run `/quote` logic to confirm the chosen pool still passes quality gates and computes expected net APY
3. Build a single UserOp with 4 executions via GuardedExecModule:
   - WETH.approve(aavePool, amount)
   - aavePool.supply(WETH, amount, safe)
   - aavePool.borrow(USDC, borrowAmount, variable, safe)
   - USDC.approve(poolAddress, borrowAmount)
   - poolAddress.deposit(borrowAmount, safe)  or vault-specific selector
4. Submit via session-executor.service.ts
5. On success: insert into `carry_trade_positions` with entry snapshot

Reused: session-executor, TargetRegistry, existing Aave calldata builders in vault.service.
New: batch builder for steps 1-4 + per-pool deposit adapter.

### Exit endpoint

    POST /api/strategy/carry-trade/exit

Body:

    { "positionId": "uuid" }

Flow (reverse order, no flashloan):

1. poolAddress.withdraw(shares, safe)  or redeem
2. USDC.approve(aavePool, debtAmount)
3. aavePool.repay(USDC, type(uint256).max, variable, safe)
4. aavePool.withdraw(WETH, type(uint256).max, safe)
5. Mark `carry_trade_positions.status = closed`

Reused: repay + withdraw calldata builders in vault.service.
New: per-pool withdraw adapter.

## Phase B — Migration (uses existing flashloan module)

Needed when rates change and the active strategy should move to a better pool or the collateral protocol should switch.

### Case 1 — USDC pool-to-pool migration

Move the USDC leg from pool A to pool B. No flashloan needed because USDC is liquid. Sequential:

1. poolA.withdraw(shares, safe)
2. USDC.approve(poolB, amount)
3. poolB.deposit(amount, safe)

Single UserOp. No flashloan.

### Case 2 — Aave to Morpho collateral migration

Move WETH collateral from Aave to Morpho while USDC debt is active. Requires flashloan. Already implemented as the Aave↔Morpho swap in UnifiedFlashloanModule. Plug in as-is.

## New data model

Supabase table `carry_trade_positions`:

    id                uuid PK
    user_id           uuid
    safe_address      text  (lowercase)
    status            enum  (active, closed, migrating)
    collateral_amount numeric  (WETH raw units)
    borrow_amount     numeric  (USDC raw units)
    pool_address      text  (lowercase)
    pool_protocol     text  (Morpho, other)
    ltv               numeric
    entry_weth_supply_apy   numeric
    entry_usdc_borrow_apy   numeric
    entry_usdc_deposit_apy  numeric
    entry_net_apy     numeric
    opened_at         timestamptz
    closed_at         timestamptz

Optional table `carry_trade_apy_snapshots` for stability tracking:

    position_id       uuid FK
    snapshot_at       timestamptz
    weth_supply_apy   numeric
    usdc_borrow_apy   numeric
    usdc_deposit_apy  numeric
    net_apy           numeric

## Monitoring integration

Extend the existing `monitor.service.ts` daemon. It already loops over users for HF checks. Add a second pass per user: for each active `carry_trade_positions` row, re-run the net APY calc.

Checks on each tick:

1. HF check — same as today, from Aave data. Triggers liquidation protection.
2. Net APY check — recompute `wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)` using current live rates (Aave on-chain + Degen API for the current poolAddress).
3. Compare to entry_net_apy.

Rules:

- live_net_apy > 0 AND ≥ 50% of entry_net_apy → keep position, log snapshot
- live_net_apy < 50% of entry_net_apy → flag. Notify user or queue for migration check.
- live_net_apy ≤ 0 → auto-exit via the exit endpoint. Unwinds to safe state.
- Better pool found (new top pool beats current by ≥ X%) → queue migration via Phase B Case 1.

All of this fits inside monitor.service.ts's existing tier loop. No new daemon.

## TargetRegistry updates

Every external USDC pool must have its deposit and withdraw selectors whitelisted. One-time op per pool, owner-only:

- addToWhitelist(poolAddress, ERC4626.deposit.selector)
- addToWhitelist(poolAddress, ERC4626.withdraw.selector)  or redeem
- addToWhitelist(USDC, ERC20.approve.selector)  already present

Without whitelisting, TargetRegistry rejects the execution. This is the main security gate.

## Reused safety checks

- HF monitoring — unchanged, runs per tick
- TargetRegistry whitelist — every step in the UserOp validated
- Session key chain — same as existing vault ops
- Simulation pre-check — run eth_call on each execution before submit
- Position idempotency — use positionId as jobId when a queue is introduced

## What is new vs reused

New:
- `/execute` endpoint and route
- `/exit` endpoint and route
- `/migrate-pool` endpoint (Phase B Case 1)
- carry_trade_positions table + snapshots table
- Per-pool deposit/withdraw adapter (one file per pool type, starts with ERC4626 for Morpho vaults)
- Net APY check inside monitor.service.ts
- Whitelist entries per supported pool

Reused:
- Session-executor, UserOp building
- Aave supply/borrow/repay/withdraw calldata
- TargetRegistry + GuardedExecModule
- UnifiedFlashloanModule (only for Phase B Case 2)
- Supabase positions table
- getProtocolRates + strategy.service.ts quote logic

## Execution order for shipping

1. Entry endpoint + carry_trade_positions table + Morpho ERC4626 adapter
2. Exit endpoint
3. Monitor integration (net APY pass + snapshot storage)
4. Pool-to-pool migration endpoint
5. Aave ↔ Morpho collateral migration hook (reuses flashloan module)

## File map

New:
- backend/src/routes/strategy.routes.ts  (extend existing)
- backend/src/services/carry-trade.service.ts
- backend/src/services/adapters/erc4626.adapter.ts
- supabase migration for carry_trade_positions

Touched:
- backend/src/services/monitor.service.ts  (add net APY pass)
- backend/src/services/strategy.service.ts  (expose reusable APY calc)
