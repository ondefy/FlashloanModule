import { z } from 'zod';

const envSchema = z.object({
  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_KEY: z.string().min(1),

  // Auth
  JWT_SECRET: z.string().min(16, 'JWT_SECRET must be at least 16 characters'),

  // Encryption
  MASTER_ENCRYPTION_KEY: z.string().length(64, 'MASTER_ENCRYPTION_KEY must be 64-char hex (32 bytes)'),

  // Chain
  BASE_RPC_URL: z.string().url().default('https://mainnet.base.org'),
  PIMLICO_API_KEY: z.string().min(1),

  // Contracts
  UNIFIED_MODULE_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  GUARDED_EXEC_MODULE_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  TARGET_REGISTRY_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),

  // Server
  PORT: z.coerce.number().default(3001),
  ALLOWED_ORIGINS: z.string().default('http://localhost:3000'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

let _env: Env | null = null;

export function getEnv(): Env {
  if (!_env) {
    const result = envSchema.safeParse(process.env);
    if (!result.success) {
      console.error('Invalid environment variables:');
      for (const issue of result.error.issues) {
        console.error(`  ${issue.path.join('.')}: ${issue.message}`);
      }
      process.exit(1);
    }
    _env = result.data;
  }
  return _env;
}
