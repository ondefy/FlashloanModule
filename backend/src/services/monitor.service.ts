import {
  createPublicClient,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  maxUint256,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import pino from 'pino';
import { getEnv } from '../config/env.js';
import { TOKENS, POOLS, MORPHO_MARKET, LIQUIDATION_THRESHOLDS, AAVE_EMODE_CATEGORY } from '../config/addresses.js';
import { AAVE_POOL_ABI, ERC20_ABI, MORPHO_BLUE_ABI, UNIFIED_MODULE_ABI } from '../utils/abis.js';
import {
  getPositionsDueForCheck,
  updatePositionHealth,
  insertTransactionLog,
  getSupabase,
} from '../db/supabase.js';
import { executeGuardedBatch, type Execution } from './session-executor.service.js';
import { supplyWethToAave, getProtocolRates } from './vault.service.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const USDC_DECIMALS = 6;
const VARIABLE_RATE = 2n;
const REPAY_BUFFER_MAX_USDC = 1_000_000n; // 1 USDC max buffer
const REPAY_BUFFER_BPS = 50n; // 0.5% buffer for interest accrual
const REPAY_BUFFER_MIN = 100n; // 0.0001 USDC minimum buffer

// ─── Rebalance Config ───────────────────────────────────────────────────────

// Cost-based rebalance config
const REBALANCE_MIN_SAVINGS_USD = 10; // Minimum $10/year savings to migrate
const REBALANCE_MIN_SAVINGS_PCT = 0.01; // OR 1% of debt value
const REBALANCE_MIN_HF = 1.5; // Don't migrate below this health factor (cost migration)
const REBALANCE_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours between migrations
const REBALANCE_MIN_DEBT_USD = 100; // Skip positions with < $100 debt
const REBALANCE_TWAP_MIN_SAMPLES = 10; // Need at least 10 samples (~10 min) before deciding
const ETH_PRICE_VOLATILITY_PCT = 0.03; // Skip if ETH moved >3% in 1 hour

// Safety-based migration config
const SAFETY_HF_TRIGGER = 1.3; // Trigger safety check when HF drops below this
const SAFETY_HF_FLOOR = 1.05; // Don't touch if already being liquidated
const SAFETY_HF_MIN_IMPROVEMENT = 0.05; // Target protocol must give at least 0.05 HF improvement
const SAFETY_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 hour cooldown for safety migrations (faster than cost)

// ─── Rate TWAP Ring Buffer ──────────────────────────────────────────────────
// Store rate samples every cycle. Use 1-hour average for migration decisions.

interface RateSample {
  timestamp: number;
  aaveCollateralApy: number;
  aaveBorrowApy: number;
  morphoCollateralApy: number;
  morphoBorrowApy: number;
  ethPriceUsd: number;
}

const TWAP_MAX_SAMPLES = 60; // 60 samples = 1 hour at 60s intervals
const rateSamples: RateSample[] = [];

/** Add a new rate sample to the ring buffer */
function pushRateSample(sample: RateSample): void {
  rateSamples.push(sample);
  if (rateSamples.length > TWAP_MAX_SAMPLES) {
    rateSamples.shift();
  }
}

/** Get the TWAP (average) of all stored samples */
function getTwapRates(): RateSample | null {
  if (rateSamples.length < REBALANCE_TWAP_MIN_SAMPLES) return null;

  const sum = rateSamples.reduce(
    (acc, s) => ({
      timestamp: Date.now(),
      aaveCollateralApy: acc.aaveCollateralApy + s.aaveCollateralApy,
      aaveBorrowApy: acc.aaveBorrowApy + s.aaveBorrowApy,
      morphoCollateralApy: acc.morphoCollateralApy + s.morphoCollateralApy,
      morphoBorrowApy: acc.morphoBorrowApy + s.morphoBorrowApy,
      ethPriceUsd: acc.ethPriceUsd + s.ethPriceUsd,
    }),
    { timestamp: 0, aaveCollateralApy: 0, aaveBorrowApy: 0, morphoCollateralApy: 0, morphoBorrowApy: 0, ethPriceUsd: 0 },
  );

  const n = rateSamples.length;
  return {
    timestamp: Date.now(),
    aaveCollateralApy: sum.aaveCollateralApy / n,
    aaveBorrowApy: sum.aaveBorrowApy / n,
    morphoCollateralApy: sum.morphoCollateralApy / n,
    morphoBorrowApy: sum.morphoBorrowApy / n,
    ethPriceUsd: sum.ethPriceUsd / n,
  };
}

/** Check if ETH price has moved more than threshold in the last hour */
function isEthPriceVolatile(): boolean {
  if (rateSamples.length < 2) return false;
  const oldest = rateSamples[0];
  const newest = rateSamples[rateSamples.length - 1];
  if (oldest.ethPriceUsd === 0) return false;
  const pctChange = Math.abs(newest.ethPriceUsd - oldest.ethPriceUsd) / oldest.ethPriceUsd;
  return pctChange > ETH_PRICE_VOLATILITY_PCT;
}

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Compute Morpho Blue market ID = keccak256(abi.encode(loanToken, collateralToken, oracle, irm, lltv)) */
function getMorphoMarketId(): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [MORPHO_MARKET.loanToken, MORPHO_MARKET.collateralToken, MORPHO_MARKET.oracle, MORPHO_MARKET.irm, MORPHO_MARKET.lltv],
    ),
  );
}

// ─── Daemon Control ──────────────────────────────────────────────────────────

