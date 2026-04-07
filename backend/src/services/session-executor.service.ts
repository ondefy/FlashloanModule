import {
  createPublicClient,
  encodeFunctionData,
  http,
  toHex,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, toAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { entryPoint07Address, getUserOperationHash } from 'viem/account-abstraction';
import { getAccountNonce } from 'permissionless/actions';
import { createSmartAccountClient } from 'permissionless';
import { toSafeSmartAccount } from 'permissionless/accounts';
import { erc7579Actions } from 'permissionless/actions/erc7579';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import {
  getSmartSessionsValidator,
  OWNABLE_VALIDATOR_ADDRESS,
  getAccount,
  encodeSmartSessionSignature,
  getOwnableValidatorMockSignature,
  RHINESTONE_ATTESTER_ADDRESS,
  encodeValidatorNonce,
  getOwnableValidator,
  SmartSessionMode,
  getPermissionId,
  encodeValidationData,
  type Session,
} from '@rhinestone/module-sdk';
import pino from 'pino';
import { getEnv } from '../config/env.js';
import { INFRA } from '../config/addresses.js';
import { GUARDED_EXEC_MODULE_ABI } from '../utils/abis.js';
import { decryptSessionKey } from './crypto.service.js';
import { getSessionKey, insertTransactionLog, updateTransactionLog } from '../db/supabase.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

export type Execution = {
  target: Address;
  value: bigint;
  callData: Hex;
};

export type ExecutionResult = {
  txHash: Hex;
  userOpHash: Hex;
};

/**
 * Execute a batch of operations through GuardedExecModule using a user's session key.
 * Decrypts session key from Supabase, signs UserOp, submits to Pimlico.
 */
export async function executeGuardedBatch(
  userAddress: string,
  ownerAddress: string,
  safeAddress: string,
  executions: Execution[],
): Promise<ExecutionResult> {
  const env = getEnv();
  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  // 1. Decrypt session key from Supabase
  const sessionKeyData = await getSessionKey(userAddress);
  const sessionKeyPk = decryptSessionKey(sessionKeyData.encrypted_key, userAddress);
  const sessionOwner = privateKeyToAccount(sessionKeyPk as Hex);

  // 2. Create stub owner (no signing, just address)
  const owner = toAccount({
    address: ownerAddress as Address,
    async signMessage() { throw new Error('Owner signing not available'); },
    async signTransaction() { throw new Error('Owner signing not available'); },
    async signTypedData() { throw new Error('Owner signing not available'); },
  });

  // 3. Build clients
  const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
  const pimlicoUrl = `https://api.pimlico.io/v2/${base.id}/rpc?apikey=${env.PIMLICO_API_KEY}`;
  const pimlicoClient = createPimlicoClient({
    transport: http(pimlicoUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  // 4. Load Safe account
  const ownableValidator = getOwnableValidator({ owners: [owner.address], threshold: 1 });
  const safeAccount = await toSafeSmartAccount({
    client: publicClient as any,
    owners: [owner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: INFRA.SAFE_4337_MODULE,
    erc7579LaunchpadAddress: INFRA.ERC7579_LAUNCHPAD,
    attesters: [RHINESTONE_ATTESTER_ADDRESS],
    attestersThreshold: 1,
    address: safeAddress as Address,
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

  // 5. Encode executeGuardedBatch calldata
  const guardedCallData = encodeFunctionData({
    abi: GUARDED_EXEC_MODULE_ABI,
    functionName: 'executeGuardedBatch',
    args: [executions],
  });

  // 6. Build session details for "use" mode
  const smartSessions = getSmartSessionsValidator({});
  const account = getAccount({ address: safeAccount.address, type: 'safe' });

  const nonce = await getAccountNonce(publicClient as any, {
    address: safeAccount.address,
    entryPointAddress: entryPoint07Address,
    key: encodeValidatorNonce({ account, validator: smartSessions }),
  });

  // Reconstruct session to compute permissionId
  const session: Session = {
    sessionValidator: OWNABLE_VALIDATOR_ADDRESS,
    sessionValidatorInitData: encodeValidationData({ threshold: 1, owners: [sessionOwner.address] }),
    salt: toHex(toBytes('0', { size: 32 })),
    userOpPolicies: [],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [],
    chainId: BigInt(base.id),
    permitERC4337Paymaster: true,
  };
  const permissionId = getPermissionId({ session });

  const sessionDetails = {
    mode: SmartSessionMode.USE,
    permissionId,
    signature: getOwnableValidatorMockSignature({ threshold: 1 }),
  };

  // 7. Prepare UserOperation
  // @ts-ignore
  const userOperation = await smartClient.prepareUserOperation({
    account: safeAccount,
    calls: [{ to: guardedModuleAddr, value: 0n, data: guardedCallData }],
    nonce,
    signature: encodeSmartSessionSignature(sessionDetails),
  });

  // 8. Session key signs UserOp hash
  const userOpHashToSign = getUserOperationHash({
    chainId: base.id,
    entryPointAddress: entryPoint07Address,
    entryPointVersion: '0.7',
    userOperation,
  });

  sessionDetails.signature = await sessionOwner.signMessage({ message: { raw: userOpHashToSign } });
  userOperation.signature = encodeSmartSessionSignature(sessionDetails);

  // 9. Submit UserOperation
  const userOpHash = await smartClient.sendUserOperation(userOperation);
  logger.info({ userAddress, userOpHash }, 'UserOp submitted');

  // 10. Wait for receipt
  const receipt = await pimlicoClient.waitForUserOperationReceipt({ hash: userOpHash });
  const txHash = receipt.receipt.transactionHash;

  logger.info({ userAddress, txHash }, 'UserOp confirmed');
  return { txHash, userOpHash };
}
