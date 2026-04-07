import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { generateNonce, verifyAndIssue } from '../services/auth.service.js';

const router = Router();

const nonceQuerySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address'),
});

const verifyBodySchema = z.object({
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Invalid Ethereum address'),
  signature: z.string().startsWith('0x'),
  nonce: z.string().min(1),
});

/** GET /auth/nonce?address=0x... */
router.get('/nonce', (req: Request, res: Response) => {
  try {
    const { address } = nonceQuerySchema.parse(req.query);
    const nonce = generateNonce(address);
    res.json({ nonce });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Invalid request' });
  }
});

/** POST /auth/verify */
router.post('/verify', async (req: Request, res: Response) => {
  try {
    const { address, signature, nonce } = verifyBodySchema.parse(req.body);
    const token = await verifyAndIssue(address, signature, nonce);
    res.json({ token });
  } catch (err: any) {
    res.status(400).json({ error: err.message || 'Verification failed' });
  }
});

export default router;
