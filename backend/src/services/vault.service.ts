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

/** Compute Morpho Blue market ID = keccak256(abi.encode(loanToken, collateralToken, oracle, irm, lltv)) */
function getMorphoMarketId(): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [
        MORPHO_MARKET.loanToken,
        MORPHO_MARKET.collateralToken,
        MORPHO_MARKET.oracle,
        MORPHO_MARKET.irm,
        MORPHO_MARKET.lltv,
      ],
    ),
  );
}

/**
 * Ensure a position record exists in Supabase for this user.
 * If user has on-chain Aave collateral but no DB position, auto-create one.
 * Returns the position record.
 */
async function ensurePositionExists(userAddress: string, safeAddress: string) {
  const positions = await getActivePositions(userAddress);
  if (positions && positions.length > 0) return positions[0];

  // No DB position — check on-chain Aave data
  const publicClient = getPublicClient();
  const safeAddr = safeAddress as Address;

  const [totalCollateralBase] = await publicClient.readContract({
    address: POOLS.AAVE_V3,
    abi: AAVE_POOL_ABI,
    functionName: 'getUserAccountData',
    args: [safeAddr],
  });

  if (totalCollateralBase === 0n) {
    throw new Error('No active position — deposit WETH to your Safe first');
  }

  // On-chain collateral exists but no DB record — get actual WETH balance
  let collateralAmount = '0';
  let debtAmount = '0';
  try {
    const [wethReserve, usdcReserve] = await Promise.all([
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
        functionName: 'getReserveData', args: [TOKENS.WETH],
      }),
      publicClient.readContract({
        address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
        functionName: 'getReserveData', args: [TOKENS.USDC],
      }),
    ]);
    const aTokenAddr = (wethReserve as any).aTokenAddress as Address;
    const variableDebtAddr = (usdcReserve as any).variableDebtTokenAddress as Address;

    const [aTokenBal, debtBal] = await Promise.all([
      publicClient.readContract({ address: aTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
      publicClient.readContract({ address: variableDebtAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }),
    ]);
    collateralAmount = (aTokenBal as bigint).toString();
    debtAmount = (debtBal as bigint).toString();
  } catch (err) {
    logger.warn({ err }, 'Failed to read token balances for position sync');
  }

  // Auto-create position from on-chain data
  const positionId = await insertPosition({
    user_address: userAddress,
    safe_address: safeAddress,
    current_protocol: 'aave_v3',
    collateral_token: TOKENS.WETH,
    collateral_amount: collateralAmount,
    debt_token: TOKENS.USDC,
    debt_amount: debtAmount,
  });

  logger.info({ userAddress, positionId }, 'Auto-created position from on-chain Aave data');

  // Re-fetch to get the full view data
  const refreshed = await getActivePositions(userAddress);
  return refreshed![0];
}

// ─── Supply WETH to Aave ────────────────────────────────────────────────────
// Called by monitor when idle WETH is detected in Safe, or by deposit endpoint

export async function supplyWethToAave(
  userAddress: string,
  ownerAddress: string,
  safeAddress: string,
  amount: bigint,
) {
  const safeAddr = safeAddress as Address;

  const executions: Execution[] = [
    {
      target: TOKENS.WETH,
      value: 0n,
      callData: encodeFunctionData({
        abi: ERC20_ABI, functionName: 'approve', args: [POOLS.AAVE_V3, amount],
      }),
    },
    {
      target: POOLS.AAVE_V3,
      value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'supply', args: [TOKENS.WETH, amount, safeAddr, 0],
      }),
    },
  ];

  // Execute on-chain FIRST — only write to Supabase after confirmed success
  const result = await executeGuardedBatch(userAddress, ownerAddress, safeAddress, executions);

  // On-chain tx confirmed — now safe to write to DB
  const position = await ensurePositionExists(userAddress, safeAddress);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: safeAddress,
    tx_type: 'deposit',
    protocol: 'aave_v3',
    token_address: TOKENS.WETH,
    amount: amount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
  });

  logger.info({ userAddress, txHash: result.txHash, amount: amount.toString() }, 'WETH supplied to Aave');
  return { txHash: result.txHash, positionId: position.id, protocol: 'aave_v3' };
}

