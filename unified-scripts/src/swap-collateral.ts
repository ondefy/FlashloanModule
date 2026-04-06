import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, formatEther, formatUnits, maxUint256, type Address } from 'viem';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';
import { ERC20_ABI, AAVE_POOL_ABI, MORPHO_BLUE_ABI, UNIFIED_MODULE_ABI } from './abis.js';
import {
  ADDRESSES,
  MORPHO_MARKET_PARAMS,
  AAVE_BASE_DECIMALS,
  USDC_DECIMALS,
  VARIABLE_RATE,
  REPAY_BUFFER_MAX_USDC,
  FLASHLOAN_MIN_USDC,
  FlashloanProvider,
} from './constants.js';

type Execution = {
  target: Address;
  value: bigint;
  callData: `0x${string}`;
};

/**
 * Swap collateral from Aave to Morpho Blue using UnifiedFlashloanModule v4.
 *
 * No signatures needed — security is handled by TargetRegistry whitelist.
 *
 * Atomic flow inside a Morpho Blue flashloan (0% fee):
 *   1. Flash borrow USDC
 *   2. Approve USDC to Aave
 *   3. Repay all USDC debt on Aave
 *   4. Withdraw all WETH from Aave
 *   5. Approve WETH to Morpho Blue
 *   6. Supply WETH as collateral on Morpho Blue
 *   7. Borrow USDC from Morpho Blue (repay flashloan)
 *
 * Prerequisites:
 *   - Safe deployed (create-safe.ts)
 *   - Module installed (install-module.ts)
 *   - Safe has an Aave position (WETH collateral + USDC debt)
 *   - TargetRegistry has whitelisted all required selectors
 *
 * Required .env:
 *   PRIVATE_KEY              - owner private key
 *   SAFE_ACCOUNT_ADDRESS     - deployed Safe address
 *   UNIFIED_MODULE_ADDRESS   - deployed UnifiedFlashloanModule proxy address
 *   BASE_RPC_URL             - Base RPC endpoint
 *   PIMLICO_API_KEY          - Pimlico bundler/paymaster key
 *
 * Run: yarn swap-collateral
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Swap Collateral: Aave -> Morpho Blue (Flashloan v4)');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress, moduleAddress } = getEnv();

  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set in .env');
  if (!moduleAddress) throw new Error('UNIFIED_MODULE_ADDRESS not set in .env');

  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);
  console.log('Module:', moduleAddress);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  // ============================================================
  //  STEP 1: Read current Aave position
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log('Step 1: Read Current Aave Position');
  console.log('='.repeat(50));

  const [totalCollateralBase, totalDebtBase, , , , healthFactor] =
    await publicClient.readContract({
      address: ADDRESSES.AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddress],
    });

  console.log('  Collateral (USD):', formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS));
  console.log('  Debt (USD):', formatUnits(totalDebtBase, AAVE_BASE_DECIMALS));
  console.log('  Health factor:', formatUnits(healthFactor, 18));

  if (totalDebtBase === 0n) {
    throw new Error('No Aave debt found. Create an Aave position first.');
  }

  // Get aWETH balance (= exact collateral amount)
  const reserveData = await publicClient.readContract({
    address: ADDRESSES.AAVE_POOL,
    abi: AAVE_POOL_ABI,
    functionName: 'getReserveData',
    args: [ADDRESSES.WETH],
  });

  const aWethAddress = reserveData.aTokenAddress as Address;
  const collateralWeth = await publicClient.readContract({
    address: aWethAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [safeAddress],
  });

  console.log('  WETH collateral:', formatEther(collateralWeth));
  if (collateralWeth === 0n) throw new Error('No WETH collateral on Aave.');

  // ============================================================
  //  STEP 2: Calculate flashloan amount
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log('Step 2: Calculate Flashloan Amount');
  console.log('='.repeat(50));

  // Convert debt from 8-decimal USD to 6-decimal USDC (round up)
  const debtUsdc =
    (totalDebtBase * BigInt(10 ** USDC_DECIMALS) + BigInt(10 ** AAVE_BASE_DECIMALS) - 1n) /
    BigInt(10 ** AAVE_BASE_DECIMALS);
  const bufferUsdc = debtUsdc >= REPAY_BUFFER_MAX_USDC ? REPAY_BUFFER_MAX_USDC : debtUsdc;
  let flashloanAmount = debtUsdc + bufferUsdc;
  if (flashloanAmount < FLASHLOAN_MIN_USDC) flashloanAmount = FLASHLOAN_MIN_USDC;

  console.log('  Aave debt (USDC):', formatUnits(debtUsdc, USDC_DECIMALS));
  console.log('  Buffer:', formatUnits(bufferUsdc, USDC_DECIMALS), 'USDC');
  console.log('  Flashloan amount:', formatUnits(flashloanAmount, USDC_DECIMALS), 'USDC');

  // ============================================================
  //  STEP 3: Build callback executions
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log('Step 3: Build Callback Executions');
  console.log('='.repeat(50));

  const executions: Execution[] = [
    // 1. Approve USDC to Aave
    {
      target: ADDRESSES.USDC,
      value: 0n,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.AAVE_POOL, flashloanAmount],
      }),
    },
    // 2. Repay all Aave debt
    {
      target: ADDRESSES.AAVE_POOL,
      value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: 'repay',
        args: [ADDRESSES.USDC, maxUint256, VARIABLE_RATE, safeAddress],
      }),
    },
    // 3. Withdraw all WETH from Aave
    {
      target: ADDRESSES.AAVE_POOL,
      value: 0n,
      callData: encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: 'withdraw',
        args: [ADDRESSES.WETH, maxUint256, safeAddress],
      }),
    },
    // 4. Approve WETH to Morpho Blue
    {
      target: ADDRESSES.WETH,
      value: 0n,
      callData: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ADDRESSES.MORPHO_BLUE, collateralWeth],
      }),
    },
    // 5. Supply WETH collateral on Morpho Blue
    {
      target: ADDRESSES.MORPHO_BLUE,
      value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI,
        functionName: 'supplyCollateral',
        args: [MORPHO_MARKET_PARAMS, collateralWeth, safeAddress, '0x'],
      }),
    },
    // 6. Borrow USDC from Morpho Blue (repay flashloan — 0% fee)
    {
      target: ADDRESSES.MORPHO_BLUE,
      value: 0n,
      callData: encodeFunctionData({
        abi: MORPHO_BLUE_ABI,
        functionName: 'borrow',
        args: [MORPHO_MARKET_PARAMS, flashloanAmount, 0n, safeAddress, safeAddress],
      }),
    },
  ];

  console.log('  1. Approve USDC -> Aave');
  console.log('  2. Repay all USDC debt on Aave');
  console.log('  3. Withdraw all WETH from Aave');
  console.log('  4. Approve WETH -> Morpho Blue');
  console.log('  5. Supply WETH collateral on Morpho Blue');
  console.log('  6. Borrow USDC from Morpho Blue');
  console.log(`  Total: ${executions.length} executions`);

  // ============================================================
  //  STEP 4: Execute flashloan via Safe (no signature needed)
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log('Step 4: Execute Flashloan');
  console.log('='.repeat(50));

  const initiateCalldata = encodeFunctionData({
    abi: UNIFIED_MODULE_ABI,
    functionName: 'initiateFlashloan',
    args: [FlashloanProvider.MORPHO, ADDRESSES.USDC, flashloanAmount, executions],
  });

  console.log('  Provider: Morpho Blue (0% fee)');
  console.log('  Calling initiateFlashloan() via Safe...');

  const userOpHash = await smartClient.sendTransaction({
    calls: [{ to: moduleAddress, value: 0n, data: initiateCalldata }],
  });

  console.log('  UserOp hash:', userOpHash);
  console.log('  Waiting for confirmation...');

  try {
    const receipt = await smartClient.waitForUserOperationReceipt({
      hash: userOpHash,
      timeout: 60_000,
      pollingInterval: 3_000,
    });
    console.log('  Tx:', receipt.receipt.transactionHash);
    console.log('  Block:', receipt.receipt.blockNumber);
  } catch {
    console.log('  Receipt timed out — tx may still confirm on-chain.');
    console.log('  Check: https://jiffyscan.xyz/userOpHash/' + userOpHash + '?network=base');
  }

  // ============================================================
  //  STEP 5: Verify final state
  // ============================================================
  console.log('\n' + '='.repeat(50));
  console.log('Step 5: Verify Final State');
  console.log('='.repeat(50));

  const [aaveCollateral, aaveDebt] = await publicClient.readContract({
    address: ADDRESSES.AAVE_POOL,
    abi: AAVE_POOL_ABI,
    functionName: 'getUserAccountData',
    args: [safeAddress],
  });

  const usdcBalance = await publicClient.readContract({
    address: ADDRESSES.USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [safeAddress],
  });

  console.log('\n  Aave:');
  console.log('    Collateral (USD):', formatUnits(aaveCollateral, AAVE_BASE_DECIMALS));
  console.log('    Debt (USD):', formatUnits(aaveDebt, AAVE_BASE_DECIMALS));
  console.log('    Status:', aaveDebt === 0n ? 'CLOSED' : 'WARNING - still has debt');
  console.log('  Safe USDC balance:', formatUnits(usdcBalance, USDC_DECIMALS));

  console.log('\n' + '='.repeat(50));
  console.log('Collateral swap complete!');
  console.log('='.repeat(50));
  console.log('  Aave: position closed');
  console.log('  Morpho Blue: WETH collateral + USDC debt');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
