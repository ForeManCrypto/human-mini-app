/**
 * Proof of Human — Cloudflare Worker
 *
 * Endpoints:
 *
 *   POST /session
 *     Called by index.html on QR load.
 *     Stores {user_id, chat_id} keyed by session_id.
 *
 *   POST /verified
 *     Called by ShareRing servers after a successful scan.
 *     Looks up session, approves the Telegram join request directly.
 *
 *   GET /check?session=SESSION_ID
 *     Called by index.html to confirm verification.
 *     Returns { verified: true/false }
 */

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { ...CORS, 'Content-Type': 'application/json' }
    });
}

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // Handle CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        // ── POST /session ─────────────────────────────────────────
        // index.html calls this on QR load to register user_id + chat_id
        if (request.method === 'POST' && url.pathname === '/session') {
            try {
                const body = await request.json();
                const { session_id, user_id, chat_id } = body;

                if (!session_id) return json({ error: 'No session_id' }, 400);

                await env.SESSIONS.put(
                    `meta_${session_id}`,
                    JSON.stringify({ user_id, chat_id }),
                    { expirationTtl: 3600 }
                );

                console.log(`Session registered: ${session_id} → user=${user_id} chat=${chat_id}`);
                return json({ success: true });

            } catch(err) {
                return json({ error: err.message }, 500);
            }
        }

        // ── POST /verified ────────────────────────────────────────
        // ShareRing calls this after a successful scan
        if (request.method === 'POST' && url.pathname === '/verified') {
            try {
                const body = await request.json();
                console.log('ShareRing POST:', JSON.stringify(body));

                const sessionId = body.sessionId || body.session_id;
                if (!sessionId) return json({ error: 'No session_id' }, 400);

                // Store verification result
                await env.SESSIONS.put(
                    sessionId,
                    JSON.stringify({ verified: true, data: body, timestamp: new Date().toISOString() }),
                    { expirationTtl: 3600 }
                );

                // Look up user_id + chat_id registered by the mini app
                const metaRaw = await env.SESSIONS.get(`meta_${sessionId}`);
                if (metaRaw) {
                    const meta = JSON.parse(metaRaw);
                    const { user_id, chat_id } = meta;

                    if (user_id && chat_id && env.BOT_TOKEN) {
                        // Approve the Telegram join request directly
                        const tgRes = await fetch(
                            `https://api.telegram.org/bot${env.BOT_TOKEN}/approveChatJoinRequest`,
                            {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ chat_id: parseInt(chat_id), user_id: parseInt(user_id) })
                            }
                        );
                        const tgJson = await tgRes.json();
                        console.log(`Telegram approve result: ${JSON.stringify(tgJson)}`);

                        // Send confirmation message to user
                        if (tgJson.ok) {
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
                        }
                    }
                }

                return json({ success: true });

            } catch(err) {
                console.error('POST /verified error:', err.message);
                return json({ error: err.message }, 500);
            }
        }

        // ── GET /check?session=SESSION_ID ─────────────────────────
        // index.html polls this to confirm verification
        if (request.method === 'GET' && url.pathname === '/check') {
            const sessionId = url.searchParams.get('session');
            if (!sessionId) return json({ verified: false, error: 'No session' }, 400);

            try {
                const stored = await env.SESSIONS.get(sessionId);
                if (!stored) return json({ verified: false });
                const parsed = JSON.parse(stored);
                return json({ verified: true, data: parsed.data });
            } catch(err) {
                return json({ verified: false, error: err.message });
            }
        }

        // ── Health check ──────────────────────────────────────────
        if (url.pathname === '/') {
            return json({ status: 'Proof of Human Worker running' });
        }

        return new Response('Not found', { status: 404, headers: CORS });
    }
};