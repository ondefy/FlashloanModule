import { privateKeyToAccount } from 'viem/accounts';
import { formatEther, formatUnits, type Address } from 'viem';
import { getEnv, createClients } from './setup.js';
import { ERC20_ABI, AAVE_POOL_ABI } from './abis.js';
import { ADDRESSES, AAVE_BASE_DECIMALS, USDC_DECIMALS } from './constants.js';

/**
 * Check the current position status of the Safe on Aave V3.
 * Shows balances, collateral, debt, and health factor.
 *
 * Run: yarn check-position
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Position Status');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  const { publicClient } = createClients(rpcUrl, pimlicoApiKey);

  // ─── Safe balances ─────────────────────────────────────────────
  const ethBalance = await publicClient.getBalance({ address: safeAddress });
  const wethBalance = await publicClient.readContract({
    address: ADDRESSES.WETH, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddress],
  }) as bigint;
  const usdcBalance = await publicClient.readContract({
    address: ADDRESSES.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddress],
  }) as bigint;

  console.log('\n  Safe:', safeAddress);
  console.log('  Owner EOA:', eoaAccount.address);
  console.log('\n  --- Safe Balances ---');
  console.log('  ETH:', formatEther(ethBalance));
  console.log('  WETH:', formatEther(wethBalance));
  console.log('  USDC:', formatUnits(usdcBalance, USDC_DECIMALS));

  // ─── EOA balances ──────────────────────────────────────────────
  const eoaEth = await publicClient.getBalance({ address: eoaAccount.address });
  const eoaUsdc = await publicClient.readContract({
    address: ADDRESSES.USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [eoaAccount.address],
  }) as bigint;

  console.log('\n  --- EOA Balances ---');
  console.log('  ETH:', formatEther(eoaEth));
  console.log('  USDC:', formatUnits(eoaUsdc, USDC_DECIMALS));

  // ─── Aave Position ─────────────────────────────────────────────
  const [totalCollateralBase, totalDebtBase, availableBorrowsBase, currentLiquidationThreshold, ltv, healthFactor] =
    await publicClient.readContract({
      address: ADDRESSES.AAVE_POOL,
      abi: AAVE_POOL_ABI,
      functionName: 'getUserAccountData',
      args: [safeAddress],
    });

  console.log('\n  --- Aave V3 Position ---');
  if (totalCollateralBase === 0n && totalDebtBase === 0n) {
    console.log('  No position on Aave.');
  } else {
    console.log('  Collateral (USD):', formatUnits(totalCollateralBase, AAVE_BASE_DECIMALS));
    console.log('  Debt (USD):', formatUnits(totalDebtBase, AAVE_BASE_DECIMALS));
    console.log('  Available Borrows (USD):', formatUnits(availableBorrowsBase, AAVE_BASE_DECIMALS));
    console.log('  LTV:', (Number(ltv) / 100).toFixed(2) + '%');
    console.log('  Liquidation Threshold:', (Number(currentLiquidationThreshold) / 100).toFixed(2) + '%');
    if (totalDebtBase > 0n) {
      console.log('  Health Factor:', formatUnits(healthFactor, 18));
    } else {
      console.log('  Health Factor: N/A (no debt)');
    }

    // Get actual aWETH balance
    try {
      const reserveData = await publicClient.readContract({
        address: ADDRESSES.AAVE_POOL, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [ADDRESSES.WETH],
      });
      const aWethAddr = (reserveData as any).aTokenAddress as Address;
      const aWethBal = await publicClient.readContract({
        address: aWethAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddress],
      }) as bigint;
      console.log('  aWETH (collateral):', formatEther(aWethBal));
    } catch { /* skip */ }

    // Get actual variable debt
    try {
      const reserveData = await publicClient.readContract({
        address: ADDRESSES.AAVE_POOL, abi: AAVE_POOL_ABI, functionName: 'getReserveData', args: [ADDRESSES.USDC],
      });
      const vDebtAddr = (reserveData as any).variableDebtTokenAddress as Address;
      const vDebtBal = await publicClient.readContract({
        address: vDebtAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [safeAddress],
      }) as bigint;
      console.log('  Variable Debt USDC:', formatUnits(vDebtBal, USDC_DECIMALS));
    } catch { /* skip */ }
  }

  console.log('\n' + '='.repeat(50));
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
