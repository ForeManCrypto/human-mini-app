import logging, json, sqlite3, os, hashlib, urllib.request
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    WebAppInfo, LabeledPrice, ChatMember, ChatPermissions
)
from telegram.ext import (
    Application, CommandHandler, ChatJoinRequestHandler, ChatMemberHandler,
    MessageHandler, CallbackQueryHandler, filters,
    ContextTypes, PreCheckoutQueryHandler
)

# ── Logging ───────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)
logging.getLogger("httpx").setLevel(logging.WARNING)

# ── Config ────────────────────────────────────────────────────────
BOT_TOKEN      = os.environ.get("BOT_TOKEN")
MINI_APP_URL   = os.environ.get("MINI_APP_URL", "https://foremancrypto.github.io/human-mini-app")
WEBHOOK_HOST   = os.environ.get("WEBHOOK_HOST", "human-mini-app-production.up.railway.app")
PORT           = int(os.environ.get("PORT", 8080))
WORKER_URL     = os.environ.get("WORKER_URL", "https://human-bot-worker.moneyforeman.workers.dev")
WORKER_SECRET  = os.environ.get("WORKER_SECRET", "")

# C4 — deterministic webhook secret derived from BOT_TOKEN
WEBHOOK_SECRET = hashlib.sha256(BOT_TOKEN.encode()).hexdigest()[:64] if BOT_TOKEN else ""

ENABLE_SETUP_FEE = False
SETUP_FEE_STARS  = 299

IOS_URL     = "https://apps.apple.com/us/app/sharering-me/id6476899324"
ANDROID_URL = "https://play.google.com/store/apps/details?id=network.sharering.me"
ABOUT_URL   = "https://sharering.network"

# ── Permissions ───────────────────────────────────────────────────
NO_SEND_PERMISSIONS = ChatPermissions(
    can_send_messages=False,
    can_send_audios=False,
    can_send_documents=False,
    can_send_photos=False,
    can_send_videos=False,
    can_send_video_notes=False,
    can_send_voice_notes=False,
    can_send_polls=False,
    can_send_other_messages=False,
)

# ── Messages ──────────────────────────────────────────────────────
WELCOME_TEXT = (
    "👋 *Welcome!*\n\n"
    "This is a *private channel* — entry requires Proof of Human verification.\n\n"
    "We use *ShareRing Me*, a biometric identity app. "
    "Your data stays on your device — nothing is stored by this bot.\n\n"
    "━━━━━━━━━━━━━━━\n"
    "📱 *Need the app?* Download ShareRing Me, then:\n"
    "• Complete your identity setup\n"
    "• Add your *Social Profile* to the vault _(Social Network → Telegram)_\n\n"
    "Once ready, tap *Verify Now* below. "
    "Scan the QR code in the app and tap *Approve*. Takes about 30 seconds. ✅\n"
    "━━━━━━━━━━━━━━━"
)

RESTRICTED_TEXT = (
    "👋 *Welcome to the group!*\n\n"
    "To participate, you need to complete a quick *Proof of Human* verification.\n\n"
    "We use *ShareRing Me*, a biometric identity app. "
    "Your data stays on your device — nothing is stored by this bot.\n\n"
    "━━━━━━━━━━━━━━━\n"
    "📱 *Need the app?* Download ShareRing Me, then:\n"
    "• Complete your identity setup\n"
    "• Add your *Social Profile* to the vault _(Social Network → Telegram)_\n\n"
    "Once ready, tap *Verify Now* below. "
    "Scan the QR code in the app and tap *Approve*. Takes about 30 seconds. ✅\n"
    "━━━━━━━━━━━━━━━"
)

# ── Database (M2 — module-level connection with WAL mode) ─────────
_db = sqlite3.connect("groups.db", check_same_thread=False)
_db.execute("PRAGMA journal_mode=WAL")
_db.execute("PRAGMA busy_timeout=5000")
_db.execute('''CREATE TABLE IF NOT EXISTS groups
               (chat_id INTEGER PRIMARY KEY, activated INTEGER)''')
_db.commit()

def is_activated(chat_id):
    if not ENABLE_SETUP_FEE:
        return True
    row = _db.execute(
        "SELECT activated FROM groups WHERE chat_id=?", (chat_id,)
    ).fetchone()
    return bool(row and row[0])

def activate_group(chat_id):
    _db.execute("INSERT OR REPLACE INTO groups VALUES (?,1)", (chat_id,))
    _db.commit()

