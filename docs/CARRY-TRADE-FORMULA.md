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
