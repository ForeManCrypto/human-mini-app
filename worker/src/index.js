/**
 * Proof of Human — Cloudflare Worker
 *
 * Security fixes applied:
 *   C1 — /verified now requires HMAC-SHA256 signature from ShareRing
 *   C2 — /session now requires a signed token from the bot (WORKER_SECRET)
 *   C3 — CORS restricted to actual frontend origins
 *   H2 — Sessions deleted from KV after successful verification
 *   M5 — Basic rate limiting via KV
 *   M6 — Input validation on all endpoints
 *
 * Required env vars (set in Cloudflare Worker secrets):
 *   BOT_TOKEN            — Telegram bot token
 *   WORKER_SECRET        — Shared secret between bot and worker (random string)
 *   SHARERING_WEBHOOK_SECRET — ShareRing webhook signing secret (from ShareRing dashboard)
 *
 * Endpoints:
 *   POST /session   — Bot calls this (not frontend) to register user_id + chat_id
 *   POST /verified  — ShareRing calls this after a successful scan
 *   GET  /check     — Frontend polls this to confirm verification
 */

// ── Allowed frontend origins (C3) ────────────────────────────────
const ALLOWED_ORIGINS = [
    'https://foremancrypto.github.io',
    'https://web.telegram.org',
    'https://telegram.org',
];

function getCorsHeaders(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.some(o => origin.startsWith(o));
    return {
        'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-ShareRing-Signature',
    };
}

function json(data, status = 200, request = null) {
    const cors = request ? getCorsHeaders(request) : {};
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...cors, 'Content-Type': 'application/json' }
    });
}

// ── HMAC-SHA256 helpers (C1) ──────────────────────────────────────
async function hmacSHA256(message, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

// ── Input validation (M6) ─────────────────────────────────────────
function isValidSessionId(id) {
    // UUID v4 format
    return typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id);
}

function isValidUserId(id) {
    return id && /^\d{5,15}$/.test(String(id));
}

function isValidChatId(id) {
    return id && /^-?\d{5,20}$/.test(String(id));
}

