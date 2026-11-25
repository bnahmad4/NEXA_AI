# NEXA AI — Production Telegram AI Assistant

**NEXA AI** is a real, production-ready Telegram AI chatbot powered by the **Telegram Bot API (`telegraf`)**, **Google Gemini (`@google/genai`)**, and **PostgreSQL (`drizzle-orm`)** with private, per-user persistent conversation memory.

---

## 1. System Architecture

```
Telegram User (Mobile / Desktop / Web)
          │
          ▼
  Telegram Bot API
   ├── Development: Long Polling (auto-started via src/instrumentation.ts)
   └── Production:  HTTPS Webhook (POST /api/telegram/webhook)
                    + X-Telegram-Bot-Api-Secret-Token verification
          │
          ▼
   NEXA AI Engine
   ├── Update Deduplication (processed_updates table)
   ├── Input Sanitization & Validation
   ├── Per-User Sliding-Window Rate Limiter
   ├── Typing Indicator Heartbeat (sendChatAction)
   ├── Context-Window Memory Manager (PostgreSQL)
   ├── Google Gemini SDK (@google/genai + retry & fallback models)
   └── Telegram-Safe HTML Formatter & 4096-Char Chunker
          │
          ▼
     PostgreSQL
   ├── telegram_users
   ├── user_preferences
   ├── conversations (strictly isolated by user_id)
   ├── messages
   └── processed_updates
```

### Project Folder Structure

```
nexa-ai/
├── public/assets/
│   └── nexa-ai-avatar.png             # Official 1024×1024 NEXA AI neon brand artwork
├── src/
│   ├── ai/
│   │   ├── conversation.ts            # Context-window budgeting & turn normalization
│   │   ├── gemini.ts                  # Official @google/genai client + retries/fallbacks
│   │   └── prompts.ts                 # NEXA AI identity, prompts, Phase 2/3 interfaces
│   ├── app/
│   │   ├── api/
│   │   │   ├── health/route.ts        # Health check endpoint (DB + Bot runtime)
│   │   │   ├── telegram/webhook/      # Secured production webhook handler
│   │   │   └── bot/{status,control,probe}/ # Operations & live verification APIs
│   │   ├── layout.tsx
│   │   └── page.tsx                   # Operations & Setup Console
│   ├── components/
│   │   └── NexaConsole.tsx            # Live status, BotFather kit & real API probe
│   ├── config/
│   │   └── env.ts                     # Zod-validated environment configuration
│   ├── db/
│   │   ├── index.ts                   # PostgreSQL pool & Drizzle client
│   │   └── schema.ts                  # Relational schema (users, prefs, convs, messages)
│   ├── middleware/
│   │   ├── error-handler.ts           # Error classification, secret-safe messages & webhook auth
│   │   └── rate-limit.ts              # Per-user burst & sliding-window rate limiter
│   ├── services/
│   │   ├── conversation.service.ts    # User-isolated conversation lifecycle & reset
│   │   ├── message.service.ts         # Persistent memory & atomic update deduplication
│   │   └── user.service.ts            # Telegram user upsert, preferences & privacy delete
│   ├── telegram/
│   │   ├── bot.ts                     # Telegraf singleton, polling & webhook manager
│   │   ├── commands.ts                # /start, /help, /reset, /about, /status & API profile sync
│   │   ├── format.ts                  # Markdown -> Telegram HTML & safe long-message chunking
│   │   ├── handlers.ts                # Incoming text pipeline, inline callbacks, Phase 2 notice
│   │   └── keyboards.ts               # Official NEXA AI inline keyboards
│   ├── utils/
│   │   └── logger.ts                  # Secret-redacting structured JSON logger
│   ├── instrumentation.ts             # Next.js runtime hook for automatic polling startup
│   └── server.ts                      # Standalone Express.js + Telegraf server entrypoint
├── tests/
│   ├── unit.security-and-formatting.test.ts
│   ├── integration.db-and-bot.test.ts
│   └── live.external-apis.test.ts
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
└── vitest.config.ts
```

---

## 2. Branding & BotFather Configuration

Telegram allows some profile settings to be automated via the Bot API, while others **must** be set in `@BotFather`.

### Automatically Configured by NEXA AI Backend (`syncTelegramBotProfile`)
Calling **Sync Bot API Profile** in the console (or on server startup) automatically configures:
- **Display Name** (`setMyName`): `NEXA AI`
- **About / Short Bio** (`setMyShortDescription`): `Ask me anything.`
- **Description ("What can this bot do?")** (`setMyDescription`): `Your intelligent AI assistant. Ask questions, explore ideas, solve problems, learn new things and get assistance whenever you need it.`
- **Bot Commands** (`setMyCommands`): `/start`, `/help`, `/reset`, `/about`, `/status`
- **Chat Menu Button** (`setChatMenuButton`): Commands menu

