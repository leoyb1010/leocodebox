import express from 'express';

import { getModelPrices, setModelPrices, usageDb } from './usage.db.js';

const router = express.Router();
router.get('/prices', (_req, res) => res.json({ success: true, prices: getModelPrices() }));
router.put('/prices', (req, res) => res.json({ success: true, prices: setModelPrices(req.body?.prices) }));
router.get('/summary', (req, res) => {
  const read = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;
  res.json({ success: true, rows: usageDb.summary({
    from: read(req.query.from),
    to: read(req.query.to),
    projectPath: read(req.query.projectPath),
    provider: read(req.query.provider),
  }) });
});
export default router;
