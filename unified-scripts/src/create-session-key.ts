import { getAccountNonce } from 'permissionless/actions';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { erc7579Actions } from 'permissionless/actions/erc7579';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import {
  getSmartSessionsValidator,
  OWNABLE_VALIDATOR_ADDRESS,
  getSudoPolicy,
  type Session,
  getAccount,
  encodeSmartSessionSignature,
  getOwnableValidatorMockSignature,
  RHINESTONE_ATTESTER_ADDRESS,
  encodeValidatorNonce,
  getOwnableValidator,
  encodeValidationData,
  getEnableSessionDetails,
} from '@rhinestone/module-sdk';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import {
  toHex,
  toBytes,
  encodeFunctionData,
  type Address,
  type Hex,
  createPublicClient,
  http,
} from 'viem';
import {
  entryPoint07Address,
  getUserOperationHash,
} from 'viem/account-abstraction';
import { toFunctionSelector, getAbiItem } from 'viem';
import { getEnv, createClients, loadSafeAccount, createSmartClient } from './setup.js';

const GUARDED_EXEC_MODULE_ABI = [{
  name: 'executeGuardedBatch',
  type: 'function',
  inputs: [{
    name: 'executions',
    type: 'tuple[]',
    components: [
      { name: 'target', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'callData', type: 'bytes' },
    ],
  }],
  outputs: [],
  stateMutability: 'nonpayable',
}] as const;

/**
 * Create a session key for autonomous backend operations.
 * Follows the exact same pattern as rhinestone-executor-module/hardhat/scripts/3-create-module-session-key.ts
 *
 * Prerequisites:
 *   - Safe deployed
 *   - GuardedExecModule installed
 *   - SmartSessions installed
 *
 * Required .env:
 *   PRIVATE_KEY
 *   SAFE_ACCOUNT_ADDRESS
 *   GUARDED_EXEC_MODULE_ADDRESS
 *   BASE_RPC_URL
 *   PIMLICO_API_KEY
 *
 * Run: yarn create-session-key
 */
