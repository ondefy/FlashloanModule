import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  maxUint256,
  type Address,
  type Hex,
} from 'viem';
import { base } from 'viem/chains';
import pino from 'pino';
import { getEnv } from '../config/env.js';
import { TOKENS, POOLS, MORPHO_MARKET } from '../config/addresses.js';
import { ERC20_ABI, AAVE_POOL_ABI, MORPHO_BLUE_ABI, UNIFIED_MODULE_ABI } from '../utils/abis.js';
import { executeGuardedBatch, type Execution } from './session-executor.service.js';
import {
  getUser,
  getActivePositions,
  insertPosition,
  insertTransactionLog,
  updateTransactionLog,
} from '../db/supabase.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const VARIABLE_RATE = 2n;
const AAVE_BASE_DECIMALS = 8;
const USDC_DECIMALS = 6;

function getPublicClient() {
  return createPublicClient({ chain: base, transport: http(getEnv().BASE_RPC_URL) });
}

/**
 * Determine the best protocol for supplying collateral based on current rates.
 */
async function getBestSupplyProtocol(token: Address): Promise<'aave_v3' | 'morpho_blue'> {
  const publicClient = getPublicClient();

  try {
    const reserveData = await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getReserveData',
      args: [token],
    });

    // currentLiquidityRate is in RAY (1e27), convert to APY
    const aaveLiquidityRate = (reserveData as any).currentLiquidityRate as bigint;
    // Rough comparison: Morpho WETH/USDC market generally offers competitive rates
    // For MVP, prefer Morpho (0% flashloan fee for future migrations)
    // TODO: Fetch actual Morpho rates and compare properly
    if (aaveLiquidityRate > BigInt(5e25)) { // > 5% APY on Aave
      return 'aave_v3';
    }
  } catch {
    logger.warn('Could not fetch Aave rates, defaulting to Morpho');
  }

  return 'morpho_blue';
}

// ─── Deposit ─────────────────────────────────────────────────────────────────

export async function deposit(userAddress: string, tokenAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const token = tokenAddress.toLowerCase() as Address;
  const safeAddr = user.safe_address as Address;

  // Log the pending transaction
  const logId = await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    tx_type: 'deposit',
    token_address: token,
    amount: amount.toString(),
    status: 'pending',
  });

  try {
    const bestProtocol = await getBestSupplyProtocol(token);
    let executions: Execution[];

    if (bestProtocol === 'aave_v3') {
      executions = [
        {
          target: token,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'approve', args: [POOLS.AAVE_V3, amount],
          }),
        },
        {
          target: POOLS.AAVE_V3,
          value: 0n,
          callData: encodeFunctionData({
            abi: AAVE_POOL_ABI, functionName: 'supply', args: [token, amount, safeAddr, 0],
          }),
        },
      ];
    } else {
      executions = [
        {
          target: token,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'approve', args: [POOLS.MORPHO_BLUE, amount],
          }),
        },
        {
          target: POOLS.MORPHO_BLUE,
          value: 0n,
          callData: encodeFunctionData({
            abi: MORPHO_BLUE_ABI, functionName: 'supplyCollateral',
            args: [MORPHO_MARKET, amount, safeAddr, '0x'],
          }),
        },
      ];
    }

    const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

    // Create position in DB
    const positionId = await insertPosition({
      user_address: userAddress,
      safe_address: user.safe_address,
      current_protocol: bestProtocol,
      collateral_token: token,
      collateral_amount: amount.toString(),
      debt_token: TOKENS.USDC,
      debt_amount: '0',
    });

    await updateTransactionLog(logId, {
      status: 'confirmed',
      tx_hash: result.txHash,
      user_op_hash: result.userOpHash,
    });

    logger.info({ userAddress, txHash: result.txHash, protocol: bestProtocol, positionId }, 'Deposit completed');
    return { txHash: result.txHash, positionId, protocol: bestProtocol };
  } catch (err: any) {
    await updateTransactionLog(logId, { status: 'failed', error_message: err.message });
    throw err;
  }
}

// ─── Borrow ──────────────────────────────────────────────────────────────────

export async function borrow(userAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const safeAddr = user.safe_address as Address;

  // Find active position to determine protocol
  const positions = await getActivePositions(userAddress);
  if (!positions || positions.length === 0) throw new Error('No active position to borrow against');
  const position = positions[0];

  const logId = await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'borrow',
    protocol: position.current_protocol,
    token_address: TOKENS.USDC,
    amount: amount.toString(),
    status: 'pending',
    metadata: { recipient_eoa: user.address },
  });

  try {
    let executions: Execution[];

    if (position.current_protocol === 'aave_v3') {
      executions = [
        {
          target: POOLS.AAVE_V3,
          value: 0n,
          callData: encodeFunctionData({
            abi: AAVE_POOL_ABI, functionName: 'borrow',
            args: [TOKENS.USDC, amount, VARIABLE_RATE, 0, safeAddr],
          }),
        },
        {
          target: TOKENS.USDC,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'transfer',
            args: [user.address as Address, amount],
          }),
        },
      ];
    } else {
      executions = [
        {
          target: POOLS.MORPHO_BLUE,
          value: 0n,
          callData: encodeFunctionData({
            abi: MORPHO_BLUE_ABI, functionName: 'borrow',
            args: [MORPHO_MARKET, amount, 0n, safeAddr, safeAddr],
          }),
        },
        {
          target: TOKENS.USDC,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'transfer',
            args: [user.address as Address, amount],
          }),
        },
      ];
    }

    const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

    await updateTransactionLog(logId, {
      status: 'confirmed',
      tx_hash: result.txHash,
      user_op_hash: result.userOpHash,
    });

    logger.info({ userAddress, txHash: result.txHash, amount: amount.toString() }, 'Borrow completed');
    return { txHash: result.txHash };
  } catch (err: any) {
    await updateTransactionLog(logId, { status: 'failed', error_message: err.message });
    throw err;
  }
}

