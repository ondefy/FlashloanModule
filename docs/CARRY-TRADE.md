# Carry Trade Strategy

## Purpose

User deposits WETH, borrows USDC against it, redeposits that USDC into a yield pool. We return one APY shown on the WETH principal.

## Solution

1. Get WETH supply APY and USDC borrow APY from Aave V3 on Base.
2. Get USDC yield pools from the Degen API. Filter. Pick the best.
3. Compute net APY.

## Degen API

    GET {DEFI_API_URL}/api/v2/opportunities/degen-strategies?status=live&asset=USDC&chainId=8453

Env:

    DEFI_API_URL=https://defiapi.zyf.ai
    OTHER_BACKEND_API_KEY=<optional>

Fields used: `protocol_name`, `pool_name`, `pool_address`, `combined_apy`, `tvl`, `liquidity`, `interestratestrategy.utilization`.

Filters:

- status = live
- tvl ≥ $1,000,000
- liquidity ≥ $500,000
- utilization ≤ 95%
- combined_apy > 0

Sort remaining by net APY. Return best + top N-1 alternatives (default N=3).

## Formula

    net_apy = wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)

That is it. The USD principal cancels out in the algebra, so the number works as an APY on the WETH deposit.

## Example (10 WETH, 70% LTV, ETH=$2,000)

    wethSupplyApy   = 1.8%
    usdcBorrowApy   = 6.5%
    usdcDepositApy  = 4.71%

    net_apy = 1.8% + 0.70 × (4.71% − 6.5%)
            = 1.8% − 1.25%
            = 0.55%

Yearly yield: 0.0055 × $20,000 = $109.40 = 0.0547 WETH.

Supply-only (no borrow) would earn 1.80% = $360. Carry trade is worse here because USDC deposit APY < USDC borrow APY.

## Scenarios in Response

- supplyOnly — just deposit WETH, APY = wethSupplyApy.
- carryTrade — full loop, APY from formula above.
- improvement — delta. `worthIt = true` when carryTrade > supplyOnly.

## API

    POST http://localhost:3001/api/strategy/carry-trade/quote

Request:

    {
      "collateralAmount": 10,
      "collateralAsset": "WETH",
      "ltv": 0.70,
      "topN": 3
    }

Response example:

    {
      "input": {
        "collateralAsset": "WETH",
        "collateralAmount": 10,
        "ltv": 0.70,
        "ethPriceUsd": 2000
      },
      "collateral": {
        "asset": "WETH",
        "amount": 10,
        "usdValue": 20000,
        "protocol": "Aave V3",
        "supplyApy": 0.018,
        "supplyApyPct": 1.80
      },
      "borrow": {
        "asset": "USDC",
        "amount": 14000,
        "usdValue": 14000,
        "borrowApy": 0.065,
        "borrowApyPct": 6.50
      },
      "best": {
        "deposit": {
          "protocol": "Morpho",
          "poolName": "Steakhouse High Yield USDC",
          "poolAddress": "0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F",
          "combinedApy": 0.0471,
          "combinedApyPct": 4.7125,
          "tvlUsd": 24391192.49,
          "liquidityUsd": 7498536.52,
          "utilizationPct": 90.0,
          "url": "https://app.morpho.org/base/vault/0xBEEFA7B88064FeEF0cEe02AAeBBd95D30df3878F/steakhouse-high-yield-usdc-v11"
        },
        "legs": {
          "wethSupply":  { "yieldWeth": 0.18,   "yieldUsd": 360 },
          "usdcBorrow":  { "costUsdc":  910,    "costUsd":  910 },
          "usdcDeposit": { "yieldUsdc": 659.75, "yieldUsd": 659.75 }
        },
        "breakdown": {
          "wethSupplyApy":      0.018,
          "usdcDepositApy":     0.0471,
          "usdcBorrowApy":      0.065,
          "usdcLegSpread":     -0.0179,
          "usdcLegWeightedApy": -0.0125
        },
        "scenarios": {
          "supplyOnly": {
            "description": "Just deposit 10 WETH on Aave. No borrow.",
            "yearlyYieldWeth": 0.18,
            "yearlyYieldUsd": 360,
            "netApy": 0.018,
            "netApyPct": 1.80
          },
          "carryTrade": {
            "description": "Deposit 10 WETH, borrow 14000 USDC at 70% LTV, redeposit USDC in Steakhouse High Yield USDC.",
            "yearlyYieldWeth": 0.0549,
            "yearlyYieldUsd": 109.75,
            "netApy": 0.0055,
            "netApyPct": 0.55
          },
          "improvement": {
            "deltaApy": -0.0125,
            "deltaApyPct": -1.25,
            "deltaYieldUsd": -250.25,
            "deltaYieldWeth": -0.1251,
            "worthIt": false
          }
        },
        "netApyInWeth": 0.0055,
        "netApyInWethPct": 0.55,
        "profitable": true,
        "warnings": [
          "USDC deposit APY (4.71%) is below borrow APY (6.50%) — negative carry on the USDC leg",
          "Carry trade is WORSE than just supplying WETH — user should skip the borrow",
          "High utilization (90.0%) — withdrawal liquidity may be limited"
        ]
      },
      "alternatives": [
        /* next 2 opportunities, same shape as `best` */
      ],
      "fetchedAt": "2026-04-13T17:45:00.000Z"
    }

## File Map

- `backend/src/services/strategy.service.ts`
- `backend/src/routes/strategy.routes.ts`
- `backend/src/index.ts`
- `backend/src/config/env.ts`
- `docs/CARRY-TRADE-EXAMPLE.md`

## Test

    cd backend && yarn dev

    curl -X POST http://localhost:3001/api/strategy/carry-trade/quote \
      -H 'Content-Type: application/json' \
      -d '{"collateralAmount": 10, "ltv": 0.70}'