// ─── Deposit (notify backend that WETH was sent to Safe) ─────────────────────

export async function deposit(userAddress: string, tokenAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  // Check current protocol to supply to the right place
  let currentProtocol = 'aave_v3';
  try {
    const positions = await getActivePositions(userAddress);
    if (positions && positions.length > 0) {
      currentProtocol = positions[0].current_protocol;
    }
  } catch { /* default to aave_v3 */ }

  if (currentProtocol === 'morpho_blue') {
    return supplyWethToMorpho(userAddress, user.address, user.safe_address, amount);
  }
  return supplyWethToAave(userAddress, user.address, user.safe_address, amount);
}

// ─── Supply WETH to Morpho ───────────────────────────────────────────────────

async function supplyWethToMorpho(
  userAddress: string,
  ownerAddress: string,
  safeAddress: string,
  amount: bigint,
) {
  const safeAddr = safeAddress as Address;

  const executions: Execution[] = [
    {
      target: TOKENS.WETH,
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

  const result = await executeGuardedBatch(userAddress, ownerAddress, safeAddress, executions);

  const position = await ensurePositionExists(userAddress, safeAddress);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: safeAddress,
    tx_type: 'deposit',
    protocol: 'morpho_blue',
    token_address: TOKENS.WETH,
    amount: amount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
  });

  logger.info({ userAddress, txHash: result.txHash, amount: amount.toString() }, 'WETH supplied to Morpho');
  return { txHash: result.txHash, positionId: position.id, protocol: 'morpho_blue' };
}

// ─── Borrow ──────────────────────────────────────────────────────────────────

export async function borrow(userAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const safeAddr = user.safe_address as Address;

  // Find or auto-create position from on-chain data
  const position = await ensurePositionExists(userAddress, user.safe_address);

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

  // Execute on-chain FIRST — only write to Supabase after confirmed success
  const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'borrow',
    protocol: position.current_protocol,
    token_address: TOKENS.USDC,
    amount: amount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
    metadata: { recipient_eoa: user.address },
  });

  logger.info({ userAddress, txHash: result.txHash, amount: amount.toString() }, 'Borrow completed');
  return { txHash: result.txHash };
}

// ─── Repay ───────────────────────────────────────────────────────────────────

export async function repay(userAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const safeAddr = user.safe_address as Address;
  const position = await ensurePositionExists(userAddress, user.safe_address);

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
    // Morpho repay: compute exact borrow shares for the amount, then repay by shares.
    // Using shares avoids arithmetic overflow issues in Morpho's assets-to-shares conversion.
    const publicClient = getPublicClient();
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
    const [, userBorrowShares] = posResult as unknown as [bigint, bigint, bigint];
    const [, , totalBorrowAssets, totalBorrowShares] = marketResult as unknown as [bigint, bigint, bigint, bigint, bigint, bigint];

    // Convert repay amount to shares: shares = amount * totalShares / totalAssets (round up for user)
    let repayShares = 0n;
    if (totalBorrowAssets > 0n) {
      repayShares = (amount * totalBorrowShares + totalBorrowAssets - 1n) / totalBorrowAssets;
    }
    // Cap to user's actual borrow shares (can't repay more than you owe)
    if (repayShares > userBorrowShares) {
      repayShares = userBorrowShares;
    }

    // Approve a bit more USDC than needed (shares → assets rounding may need extra)
    const approveAmount = amount + 1000n; // 0.001 USDC buffer

    executions = [
      {
        target: TOKENS.USDC,
        value: 0n,
        callData: encodeFunctionData({
          abi: ERC20_ABI, functionName: 'approve', args: [POOLS.MORPHO_BLUE, approveAmount],
        }),
      },
      {
        target: POOLS.MORPHO_BLUE,
        value: 0n,
        callData: encodeFunctionData({
          abi: MORPHO_BLUE_ABI, functionName: 'repay',
          args: [MORPHO_MARKET, 0n, repayShares, safeAddr, '0x'],
        }),
      },
    ];
  }

  // Execute on-chain FIRST — only write to Supabase after confirmed success
  const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'repay',
    protocol: position.current_protocol,
    token_address: TOKENS.USDC,
    amount: amount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
  });

  logger.info({ userAddress, txHash: result.txHash }, 'Repay completed');
  return { txHash: result.txHash };
}

