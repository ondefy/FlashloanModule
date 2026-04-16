# Carry Trade — Monitoring and Decision Rules

How a carry trade position is watched, when it migrates, when it exits, and which backend does which part of the work.

## Two backends

The data backend tracks all market-level information: rates on every supported lending protocol, ETH price, pool APY, pool TVL, liquidity, utilization, stability flags. It knows nothing about individual users. It exposes REST endpoints for current state and a WebSocket stream for change events.

The execution backend owns the user layer. It holds the user table, each user's Safe address, session keys, active positions, and debt/collateral amounts. It reads per-user health factor directly from on-chain protocols when needed. It signs and submits user operations. When it needs market context it either calls the data backend's REST endpoints or subscribes to the WebSocket stream.

Put simply: the data backend answers "what is the market doing right now?" and the execution backend answers "given what the market is doing, what should this user do?"

## How the flow works

When a user deposits WETH for the first time the execution backend asks the data backend for the best carry trade opportunity. If the best carry's net APY does not beat plain WETH supply by a meaningful margin, the position is created as lending only — WETH is supplied on whichever protocol pays the most, no borrow, no downstream pool. If the carry does beat supply-only, the execution backend builds a single batched user operation that supplies WETH, borrows USDC against it, and deposits that USDC into the chosen pool.

Once the position exists, monitoring runs continuously. Two signals feed it. The slow signal is a short cron on the execution backend (typically one minute) that iterates active carry positions and reads each Safe's health factor from Aave on-chain. The fast signal is the WebSocket stream from the data backend: when a material market event happens — borrow rate jumps, ETH price drops, a pool's stability flips, a pool's utilization spikes — the execution backend receives an event within seconds and reacts immediately for the users that event affects. The cron is the safety net; the WebSocket is how we beat the rebalance window.

Actions fall into four families: hold, migrate, reduce, exit. Hold means keep the position as-is. Migrate moves a leg of the position to a better venue. Reduce means partially repay USDC to cut LTV and raise HF without fully unwinding. Exit closes the carry entirely and returns to lending-only or out to the user.

## Protocol choice for the collateral leg

The current carry trade endpoint computes net APY using Aave as the supply venue for WETH. That's a simplification that should be lifted. On Aave, supplying WETH earns a real supply APY (typically 1–2%). On Morpho Blue, collateral does not earn anything — it sits idle as security for the market. Morpho Blue's USDC borrow rate is often lower than Aave's, so the tradeoff is real: Aave gives you free WETH yield but charges more to borrow; Morpho charges less to borrow but the WETH leg earns zero.

The right answer is to compute the carry for both and return whichever has the higher net APY per USDC pool. The data backend already reads Aave rates on-chain and already has Morpho integration for pool data, so this is an extension of the existing rate utility, not new infrastructure. Until this is built, assume Aave for collateral; once built, each carry opportunity row will include which protocol to supply into.

## Decision rules

### Creating a position

A first deposit becomes a lending-only position when no carry opportunity beats the best pure WETH supply by at least 0.5%. It becomes a carry trade when the best carry opportunity beats supply-only by 0.5% or more. For an existing lending user, if a carry becomes profitable later by the same margin, the position converts to carry — add the borrow and the USDC pool leg. For an existing carry user, if the net APY falls below supply-only, convert back to lending — close the USDC legs and keep WETH supplied.

### Collateral side — the WETH supply leg

If another lending protocol starts paying a materially better WETH supply rate (25 bps net of gas is a reasonable bar), the collateral should move. While USDC debt is active this move requires a flashloan — supplies on one protocol cannot be moved to another without repaying the debt first, and the flashloan lets us do both atomically. If the user is in lending-only mode with no debt, the migration is just a sequential withdraw and redeposit, no flashloan.

If the current supply protocol freezes WETH reserves, reduces the LTV cap below what the user holds, or otherwise degrades, the same migration runs as an emergency case. Priority is safety, not APY.

### USDC deposit leg — the yield pool

The USDC leg is liquid by design and never requires a flashloan to move. Migration triggers include: a better pool opens up and beats the current pool by 25 bps with gas payback under ten days; the current pool's utilization climbs past 95%, making withdrawals uncertain; the pool's TVL drops more than 20% in an hour; the data backend's stability flags flip from stable to unstable on APY or TVL; the pool goes offline or is marked not-live. In all cases the move is withdraw from pool A, approve, deposit into pool B, done in a single user operation.

