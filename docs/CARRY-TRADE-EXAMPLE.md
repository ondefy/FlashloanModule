# Carry Trade — Worked Example

## Inputs

- 10 WETH
- ETH price = $2,000 → principal = $20,000
- LTV = 70% → borrow = $14,000 USDC
- WETH supply APY = 1.8%
- USDC borrow APY = 6.5%
- USDC deposit APY = 4.71%

## Calculation

Leg 1 — WETH supply:

    0.18 WETH = $360

Leg 2 — USDC borrow cost:

    14,000 × 6.5% = 910 USDC = $910

Leg 3 — USDC deposit yield:

    14,000 × 4.71% = 659.40 USDC = $659.40

Net:

    $360 − $910 + $659.40 = $109.40

APY on WETH principal:

    $109.40 / $20,000 = 0.55%

## Shortcut formula

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)
            = 1.8% + 0.70 × (4.71% − 6.5%)
            = 0.55%

Same answer.

## Comparison

| Scenario | Yearly yield | APY |
|---|---|---|
| Supply-only | $360 | 1.80% |
| Carry trade | $109.40 | 0.55% |

Supply-only wins here because the USDC deposit APY is below the USDC borrow APY. Carry trade beats supply-only only when `usdcDepositApy > usdcBorrowApy`.

---

## Example 2 — Positive carry (USDC deposit 9%)

Same inputs, but pick a USDC pool at 9%.

    leg1 = $360
    leg2 = 14,000 × 6.5% = $910
    leg3 = 14,000 × 9%   = $1,260
    net  = $360 − $910 + $1,260 = $710
    apy  = $710 / $20,000 = 3.55%

Shortcut:

    net_apy = 1.8% + 0.70 × (9% − 6.5%) = 1.8% + 1.75% = 3.55%

| Scenario | Yearly yield | APY |
|---|---|---|
| Supply-only | $360 | 1.80% |
| Carry trade | $710 | 3.55% |

Carry trade wins by +1.75% APY.

---

## Example 3 — Positive carry at lower LTV (50%)

Same as Example 2 with LTV = 50%.

    borrow = $10,000
    leg1   = $360
    leg2   = $10,000 × 6.5% = $650
    leg3   = $10,000 × 9%   = $900
    net    = $360 − $650 + $900 = $610
    apy    = $610 / $20,000 = 3.05%

Shortcut:

    net_apy = 1.8% + 0.50 × (9% − 6.5%) = 1.8% + 1.25% = 3.05%

| Scenario | Yearly yield | APY |
|---|---|---|
| Supply-only | $360 | 1.80% |
| Carry trade | $610 | 3.05% |

Still positive, but lower than Example 2. Lower LTV = less borrow = smaller USDC profit leg.

---

## Example 4 — Strongly positive carry (USDC deposit 12%)

Same inputs as Example 1 but with a 12% USDC pool.

    leg1 = $360
    leg2 = $910
    leg3 = 14,000 × 12% = $1,680
    net  = $360 − $910 + $1,680 = $1,130
    apy  = $1,130 / $20,000 = 5.65%

Shortcut:

    net_apy = 1.8% + 0.70 × (12% − 6.5%) = 1.8% + 3.85% = 5.65%

| Scenario | Yearly yield | APY |
|---|---|---|
| Supply-only | $360 | 1.80% |
| Carry trade | $1,130 | 5.65% |

Carry trade wins by +3.85% APY.
