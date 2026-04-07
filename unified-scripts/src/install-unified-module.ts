import { privateKeyToAccount } from 'viem/accounts';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';
import { UNIFIED_MODULE_ABI } from './abis.js';

/**
 * Install UnifiedFlashloanModule as executor (type 2) on Safe.
 * This module handles flashloan-based collateral swaps.
 *
 * Run: yarn install-unified-module
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Install UnifiedFlashloanModule');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress, moduleAddress } = getEnv();

  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');
  if (!moduleAddress) throw new Error('UNIFIED_MODULE_ADDRESS not set');

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
  console.log(`Module: ${moduleName} v${moduleVersion}`);

  // Check if already installed
  let installed = false;
  try {
    installed = await smartClient.isModuleInstalled({
      address: moduleAddress, type: 'executor', context: '0x',
    });
  } catch { /* not installed */ }

  if (installed) {
    console.log('\nAlready installed. Nothing to do.');
    return;
  }

  console.log('\nInstalling as executor (type 2)...');
  const opHash = await smartClient.installModule({
    address: moduleAddress, type: 'executor', context: '0x',
  });
  console.log('UserOp hash:', opHash);

  const receipt = await smartClient.waitForUserOperationReceipt({ hash: opHash });
  console.log('Tx:', receipt.receipt.transactionHash);

  const verified = await smartClient.isModuleInstalled({
    address: moduleAddress, type: 'executor', context: '0x',
  });
  console.log(verified ? '\nUnifiedFlashloanModule installed!' : '\nWARNING: Installation may have failed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
