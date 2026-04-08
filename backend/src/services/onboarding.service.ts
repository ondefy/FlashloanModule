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
  SmartSessionMode,
  getPermissionId,
  getSessionNonce,
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
  upsertUser,
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

// ─── Register Existing Safe (skip deploy) ────────────────────────────────────

/**
 * Register a Safe that was already deployed by another backend (e.g., api.zyf.ai).
 * Verifies it exists on-chain, saves it, and advances to step 1.
 */
export async function registerExistingSafe(userAddress: string, safeAddress: string) {
  const { publicClient } = buildClients();

  // Verify the Safe is actually deployed on-chain
  const code = await publicClient.getCode({ address: safeAddress as Address });
  if (!code || code === '0x') {
    throw Object.assign(new Error('Safe not found on-chain at this address'), { status: 400 });
  }

  // Ensure user exists in DB (they may have authenticated via old backend's JWT)
  await upsertUser(userAddress);

  // Save and advance to step 1
  await setSafeAddress(userAddress, safeAddress);
  await updateOnboardingStep(userAddress, 1);

  logger.info({ userAddress, safeAddress }, 'Existing Safe registered');
  return { safeAddress: safeAddress.toLowerCase(), step: 1 };
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

  // Find the FIRST module that needs installing (install one at a time)
  let moduleToInstall: { address: Address; type: 'executor' | 'validator'; name: string } | null = null;

  // Install modules one at a time: executors first, then SmartSessions validator
  for (const mod of [
    { address: guardedModuleAddr, type: 'executor' as const, name: 'GuardedExecModule' },
    { address: unifiedModuleAddr, type: 'executor' as const, name: 'UnifiedFlashloanModule' },
    { address: smartSessions.address as Address, type: 'validator' as const, name: 'SmartSessions' },
  ]) {
    let installed = false;
    try { installed = await smartClient.isModuleInstalled({ address: mod.address, type: mod.type, context: '0x' }); } catch { /* proceed */ }
    logger.info({ name: mod.name, address: mod.address, installed }, 'Module install check');
    if (!installed) {
      moduleToInstall = mod;
      break; // Install first uninstalled module only
    }
  }

  if (!moduleToInstall) {
    await updateOnboardingStep(userAddress, 2);
    throw Object.assign(new Error('All modules already installed'), { status: 409 });
  }

  logger.info({ name: moduleToInstall.name, address: moduleToInstall.address }, 'Preparing single module install');

  // Build a SINGLE installModule call (not batched — avoids encoding issues)
  const calls = [{
    to: safeAccount.address,
    value: 0n,
    data: encodeFunctionData({
      abi: [{
        name: 'installModule',
        type: 'function',
        inputs: [
          { name: 'moduleTypeId', type: 'uint256' },
          { name: 'module', type: 'address' },
          { name: 'initData', type: 'bytes' },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
      }] as const,
      functionName: 'installModule',
      args: [BigInt(moduleToInstall.type === 'executor' ? 2 : 1), moduleToInstall.address, '0x' as Hex],
    }),
  }];

  const mockSig = getOwnableValidatorMockSignature({ threshold: 1 }) as Hex;
  const wrappedMockSig = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, mockSig]);

  try {
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

    logger.info({ userAddress, opId, module: moduleToInstall.name }, 'Install module prepared');
    return { opId, typedData: serializeTypedData(typedData) };
  } catch (err: any) {
    logger.error({
      userAddress, module: moduleToInstall.name, error: err.message,
      details: err.details || err.cause?.message,
    }, 'prepareUserOperation FAILED');
    throw err;
  }
}

export async function submitInstallModule(userAddress: string, opId: string, signature: Hex) {
  const pending = pendingOps.get(opId);
  if (!pending) throw new Error('Pending operation not found or expired');
  if (pending.userAddress !== userAddress.toLowerCase()) throw new Error('Operation does not belong to this user');
  pendingOps.delete(opId);

  const { userOp, pimlicoClient, smartClient } = pending;
  userOp.signature = encodePacked(['uint48', 'uint48', 'bytes'], [0, 0, signature]);

  const userOpHash = await sendSignedUserOp(pimlicoClient, userOp);
  logger.info({ userAddress, userOpHash }, 'Install module UserOp sent');

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

  // Check if all modules are now installed
  const env = getEnv();
  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;
  const unifiedModuleAddr = env.UNIFIED_MODULE_ADDRESS as Address;
  const smartSessionsCheck = getSmartSessionsValidator({});

  let allInstalled = true;
  for (const mod of [
    { address: guardedModuleAddr, type: 'executor' as const },
    { address: unifiedModuleAddr, type: 'executor' as const },
    { address: smartSessionsCheck.address as Address, type: 'validator' as const },
  ]) {
    try {
      const installed = await smartClient.isModuleInstalled({ address: mod.address, type: mod.type, context: '0x' });
      if (!installed) { allInstalled = false; break; }
    } catch { allInstalled = false; break; }
  }

  if (allInstalled) {
    await updateOnboardingStep(userAddress, 2);
    logger.info({ userAddress, txHash }, 'All modules installed');
  } else {
    logger.info({ userAddress, txHash }, 'Module installed, more remaining — frontend should call prepare again');
  }

  return { txHash, allInstalled };
}

