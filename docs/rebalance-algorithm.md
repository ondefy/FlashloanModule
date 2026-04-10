ZyFi Rebalance Algorithm
========================

Date: April 10, 2026
Status: Ready for Review



1. What is Rebalancing?

Users deposit WETH as collateral and borrow USDC. This position lives on either Aave V3 or Morpho Blue on Base.

Each protocol charges different rates that change constantly. Rebalancing means moving the entire position to whichever protocol costs the user less.

The move is a single atomic transaction using a flashloan. If any step fails, nothing happens. No partial moves, no risk.



2. How the Two Protocols Differ

                          Aave V3                    Morpho Blue
Collateral (WETH)         Earns supply APY            Earns nothing (0%)
Debt (USDC)               Pays borrow APY             Pays borrow APY
Current borrow rate       3.89%                       4.81%
Current supply rate       1.71% on WETH               0% on WETH

The key difference: On Aave, your WETH collateral earns interest. On Morpho, your WETH collateral sits idle and earns nothing.

This means the borrow rate alone does not tell you which protocol is cheaper. You must account for what the collateral earns.



3. The Rebalance Formula

Step 1: Convert everything to dollar amounts per year.

  Collateral value = WETH amount x ETH price in USD
  Debt value       = USDC amount x $1.00

  Annual earnings  = Collateral value x collateral supply rate
  Annual cost      = Debt value x borrow rate

  Net cost per year = Annual cost - Annual earnings

Step 2: Calculate net cost for both protocols.

Step 3: Compare.

  Savings = Net cost on current protocol - Net cost on target protocol

  If savings is positive and large enough, migrate.



4. Examples

Example A: Typical Position

Position: 5 WETH ($10,962 at current ETH price), 5,000 USDC debt

  On Aave:
    Earnings from collateral = $10,962 x 1.71% = $187 per year
    Cost of borrowing        = $5,000 x 3.89%  = $195 per year
    Net cost on Aave         = $195 - $187 = $8 per year

  On Morpho:
    Earnings from collateral = $10,962 x 0%    = $0 per year
    Cost of borrowing        = $5,000 x 4.81%  = $241 per year
    Net cost on Morpho       = $241 - $0 = $241 per year

  Aave costs $8/year. Morpho costs $241/year. Stay on Aave.

  Why: Aave collateral earnings ($187) nearly cover the entire borrow cost. On Morpho, the user gets zero from collateral and pays a higher borrow rate.


Example B: High Leverage Position

Position: 1 WETH ($2,192), 1,700 USDC debt (77% LTV)

  On Aave:
    Earnings = $2,192 x 1.71% = $37 per year
    Cost     = $1,700 x 3.89% = $66 per year
    Net cost = $29 per year

  On Morpho:
    Earnings = $0 per year
    Cost     = $1,700 x 4.81% = $82 per year
    Net cost = $82 per year

  Aave costs $29/year. Morpho costs $82/year. Stay on Aave.


Example C: When Morpho Wins

Same position, but Aave rates spike during a volatile market:
Aave supply drops to 0.30%, Aave borrow jumps to 12%. Morpho rates unchanged.

  On Aave (spiked):
    Earnings = $2,192 x 0.30% = $7 per year
    Cost     = $1,700 x 12.0% = $204 per year
    Net cost = $197 per year

  On Morpho (stable):
    Earnings = $0 per year
    Cost     = $1,700 x 4.81% = $82 per year
    Net cost = $82 per year

  Aave costs $197/year. Morpho costs $82/year. Migrate to Morpho. Saves $115/year.

  This happens during high-volatility events when Aave utilization spikes. These events are common in DeFi.


Example D: Small Position

Position: 0.01 WETH ($22), 15 USDC debt

  Even with a rate advantage, savings would be pennies per year. Not worth the gas cost.

  Result: Do not migrate. Position is too small.



5. When to Migrate (Decision Rules)

The system migrates when ALL of these are true:

  1. Annual savings in USD is meaningful
     Threshold: savings must exceed $10 per year OR 1% of the debt value, whichever is larger.

  2. Position is safe to move
     Health factor must be above 1.5. Below that, the position is close to liquidation.

  3. Enough time has passed since last migration
     Minimum 6 hours between migrations. This prevents back-and-forth switching on temporary rate changes.

  4. Position is large enough
     Minimum $100 in debt. Smaller positions are not worth the operational cost.

  5. Rates are stable
     Use a 1-hour average of rates, not a single snapshot. This avoids reacting to momentary spikes.


Why each rule exists:

  Savings threshold    Small differences are not worth the gas and execution risk.
  Health factor > 1.5  Moving a position near liquidation is dangerous.
  6-hour cooldown      Rates fluctuate. Wait for a sustained improvement, not a blip.
  $100 minimum         Tiny positions save too little to justify any migration.
  1-hour average       Prevents false signals from short rate spikes.



6. When Does Each Protocol Win?

Aave wins when:
  - Collateral supply rate is meaningful (>0.5%)
  - User has a large collateral-to-debt ratio (low LTV)
  - The earnings on collateral offset or exceed the borrow cost difference

Morpho wins when:
  - Morpho borrow rate is significantly lower than Aave borrow rate
  - The borrow rate gap is large enough to overcome 0% collateral earnings

