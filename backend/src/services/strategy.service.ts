import pino from 'pino';
import { getEnv } from '../config/env.js';
import { getProtocolRates } from './vault.service.js';

const logger = pino({ name: 'strategy-service' });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DegenOpportunity {
  id: number;
  protocol_name: string;
  pool_name: string;
  pool_address: string;
  combined_apy: number;
  pool_apy: number;
  rewards_apy: number;
  tvl: number;
  liquidity: number;
  chain_id: number;
  status: string;
  url?: string;
  collateral_symbols?: string[];
  interestratestrategy?: {
    utilization?: number;
    maxMarketUtilization?: number;
    currentSupplyApy?: number;
  };
}

interface DegenStrategiesResponse {
  status: string;
  data: DegenOpportunity[];
}

export interface CarryTradeQuoteInput {
  collateralAmount: number;     // e.g., 10 (meaning 10 WETH)
  collateralAsset: 'WETH';
  ltv?: number;                 // default 0.70, max 0.80
  topN?: number;                // how many opps to return, default 3
}

export interface CarryTradeQuote {
  input: {
    collateralAsset: string;
    collateralAmount: number;
    ltv: number;
    ethPriceUsd: number;
  };
  collateral: {
    asset: string;
    amount: number;
    usdValue: number;
    protocol: string;            // where WETH is supplied
    supplyApy: number;           // decimal (e.g. 0.018 = 1.8%)
    supplyApyPct: number;        // for display
  };
  borrow: {
    asset: string;
    amount: number;              // USDC to borrow
    usdValue: number;
    borrowApy: number;           // decimal
    borrowApyPct: number;
  };
  best: CarryStrategyResult;
  alternatives: CarryStrategyResult[];
  fetchedAt: string;
}

export interface CarryStrategyResult {
  deposit: {
    protocol: string;
    poolName: string;
    poolAddress: string;
    combinedApy: number;         // decimal
    combinedApyPct: number;      // for display
    tvlUsd: number;
    liquidityUsd: number;
    utilizationPct: number | null;
    url?: string;
  };
  legs: {
    wethSupply: { yieldWeth: number; yieldUsd: number };     // leg 1
    usdcBorrow: { costUsdc: number; costUsd: number };       // leg 2
    usdcDeposit: { yieldUsdc: number; yieldUsd: number };    // leg 3
  };
  breakdown: {
    wethSupplyApy: number;
    usdcDepositApy: number;
    usdcBorrowApy: number;
    usdcLegSpread: number;                 // depositApy - borrowApy
    usdcLegWeightedApy: number;            // ltv × spread
  };
  scenarios: {
    supplyOnly: {
      description: string;
      yearlyYieldWeth: number;
      yearlyYieldUsd: number;
      netApy: number;                      // = wethSupplyApy
      netApyPct: number;
    };
    carryTrade: {
      description: string;
      yearlyYieldWeth: number;
      yearlyYieldUsd: number;
      netApy: number;                      // final APY on WETH principal
      netApyPct: number;
    };
    improvement: {
      deltaApy: number;                    // carryTrade - supplyOnly
      deltaApyPct: number;
      deltaYieldUsd: number;
      deltaYieldWeth: number;
      worthIt: boolean;                    // carry > supply-only?
    };
  };
  netApyInWeth: number;                    // headline number, WETH-denominated
  netApyInWethPct: number;
  profitable: boolean;
  warnings: string[];
}

// ─── Quality gates ──────────────────────────────────────────────────────────

const MIN_TVL_USD = 1_000_000;
const MIN_LIQUIDITY_USD = 500_000;
const MAX_UTILIZATION = 0.95;
const MAX_LTV = 0.80;

// ─── Fetch from DeFi API ────────────────────────────────────────────────────

async function fetchUsdcOpportunities(chainId = 8453): Promise<DegenOpportunity[]> {
  const env = getEnv();
  const url = `${env.DEFI_API_URL}/api/v2/opportunities/degen-strategies?status=live&asset=USDC&chainId=${chainId}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.OTHER_BACKEND_API_KEY) headers['x-api-key'] = env.OTHER_BACKEND_API_KEY;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`DeFi API returned ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as DegenStrategiesResponse;
  if (body.status !== 'success' || !Array.isArray(body.data)) {
    throw new Error(`DeFi API unexpected response shape`);
  }
  return body.data;
}

// ─── Core filter + rank ─────────────────────────────────────────────────────

