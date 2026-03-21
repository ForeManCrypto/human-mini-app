/**
 * Proof of Human — Cloudflare Worker
 *
 * Session storage uses Durable Objects for strong consistency.
 * Rate limiting uses KV (eventual consistency is fine for this).
 *
 * Security:
 *   C1 — /verified requires secret from ShareRing
 *   C3 — CORS restricted to actual frontend origins
 *   H2 — Sessions auto-expire 1h via DO alarm, deleted immediately after use
 *   M5 — Rate limiting via KV
 *   M6 — Input validation on all endpoints
 *
 * Required env vars (Cloudflare Worker secrets):
 *   BOT_TOKEN                  — Telegram bot token
 *   WORKER_SECRET              — Shared secret between bot and worker
 *   SHARERING_WEBHOOK_SECRET   — ShareRing webhook signing secret
 *
 * Endpoints:
 *   POST /session   — Frontend registers session_id + user_id + chat_id
 *   POST /verified  — ShareRing calls this after a successful scan
 *   GET  /check     — Frontend polls to confirm verification
 */

// ── Durable Object — SessionStore ────────────────────────────────
export class SessionStore {
    constructor(state) {
        this.state = state;
    }

    async fetch(request) {
        const url = new URL(request.url);

        switch (`${request.method} ${url.pathname}`) {

            case 'PUT /meta': {
                const data = await request.json();
                await this.state.storage.put('meta', data);
                // Auto-expire session after 1 hour
                await this.state.storage.setAlarm(Date.now() + 3600 * 1000);
                return new Response(JSON.stringify({ success: true }));
            }

            case 'GET /meta': {
                const meta = await this.state.storage.get('meta');
                if (!meta) return new Response(JSON.stringify({ found: false }), { status: 404 });
                return new Response(JSON.stringify({ found: true, data: meta }));
            }

            case 'PUT /verified': {
                const data = await request.json();
                await this.state.storage.put('verified', data);
                return new Response(JSON.stringify({ success: true }));
            }

            case 'GET /check': {
                const [verified, meta] = await Promise.all([
                    this.state.storage.get('verified'),
                    this.state.storage.get('meta')
                ]);
                return new Response(JSON.stringify({
                    verified: !!verified,
                    data: verified ? verified.data : null,
                    invite_link: verified ? (verified.invite_link || null) : null,
                    has_meta: !!meta
                }));
            }

            case 'DELETE /meta': {
                await this.state.storage.delete('meta');
                return new Response(JSON.stringify({ success: true }));
            }

            case 'DELETE /': {
                await this.state.storage.deleteAll();
                return new Response(JSON.stringify({ success: true }));
            }
        }

        return new Response('Not found', { status: 404 });
    }

    async alarm() {
        await this.state.storage.deleteAll();
    }
}

// ── Helpers ───────────────────────────────────────────────────────
function getSession(env, sessionId) {
    const id = env.SESSIONS.idFromName(sessionId);
    return env.SESSIONS.get(id);
}

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

async function alertAdmin(env, message) {
    if (!env.BOT_TOKEN || !env.ADMIN_TELEGRAM_ID) return;
    await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_id: env.ADMIN_TELEGRAM_ID,
            text: `⚠️ *Proof of Human — Worker Alert*\n\n${message}`,
            parse_mode: 'Markdown'
        })
    }).catch(() => {});
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
    return typeof id === 'string' && id.length >= 8 && id.length <= 128 && /^[a-zA-Z0-9_.-]+$/.test(id);
}

function isValidUserId(id) {
    return id && /^\d{5,15}$/.test(String(id));
}

function isValidChatId(id) {
    return id && /^-?\d{5,20}$/.test(String(id));
}

function isValidMessageId(id) {
    return id && /^\d{1,15}$/.test(String(id));
}