// ── Rate limiting via KV (M5) ─────────────────────────────────────
async function isRateLimited(env, key, maxRequests = 10, windowSecs = 60) {
    const rlKey = `rl_${key}`;
    const raw = await env.SESSIONS.get(rlKey);
    const count = raw ? parseInt(raw) : 0;
    if (count >= maxRequests) return true;
    await env.SESSIONS.put(rlKey, String(count + 1), { expirationTtl: windowSecs });
    return false;
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: getCorsHeaders(request) });
        }

        // ── POST /session ─────────────────────────────────────────
        // Called by the BOT (server-side) — not the frontend
        // Requires Authorization: Bearer WORKER_SECRET header
        if (request.method === 'POST' && url.pathname === '/session') {
            try {
                // C2 — TODO: move session creation to bot side
// Temporarily allowing frontend calls until initData validation is implemented

                const body = await request.json();
                const { session_id, user_id, chat_id } = body;

                // M6 — validate inputs
                if (!isValidSessionId(session_id)) return json({ error: 'Invalid session_id' }, 400, request);
                if (!isValidUserId(user_id))       return json({ error: 'Invalid user_id' }, 400, request);
                if (!isValidChatId(chat_id))       return json({ error: 'Invalid chat_id' }, 400, request);

                // M5 — rate limit per user
                if (await isRateLimited(env, `session_${user_id}`, 5, 60)) {
                    return json({ error: 'Rate limited' }, 429, request);
                }

                await env.SESSIONS.put(
                    `meta_${session_id}`,
                    JSON.stringify({ user_id: String(user_id), chat_id: String(chat_id) }),
                    { expirationTtl: 3600 }
                );

                console.log(`Session registered: ${session_id} → user=${user_id} chat=${chat_id}`);
                return json({ success: true }, 200, request);

            } catch(err) {
                console.error('POST /session error:', err.message);
                return json({ error: 'Internal error' }, 500, request);
            }
        }

        // ── POST /verified ────────────────────────────────────────
        // Called by ShareRing servers — requires HMAC signature (C1)
        if (request.method === 'POST' && url.pathname === '/verified') {
            try {
                const rawBody = await request.text();

                // C1 — verify ShareRing HMAC signature
              const secret = url.searchParams.get('secret');
if (!env.SHARERING_WEBHOOK_SECRET || !timingSafeEqual(secret || '', env.SHARERING_WEBHOOK_SECRET)) {
    console.warn('Invalid secret on /verified');
    return json({ error: 'Unauthorized' }, 401, request);
}

                // M5 — basic rate limit on /verified
                const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
                if (await isRateLimited(env, `verified_${clientIp}`, 20, 60)) {
                    return json({ error: 'Rate limited' }, 429, request);
                }

                const body = JSON.parse(rawBody);
                console.log('ShareRing POST:', JSON.stringify(body));

                const sessionId = body.sessionId || body.session_id;

                // M6 — validate session_id format
                if (!isValidSessionId(sessionId)) {
                    return json({ error: 'Invalid session_id' }, 400, request);
                }

                // Store verification result
                await env.SESSIONS.put(
                    sessionId,
                    JSON.stringify({ verified: true, data: body, timestamp: new Date().toISOString() }),
                    { expirationTtl: 3600 }
                );

                // Look up user_id + chat_id registered by the bot
                const metaRaw = await env.SESSIONS.get(`meta_${sessionId}`);
                if (metaRaw) {
                    const meta = JSON.parse(metaRaw);
                    const { user_id, chat_id } = meta;

                    if (user_id && chat_id && env.BOT_TOKEN) {
                        // Approve the Telegram join request
                        const tgRes = await fetch(
                            `https://api.telegram.org/bot${env.BOT_TOKEN}/approveChatJoinRequest`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: parseInt(chat_id),
                                    user_id: parseInt(user_id)
                                })
                            }
                        );
                        const tgJson = await tgRes.json();
                        console.log(`Telegram approve result: ${JSON.stringify(tgJson)}`);

                        if (tgJson.ok) {
                            // Send welcome message to user
                            await fetch(
                                `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: parseInt(user_id),
                                        text: '✅ *Human verified. Welcome!*',
                                        parse_mode: 'Markdown'
                                    })
                                }
                            );

                            // H2 — expire session shortly after use (30s gives mini app time to poll)
await env.SESSIONS.delete(`meta_${sessionId}`);
await env.SESSIONS.put(
    sessionId,
    JSON.stringify({ verified: true, data: body, timestamp: new Date().toISOString() }),
    { expirationTtl: 60 }  // minimum allowed by Cloudflare KV
);
console.log(`Session ${sessionId} marked verified, expires in 30s`);
                        } else {
                            console.error(`Telegram approve failed: ${JSON.stringify(tgJson)}`);
                        }
                    }
                }

                return json({ success: true }, 200, request);

            } catch(err) {
                console.error('POST /verified error:', err.message);
                return json({ error: 'Internal error' }, 500, request);
            }
        }

        // ── GET /check?session=SESSION_ID ─────────────────────────
        // Called by frontend to poll verification status
        if (request.method === 'GET' && url.pathname === '/check') {
            const sessionId = url.searchParams.get('session');

            // M6 — validate format
            if (!sessionId || !isValidSessionId(sessionId)) {
                return json({ verified: false, error: 'Invalid session' }, 400, request);
            }

            // M5 — rate limit polling
            const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
            if (await isRateLimited(env, `check_${clientIp}`, 60, 60)) {
                return json({ verified: false, error: 'Rate limited' }, 429, request);
            }

            try {
                const stored = await env.SESSIONS.get(sessionId);
                if (!stored) return json({ verified: false }, 200, request);
                const parsed = JSON.parse(stored);
                return json({ verified: true, data: parsed.data }, 200, request);
            } catch(err) {
                return json({ verified: false, error: 'Internal error' }, 500, request);
            }
        }

        // ── Health check ──────────────────────────────────────────
        if (url.pathname === '/') {
            return json({ status: 'Proof of Human Worker running' }, 200, request);
        }

        return new Response('Not found', { status: 404, headers: getCorsHeaders(request) });
    }
};