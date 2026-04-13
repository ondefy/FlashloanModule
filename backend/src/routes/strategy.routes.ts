import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { quoteCarryTrade } from '../services/strategy.service.js';

const router = Router();

const quoteSchema = z.object({
  collateralAmount: z.union([z.number(), z.string()]).transform((v) => Number(v)),
  collateralAsset: z.literal('WETH').default('WETH'),
  ltv: z.union([z.number(), z.string()]).optional().transform((v) => (v == null ? undefined : Number(v))),
  topN: z.number().int().min(1).max(10).optional(),
});

/**
 * POST /api/strategy/carry-trade/quote
 * Body: { collateralAmount, collateralAsset?, ltv?, topN? }
 *
 * Returns net APY for: deposit WETH on Aave → borrow USDC → deposit in best USDC opp.
 */
router.post('/carry-trade/quote', async (req: Request, res: Response) => {
  try {
    const parsed = quoteSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid request', issues: parsed.error.issues });
    }
    const quote = await quoteCarryTrade(parsed.data as any);
    res.json(quote);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
