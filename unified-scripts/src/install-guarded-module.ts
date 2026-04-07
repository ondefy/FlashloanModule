import { privateKeyToAccount } from 'viem/accounts';
import { type Address } from 'viem';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';

/**
 * Install GuardedExecModule as executor (type 2) on Safe.
 * This module validates target+selector against TargetRegistry before execution.
 *
 * Run: yarn install-guarded-module
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Install GuardedExecModule');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  const guardedModuleAddress = process.env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');
  if (!guardedModuleAddress) throw new Error('GUARDED_EXEC_MODULE_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);
  console.log('GuardedExecModule:', guardedModuleAddress);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  // Check if already installed
  let installed = false;
  try {
    installed = await smartClient.isModuleInstalled({
      address: guardedModuleAddress, type: 'executor', context: '0x',
    });
  } catch { /* not installed */ }

  if (installed) {
    console.log('\nAlready installed. Nothing to do.');
    return;
  }

  console.log('\nInstalling as executor (type 2)...');
  const opHash = await smartClient.installModule({
    address: guardedModuleAddress, type: 'executor', context: '0x',
  });
  console.log('UserOp hash:', opHash);

  const receipt = await smartClient.waitForUserOperationReceipt({ hash: opHash });
  console.log('Tx:', receipt.receipt.transactionHash);

  const verified = await smartClient.isModuleInstalled({
    address: guardedModuleAddress, type: 'executor', context: '0x',
  });
  console.log(verified ? '\nGuardedExecModule installed!' : '\nWARNING: Installation may have failed');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
