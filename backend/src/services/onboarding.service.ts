import {
  createPublicClient,
  http,
  encodeFunctionData,
  encodePacked,
  concatHex,
  concat,
  pad,
  toHex,
  toBytes,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, toAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { entryPoint07Address, getUserOperationHash, formatUserOperationRequest } from 'viem/account-abstraction';
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
import { toFunctionSelector, getAbiItem } from 'viem';
import { randomBytes } from 'crypto';
import pino from 'pino';
import { getEnv } from '../config/env.js';
import { INFRA } from '../config/addresses.js';
import { GUARDED_EXEC_MODULE_ABI } from '../utils/abis.js';
import { encryptSessionKey } from './crypto.service.js';
import {
  getUser,
  setSafeAddress,
  updateOnboardingStep,
  saveSessionKey,
} from '../db/supabase.js';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const USEROP_RECEIPT_TIMEOUT = 180_000;
const USEROP_POLL_INTERVAL = 2_000;
const PENDING_OP_TTL = 5 * 60 * 1000;

/** EIP-712 SafeOp type for EntryPoint v0.7 */
const EIP712_SAFE_OPERATION_TYPE_V07 = {
  SafeOp: [
    { type: 'address', name: 'safe' },
    { type: 'uint256', name: 'nonce' },
    { type: 'bytes', name: 'initCode' },
    { type: 'bytes', name: 'callData' },
    { type: 'uint128', name: 'verificationGasLimit' },
    { type: 'uint128', name: 'callGasLimit' },
    { type: 'uint256', name: 'preVerificationGas' },
    { type: 'uint128', name: 'maxPriorityFeePerGas' },
    { type: 'uint128', name: 'maxFeePerGas' },
    { type: 'bytes', name: 'paymasterAndData' },
    { type: 'uint48', name: 'validAfter' },
    { type: 'uint48', name: 'validUntil' },
    { type: 'address', name: 'entryPoint' },
  ],
} as const;

// ─── Pending Operations Store ─────────────────────────────────────────────────

interface PendingOp {
  userAddress: string;
  userOp: any;
  safeAccount: any;
  pimlicoClient: any;
  smartClient?: any;
  createdAt: number;
  sessionKeyPk?: string;
  sessionDetails?: any;
  sessionOwner?: any;
}

const pendingOps = new Map<string, PendingOp>();

function cleanupExpiredOps(): void {
  const now = Date.now();
  for (const [id, op] of pendingOps) {
    if (now - op.createdAt > PENDING_OP_TTL) {
      pendingOps.delete(id);
    }
  }
}

function generateOpId(): string {
  return randomBytes(16).toString('hex');
}

// ─── Shared Infrastructure ────────────────────────────────────────────────────

function buildClients() {
  const env = getEnv();
  const publicClient = createPublicClient({ chain: base, transport: http(env.BASE_RPC_URL) });
  const pimlicoUrl = `https://api.pimlico.io/v2/${base.id}/rpc?apikey=${env.PIMLICO_API_KEY}`;
  const pimlicoClient = createPimlicoClient({
    transport: http(pimlicoUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });
  return { publicClient, pimlicoClient, pimlicoUrl };
}

async function buildStubSmartClient(
  userEoaAddress: Address,
  publicClient: any,
  pimlicoUrl: string,
  pimlicoClient: any,
  safeAddress?: Address,
) {
  const stubOwner = toAccount({
    address: userEoaAddress,
    async signMessage() { throw new Error('Use frontend signing'); },
    async signTransaction() { throw new Error('Use frontend signing'); },
    async signTypedData() { throw new Error('Use frontend signing'); },
  });

  const ownableValidator = getOwnableValidator({ owners: [userEoaAddress], threshold: 1 });

  const safeOpts: any = {
    client: publicClient,
    owners: [stubOwner],
    version: '1.4.1',
    entryPoint: { address: entryPoint07Address, version: '0.7' },
    safe4337ModuleAddress: INFRA.SAFE_4337_MODULE,
    erc7579LaunchpadAddress: INFRA.ERC7579_LAUNCHPAD,
    attesters: [RHINESTONE_ATTESTER_ADDRESS],
    attestersThreshold: 1,
    validators: [{ address: ownableValidator.address, context: ownableValidator.initData }],
  };
  if (safeAddress) safeOpts.address = safeAddress;

  const safeAccount = await toSafeSmartAccount(safeOpts);

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

  return { safeAccount, smartClient };
}

async function sendSignedUserOp(pimlicoClient: any, userOp: any): Promise<Hex> {
  const rpcParams = formatUserOperationRequest(userOp);
  return pimlicoClient.request(
    { method: 'eth_sendUserOperation', params: [rpcParams, entryPoint07Address] },
    { retryCount: 0 },
  );
}

function buildSafeOpTypedData(userOp: any) {
  let initCode: Hex = '0x';
  if (userOp.factory && userOp.factoryData) {
    initCode = concatHex([userOp.factory, userOp.factoryData]);
  }

  let paymasterAndData: Hex = '0x';
  if (userOp.paymaster) {
    paymasterAndData = concat([
      userOp.paymaster,
      pad(toHex(userOp.paymasterVerificationGasLimit || 0n), { size: 16 }),
      pad(toHex(userOp.paymasterPostOpGasLimit || 0n), { size: 16 }),
      userOp.paymasterData || '0x',
    ]) as Hex;
  }

  return {
    domain: { chainId: base.id, verifyingContract: INFRA.SAFE_4337_MODULE },
    types: EIP712_SAFE_OPERATION_TYPE_V07,
    primaryType: 'SafeOp' as const,
    message: {
      safe: userOp.sender,
      nonce: userOp.nonce,
      initCode,
      callData: userOp.callData,
      verificationGasLimit: userOp.verificationGasLimit,
      callGasLimit: userOp.callGasLimit,
      preVerificationGas: userOp.preVerificationGas,
      maxPriorityFeePerGas: userOp.maxPriorityFeePerGas,
      maxFeePerGas: userOp.maxFeePerGas,
      paymasterAndData,
      validAfter: 0,
      validUntil: 0,
      entryPoint: entryPoint07Address,
    },
  };
}

function serializeTypedData(typedData: ReturnType<typeof buildSafeOpTypedData>) {
  const msg = typedData.message;
  return {
    domain: typedData.domain,
    types: typedData.types,
    primaryType: typedData.primaryType,
    message: {
      safe: msg.safe,
      nonce: msg.nonce.toString(),
      initCode: msg.initCode,
      callData: msg.callData,
      verificationGasLimit: msg.verificationGasLimit.toString(),
      callGasLimit: msg.callGasLimit.toString(),
      preVerificationGas: msg.preVerificationGas.toString(),
      maxPriorityFeePerGas: msg.maxPriorityFeePerGas.toString(),
      maxFeePerGas: msg.maxFeePerGas.toString(),
      paymasterAndData: msg.paymasterAndData,
      validAfter: msg.validAfter,
      validUntil: msg.validUntil,
      entryPoint: msg.entryPoint,
    },
  };
}

// ─── Step 1: Deploy Safe ─────────────────────────────────────────────────────

export async function prepareDeploySafe(userAddress: string) {
  cleanupExpiredOps();
  const user = await getUser(userAddress);
  if (user && user.onboarding_step >= 1) throw Object.assign(new Error('Safe already deployed'), { status: 409 });

  const { publicClient, pimlicoClient, pimlicoUrl } = buildClients();
  const { safeAccount, smartClient } = await buildStubSmartClient(
    userAddress as Address, publicClient, pimlicoUrl, pimlicoClient,
  );
  const safeAddress = await safeAccount.getAddress();

  // Check if already deployed on-chain
  const code = await publicClient.getCode({ address: safeAddress });
  if (code && code !== '0x') {
    await setSafeAddress(userAddress, safeAddress);
    await updateOnboardingStep(userAddress, 1);
    throw Object.assign(new Error('Safe already deployed on-chain'), { status: 409 });
  }

  await setSafeAddress(userAddress, safeAddress);

  const mockSig = getOwnableValidatorMockSignature({ threshold: 1 }) as Hex;
  const wrappedMockSig = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, mockSig]);

  // @ts-ignore
  const userOp = await smartClient.prepareUserOperation({
    account: safeAccount,
    calls: [{ to: safeAddress, value: 0n, data: '0x' as Hex }],
    signature: wrappedMockSig,
  });

  const typedData = buildSafeOpTypedData(userOp);
  const opId = generateOpId();
  pendingOps.set(opId, {
    userAddress: userAddress.toLowerCase(),
    userOp, safeAccount, pimlicoClient, smartClient, createdAt: Date.now(),
  });

  logger.info({ safeAddress, userAddress, opId }, 'Deploy Safe prepared');
  return { opId, safeAddress, typedData: serializeTypedData(typedData) };
}