function filterOpportunities(opps: DegenOpportunity[]): DegenOpportunity[] {
  return opps.filter((o) => {
    if (o.status !== 'live') return false;
    if (o.tvl < MIN_TVL_USD) return false;
    if (o.liquidity < MIN_LIQUIDITY_USD) return false;
    const util = o.interestratestrategy?.utilization;
    if (util != null && util > MAX_UTILIZATION) return false;
    if (!o.combined_apy || o.combined_apy <= 0) return false;
    return true;
  });
}

// ─── Quote builder ──────────────────────────────────────────────────────────

export async function quoteCarryTrade(input: CarryTradeQuoteInput): Promise<CarryTradeQuote> {
  const ltv = input.ltv ?? 0.70;
  const topN = input.topN ?? 3;

  if (ltv <= 0 || ltv > MAX_LTV) {
    throw new Error(`ltv must be between 0 and ${MAX_LTV} (got ${ltv})`);
  }
  if (input.collateralAsset !== 'WETH') {
    throw new Error(`Only WETH collateral supported in v1 (got ${input.collateralAsset})`);
  }
  if (!Number.isFinite(input.collateralAmount) || input.collateralAmount <= 0) {
    throw new Error(`collateralAmount must be a positive number`);
  }

  // 1. Fetch lending protocol rates + ETH price
  const rates = await getProtocolRates();
  const ethPriceUsd = rates.ethPriceUsd;
  const collateralUsd = input.collateralAmount * ethPriceUsd;
  const borrowUsd = collateralUsd * ltv;
  // Borrow leg on Aave V3 (simpler, on-chain reliable rates). WETH supply also on Aave.
  const wethSupplyApy = rates.aave.collateralSupplyApy;
  const usdcBorrowApy = rates.aave.borrowApy;

  // 2. Fetch + filter USDC opps
  const allOpps = await fetchUsdcOpportunities(8453);
  const safe = filterOpportunities(allOpps);

  if (safe.length === 0) {
    throw new Error('No USDC opportunities passed quality gates (TVL, liquidity, utilization)');
  }

  // 3. Score each and sort by net APY (in ETH terms)
  const scored = safe.map((opp) => buildResult({
    opp,
    collateralAmountEth: input.collateralAmount,
    collateralUsd,
    borrowUsd,
    ltv,
    wethSupplyApy,
    usdcBorrowApy,
    ethPriceUsd,
  }));

  scored.sort((a, b) => b.netApyInWeth - a.netApyInWeth);

  const best = scored[0];
  const alternatives = scored.slice(1, topN);

  logger.info(
    { best: best.deposit.poolName, netApy: best.netApyInWeth, considered: safe.length },
    'Carry trade quote built',
  );

  return {
    input: {
      collateralAsset: input.collateralAsset,
      collateralAmount: input.collateralAmount,
      ltv,
      ethPriceUsd,
    },
    collateral: {
      asset: 'WETH',
      amount: input.collateralAmount,
      usdValue: round2(collateralUsd),
      protocol: 'Aave V3',
      supplyApy: wethSupplyApy,
      supplyApyPct: round4(wethSupplyApy * 100),
    },
    borrow: {
      asset: 'USDC',
      amount: round2(borrowUsd),        // USDC is ~$1, so borrowUsd ≈ units
      usdValue: round2(borrowUsd),
      borrowApy: usdcBorrowApy,
      borrowApyPct: round4(usdcBorrowApy * 100),
    },
    best,
    alternatives,
    fetchedAt: new Date().toISOString(),
  };
}

