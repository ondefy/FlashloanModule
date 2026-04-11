## When Does the System Migrate?

There are only **two situations** where the system migrates:

---

### Situation 1: Save Money (Cost Migration)

The other protocol is meaningfully cheaper for your position.

**Example:**  
You're on Aave. Aave borrow rate spikes to 12%.

- **Your position:** 1 WETH ($2,000), 1,700 USDC debt

**On Aave right now:**
- Earn: $6/year on collateral
- Pay: $204/year on debt  
- **Net:** paying $198/year

**On Morpho:**
- Earn: $0/year on collateral
- Pay: $82/year on debt  
- **Net:** paying $82/year

**Savings by moving to Morpho:** $116/year  
($116 > $10 threshold → **MIGRATE**)

> This only happens when the savings are over $10/year, rates have been stable for 1 hour, and the last migration was 6+ hours ago.

---

### Situation 2: Avoid Liquidation (Safety Migration)

Your health factor is dropping dangerously. The system moves your position to a protocol with a higher liquidation threshold — this instantly gives you more breathing room.

**Example:**  
ETH price drops. Your HF falls to 1.1 on Aave.

- **Your position:** 1 WETH ($2,000), 1,600 USDC debt

**On Aave (83% liquidation threshold):**
- HF = ($2,000 × 0.83) / $1,600 = 1.04  ← *about to get liquidated!*

**Step 1 — System enables Aave e-mode (93% threshold):**
- HF = ($2,000 × 0.93) / $1,600 = 1.16  ← *safe again, no migration needed*

If e-mode was already on and HF is still low:

**Step 2 — Move to Morpho (86% threshold):**
- HF = ($2,000 × 0.86) / $1,600 = 1.075  ← *buys some room*

> This triggers when HF drops below 1.3. The system doesn't care about cost here — it just wants to keep the position alive.

---

## When Does It **NOT** Migrate?

- Savings are tiny (under $10/year) → not worth gas
- Health factor is fine (above 1.5) and current protocol is cheaper → stay put
- Rates just spiked 5 minutes ago → wait for 1-hour average to confirm
- Last migration was 2 hours ago → wait for 6-hour cooldown
- Position is tiny (under $100 debt) → skip

> Right now with current rates (Aave borrow 3.89%, Morpho borrow 4.81%, Morpho collateral 0%), no migration happens. Aave is always cheaper. The system is waiting for a rate shift.