export async function submitDeploySafe(userAddress: string, opId: string, signature: Hex) {
  const pending = pendingOps.get(opId);
  if (!pending) throw new Error('Pending operation not found or expired');
  if (pending.userAddress !== userAddress.toLowerCase()) throw new Error('Operation does not belong to this user');
  pendingOps.delete(opId);

  const { userOp, pimlicoClient } = pending;
  userOp.signature = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, signature]);

  const userOpHash = await sendSignedUserOp(pimlicoClient, userOp);
  logger.info({ userAddress, userOpHash }, 'Deploy UserOp sent');

  let txHash: string;
  try {
    const receipt = await pimlicoClient.waitForUserOperationReceipt({
      hash: userOpHash, timeout: USEROP_RECEIPT_TIMEOUT, pollingInterval: USEROP_POLL_INTERVAL,
    });
    txHash = receipt.receipt.transactionHash;
  } catch {
    // Check on-chain
    const { publicClient } = buildClients();
    const user = await getUser(userAddress);
    const codeAfter = await publicClient.getCode({ address: user!.safe_address as Address });
    if (codeAfter && codeAfter !== '0x') {
      txHash = userOpHash;
    } else {
      throw new Error(`Safe deployment submitted (UserOp: ${userOpHash}) but could not confirm. May still be pending.`);
    }
  }

  await updateOnboardingStep(userAddress, 1);
  logger.info({ userAddress, txHash }, 'Safe deployed');
  return { txHash };
}

