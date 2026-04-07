import crypto from 'crypto';
import { getEnv } from '../config/env.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;  // 96 bits (recommended for GCM)
const AUTH_TAG_LENGTH = 16; // 128 bits

interface EncryptedBlob {
  iv: string;       // hex
  authTag: string;  // hex
  ciphertext: string; // hex
}

/**
 * Derive a per-user encryption key using HKDF.
 * This way, if one user's encrypted key leaks alongside the master key,
 * only THAT user is compromised — not all users.
 */
function deriveUserKey(userAddress: string): Buffer {
  const masterKey = Buffer.from(getEnv().MASTER_ENCRYPTION_KEY, 'hex');
  const salt = Buffer.from('zyfi-session-key-v1', 'utf8');
  const info = Buffer.from(userAddress.toLowerCase(), 'utf8');

  // HKDF: derive 32 bytes (256 bits) for AES-256
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, salt, info, 32));
}

/**
 * Encrypt a session key private key for storage in Supabase.
 * Returns a JSON string: { iv, authTag, ciphertext }
 */
export function encryptSessionKey(plaintext: string, userAddress: string): string {
  const key = deriveUserKey(userAddress);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  const blob: EncryptedBlob = {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };

  return JSON.stringify(blob);
}

/**
 * Decrypt a session key private key from Supabase storage.
 * Input is the JSON blob (or parsed object) stored in session_keys.encrypted_key.
 */
export function decryptSessionKey(blobInput: string | EncryptedBlob, userAddress: string): string {
  const key = deriveUserKey(userAddress);
  const blob: EncryptedBlob = typeof blobInput === 'string'
    ? JSON.parse(blobInput)
    : blobInput;

  const iv = Buffer.from(blob.iv, 'hex');
  const authTag = Buffer.from(blob.authTag, 'hex');
  const ciphertext = Buffer.from(blob.ciphertext, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString('utf8');
}
