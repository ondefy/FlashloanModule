import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { getUser } from '../db/supabase.js';
import {
  prepareDeploySafe,
  submitDeploySafe,
  prepareInstallModule,
  submitInstallModule,
  prepareCreateSession,
  submitCreateSession,
} from '../services/onboarding.service.js';

const router = Router();
router.use(authMiddleware);

const submitSchema = z.object({
  opId: z.string().min(1),
  signature: z.string().startsWith('0x'),
});

/** GET /onboarding/status */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const user = await getUser(req.user!.address);
    res.json({ step: user?.onboarding_step ?? 0, safeAddress: user?.safe_address ?? null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Register existing Safe (skip deploy) ─────────────────────────────────

const registerSafeSchema = z.object({
  safeAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Safe address'),
});

/**
 * POST /onboarding/register-safe — Register an existing Safe address (skip deploy).
 * Use when the Safe was already deployed by another backend (e.g., api.zyf.ai).
 * Frontend sends the known Safe address, backend verifies it's deployed on-chain,
 * saves it, and advances to step 1.
 */
router.post('/register-safe', async (req: Request, res: Response) => {
  try {
    const { registerExistingSafe } = await import('../services/onboarding.service.js');
    const { safeAddress } = registerSafeSchema.parse(req.body);
    const result = await registerExistingSafe(req.user!.address, safeAddress);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Step 1: Deploy Safe ──────────────────────────────────────────────────

router.post('/deploy-safe/prepare', async (req: Request, res: Response) => {
  try {
    const result = await prepareDeploySafe(req.user!.address);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/deploy-safe/submit', async (req: Request, res: Response) => {
  try {
    const { opId, signature } = submitSchema.parse(req.body);
    const result = await submitDeploySafe(req.user!.address, opId, signature as `0x${string}`);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Step 2: Install Modules ──────────────────────────────────────────────

router.post('/install-module/prepare', async (req: Request, res: Response) => {
  try {
    const result = await prepareInstallModule(req.user!.address);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/install-module/submit', async (req: Request, res: Response) => {
  try {
    const { opId, signature } = submitSchema.parse(req.body);
    const result = await submitInstallModule(req.user!.address, opId, signature as `0x${string}`);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// ─── Step 3: Create Session Key ───────────────────────────────────────────

router.post('/create-session/prepare', async (req: Request, res: Response) => {
  try {
    const result = await prepareCreateSession(req.user!.address);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

router.post('/create-session/submit', async (req: Request, res: Response) => {
  try {
    const { opId, signature } = submitSchema.parse(req.body);
    const result = await submitCreateSession(req.user!.address, opId, signature as `0x${string}`);
    res.json(result);
  } catch (err: any) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

export default router;