export function startMonitor(): void {
  const intervalMs = Number(process.env.MONITOR_INTERVAL_MS) || 60_000;
  logger.info({ intervalMs }, 'Starting position monitor daemon');

  // Run immediately, then on interval
  runMonitorCycle().catch(err => logger.error({ err: err.message }, 'Initial monitor cycle failed'));

  intervalId = setInterval(() => {
    runMonitorCycle().catch(err => logger.error({ err: err.message }, 'Monitor cycle failed'));
  }, intervalMs);
}

export function stopMonitor(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    logger.info('Position monitor stopped');
  }
}

// ─── Monitor Cycle ───────────────────────────────────────────────────────────

async function runMonitorCycle(): Promise<void> {
  logger.info('Monitor cycle starting');

  // 1. Check idle WETH in user Safes and auto-supply to Aave
  await checkIdleWethBalances().catch(err =>
    logger.error({ err: err.message }, 'Idle WETH check failed')
  );

  // 2. Sample current rates for TWAP
  await sampleRates().catch(err =>
    logger.error({ err: err.message }, 'Rate sampling failed')
  );

  // 3. Health check existing positions
  const positions = await getPositionsDueForCheck(500);
  if (!positions || positions.length === 0) {
    logger.info('No positions due for check');
    return;
  }

  logger.info({ count: positions.length }, 'Checking positions');

  const publicClient = createPublicClient({
    chain: base,
    transport: http(getEnv().BASE_RPC_URL),
  });

  for (const pos of positions) {
    try {
      await checkAndUpdatePosition(publicClient, pos);
    } catch (err: any) {
      logger.error({ positionId: pos.id, err: err.message }, 'Failed to check position');
    }
  }
}

// ─── Rate Sampling ──────────────────────────────────────────────────────────

async function sampleRates(): Promise<void> {
  const rates = await getProtocolRates();
  pushRateSample({
    timestamp: Date.now(),
    aaveCollateralApy: rates.aave.collateralSupplyApy,
    aaveBorrowApy: rates.aave.borrowApy,
    morphoCollateralApy: rates.morpho.collateralSupplyApy,
    morphoBorrowApy: rates.morpho.borrowApy,
    ethPriceUsd: rates.ethPriceUsd,
  });
  logger.debug({
    samples: rateSamples.length,
    aaveBorrow: rates.aave.borrowApy,
    morphoBorrow: rates.morpho.borrowApy,
    ethPrice: rates.ethPriceUsd,
  }, 'Rate sample recorded');
}

// ─── Idle WETH Auto-Supply ──────────────────────────────────────────────────
// Check all onboarded users' Safes for idle WETH and auto-supply to Aave

const MIN_WETH_TO_SUPPLY = BigInt('100000000000000'); // 0.0001 WETH (avoid dust)

async function checkIdleWethBalances(): Promise<void> {
  const supabase = getSupabase();

  // Get all fully onboarded users with Safes and active session keys
  const { data: users, error } = await supabase
    .from('users')
    .select('address, safe_address')
    .eq('onboarding_step', 3)
    .eq('is_active', true)
    .not('safe_address', 'is', null);

  if (error || !users || users.length === 0) return;

  const publicClient = createPublicClient({
    chain: base,
    transport: http(getEnv().BASE_RPC_URL),
  });

  for (const user of users) {
    try {
      const wethBalance = await publicClient.readContract({
        address: TOKENS.WETH,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [user.safe_address as Address],
      }) as bigint;

      if (wethBalance >= MIN_WETH_TO_SUPPLY) {
        logger.info({
          userAddress: user.address,
          safeAddress: user.safe_address,
          wethBalance: wethBalance.toString(),
        }, 'Idle WETH detected in Safe, auto-supplying to Aave');

        await supplyWethToAave(user.address, user.address, user.safe_address, wethBalance);
      }
    } catch (err: any) {
      logger.error({ userAddress: user.address, err: err.message }, 'Failed to check/supply idle WETH');
    }
  }
}

// ─── Position Health Check ───────────────────────────────────────────────────

