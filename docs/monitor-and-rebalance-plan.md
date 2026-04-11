# Monitor & Rebalance — What's Built, How It Works, What's Next

Date: April 10, 2026


## What the Monitor Does

The monitor is a background service that runs every 60 seconds. It does four things:

1. Checks if users have idle WETH sitting in their Safe wallet and auto-deposits it to Aave
2. Samples current rates from both protocols (builds up a 1-hour average)
3. Reads each user's health factor from on-chain and updates the database
4. Runs two migration checks per position:
   a. Safety check — if HF is dangerously low, enable e-mode or migrate to safer protocol
   b. Cost check — if the other protocol is meaningfully cheaper, migrate to save money


## What's Built and Working

**Monitoring:**
- Health factor reading from Aave (on-chain) and Morpho (on-chain)
- Tiered check intervals (risky positions checked more often)
- Idle WETH auto-deposit to Aave
- Health factor stored in database with next check time

**Safety migration (liquidation protection):**
- Detects when health factor drops below 1.3 (danger zone)
- Auto-enables Aave e-mode if user isn't already in it (raises liquidation threshold from 83% to 93%)
- If e-mode isn't enough, migrates to protocol with higher liquidation threshold
- 1-hour cooldown (faster than cost migration because safety is urgent)
- Morpho LLTV: 86%, Aave normal: 83%, Aave e-mode: 93%

**Migration execution:**
- Aave to Morpho swap (6 steps, atomic flashloan, 0% fee)
- Morpho to Aave swap (6 steps, atomic flashloan, 0% fee)
- Manual trigger via API (POST /vault/migrate)
- Preflight diagnostics (checks all modules, keys, whitelist before migrating)

**Rate fetching:**
- Aave rates from on-chain (getReserveData — supply APY on WETH, borrow APY on USDC)
- Morpho rates from their GraphQL API (borrow APY on USDC, confirmed 0% on WETH collateral)
- ETH/USD price from Morpho oracle (part of the same API call)
- Public API endpoint: GET /vault/rates (no auth needed)

**Rebalance decision engine:**
- USD-normalized cost comparison (the correct formula)
- TWAP rate smoothing (1-hour average to avoid reacting to spikes)
- ETH price volatility guard (skips if ETH moved >3% in last hour)
- Cooldown check (6 hours between migrations, reads from migration_history table)
- Minimum position size ($100 debt)
- Minimum savings threshold ($10/year or 1% of debt)
- Auto-triggers migration when all checks pass


## How the Rates Flow

```
Every 60 seconds:

  1. Monitor calls getProtocolRates()

  2. getProtocolRates() makes two calls in parallel:

     Aave (on-chain RPC):
       getReserveData(WETH) → currentLiquidityRate → WETH supply APY
       getReserveData(USDC) → currentVariableBorrowRate → USDC borrow APY

     Morpho (GraphQL API to blue-api.morpho.org):
       marketByUniqueKey(our WETH/USDC market on Base)
       → state.borrowApy     = USDC borrow rate (e.g. 4.81%)
       → state.supplyApy     = USDC lender rate (NOT collateral — we don't use this)
       → collateralAsset.priceUsd = ETH price in USD

  3. Result is pushed into an in-memory array (rate sample)

  4. Array holds up to 60 samples (1 hour of data)
```


## How the TWAP Works

TWAP = Time-Weighted Average Price. We use it for rates too.

Instead of reacting to the latest rate (which could be a 5-minute spike), we average all samples from the last hour.

```
Rate samples array (in memory):

  Sample 1:  Aave borrow 3.89%, Morpho borrow 4.81%, ETH $2,192  (60 min ago)
  Sample 2:  Aave borrow 3.91%, Morpho borrow 4.80%, ETH $2,190  (59 min ago)
  Sample 3:  Aave borrow 3.88%, Morpho borrow 4.82%, ETH $2,195  (58 min ago)
  ...
  Sample 60: Aave borrow 3.90%, Morpho borrow 4.79%, ETH $2,193  (just now)

  TWAP = average of all 60 samples
       = Aave borrow ~3.90%, Morpho borrow ~4.80%, ETH ~$2,193
```

The system needs at least 10 samples (~10 minutes after server start) before it will make any migration decision. This prevents acting on incomplete data.

If the server restarts, the array is empty and it takes 10 minutes to collect enough data again.


## How the Rebalance Decision Works

Every 60 seconds, for each user position:

```
Gate 1: Is health factor above 1.5?
  No → skip (too close to liquidation)

Gate 2: Does the position have debt?
  No → skip (nothing to optimize)

Gate 3: Do we have enough rate samples (10+ minutes)?
  No → skip (not enough data yet)

Gate 4: Has ETH price been stable (less than 3% change in our sample window)?
  No → skip (wait for stability)

Gate 5: Is the debt above $100?
  No → skip (too small to bother)

Gate 6: Has it been more than 6 hours since the last migration?
  No → skip (cooldown period)

Gate 7: Would migrating save meaningful money?
  Calculate using the TWAP rates:

    On current protocol:
      Yearly earnings = collateral in USD × collateral supply rate
      Yearly cost     = debt in USD × borrow rate
      Net cost        = Yearly cost − Yearly earnings

    On target protocol:
      Same calculation with the other protocol's rates

    Savings = current net cost − target net cost

  Is savings above $10/year (or 1% of debt, whichever is more)?
  No → skip (not worth it)

All gates passed → execute migration via flashloan
```


## Current Live Rates (for reference)

From GET /vault/rates on April 10, 2026:

```
Aave:
  WETH collateral supply APY:  1.71%  (your collateral earns this)
  USDC borrow APY:             3.89%  (you pay this on debt)

Morpho:
  WETH collateral supply APY:  0%     (collateral earns nothing)
  USDC borrow APY:             4.81%  (you pay this on debt)

ETH price: $2,192
```

At these rates, Aave is always cheaper because:
- Aave has a lower borrow rate (3.89% vs 4.81%)
- Aave pays 1.71% on your WETH collateral, Morpho pays 0%

Morpho would only win if Aave's borrow rate spikes significantly (like during volatile market events).


## Config Values

All tunable in monitor.service.ts:

```
Minimum savings to migrate:    $10/year or 1% of debt (whichever is more)
Minimum health factor:         1.5
Cooldown between migrations:   6 hours
Minimum debt to consider:      $100
Rate samples needed:           10 (about 10 minutes of data)
ETH price volatility limit:    3% change in sample window
Max rate samples stored:       60 (1 hour of data)
Monitor cycle interval:        60 seconds
```


## What's NOT Built Yet

**Rate persistence:**
Currently rates are stored in memory. If the server restarts, the TWAP buffer is empty and it takes 10 minutes before any migration decision can happen. Redis or database storage would fix this.

**Morpho health factor reading:**
The monitor reads Aave health factor from on-chain but currently uses a hardcoded 2.0 for Morpho positions. Needs to read actual Morpho position data and calculate HF from collateral value, debt, and LLTV.

**Post-migration health factor check:**
Before migrating, should simulate what the health factor would be on the target protocol. Aave and Morpho have different LTV limits (Aave 80%, Morpho 86%).

**Rate trend detection:**
Currently uses a flat average. Could be smarter — check if rates are trending in a direction over the last 6 hours, and only migrate if the favorable trend is sustained.

**User notifications:**
No alerts when a position is auto-migrated. Users should get notified.

**Redis cache for rates:**
Rates are fetched fresh on every cycle. With many users, this means repeated calls. A shared Redis cache with 60-second TTL would reduce RPC/API calls.

**Projection-based savings:**
Current formula projects savings over a full year assuming rates stay constant. A 30-day projection would be more realistic since rates change frequently.


## File Map

```
backend/src/services/
  monitor.service.ts     — Monitor daemon, health checks, rate TWAP, rebalance decision engine,
                           migration execution, preflight checks
  vault.service.ts       — Rate fetching (getProtocolRates), deposit/borrow/repay/withdraw,
                           Morpho GraphQL integration
  session-executor.ts    — Executes transactions on the Safe wallet via session keys

backend/src/routes/
  vault.routes.ts        — GET /vault/rates (public), POST /vault/migrate (auth required)

docs/
  rebalance-algorithm.md — The rebalance formula, examples, decision rules
  when-to-migrate.md     — Original migration guide (being replaced by rebalance-algorithm.md)
```


## Improvement Roadmap

**Next up (Phase 2):**
- Read Morpho position data on-chain (health factor, collateral, debt)
- Persist rate samples to Redis (survive restarts, share across instances)
- Simulate post-migration health factor before executing
- Rate trend detection (only migrate if trend is sustained for 6+ hours)

**Later (Phase 3):**
- 30-day savings projection instead of annual
- Gas cost subtracted from savings calculation
- User notifications on migration
- Process users sequentially with rate re-check between each migration
- Dashboard for monitoring migration decisions and rate history

**Future:**
- Support more protocols (Compound V3, Spark, Fluid)
- Morpho Vault integration (some vaults do pay on collateral)
- Cross-chain rebalancing