// ─── Withdraw ────────────────────────────────────────────────────────────────

export async function withdraw(userAddress: string, tokenAddress: string, amount: bigint) {
  const user = await getUser(userAddress);
  if (!user || user.onboarding_step < 3) throw new Error('User not fully onboarded');
  if (!user.safe_address) throw new Error('No Safe address');

  const token = tokenAddress.toLowerCase() as Address;
  const position = await ensurePositionExists(userAddress, user.safe_address);

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
    // Morpho: withdraw collateral, then transfer to EOA
    const safeAddr = user.safe_address as Address;
    executions = [
      {
        target: POOLS.MORPHO_BLUE,
        value: 0n,
        callData: encodeFunctionData({
          abi: MORPHO_BLUE_ABI, functionName: 'withdrawCollateral',
          args: [MORPHO_MARKET, amount, safeAddr, safeAddr], // withdraw to Safe first
        }),
      },
      {
        target: token,
        value: 0n,
        callData: encodeFunctionData({
          abi: ERC20_ABI, functionName: 'transfer',
          args: [user.address as Address, amount], // then transfer to EOA
        }),
      },
    ];
  }

  // Execute on-chain FIRST — only write to Supabase after confirmed success
  const result = await executeGuardedBatch(userAddress, user.address, user.safe_address, executions);

  await insertTransactionLog({
    user_address: userAddress,
    safe_address: user.safe_address,
    position_id: position.id,
    tx_type: 'withdraw',
    protocol: position.current_protocol,
    token_address: token,
    amount: amount.toString(),
    status: 'confirmed',
    tx_hash: result.txHash,
    user_op_hash: result.userOpHash,
  });

  logger.info({ userAddress, txHash: result.txHash }, 'Withdraw completed');
  return { txHash: result.txHash };
}

// ─── Get Position Info ───────────────────────────────────────────────────────

export async function getPositionInfo(userAddress: string) {
  const user = await getUser(userAddress);
  if (!user?.safe_address) return null;

  const publicClient = getPublicClient();
  const safeAddr = user.safe_address as Address;

  // Determine current protocol from DB (defaults to aave_v3 if no position yet)
  let currentProtocol = 'aave_v3';
  try {
    const positions = await getActivePositions(userAddress);
    if (positions && positions.length > 0) {
      currentProtocol = positions[0].current_protocol;
    }
  } catch { /* default to aave_v3 */ }

  // Read idle token balances sitting in Safe (not yet supplied/used)
  let idleWeth = 0n;
  let idleUsdc = 0n;
  try {
    [idleWeth, idleUsdc] = await Promise.all([
      publicClient.readContract({ address: TOKENS.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }) as Promise<bigint>,
      publicClient.readContract({ address: TOKENS.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr] }) as Promise<bigint>,
    ]);
  } catch { /* ignore */ }

  if (currentProtocol === 'morpho_blue') {
    return getMorphoPositionInfo(publicClient, safeAddr, idleWeth, idleUsdc);
  }
  return getAavePositionInfo(publicClient, safeAddr, idleWeth, idleUsdc);
}