// ─── Step 3: Create Session Key ──────────────────────────────────────────────
//
// Matches existing frontend pattern from rhinestone.utils.ts:
//   1. Backend generates session key + session config
//   2. Frontend calls signSessionKey() to sign permissionEnableHash via MetaMask
//   3. Frontend sends signature + nonces back to backend
//   4. Backend stores encrypted session key + signature for later use
//
// NO UserOp is submitted during session creation. The signature + nonces are
// stored and used later when the session key executor builds UserOps.

/**
 * Step 3a: Generate session key and return session config for frontend to sign.
 * Frontend will call signSessionKey() with this config.
 */
export async function prepareCreateSession(userAddress: string) {
  cleanupExpiredOps();
  const user = await getUser(userAddress);
  if (!user) throw new Error('User not found');
  if (user.onboarding_step < 2) throw Object.assign(new Error('Modules not installed yet'), { status: 400 });
  if (user.onboarding_step >= 3) throw Object.assign(new Error('Session key already created'), { status: 409 });

  const env = getEnv();
  const guardedModuleAddr = env.GUARDED_EXEC_MODULE_ADDRESS as Address;

  // Generate session key
  const sessionKeyPk = generatePrivateKey();
  const sessionOwner = privateKeyToAccount(sessionKeyPk);

  const selector = toFunctionSelector(
    getAbiItem({ abi: GUARDED_EXEC_MODULE_ABI, name: 'executeGuardedBatch' }),
  ) as Hex;

  // Build session config (same format as api.zyf.ai /session-keys/config)
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

  // Compute permissionEnableHash using the BORROW AGENT's Safe address (not the main ZyfAI Safe)
  const { publicClient } = buildClients();
  const safeAddr = user.safe_address as Address;
  const account = getAccount({ address: safeAddr, type: 'safe' });

  // @ts-ignore
  const enableDetails = await getEnableSessionDetails({
    sessions: [session],
    account,
    clients: [publicClient] as any,
  });

  const permissionEnableHash = enableDetails.permissionEnableHash as Hex;

  // Store session key + enable details in pending ops (5-min TTL)
  const opId = generateOpId();
  pendingOps.set(opId, {
    userAddress: userAddress.toLowerCase(),
    userOp: null, safeAccount: null as any, pimlicoClient: null as any,
    sessionKeyPk, sessionDetails: null, sessionOwner, createdAt: Date.now(),
  });

  logger.info({ userAddress, opId, sessionKeyAddress: sessionOwner.address }, 'Create session prepared');
  return {
    opId,
    sessionKeyAddress: sessionOwner.address,
    permissionEnableHash,
  };
}

/**
 * Step 3b: Receive the MetaMask-signed permissionEnableHash from frontend.
 * Store the encrypted session key and advance to step 3.
 *
 * Body: { opId, signature (signed permissionEnableHash), nonces (session nonces) }
 */
export async function submitCreateSession(userAddress: string, opId: string, signature: Hex) {
  const pending = pendingOps.get(opId);
  if (!pending) throw new Error('Pending operation not found or expired');
  if (pending.userAddress !== userAddress.toLowerCase()) throw new Error('Operation does not belong to this user');
  pendingOps.delete(opId);

  const { sessionKeyPk, sessionOwner } = pending;

  // Encrypt and store session key + the signed permissionEnableHash
  const encryptedKey = encryptSessionKey(sessionKeyPk!, userAddress);
  await saveSessionKey(userAddress, sessionOwner!.address, encryptedKey);

  // Store the signature for later use when building enable-mode UserOps
  // The session executor will use this signature + session key to build UserOps
  const supabase = (await import('../db/supabase.js')).getSupabase();
  await supabase
    .from('session_keys')
    .update({
      encrypted_key: {
        ...JSON.parse(encryptedKey),
        permission_enable_sig: signature,
      },
    })
    .eq('user_address', userAddress.toLowerCase());

  await updateOnboardingStep(userAddress, 3);

  logger.info({ userAddress, sessionKeyAddress: sessionOwner!.address }, 'Session key stored');
  return { sessionKeyAddress: sessionOwner!.address };
}
