import { Router, type Request, type Response } from 'express';
import { authMiddleware } from '../middleware/auth.js';
import { getActivePositions, getTransactionLogs } from '../db/supabase.js';

const router = Router();

// All routes require JWT auth
router.use(authMiddleware);

/** GET /positions — Get all active positions for the authenticated user */
router.get('/', async (req: Request, res: Response) => {
  try {
    const positions = await getActivePositions(req.user!.address);
    res.json({ positions });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /positions/history — Get all transaction logs for the authenticated user */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    const logs = await getTransactionLogs(req.user!.address, limit, offset);
    res.json({ logs, limit, offset });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