async function checkAndUpdatePosition(publicClient: any, pos: any): Promise<void> {
  let healthFactor: number;
  let collateralAmount: bigint;
  let debtAmount: bigint;

  if (pos.current_protocol === 'aave_v3') {
    const [totalCollateralBase, totalDebtBase, , , , hf] = await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [pos.safe_address as Address],
    });

    healthFactor = Number(hf) / 1e18;
    collateralAmount = totalCollateralBase;
    debtAmount = totalDebtBase;

    // Get actual WETH collateral from aToken balance
    try {
      const reserveData = await publicClient.readContract({
        address: POOLS.AAVE_V3,
        abi: AAVE_POOL_ABI,
        functionName: 'getReserveData',
        args: [pos.collateral_token as Address],
      });
      const aTokenAddr = (reserveData as any).aTokenAddress as Address;
      collateralAmount = await publicClient.readContract({
        address: aTokenAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [pos.safe_address as Address],
      }) as bigint;
    } catch { /* use USD-denominated fallback */ }

    // Get actual USDC debt
    try {
      const reserveData = await publicClient.readContract({
        address: POOLS.AAVE_V3,
        abi: AAVE_POOL_ABI,
        functionName: 'getReserveData',
        args: [TOKENS.USDC],
      });
      const variableDebtAddr = (reserveData as any).variableDebtTokenAddress as Address;
      debtAmount = await publicClient.readContract({
        address: variableDebtAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [pos.safe_address as Address],
      }) as bigint;
    } catch { /* use USD-denominated fallback */ }

  } else {
    // Morpho Blue position — read on-chain
    const marketId = getMorphoMarketId();
    try {
      const [posResult, marketResult] = await Promise.all([
        publicClient.readContract({
          address: POOLS.MORPHO_BLUE, abi: MORPHO_BLUE_ABI, functionName: 'position',
          args: [marketId, pos.safe_address as Address],
        }),
        publicClient.readContract({
          address: POOLS.MORPHO_BLUE, abi: MORPHO_BLUE_ABI, functionName: 'market',
          args: [marketId],
        }),
      ]);
      const [, borrowShares, collateral] = posResult as unknown as [bigint, bigint, bigint];
      const [, , totalBorrowAssets, totalBorrowShares] = marketResult as unknown as [bigint, bigint, bigint, bigint, bigint, bigint];

      collateralAmount = collateral;

      // Convert borrow shares to assets (round up)
      if (totalBorrowShares > 0n && borrowShares > 0n) {
        debtAmount = (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
      } else {
        debtAmount = 0n;
      }

      // Calculate Morpho HF: (collateralUsd * LLTV) / debtUsd
      // Use ETH price from latest rate sample
      const latestSample = rateSamples.length > 0 ? rateSamples[rateSamples.length - 1] : null;
      const ethPrice = latestSample?.ethPriceUsd ?? 0;
      if (ethPrice > 0 && debtAmount > 0n) {
        const collateralWeth = Number(formatUnits(collateralAmount, 18));
        const debtUsdc = Number(formatUnits(debtAmount, USDC_DECIMALS));
        const collateralUsd = collateralWeth * ethPrice;
        healthFactor = (collateralUsd * LIQUIDATION_THRESHOLDS.MORPHO) / debtUsdc;
      } else {
        healthFactor = debtAmount === 0n ? 999 : 2.0;
      }
    } catch (err: any) {
      logger.error({ positionId: pos.id, err: err.message }, 'Failed to read Morpho position');
      healthFactor = 2.0;
      collateralAmount = BigInt(pos.collateral_amount || '0');
      debtAmount = BigInt(pos.debt_amount || '0');
    }
  }

  // Update position in DB (also sets next_check_at via tiered function)
  await updatePositionHealth(
    pos.id,
    healthFactor,
    collateralAmount.toString(),
    debtAmount.toString(),
  );

  // Safety check first (higher priority than cost optimization)
  await checkSafetyMigration(publicClient, pos, healthFactor);

  // Then check if cost-based migration is beneficial
  await checkMigrationOpportunity(publicClient, pos, healthFactor);
}

// ─── Safety Migration (Liquidation Protection) ─────────────────────────────

/**
 * If HF is dangerously low, try to protect the position:
 *   1. Enable Aave e-mode (cheapest — no flashloan, just raises liquidation threshold)
 *   2. Migrate to protocol with higher liquidation threshold
 */
