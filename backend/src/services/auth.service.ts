import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { verifyMessage, type Address, type Hex } from 'viem';
import { getEnv } from '../config/env.js';
import { upsertUser } from '../db/supabase.js';

const JWT_EXPIRY = '24h';
const NONCE_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

interface NonceEntry {
  nonce: string;
  createdAt: number;
}

/** In-memory nonce store: address (lowercase) -> NonceEntry */
const nonceStore = new Map<string, NonceEntry>();

// Cleanup expired nonces every 60 seconds
setInterval(() => {
  const now = Date.now();
  for (const [addr, entry] of nonceStore) {
    if (now - entry.createdAt > NONCE_EXPIRY_MS) {
      nonceStore.delete(addr);
    }
  }
}, 60_000);

/**
 * Generate a nonce message for EIP-191 signing.
 */
export function generateNonce(address: string): string {
  const nonce = `Sign this message to authenticate with Zyfi Borrow Agent.\n\nNonce: ${crypto.randomUUID()}`;
  nonceStore.set(address.toLowerCase(), { nonce, createdAt: Date.now() });
  return nonce;
}

/**
 * Verify an EIP-191 signature and issue a JWT.
 */
export async function verifyAndIssue(
  address: string,
  signature: string,
  nonce: string,
): Promise<string> {
  const key = address.toLowerCase();
  const entry = nonceStore.get(key);

  if (!entry) {
    throw new Error('No nonce found for this address. Request a new one.');
  }

  if (entry.nonce !== nonce) {
    throw new Error('Nonce mismatch.');
  }

  if (Date.now() - entry.createdAt > NONCE_EXPIRY_MS) {
    nonceStore.delete(key);
    throw new Error('Nonce expired. Request a new one.');
  }

  // Verify EIP-191 signature via viem
  const valid = await verifyMessage({
    address: address as Address,
    message: nonce,
    signature: signature as Hex,
  });

  if (!valid) {
    throw new Error('Invalid signature.');
  }

  // Consume nonce (one-time use)
  nonceStore.delete(key);

  // Upsert user in Supabase
  await upsertUser(key);

  // Issue JWT
  const token = jwt.sign({ address: key }, getEnv().JWT_SECRET, {
    expiresIn: JWT_EXPIRY,
  });

  return token;
}

/**
 * Verify a JWT and return the decoded payload.
 */
export function verifyToken(token: string): { address: string } {
  return jwt.verify(token, getEnv().JWT_SECRET) as { address: string };
}
