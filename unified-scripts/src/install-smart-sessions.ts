import { privateKeyToAccount } from 'viem/accounts';
import { type Address } from 'viem';
import { getSmartSessionsValidator } from '@rhinestone/module-sdk';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';

/**
 * Install SmartSessions as validator (type 1) on Safe.
 * Required for session key-based autonomous operations (backend rebalancing).
 *
 * Run: yarn install-smart-sessions
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Install SmartSessions Validator');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  const smartSessions = getSmartSessionsValidator({});
  const ssAddress = smartSessions.address as Address;

  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);
  console.log('SmartSessions:', ssAddress);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  // Check if already installed
  let installed = false;
  try {
    installed = await smartClient.isModuleInstalled({
      address: ssAddress, type: 'validator', context: '0x',
    });
  } catch { /* not installed */ }

  if (installed) {
    console.log('\nAlready installed. Nothing to do.');
    return;
  }

  console.log('\nInstalling as validator (type 1)...');
  const opHash = await smartClient.installModule({
    address: ssAddress, type: 'validator', context: '0x',
  });
  console.log('UserOp hash:', opHash);

  const receipt = await smartClient.waitForUserOperationReceipt({ hash: opHash });
  console.log('Tx:', receipt.receipt.transactionHash);

  const verified = await smartClient.isModuleInstalled({
    address: ssAddress, type: 'validator', context: '0x',
  });
  console.log(verified ? '\nSmartSessions installed!' : '\nWARNING: Installation may have failed');
  console.log('\nThis enables session key-based backend operations.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