// ─── Repay ───────────────────────────────────────────────────────────────────

export async function repay(userAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const safeAddr = user.safe_address as Address;
  const positions = await getActivePositions(userAddress);
  if (!positions || positions.length === 0) throw new Error('No active position to repay');
  const position = positions[0];

  const logId = await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'repay',
    protocol: position.current_protocol,
    token_address: TOKENS.USDC,
    amount: amount.toString(),
    status: 'pending',
  });

  try {
    let executions: Execution[];

    if (position.current_protocol === 'aave_v3') {
      executions = [
        {
          target: TOKENS.USDC,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'approve', args: [POOLS.AAVE_V3, amount],
          }),
        },
        {
          target: POOLS.AAVE_V3,
          value: 0n,
          callData: encodeFunctionData({
            abi: AAVE_POOL_ABI, functionName: 'repay',
            args: [TOKENS.USDC, amount, VARIABLE_RATE, safeAddr],
          }),
        },
      ];
    } else {
      // Morpho repay = supply loan token
      executions = [
        {
          target: TOKENS.USDC,
          value: 0n,
          callData: encodeFunctionData({
            abi: ERC20_ABI, functionName: 'approve', args: [POOLS.MORPHO_BLUE, amount],
          }),
        },
        // For Morpho, repay is done via repay function (not in minimal ABI — use supply to loan)
        // TODO: Add Morpho repay ABI when implementing Morpho repay flow
      ];
      // Simplified: for now, only Aave repay is fully implemented
      throw new Error('Morpho repay not yet implemented — position is on Morpho');
    }

    const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

    await updateTransactionLog(logId, {
      status: 'confirmed',
      tx_hash: result.txHash,
      user_op_hash: result.userOpHash,
    });

    logger.info({ userAddress, txHash: result.txHash }, 'Repay completed');
    return { txHash: result.txHash };
  } catch (err: any) {
    await updateTransactionLog(logId, { status: 'failed', error_message: err.message });
    throw err;
  }
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

export async function withdraw(userAddress: string, tokenAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const token = tokenAddress.toLowerCase() as Address;
  const positions = await getActivePositions(userAddress);
  if (!positions || positions.length === 0) throw new Error('No active position to withdraw from');
  const position = positions[0];

  const logId = await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'withdraw',
    protocol: position.current_protocol,
    token_address: token,
    amount: amount.toString(),
    status: 'pending',
  });

  try {
    let executions: Execution[];

    if (position.current_protocol === 'aave_v3') {
      executions = [
        {
          target: POOLS.AAVE_V3,
          value: 0n,
          callData: encodeFunctionData({
            abi: AAVE_POOL_ABI, functionName: 'withdraw',
            args: [token, amount, user.address as Address], // withdraw directly to EOA
          }),
        },
      ];
    } else {
      // Morpho withdrawCollateral
      // TODO: Add Morpho withdrawCollateral when implementing
      throw new Error('Morpho withdraw not yet implemented');
    }

    const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

    await updateTransactionLog(logId, {
      status: 'confirmed',
      tx_hash: result.txHash,
      user_op_hash: result.userOpHash,
    });

    logger.info({ userAddress, txHash: result.txHash }, 'Withdraw completed');
    return { txHash: result.txHash };
  } catch (err: any) {
    await updateTransactionLog(logId, { status: 'failed', error_message: err.message });
    throw err;
  }
}

// ─── Get Position Info ───────────────────────────────────────────────────────

export async function getPositionInfo(userAddress: string) {
  const user = await getUser(userAddress);
  if (!user?.safe_address) return null;

  const publicClient = getPublicClient();
  const safeAddr = user.safe_address as Address;

  // Aave position
  const [totalCollateralBase, totalDebtBase, , , , healthFactor] =
    await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddr],
    });

  return {
    aave: {
      collateralUsd: formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS),
      debtUsd: formatUnits(totalDebtBase, AAVE_BASE_DECIMALS),
      healthFactor: formatUnits(healthFactor, 18),
      hasPosition: totalCollateralBase > 0n || totalDebtBase > 0n,
    },
    // TODO: Add Morpho position reading
  };
}
