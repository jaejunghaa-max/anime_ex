# Anime Exchange Bot 🎁

A Discord bot that runs an **Anime Exchange**: every participant submits one anime
recommendation, receives another participant's pick at random, watches the full
season, and writes a review in a Google Doc by a deadline. Assignments form
circular loops — one big loop over everyone by default, or several smaller
loops if the manager splits participants into **groups**. The recommender's
identity stays secret until the reveal.

Implements **[Specification v2, rev. 3](.)** — one event per guild, all state in
Cloudflare **D1**, all Google artifacts in the **manager's own Drive** (OAuth,
`drive.file` scope only), designed to fit the **Workers Free plan** budget.

## Architecture

- **One Worker**, HTTP-only Discord app (Interactions Endpoint). No gateway.
  - `POST /interactions` — Ed25519-verified via **native WebCrypto** (never pure JS)
  - `GET /google/oauth/start` + `/google/oauth/callback` — manager OAuth
- **D1** for all state; a **single minute cron** drives everything else.
- Every participant-scaling fan-out (launch, close, status sync, reminders,
  finish) is a **batched job**: at most `JOB_BATCH` units per cron tick, with
  per-unit completion markers — a redeploy mid-launch loses nothing, and each
  invocation stays inside the free plan's 10 ms CPU / 50 subrequest budget.
- Raw `fetch` REST everywhere (Discord v10, Drive v3, Sheets v4, Docs v1,
  Jikan v4, AniList GraphQL). **Zero runtime dependencies.**

```
src/
  index.ts      entry: /interactions + OAuth routes + cron
  cron.ts       minute dispatcher: reminders → jobs; banner/auto-stop; hourly sync
  jobs.ts       batched launch / close / sync / finish engine
  handlers/     router, /setup, manager panel, signup wizard
  panels.ts     pure render(state) → panel payloads for both pinned panels
  validate.ts   sheet↔D1 reconciliation; row order + Group column = the loops
  sheet.ts      sheet layout; derived Santa/Given block (never read as input)
  google.ts     OAuth token cache + Drive/Sheets/Docs REST
  mal.ts        Jikan search + EN/JP re-ranking + 24 h cache (+ AniList fallback)
  discord.ts    REST client + component/response builders
  util.ts       WebCrypto (Ed25519, AES-GCM), Intl-based tz conversion, loop math
```

## Deploy

Prereqs: Node 20+, a Cloudflare account, `npm install`.

### 1. Discord application

1. <https://discord.com/developers/applications> → **New Application**.
2. Copy **Application ID** and **Public Key** (General Information).
3. **Bot** tab → copy the **Token**. No privileged intents needed.

### 2. Cloudflare resources

```sh
npx wrangler d1 create anime-exchange     # put the database_id into wrangler.toml
```

Edit `wrangler.toml`: set `DISCORD_APP_ID`, `DISCORD_PUBLIC_KEY`, the D1
`database_id`, and `GOOGLE_REDIRECT_URI` (your workers.dev URL +
`/google/oauth/callback`).

```sh
npm run migrate                            # apply migrations/0001_init.sql remotely
wrangler secret put DISCORD_TOKEN
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32
npm run deploy
```

### 3. Google Cloud OAuth client

1. Google Cloud console → APIs & Services → enable **Drive API**, **Sheets API**,
   **Docs API**.
2. OAuth consent screen: External, add yourself as a test user (or publish).
3. Credentials → **OAuth client ID** → Web application → authorized redirect URI
   = exactly your `GOOGLE_REDIRECT_URI`.
4. That client's id/secret are the two secrets above.

### 4. Wire up Discord

1. `DISCORD_TOKEN=... DISCORD_APP_ID=... npm run register` — registers
   `/setup init` + `/setup repair` and prints the **invite URL** (Manage Roles,
   Manage Channels, Manage Threads, Create Private Threads, Send Messages
   (+ in Threads), Embed Links, Read Message History, Manage Messages).
2. In the app's **General Information**, set **Interactions Endpoint URL** to
   `https://<worker>/interactions` (Discord sends a PING — the deployed Worker
   must be live first).
3. Invite the bot, then run **`/setup init`** in the server (Administrator only).

`/setup init` creates the `Exchange Manager` role, the private
`#anime-exchange-manager` channel, the read-only `#anime-exchange` channel, and
pins one panel message in each. `/setup repair` re-creates anything missing.

## Running an event

Everything happens on the two pinned panels:

