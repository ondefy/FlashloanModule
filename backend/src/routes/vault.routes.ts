import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { authMiddleware } from '../middleware/auth.js';
import { deposit, borrow, repay, withdraw, getPositionInfo, simulateAction, getProtocolRates } from '../services/vault.service.js';
import { forceMigrate } from '../services/monitor.service.js';

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

/** GET /vault/position — Current position details with balances and limits */
router.get('/position', async (req: Request, res: Response) => {
  try {
    const info = await getPositionInfo(req.user!.address);
    res.json(info);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const simulateSchema = z.object({
  action: z.enum(['deposit', 'withdraw', 'borrow', 'repay']),
  amount: z.string().min(1),
  token: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
});

/** POST /vault/simulate — Preview health factor after an action */
router.post('/simulate', async (req: Request, res: Response) => {
  try {
    const { action, amount, token } = simulateSchema.parse(req.body);
    const result = await simulateAction(req.user!.address, action, BigInt(amount), token);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

const migrateSchema = z.object({
  toProtocol: z.enum(['aave_v3', 'morpho_blue']),
});

/** POST /vault/migrate — Force-migrate position to another protocol via flashloan */
router.post('/migrate', async (req: Request, res: Response) => {
  try {
    const { toProtocol } = migrateSchema.parse(req.body);
    const result = await forceMigrate(req.user!.address, toProtocol);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/** GET /vault/rates — Current protocol APYs */
router.get('/rates', async (_req: Request, res: Response) => {
  try {
    const rates = await getProtocolRates();
    res.json(rates);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
