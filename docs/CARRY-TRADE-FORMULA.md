# Where the Carry Trade Formula Comes From

The final formula:

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)

Here is how it is built, step by step.

## Step 1 — Write down what the user earns and pays

Per year the user has three things happening:

- WETH supply earns interest on the WETH deposited
- USDC deposit earns interest on the USDC redeposited
- USDC borrow costs interest on the USDC borrowed

Total net yield in dollars:

    net_usd = (what WETH earns)
            + (what USDC deposit earns)
            − (what USDC borrow costs)

Expanded:

    net_usd = collateralUsd × wethSupplyApy
            + borrowUsd     × usdcDepositApy
            − borrowUsd     × usdcBorrowApy

## Step 2 — Replace borrowUsd with collateralUsd × ltv

The borrow amount is not random. It is a fraction of the collateral. That fraction is LTV.

    borrowUsd = collateralUsd × ltv

Substituting:

    net_usd = collateralUsd × wethSupplyApy
            + collateralUsd × ltv × usdcDepositApy
            − collateralUsd × ltv × usdcBorrowApy

## Step 3 — Group the two USDC lines

Both USDC lines share `collateralUsd × ltv`. Pull it out:

    net_usd = collateralUsd × wethSupplyApy
            + collateralUsd × ltv × (usdcDepositApy − usdcBorrowApy)

The part `(usdcDepositApy − usdcBorrowApy)` is the spread — profit per dollar borrowed on the USDC leg.

## Step 4 — Divide by principal to get APY

APY = yield / principal. Divide both sides by collateralUsd:

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)

The principal cancels. The formula is left.

## What each piece means

- `wethSupplyApy` — what the WETH collateral earns no matter what
- `ltv` — how much of the collateral is levered up as USDC
- `(usdcDepositApy − usdcBorrowApy)` — spread. Positive means USDC leg makes money. Negative means it loses money.
- `ltv × spread` — the user's exposure to that spread, scaled by how much was borrowed

Bigger LTV amplifies the spread. If spread is positive, higher LTV gives more APY. If spread is negative, higher LTV hurts more.

## Order of operations

Always in this order:

1. Parentheses first — compute the spread
2. Multiplication — multiply spread by ltv
3. Addition last — add wethSupplyApy

Example: `1.8% + 0.70 × (7.27% − 6.5%)`

    step 1: 7.27% − 6.5%   = 0.77%
    step 2: 0.70 × 0.77%    = 0.539%
    step 3: 1.8% + 0.539%   = 2.339%

## Why the result works on WETH principal

The APY itself is a percentage with no unit. Multiply by any principal to get yield in that currency:

- Multiply by WETH principal → yield in WETH
- Multiply by USD principal → yield in USD

Example with 10 WETH at $2,000 ETH:

    yield in USD  = $20,000 × 2.339% = $467.80
    yield in WETH = 10 × 2.339%       = 0.234 WETH

Both match ($467.80 / $2,000 = 0.234 WETH).

The code labels this number `netApyInWeth` because the user's deposit is WETH.

## ETH price caveat

"Assumes ETH price is flat" = the 2.34% number is calculated as if 1 ETH stays $2,000 for the whole year.

"Real WETH return drifts with ETH price" = in real life ETH price moves, so the actual yield measured in WETH will be different from what we quoted.

"USDC legs are fixed USD" = the USDC borrow cost and USDC deposit yield produce DOLLAR amounts, not WETH amounts.

Why this matters with one example:

User deposits 10 WETH. Suppose USDC legs net = $250 loss per year.

If ETH stays at $2,000:

    $250 loss = 0.125 WETH loss

If ETH pumps to $4,000 (ETH doubles during the year):

    $250 loss = 0.0625 WETH loss (each dollar is worth fewer WETH now)

So the USDC loss hurts LESS in WETH terms → real WETH APY is BETTER than quoted.

If ETH dumps to $1,000:

    $250 loss = 0.25 WETH loss (each dollar is worth more WETH now)

USDC loss hurts MORE → real WETH APY is WORSE than quoted.

The WETH supply leg (1.8%) is unaffected either way because it is earned directly in WETH.

Bottom line: the quoted APY is a snapshot assuming flat ETH. Fine for display. Real yield will differ depending on where ETH price goes.