// ─── Step 2: Install Modules ─────────────────────────────────────────────────

export async function prepareInstallModule(userAddress: string) {
  cleanupExpiredOps();
  const user = await getUser(userAddress);
  if (!user) throw new Error('User not found');
  if (user.onboarding_step < 1) throw Object.assign(new Error('Safe not deployed yet'), { status: 400 });
  if (user.onboarding_step >= 2) throw Object.assign(new Error('Modules already installed'), { status: 409 });

  const env = getEnv();
  const { publicClient, pimlicoClient, pimlicoUrl } = buildClients();
  const { safeAccount, smartClient } = await buildStubSmartClient(
    userAddress as Address, publicClient, pimlicoUrl, pimlicoClient, user.safe_address as Address,
  );

  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;
  const unifiedModuleAddr = env.UNIFIED_MODULE_ADDRESS as Address;
  const smartSessions = getSmartSessionsValidator({});

  // Build batch install calls
  const installModuleAbi = [{
    name: 'installModule', type: 'function',
    inputs: [
      { name: 'moduleTypeId', type: 'uint256' },
      { name: 'module', type: 'address' },
      { name: 'initData', type: 'bytes' },
    ],
    outputs: [], stateMutability: 'nonpayable',
  }] as const;

  const calls: { to: Address; value: bigint; data: Hex }[] = [];

  // Check and install each module
  for (const { address, type, typeId } of [
    { address: guardedModuleAddr, type: 'executor' as const, typeId: 2n },
    { address: unifiedModuleAddr, type: 'executor' as const, typeId: 2n },
    { address: smartSessions.address as Address, type: 'validator' as const, typeId: 1n },
  ]) {
    let installed = false;
    try { installed = await smartClient.isModuleInstalled({ address, type, context: '0x' }); } catch { /* proceed */ }
    if (!installed) {
      calls.push({
        to: user.safe_address as Address,
        value: 0n,
        data: encodeFunctionData({ abi: installModuleAbi, functionName: 'installModule', args: [typeId, address, '0x'] }),
      });
    }
  }

  if (calls.length === 0) {
    await updateOnboardingStep(userAddress, 2);
    throw Object.assign(new Error('All modules already installed'), { status: 409 });
  }

  const mockSig = getOwnableValidatorMockSignature({ threshold: 1 }) as Hex;
  const wrappedMockSig = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, mockSig]);

  // @ts-ignore
  const userOp = await smartClient.prepareUserOperation({
    account: safeAccount, calls, signature: wrappedMockSig,
  });

  const typedData = buildSafeOpTypedData(userOp);
  const opId = generateOpId();
  pendingOps.set(opId, {
    userAddress: userAddress.toLowerCase(),
    userOp, safeAccount, pimlicoClient, smartClient, createdAt: Date.now(),
  });

  logger.info({ userAddress, opId, callCount: calls.length }, 'Install modules prepared');
  return { opId, typedData: serializeTypedData(typedData) };
}