/** Read position data from Aave V3 */
async function getAavePositionInfo(publicClient: any, safeAddr: Address, idleWeth: bigint, idleUsdc: bigint) {
  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] =
    await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddr],
    });

  const hasPosition = totalCollateralBase > 0n || totalDebtBase > 0n;

  let deposited = 0n;
  let borrowed = 0n;

  if (hasPosition) {
    try {
      const [wethReserve, usdcReserve] = await Promise.all([
        publicClient.readContract({
          address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
          functionName: 'getReserveData', args: [TOKENS.WETH],
        }),
        publicClient.readContract({
          address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
          functionName: 'getReserveData', args: [TOKENS.USDC],
        }),
      ]);

      const aTokenAddr = (wethReserve as any).aTokenAddress as Address;
      const variableDebtAddr = (usdcReserve as any).variableDebtTokenAddress as Address;

      const [aTokenBal, debtBal] = await Promise.all([
        publicClient.readContract({
          address: aTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr],
        }),
        publicClient.readContract({
          address: variableDebtAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr],
        }),
      ]);

      deposited = aTokenBal as bigint;
      borrowed = debtBal as bigint;
    } catch (err) {
      logger.warn({ err }, 'Failed to read aToken/debtToken balances, using zero');
    }
  }

  let wethPriceUsd = 0;
  if (deposited > 0n && totalCollateralBase > 0n) {
    wethPriceUsd = Number(totalCollateralBase) / 1e8 / (Number(deposited) / 1e18);
  }

  const borrowableUsdc = availableBorrowsBase / 100n;

  let withdrawable = deposited;
  if (totalDebtBase > 0n && deposited > 0n && totalCollateralBase > 0n) {
    const minCollateralBase = (totalDebtBase * 10500n) / currentLiquidationThreshold;
    if (totalCollateralBase > minCollateralBase) {
      const excessBase = totalCollateralBase - minCollateralBase;
      withdrawable = (deposited * excessBase) / totalCollateralBase;
    } else {
      withdrawable = 0n;
    }
  }

  const hfRaw = Number(formatUnits(healthFactor, 18));
  const hfDisplay = totalDebtBase === 0n ? 0 : (hfRaw > 999 ? 999 : hfRaw);

  return {
    position: {
      collateralUsd: Number(formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS)),
      debtUsd: Number(formatUnits(totalDebtBase, AAVE_BASE_DECIMALS)),
      healthFactor: hfDisplay,
      hasPosition,
      ltv: Number(ltv) / 10000,
      maxLtv: Number(ltv) / 10000,
      liquidationThreshold: Number(currentLiquidationThreshold) / 10000,
      protocol: 'Aave V3',
    },
    // Keep legacy "aave" key for backward compatibility with frontend
    aave: {
      collateralUsd: Number(formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS)),
      debtUsd: Number(formatUnits(totalDebtBase, AAVE_BASE_DECIMALS)),
      healthFactor: hfDisplay,
      hasPosition,
      ltv: Number(ltv) / 10000,
      maxLtv: Number(ltv) / 10000,
      liquidationThreshold: Number(currentLiquidationThreshold) / 10000,
      protocol: 'Aave V3',
    },
    balances: {
      weth: {
        deposited: deposited.toString(),
        idle: idleWeth.toString(),
        available: withdrawable.toString(),
        withdrawable: withdrawable.toString(),
        decimals: 18,
        priceUsd: wethPriceUsd,
      },
      usdc: {
        borrowed: borrowed.toString(),
        borrowable: borrowableUsdc.toString(),
        repayable: borrowed.toString(),
        idle: idleUsdc.toString(),
        decimals: 6,
        priceUsd: 1.0,
      },
    },
  };
}

