import express from 'express';
import type { ErrorRequestHandler } from 'express';

import cliToolsRoutes from './cli-tools.routes.js';
import feedbackUpdateRoutes from './feedback-update.routes.js';
import providerSwitchRoutes from './provider-switch.routes.js';

const router = express.Router();

router.use('/cli', cliToolsRoutes);
router.use(feedbackUpdateRoutes);
router.use(providerSwitchRoutes);

const localRouteErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'leocodebox local route failed.';
  res.status(statusCode).json({ success: false, error: message });
};
router.use(localRouteErrorHandler);

export default router;
