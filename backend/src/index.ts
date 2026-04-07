import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { getEnv } from './config/env.js';
import authRoutes from './routes/auth.routes.js';
import onboardingRoutes from './routes/onboarding.routes.js';
import positionRoutes from './routes/position.routes.js';
import vaultRoutes from './routes/vault.routes.js';
import { startMonitor } from './services/monitor.service.js';

const env = getEnv();
const logger = pino({ level: env.LOG_LEVEL });

const app = express();

// Middleware
const allowedOrigins = env.ALLOWED_ORIGINS.split(',');
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());
app.use(pinoHttp({ logger }));

// Routes
app.use('/auth', authRoutes);
app.use('/onboarding', onboardingRoutes);
app.use('/positions', positionRoutes);
app.use('/vault', vaultRoutes);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server
app.listen(env.PORT, () => {
  logger.info(`Zyfi Borrow Agent API listening on port ${env.PORT}`);

  // Start position monitor daemon
  startMonitor();
});

export default app;
