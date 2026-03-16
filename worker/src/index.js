/**
 * Proof of Human — Cloudflare Worker
 *
 * Two endpoints:
 *
 *   POST /verified
 *     Called by ShareRing servers after a successful scan.
 *     Stores the session_id in KV as verified.
 *     → Update your ShareRing dashboard endpoint to:
 *       https://human-bot-worker.moneyforeman.workers.dev/verified
 *
 *   GET /check?session=SESSION_ID
 *     Called by your index.html to confirm a session was verified.
 *     Returns { verified: true/false, data: {...} }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // ── POST /verified ────────────────────────────────────────────
    // ShareRing posts here after a successful scan
    if (request.method === 'POST' && url.pathname === '/verified') {
      try {
        const body = await request.json();
        console.log('ShareRing POST received:', JSON.stringify(body));

        // Extract session_id — ShareRing may use either key
        const sessionId = body.sessionId || body.session_id;

        if (!sessionId) {
          return new Response(
            JSON.stringify({ error: 'No session_id in payload' }),
            { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
          );
        }

        // Store in KV with 1 hour expiry (enough time to complete verification)
        await env.SESSIONS.put(sessionId, JSON.stringify({
          verified: true,
          data: body,
          timestamp: new Date().toISOString()
        }), { expirationTtl: 3600 });

        console.log('Session stored:', sessionId);

        return new Response(
          JSON.stringify({ success: true }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );

      } catch (err) {
        console.error('POST /verified error:', err.message);
        return new Response(
          JSON.stringify({ error: err.message }),
          { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }
    }

    // ── GET /check?session=SESSION_ID ─────────────────────────────
    // Your index.html polls this after onScan fires
    if (request.method === 'GET' && url.pathname === '/check') {
      const sessionId = url.searchParams.get('session');

      if (!sessionId) {
        return new Response(
          JSON.stringify({ verified: false, error: 'No session provided' }),
          { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      const stored = await env.SESSIONS.get(sessionId);

      if (!stored) {
        return new Response(
          JSON.stringify({ verified: false }),
          { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
        );
      }

      const parsed = JSON.parse(stored);
      return new Response(
        JSON.stringify({ verified: true, data: parsed.data }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── Health check ──────────────────────────────────────────────
    if (url.pathname === '/') {
      return new Response(
        JSON.stringify({ status: 'Proof of Human Worker running' }),
        { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404, headers: CORS });
  }
};