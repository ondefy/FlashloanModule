import dotenv from 'dotenv';
dotenv.config();

import { getEnv } from './config/env.js';
import { encryptSessionKey } from './services/crypto.service.js';
import { saveSessionKey, updateOnboardingStep } from './db/supabase.js';

/**
 * One-time script to save a session key that was created via unified-scripts.
 * Usage: npx tsx src/save-session-key.ts <userAddress> <sessionKeyPrivateKey> <sessionKeyAddress>
 */
async function main() {
  const [, , userAddress, sessionKeyPk, sessionKeyAddress] = process.argv;

  if (!userAddress || !sessionKeyPk || !sessionKeyAddress) {
    console.error('Usage: npx tsx src/save-session-key.ts <userAddress> <sessionKeyPrivateKey> <sessionKeyAddress>');
    process.exit(1);
  }

  // Ensure env is loaded
  getEnv();

  const encryptedKey = encryptSessionKey(sessionKeyPk, userAddress.toLowerCase());
  await saveSessionKey(userAddress.toLowerCase(), sessionKeyAddress.toLowerCase(), encryptedKey);
  await updateOnboardingStep(userAddress.toLowerCase(), 3);

  console.log('Session key saved and encrypted in Supabase');
  console.log('  User:', userAddress);
  console.log('  Session key address:', sessionKeyAddress);
  console.log('  Onboarding step: 3');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error('Error:', e.message); process.exit(1); });