async function checkSafetyMigration(
  publicClient: any,
  pos: any,
  healthFactor: number,
): Promise<void> {
  // Only trigger when HF is in the danger zone (1.05 - 1.3)
  if (healthFactor >= SAFETY_HF_TRIGGER || healthFactor <= SAFETY_HF_FLOOR) return;
  if (BigInt(pos.debt_amount || '0') === 0n) return;

  const positionId = pos.id;
  const safeAddr = pos.safe_address as Address;

  logger.warn({ positionId, healthFactor, protocol: pos.current_protocol }, 'Safety check: HF in danger zone');

  // Cooldown check (1 hour for safety)
  const supabase = getSupabase();
  const { data: lastMigration } = await supabase
    .from('migration_history')
    .select('created_at')
    .eq('position_id', positionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (lastMigration) {
    const elapsed = Date.now() - new Date(lastMigration.created_at).getTime();
    if (elapsed < SAFETY_COOLDOWN_MS) {
      logger.debug({ positionId }, 'Safety skip: cooldown active');
      return;
    }
  }

  // Step 1: If on Aave, try enabling e-mode first (cheapest intervention)
  if (pos.current_protocol === 'aave_v3') {
    try {
      const currentEMode = await publicClient.readContract({
        address: POOLS.AAVE_V3,
        abi: AAVE_POOL_ABI,
        functionName: 'getUserEMode',
        args: [safeAddr],
      }) as bigint;

      if (Number(currentEMode) === 0) {
        // User is NOT in e-mode. Enabling it would raise liquidation threshold from 83% to 93%.
        // Project new HF: (collateralUsd * 0.93) / debtUsd
        const latestSample = rateSamples.length > 0 ? rateSamples[rateSamples.length - 1] : null;
        const ethPrice = latestSample?.ethPriceUsd ?? 0;
        if (ethPrice > 0) {
          const collateralWeth = Number(formatUnits(BigInt(pos.collateral_amount || '0'), 18));
          const debtUsdc = Number(formatUnits(BigInt(pos.debt_amount || '0'), USDC_DECIMALS));
          const collateralUsd = collateralWeth * ethPrice;
          const projectedHF = (collateralUsd * LIQUIDATION_THRESHOLDS.AAVE_EMODE) / debtUsdc;

          if (projectedHF > healthFactor + SAFETY_HF_MIN_IMPROVEMENT) {
            logger.info({
              positionId,
              currentHF: healthFactor,
              projectedHF: Math.round(projectedHF * 100) / 100,
            }, 'Safety: enabling Aave e-mode to raise HF');

            try {
              const emodeCalldata = encodeFunctionData({
                abi: AAVE_POOL_ABI,
                functionName: 'setUserEMode',
                args: [AAVE_EMODE_CATEGORY],
              });

              const execution: Execution = {
                target: POOLS.AAVE_V3,
                value: 0n,
                callData: emodeCalldata as Hex,
              };

              await executeGuardedBatch(pos.user_address, pos.user_address, pos.safe_address, [execution]);
              logger.info({ positionId, projectedHF }, 'Safety: e-mode enabled successfully');
              return; // e-mode enabled, no need to migrate
            } catch (err: any) {
              logger.error({ positionId, err: err.message }, 'Safety: failed to enable e-mode');
            }
          }
        }
      }
    } catch (err: any) {
      logger.error({ positionId, err: err.message }, 'Safety: failed to check e-mode status');
    }
  }

  // Step 2: Check if migrating to target protocol gives better HF
  const latestSample = rateSamples.length > 0 ? rateSamples[rateSamples.length - 1] : null;
  const ethPrice = latestSample?.ethPriceUsd ?? 0;
  if (ethPrice <= 0) return;

  const collateralWeth = Number(formatUnits(BigInt(pos.collateral_amount || '0'), 18));
  const debtUsdc = Number(formatUnits(BigInt(pos.debt_amount || '0'), USDC_DECIMALS));
  const collateralUsd = collateralWeth * ethPrice;
  if (debtUsdc <= 0) return;

  const currentThreshold = pos.current_protocol === 'aave_v3'
    ? LIQUIDATION_THRESHOLDS.AAVE_NORMAL
    : LIQUIDATION_THRESHOLDS.MORPHO;
  const targetThreshold = pos.current_protocol === 'aave_v3'
    ? LIQUIDATION_THRESHOLDS.MORPHO
    : LIQUIDATION_THRESHOLDS.AAVE_NORMAL;
  const targetProtocol = pos.current_protocol === 'aave_v3' ? 'morpho_blue' : 'aave_v3';

  const currentHF = (collateralUsd * currentThreshold) / debtUsdc;
  const targetHF = (collateralUsd * targetThreshold) / debtUsdc;

  if (targetHF > currentHF + SAFETY_HF_MIN_IMPROVEMENT) {
    logger.info({
      positionId,
      currentHF: Math.round(currentHF * 100) / 100,
      targetHF: Math.round(targetHF * 100) / 100,
      targetProtocol,
      currentThreshold,
      targetThreshold,
    }, 'Safety migration: target protocol has higher liquidation threshold');

    try {
      await forceMigrate(pos.user_address, targetProtocol as 'aave_v3' | 'morpho_blue');
      logger.info({ positionId, targetProtocol }, 'Safety migration completed');
    } catch (err: any) {
      logger.error({ positionId, err: err.message }, 'Safety migration failed');
    }
  } else {
    logger.warn({ positionId, currentHF, targetHF }, 'Safety: no protocol offers better HF, position at risk');
  }
}

// ─── Cost-Based Migration Decision Engine ───────────────────────────────────

/**
 * Decide whether to migrate a position based on USD-normalized net cost comparison.
 *
 * Formula:
 *   net_cost = (debt_usd × borrow_apy) − (collateral_usd × collateral_supply_apy)
 *   savings  = current_net_cost − target_net_cost
 *
 * Gates (all must pass):
 *   1. Health factor > 1.5
 *   2. Debt > $100
 *   3. Cooldown > 6 hours since last migration
 *   4. Enough TWAP samples (10+ minutes of data)
 *   5. ETH price stable (<3% change in last hour)
 *   6. Savings > max($10, 1% of debt)
 */
async function checkMigrationOpportunity(
  _pc: any, // publicClient passed from caller, unused — rates come from TWAP
  pos: any,
  healthFactor: number,
): Promise<void> {
  const positionId = pos.id;
  const currentProtocol = pos.current_protocol;
  const targetProtocol = currentProtocol === 'aave_v3' ? 'morpho_blue' : 'aave_v3';

  // Gate 1: Health factor
  if (healthFactor < REBALANCE_MIN_HF) {
    logger.debug({ positionId, healthFactor }, 'Rebalance skip: HF too low');
    return;
  }

  // Gate 2: Must have debt
  const debtRaw = BigInt(pos.debt_amount || '0');
  if (debtRaw === 0n) return;

  // Gate 3: Need enough TWAP samples
  const twap = getTwapRates();
  if (!twap) {
    logger.debug({ positionId, samples: rateSamples.length }, 'Rebalance skip: not enough rate samples yet');
    return;
  }

  // Gate 4: ETH price stability
  if (isEthPriceVolatile()) {
    logger.info({ positionId }, 'Rebalance skip: ETH price too volatile');
    return;
  }

  // Calculate USD values
  const ethPrice = twap.ethPriceUsd;
  if (ethPrice <= 0) return;

  // collateral_amount is in wei (18 decimals) for WETH, debt_amount is in 6 decimals for USDC
  const collateralWeth = Number(formatUnits(BigInt(pos.collateral_amount || '0'), 18));
  const debtUsdc = Number(formatUnits(debtRaw, USDC_DECIMALS));

  const collateralUsd = collateralWeth * ethPrice;
  const debtUsd = debtUsdc;

  // Gate 5: Minimum debt size
  if (debtUsd < REBALANCE_MIN_DEBT_USD) {
    logger.debug({ positionId, debtUsd }, 'Rebalance skip: debt too small');
    return;
  }

  // Gate 6: Cooldown — check last migration time
  const supabase = getSupabase();
  const { data: lastMigration } = await supabase
    .from('migration_history')
    .select('created_at')
    .eq('position_id', positionId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (lastMigration) {
    const lastMigratedAt = new Date(lastMigration.created_at).getTime();
    const elapsed = Date.now() - lastMigratedAt;
    if (elapsed < REBALANCE_COOLDOWN_MS) {
      const hoursLeft = ((REBALANCE_COOLDOWN_MS - elapsed) / 3600000).toFixed(1);
      logger.debug({ positionId, hoursLeft }, 'Rebalance skip: cooldown active');
      return;
    }
  }

  // Calculate net annual cost for each protocol using TWAP rates
  const aaveNetCost = (debtUsd * twap.aaveBorrowApy) - (collateralUsd * twap.aaveCollateralApy);
  const morphoNetCost = (debtUsd * twap.morphoBorrowApy) - (collateralUsd * twap.morphoCollateralApy);

  const currentCost = currentProtocol === 'aave_v3' ? aaveNetCost : morphoNetCost;
  const targetCost = currentProtocol === 'aave_v3' ? morphoNetCost : aaveNetCost;
  const annualSavings = currentCost - targetCost;

  // Gate 7: Savings threshold
  const minSavings = Math.max(REBALANCE_MIN_SAVINGS_USD, debtUsd * REBALANCE_MIN_SAVINGS_PCT);
  if (annualSavings <= minSavings) {
    logger.debug({
      positionId,
      currentProtocol,
      currentCost: Math.round(currentCost * 100) / 100,
      targetCost: Math.round(targetCost * 100) / 100,
      annualSavings: Math.round(annualSavings * 100) / 100,
      minSavings: Math.round(minSavings * 100) / 100,
    }, 'Rebalance skip: savings below threshold');
    return;
  }

  // All gates passed — trigger migration
  logger.info({
    positionId,
    userAddress: pos.user_address,
    currentProtocol,
    targetProtocol,
    collateralUsd: Math.round(collateralUsd),
    debtUsd: Math.round(debtUsd),
    currentCostUsd: Math.round(currentCost * 100) / 100,
    targetCostUsd: Math.round(targetCost * 100) / 100,
    annualSavingsUsd: Math.round(annualSavings * 100) / 100,
    twapSamples: rateSamples.length,
    rates: {
      aaveSupply: twap.aaveCollateralApy,
      aaveBorrow: twap.aaveBorrowApy,
      morphoSupply: twap.morphoCollateralApy,
      morphoBorrow: twap.morphoBorrowApy,
      ethPrice: twap.ethPriceUsd,
    },
  }, 'Rebalance triggered: migrating position');

  try {
    await forceMigrate(pos.user_address, targetProtocol as 'aave_v3' | 'morpho_blue');
    logger.info({ positionId, targetProtocol, annualSavings }, 'Auto-rebalance completed successfully');
  } catch (err: any) {
    logger.error({
      positionId,
      targetProtocol,
      err: err.message,
    }, 'Auto-rebalance failed');
  }
}

// ─── Flashloan Migration ─────────────────────────────────────────────────────

/**
 * Execute an atomic collateral swap from one protocol to another via flashloan.
 * This is the core rebalancing operation.
 */
export async function migratePosition(
  userAddress: string,
  ownerAddress: string,
  safeAddress: string,
  positionId: string,
  fromProtocol: string,
  toProtocol: string,
  collateralToken: Address,
  collateralAmount: bigint,
  debtToken: Address,
  debtAmount: bigint,
  morphoBorrowShares = 0n,
): Promise<{ txHash: string }> {
  const env = getEnv();
  const unifiedModuleAddr = env.UNIFIED_MODULE_ADDRESS as Address;

  // Calculate flashloan amount (debt + small buffer for interest accrual)
  // Old logic used min(debt, 1 USDC) which doubled the borrow for small positions,
  // exceeding Morpho's LLTV. Use 0.5% of debt instead, clamped to [0.0001, 1] USDC.
  const bufferBps = debtAmount * REPAY_BUFFER_BPS / 10000n;
  const bufferUsdc = bufferBps < REPAY_BUFFER_MIN ? REPAY_BUFFER_MIN : (bufferBps > REPAY_BUFFER_MAX_USDC ? REPAY_BUFFER_MAX_USDC : bufferBps);
  const flashloanAmount = debtAmount + bufferUsdc;

  let executions: Execution[];

  if (fromProtocol === 'aave_v3' && toProtocol === 'morpho_blue') {
    executions = buildAaveToMorphoExecutions(
      safeAddress as Address, collateralToken, collateralAmount, debtToken, flashloanAmount,
    );
  } else if (fromProtocol === 'morpho_blue' && toProtocol === 'aave_v3') {
    executions = buildMorphoToAaveExecutions(
      safeAddress as Address, collateralToken, collateralAmount, debtToken, flashloanAmount, morphoBorrowShares,
    );
  } else {
    throw new Error(`Unsupported migration: ${fromProtocol} -> ${toProtocol}`);
  }

  // Build the initiateFlashloan call and wrap in GuardedExecModule batch
  const initiateCalldata = encodeFunctionData({
    abi: UNIFIED_MODULE_ABI,
    functionName: 'initiateFlashloan',
    args: [0, debtToken, flashloanAmount, executions], // 0 = MORPHO provider (0% fee)
  });

  const outerExecutions: Execution[] = [{
    target: unifiedModuleAddr,
    value: 0n,
    callData: initiateCalldata as Hex,
  }];

  // Execute on-chain FIRST — only write to Supabase after confirmed success
  const result = await executeGuardedBatch(userAddress, ownerAddress, safeAddress, outerExecutions);

  // On-chain tx confirmed — now safe to update DB
  const supabase = getSupabase();

  const { data: posData } = await supabase.from('positions').select('migration_count').eq('id', positionId).single();
  await supabase.from('positions').update({
    current_protocol: toProtocol,
    migration_count: (posData?.migration_count ?? 0) + 1,
    updated_at: new Date().toISOString(),
  }).eq('id', positionId);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: safeAddress,
    position_id: positionId,
    tx_type: 'flashloan_migrate',
    protocol: toProtocol,
    token_address: debtToken,
    amount: flashloanAmount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
    metadata: {
      from_protocol: fromProtocol,
      to_protocol: toProtocol,
      flashloan_provider: 'morpho_blue',
      collateral_amount: collateralAmount.toString(),
      debt_amount: debtAmount.toString(),
    },
  });

  await supabase.from('migration_history').insert({
    position_id: positionId,
    user_address: userAddress.toLowerCase(),
    from_protocol: fromProtocol,
    to_protocol: toProtocol,
    collateral_token: collateralToken.toLowerCase(),
    collateral_amount: collateralAmount.toString(),
    debt_token: debtToken.toLowerCase(),
    debt_amount: debtAmount.toString(),
    flashloan_provider: 'morpho_blue',
    flashloan_token: debtToken.toLowerCase(),
    flashloan_amount: flashloanAmount.toString(),
    flashloan_fee: '0',
    tx_hash: result.txHash,
    status: 'completed',
  });

  logger.info({ userAddress, positionId, txHash: result.txHash, fromProtocol, toProtocol }, 'Migration completed');
  return { txHash: result.txHash };
}