### Must Be Configured Manually in `@BotFather`
1. Open [@BotFather](https://t.me/BotFather) on Telegram.
2. **Create or select your bot**:
   - Run `/newbot` (for a new bot) or `/mybots` (for an existing bot).
   - Set display name to `NEXA AI` and choose a username ending in `bot` (e.g., `NexaGenius_Bot`).
3. **Upload the Official 1024×1024 NEXA AI Brand Artwork** (cannot be set via Bot API):
   - Send `/setuserpic` to `@BotFather`.
   - Select your NEXA AI bot.
   - Upload `public/assets/nexa-ai-avatar.png` (also downloadable from the Operations Console).
4. **Verify Optional BotFather Settings**:
   - `/setname` -> `NEXA AI`
   - `/setabouttext` -> `Ask me anything.`
   - `/setdescription` -> `Your intelligent AI assistant. Ask questions, explore ideas, solve problems, learn new things and get assistance whenever you need it.`

---

## 3. Environment Variables & Obtaining Credentials

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | How to Obtain / Description |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Open [@BotFather](https://t.me/BotFather) on Telegram -> `/newbot` (or `/mybots` -> API Token). |
| `GEMINI_API_KEY` | Visit [Google AI Studio](https://aistudio.google.com/apikey) -> **Create API Key**. |
| `GEMINI_MODEL` | Active Gemini model name (default: `gemini-3.5-flash-lite`). |
| `GEMINI_FALLBACK_MODELS` | Comma-separated fallback models used automatically during transient 503/429 load spikes. |
| `DATABASE_URL` | PostgreSQL connection URL, e.g. `postgresql://postgres:postgres@127.0.0.1:5432/app_db`. |
| `TELEGRAM_MODE` | `polling` for local development, `webhook` for production HTTPS hosting. |
| `WEBHOOK_URL` | Your public HTTPS base URL in production (e.g. `https://nexa-ai.onrender.com`). |
| `WEBHOOK_SECRET` | Random secret sent in `X-Telegram-Bot-Api-Secret-Token` (`openssl rand -hex 32`). |
| `ADMIN_API_KEY` | Optional header secret (`x-admin-api-key`) protecting `/api/bot/control` in production. |

---

## 4. Local Development Setup

```bash
# 1. Install dependencies
npm install

# 2. Push PostgreSQL schema via Drizzle Kit
npx drizzle-kit push

# 3. Run automated test suite (unit + PostgreSQL integration + live API checks)
npx vitest run

# 4. Start development server (auto-starts Telegram long-polling when TELEGRAM_MODE=polling)
npm run dev
```

Open Telegram, search for your bot (e.g. `@NexaGenius_Bot`), tap **Start**, and send any message!

---

## 5. Production Deployment (Docker, Render, Railway)

### Option A: Docker Compose (App + PostgreSQL)

```bash
# Ensure .env is configured with TELEGRAM_MODE=webhook, WEBHOOK_URL, and WEBHOOK_SECRET
docker compose up -d --build
```

### Option B: Render or Railway

1. Create a managed **PostgreSQL** database on Render or Railway and copy its `DATABASE_URL`.
2. Create a Web Service connected to this repository:
   - **Build Command**: `npm ci && npx drizzle-kit push && npm run build`
   - **Start Command**: `npm run start` (Next.js fullstack + webhook) or `npx tsx src/server.ts` (standalone Express server)
   - **Health Check Path**: `/api/health` (or `/health` for standalone Express)
3. Set all production environment variables (`TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, `GEMINI_MODEL`, `DATABASE_URL`, `TELEGRAM_MODE=webhook`, `WEBHOOK_URL=https://your-service.onrender.com`, `WEBHOOK_SECRET`, `ADMIN_API_KEY`).
4. Register the webhook with Telegram (via the Operations Console **Set Webhook** button or `curl`):

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-service.onrender.com/api/telegram/webhook",
    "secret_token": "'"${WEBHOOK_SECRET}"'",
    "allowed_updates": ["message", "callback_query"]
  }'
```

---

## 6. Roadmap & Phases

- **Phase 1 (Implemented & Verified)**: Core conversational AI, Google Gemini integration, persistent PostgreSQL memory, user isolation, Telegram commands (`/start`, `/help`, `/reset`, `/about`, `/status`), inline keyboards, typing indicators, long-message chunking, rate limiting, duplicate-update protection, and webhook security.
- **Phase 2 (Architected)**: Multimodal image understanding, PDF/document analysis, and voice transcription (`MultimodalAttachment` interface & media handler hooks prepared).
- **Phase 3 (Architected)**: Web search, AI research, and tool/function calling (`AgentToolDefinition` registry prepared).

---

## 7. Troubleshooting

- **`409 Conflict: terminated by other getUpdates request`**: Two instances are polling with the same bot token, or a webhook is still registered. Stop the extra process or call `deleteWebhook` before polling.
- **`401 Unauthorized` on `/api/telegram/webhook`**: Ensure the `secret_token` registered with Telegram `setWebhook` matches `WEBHOOK_SECRET` in your environment.
- **Gemini `503 UNAVAILABLE` high-demand spikes**: NEXA AI automatically retries and fails over to `GEMINI_FALLBACK_MODELS`. You can customize both `GEMINI_MODEL` and `GEMINI_FALLBACK_MODELS` without code changes.


### NEXA AI Brand Assets

- `public/assets/nexa-ai-avatar.png` is the supplied full NEXA AI neon artwork used in the site and Telegram profile preview.
- `public/assets/nexa-ai-mark.png` is a simplified crop of the neon X used for browser and Apple icons.
