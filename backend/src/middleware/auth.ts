import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service.js';

declare global {
  namespace Express {
    interface Request {
      user?: { address: string };
    }
  }
}

/**
 * JWT Bearer authentication middleware.
 * Sets req.user.address (lowercase) on success.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer "

  try {
    const decoded = verifyToken(token);
    req.user = { address: decoded.address };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}
