# Carry Trade — Full Context and Plan

Snapshot of everything discussed so far. Use this as the pickup point for the next session.

## Product goal

Deposit WETH → borrow USDC → redeposit USDC into a high-yield pool. User stays long ETH. We return one APY expressed on the WETH principal.

## What is already built

- `/quote` endpoint (POST /api/strategy/carry-trade/quote) — calculates net APY, returns best + alternatives ranked. Reads Aave V3 rates on-chain and fetches USDC yield pools from the Degen API (`{DEFI_API_URL}/api/v2/opportunities/degen-strategies`). Quality gates: TVL ≥ $1M, liquidity ≥ $500k, utilization ≤ 95%.
- Net APY formula: `wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)`
- Response includes per-leg breakdown, scenarios (supplyOnly vs carryTrade vs improvement), and `netApyInWeth` headline number.
- Docs: CARRY-TRADE.md, CARRY-TRADE-EXAMPLE.md, CARRY-TRADE-FORMULA.md, CARRY-TRADE-FORMULA-RIGOROUS.md

## Existing backends

**Our backend (FlashloanModule):**
- Aave supply/borrow/repay/withdraw calldata
- UnifiedFlashloanModule (Aave ↔ Morpho atomic collateral swap)
- GuardedExecModule + TargetRegistry (selector whitelist)
- session-executor.service.ts (UserOp signing + submit)
- monitor.service.ts (HF polling, tiered intervals)
- strategy.service.ts (the /quote logic)
- Supabase positions table

**Utkir's execution backend (existing, separate):**
- USDC lending only (no borrow, no Aave, no HF)
- Already has: opportunity analysis, continuous monitoring, APY-stability + TVL-stability + liquidity checks, rebalance, execution
- Battle-tested on USDC-only strategies

## Founder's direction

Don't build a parallel system. Plan how the carry trade fits into the existing execution backend (utkir's) using the checks and infra already running. Show how a live carry trade position is continuously monitored and kept profitable, reusing what's there.

## Architecture decision — hybrid split

Three options were considered:

1. Build everything in our backend (duplicates utkir's USDC logic, risks state drift)
2. Expose rebalance-check endpoints and let utkir execute everything (utkir's backend has no Aave borrow/repay surface — big new work for him)
3. **Hybrid split (recommended)** — each backend does what it is already good at

Hybrid split:

- **Our backend owns:** entry, exit, HF monitoring, Aave ↔ Morpho collateral migration (uses flashloan module), the carry_trade_positions DB, and session key for Aave-touching ops.
- **Utkir's backend owns:** USDC-leg pool-to-pool rebalance (pure USDC lending — exactly what his backend already does). Reuses his existing APY/TVL/liquidity stability checks.
- **Shared decision layer:** a `/carry-trade/rebalance-check` endpoint on our side computes live net APY + profitability verdict. Both backends read from it to stay aligned.

## How monitoring works under the split

Per tick (handled inside our monitor.service.ts):

1. HF check (ours) — unchanged from today. Protects the borrow side.
2. Net APY recompute — `wethSupplyApy + ltv × (usdcDepositApy − usdcBorrowApy)` using live Aave rates + current USDC pool APY.
3. Compare to entry_net_apy. Rules:
   - live ≥ 50% of entry → keep
   - live < 50% of entry → flag, check if migration beats current
   - live ≤ 0 → auto-exit
   - new pool beats current by ≥ threshold → emit "migrate USDC leg" signal

Utkir's backend keeps running its own APY/TVL stability checks on the USDC pool. When it signals instability OR we signal a better pool, his backend performs the USDC-leg pool-to-pool swap (simple withdraw + deposit).

## Phase split for shipping

**Phase A — no flashloan needed:**
- Entry endpoint (POST /api/strategy/carry-trade/execute) — batched Safe UserOp: Aave supply WETH → Aave borrow USDC → approve + deposit into chosen pool
- Exit endpoint (POST /api/strategy/carry-trade/exit) — reverse sequence
- carry_trade_positions Supabase table
- Net APY pass added to monitor.service.ts
- Per-pool deposit/withdraw adapter (starts with ERC4626 for Morpho vaults)
- TargetRegistry whitelist entries for each supported pool

**Phase B — uses existing flashloan module:**
- Aave ↔ Morpho collateral migration (already implemented in UnifiedFlashloanModule, just plug in)
- USDC-leg pool-to-pool migration (no flashloan, utkir's backend handles it)

## Open questions for the team

1. Where does utkir's backend store/use session keys today? Can it sign Aave borrow UserOps, or only USDC-pool deposits?
2. Is the user's Safe shared between both backends, or does each have its own per user?
3. Who owns the HF monitor if Option 2 were ever revisited? (HF must be someone's job.)
4. How do the two backends communicate? Shared DB read, queue/event, or HTTP webhook?

These answers finalize the exact split.

## Next steps

1. Get answers to the 4 open questions above.
2. Confirm the hybrid split with the team.
3. Finalize the `/execute` and `/exit` endpoint shape.
4. Draft Supabase migration for `carry_trade_positions` (+ optional snapshots table).
5. Draft the per-pool adapter interface (ERC4626 first).
6. Add TargetRegistry whitelist migration for supported pools.
7. Extend monitor.service.ts with net APY pass and emit signals for utkir's side.

## Files to read on session pickup

- docs/CARRY-TRADE.md — feature spec + sample response
- docs/CARRY-TRADE-FORMULA.md + CARRY-TRADE-FORMULA-RIGOROUS.md — math
- docs/CARRY-TRADE-EXECUTION-PLAN.md — previous execution plan (pre-hybrid-split)
- docs/CARRY-TRADE-CONTEXT-AND-PLAN.md — this file
- backend/src/services/strategy.service.ts — /quote implementation
- backend/src/services/vault.service.ts — Aave calldata + getProtocolRates
- backend/src/services/monitor.service.ts — where net APY pass will be added
