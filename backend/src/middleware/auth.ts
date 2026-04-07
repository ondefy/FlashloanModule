import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.service.js';

declare global {
  namespace Express {
    interface Request {
      authType?: 'jwt' | 'api-key';
      user?: {
        id?: string;
        walletAddress?: string;
        address: string;
        sub?: string;
        [key: string]: any;
      };
    }
  }
}

/**
 * JWT Bearer authentication middleware.
 * Compatible with old backend's error codes.
 * Sets req.user.address and req.user.walletAddress.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(403).json({
      error: 'Access denied',
      message: 'Authorization header is required',
      code: 'MISSING_AUTH_HEADER',
    });
    return;
  }

  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Invalid token format',
      message: 'Authorization header must start with "Bearer "',
      code: 'INVALID_TOKEN_FORMAT',
    });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = verifyToken(token);
    // Store both lowercase (for DB queries) and original (for compatibility)
    req.user = {
      address: decoded.address.toLowerCase(),
      walletAddress: decoded.address,
    };
    req.authType = 'jwt';
    next();
  } catch {
    res.status(401).json({
      error: 'Invalid token',
      message: 'JWT token is invalid or expired',
      code: 'INVALID_TOKEN',
    });
  }
}
