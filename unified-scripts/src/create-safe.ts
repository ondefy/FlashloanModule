import { privateKeyToAccount } from 'viem/accounts';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';

/**
 * Create and deploy a new Safe smart account on Base mainnet.
 *
 * Uses PRIVATE_KEY as the sole owner. The Safe is ERC-7579 enabled with Rhinestone attesters.
 *
 * Required .env:
 *   PRIVATE_KEY       - owner private key (0x prefixed)
 *   BASE_RPC_URL      - Base RPC endpoint
 *   PIMLICO_API_KEY   - Pimlico bundler/paymaster key
 *
 * Run: yarn create-safe
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Creating Safe Smart Account on Base');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey } = getEnv();
  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount);

  const safeAddress = await safeAccount.getAddress();
  console.log('Safe account address:', safeAddress);

  // Check if already deployed
  const code = await publicClient.getCode({ address: safeAddress });
  if (code && code !== '0x') {
    console.log('\nSafe already deployed. Add to .env:');
    console.log(`  SAFE_ACCOUNT_ADDRESS=${safeAddress}`);
    return;
  }

  console.log('\nDeploying Safe...');
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  const deployHash = await smartClient.sendTransaction({
    to: safeAddress,
    value: 0n,
    data: '0x',
  });

  console.log('UserOp hash:', deployHash);
  const receipt = await smartClient.waitForUserOperationReceipt({ hash: deployHash });

  console.log('\n' + '='.repeat(50));
  console.log('Safe deployed!');
  console.log('='.repeat(50));
  console.log('  Tx:', receipt.receipt.transactionHash);
  console.log('  Address:', safeAddress);
  console.log('  Owner:', eoaAccount.address);
  console.log('\nAdd to .env:');
  console.log(`  SAFE_ACCOUNT_ADDRESS=${safeAddress}`);
  console.log('\nNext: yarn install-module');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