The exact threshold depends on position size. For a 50% LTV position (collateral = 2x debt):

  Morpho borrow rate must be below: Aave borrow rate - 2 x Aave supply rate

  With current rates: 3.89% - 2 x 1.71% = 0.47%

  Morpho would need a borrow rate below 0.47% to beat Aave at 50% LTV.
  Currently at 4.81%, so Morpho is far from competitive at current rates.

At higher LTV (say 75%, collateral = 1.33x debt):
  Threshold = 3.89% - 1.33 x 1.71% = 1.62%
  Morpho still needs to be below 1.62%. Still not close.

Morpho primarily wins during Aave rate spikes, which happen regularly during volatile markets.



7. ETH Price Impact

The supply rate is earned on WETH. When we convert to USD:

  ETH price goes up   = Collateral earnings in USD go up   = Aave becomes more attractive
  ETH price goes down = Collateral earnings in USD go down  = Morpho becomes relatively better

The algorithm handles this automatically by recalculating USD values on every check.

Additional safety: If ETH price moves more than 3% within one hour, the system skips migration decisions until prices stabilize.



8. Decision Flowchart

  Every 60 seconds, the monitor checks each active position:

    1. Health factor above 1.5?            No --> Skip
    2. Debt above $100?                    No --> Skip
    3. Last migration more than 6h ago?    No --> Skip
    4. Fetch rates from both protocols
    5. Calculate USD net cost for both
    6. Calculate savings
    7. Savings above threshold?            No --> Skip
    8. Preflight checks pass?              No --> Skip and alert
    9. Execute migration (atomic flashloan)
   10. Log the migration with rate snapshot



9. How Migration Works (Under the Hood)

Aave to Morpho (6 steps, 1 transaction):
  1. Flashloan USDC from Morpho (0% fee)
  2. Repay all USDC debt on Aave
  3. Withdraw all WETH collateral from Aave
  4. Deposit WETH collateral on Morpho
  5. Borrow USDC from Morpho to repay the flashloan
  6. Flashloan repaid. Done.

Morpho to Aave (6 steps, 1 transaction):
  1. Flashloan USDC from Morpho (0% fee)
  2. Repay all USDC debt on Morpho
  3. Withdraw all WETH collateral from Morpho
  4. Deposit WETH collateral on Aave
  5. Borrow USDC from Aave to repay the flashloan
  6. Flashloan repaid. Done.

All steps are atomic. If any step fails, the entire transaction reverts and nothing changes.



10. Safety Checks Before Migration

Before executing, the system verifies:
  - FlashloanModule is installed on the user's Safe wallet
  - GuardedExecModule is installed
  - Session key is active and enabled
  - All required operations are whitelisted in the TargetRegistry
  - The database position matches on-chain state

If any check fails, migration is skipped and an alert is logged.



11. Edge Cases

  No debt                      Skip. Nothing to optimize.
  No collateral                Alert. Should not happen.
  Both protocols same cost     Skip. Zero savings.
  ETH crash during migration   Safe. Atomic transaction reverts if it cannot complete.
  Rates change during tx       Safe. Threshold ensures small changes do not matter.
  Many users migrate at once   Process one at a time. Re-check rates between each.



12. Data Sources

Aave V3 rates: Read directly from the Aave smart contract on Base (on-chain, real-time).
Morpho rates: Fetched from Morpho GraphQL API (blue-api.morpho.org/graphql).
ETH price: From Morpho oracle (included in the API response).

All data is available via: GET /vault/rates (public endpoint, no authentication required).
Add position parameters for a preview: GET /vault/rates?collateralUsd=25000&debtUsd=10000



13. Improvements to Build

Rate smoothing:
  Store rate samples every 60 seconds. Use 1-hour average for decisions. Do not react to short spikes.

Gas cost accounting:
  Subtract estimated gas cost ($0.10-0.60 on Base) from projected savings.

Trend detection:
  Track rate direction over past 6 hours. Only migrate if the favorable trend is sustained.

Health factor simulation:
  Check what the health factor would be on the target protocol before migrating.

Price volatility guard:
  Skip migration decisions if ETH price moved more than 3% in the last hour.



14. Implementation Status

Done:
  - Rate fetching from both protocols
  - ETH/USD price from oracle
  - USD-normalized cost calculation
  - Public rates API
  - Migration execution (both directions)
  - Preflight diagnostics

To Build:
  - Wire up auto-migration decision engine with the formula above
  - Position size and cooldown gates
  - Rate smoothing (1-hour TWAP)
  - Rate snapshot logging for audit trail
  - ETH price volatility guard
  - Health factor simulation on target protocol
  - Redis cache for rates
  - User notifications on migration



Quick Reference: The Formula

  C = collateral (WETH amount)
  D = debt (USDC amount)
  P = ETH price in USD
  s = collateral supply rate (Aave: check on-chain, Morpho: 0)
  b = borrow rate on USDC

  Net cost = (D x b) - (C x P x s)

  Savings = current_net_cost - target_net_cost

  Migrate if savings > max($10, D x 0.01) AND health factor > 1.5 AND cooldown > 6h AND D > $100
