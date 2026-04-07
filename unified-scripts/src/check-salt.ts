import { fromHex, toHex, type Address } from 'viem';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import { entryPoint07Address } from 'viem/account-abstraction';
import { getOwnableValidator, RHINESTONE_ATTESTER_ADDRESS } from '@rhinestone/module-sdk';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { toAccount } from 'viem/accounts';
import { getEnv, createClients } from './setup.js';

async function main() {
  const { rpcUrl, safeAddress } = getEnv();
  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');

  // Get the EOA that owns this Safe — check .env PRIVATE_KEY
  const { privateKey } = getEnv();
  const { privateKeyToAccount } = await import('viem/accounts');
  const eoaAccount = privateKeyToAccount(privateKey);
  const userAddress = eoaAccount.address;

  console.log('EOA:', userAddress);
  console.log('Expected Safe:', safeAddress);

  const { publicClient } = createClients(rpcUrl, 'dummy');

  const stubOwner = toAccount({
    address: userAddress,
    async signMessage() { throw new Error('stub'); },
    async signTransaction() { throw new Error('stub'); },
    async signTypedData() { throw new Error('stub'); },
  });

  const ownableValidator = getOwnableValidator({ owners: [userAddress], threshold: 1 });

  const baseOpts: any = {
    client: publicClient,
    owners: [stubOwner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: '0x7579EE8307284F293B1927136486880611F20002' as Address,
    erc7579LaunchpadAddress: '0x7579011aB74c46090561ea277Ba79D510c6C00ff' as Address,
    attesters: [RHINESTONE_ATTESTER_ADDRESS],
    attestersThreshold: 1,
    validators: [{ address: ownableValidator.address, context: ownableValidator.initData }],
  };

  // Test different salts
  const salts = [
    { name: 'no salt', salt: undefined },
    { name: 'zyfai (fromHex)', salt: fromHex(toHex('zyfai'), 'bigint') },
    { name: 'zyfai (buffer)', salt: BigInt('0x' + Buffer.from('zyfai').toString('hex')) },
    { name: '0x1', salt: 1n },
    { name: 'zyfai-staging', salt: fromHex(toHex('zyfai-staging'), 'bigint') },
  ];

  console.log('\nComputed addresses:');
  for (const { name, salt } of salts) {
    const opts = { ...baseOpts };
    if (salt !== undefined) opts.saltNonce = salt;
    const account = await toSafeSmartAccount(opts);
    const match = account.address.toLowerCase() === safeAddress.toLowerCase();
    console.log(`  ${name}: ${account.address} ${match ? '✅ MATCH' : ''}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('Error:', e.message); process.exit(1); });