/** Read position data from Morpho Blue */
async function getMorphoPositionInfo(publicClient: any, safeAddr: Address, idleWeth: bigint, idleUsdc: bigint) {
  const marketId = getMorphoMarketId();

  // Read Morpho position and market state in parallel
  const [positionResult, marketResult] = await Promise.all([
    publicClient.readContract({
      address: POOLS.MORPHO_BLUE,
      abi: MORPHO_BLUE_ABI,
      functionName: 'position',
      args: [marketId, safeAddr],
    }),
    publicClient.readContract({
      address: POOLS.MORPHO_BLUE,
      abi: MORPHO_BLUE_ABI,
      functionName: 'market',
      args: [marketId],
    }),
  ]);

  const [, borrowShares, collateral] = positionResult as [bigint, bigint, bigint];
  const [, , totalBorrowAssets, totalBorrowShares] =
    marketResult as [bigint, bigint, bigint, bigint];

  const deposited = collateral; // WETH in raw wei

  // Convert borrowShares to USDC assets: borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares
  let borrowed = 0n;
  if (totalBorrowShares > 0n && borrowShares > 0n) {
    // Round up to be conservative (user owes at least this much)
    borrowed = (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
  }

  const hasPosition = deposited > 0n || borrowed > 0n;

  // Read WETH price from Morpho oracle
  let wethPriceUsd = 0;
  let collateralUsd = 0;
  let debtUsd = 0;
  try {
    // Morpho oracle returns price in 36 decimals (USDC/WETH)
    // price = oracle.price() where 1 WETH = price / 1e36 USDC (adjusted for token decimals)
    const oraclePrice = await publicClient.readContract({
      address: MORPHO_MARKET.oracle,
      abi: [{
        name: 'price',
        type: 'function',
        inputs: [],
        outputs: [{ type: 'uint256' }],
        stateMutability: 'view',
      }] as const,
      functionName: 'price',
    }) as bigint;
    // Morpho oracle price = (USDC per WETH) * 10^(36 + loanDecimals - collateralDecimals)
    // = (USDC per WETH) * 10^(36 + 6 - 18) = (USDC per WETH) * 10^24
    // So: priceUsd = oraclePrice / 10^24
    wethPriceUsd = Number(oraclePrice) / 1e24;
    collateralUsd = (Number(deposited) / 1e18) * wethPriceUsd;
    debtUsd = Number(borrowed) / 1e6;
  } catch (err) {
    logger.warn({ err }, 'Failed to read Morpho oracle price');
    debtUsd = Number(borrowed) / 1e6;
  }

  // Compute health factor: HF = (collateral * LLTV * price) / debt
  // In Morpho terms: HF = (collateral_value * LLTV) / debt_value
  let healthFactor = 0;
  if (borrowed > 0n && collateralUsd > 0) {
    const lltvDecimal = Number(MORPHO_MARKET.lltv) / 1e18;
    healthFactor = (collateralUsd * lltvDecimal) / debtUsd;
    healthFactor = Math.round(healthFactor * 100) / 100;
  }

  // Compute borrowable: maxBorrow = collateral_value * LLTV - current_debt
  const lltvDecimal = Number(MORPHO_MARKET.lltv) / 1e18;
  const maxBorrowUsd = collateralUsd * lltvDecimal;
  const borrowableUsd = Math.max(0, maxBorrowUsd - debtUsd);
  const borrowableUsdc = BigInt(Math.floor(borrowableUsd * 1e6));

  // Compute withdrawable: similar to Aave, keep HF >= 1.05
  let withdrawable = deposited;
  if (borrowed > 0n && deposited > 0n && collateralUsd > 0) {
    // minCollateralUsd = debtUsd * 1.05 / LLTV
    const minCollateralUsd = (debtUsd * 1.05) / lltvDecimal;
    if (collateralUsd > minCollateralUsd) {
      const excessRatio = (collateralUsd - minCollateralUsd) / collateralUsd;
      withdrawable = BigInt(Math.floor(Number(deposited) * excessRatio));
    } else {
      withdrawable = 0n;
    }
  }

  return {
    position: {
      collateralUsd: Math.round(collateralUsd * 100) / 100,
      debtUsd: Math.round(debtUsd * 100) / 100,
      healthFactor,
      hasPosition,
      ltv: lltvDecimal,
      maxLtv: lltvDecimal,
      liquidationThreshold: lltvDecimal,
      protocol: 'Morpho Blue',
    },
    // Legacy key — frontend reads this
    aave: {
      collateralUsd: Math.round(collateralUsd * 100) / 100,
      debtUsd: Math.round(debtUsd * 100) / 100,
      healthFactor,
      hasPosition,
      ltv: lltvDecimal,
      maxLtv: lltvDecimal,
      liquidationThreshold: lltvDecimal,
      protocol: 'Morpho Blue',
    },
    balances: {
      weth: {
        deposited: deposited.toString(),
        idle: idleWeth.toString(),
        available: withdrawable.toString(),
        withdrawable: withdrawable.toString(),
        decimals: 18,
        priceUsd: wethPriceUsd,
      },
      usdc: {
        borrowed: borrowed.toString(),
        borrowable: borrowableUsdc.toString(),
        repayable: borrowed.toString(),
        idle: idleUsdc.toString(),
        decimals: 6,
        priceUsd: 1.0,
      },
    },
  };
}

// ─── Simulate Action ────────────────────────────────────────────────────────

export async function simulateAction(
  userAddress: string,
  action: 'deposit' | 'withdraw' | 'borrow' | 'repay',
  amount: bigint,
  tokenAddress?: string,
) {
  const user = await getUser(userAddress);
  if (!user?.safe_address) throw new Error('No Safe address');

  const publicClient = getPublicClient();
  const safeAddr = user.safe_address as Address;

  const [totalCollateralBase, totalDebtBase, , currentLiquidationThreshold, , healthFactor] =
    await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddr],
    });

  const currentHf = totalDebtBase === 0n ? 999 : Number(formatUnits(healthFactor, 18));

  // Convert amount to 8-decimal USD base units for math
  let amountBase: bigint;
  const token = (tokenAddress || '').toLowerCase();

  if (action === 'borrow' || action === 'repay' || token === TOKENS.USDC.toLowerCase()) {
    // USDC: 6 decimals → 8 decimals USD (multiply by 100)
    amountBase = amount * 100n;
  } else {
    // WETH: derive price from current position
    if (totalCollateralBase > 0n) {
      // Get deposited amount to compute price
      try {
        const wethReserve = await publicClient.readContract({
          address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
          functionName: 'getReserveData', args: [TOKENS.WETH],
        });
        const aTokenAddr = (wethReserve as any).aTokenAddress as Address;
        const deposited = await publicClient.readContract({
          address: aTokenAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr],
        }) as bigint;

        if (deposited > 0n) {
          amountBase = (amount * totalCollateralBase) / deposited;
        } else {
          amountBase = 0n;
        }
      } catch {
        amountBase = 0n;
      }
    } else {
      amountBase = 0n;
    }
  }

  let projectedCollateral = totalCollateralBase;
  let projectedDebt = totalDebtBase;

  switch (action) {
    case 'deposit':
      projectedCollateral = totalCollateralBase + amountBase;
      break;
    case 'withdraw':
      projectedCollateral = totalCollateralBase > amountBase ? totalCollateralBase - amountBase : 0n;
      break;
    case 'borrow':
      projectedDebt = totalDebtBase + amountBase;
      break;
    case 'repay':
      projectedDebt = totalDebtBase > amountBase ? totalDebtBase - amountBase : 0n;
      break;
  }

  let projectedHf: number;
  if (projectedDebt === 0n) {
    projectedHf = 999;
  } else {
    // HF = collateral * LT / debt
    // LT is in basis points (e.g., 8250 = 82.5%)
    projectedHf = (Number(projectedCollateral) * Number(currentLiquidationThreshold)) /
      (Number(projectedDebt) * 10000);
  }

  return {
    currentHealthFactor: currentHf,
    projectedHealthFactor: Math.round(projectedHf * 100) / 100,
    safe: projectedHf >= 1.05,
  };
}