# ── Worker session registration (C2 fix) ─────────────────────────
def register_session(session_id: str, user_id: int, chat_id: int):
    """
    Called server-side by the bot after a join request.
    Pre-registers the pending session so the Worker knows which
    user/chat to approve when ShareRing POSTs to /verified.
    NOTE: session_id is not known yet at this point — the ShareRing
    SDK generates it client-side. We store user_id/chat_id keyed by
    a bot-generated token, and the mini app exchanges it on load.
    For now we pass user_id and chat_id via the URL (existing approach)
    and keep this function for future server-side session generation.
    """
    if not WORKER_SECRET or not WORKER_URL:
        logger.warning("WORKER_SECRET or WORKER_URL not set — skipping session pre-registration")
        return

    try:
        data = json.dumps({
            "session_id": session_id,
            "user_id": str(user_id),
            "chat_id": str(chat_id)
        }).encode()
        req = urllib.request.Request(
            f"{WORKER_URL}/session",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {WORKER_SECRET}"
            },
            method="POST"
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            logger.info(f"Session pre-registered: status={resp.status}")
    except Exception as e:
        logger.warning(f"Session pre-registration failed: {e}")

def mini_app_url(chat_id, user_id, message_id=None, action_type=None):
    url = f"{MINI_APP_URL}/?chat_id={chat_id}&user_id={user_id}"
    if message_id:
        url += f"&message_id={message_id}"
    if action_type:
        url += f"&action_type={action_type}"
    return url

# ── Keyboard ──────────────────────────────────────────────────────
def main_keyboard(chat_id, user_id, message_id=None, action_type=None):
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🍎 App Store",  url=IOS_URL),
            InlineKeyboardButton("🤖 Play Store", url=ANDROID_URL),
        ],
        [InlineKeyboardButton("🌐 About ShareRing", url=ABOUT_URL)],
        [
            InlineKeyboardButton(
                "✅ Verify Now →",
                web_app=WebAppInfo(url=mini_app_url(chat_id, user_id, message_id, action_type))
            )
        ]
    ])

# ── Handlers ──────────────────────────────────────────────────────
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        "👋 Add me as admin to your group and enable *Join Request Approval* "
        "to start human gating.\n\nMembers will receive a guided verification "
        "flow before being approved.",
        parse_mode="Markdown"
    )

async def setup_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not ENABLE_SETUP_FEE:
        await update.message.reply_text("Setup fee is disabled for now.")
        return
    chat   = update.effective_chat
    user   = update.effective_user
    member = await context.bot.get_chat_member(chat.id, user.id)
    if member.status not in ["administrator", "creator"]:
        await update.message.reply_text("Only admins can run /setup.")
        return
    if is_activated(chat.id):
        await update.message.reply_text("✅ This group is already activated!")
        return
    prices = [LabeledPrice("One-time Human Bot Activation", SETUP_FEE_STARS)]
    await context.bot.send_invoice(
        chat_id=chat.id,
        title="Proof of Human Bot – One-time Setup",
        description=f"Activate human gating forever ({SETUP_FEE_STARS} Stars). Zero data stored.",
        payload="human_bot_setup",
        provider_token="",
        currency="XTR",
        prices=prices
    )

async def precheckout_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.pre_checkout_query
    await query.answer(ok=query.invoice_payload == "human_bot_setup")

async def successful_payment_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    payment = update.message.successful_payment
    if payment.invoice_payload == "human_bot_setup":
        activate_group(update.message.chat.id)
        await update.message.reply_text(
            f"✅ Paid {payment.total_amount} Stars! Human gating is now active."
        )

async def on_join_request(update: Update, context: ContextTypes.DEFAULT_TYPE):
    req     = update.chat_join_request
    chat_id = req.chat.id
    user_id = req.from_user.id

    logger.info(f"JOIN REQUEST from user {user_id} for chat {chat_id}")

    if not is_activated(chat_id):
        await context.bot.send_message(
            chat_id=chat_id,
            text="👋 Human gating not activated yet.\nAdmins: run /setup to enable it."
        )
        return

    # Send single-screen welcome, then edit to inject message_id into the WebApp URL
    # so the worker can clean up this message after verification.
    sent = await context.bot.send_message(
        chat_id=user_id,
        text=WELCOME_TEXT,
        parse_mode="Markdown",
        reply_markup=main_keyboard(chat_id, user_id)
    )
    await context.bot.edit_message_reply_markup(
        chat_id=user_id,
        message_id=sent.message_id,
        reply_markup=main_keyboard(chat_id, user_id, sent.message_id)
    )

