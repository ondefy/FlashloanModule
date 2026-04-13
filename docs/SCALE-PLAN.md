# SCALE PLAN — Backend Scalability Roadmap

**Goal:** Scale backend to 20k+ users without changing smart contracts.
**Status:** Planning — not started.
**Owner:** Sunny
**Last updated:** 2026-04-13

---

## Current State (baseline)

Backend works for ~500–1,000 users. Will break beyond that.

### Known bottlenecks
- [ ] `monitor.service.ts` uses `setInterval` + per-user loop → RPC explosion at scale
- [ ] `onboarding.service.ts` keeps pending ops in in-memory `Map` → lost on restart, breaks horizontal scaling
- [ ] `session-executor.service.ts` submits UserOps serially → thundering herd on concurrent user actions
- [ ] Only one bundler (Pimlico) → single point of failure
- [ ] `vault.service.ts` has protocol branches (Aave/Morpho) → adding Compound/Silo requires refactor
- [ ] No rate service, no rebalancer worker, no event listener (flagged in CLAUDE.md)
- [ ] No circuit breakers, no structured logging, no tracing

### Target SLAs
| Metric | Target |
|---|---|
| Single deposit latency | 8–15s (unchanged) |
| 1,000 concurrent deposits | < 60s to drain |
| HF-critical event → UserOp submitted | < 60s |
| HF-critical → on-chain confirmed | < 2 min |
| Monitor capacity | 20k+ users |
| Infra budget | ~$1.5k/month @ 20k users |

---

## Phase 1 — Foundations (1–2 weeks)

**Goal:** Replace in-memory state with Redis, add queue system.

- [ ] Add Redis (Upstash managed or self-hosted)
- [ ] Add BullMQ with three queues:
  - [ ] `hf-critical` (priority 10, dedicated workers)
  - [ ] `rebalance` (priority 5)
  - [ ] `user-action` (priority 8)
- [ ] Migrate `onboarding.service.ts` pending-ops `Map` → Redis (keep 5-min TTL)
- [ ] Add per-Safe nonce lock: `SETNX safe:{addr}:key:{k}:seq EX 120`
- [ ] Idempotency: `jobId = keccak256(safe || nonceKey || seq)`
- [ ] Add Supabase tables:
  - [ ] `circuit_breakers` (bundler, rpc, gas, paymaster status)
  - [ ] `nonce_reservations`
  - [ ] `job_log` (for retries + audit)
- [ ] Add structured logging (pino) + per-request trace IDs
- [ ] Add Sentry for error tracking

**Exit criteria:** Server can restart without losing pending onboarding ops. Two backend replicas can run side-by-side.

---

## Phase 2 — Event-Driven Monitor (1–2 weeks)

**Goal:** Kill `setInterval` polling. Only check users whose position actually changed.

- [ ] Deploy Envio HyperIndex (self-hosted) indexing:
  - [ ] Aave V3 events: `Borrow`, `Repay`, `Supply`, `Withdraw`, `ReserveDataUpdated`
  - [ ] Morpho Blue events: `Supply`, `Borrow`, `Repay`, `Withdraw`, `Liquidate`
  - [ ] Chainlink `AnswerUpdated` for WETH/USD
- [ ] Indexer writes "dirty" userIds to Redis set on relevant events
- [ ] Worker pool consumes dirty set:
  - [ ] Multicall3 batch (200 users/call) for Aave `getUserAccountData`
  - [ ] Multicall3 batch for Morpho `position(marketId, user)` + `market(marketId)`
- [ ] Tiered re-check intervals (keep existing logic, event-driven now):
  - [ ] HF < 1.3 → 15s
  - [ ] HF 1.3–1.5 → 30s
  - [ ] HF 1.5–2.0 → 2min
  - [ ] HF > 2.0 → 10min
- [ ] Add 2-block confirmation for monitor reads (Base reorg safety)
- [ ] Shard workers by `userId % N` for horizontal scaling
- [ ] Delete old `setInterval` monitor code

**Exit criteria:** Monitor handles 20k users on Alchemy Scale tier without rate limits.

---

## Phase 3 — Execution Layer (2 weeks)

**Goal:** Parallelize UserOps safely. Survive bundler outages.

- [ ] Implement 2D nonce keys:
  - [ ] `key=0` → user-initiated ops
  - [ ] `key=1` → auto-rebalance
  - [ ] `key=2` → HF-critical emergency
- [ ] Nonce manager with Redis locks + atomic assignment
- [ ] Dual-bundler transport:
  - [ ] Pimlico Alto (primary)
  - [ ] Alchemy Rundler (secondary)
  - [ ] Health-checked round-robin + failover on AA25/AA22
- [ ] Retry/replace-by-nonce patterns (OZ Defender style):
  - [ ] Gas bump on stall
  - [ ] No-op replacement to unstick deadlocked sender
  - [ ] Poll by `transactionId`, not tx hash
