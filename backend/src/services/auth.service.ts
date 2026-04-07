import jwt from 'jsonwebtoken';
import { SiweMessage } from 'siwe';
import { ethers } from 'ethers';
import { getEnv } from '../config/env.js';
import { upsertUser } from '../db/supabase.js';

const JWT_EXPIRY = '30d';

// ─── Provider cache for EIP-1271 smart contract wallet verification ──────────

const providerCache = new Map<number, ethers.providers.JsonRpcProvider>();

function getProviderForChain(chainId: number): ethers.providers.JsonRpcProvider | null {
  if (providerCache.has(chainId)) return providerCache.get(chainId)!;

  const env = getEnv();
  const rpcUrlMap: Record<number, string> = {
    8453: env.BASE_RPC_URL,
  };

  const rpcUrl = rpcUrlMap[chainId];
  if (!rpcUrl) return null;

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  providerCache.set(chainId, provider);
  return provider;
}

async function isContractAddress(
  address: string,
  provider: ethers.providers.JsonRpcProvider,
): Promise<boolean> {
  try {
    const code = await provider.getCode(address);
    return code !== '0x' && code !== '';
  } catch {
    return false;
  }
}

// ─── Signature verification (EOA + EIP-1271 smart contract wallets) ──────────

async function verifySignature(
  message: string,
  signature: string,
  address: string,
  chainId: number,
): Promise<boolean> {
  const provider = getProviderForChain(chainId);
  if (!provider) throw new Error(`No RPC provider available for chain ID: ${chainId}`);

  const isContract = await isContractAddress(address, provider);

  if (isContract) {
    // Smart contract wallet — EIP-1271 verification
    try {
      const EIP1271_ABI = [
        'function isValidSignature(bytes32 _hash, bytes memory _signature) external view returns (bytes4)',
      ];
      const messageHash = ethers.utils.hashMessage(message);
      const contract = new ethers.Contract(address, EIP1271_ABI, provider);
      const magicValue = await contract.isValidSignature(messageHash, signature);
      return magicValue === '0x1626ba7e';
    } catch {
      return false;
    }
  } else {
    // EOA — standard ecrecover
    try {
      const recoveredAddress = ethers.utils.verifyMessage(message, signature);
      return recoveredAddress.toLowerCase() === address.toLowerCase();
    } catch {
      return false;
    }
  }
}

// ─── SIWE Auth: verify signature and issue JWT ───────────────────────────────

export interface SecureAuthInput {
  signature: string;
  message: any;
  walletAddress?: string;
  address?: string;
  chainId?: number;
}

export interface SecureAuthResult {
  token: string;
  expiresIn: number;
  address: string;
}

/**
 * Verify a SIWE signed message and issue a JWT.
 * Compatible with the old backend's POST /api/v2/auth/secure
 */
export async function secureAuth(input: SecureAuthInput): Promise<SecureAuthResult> {
  const { signature, message, chainId } = input;
  const address = input.walletAddress || input.address;

  // Validate required fields
  if (!signature || !address || !message) {
    throw Object.assign(
      new Error('Missing required fields: signature, walletAddress (or address), message'),
      { status: 400, code: 'MISSING_FIELDS' },
    );
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw Object.assign(
      new Error('Invalid wallet address format'),
      { status: 400, code: 'INVALID_ADDRESS' },
    );
  }

  // Validate signature format
  if (!signature || typeof signature !== 'string' || !signature.startsWith('0x')) {
    throw Object.assign(
      new Error('Invalid signature format'),
      { status: 400, code: 'INVALID_SIGNATURE' },
    );
  }

  // Parse and verify SIWE message
  const siweMessage = new SiweMessage(message);
  const messageToVerify = siweMessage.prepareMessage();

  const messageChainId = message.chainId || chainId;
  if (!messageChainId) {
    throw Object.assign(
      new Error('Chain ID is required for signature verification'),
      { status: 400, code: 'MISSING_CHAIN_ID' },
    );
  }

  const isValid = await verifySignature(messageToVerify, signature, address, messageChainId);

  if (!isValid) {
    throw Object.assign(
      new Error('Signature does not match address'),
      { status: 401, code: 'SIGNATURE_MISMATCH' },
    );
  }

  // JWT: use checksummed address from SIWE (matches old backend exactly)
  const canonicalAddress = siweMessage.address;

  // Upsert user in Supabase (store lowercase)
  await upsertUser(canonicalAddress.toLowerCase());

  // Issue JWT — same format as old backend
  const token = jwt.sign(
    { address: canonicalAddress },
    getEnv().DEFI_API_JWT_SECRET,
    { expiresIn: JWT_EXPIRY },
  );

  return {
    token,
    expiresIn: 2592000, // 30 days in seconds
    address: canonicalAddress,
  };
}

// ─── JWT verification ────────────────────────────────────────────────────────

/**
 * Verify a JWT and return the decoded payload.
 * Accepts tokens from BOTH the old backend and this backend (same secret).
 */
export function verifyToken(token: string): { address: string } {
  const decoded = jwt.verify(token, getEnv().DEFI_API_JWT_SECRET) as any;
  return { address: decoded.walletAddress || decoded.address };
}
