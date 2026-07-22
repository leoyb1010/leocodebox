/**
 * Loopback proxy surface for the Leoapi gateway. Mounted OUTSIDE `/api` and
 * BEFORE the JSON body parser so the request body streams through untouched; it
 * authenticates via the opaque `lgw:<target>[:<slot>]` token (not the app's
 * local token, which the agent CLI doesn't have), resolves the current node for
 * that target at REQUEST time (so switching the active node takes effect on the
 * next request), fails over to same-target siblings on a retryable upstream
 * error, and is bound to 127.0.0.1 only.
 */
import express from 'express';

import { isGatewayEnabled } from './gateway-config.js';
import { buildUpstreamHeaders, gatewayInternals, meterFromResponse, resolveUpstreamChain, type ResolvedUpstream } from './gateway.service.js';

const router = express.Router();

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** A retryable upstream failure — safe to fail over BEFORE any byte is streamed. */
function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** Faithfully stream an upstream response back + tee-meter it. */
async function streamAndMeter(res: express.Response, upstreamResponse: Response, providerName: string): Promise<void> {
  res.status(upstreamResponse.status);
  upstreamResponse.headers.forEach((value, key) => {
    if (!gatewayInternals.STRIP_RESPONSE_HEADERS.has(key.toLowerCase())) res.setHeader(key, value);
  });
  if (!upstreamResponse.body) {
    const text = await upstreamResponse.text().catch(() => '');
    res.send(text);
    meterFromResponse(providerName, text, upstreamResponse.status);
    return;
  }
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
  meterFromResponse(providerName, copy, upstreamResponse.status);
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
  const chain: ResolvedUpstream[] = await resolveUpstreamChain(req.headers);
  if (chain.length === 0) {
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

  // Try the primary node, then fail over to same-target siblings on a retryable
  // upstream error (429 / 5xx / network) — but only BEFORE any byte is streamed,
  // so a client never sees a half-response from two nodes. Each attempt is
  // metered. If every node fails, fail closed with the last real error.
  const upstreamHeaders = buildUpstreamHeaders(req.headers, '');
  for (let i = 0; i < chain.length; i += 1) {
    const upstream = chain[i];
    const isLast = i === chain.length - 1;
    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(`${upstream.baseUrl}${req.url}`, {
        method: req.method,
        headers: { ...upstreamHeaders, 'x-api-key': upstream.apiKey, authorization: `Bearer ${upstream.apiKey}` },
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
    } catch (error) {
      meterFromResponse(upstream.providerName, '', 502);
      if (!isLast) continue;
      res.status(502).json({ error: { type: 'upstream_error', message: error instanceof Error ? error.message : 'Upstream request failed.' } });
      return;
    }

    if (isRetryableStatus(upstreamResponse.status) && !isLast) {
      await upstreamResponse.body?.cancel().catch(() => { /* discard */ });
      meterFromResponse(upstream.providerName, '', upstreamResponse.status);
      continue;
    }

    await streamAndMeter(res, upstreamResponse, upstream.providerName);
    return;
  }
});

export default router;