- [ ] Circuit breakers:
  - [ ] Per bundler
  - [ ] Per RPC
  - [ ] Gas price threshold
  - [ ] Paymaster balance low
  - [ ] Auto-pause automation when breaker opens
- [ ] Surface breaker status to frontend (transparency)

**Exit criteria:** 1,000 concurrent deposits drain in <60s. Pimlico outage does not block users.

---

## Phase 4 — Rebalancer Engine (2–3 weeks)

**Goal:** Autonomous rebalancing at scale with fairness + prioritization.

- [ ] Rate service with Redis cache:
  - [ ] 30s TTL for protocol rates
  - [ ] 5s TTL for per-user HF
- [ ] Rebalance scoring worker:
  ```
  score = risk_weight * (1 / max(HF - 1, 0.01))
        + value_weight * log(position_usd)
        + staleness_weight * seconds_since_last_check
        + opportunity_weight * apy_delta
        - fairness_penalty * consecutive_skips
  ```
- [ ] Map score → BullMQ priority (0–10)
- [ ] Fairness:
  - [ ] Cap 1 job per user in-flight
  - [ ] Exponential cooldown after successful rebalance (prevent thrash)
- [ ] Temporal workflow (optional) for flashloan saga:
  - [ ] quote → simulate → build UserOp → submit → confirm → reconcile DB
  - [ ] Per-step retry with gas re-quoting
- [ ] Simulation pre-check before submit (catch reverts early)
- [ ] Per-user `automation_enabled` flag + `max_slippage_bps` + `min_apy_delta_bps`

**Exit criteria:** 10k users with active positions rebalanced as needed within 30–60 min. HF-critical cases handled in <60s.

---

## Phase 5 — Protocol Adapter Refactor (1 week)

**Goal:** Adding a new lending market = new file, not a refactor.

- [ ] Define `LendingAdapter` interface:
  ```ts
  interface LendingAdapter {
    getPosition(user: Address): Promise<Position>
    buildSupply(user, token, amount): Call
    buildBorrow(user, token, amount): Call
    buildRepay(user, token, amount): Call
    buildWithdraw(user, token, amount): Call
    healthFactor(user): Promise<bigint>
    getSupplyApy(token): Promise<number>
    getBorrowApy(token): Promise<number>
  }
  ```
- [ ] Extract `AaveAdapter` from `vault.service.ts`
- [ ] Extract `MorphoBlueAdapter` from `vault.service.ts`
- [ ] `vault.service.ts` becomes thin dispatcher over adapter registry
- [ ] Document how to add a new protocol:
  1. Write `XAdapter implements LendingAdapter`
  2. Register in adapter registry
  3. Add target+selector entries to TargetRegistry on-chain (already a config op)

**Exit criteria:** Adding Compound/Silo takes <1 day of work, no changes to vault.service.ts core logic.

---

## Phase 6 — Production Hardening (ongoing)

- [ ] RPC: dedicated provider (Alchemy Scale / QuickNode Growth) + fallback
- [ ] Supabase: read replicas + pgBouncer connection pooling
- [ ] Horizontal scaling: stateless API behind load balancer
- [ ] Workers scale independently by queue
- [ ] Metrics dashboard (Grafana / Datadog):
  - [ ] Queue depth per priority
  - [ ] UserOp success rate per bundler
  - [ ] Monitor re-check latency
  - [ ] HF distribution histogram
- [ ] Alerting:
  - [ ] Queue backlog > threshold
  - [ ] Bundler failure rate > 5%
  - [ ] Any HF < 1.05 not rebalanced in 60s
- [ ] Load testing: simulate 20k users, 1k concurrent deposits, 100 HF-critical events
- [ ] Runbooks for common incidents

---

## Infra Cost Estimate @ 20k users

| Component | Monthly |
|---|---|
| Alchemy Scale (RPC) | $500 |
| Pimlico bundler | $200–500 |
| Supabase Pro | $25 |
| Redis (Upstash) | $20–100 |
| Envio indexer (self-hosted) | $100–300 |
| Observability (Sentry, logs, metrics) | $100 |
| **Total** | **~$1,000–1,500** |

Scales with chain operations, not user count.

---

## Dependencies / Decisions Needed

- [ ] Confirm Redis provider (Upstash vs self-hosted vs Railway)
- [ ] Confirm indexer choice (Envio vs Ponder vs Goldsky)
- [ ] Decide if Temporal is worth adding for the flashloan saga (or stick with BullMQ only)
- [ ] Confirm opt-in vs opt-out automation model
- [ ] Confirm HF-critical SLA (currently targeting <60s)

---

## Not In Scope

- Smart contract changes (frozen per decision 2026-04-13)
- Frontend work
- New protocol integrations until Phase 5 adapter refactor is done
- Multi-chain expansion