async def on_new_member(update: Update, context: ContextTypes.DEFAULT_TYPE):
    member_update = update.chat_member
    if not member_update:
        return

    old_status = member_update.old_chat_member.status
    new_status = member_update.new_chat_member.status

    # Only handle fresh joins into "member" status
    if new_status != ChatMember.MEMBER:
        return
    # Skip re-joins from existing/restricted states (avoids loop when we lift restrictions)
    if old_status in (ChatMember.MEMBER, ChatMember.ADMINISTRATOR, ChatMember.OWNER, ChatMember.RESTRICTED):
        return

    user    = member_update.new_chat_member.user
    chat_id = member_update.chat.id

    if user.is_bot:
        return
    if not is_activated(chat_id):
        return

    logger.info(f"NEW MEMBER user {user.id} joined chat {chat_id} — restricting pending verification")

    try:
        await context.bot.restrict_chat_member(
            chat_id=chat_id,
            user_id=user.id,
            permissions=NO_SEND_PERMISSIONS,
        )
    except Exception as e:
        logger.warning(f"Could not restrict user {user.id} in {chat_id}: {e}")
        return  # Bot lacks admin rights — skip the DM too

    try:
        sent = await context.bot.send_message(
            chat_id=user.id,
            text=RESTRICTED_TEXT,
            parse_mode="Markdown",
            reply_markup=main_keyboard(chat_id, user.id, action_type="unrestrict"),
        )
        await context.bot.edit_message_reply_markup(
            chat_id=user.id,
            message_id=sent.message_id,
            reply_markup=main_keyboard(chat_id, user.id, sent.message_id, action_type="unrestrict"),
        )
    except Exception as e:
        logger.warning(f"Could not DM user {user.id}: {e}")


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    # No navigation callbacks in the current flow — just dismiss the spinner
    # for any lingering buttons from before this deploy.
    await update.callback_query.answer()

async def on_web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Fallback — Worker approves directly but this catches sendData as safety net."""
    try:
        payload = json.loads(update.effective_message.web_app_data.data)
        logger.info(f"WebApp data received action={payload.get('action')}")

        if payload.get("action") == "human_verified":
            user_id = update.effective_user.id
            chat_id = int(payload.get("chat_id", 0))
            profile = payload.get("profile", "")

            if chat_id and is_activated(chat_id):
                try:
                    await context.bot.approve_chat_join_request(
                        chat_id=chat_id, user_id=user_id
                    )
                    logger.info(f"Approved user {user_id} for chat {chat_id} via sendData fallback")
                except Exception as e:
                    logger.info(f"sendData fallback approve (may already be approved): {e}")

                msg = "✅ *Human verified. Welcome!*"
                if profile:
                    msg += f"\n\nVerified profile: `{profile}`"
                await update.effective_message.reply_text(msg, parse_mode="Markdown")
    except Exception as e:
        logger.error(f"on_web_app_data error: {e}")

# ── Main ──────────────────────────────────────────────────────────
def main():
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler(
        "setup", setup_command,
        filters.ChatType.GROUP | filters.ChatType.SUPERGROUP
    ))
    app.add_handler(ChatJoinRequestHandler(on_join_request))
    app.add_handler(ChatMemberHandler(on_new_member, ChatMemberHandler.CHAT_MEMBER))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(
        filters.StatusUpdate.WEB_APP_DATA, on_web_app_data
    ))
    app.add_handler(PreCheckoutQueryHandler(precheckout_callback))
    app.add_handler(MessageHandler(
        filters.SUCCESSFUL_PAYMENT, successful_payment_callback
    ))

    domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN", WEBHOOK_HOST)
    logger.info(f"Starting webhook on {domain}")

    # C4 — webhook secret to prevent fake Telegram update injection
    # allowed_updates must include chat_member explicitly — Telegram omits it by default.
    app.run_webhook(
        listen="0.0.0.0",
        port=PORT,
        url_path="/webhook",
        webhook_url=f"https://{domain}/webhook",
        secret_token=WEBHOOK_SECRET,
        allowed_updates=[
            "message", "callback_query", "chat_join_request",
            "chat_member", "pre_checkout_query",
        ],
    )

if __name__ == "__main__":
    main()