import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, formatEther, formatUnits, parseEther, type Address } from 'viem';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';
import { ERC20_ABI, AAVE_POOL_ABI, WETH_ABI } from './abis.js';
import { ADDRESSES, AAVE_BASE_DECIMALS } from './constants.js';

/**
 * Deposit WETH as collateral on Aave V3 via the Safe.
 *
 * Flow:
 *   1. Check Safe WETH balance
 *   2. Approve WETH to Aave
 *   3. Supply WETH to Aave as collateral
 *
 * If the Safe has ETH instead of WETH, it wraps it first.
 *
 * Required .env:
 *   PRIVATE_KEY
 *   SAFE_ACCOUNT_ADDRESS
 *   BASE_RPC_URL
 *   PIMLICO_API_KEY
 *
 * Usage:
 *   yarn deposit-weth                    # Deposits all WETH in Safe
 *   yarn deposit-weth -- --amount 0.01   # Deposits 0.01 WETH
 *
 * Run: yarn deposit-weth
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Deposit WETH as Collateral on Aave V3');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  // ─── Check balances ────────────────────────────────────────────
  const ethBalance = await publicClient.getBalance({ address: safeAddress });
  const wethBalance = await publicClient.readContract({
    address: ADDRESSES.WETH,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [safeAddress],
  }) as bigint;

  console.log('\n  Safe ETH balance:', formatEther(ethBalance));
  console.log('  Safe WETH balance:', formatEther(wethBalance));

  // Parse amount from CLI args or use all WETH
  const amountArg = process.argv.find((_, i) => process.argv[i - 1] === '--amount');
  let depositAmount: bigint;

  if (amountArg) {
    depositAmount = parseEther(amountArg);
    console.log(`\n  Depositing ${amountArg} WETH`);
  } else {
    depositAmount = wethBalance;
    console.log(`\n  Depositing all WETH: ${formatEther(wethBalance)}`);
  }

  if (depositAmount === 0n && ethBalance === 0n) {
    throw new Error('No WETH or ETH in Safe. Send WETH to your Safe first.');
  }

  // ─── Build transaction calls ───────────────────────────────────
  const calls: { to: Address; value: bigint; data: `0x${string}` }[] = [];

  // If not enough WETH but have ETH, wrap ETH -> WETH
  if (depositAmount > wethBalance && ethBalance > 0n) {
    const wrapAmount = depositAmount - wethBalance > ethBalance
      ? ethBalance
      : depositAmount - wethBalance;

    console.log(`  Wrapping ${formatEther(wrapAmount)} ETH -> WETH`);
    calls.push({
      to: ADDRESSES.WETH,
      value: wrapAmount,
      data: encodeFunctionData({ abi: WETH_ABI, functionName: 'deposit' }),
    });
    depositAmount = wethBalance + wrapAmount;
  }

  if (depositAmount === 0n) {
    throw new Error('No WETH available to deposit.');
  }

  // Approve WETH to Aave
  console.log(`  Approving ${formatEther(depositAmount)} WETH to Aave`);
  calls.push({
    to: ADDRESSES.WETH,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [ADDRESSES.AAVE_POOL, depositAmount],
    }),
  });

  // Supply WETH to Aave
  console.log(`  Supplying ${formatEther(depositAmount)} WETH to Aave`);
  calls.push({
    to: ADDRESSES.AAVE_POOL,
    value: 0n,
    data: encodeFunctionData({
      abi: AAVE_POOL_ABI,
      functionName: 'supply',
      args: [ADDRESSES.WETH, depositAmount, safeAddress, 0],
    }),
  });

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
  const [totalCollateralBase, totalDebtBase, , , , healthFactor] =
    await publicClient.readContract({
      address: ADDRESSES.AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddress],
    });

  console.log('\n' + '='.repeat(50));
  console.log('Deposit complete!');
  console.log('='.repeat(50));
  console.log('  Collateral (USD):', formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS));
  console.log('  Debt (USD):', formatUnits(totalDebtBase, AAVE_BASE_DECIMALS));
  console.log('  Health Factor:', totalDebtBase > 0n ? formatUnits(healthFactor, 18) : 'N/A (no debt)');
  console.log('\nNext: yarn borrow-usdc -- --amount 100');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
