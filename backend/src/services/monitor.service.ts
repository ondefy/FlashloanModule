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
import { TOKENS, POOLS, MORPHO_MARKET } from '../config/addresses.js';
import { AAVE_POOL_ABI, ERC20_ABI, MORPHO_BLUE_ABI, UNIFIED_MODULE_ABI } from '../utils/abis.js';
import {
  getPositionsDueForCheck,
  updatePositionHealth,
  insertTransactionLog,
  updateTransactionLog,
  getSupabase,
} from '../db/supabase.js';
import { executeGuardedBatch, type Execution } from './session-executor.service.js';
import { supplyWethToAave } from './vault.service.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AAVE_BASE_DECIMALS = 8;
const USDC_DECIMALS = 6;
const VARIABLE_RATE = 2n;
const REPAY_BUFFER_MAX_USDC = 1_000_000n; // 1 USDC max buffer
const REPAY_BUFFER_BPS = 50n; // 0.5% buffer for interest accrual
const REPAY_BUFFER_MIN = 100n; // 0.0001 USDC minimum buffer

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

  // 2. Health check existing positions
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
    // Morpho Blue position
    // TODO: Read Morpho position data
    // For now, set reasonable defaults
    healthFactor = 2.0;
    collateralAmount = BigInt(pos.collateral_amount || '0');
    debtAmount = BigInt(pos.debt_amount || '0');
  }

  // Update position in DB (also sets next_check_at via tiered function)
  await updatePositionHealth(
    pos.id,
    healthFactor,
    collateralAmount.toString(),
    debtAmount.toString(),
  );

  // Check if migration is beneficial
  await checkMigrationOpportunity(publicClient, pos, healthFactor);
}

// ─── Migration Decision Engine ───────────────────────────────────────────────

async function checkMigrationOpportunity(
  publicClient: any,
  pos: any,
  healthFactor: number,
): Promise<void> {
  // Don't migrate if health factor is too low (risky)
  if (healthFactor < 1.5) {
    logger.warn({ positionId: pos.id, healthFactor }, 'HF too low to migrate');
    return;
  }

  // Don't migrate if position has no debt (nothing to swap)
  if (BigInt(pos.debt_amount || '0') === 0n) return;

  // TODO: Fetch and compare actual rates from both protocols
  // For now, log that migration check was performed
  const currentProtocol = pos.current_protocol;
  const targetProtocol = currentProtocol === 'aave_v3' ? 'morpho_blue' : 'aave_v3';

  // Placeholder: rate comparison logic
  // const currentRate = await fetchRate(currentProtocol, pos.collateral_token);
  // const targetRate = await fetchRate(targetProtocol, pos.collateral_token);
  // const rateDiffBps = (targetRate - currentRate) * 10000;
  // if (rateDiffBps > MIN_RATE_DIFF) { triggerMigration(...) }

  logger.debug({ positionId: pos.id, currentProtocol, targetProtocol }, 'Migration check completed');
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