// ── Rate limiting via KV (M5) ─────────────────────────────────────
async function isRateLimited(env, key, maxRequests = 10, windowSecs = 60) {
    const rlKey = `rl_${key}`;
    const raw = await env.RATE_LIMIT.get(rlKey);
    const count = raw ? parseInt(raw) : 0;
    if (count >= maxRequests) return true;
    await env.RATE_LIMIT.put(rlKey, String(count + 1), { expirationTtl: windowSecs });
    return false;
}

// ── Worker ────────────────────────────────────────────────────────
export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        // CORS preflight
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: getCorsHeaders(request) });
        }

        // ── POST /session ─────────────────────────────────────────
        if (request.method === 'POST' && url.pathname === '/session') {
            try {
                const body = await request.json();
                const { session_id, user_id, chat_id, message_id, action_type, group_message_id } = body;

                if (!isValidSessionId(session_id)) return json({ error: 'Invalid session_id' }, 400, request);
                if (!isValidUserId(user_id))       return json({ error: 'Invalid user_id' }, 400, request);
                if (!isValidChatId(chat_id))       return json({ error: 'Invalid chat_id' }, 400, request);
                if (message_id && !isValidMessageId(message_id)) return json({ error: 'Invalid message_id' }, 400, request);
                if (action_type && action_type !== 'unrestrict') return json({ error: 'Invalid action_type' }, 400, request);
                if (group_message_id && !isValidMessageId(group_message_id)) return json({ error: 'Invalid group_message_id' }, 400, request);

                if (await isRateLimited(env, `session_${user_id}`, 20, 60)) {
                    return json({ error: 'Rate limited' }, 429, request);
                }

                const meta = { user_id: String(user_id), chat_id: String(chat_id) };
                if (message_id) meta.message_id = String(message_id);
                if (action_type === 'unrestrict') meta.action_type = 'unrestrict';
                if (group_message_id) meta.group_message_id = String(group_message_id);

                const stub = getSession(env, session_id);
                await stub.fetch('http://do/meta', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(meta)
                });

                console.log(`Session registered: ${session_id} → user=${user_id} chat=${chat_id} msg=${message_id || 'n/a'}`);
                return json({ success: true }, 200, request);

            } catch(err) {
                console.error('POST /session error:', err.message);
                return json({ error: 'Internal error' }, 500, request);
            }
        }

        // ── POST /verified ────────────────────────────────────────
        if (request.method === 'POST' && url.pathname === '/verified') {
            try {
                const rawBody = await request.text();
                const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';
                console.log(`/verified hit: ip=${clientIp} body_len=${rawBody.length} secret_present=${!!url.searchParams.get('secret')}`);

                // C1 — verify ShareRing secret
                const secret = url.searchParams.get('secret');
                if (!env.SHARERING_WEBHOOK_SECRET || !timingSafeEqual(secret || '', env.SHARERING_WEBHOOK_SECRET)) {
                    console.warn('Invalid secret on /verified');
                    await alertAdmin(env, '🔐 Invalid secret on `/verified` — possible misconfiguration or probe.');
                    return json({ error: 'Unauthorized' }, 401, request);
                }

                if (await isRateLimited(env, `verified_${clientIp}`, 20, 60)) {
                    return json({ error: 'Rate limited' }, 429, request);
                }

                const body = JSON.parse(rawBody);
                console.log('ShareRing POST:', JSON.stringify(body));

                const sessionId = body.sessionId || body.session_id;
                if (!isValidSessionId(sessionId)) {
                    return json({ error: 'Invalid session_id' }, 400, request);
                }

                const stub = getSession(env, sessionId);

                // Write verified=true immediately so the frontend can pick it up
                // regardless of what happens next (meta lookup, Telegram approval).
                // We update it with the invite link once that's generated.
                await stub.fetch('http://do/verified', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ verified: true, data: body, timestamp: new Date().toISOString() })
                });
                console.log(`Verified=true written for session ${sessionId}`);

                // Look up meta registered by the frontend.
                // Retry up to 3x with 1s delay — handles the race where ShareRing
                // calls /verified before the frontend's POST /session completes.
                let metaJson = { found: false };
                for (let attempt = 1; attempt <= 3; attempt++) {
                    const metaRes = await stub.fetch('http://do/meta');
                    metaJson = await metaRes.json();
                    if (metaJson.found) break;
                    if (attempt < 3) {
                        console.log(`Meta not found for ${sessionId} (attempt ${attempt}/3) — retrying in 1s`);
                        await new Promise(r => setTimeout(r, 1000));
                    }
                }

                if (!metaJson.found) {
                    console.warn(`No meta found for session ${sessionId} after 3 attempts`);
                    await alertAdmin(env, `🔍 No meta found for session \`${sessionId}\` after retries — possible race condition or unregistered session.`);
                }

                if (metaJson.found) {
                    const meta = metaJson.data;
                    const { user_id, chat_id } = meta;

                    if (user_id && chat_id && env.BOT_TOKEN) {
                        let inviteLink = null;

                        if (meta.action_type === 'unrestrict') {
                            // Lift restrictions — user is already in the group, just muted pending verification.
                            const tgRes = await fetch(
                                `https://api.telegram.org/bot${env.BOT_TOKEN}/restrictChatMember`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: parseInt(chat_id),
                                        user_id: parseInt(user_id),
                                        permissions: {
                                            can_send_messages: true,
                                            can_send_audios: true,
                                            can_send_documents: true,
                                            can_send_photos: true,
                                            can_send_videos: true,
                                            can_send_video_notes: true,
                                            can_send_voice_notes: true,
                                            can_send_polls: true,
                                            can_send_other_messages: true,
                                            can_add_web_page_previews: true,
                                            can_change_info: false,
                                            can_invite_users: true,
                                            can_pin_messages: false,
                                        }
                                    })
                                }
                            );
                            const tgJson = await tgRes.json();
                            console.log(`Telegram unrestrict result: ${JSON.stringify(tgJson)}`);
                            if (!tgJson.ok) {
                                console.error(`Telegram unrestrict failed: ${JSON.stringify(tgJson)}`);
                                await alertAdmin(env, `❌ Telegram unrestrict failed for user \`${user_id}\` in chat \`${chat_id}\`\n\`${JSON.stringify(tgJson)}\``);
                            }
                        } else {
                            // Approve the Telegram join request.
                            // USER_ALREADY_PARTICIPANT is not an error.
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

                            const approvalOk = tgJson.ok ||
                                (tgJson.error_code === 400 && tgJson.description && tgJson.description.includes('USER_ALREADY_PARTICIPANT'));

                            if (!tgJson.ok && !approvalOk) {
                                console.error(`Telegram approval failed: ${JSON.stringify(tgJson)}`);
                                await alertAdmin(env, `❌ Telegram approval failed for user \`${user_id}\` in chat \`${chat_id}\`\n\`${JSON.stringify(tgJson)}\``);
                            }

                            // Generate invite link (join-request flow).
                            try {
                                const inviteRes = await fetch(
                                    `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`,
                                    {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            chat_id: parseInt(chat_id),
                                            member_limit: 1,
                                            expire_date: Math.floor(Date.now() / 1000) + 300
                                        })
                                    }
                                );
                                const inviteJson = await inviteRes.json();
                                if (inviteJson.ok) {
                                    inviteLink = inviteJson.result.invite_link;
                                    console.log(`Invite link created for session ${sessionId}`);
                                } else {
                                    console.warn(`createChatInviteLink failed: ${JSON.stringify(inviteJson)}`);
                                }
                            } catch(e) {
                                console.warn(`createChatInviteLink error: ${e.message}`);
                            }
                        }

                        // Generate invite link for unrestrict flow too — used by mini app to navigate
                        // back to the group. Member_limit=1 still works; user is already in the group
                        // so Telegram will just redirect them to the chat.
                        if (meta.action_type === 'unrestrict' && !inviteLink) {
                            try {
                                const inviteRes = await fetch(
                                    `https://api.telegram.org/bot${env.BOT_TOKEN}/createChatInviteLink`,
                                    {
                                        method: 'POST',
                                        headers: { 'Content-Type': 'application/json' },
                                        body: JSON.stringify({
                                            chat_id: parseInt(chat_id),
                                            member_limit: 1,
                                            expire_date: Math.floor(Date.now() / 1000) + 300
                                        })
                                    }
                                );
                                const inviteJson = await inviteRes.json();
                                if (inviteJson.ok) {
                                    inviteLink = inviteJson.result.invite_link;
                                    console.log(`Invite link created (unrestrict) for session ${sessionId}`);
                                } else {
                                    console.warn(`createChatInviteLink (unrestrict) failed: ${JSON.stringify(inviteJson)}`);
                                }
                            } catch(e) {
                                console.warn(`createChatInviteLink (unrestrict) error: ${e.message}`);
                            }
                        }

                        // Update verified record with invite link.
                        await stub.fetch('http://do/verified', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ verified: true, data: body, invite_link: inviteLink, timestamp: new Date().toISOString() })
                        });

                        // Edit the verify button message to show success (replaces the Verify Now button).
                        if (meta.message_id) {
                            const editText = meta.action_type === 'unrestrict'
                                ? '✅ *Identity verified — you can now send messages!*\n\nYou can close this chat.'
                                : '✅ *Identity verified — you\'ve been approved!*\n\nYou can now close this chat and join the group.';
                            await fetch(
                                `https://api.telegram.org/bot${env.BOT_TOKEN}/editMessageText`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: parseInt(user_id),
                                        message_id: parseInt(meta.message_id),
                                        text: editText,
                                        parse_mode: 'Markdown',
                                        reply_markup: { inline_keyboard: [] }
                                    })
                                }
                            );
                            console.log(`Cleaned up verify message ${meta.message_id} for user ${user_id}`);
                        }

                        // Delete the group fallback message (if user couldn't be DM'd initially).
                        if (meta.group_message_id) {
                            await fetch(
                                `https://api.telegram.org/bot${env.BOT_TOKEN}/deleteMessage`,
                                {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: parseInt(chat_id),
                                        message_id: parseInt(meta.group_message_id)
                                    })
                                }
                            ).catch(e => console.warn(`deleteMessage (group fallback) error: ${e.message}`));
                            console.log(`Deleted group fallback message ${meta.group_message_id} in chat ${chat_id}`);
                        }

                        // H2 — delete meta to prevent re-use, keep verified for frontend to poll
                        await stub.fetch('http://do/meta', { method: 'DELETE' });
                        console.log(`Session ${sessionId} ${meta.action_type === 'unrestrict' ? 'unrestricted' : 'approved'} and meta cleared`);
                    }
                }

                return json({ success: true }, 200, request);

            } catch(err) {
                console.error('POST /verified error:', err.message);
                return json({ error: 'Internal error' }, 500, request);
            }
        }

        // ── GET /check?session=SESSION_ID ─────────────────────────
        if (request.method === 'GET' && url.pathname === '/check') {
            const sessionId = url.searchParams.get('session');

            if (!sessionId || !isValidSessionId(sessionId)) {
                return json({ verified: false, error: 'Invalid session' }, 400, request);
            }

            if (await isRateLimited(env, `check_${sessionId}`, 200, 120)) {
                return json({ verified: false, error: 'Rate limited' }, 429, request);
            }

            try {
                const stub = getSession(env, sessionId);
                const res = await stub.fetch('http://do/check');
                const data = await res.json();

                const sid = sessionId.substring(0, 8);
                if (data.verified) {
                    console.log(`[check] ${sid}… verified=true ✅`);
                } else if (!data.has_meta) {
                    console.warn(`[check] ${sid}… verified=false meta=MISSING — session never registered or already expired`);
                } else {
                    console.log(`[check] ${sid}… verified=false meta=ok — waiting for ShareRing callback`);
                }

                return json({ verified: data.verified, data: data.data, invite_link: data.invite_link || null }, 200, request);
            } catch(err) {
                console.error(`[check] error for session ${sessionId.substring(0,8)}: ${err.message}`);
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
