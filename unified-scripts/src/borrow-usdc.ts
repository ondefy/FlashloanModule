import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, formatEther, formatUnits, parseUnits, type Address } from 'viem';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';
import { ERC20_ABI, AAVE_POOL_ABI } from './abis.js';
import { ADDRESSES, AAVE_BASE_DECIMALS, USDC_DECIMALS, VARIABLE_RATE } from './constants.js';

/**
 * Borrow USDC from Aave V3 against Safe's collateral.
 * The borrowed USDC is transferred to the owner's EOA.
 *
 * Flow:
 *   1. Check Aave position (collateral, available borrows)
 *   2. Borrow USDC from Aave
 *   3. Transfer USDC from Safe to owner EOA
 *
 * Required .env:
 *   PRIVATE_KEY
 *   SAFE_ACCOUNT_ADDRESS
 *   BASE_RPC_URL
 *   PIMLICO_API_KEY
 *
 * Usage:
 *   yarn borrow-usdc -- --amount 100     # Borrow 100 USDC
 *   yarn borrow-usdc -- --amount 1000    # Borrow 1000 USDC
 *
 * Run: yarn borrow-usdc -- --amount <USDC_AMOUNT>
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Borrow USDC from Aave V3');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);

  // Parse amount
  const amountArg = process.argv.find((_, i) => process.argv[i - 1] === '--amount');
  if (!amountArg) {
    throw new Error('Usage: yarn borrow-usdc -- --amount <USDC_AMOUNT>\n  Example: yarn borrow-usdc -- --amount 100');
  }
  const borrowAmount = parseUnits(amountArg, USDC_DECIMALS); // e.g. "100" -> 100_000_000
  console.log(`\n  Borrow amount: ${amountArg} USDC (${borrowAmount.toString()} raw)`);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  // ─── Check current Aave position ──────────────────────────────
  console.log('\n  Checking Aave position...');
  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, , , healthFactor] =
    await publicClient.readContract({
      address: ADDRESSES.AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddress],
    });

  console.log('  Collateral (USD):', formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS));
  console.log('  Current Debt (USD):', formatUnits(totalDebtBase, AAVE_BASE_DECIMALS));
  console.log('  Available to Borrow (USD):', formatUnits(availableBorrowsBase, AAVE_BASE_DECIMALS));
  if (totalDebtBase > 0n) {
    console.log('  Health Factor:', formatUnits(healthFactor, 18));
  }

  if (totalCollateralBase === 0n) {
    throw new Error('No collateral on Aave. Run yarn deposit-weth first.');
  }

  // Rough check: available borrows is in 8-decimal USD, borrowAmount is 6-decimal
  const borrowUsd = borrowAmount * BigInt(10 ** (AAVE_BASE_DECIMALS - USDC_DECIMALS)); // convert 6-dec to 8-dec
  if (borrowUsd > availableBorrowsBase) {
    console.warn(`\n  WARNING: Requesting ${amountArg} USDC but only ${formatUnits(availableBorrowsBase, AAVE_BASE_DECIMALS)} USD available.`);
    console.warn('  Transaction may revert if amount exceeds borrow capacity.');
  }

  // ─── Build transaction: Borrow + Transfer ─────────────────────
  const calls: { to: Address; value: bigint; data: `0x${string}` }[] = [
    // 1. Borrow USDC from Aave (variable rate)
    {
      to: ADDRESSES.AAVE_POOL,
      value: 0n,
      data: encodeFunctionData({
        abi: AAVE_POOL_ABI,
        functionName: 'borrow',
        args: [ADDRESSES.USDC, borrowAmount, VARIABLE_RATE, 0, safeAddress],
      }),
    },
    // 2. Transfer USDC from Safe to owner's EOA
    {
      to: ADDRESSES.USDC,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [eoaAccount.address, borrowAmount],
      }),
    },
  ];

  console.log('\n  Step 1: Borrow', amountArg, 'USDC from Aave (variable rate)');
  console.log('  Step 2: Transfer', amountArg, 'USDC to EOA', eoaAccount.address);

  // ─── Execute ───────────────────────────────────────────────────
  console.log('\n  Sending transaction...');
  const userOpHash = await smartClient.sendTransaction({ calls });
  console.log('  UserOp hash:', userOpHash);

  console.log('  Waiting for confirmation...');
  try {
    const receipt = await smartClient.waitForUserOperationReceipt({
      hash: userOpHash,
      timeout: 180_000,
      pollingInterval: 2_000,
    });
    console.log('  Tx:', receipt.receipt.transactionHash);
  } catch {
    console.log('  Receipt polling timed out — tx may still confirm on-chain.');
    console.log('  Check: https://jiffyscan.xyz/userOpHash/' + userOpHash + '?network=base');
  }

  // ─── Verify ────────────────────────────────────────────────────
  const [newCollateral, newDebt, , , , newHf] =
    await publicClient.readContract({
      address: ADDRESSES.AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddress],
    });

  const eoaUsdcBalance = await publicClient.readContract({
    address: ADDRESSES.USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [eoaAccount.address],
  }) as bigint;

  console.log('\n' + '='.repeat(50));
  console.log('Borrow complete!');
  console.log('='.repeat(50));
  console.log('  Collateral (USD):', formatUnits(newCollateral, AAVE_BASE_DECIMALS));
  console.log('  Debt (USD):', formatUnits(newDebt, AAVE_BASE_DECIMALS));
  console.log('  Health Factor:', formatUnits(newHf, 18));
  console.log('  EOA USDC balance:', formatUnits(eoaUsdcBalance, USDC_DECIMALS));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