// ─── Protocol Rates ─────────────────────────────────────────────────────────

/** Morpho Blue GraphQL endpoint */
const MORPHO_API_URL = 'https://blue-api.morpho.org/graphql';

/** Our specific WETH/USDC market on Base */
const MORPHO_MARKET_ID = '0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda';

const MORPHO_MARKET_QUERY = `query MarketRates($marketId: String!, $chainId: Int!) {
  marketByUniqueKey(uniqueKey: $marketId, chainId: $chainId) {
    loanAsset { symbol priceUsd }
    collateralAsset { symbol priceUsd }
    lltv
    state {
      borrowApy
      supplyApy
      fee
      utilization
      borrowAssetsUsd
      supplyAssetsUsd
      collateralAssetsUsd
      rewards {
        asset { symbol }
        supplyApr
        borrowApr
      }
    }
  }
}`;

interface ProtocolRates {
  /** WETH collateral supply APY (decimal, e.g., 0.0171 = 1.71%) */
  collateralSupplyApy: number;
  /** USDC borrow APY (decimal, e.g., 0.0392 = 3.92%) */
  borrowApy: number;
  /** USDC lender supply APY — informational, not used in rebalance calc */
  lenderSupplyApy: number;
  /** Utilization rate (decimal, e.g., 0.90 = 90%) */
  utilization: number | null;
}

