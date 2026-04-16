# Carry Trade Profitability — Live Example

When does a carry trade beat just supplying WETH? Worked on real rates from Base.

## The formula

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)

## Inputs used

- WETH supply APY (Aave): 1.50%
- USDC borrow APY (Aave): 4.10%
- LTV: 0.70
- Baseline for comparison: just supply WETH → 1.50%

## Break-even

Carry beats supply-only only when the USDC deposit APY is higher than the USDC borrow APY. Today's break-even threshold is 4.10%. Above it, the spread is positive and carry wins. Below it, carry loses.

## Five pools compared

Wasabi USDC — deposit APY 6.66%

    net = 1.50 + 0.70 × (6.66 − 4.10) = 3.29%   → +1.79% vs supply-only. WIN

Steakhouse High Yield USDC — deposit APY 5.44%

    net = 1.50 + 0.70 × (5.44 − 4.10) = 2.44%   → +0.94% vs supply-only. WIN

Gauntlet USDC Prime — deposit APY 4.34%

    net = 1.50 + 0.70 × (4.34 − 4.10) = 1.67%   → +0.17% vs supply-only. BARELY

Steakhouse Prime USDC — deposit APY 4.34%

    net = 1.50 + 0.70 × (4.34 − 4.10) = 1.67%   → +0.17% vs supply-only. BARELY

Spark USDC Vault — deposit APY 3.94%

    net = 1.50 + 0.70 × (3.94 − 4.10) = 1.39%   → −0.11% vs supply-only. LOSS

## Reading the result

- Deposit APY clearly above borrow APY → meaningful extra yield
- Deposit APY just above borrow APY → marginal, gas usually eats it
- Deposit APY below borrow APY → worse than supply-only, don't carry

## Practical rule

Create a carry position only when the net APY exceeds supply-only by at least 0.5 percentage points. Anything less is noise once gas and monitoring are priced in. With today's numbers only Wasabi (+1.79) and Steakhouse High Yield (+0.94) qualify.

## Why it can flip

Profitability is driven by two moving numbers: the USDC deposit APY on the chosen pool and the USDC borrow APY on the lending protocol. When borrow rates rise, fewer pools clear the threshold. When borrow rates fall, many pools qualify. A position that makes sense today can become unprofitable in a week, which is why continuous monitoring and auto-conversion back to supply-only is part of the design.