async function main() {
  console.log('='.repeat(50));
  console.log('Create Session Key');
  console.log('='.repeat(50));

  const { privateKey, rpcUrl, pimlicoApiKey, safeAddress } = getEnv();
  const guardedExecModuleAddress = process.env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  if (!safeAddress) throw new Error('SAFE_ACCOUNT_ADDRESS not set');
  if (!guardedExecModuleAddress) throw new Error('GUARDED_EXEC_MODULE_ADDRESS not set');

  const owner = privateKeyToAccount(privateKey);
  console.log('\nOwner EOA:', owner.address);
  console.log('Safe:', safeAddress);
  console.log('GuardedExecModule:', guardedExecModuleAddress);

  // Create clients
  const publicClient = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const pimlicoUrl = `https://api.pimlico.io/v2/${base.id}/rpc?apikey=${pimlicoApiKey}`;
  const pimlicoClient = createPimlicoClient({
    transport: http(pimlicoUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  // Load Safe account (with real owner, not stub)
  const ownableValidator = getOwnableValidator({ owners: [owner.address], threshold: 1 });
  const safeAccount = await toSafeSmartAccount({
    client: publicClient as any,
    owners: [owner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: '0x7579EE8307284F293B1927136486880611F20002' as Address,
    erc7579LaunchpadAddress: '0x7579011aB74c46090561ea277Ba79D510c6C00ff' as Address,
    attesters: [RHINESTONE_ATTESTER_ADDRESS],
    attestersThreshold: 1,
    address: safeAddress,
    validators: [{ address: ownableValidator.address, context: ownableValidator.initData }],
  });

  // @ts-ignore
  const smartClient = createSmartAccountClient({
    account: safeAccount,
    chain: base,
    bundlerTransport: http(pimlicoUrl),
    paymaster: pimlicoClient,
    userOperation: {
      estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
    },
  }).extend(erc7579Actions());

  // Check SmartSessions is installed
  const smartSessions = getSmartSessionsValidator({});
  let ssInstalled = false;
  try {
    ssInstalled = await smartClient.isModuleInstalled({
      address: smartSessions.address as Address, type: 'validator', context: '0x',
    });
  } catch { /* proceed */ }

  if (!ssInstalled) {
    console.log('\nSmartSessions not installed. Installing...');
    const opHash = await smartClient.installModule({
      address: smartSessions.address as Address, type: 'validator', context: '0x',
    });
    await pimlicoClient.waitForUserOperationReceipt({ hash: opHash });
    console.log('SmartSessions installed!');
  } else {
    console.log('\nSmartSessions already installed');
  }

  // Generate session key
  const sessionKeyPk = generatePrivateKey();
  const sessionOwner = privateKeyToAccount(sessionKeyPk);
  console.log('\nSession key address:', sessionOwner.address);
  console.log('Session key private key:', sessionKeyPk);

  // Get executeGuardedBatch selector
  const selector = toFunctionSelector(
    getAbiItem({ abi: GUARDED_EXEC_MODULE_ABI, name: 'executeGuardedBatch' }),
  ) as Hex;

  console.log('\nTarget (GuardedExecModule):', guardedExecModuleAddress);
  console.log('Selector (executeGuardedBatch):', selector);

  // Create session
  const session: Session = {
    sessionValidator: OWNABLE_VALIDATOR_ADDRESS,
    sessionValidatorInitData: encodeValidationData({
      threshold: 1,
      owners: [sessionOwner.address],
    }),
    salt: toHex(toBytes('0', { size: 32 })),
    userOpPolicies: [getSudoPolicy()],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [{
      actionTarget: guardedExecModuleAddress,
      actionTargetSelector: selector,
      actionPolicies: [getSudoPolicy()],
    }],
    chainId: BigInt(base.id),
    permitERC4337Paymaster: true,
  };

  // Get enable session details
  console.log('\nGetting session enable details...');
  const account = getAccount({ address: safeAccount.address, type: 'safe' });

  // @ts-ignore
  const sessionDetails = await getEnableSessionDetails({
    sessions: [session],
    account,
    clients: [publicClient] as any,
  });

  // Owner signs the permissionEnableHash
  console.log('Signing permission enable hash...');
  sessionDetails.enableSessionData.enableSession.permissionEnableSig =
    await owner.signMessage({
      message: { raw: sessionDetails.permissionEnableHash },
    });

  // Get nonce for SmartSessions validator
  console.log('Getting SmartSessions nonce...');
  const nonce = await getAccountNonce(publicClient as any, {
    address: safeAccount.address,
    entryPointAddress: entryPoint07Address,
    key: encodeValidatorNonce({ account, validator: smartSessions }),
  });
  console.log('Nonce:', nonce.toString());

  // Set mock signature for preparing UserOp
  sessionDetails.signature = getOwnableValidatorMockSignature({ threshold: 1 });

  // Build dummy call: WETH.approve(WETH, 0) via GuardedExecModule
  const WETH = '0x4200000000000000000000000000000000000006' as Address;
  const approveData = encodeFunctionData({
    abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const,
    functionName: 'approve',
    args: [WETH, 0n],
  });
  const guardedCallData = encodeFunctionData({
    abi: GUARDED_EXEC_MODULE_ABI,
    functionName: 'executeGuardedBatch',
    args: [[{ target: WETH, value: 0n, callData: approveData }]],
  });

  // Prepare UserOp
  console.log('Preparing UserOperation...');
  // @ts-ignore
  const userOperation = await smartClient.prepareUserOperation({
    account: safeAccount,
    calls: [{ to: guardedExecModuleAddress, value: 0n, data: guardedCallData }],
    nonce,
    signature: encodeSmartSessionSignature(sessionDetails),
  });

  // Session key signs UserOp hash
  console.log('Session key signing UserOp...');
  const userOpHashToSign = getUserOperationHash({
    chainId: base.id,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: '0.7',
    userOperation,
  });

  sessionDetails.signature = await sessionOwner.signMessage({
    message: { raw: userOpHashToSign },
  });
  userOperation.signature = encodeSmartSessionSignature(sessionDetails);

  // Submit
  console.log('Submitting UserOperation...');
  const userOpHash = await smartClient.sendUserOperation(userOperation);
  console.log('UserOp hash:', userOpHash);

  console.log('Waiting for confirmation...');
  try {
    const receipt = await pimlicoClient.waitForUserOperationReceipt({
      hash: userOpHash,
      timeout: 180_000,
      pollingInterval: 2_000,
    });
    console.log('Tx:', receipt.receipt.transactionHash);
  } catch {
    console.log('Receipt timed out — may still confirm on-chain.');
    console.log('Check: https://jiffyscan.xyz/userOpHash/' + userOpHash + '?network=base');
  }

  console.log('\n' + '='.repeat(50));
  console.log('Session Key Created!');
  console.log('='.repeat(50));
  console.log('  Session key address:', sessionOwner.address);
  console.log('  Session key private key:', sessionKeyPk);
  console.log('  Safe:', safeAddress);
  console.log('\nSave the private key — you need it for backend operations.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('\nError:', (e as Error).message || e); process.exit(1); });
