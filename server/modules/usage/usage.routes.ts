import express from 'express';

import { usageDb } from './usage.db.js';

const router = express.Router();
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