### Borrow leg — the USDC debt

The borrow leg is the one that can kill the carry's profitability. If Aave's USDC borrow rate spikes and the net APY crosses zero, the carry leg is closed — the position reverts to lending only. If the net APY is still positive but below half of the entry APY, the response is to reduce LTV: partially repay USDC, shrink the leveraged spread, and improve HF at the same time. If another venue offers a materially cheaper variable borrow rate, migrating the borrow across protocols is possible but requires a flashloan since collateral and debt are tied on the same venue.

### Health factor

HF above 1.5 is comfortable; keep monitoring. Between 1.3 and 1.5 the position is flagged and a small LTV reduction is prepared in case it drifts further. Between 1.1 and 1.3 the system notifies the user and stages an exit — at this level, waiting for the next scheduled cycle is too slow. Below 1.1 the execution backend force-exits immediately or, if the fall is fast and market is liquid, does an emergency partial repay to buy time. A special case: if HF is dropping sharply — more than 0.1 per minute — act immediately regardless of the absolute HF band.

### ETH price movement

The carry's USDC legs are dollar-denominated, so a sharp ETH drop hurts HF without touching borrow or deposit rates. Rules that work well in practice: on a 5% drop in five minutes, recompute HF for every active carry position and flag any below 1.3; on a 10% drop in an hour, auto-reduce LTV for users with HF below 1.4; on a 20% drop, emergency-exit users with HF below 1.2. When ETH pumps the pressure reverses — HF improves automatically, and the position can optionally take on slightly more USDC borrow to restore the target LTV.

### User-initiated changes

A top-up adds WETH to supply and optionally grows the borrow + redeposit leg proportionally so the LTV stays at target. A partial withdraw repays USDC first to keep HF above the 1.3 threshold, then withdraws the WETH. A full exit runs the standard unwind — pool withdraw, repay in full, withdraw WETH. Switching to lending-only is the same as a full carry close without withdrawing WETH.

### Protocol-level emergencies

If Aave's USDC market pauses new borrows, block new carry entries; existing ones continue unaffected. If Aave's WETH reserve is paused, no new collateral migrations into Aave, and migrations out should be prioritized. If a USDC pool is compromised or halts withdrawals, every user in that pool migrates immediately — USDC movement doesn't need a flashloan. If the flashloan module itself is paused, collateral migrations are blocked but existing carry positions continue to run. If the price oracle freshness fails, pause all automation and leave positions static until oracles recover.

## When a flashloan is needed

A flashloan is needed whenever we want to move the collateral or the borrow leg between protocols while the counter-leg is still active. That means migrating WETH from Aave to Morpho while USDC is borrowed, migrating USDC debt from Aave to Morpho while WETH is supplied, or swapping the collateral asset itself (out of scope for now). In all of those cases, the flashloan bridges the gap between closing the old position and opening the new one.

A flashloan is not needed for entering a carry, exiting a carry, migrating the USDC redeposit pool, partial repay, or partial withdraw. These are sequential operations that succeed or fail atomically within a single user operation via the Safe's execution module, without borrowing anything from outside.

## Event types on the WebSocket stream

The data backend already has a WebSocket server running at `/ws/events` with an EventBus and broadcaster. Existing event types include depeg, liquidity trap, and pool status change. For carry trade the bus needs a handful of additions: rate change (Aave WETH supply or USDC borrow moved beyond a threshold), ETH price move (short-interval price change), pool alert (utilization, TVL drop, or stability flip on any USDC pool), and carry APY change (the computed net APY for a pool crossed zero or moved materially). Each event carries the chain, affected protocol or pool, old and new values, and a timestamp. None of them carry a user ID — filtering to affected users is the execution backend's job.

## Ownership summary

The data backend owns all market data, publishes change events, and ranks carry opportunities. It is stateless with respect to users. The execution backend owns every user-specific thing — addresses, session keys, positions, HF reads, decision logic, and transaction submission. The flashloan module is a shared piece of on-chain infrastructure: the execution backend calls it when it needs to move collateral or debt across protocols while the counter-leg is active.

The rest is plumbing. Events flow one way, transactions flow one way, and the split keeps both backends doing what they are already good at.