function buildResult(args: {
  opp: DegenOpportunity;
  collateralAmountEth: number;
  collateralUsd: number;
  borrowUsd: number;
  ltv: number;
  wethSupplyApy: number;
  usdcBorrowApy: number;
  ethPriceUsd: number;
}): CarryStrategyResult {
  const {
    opp, collateralAmountEth, collateralUsd, borrowUsd, ltv,
    wethSupplyApy, usdcBorrowApy, ethPriceUsd,
  } = args;

  const usdcDepositApy = (opp.combined_apy ?? 0) / 100; // API returns percent

  // ─── Leg-by-leg in native units ──────────────────────────────────────────
  const leg1YieldWeth = collateralAmountEth * wethSupplyApy;
  const leg1YieldUsd  = leg1YieldWeth * ethPriceUsd;

  const leg2CostUsdc  = borrowUsd * usdcBorrowApy;   // USDC ≈ $1
  const leg2CostUsd   = leg2CostUsdc;

  const leg3YieldUsdc = borrowUsd * usdcDepositApy;
  const leg3YieldUsd  = leg3YieldUsdc;

  // ─── Net in USD, then convert to WETH principal ──────────────────────────
  const netUsd  = leg1YieldUsd - leg2CostUsd + leg3YieldUsd;
  const netWeth = netUsd / ethPriceUsd;

  const netApyInWeth = collateralUsd > 0 ? netUsd / collateralUsd : 0;

  // ─── Scenario: supply-only (no borrow, no redeposit) ─────────────────────
  const supplyOnlyApy = wethSupplyApy;
  const supplyOnlyYieldWeth = collateralAmountEth * supplyOnlyApy;
  const supplyOnlyYieldUsd  = supplyOnlyYieldWeth * ethPriceUsd;

  // ─── Improvement delta ──────────────────────────────────────────────────
  const deltaApy       = netApyInWeth - supplyOnlyApy;
  const deltaYieldUsd  = netUsd - supplyOnlyYieldUsd;
  const deltaYieldWeth = netWeth - supplyOnlyYieldWeth;

  const spread = usdcDepositApy - usdcBorrowApy;
  const usdcLegWeightedApy = ltv * spread;

  const warnings: string[] = [];
  if (spread < 0) warnings.push(`USDC deposit APY (${pct(usdcDepositApy)}) is below borrow APY (${pct(usdcBorrowApy)}) — negative carry on the USDC leg`);
  if (netApyInWeth <= supplyOnlyApy) warnings.push(`Carry trade is WORSE than just supplying WETH — user should skip the borrow`);
  if (netApyInWeth <= 0) warnings.push(`Strategy is unprofitable at current rates`);
  if (netApyInWeth > 0 && netApyInWeth < 0.01) warnings.push(`Net APY below 1% — thin margin, gas + slippage likely erode further`);
  const util = opp.interestratestrategy?.utilization;
  if (util != null && util > 0.90) warnings.push(`High utilization (${(util * 100).toFixed(1)}%) — withdrawal liquidity may be limited`);

  return {
    deposit: {
      protocol: opp.protocol_name,
      poolName: opp.pool_name,
      poolAddress: opp.pool_address,
      combinedApy: round4(usdcDepositApy),
      combinedApyPct: round4(opp.combined_apy),
      tvlUsd: round2(opp.tvl),
      liquidityUsd: round2(opp.liquidity),
      utilizationPct: util != null ? round4(util * 100) : null,
      url: opp.url,
    },
    legs: {
      wethSupply:  { yieldWeth: round6(leg1YieldWeth), yieldUsd: round2(leg1YieldUsd) },
      usdcBorrow:  { costUsdc:  round2(leg2CostUsdc),  costUsd:  round2(leg2CostUsd)  },
      usdcDeposit: { yieldUsdc: round2(leg3YieldUsdc), yieldUsd: round2(leg3YieldUsd) },
    },
    breakdown: {
      wethSupplyApy:       round4(wethSupplyApy),
      usdcDepositApy:      round4(usdcDepositApy),
      usdcBorrowApy:       round4(usdcBorrowApy),
      usdcLegSpread:       round4(spread),
      usdcLegWeightedApy:  round4(usdcLegWeightedApy),
    },
    scenarios: {
      supplyOnly: {
        description: `Just deposit ${collateralAmountEth} WETH on Aave. No borrow.`,
        yearlyYieldWeth: round6(supplyOnlyYieldWeth),
        yearlyYieldUsd:  round2(supplyOnlyYieldUsd),
        netApy:          round4(supplyOnlyApy),
        netApyPct:       round4(supplyOnlyApy * 100),
      },
      carryTrade: {
        description: `Deposit ${collateralAmountEth} WETH, borrow ${round2(borrowUsd)} USDC at ${(ltv * 100).toFixed(0)}% LTV, redeposit USDC in ${opp.pool_name}.`,
        yearlyYieldWeth: round6(netWeth),
        yearlyYieldUsd:  round2(netUsd),
        netApy:          round4(netApyInWeth),
        netApyPct:       round4(netApyInWeth * 100),
      },
      improvement: {
        deltaApy:       round4(deltaApy),
        deltaApyPct:    round4(deltaApy * 100),
        deltaYieldUsd:  round2(deltaYieldUsd),
        deltaYieldWeth: round6(deltaYieldWeth),
        worthIt:        deltaApy > 0,
      },
    },
    netApyInWeth:    round4(netApyInWeth),
    netApyInWethPct: round4(netApyInWeth * 100),
    profitable:      netApyInWeth > 0,
    warnings,
  };
}

// ─── helpers ────────────────────────────────────────────────────────────────

function round2(n: number) { return Math.round(n * 100) / 100; }
function round4(n: number) { return Math.round(n * 10000) / 10000; }
function round6(n: number) { return Math.round(n * 1e6) / 1e6; }
function pct(n: number) { return `${(n * 100).toFixed(2)}%`; }