export async function submitInstallModule(userAddress: string, opId: string, signature: Hex) {
  const pending = pendingOps.get(opId);
  if (!pending) throw new Error('Pending operation not found or expired');
  if (pending.userAddress !== userAddress.toLowerCase()) throw new Error('Operation does not belong to this user');
  pendingOps.delete(opId);

  const { userOp, pimlicoClient } = pending;
  userOp.signature = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, signature]);

  const userOpHash = await sendSignedUserOp(pimlicoClient, userOp);
  logger.info({ userAddress, userOpHash }, 'Install modules UserOp sent');

  let txHash: string;
  try {
    const result = await pimlicoClient.waitForUserOperationReceipt({
      hash: userOpHash, timeout: USEROP_RECEIPT_TIMEOUT, pollingInterval: USEROP_POLL_INTERVAL,
    });
    txHash = result.receipt.transactionHash;
  } catch {
    txHash = userOpHash;
    logger.warn({ userAddress }, 'Receipt timeout, proceeding with UserOp hash');
  }

  await updateOnboardingStep(userAddress, 2);
  logger.info({ userAddress, txHash }, 'Modules installed');
  return { txHash };
}

// ─── Step 3: Create Session Key ──────────────────────────────────────────────

export async function prepareCreateSession(userAddress: string) {
  cleanupExpiredOps();
  const user = await getUser(userAddress);
  if (!user) throw new Error('User not found');
  if (user.onboarding_step < 2) throw Object.assign(new Error('Modules not installed yet'), { status: 400 });
  if (user.onboarding_step >= 3) throw Object.assign(new Error('Session key already created'), { status: 409 });

  const env = getEnv();
  const { publicClient, pimlicoClient, pimlicoUrl } = buildClients();
  const { safeAccount, smartClient } = await buildStubSmartClient(
    userAddress as Address, publicClient, pimlicoUrl, pimlicoClient, user.safe_address as Address,
  );

  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;
  const sessionKeyPk = generatePrivateKey();
  const sessionOwner = privateKeyToAccount(sessionKeyPk);

  const selector = toFunctionSelector(
    getAbiItem({ abi: GUARDED_EXEC_MODULE_ABI, name: 'executeGuardedBatch' }),
  ) as Hex;

  const session: Session = {
    sessionValidator: OWNABLE_VALIDATOR_ADDRESS,
    sessionValidatorInitData: encodeValidationData({ threshold: 1, owners: [sessionOwner.address] }),
    salt: toHex(toBytes('0', { size: 32 })),
    userOpPolicies: [getSudoPolicy()],
    erc7739Policies: { allowedERC7739Content: [], erc1271Policies: [] },
    actions: [{
      actionTarget: guardedModuleAddr,
      actionTargetSelector: selector,
      actionPolicies: [getSudoPolicy()],
    }],
    chainId: BigInt(base.id),
    permitERC4337Paymaster: true,
  };

  const account = getAccount({ address: safeAccount.address, type: 'safe' });

  // @ts-ignore
  const sessionDetails = await getEnableSessionDetails({
    sessions: [session],
    account,
    clients: [publicClient] as any,
  });

  const hashToSign = sessionDetails.permissionEnableHash as Hex;
  const opId = generateOpId();
  pendingOps.set(opId, {
    userAddress: userAddress.toLowerCase(),
    userOp: null, safeAccount, pimlicoClient, smartClient,
    sessionKeyPk, sessionDetails, sessionOwner, createdAt: Date.now(),
  });

  logger.info({ userAddress, opId, sessionKeyAddress: sessionOwner.address }, 'Create session prepared');
  return { opId, hashToSign };
}