interface RatesResponse {
  aave: ProtocolRates;
  morpho: ProtocolRates;
  /** ETH/USD price used for USD-normalized calculations */
  ethPriceUsd: number;
  /** Market metadata */
  market: {
    collateralToken: string;
    debtToken: string;
    morphoLltv: number;
  };
  /** Pre-calculated example for a given position (if position data provided) */
  rebalancePreview: {
    aaveNetCostUsd: number;
    morphoNetCostUsd: number;
    annualSavingsUsd: number;
    cheaperProtocol: 'aave_v3' | 'morpho_blue' | 'equal';
    explanation: string;
  } | null;
  fetchedAt: string;
}

/**
 * Fetch current APY/APR rates from both Aave V3 and Morpho Blue.
 *
 * Key distinction:
 *   - collateralSupplyApy = what WETH collateral earns (Aave: >0, Morpho: 0)
 *   - borrowApy = what USDC debt costs
 *   - lenderSupplyApy = what USDC lenders earn (informational only)
 *
 * Morpho Blue collateral does NOT earn supply APY — it sits idle as security.
 * Only USDC lenders earn supplyApy on Morpho. This is a critical difference from Aave
 * where aTokens (collateral) accrue interest.
 */
export async function getProtocolRates(
  collateralUsd?: number,
  debtUsd?: number,
): Promise<RatesResponse> {
  const publicClient = getPublicClient();

  // Fetch Aave rates (on-chain) and Morpho rates (API) in parallel
  const [aaveWethReserve, aaveUsdcReserve, morphoData] = await Promise.all([
    publicClient.readContract({
      address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
      functionName: 'getReserveData', args: [TOKENS.WETH],
    }),
    publicClient.readContract({
      address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
      functionName: 'getReserveData', args: [TOKENS.USDC],
    }),
    fetchMorphoMarketRates(),
  ]);

  // Aave rates are in RAY (1e27). Convert to decimal.
  const aaveWethSupplyApy = Number((aaveWethReserve as any).currentLiquidityRate) / 1e27;
  const aaveUsdcBorrowApy = Number((aaveUsdcReserve as any).currentVariableBorrowRate) / 1e27;
  const aaveUsdcSupplyApy = Number((aaveUsdcReserve as any).currentLiquidityRate) / 1e27;

  const aave: ProtocolRates = {
    collateralSupplyApy: round4(aaveWethSupplyApy),
    borrowApy: round4(aaveUsdcBorrowApy),
    lenderSupplyApy: round4(aaveUsdcSupplyApy),
    utilization: null, // Aave doesn't expose a single utilization number easily
  };

  const morpho: ProtocolRates = {
    // Morpho Blue: collateral earns NOTHING. It's locked idle.
    collateralSupplyApy: 0,
    borrowApy: round4(morphoData.borrowApy),
    lenderSupplyApy: round4(morphoData.supplyApy),
    utilization: round4(morphoData.utilization),
  };

  const ethPriceUsd = morphoData.ethPriceUsd;

  // Pre-calculate rebalance preview if position data is provided
  let rebalancePreview: RatesResponse['rebalancePreview'] = null;
  if (collateralUsd != null && debtUsd != null && debtUsd > 0) {
    const aaveNetCost = (debtUsd * aave.borrowApy) - (collateralUsd * aave.collateralSupplyApy);
    const morphoNetCost = (debtUsd * morpho.borrowApy) - (collateralUsd * morpho.collateralSupplyApy);
    const savings = aaveNetCost - morphoNetCost; // positive = Morpho is cheaper

    let cheaperProtocol: 'aave_v3' | 'morpho_blue' | 'equal';
    if (Math.abs(savings) < 1) cheaperProtocol = 'equal';
    else cheaperProtocol = savings > 0 ? 'morpho_blue' : 'aave_v3';

    const collateralFmt = `$${collateralUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
    const debtFmt = `$${debtUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;

    rebalancePreview = {
      aaveNetCostUsd: round2(aaveNetCost),
      morphoNetCostUsd: round2(morphoNetCost),
      annualSavingsUsd: round2(Math.abs(savings)),
      cheaperProtocol,
      explanation: cheaperProtocol === 'equal'
        ? `For ${collateralFmt} collateral / ${debtFmt} debt: both protocols cost roughly the same.`
        : `For ${collateralFmt} collateral / ${debtFmt} debt: ${cheaperProtocol === 'aave_v3' ? 'Aave' : 'Morpho'} saves ~$${Math.abs(savings).toFixed(2)}/year.`
        + (cheaperProtocol === 'aave_v3'
          ? ` Aave's WETH supply earnings (${(aave.collateralSupplyApy * 100).toFixed(2)}%) offset its higher borrow rate.`
          : ` Morpho's lower borrow rate (${(morpho.borrowApy * 100).toFixed(2)}% vs ${(aave.borrowApy * 100).toFixed(2)}%) outweighs Aave's supply earnings.`),
    };
  }

  return {
    aave,
    morpho,
    ethPriceUsd: round2(ethPriceUsd),
    market: {
      collateralToken: 'WETH',
      debtToken: 'USDC',
      morphoLltv: 0.86,
    },
    rebalancePreview,
    fetchedAt: new Date().toISOString(),
  };
}

/** Fetch Morpho Blue market rates from their GraphQL API */
async function fetchMorphoMarketRates(): Promise<{
  borrowApy: number;
  supplyApy: number;
  utilization: number;
  ethPriceUsd: number;
}> {
  try {
    const res = await fetch(MORPHO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: MORPHO_MARKET_QUERY,
        variables: { marketId: MORPHO_MARKET_ID, chainId: 8453 },
      }),
    });
    const json = await res.json() as any;
    const market = json?.data?.marketByUniqueKey;
    if (!market?.state) throw new Error('No market state returned');

    return {
      borrowApy: market.state.borrowApy ?? 0,
      supplyApy: market.state.supplyApy ?? 0,
      utilization: market.state.utilization ?? 0,
      ethPriceUsd: market.collateralAsset?.priceUsd ?? 0,
    };
  } catch (err: any) {
    logger.error({ err: err.message }, 'Failed to fetch Morpho market rates');
    return { borrowApy: 0, supplyApy: 0, utilization: 0, ethPriceUsd: 0 };
  }
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
