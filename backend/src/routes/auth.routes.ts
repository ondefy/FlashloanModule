import { Router, type Request, type Response } from 'express';
import { secureAuth } from '../services/auth.service.js';

const router = Router();

/** GET /api/v2/auth/status — Health check (no auth required) */
router.get('/status', (_req: Request, res: Response) => {
  res.json({
    success: true,
    data: {
      status: 'Authentication service is running',
      domain: process.env.SIWE_DOMAIN || 'localhost:3001',
      statement: process.env.SIWE_STATEMENT || 'Sign in with Ethereum',
      timestamp: new Date().toISOString(),
    },
  });
});

/** POST /api/v2/auth/secure — SIWE login (compatible with old backend) */
router.post('/secure', async (req: Request, res: Response) => {
  try {
    const result = await secureAuth(req.body);
    res.json({
      success: true,
      data: {
        token: result.token,
        expiresIn: result.expiresIn,
        address: result.address,
        message: 'Authentication successful (secure)',
      },
    });
  } catch (err: any) {
    const status = err.status || 500;
    const code = err.code || 'AUTHENTICATION_ERROR';
    res.status(status).json({
      success: false,
      error: err.message || 'Failed to authenticate',
      code,
    });
  }
});

export default router;
