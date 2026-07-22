/**
 * Loopback proxy surface for the Leoapi gateway. Mounted OUTSIDE `/api` and
 * BEFORE the JSON body parser so the request body streams through untouched; it
 * authenticates via the opaque `lgw:<providerId>` token (not the app's local
 * token, which the agent CLI doesn't have), and is bound to 127.0.0.1 only.
 */
import express from 'express';

import { isGatewayEnabled } from './gateway-config.js';
import { buildUpstreamHeaders, gatewayInternals, meterFromResponse, resolveUpstreamFromHeaders } from './gateway.service.js';

const router = express.Router();

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

router.all(/.*/, async (req, res) => {
  // Loopback only: the gateway holds real upstream keys and must never be
  // reachable off-box, regardless of how the server socket was bound.
  if (!LOOPBACK.has(req.socket.remoteAddress || '')) {
    res.status(403).json({ error: { type: 'forbidden', message: 'Gateway is loopback-only.' } });
    return;
  }
  if (!isGatewayEnabled()) {
    res.status(503).json({ error: { type: 'gateway_disabled', message: 'Leoapi gateway is off.' } });
    return;
  }
  const upstream = await resolveUpstreamFromHeaders(req.headers);
  if (!upstream) {
    res.status(401).json({ error: { type: 'authentication_error', message: 'Unknown or missing Leoapi gateway token.' } });
    return;
  }

  let body: Buffer;
  try {
    body = await readRawBody(req);
  } catch {
    res.status(400).json({ error: { type: 'invalid_request_error', message: 'Could not read request body.' } });
    return;
  }

  const target = `${upstream.baseUrl}${req.url}`;
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target, {
      method: req.method,
      headers: buildUpstreamHeaders(req.headers, upstream.apiKey),
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
    });
  } catch (error) {
    // Fail closed: a real error, never a silent fallback to some other route.
    res.status(502).json({ error: { type: 'upstream_error', message: error instanceof Error ? error.message : 'Upstream request failed.' } });
    meterFromResponse(upstream.providerName, '', 502);
    return;
  }

  res.status(upstreamResponse.status);
  upstreamResponse.headers.forEach((value, key) => {
    if (!gatewayInternals.STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });

  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => '');
    res.send(text);
    meterFromResponse(upstream.providerName, text, upstreamResponse.status);
    return;
  }

  // Stream chunks straight through (faithful), tee-decoding a bounded copy for
  // metering. A metering failure can never affect the forwarded bytes.
  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  let copy = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        res.write(Buffer.from(value));
        if (copy.length < 512_000) copy += decoder.decode(value, { stream: true });
      }
    }
  } catch { /* client disconnect / upstream abort — end below */ }
  res.end();
  meterFromResponse(upstream.providerName, copy, upstreamResponse.status);
});

export default router;
