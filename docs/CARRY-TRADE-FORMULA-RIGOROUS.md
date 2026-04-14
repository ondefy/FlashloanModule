# Carry Trade Formula — Rigorous Version

Same final formula. This version writes each leg in its native unit first, then converts explicitly to USD. The earlier doc took a shortcut; this one does not.

## Inputs

- collateralWeth — WETH deposited (e.g. 10)
- ethPrice — ETH price in USD (e.g. $2,000)
- ltv — loan-to-value (e.g. 0.70)
- wethSupplyApy — APY on WETH deposit (e.g. 1.8%)
- usdcBorrowApy — APY on USDC borrow (e.g. 6.5%)
- usdcDepositApy — APY on USDC redeposit (e.g. 4.71%)

## Step 1 — Yield in native units

Each leg produces yield in its own currency. Nothing converted yet.

    leg1_yield_weth = collateralWeth × wethSupplyApy       (WETH)
    leg2_cost_usdc  = borrowUsdc     × usdcBorrowApy       (USDC)
    leg3_yield_usdc = borrowUsdc     × usdcDepositApy      (USDC)

With numbers:

    leg1 = 10      × 1.8%    = 0.18 WETH
    leg2 = 14,000  × 6.5%    = 910 USDC
    leg3 = 14,000  × 4.71%   = 659.40 USDC

Two legs are in USDC. One leg is in WETH. They cannot be summed yet.

## Step 2 — Convert every leg to USD

Use current ETH price. USDC ≈ $1.

    leg1_usd = leg1_yield_weth × ethPrice
    leg2_usd = leg2_cost_usdc  × 1
    leg3_usd = leg3_yield_usdc × 1

With numbers:

    leg1_usd = 0.18 × $2,000 = $360
    leg2_usd = $910
    leg3_usd = $659.40

## Step 3 — Net yield in USD

    net_usd = leg1_usd − leg2_usd + leg3_usd
            = $360 − $910 + $659.40
            = $109.40

## Step 4 — Express the APY

The user's principal in USD is:

    principal_usd = collateralWeth × ethPrice = $20,000

APY on the principal:

    net_apy = net_usd / principal_usd
            = $109.40 / $20,000
            = 0.55%

## The hidden ETH price

Notice: ethPrice appeared twice — once to convert leg1 to USD, once to build principal_usd. When we divide, these two ethPrice values cancel:

    net_apy = (collateralWeth × wethSupplyApy × ethPrice
              + borrowUsdc × (usdcDepositApy − usdcBorrowApy))
              / (collateralWeth × ethPrice)

Split the division:

    net_apy = wethSupplyApy
            + (borrowUsdc × (usdcDepositApy − usdcBorrowApy))
              / (collateralWeth × ethPrice)

And borrowUsdc = principal_usd × ltv = collateralWeth × ethPrice × ltv. Substitute:

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)

Same shortcut formula as before. Just derived rigorously.

## Why this version is important

Leg1 produces WETH, not USD. The earlier derivation wrote `collateralUsd × wethSupplyApy` without the explicit conversion. That conversion step is now visible (Step 2 uses ethPrice on leg1).

The final formula only works because ethPrice appears in both numerator (converting leg1) and denominator (principal_usd), and cancels. This cancellation happens exactly once per year using ONE ethPrice snapshot. If ETH price drifts during the year, the two ethPrice values are not actually equal and the cancellation is imperfect. That is the source of the "flat ETH price" caveat.

## Numerical check

Plug the same inputs into the shortcut:

    net_apy = 1.8% + 0.70 × (4.71% − 6.5%)
            = 1.8% + 0.70 × (−1.79%)
            = 1.8% − 1.253%
            = 0.547%

Matches the rigorous calc (0.55%).