1. **Connect Google** (manager panel) → **New Event** → **Set Basics** → add up
   to 9 custom form items (fill-in or MCQ, each 👁 visible-to-recommender or 🔒
   hidden) → **Open Sign-Ups** (creates the spreadsheet in the manager's Drive).
2. Participants press **Sign Up**: modal (keyword + items 1–4) → MAL picker
   (English and Japanese queries both re-ranked across all title variants) →
   optional second modal (items 5–9) → confirm. Edit/withdraw any time while
   sign-ups are open.
3. **Stop Sign-Ups** → arrange the loops → **Validate** → **Launch**.
   - **🧩 Grouping** splits everyone into G random loops of near-equal size
     (G ≤ ⌊n/2⌋; G = 1 is the classic single loop). Re-roll freely.
   - **🔀 Shuffle** re-draws the order *within each group independently*,
     preserving membership — randomize assignments after hand-curating groups.
   - **Manual control = two sheet levers**: reorder rows (loop order) and edit
     the **Group** column (loop membership; blank = 1). Your santa is simply
     the next row *within your group's block*; the Santa/Given columns are
     always derived, never read.
   - **Validate** parses the Group column (positive integers, normalized to
     1..G by first appearance), blocks on any 1-member group
     (self-assignment), warns on 2-member groups (mutual pair — intentional
     gift-swap mode is fine), then re-sorts rows into contiguous group blocks
     and adopts order + membership into D1.
4. Launch runs as a batched job: per participant a review doc
   (`Review of {Anime} by {name}`, anyone-with-link **editor**), a private
   thread `🎁 {name}`, and an assignment card with the doc link plus a
   **⭐ Score it /10** button. The panel counts up (~n/`JOB_BATCH` minutes)
   and flips to RUNNING by itself.
5. During RUNNING: hourly wrote-detection (modifiedTime + char count vs the
   doc template — internal; the sheet shows a **Review Length** column),
   progress panel, scheduled reminders (thread ping, optional DM mirror),
   **Remind Now** for laggards. Participants can score their given anime out
   of 10 any time until Close (re-scoring allowed); scores land in the
   sheet's **Score** column and appear on reveal cards, the gallery and
   View Event.
6. **Close Reviews** (with or without a public gallery): final status sync, all
   docs flip to anyone-with-link **viewer** *before* any reveal link is posted,
   then reveal cards (+ optional gallery with one section per loop — single-loop
   events get one untitled section).
7. **Finish**: deletes threads and the bot's event data. **The sheet and docs
   stay in the manager's Drive** — nothing to export.

## Operational notes

- **Free-plan budget:** `JOB_BATCH=5` default (a launch unit ≈ 7 external
  subrequests; D1 ops may also count toward the 50/invocation cap). On the paid
  plan raise `JOB_BATCH`/`REMINDERS_PER_TICK` freely.
- **Restart-safe by construction:** panels re-render from D1; jobs re-enter on
  per-unit markers; duplicate enqueues are blocked by a partial unique index;
  every state transition is a conditional `UPDATE … WHERE state = ?`.
- **Stalls self-heal:** after 5 consecutive failing ticks the manager panel
  shows the job's last error (e.g. the Google reconnect prompt); the dispatcher
  retries every minute, so fixing the cause is sufficient.
- **Privacy caveat:** members with *Manage Threads* (admins/mods) can open
  private threads — assignments are hidden from ordinary members, not from
  moderators. Review-doc URLs are capabilities: they only ever appear inside
  the owner's private thread until Close flips docs read-only.
- **Left-server participants:** the row is kept and the loop stays intact; their
  doc still counts at the reveal.
- Refresh tokens are AES-GCM encrypted at rest (`TOKEN_ENC_KEY`); OAuth `state`
  is random with a 10-minute TTL; every manager action is role-checked
  server-side.

## Platform assumptions (spec §17, verified at implementation time)

| Assumption | Status |
|---|---|
| Ed25519 in Workers WebCrypto (`crypto.subtle` with `"Ed25519"`) | Supported; legacy `NODE-ED25519` fallback included |
| Select menus inside modals via the **Label** component (type 18) | GA since Sept 2025; all modals here use Label wrappers. If Discord ever rejects a modal, fall back to plan B in spec §5.2 (MCQs as ephemeral selects between modal steps) |
| Private threads without boosts; `Manage Threads` visibility caveat | Yes (documented above) |
| `drive.file` scope for Sheets/Docs/Drive calls on app-created files | Yes — creation + all follow-up calls are on app-created files; the connected email comes from `drive/v3/about` (no extra scope) |
| Free plan: 10 ms CPU, 50 subrequests, 1-min cron; D1 ops may count | Designed with headroom (`JOB_BATCH=5`); tune upward on paid |
| Jikan v4 availability (~3 req/s) | Descriptive `User-Agent` (api.jikan.moe's bot protection 403s UA-less Workers fetches), backed-off retries, 24 h D1 cache; AniList failover for native-script queries **and** whenever Jikan is unreachable (results still resolve to MAL ids) |

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest (tz conversion, re-ranking, loop math, layout)
npm run dev         # wrangler dev (local)
npm run migrate:local
```
