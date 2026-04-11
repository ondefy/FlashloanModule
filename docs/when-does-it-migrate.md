# When Does the System Migrate?

There are only 2 situations where the system moves your position.

---

## Situation 1: Save Money

The other protocol is meaningfully cheaper for your position.

### The Scenario

You have a position on Aave. Market conditions change and Aave becomes expensive.

### Your Position

- 1 WETH collateral (worth $2,000)
- 1,700 USDC debt

### What Changed

Aave's borrow rate spiked to 12% (this happens during volatile markets).
Morpho's borrow rate stayed at 4.81%.

### What You're Paying Right Now (on Aave)

```
Collateral earnings:  $2,000 × 0.3% = $6 per year
Debt cost:            $1,700 × 12%  = $204 per year

You're paying $198 per year net
```

### What You'd Pay on Morpho

```
Collateral earnings:  $0 per year (Morpho collateral earns nothing)
Debt cost:            $1,700 × 4.81% = $82 per year

You'd pay $82 per year net
```

### The Decision

```
Savings = $198 - $82 = $116 per year

$116 is more than the $10 minimum threshold
Rates have been stable for over 1 hour
Last migration was more than 6 hours ago
Health factor is above 1.5
Debt is above $100

All checks pass → System migrates to Morpho
```

### What Happens

The system executes a flashloan that moves the entire position in one transaction:

1. Borrow USDC via flashloan (free, 0% fee)
2. Repay all debt on Aave
3. Withdraw all WETH from Aave
4. Deposit WETH on Morpho
5. Borrow USDC from Morpho
6. Repay the flashloan

Done. Position is now on Morpho. You're saving $116 per year.

If any step fails, nothing happens. The transaction is atomic.

### When This Doesn't Happen

- Savings are under $10/year → not worth it
- Rates spiked 5 minutes ago → system waits for 1-hour average to confirm
- You already migrated 3 hours ago → system waits for 6-hour cooldown
- Your health factor is below 1.5 → too risky to move
- Your debt is under $100 → too small to bother

---

## Situation 2: Avoid Liquidation

Your health factor is dropping dangerously. The system protects your position before it gets liquidated.

### The Scenario

You have a position on Aave. ETH price drops sharply. Your health factor is falling.

### Your Position

- 1 WETH collateral (was $2,500, now dropped to $2,000)
- 1,600 USDC debt

### The Problem

Each protocol liquidates at a different threshold:

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

### What the System Does

**Step 1: Try E-Mode First (Cheapest Fix)**

The system checks: is e-mode enabled on Aave? No.

So it enables e-mode. This is just one transaction — no flashloan, no moving funds. It raises the liquidation threshold from 83% to 93%.

```
New HF = ($2,000 × 0.93) / $1,600
New HF = 1.16

1.16 is much safer. Problem solved without migrating.
```

**Step 2: If E-Mode Isn't Enough**

If e-mode was already on and HF is still dropping, the system checks which protocol gives a higher health factor:

```
On Aave (e-mode):   HF = ($2,000 × 0.93) / $1,600 = 1.16
On Morpho:          HF = ($2,000 × 0.86) / $1,600 = 1.075
```

Aave e-mode is better (1.16 vs 1.075), so it stays on Aave.

But if the user was on Morpho and HF was dropping:

```
On Morpho:          HF = ($2,000 × 0.86) / $1,600 = 1.075
On Aave (e-mode):   HF = ($2,000 × 0.93) / $1,600 = 1.16
```

System migrates to Aave and enables e-mode. Health factor jumps from 1.075 to 1.16.

### The Decision

```
Health factor is below 1.3 (danger zone)
E-mode is not enabled
Enabling e-mode raises HF by 0.12 (more than the 0.05 minimum)
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

### Why This Matters

Without this protection:
- ETH price drops → HF falls to 1.04 → one more small drop → liquidation → user loses funds

With this protection:
- ETH price drops → HF falls to 1.04 → system enables e-mode → HF jumps to 1.16 → user is safe

The system acts automatically. The user doesn't need to do anything.

### When This Doesn't Happen

- Health factor is above 1.3 → no danger, no action needed
- Health factor is below 1.05 → too late, position is already being liquidated
- Target protocol doesn't give at least 0.05 better HF → not enough improvement
- Last migration was less than 1 hour ago → cooldown active

---

## Key Differences Between the Two Situations

| | Save Money | Avoid Liquidation |
|--|------------|-------------------|
| Why | Other protocol is cheaper | Health factor is dangerously low |
| Trigger | Savings above $10/year | Health factor below 1.3 |
| Cooldown | 6 hours | 1 hour (it's urgent) |
| Cares about rates? | Yes | No (safety first) |
| First action | Migrate | Enable e-mode (cheaper) |
| Minimum savings | $10/year or 1% of debt | Not applicable |

---

## Current State (April 2026)

```
Aave:   1.71% supply on WETH,  3.89% borrow on USDC
Morpho: 0% supply on WETH,     4.81% borrow on USDC
```

No migration happens right now. Aave is cheaper because it has a lower borrow rate AND pays interest on collateral.

The system monitors rates every 60 seconds. As soon as conditions change and one of the two situations above is triggered, it migrates automatically.
