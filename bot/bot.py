import logging, json, sqlite3
from telegram import (
    Update, InlineKeyboardButton, InlineKeyboardMarkup,
    WebAppInfo, LabeledPrice
)
from telegram.ext import (
    Application, CommandHandler, ChatJoinRequestHandler,
    MessageHandler, CallbackQueryHandler, filters,
    ContextTypes, PreCheckoutQueryHandler
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────
BOT_TOKEN    = "8437257336:AAG7okUlpQoa3QbVFCC5cf1gO5W9Rw2dDqc"
MINI_APP_URL = "https://foremancrypto.github.io/human-mini-app"

ENABLE_SETUP_FEE = False
SETUP_FEE_STARS  = 299

# App store links
IOS_URL     = "https://apps.apple.com/us/app/sharering-me/id6476899324"
ANDROID_URL = "https://play.google.com/store/apps/details?id=network.sharering.me"
ABOUT_URL   = "https://sharering.network"

# ── Welcome message (standardized for all channels) ───────────────
WELCOME_TEXT = (
    "👋 *Welcome!*\n\n"
    "This is a *private channel* — Proof of Human is required to enter.\n\n"
    "To verify your identity we use *ShareRing Me*, a biometric identity app. "
    "Your data stays on your device — nothing is stored by this bot.\n\n"
    "━━━━━━━━━━━━━━━\n"
    "📱 *Before you start:*\n"
    "1. Download the *ShareRing Me* app\n"
    "2. Set up your digital identity in the app\n"
    "3. Come back here and tap *Start Verification*\n"
    "━━━━━━━━━━━━━━━\n\n"
    "Tap a button below to get started 👇"
)

ABOUT_TEXT = (
    "ℹ️ *About ShareRing*\n\n"
    "ShareRing is a blockchain-based digital identity platform. "
    "It lets you prove who you are — without revealing your personal data.\n\n"
    "*How it works:*\n"
    "• Your ID documents are verified once and stored encrypted on your device\n"
    "• You share only what's needed — nothing more\n"
    "• Zero data is sent to or stored by this bot\n\n"
    "*Why Proof of Human?*\n"
    "To keep this community genuine and bot-free. "
    "Every member has passed biometric verification.\n\n"
    "[Learn more →](https://sharering.network)"
)

INSTRUCTIONS_TEXT = (
    "📋 *Before you scan the QR code:*\n\n"
    "1️⃣ Make sure you have the *ShareRing Me* app installed\n"
    "2️⃣ Open the app and complete your identity setup\n"
    "3️⃣ Have your phone ready to scan\n\n"
    "When you tap *Verify Now*, a QR code will appear. "
    "Open ShareRing Me, tap the scan icon, and scan it. "
    "Then approve the request in the app.\n\n"
    "The whole process takes about *30 seconds*. ✅"
)

# ── Database ──────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect("groups.db")
    conn.execute('''CREATE TABLE IF NOT EXISTS groups
                    (chat_id INTEGER PRIMARY KEY, activated INTEGER)''')
    conn.execute('''CREATE TABLE IF NOT EXISTS seen_users
                    (user_id INTEGER, chat_id INTEGER,
                     PRIMARY KEY (user_id, chat_id))''')
    conn.commit()
    conn.close()

def is_activated(chat_id):
    if not ENABLE_SETUP_FEE:
        return True
    conn = sqlite3.connect("groups.db")
    row  = conn.execute(
        "SELECT activated FROM groups WHERE chat_id=?", (chat_id,)
    ).fetchone()
    conn.close()
    return bool(row and row[0])

def activate_group(chat_id):
    conn = sqlite3.connect("groups.db")
    conn.execute("INSERT OR REPLACE INTO groups VALUES (?,1)", (chat_id,))
    conn.commit()
    conn.close()

def has_seen_welcome(user_id, chat_id):
    """Returns True if this user has already received the welcome flow for this chat."""
    conn = sqlite3.connect("groups.db")
    row  = conn.execute(
        "SELECT 1 FROM seen_users WHERE user_id=? AND chat_id=?",
        (user_id, chat_id)
    ).fetchone()
    conn.close()
    return bool(row)

def mark_seen(user_id, chat_id):
    conn = sqlite3.connect("groups.db")
    conn.execute(
        "INSERT OR IGNORE INTO seen_users VALUES (?,?)", (user_id, chat_id)
    )
    conn.commit()
    conn.close()

# ── Keyboards ─────────────────────────────────────────────────────
def welcome_keyboard(chat_id):
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("ℹ️ About Us",        callback_data=f"about|{chat_id}"),
            InlineKeyboardButton("📱 Download App",    callback_data=f"download|{chat_id}"),
        ],
        [
            InlineKeyboardButton(
                "✅ Start Verification →",
                callback_data=f"instructions|{chat_id}"
            )
        ]
    ])

