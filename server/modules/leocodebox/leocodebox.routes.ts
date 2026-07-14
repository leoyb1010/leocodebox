import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import type { ErrorRequestHandler } from 'express';

import { findAppRoot } from '@/utils/runtime-paths.js';

import cliToolsRoutes, { CLI_TOOLS, getCliToolStatus } from './cli-tools.routes.js';
import { collectDiagnostics } from './diagnostics.service.js';
import { collectDoctorReport } from './doctor.service.js';
import feedbackUpdateRoutes from './feedback-update.routes.js';
import providerSwitchRoutes from './provider-switch.routes.js';

const router = express.Router();

router.use('/cli', cliToolsRoutes);
router.use(feedbackUpdateRoutes);
router.use(providerSwitchRoutes);

// One-click shareable diagnostics: CLI inventory + Leoapi state, with API keys
// masked and home paths collapsed. No raw logs, no secrets.
router.get('/diagnostics', async (_req, res, next) => {
  try {
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool, { checkLatest: false })),
    );
    const appRoot = findAppRoot(path.dirname(fileURLToPath(import.meta.url)));
    res.json({ success: true, report: await collectDiagnostics(appRoot, tools) });
  } catch (error) {
    next(error);
  }
});

// Read-only readiness assessment: per-check ok/warn/fail for CLIs + Leoapi nodes.
router.get('/doctor', async (_req, res, next) => {
  try {
    const tools = await Promise.all(
      Object.values(CLI_TOOLS).map((tool) => getCliToolStatus(tool, { checkLatest: false })),
    );
    res.json({ success: true, report: await collectDoctorReport(tools) });
  } catch (error) {
    next(error);
  }
});

const localRouteErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  const statusCode = typeof error?.statusCode === 'number' ? error.statusCode : 500;
  const message = error instanceof Error ? error.message : 'leocodebox local route failed.';
  res.status(statusCode).json({ success: false, error: message });
};
router.use(localRouteErrorHandler);

export default router;
