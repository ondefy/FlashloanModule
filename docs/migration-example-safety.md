# Migration Example: Avoid Liquidation

## The Scenario

You have a position on Aave. ETH price drops sharply. Your health factor is falling toward liquidation.

## Your Position

- 1 WETH collateral (was $2,500, now dropped to $2,000)
- 1,600 USDC debt

## The Problem

Each protocol has a different liquidation threshold — the point where your position gets liquidated.

```
Aave (normal mode):  liquidates at 83% LTV
Aave (e-mode):       liquidates at 93% LTV
Morpho:              liquidates at 86% LTV
```

Your health factor on Aave right now:

```
HF = (Collateral × Liquidation Threshold) / Debt
HF = ($2,000 × 0.83) / $1,600
HF = 1.04

1.04 is dangerously close to 1.0 (= liquidation)
```

## What the System Does

### Step 1: Try E-Mode First (Cheapest Fix)

The system checks: is e-mode enabled on Aave?

No. So it enables e-mode. This is just one transaction — no flashloan needed, no moving funds.

E-mode raises the liquidation threshold from 83% to 93%.

```
New HF = ($2,000 × 0.93) / $1,600
New HF = 1.16

1.16 is much safer. Problem solved without migrating.
```

### Step 2: If E-Mode Isn't Enough

If e-mode was already on and HF is still dropping, the system checks if Morpho would be safer:

```
On Aave (e-mode):   HF = ($2,000 × 0.93) / $1,600 = 1.16
On Morpho:          HF = ($2,000 × 0.86) / $1,600 = 1.075
```

In this case Aave e-mode (1.16) is better than Morpho (1.075), so it stays on Aave.

But if the user was on Morpho and HF was dropping:

```
On Morpho:          HF = ($2,000 × 0.86) / $1,600 = 1.075
On Aave (normal):   HF = ($2,000 × 0.83) / $1,600 = 1.04   ← worse
On Aave (e-mode):   HF = ($2,000 × 0.93) / $1,600 = 1.16   ← better
```

System would migrate to Aave and enable e-mode. Health factor jumps from 1.075 to 1.16.

## The Decision

```
Health factor is 1.04 (below the 1.3 danger threshold)
E-mode is not enabled
Enabling e-mode would raise HF by 0.12 (more than the 0.05 minimum improvement)
Last migration was more than 1 hour ago

→ Enable e-mode
```

If e-mode alone isn't enough:

```
Health factor is still below 1.3
Target protocol gives at least 0.05 better HF
Last migration was more than 1 hour ago

→ Migrate to the safer protocol
```

## Why This Matters

Without this protection:
- ETH price drops → HF falls to 1.04 → another small drop → liquidation → user loses funds

With this protection:
- ETH price drops → HF falls to 1.04 → system enables e-mode → HF jumps to 1.16 → user is safe

The system acts automatically. The user doesn't need to do anything.

## Key Differences from Cost Migration

| | Cost Migration | Safety Migration |
|--|----------------|------------------|
| **Why** | Save money | Prevent liquidation |
| **Trigger** | Other protocol is cheaper | Health factor below 1.3 |
| **Cooldown** | 6 hours | 1 hour (faster, it's urgent) |
| **Cares about rates?** | Yes | No (safety first) |
| **First action** | Migrate | Enable e-mode (cheaper) |
| **Minimum savings** | $10/year | Not applicable |
