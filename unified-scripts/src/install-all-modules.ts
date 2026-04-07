import { privateKeyToAccount } from 'viem/accounts';
import { type Address } from 'viem';
import { getSmartSessionsValidator } from '@rhinestone/module-sdk';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';

/**
 * Install all 3 modules on the Safe:
 *   1. GuardedExecModule (executor, type 2)
 *   2. UnifiedFlashloanModule (executor, type 2)
 *   3. SmartSessions (validator, type 1)
 *
 * Required .env:
 *   PRIVATE_KEY
 *   SAFE_ACCOUNT_ADDRESS
 *   UNIFIED_MODULE_ADDRESS
 *   GUARDED_EXEC_MODULE_ADDRESS
 *   BASE_RPC_URL
 *   PIMLICO_API_KEY
 *
 * Run: yarn install-all-modules
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Installing All Modules on Safe');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress, moduleAddress } = getEnv();
  const guardedModuleAddress = process.env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');
  if (!moduleAddress) throw new Error('UNIFIED_MODULE_ADDRESS not set');
  if (!guardedModuleAddress) throw new Error('GUARDED_EXEC_MODULE_ADDRESS not set');

  const eoaAccount = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', eoaAccount.address);
  console.log('Safe:', safeAddress);
  console.log('GuardedExecModule:', guardedModuleAddress);
  console.log('UnifiedFlashloanModule:', moduleAddress);

  const { publicClient, pimlicoClient, pimlicoUrl } = createClients(rpcUrl, pimlicoApiKey);
  const { safeAccount } = await loadSafeAccount(publicClient, eoaAccount, safeAddress);
  const smartClient = await createSmartClient(safeAccount, pimlicoClient, pimlicoUrl);

  const smartSessions = getSmartSessionsValidator({});
  console.log('SmartSessions:', smartSessions.address);

  // Check and install each module
  const modules = [
    { name: 'GuardedExecModule', address: guardedModuleAddress, type: 'executor' as const },
    { name: 'UnifiedFlashloanModule', address: moduleAddress, type: 'executor' as const },
    { name: 'SmartSessions', address: smartSessions.address as Address, type: 'validator' as const },
  ];

  for (const mod of modules) {
    console.log(`\n--- ${mod.name} ---`);

    let installed = false;
    try {
      installed = await smartClient.isModuleInstalled({
        address: mod.address,
        type: mod.type,
        context: '0x',
      });
    } catch { /* not installed */ }

    if (installed) {
      console.log(`  Already installed. Skipping.`);
      continue;
    }

    console.log(`  Installing as ${mod.type}...`);
    const opHash = await smartClient.installModule({
      address: mod.address,
      type: mod.type,
      context: '0x',
    });
    console.log('  UserOp hash:', opHash);

    const receipt = await smartClient.waitForUserOperationReceipt({ hash: opHash });
    console.log('  Tx:', receipt.receipt.transactionHash);

    // Verify
    const verified = await smartClient.isModuleInstalled({
      address: mod.address,
      type: mod.type,
      context: '0x',
    });
    console.log(`  ${verified ? 'Installed!' : 'WARNING: may have failed'}`);
  }

  console.log('\n' + '='.repeat(50));
  console.log('All modules installed!');
  console.log('='.repeat(50));
  console.log('\nNext: yarn deposit-weth');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