// ─── Force Migrate (API-triggered) ──────────────────────────────────────────

/**
 * Force-migrate a user's position from current protocol to target protocol.
 * Reads current collateral/debt amounts from on-chain, then executes atomic swap.
 */
export async function forceMigrate(
  userAddress: string,
  toProtocol: 'aave_v3' | 'morpho_blue',
): Promise<{ txHash: string }> {
  const { getUser, getActivePositions } = await import('../db/supabase.js');
  const user = await getUser(userAddress);
  if (!user?.safe_address) throw new Error('No Safe address');

  const positions = await getActivePositions(userAddress);
  if (!positions || positions.length === 0) throw new Error('No active position to migrate');
  const position = positions[0];

  if (position.current_protocol === toProtocol) {
    throw new Error(`Position already on ${toProtocol}`);
  }

  // Read actual on-chain balances for the migration
  const publicClient = createPublicClient({ chain: base, transport: http(getEnv().BASE_RPC_URL) });
  const safeAddr = user.safe_address as Address;

  let collateralAmount: bigint;
  let debtAmount: bigint;
  let morphoBorrowShares = 0n;

  if (position.current_protocol === 'aave_v3') {
    // Read Aave aToken + variableDebtToken balances
    const [wethReserve, usdcReserve] = await Promise.all([
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [TOKENS.WETH],
      }),
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [TOKENS.USDC],
      }),
    ]);
    const aTokenAddr = (wethReserve as any).aTokenAddress as Address;
    const debtAddr = (usdcReserve as any).variableDebtTokenAddress as Address;

    const [collBal, debtBal] = await Promise.all([
      publicClient.readContract({ address: aTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
      publicClient.readContract({ address: debtAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
    ]);
    collateralAmount = collBal as bigint;
    debtAmount = debtBal as bigint;
  } else {
    // Morpho position — read collateral and borrow shares, convert shares to assets
    const marketId = getMorphoMarketId();
    const [posResult, marketResult] = await Promise.all([
      publicClient.readContract({
        address: POOLS.MORPHO_BLUE, abi: MORPHO_BLUE_ABI, functionName: 'position',
        args: [marketId, safeAddr],
      }),
      publicClient.readContract({
        address: POOLS.MORPHO_BLUE, abi: MORPHO_BLUE_ABI, functionName: 'market',
        args: [marketId],
      }),
    ]);
    const [, borrowShares, collateral] = posResult as unknown as [bigint, bigint, bigint];
    const [, , totalBorrowAssets, totalBorrowShares] = marketResult as unknown as [bigint, bigint, bigint, bigint, bigint, bigint];

    collateralAmount = collateral;
    // Store exact borrow shares for repay-all (shares are stable across blocks)
    morphoBorrowShares = borrowShares;
    // Convert borrow shares to USDC assets (round up — user owes at least this much)
    if (totalBorrowShares > 0n && borrowShares > 0n) {
      debtAmount = (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
    } else {
      debtAmount = 0n;
    }
  }

  if (debtAmount === 0n) throw new Error('No debt to migrate — nothing to flashloan for');
  if (collateralAmount === 0n) throw new Error('No collateral to migrate');

  logger.info({
    userAddress,
    from: position.current_protocol,
    to: toProtocol,
    collateral: collateralAmount.toString(),
    debt: debtAmount.toString(),
  }, 'Force migration starting');

  try {
    return await migratePosition(
      userAddress,
      user.address,
      user.safe_address,
      position.id,
      position.current_protocol,
      toProtocol,
      TOKENS.WETH,
      collateralAmount,
      TOKENS.USDC,
      debtAmount,
      morphoBorrowShares,
    );
  } catch (err: any) {
    // Extract detailed revert reason from bundler/on-chain error
    const details = err.details || err.cause?.data?.message || err.cause?.message || '';
    const shortMessage = err.shortMessage || '';
    logger.error({
      userAddress,
      safeAddress: user.safe_address,
      error: err.message,
      shortMessage,
      details,
      errorName: err.name,
      // Pimlico bundler often includes AA revert reason in err.details
      revertData: err.cause?.data?.errorName || err.cause?.data?.args,
    }, 'Migration FAILED — detailed error');
    throw new Error(`Migration failed: ${shortMessage || err.message}. Details: ${details}`);
  }
}

// ─── Migration Pre-flight Check ─────────────────────────────────────────────

/**
 * Run all prerequisite checks before attempting migration.
 * Returns a diagnostic report with pass/fail for each check.
 */
export async function migrationPreflight(
  userAddress: string,
  toProtocol: 'aave_v3' | 'morpho_blue',
) {
  const env = getEnv();
  const { getUser, getActivePositions, getSessionKey } = await import('../db/supabase.js');
  const user = await getUser(userAddress);
  if (!user?.safe_address) throw new Error('No Safe address');

  const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
  const safeAddr = user.safe_address as Address;
  const unifiedModuleAddr = env.UNIFIED_MODULE_ADDRESS as Address;
  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;
  const registryAddr = env.TARGET_REGISTRY_ADDRESS as Address;

  const checks: Record<string, { pass: boolean; detail: string }> = {};

  // 1. Check UnifiedFlashloanModule is installed as executor on the Safe
  try {
    const isInstalled = await publicClient.readContract({
      address: safeAddr,
      abi: [{
        name: 'isModuleInstalled',
        type: 'function',
        inputs: [
          { name: 'moduleTypeId', type: 'uint256' },
          { name: 'module', type: 'address' },
          { name: 'additionalContext', type: 'bytes' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'view',
      }] as const,
      functionName: 'isModuleInstalled',
      args: [2n, unifiedModuleAddr, '0x' as Hex], // typeId 2 = executor
    });
    checks['unifiedModule_installed'] = { pass: !!isInstalled, detail: `installed=${isInstalled}` };
  } catch (err: any) {
    checks['unifiedModule_installed'] = { pass: false, detail: `error: ${err.message}` };
  }

  // 2. Check GuardedExecModule is installed
  try {
    const isInstalled = await publicClient.readContract({
      address: safeAddr,
      abi: [{
        name: 'isModuleInstalled',
        type: 'function',
        inputs: [
          { name: 'moduleTypeId', type: 'uint256' },
          { name: 'module', type: 'address' },
          { name: 'additionalContext', type: 'bytes' },
        ],
        outputs: [{ type: 'bool' }],
        stateMutability: 'view',
      }] as const,
      functionName: 'isModuleInstalled',
      args: [2n, guardedModuleAddr, '0x' as Hex],
    });
    checks['guardedModule_installed'] = { pass: !!isInstalled, detail: `installed=${isInstalled}` };
  } catch (err: any) {
    checks['guardedModule_installed'] = { pass: false, detail: `error: ${err.message}` };
  }

  // 3. Check session key state (ENABLE vs USE mode)
  try {
    const sessionKeyData = await getSessionKey(userAddress);
    const encryptedKeyData = sessionKeyData.encrypted_key as any;
    const hasEnableSig = !!encryptedKeyData.permission_enable_sig;
    checks['session_mode'] = {
      pass: !hasEnableSig,
      detail: hasEnableSig
        ? 'ENABLE mode (permission_enable_sig still present — session may not be enabled on-chain)'
        : 'USE mode (session enabled on-chain)',
    };
  } catch (err: any) {
    checks['session_key'] = { pass: false, detail: `error: ${err.message}` };
  }

  // 4. Check Aave position
  try {
    const [wethReserve, usdcReserve] = await Promise.all([
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [TOKENS.WETH],
      }),
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [TOKENS.USDC],
      }),
    ]);
    const aTokenAddr = (wethReserve as any).aTokenAddress as Address;
    const debtAddr = (usdcReserve as any).variableDebtTokenAddress as Address;

    const [collBal, debtBal] = await Promise.all([
      publicClient.readContract({ address: aTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
      publicClient.readContract({ address: debtAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
    ]);
    checks['aave_position'] = {
      pass: (collBal as bigint) > 0n && (debtBal as bigint) > 0n,
      detail: `collateral=${(collBal as bigint).toString()}, debt=${(debtBal as bigint).toString()}`,
    };
  } catch (err: any) {
    checks['aave_position'] = { pass: false, detail: `error: ${err.message}` };
  }

  // 5. Check TargetRegistry whitelist for all migration selectors
  const REGISTRY_ABI = [{
    name: 'whitelist',
    type: 'function',
    inputs: [{ name: 'target', type: 'address' }, { name: 'selector', type: 'bytes4' }],
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
  }] as const;

  const selectorChecks = [
    { name: 'USDC.approve', target: TOKENS.USDC, selector: '0x095ea7b3' as Hex },
    { name: 'USDC.transfer', target: TOKENS.USDC, selector: '0xa9059cbb' as Hex },
    { name: 'WETH.approve', target: TOKENS.WETH, selector: '0x095ea7b3' as Hex },
    { name: 'Aave.repay', target: POOLS.AAVE_V3, selector: '0x573ade81' as Hex },
    { name: 'Aave.withdraw', target: POOLS.AAVE_V3, selector: '0x69328dec' as Hex },
    { name: 'Morpho.supplyCollateral', target: POOLS.MORPHO_BLUE, selector: '0x238d6579' as Hex },
    { name: 'Morpho.borrow', target: POOLS.MORPHO_BLUE, selector: '0x50d8cd4b' as Hex },
    { name: 'UnifiedModule.initiateFlashloan', target: unifiedModuleAddr, selector: '0xa9a8aeb4' as Hex },
  ];

  for (const check of selectorChecks) {
    try {
      const whitelisted = await publicClient.readContract({
        address: registryAddr,
        abi: REGISTRY_ABI,
        functionName: 'whitelist',
        args: [check.target, check.selector],
      });
      checks[`whitelist_${check.name}`] = { pass: !!whitelisted, detail: `${check.target}:${check.selector}=${whitelisted}` };
    } catch (err: any) {
      checks[`whitelist_${check.name}`] = { pass: false, detail: `error: ${err.message}` };
    }
  }

  // 6. Check UnifiedModule's own registry matches TargetRegistry
  try {
    const moduleRegistry = await publicClient.readContract({
      address: unifiedModuleAddr,
      abi: UNIFIED_MODULE_ABI,
      functionName: 'registry',
    });
    const match = (moduleRegistry as string).toLowerCase() === registryAddr.toLowerCase();
    checks['module_registry_match'] = {
      pass: match,
      detail: `module.registry=${moduleRegistry}, expected=${registryAddr}`,
    };
  } catch (err: any) {
    checks['module_registry_match'] = { pass: false, detail: `error: ${err.message}` };
  }

  // 7. Check DB position
  const positions = await getActivePositions(userAddress);
  if (positions && positions.length > 0) {
    const pos = positions[0];
    checks['db_position'] = {
      pass: pos.current_protocol !== toProtocol,
      detail: `current=${pos.current_protocol}, target=${toProtocol}, collateral=${pos.collateral_amount}, debt=${pos.debt_amount}`,
    };
  } else {
    checks['db_position'] = { pass: false, detail: 'No active position in DB' };
  }

  const allPassed = Object.values(checks).every(c => c.pass);
  const failures = Object.entries(checks).filter(([, c]) => !c.pass).map(([name, c]) => `${name}: ${c.detail}`);

  return { allPassed, checks, failures, safeAddress: safeAddr, userAddress };
}

// ─── Execution Builders ──────────────────────────────────────────────────────

function buildAaveToMorphoExecutions(
  safeAddr: Address,
  collateralToken: Address,
  collateralAmount: bigint,
  debtToken: Address,
  flashloanAmount: bigint,
): Execution[] {
  return [
    // 1. Approve flashloaned USDC to Aave
    {
      target: debtToken, value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [POOLS.AAVE_V3, flashloanAmount] }),
    },
    // 2. Repay all Aave debt
    {
      target: POOLS.AAVE_V3, value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'repay', args: [debtToken, maxUint256, VARIABLE_RATE, safeAddr],
      }),
    },
    // 3. Withdraw all collateral from Aave
    {
      target: POOLS.AAVE_V3, value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'withdraw', args: [collateralToken, maxUint256, safeAddr],
      }),
    },
    // 4. Approve collateral to Morpho
    {
      target: collateralToken, value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [POOLS.MORPHO_BLUE, collateralAmount] }),
    },
    // 5. Supply collateral on Morpho
    {
      target: POOLS.MORPHO_BLUE, value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI, functionName: 'supplyCollateral', args: [MORPHO_MARKET, collateralAmount, safeAddr, '0x'],
      }),
    },
    // 6. Borrow from Morpho to repay flashloan
    {
      target: POOLS.MORPHO_BLUE, value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI, functionName: 'borrow', args: [MORPHO_MARKET, flashloanAmount, 0n, safeAddr, safeAddr],
      }),
    },
  ];
}