def download_keyboard():
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton("🍎 App Store (iOS)",      url=IOS_URL),
            InlineKeyboardButton("🤖 Play Store (Android)", url=ANDROID_URL),
        ],
        [InlineKeyboardButton("← Back", callback_data="back_to_welcome")]
    ])

def instructions_keyboard(chat_id):
    return InlineKeyboardMarkup([
        [
            InlineKeyboardButton(
                "🔍 Verify Now",
                web_app=WebAppInfo(
                    url=f"{MINI_APP_URL}/?chat_id={chat_id}"
                )
            )
        ],
        [InlineKeyboardButton("← Back", callback_data="back_to_welcome")]
    ])

def about_keyboard():
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🌐 sharering.network", url=ABOUT_URL)],
        [InlineKeyboardButton("← Back",              callback_data="back_to_welcome")]
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

    if not is_activated(chat_id):
        await context.bot.send_message(
            chat_id=chat_id,
            text="👋 Human gating not activated yet.\nAdmins: run /setup to enable it."
        )
        return

    # First interaction only — send full welcome flow
    if not has_seen_welcome(user_id, chat_id):
        mark_seen(user_id, chat_id)
        await context.bot.send_message(
            chat_id=user_id,
            text=WELCOME_TEXT,
            parse_mode="Markdown",
            reply_markup=welcome_keyboard(chat_id)
        )
    else:
        # Returning user — skip straight to verification
        await context.bot.send_message(
            chat_id=user_id,
            text="👋 Welcome back! Tap below to verify.",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "✅ Verify Now →",
                    web_app=WebAppInfo(url=f"{MINI_APP_URL}/?chat_id={chat_id}")
                )
            ]])
        )

async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data  = query.data

    if data.startswith("about|"):
        await query.edit_message_text(
            ABOUT_TEXT,
            parse_mode="Markdown",
            reply_markup=about_keyboard()
        )

    elif data.startswith("download|"):
        await query.edit_message_text(
            "📱 *Download ShareRing Me*\n\n"
            "Choose your platform below. Once installed, set up your "
            "digital identity — then come back and tap *Start Verification*.",
            parse_mode="Markdown",
            reply_markup=download_keyboard()
        )

    elif data.startswith("instructions|"):
        chat_id = data.split("|")[1]
        await query.edit_message_text(
            INSTRUCTIONS_TEXT,
            parse_mode="Markdown",
            reply_markup=instructions_keyboard(chat_id)
        )

    elif data == "back_to_welcome":
        # Extract chat_id from the current keyboard if possible
        # Fall back to a generic back message
        await query.edit_message_text(
            WELCOME_TEXT,
            parse_mode="Markdown",
            reply_markup=welcome_keyboard(
                context.user_data.get("chat_id", 0)
            )
        )

async def on_web_app_data(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        payload = json.loads(update.effective_message.web_app_data.data)
        logger.info(f"WebApp data received: {payload}")

        if payload.get("action") == "human_verified":
            user_id = update.effective_user.id
            chat_id = int(payload.get("chat_id"))
            profile = payload.get("profile", "")

            if is_activated(chat_id):
                await context.bot.approve_chat_join_request(
                    chat_id=chat_id, user_id=user_id
                )
                msg = "✅ *Human verified. Welcome!*"
                if profile:
                    msg += f"\n\nVerified profile: `{profile}`"
                await update.effective_message.reply_text(
                    msg, parse_mode="Markdown"
                )
                logger.info(
                    f"Approved user {user_id} for chat {chat_id} "
                    f"(profile: {profile})"
                )
            else:
                await update.effective_message.reply_text(
                    "⚠️ This group hasn't been activated yet. Ask an admin to run /setup."
                )
    except Exception as e:
        logger.error(f"on_web_app_data error: {e}")

# ── Main ──────────────────────────────────────────────────────────
def main():
    init_db()
    app = Application.builder().token(BOT_TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler(
        "setup", setup_command,
        filters.ChatType.GROUP | filters.ChatType.SUPERGROUP
    ))
    app.add_handler(ChatJoinRequestHandler(on_join_request))
    app.add_handler(CallbackQueryHandler(on_callback))
    app.add_handler(MessageHandler(
        filters.StatusUpdate.WEB_APP_DATA, on_web_app_data
    ))
    app.add_handler(PreCheckoutQueryHandler(precheckout_callback))
    app.add_handler(MessageHandler(
        filters.SUCCESSFUL_PAYMENT, successful_payment_callback
    ))

    logger.info("Proof of Human Bot started")
    app.run_polling(allowed_updates=Update.ALL_TYPES)

if __name__ == "__main__":
    main()