export async function submitCreateSession(userAddress: string, opId: string, signature: Hex) {
  const pending = pendingOps.get(opId);
  if (!pending) throw new Error('Pending operation not found or expired');
  if (pending.userAddress !== userAddress.toLowerCase()) throw new Error('Operation does not belong to this user');
  pendingOps.delete(opId);

  const env = getEnv();
  const { safeAccount, pimlicoClient, smartClient, sessionKeyPk, sessionDetails, sessionOwner } = pending;
  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  sessionDetails.enableSessionData.enableSession.permissionEnableSig = signature;

  const smartSessions = getSmartSessionsValidator({});
  const account = getAccount({ address: safeAccount.address, type: 'safe' });
  const { publicClient } = buildClients();

  const nonce = await getAccountNonce(publicClient as any, {
    address: safeAccount.address,
    entryPointAddress: entryPoint07Address,
    key: encodeValidatorNonce({ account, validator: smartSessions }),
  });

  sessionDetails.signature = getOwnableValidatorMockSignature({ threshold: 1 });

  // Dummy call: WETH.approve(WETH, 0) — passes TargetRegistry
  const WETH = '0x4200000000000000000000000000000000000006' as Address;
  const approveCallData = encodeFunctionData({
    abi: [{ name: 'approve', type: 'function', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }] as const,
    functionName: 'approve',
    args: [WETH, 0n],
  });
  const callData = encodeFunctionData({
    abi: GUARDED_EXEC_MODULE_ABI,
    functionName: 'executeGuardedBatch',
    args: [[{ target: WETH, value: 0n, callData: approveCallData }]],
  });

  // @ts-ignore
  const userOp = await smartClient.prepareUserOperation({
    account: safeAccount, nonce,
    calls: [{ to: guardedModuleAddr, value: 0n, data: callData }],
    signature: encodeSmartSessionSignature(sessionDetails),
  });

  const opHash = getUserOperationHash({
    chainId: base.id, entryPointAddress: entryPoint07Address, entryPointVersion: '0.7', userOperation: userOp,
  });

  sessionDetails.signature = await sessionOwner!.signMessage({ message: { raw: opHash } });
  userOp.signature = encodeSmartSessionSignature(sessionDetails);

  const hash = await sendSignedUserOp(pimlicoClient, userOp);

  let txHash: string;
  try {
    const receipt = await pimlicoClient.waitForUserOperationReceipt({
      hash, timeout: USEROP_RECEIPT_TIMEOUT, pollingInterval: USEROP_POLL_INTERVAL,
    });
    txHash = receipt.receipt.transactionHash;
  } catch {
    txHash = hash;
    logger.warn({ userAddress }, 'Session key receipt timeout, proceeding');
  }

  // Encrypt and store session key
  const encryptedKey = encryptSessionKey(sessionKeyPk!, userAddress);
  await saveSessionKey(userAddress, sessionOwner!.address, encryptedKey);
  await updateOnboardingStep(userAddress, 3);

  logger.info({ userAddress, txHash, sessionKeyAddress: sessionOwner!.address }, 'Session key created');
  return { sessionKeyAddress: sessionOwner!.address, txHash };
}
