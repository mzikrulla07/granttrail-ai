import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { PROJECT_ROOT, type AppConfig } from './config.js';
import type { Db } from './db/index.js';
import type { Extractor } from './ai/types.js';
import type { DocumentStorage } from './storage/index.js';
import { AppError, errorHandler, notFound, requestId } from './http/errors.js';
import { apiRouter } from './routes/api.js';
import { SubawardService } from './services/subawardService.js';

export interface AppDeps {
  config: AppConfig;
  db: Db;
  storage: DocumentStorage;
  extractor: Extractor;
  today?: () => string;
}

export function createApp(deps: AppDeps) {
  const { config, db } = deps;
  const service = new SubawardService({
    db,
    storage: deps.storage,
    extractor: deps.extractor,
    rules: config.rules,
    exportConfig: config.export,
    today: deps.today,
  });

  const app = express();
  app.disable('x-powered-by');
  // One proxy hop in production: the ALB (ECS) or nginx (Elastic Beanstalk).
  app.set('trust proxy', config.env === 'production' ? 1 : false);

  app.use(requestId);

  // Secure HTTP headers (CSP, HSTS, noSniff, frameguard, referrer policy …)
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'frame-src': ["'self'", 'blob:'],
          'object-src': ["'none'"],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'self'"],
          // Only force HTTPS sub-resources when the site is actually served over HTTPS
          // (localhost and a single-instance Elastic Beanstalk demo use plain HTTP).
          'upgrade-insecure-requests': config.forceHttps ? [] : null,
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: config.forceHttps,
    }),
  );

  // CORS: only the configured front-end origin (Vite dev server). In production
  // the SPA is served from this same origin, so CORS is not needed at all.
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origin === config.clientOrigin),
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Demo-User', 'X-Requested-With'],
      exposedHeaders: ['X-Request-Id', 'Content-Disposition', 'X-Export-Count'],
      maxAge: 600,
    }),
  );

  // Request size limits — JSON bodies are small; PDFs go through multer's own limit.
  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));

  app.use(
    '/api',
    rateLimit({
      windowMs: config.limits.rateLimitWindowMs,
      limit: config.limits.rateLimitMax,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      // Health checks (load balancer, UI start-up) are not counted.
      skip: (req) => req.method === 'GET' && req.path === '/health',
      handler: (_req, _res, next) =>
        next(new AppError(429, 'RATE_LIMITED', 'Too many requests. Please wait a moment and try again.')),
    }),
  );

  app.use('/api', apiRouter({ db, config, service }));
  app.use('/api', notFound);

  // Production: serve the built React app from the same origin.
  const clientDist = path.join(PROJECT_ROOT, 'client', 'dist');
  if (config.env !== 'test' && fs.existsSync(path.join(clientDist, 'index.html'))) {
    app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
  }

  app.use(notFound);
  app.use(errorHandler(config.limits.maxUploadBytes));
  return { app, service };
}
