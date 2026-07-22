/**
 * Authed control/status surface for the Leoapi gateway (under /api/leocodebox/
 * gateway). Separate from the loopback proxy surface: this one is the app UI's
 * toggle + live wire-meter readout.
 */
import express from 'express';

import { gatewayBaseUrl, isGatewayEnabled, setGatewayEnabled } from './gateway-config.js';
import { gatewayMeterSnapshot } from './gateway-meter.js';

const router = express.Router();

router.get('/status', (_req, res) => {
  res.json({ success: true, enabled: isGatewayEnabled(), baseUrl: gatewayBaseUrl(), meter: gatewayMeterSnapshot() });
});

router.put('/toggle', (req, res) => {
  const enabled = setGatewayEnabled(Boolean(req.body?.enabled));
  res.json({ success: true, enabled });
});

export default router;
