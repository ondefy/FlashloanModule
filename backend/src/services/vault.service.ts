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

  // Supply the WETH that's already in the Safe to Aave
  return supplyWethToAave(userAddress, user.address, user.safe_address, amount);
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

  if (position.current_protocol !== 'aave_v3') {
    throw new Error('Morpho repay not yet implemented');
  }

  const executions: Execution[] = [
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

  if (position.current_protocol !== 'aave_v3') {
    throw new Error('Morpho withdraw not yet implemented');
  }

  const executions: Execution[] = [
    {
      target: POOLS.AAVE_V3,
      value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI, functionName: 'withdraw',
        args: [token, amount, user.address as Address], // withdraw directly to EOA
      }),
    },
  ];

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

  // Read idle WETH sitting in Safe (not yet supplied to any protocol)
  let idleWeth = 0n;
  try {
    idleWeth = await publicClient.readContract({
      address: TOKENS.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddr],
    }) as bigint;
  } catch { /* ignore */ }

  if (currentProtocol === 'morpho_blue') {
    return getMorphoPositionInfo(publicClient, safeAddr, idleWeth);
  }
  return getAavePositionInfo(publicClient, safeAddr, idleWeth);
}

/** Read position data from Aave V3 */
async function getAavePositionInfo(publicClient: any, safeAddr: Address, idleWeth: bigint) {
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
        decimals: 6,
        priceUsd: 1.0,
      },
    },
  };
}

/** Read position data from Morpho Blue */
async function getMorphoPositionInfo(publicClient: any, safeAddr: Address, idleWeth: bigint) {
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

  const [supplyShares, borrowShares, collateral] = positionResult as [bigint, bigint, bigint];
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] =
    marketResult as [bigint, bigint, bigint, bigint];

  const deposited = collateral; // WETH in raw wei

  // Convert borrowShares to USDC assets: borrowAssets = borrowShares * totalBorrowAssets / totalBorrowShares
  let borrowed = 0n;
  if (totalBorrowShares > 0n && borrowShares > 0n) {
    // Round up to be conservative (user owes at least this much)
    borrowed = (borrowShares * totalBorrowAssets + totalBorrowShares - 1n) / totalBorrowShares;
  }

  const hasPosition = deposited > 0n || borrowed > 0n;

  // Derive WETH price from Aave oracle (still available even if position is on Morpho)
  let wethPriceUsd = 0;
  let collateralUsd = 0;
  let debtUsd = 0;
  try {
    const [totalCollateralBase] = await publicClient.readContract({
      address: POOLS.AAVE_V3,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddr],
    });
    // If Aave still has some dust, use that. Otherwise read WETH price from Aave reserve.
    // Simpler: use Aave's price feed via a small test
    const aaveWethReserve = await publicClient.readContract({
      address: POOLS.AAVE_V3, abi: AAVE_POOL_ABI,
      functionName: 'getReserveData', args: [TOKENS.WETH],
    });
    // Aave doesn't expose price directly, but we can estimate from market data
    // For now, use a simpler approach: collateral value from Morpho's perspective
  } catch { /* ignore */ }

  // Compute USD values using a simple price derivation
  // Morpho LLTV = 0.86, if we know borrowed USDC ($1 each), we can derive collateral value
  // But cleaner: read WETH price from the Morpho oracle
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

export async function getProtocolRates() {
  const publicClient = getPublicClient();

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

  // Aave rates are in RAY (1e27). Convert to decimal APY.
  const aaveSupplyApy = Number((wethReserve as any).currentLiquidityRate) / 1e27;
  const aaveBorrowApy = Number((usdcReserve as any).currentVariableBorrowRate) / 1e27;

  return {
    aave: {
      supplyApy: Math.round(aaveSupplyApy * 10000) / 10000, // 4 decimal places
      borrowApy: Math.round(aaveBorrowApy * 10000) / 10000,
    },
    morpho: {
      supplyApy: null, // TODO: Fetch Morpho rates
      borrowApy: null,
    },
  };
}
