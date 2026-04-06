import { toSafeSmartAccount } from 'permissionless/accounts';
import { createSmartAccountClient } from 'permissionless';
import { erc7579Actions } from 'permissionless/actions/erc7579';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { createPublicClient, http, type Address } from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { getOwnableValidator, RHINESTONE_ATTESTER_ADDRESS } from '@rhinestone/module-sdk';
import dotenv from 'dotenv';
import { join } from 'path';
import { SAFE4337_MODULE_ADDRESS, ERC7579_LAUNCHPAD_ADDRESS } from './constants.js';

dotenv.config({ path: join(__dirname, '..', '..', '.env') });

export function getEnv() {
  const privateKey = process.env.PRIVATE_KEY;
  const rpcUrl = process.env.BASE_RPC_URL || process.env.RPC_URL;
  const pimlicoApiKey = process.env.PIMLICO_API_KEY;
  const safeAddress = process.env.SAFE_ACCOUNT_ADDRESS as Address | undefined;
  const moduleAddress = process.env.UNIFIED_MODULE_ADDRESS as Address | undefined;

  if (!privateKey || !rpcUrl || !pimlicoApiKey) {
    throw new Error(`Missing required env vars:
  PRIVATE_KEY: ${privateKey ? 'set' : 'MISSING'}
  BASE_RPC_URL: ${rpcUrl ? 'set' : 'MISSING'}
  PIMLICO_API_KEY: ${pimlicoApiKey ? 'set' : 'MISSING'}`);
  }

  return { privateKey: privateKey as `0x${string}`, rpcUrl, pimlicoApiKey, safeAddress, moduleAddress };
}

export function createClients(rpcUrl: string, pimlicoApiKey: string) {
  const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
  });

  const pimlicoUrl = `https://api.pimlico.io/v2/${base.id}/rpc?apikey=${pimlicoApiKey}`;
  const pimlicoClient = createPimlicoClient({
    transport: http(pimlicoUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  return { publicClient, pimlicoClient, pimlicoUrl };
}

export async function loadSafeAccount(
  publicClient: any,
  eoaAccount: ReturnType<typeof privateKeyToAccount>,
  safeAddress?: Address,
) {
  const ownableValidator = getOwnableValidator({
    owners: [eoaAccount.address],
    threshold: 1,
  });

  const opts: any = {
    client: publicClient,
    owners: [eoaAccount],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: SAFE4337_MODULE_ADDRESS,
    erc7579LaunchpadAddress: ERC7579_LAUNCHPAD_ADDRESS,
    attesters: [RHINESTONE_ATTESTER_ADDRESS],
    attestersThreshold: 1,
    validators: [{ address: ownableValidator.address, context: ownableValidator.initData }],
  };

  if (safeAddress) {
    opts.address = safeAddress;
  }

  const safeAccount = await toSafeSmartAccount(opts);
  return { safeAccount, ownableValidator };
}

export async function createSmartClient(
  safeAccount: any,
  pimlicoClient: any,
  pimlicoUrl: string,
) {
  // Cast to any to avoid permissionless deep type incompatibilities with OP-stack chain types
  return createSmartAccountClient({
    account: safeAccount,
    chain: base,
    bundlerTransport: http(pimlicoUrl),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  }).extend(erc7579Actions()) as any;
}
