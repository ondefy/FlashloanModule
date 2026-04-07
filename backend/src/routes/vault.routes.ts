import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { deposit, borrow, repay, withdraw, getPositionInfo } from '../services/vault.service.js';

const router = Router();
router.use(authMiddleware);

const depositSchema = z.object({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().min(1), // Raw units as string (e.g., "1000000000000000000" for 1 WETH)
});

const borrowSchema = z.object({
  amount: z.string().min(1), // Raw USDC units (e.g., "1000000000" for 1000 USDC)
});

const repaySchema = z.object({
  amount: z.string().min(1),
});

const withdrawSchema = z.object({
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  amount: z.string().min(1),
});

/** POST /vault/deposit */
router.post('/deposit', async (req: Request, res: Response) => {
  try {
    const { token, amount } = depositSchema.parse(req.body);
    const result = await deposit(req.user!.address, token, BigInt(amount));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /vault/borrow */
router.post('/borrow', async (req: Request, res: Response) => {
  try {
    const { amount } = borrowSchema.parse(req.body);
    const result = await borrow(req.user!.address, BigInt(amount));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /vault/repay */
router.post('/repay', async (req: Request, res: Response) => {
  try {
    const { amount } = repaySchema.parse(req.body);
    const result = await repay(req.user!.address, BigInt(amount));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** POST /vault/withdraw */
router.post('/withdraw', async (req: Request, res: Response) => {
  try {
    const { token, amount } = withdrawSchema.parse(req.body);
    const result = await withdraw(req.user!.address, token, BigInt(amount));
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /vault/position — Current position details */
router.get('/position', async (req: Request, res: Response) => {
  try {
    const info = await getPositionInfo(req.user!.address);
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
