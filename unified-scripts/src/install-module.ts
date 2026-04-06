import { privateKeyToAccount } from 'viem/accounts';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';
import { UNIFIED_MODULE_ABI } from './abis.js';

/**
 * Install UnifiedFlashloanModule v4 on a Safe account.
 *
 * The module is installed as an EXECUTOR (type 2) so it can call
 * executeFromExecutor on the Safe during flashloan callbacks.
 *
 * No fallback installation needed — the flashloan providers (Morpho, Aave)
 * call the module directly, not the Safe.
 *
 * Required .env:
 *   PRIVATE_KEY              - owner private key
 *   SAFE_ACCOUNT_ADDRESS     - deployed Safe address
 *   UNIFIED_MODULE_ADDRESS   - deployed UnifiedFlashloanModule proxy address
 *   BASE_RPC_URL             - Base RPC endpoint
 *   PIMLICO_API_KEY          - Pimlico bundler/paymaster key
 *
 * Run: yarn install-module
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Installing UnifiedFlashloanModule on Safe');
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

  // Read module info
  const [moduleName, moduleVersion] = await Promise.all([
    publicClient.readContract({ address: moduleAddress, abi: UNIFIED_MODULE_ABI, functionName: 'name' }),
    publicClient.readContract({ address: moduleAddress, abi: UNIFIED_MODULE_ABI, functionName: 'version' }),
  ]);
  console.log(`\nModule: ${moduleName} v${moduleVersion}`);

  // Check if already installed
  const isInstalled = await smartClient.isModuleInstalled({
    address: moduleAddress,
    type: 'executor',
    context: '0x',
  });

  if (isInstalled) {
    console.log('\nModule already installed as executor. Nothing to do.');
    return;
  }

  // Install as executor (type 2)
  console.log('\nInstalling as executor...');
  const opHash = await smartClient.installModule({
    address: moduleAddress,
    type: 'executor',
    context: '0x',
  });

  console.log('UserOp hash:', opHash);
  const receipt = await smartClient.waitForUserOperationReceipt({ hash: opHash });
  console.log('Tx:', receipt.receipt.transactionHash);

  // Verify
  const verified = await smartClient.isModuleInstalled({
    address: moduleAddress,
    type: 'executor',
    context: '0x',
  });

  console.log('\n' + '='.repeat(50));
  console.log(verified ? 'Module installed successfully!' : 'WARNING: Installation may have failed');
  console.log('='.repeat(50));
  console.log('  Module:', moduleAddress);
  console.log('  Safe:', safeAddress);
  console.log('  Type: executor (2)');

  // Read provider addresses
  const [morpho, aave, registry] = await Promise.all([
    publicClient.readContract({ address: moduleAddress, abi: UNIFIED_MODULE_ABI, functionName: 'morphoBlue' }),
    publicClient.readContract({ address: moduleAddress, abi: UNIFIED_MODULE_ABI, functionName: 'aavePool' }),
    publicClient.readContract({ address: moduleAddress, abi: UNIFIED_MODULE_ABI, functionName: 'registry' }),
  ]);
  console.log('  Morpho Blue:', morpho);
  console.log('  Aave Pool:', aave);
  console.log('  Registry:', registry);

  console.log('\nNext: yarn swap-collateral');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