function buildMorphoToAaveExecutions(
  safeAddr: Address,
  collateralToken: Address,
  collateralAmount: bigint,
  debtToken: Address,
  flashloanAmount: bigint,
  borrowShares: bigint,
): Execution[] {
  // Use exact borrow shares for repay-all. Morpho doesn't support maxUint256 (uint128 overflow).
  // Shares are stable across blocks (interest changes the conversion ratio, not the shares).
  return [
    // 1. Approve flashloaned USDC to Morpho (to repay Morpho debt)
    {
      target: debtToken, value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [POOLS.MORPHO_BLUE, flashloanAmount] }),
    },
    // 2. Repay all Morpho debt using exact borrow shares (assets=0, shares=exact)
    {
      target: POOLS.MORPHO_BLUE, value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI, functionName: 'repay',
        args: [MORPHO_MARKET, 0n, borrowShares, safeAddr, '0x'],
      }),
    },
    // 3. Withdraw all collateral from Morpho
    {
      target: POOLS.MORPHO_BLUE, value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI, functionName: 'withdrawCollateral',
        args: [MORPHO_MARKET, collateralAmount, safeAddr, safeAddr],
      }),
    },
    // 4. Approve WETH to Aave
    {
      target: collateralToken, value: 0n,
      callData: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [POOLS.AAVE_V3, collateralAmount] }),
    },
    // 5. Supply WETH to Aave
    {
      target: POOLS.AAVE_V3, value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'supply', args: [collateralToken, collateralAmount, safeAddr, 0],
      }),
    },
    // 6. Borrow USDC from Aave to repay flashloan
    {
      target: POOLS.AAVE_V3, value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'borrow', args: [debtToken, flashloanAmount, VARIABLE_RATE, 0, safeAddr],
      }),
    },
  ];
}
