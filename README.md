# Anime Exchange Bot 🎁

A Discord bot that runs an **Anime Exchange**: every participant signs up with a
link to their **MAL/AniList**, gets secretly matched to another participant, and
**recommends an anime tailored to them** — while their own Secret Santa picks one
for *them*. A pick can be sent back ("Sorry😞") up to a manager-set number of
times; once every pick is locked in ("Thank you!😊"), the exchange launches:
everyone watches their full season and writes a review in a Google Doc by a
deadline. Matches form circular loops — one big loop over everyone by default,
or several smaller loops if the manager splits participants into **groups**.
The Santa's identity stays secret until the reveal.

**[MANUAL.md](MANUAL.md) is the day-to-day user guide** (managers &
participants); this README covers architecture and deployment.

Implements **Specification v3** (the *match → recommend → launch* rework of
v2 rev. 3) — one event per guild, all state in Cloudflare **D1**, all Google
artifacts in the **manager's own Drive** (OAuth, `drive.file` scope only),
designed to fit the **Workers Free plan** budget.

## The v3 flow (what changed from v2)

v2 collected an anime pick *at signup* and matching simply routed those picks.
v3 flips the direction — you pick **for the person you're matched with**, after
seeing who they are:

```
SIGNUP_OPEN ─→ MATCHING ─→ PREPARING ─→ RECOMMENDING ─→ LAUNCHING ─→ RUNNING ─→ CLOSING ─→ REVEALED
              (unchanged)  (threads +   (Santas pick;   (unchanged from here on)
                            missions)    giftees approve
                                         or decline ×N)
```

- **Signup**: no anime search anymore. The form's built-in item is
  **"Link of your MAL/AniList"** (validated; `myanimelist.net` / `anilist.co`,
  with a red **⚠ Proceed anyway** escape hatch for lists hosted elsewhere),
  plus up to 9 custom items.
- **Matching** (unchanged tools): 🧩 Grouping, 🔀 Shuffle, manual row-reorder +
  Group column in the sheet, ✅ Validate. Instead of Launch, the manager presses
  **🎯 Start Recommending** — assignments lock.
- **Preparing** (new batched job): each participant's private thread is created
  *now*, with a task card: who they're the Secret Santa of, that person's
  list link + 👁-visible answers, and a **🎯 Recommend an anime** button.
- **Recommending** (new): the Santa picks via the MAL search wizard (EN/JP
  re-ranking, same engine as v2's signup search). The giftee's thread gets the
  pick with **[Thank you!😊]** / **[Sorry😞]**. Accepting is reversible — a red
  **[I changed my mind to decline it😞]** stays on the card until Launch.
  Declining (before or after accepting) spends the per-person budget (**0–9,
  set in Set Basics at drafting**); a declined title can't be re-picked, a
  spent budget just removes the decline buttons — nothing locks mid-phase —
  and the Santa never sees the remaining count. Manager tools: 🔄 Refresh,
  📣 Remind Now, ↩ Back to Matching (wipes picks, keeps threads); the per-pair
  detail lives in the sheet, linked in every panel body.
- **Launch onward**: identical to v2, except Launch refuses only while a Santa
  hasn't sent a pick, locks any still-pending picks itself (after a bold
  **‼️The pending picks will be locked** warning), creates review docs for the
  final picks, posts the assignment card into the already-existing thread, and
  the reveal/gallery show who picked for whom. Closing always posts the
  gallery.

## Architecture

- **One Worker**, HTTP-only Discord app (Interactions Endpoint). No gateway.
  - `POST /interactions` — Ed25519-verified via **native WebCrypto** (never pure JS)
  - `GET /google/oauth/start` + `/google/oauth/callback` — manager OAuth
- **D1** for all state; a **single minute cron** drives everything else.
- Every participant-scaling fan-out (prepare, launch, close, status sync,
  reminders, finish) is a **batched job**: at most `JOB_BATCH` units per cron
  tick, with per-unit completion markers — a redeploy mid-job loses nothing, and
  each invocation stays inside the free plan's 10 ms CPU / 50 subrequest budget.
  Recommend/approve/decline are single-user interactions (a couple of Discord
  posts + one sheet write), so they run inline in `waitUntil`.
- Raw `fetch` REST everywhere (Discord v10, Drive v3, Sheets v4, Docs v1,
  Jikan v4, official MAL API v2). **Zero runtime dependencies.**

```
src/
  index.ts      entry: /interactions + OAuth routes + cron
  cron.ts       minute dispatcher: reminders → jobs; banner/auto-stop; periodic sync
  jobs.ts       batched prepare / launch / close / sync / finish engine
  cards.ts      thread-card builders (Santa mission, pick, assignment, reveal)
  handlers/     router, /setup, manager panel, signup wizard, recommending phase
  panels.ts     pure render(state) → panel payloads for both pinned panels
  validate.ts   sheet↔D1 reconciliation; row order + Group column = the loops
  sheet.ts      sheet layout; derived Santa + Recommendation block (never read as input)
  google.ts     OAuth token cache + Drive/Sheets/Docs REST
  mal.ts        official MAL / Jikan search + EN/JP re-ranking + 24 h cache
  discord.ts    REST client + component/response builders
  util.ts       WebCrypto (Ed25519, AES-GCM), Intl-based tz conversion, loop math, list-URL validation
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
npm run migrate                            # apply migrations remotely
wrangler secret put DISCORD_TOKEN
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put TOKEN_ENC_KEY          # openssl rand -base64 32
npm run deploy
```

> **Upgrading a v2 deployment:** migration `0004_recommend.sql` rebuilds the
> `events`/`signups`/`jobs` tables for the new flow. Rows survive, but v2
> signup-time anime picks are dropped (v3 has no such pick) — **finish or
> 🛑 Abort any in-flight event before running `npm run migrate`**, then deploy.
> `0005` is additive (username column + normalizing pre-3.1 lock states).

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
   (+ in Threads), Embed Links, Read Message History, Manage Messages,
   Mention Everyone — the Open-Sign-Ups @everyone ping). On an install that
   predates the Mention Everyone permission, re-invite with the new URL (or
   grant the bot's role "Mention @everyone") so the ping actually notifies.
2. In the app's **General Information**, set **Interactions Endpoint URL** to
   `https://<worker>/interactions` (Discord sends a PING — the deployed Worker
   must be live first).
3. Invite the bot, then run **`/setup init`** in the server (Administrator only).

`/setup init` creates the `Exchange Manager` role, the private
`#anime-exchange-manager` channel, the read-only `#anime-exchange` channel, and
pins one panel message in each. `/setup repair` re-creates anything missing.

## Running an event

Everything happens on the two pinned panels:

1. **Connect Google** (manager panel) → **New Event** → **Set Basics**
   (**Session** name, optional **Theme** — shown to participants everywhere,
   sign-up deadline, timezone, and the **Sorry😞 budget** — how many times
   each person may decline a pick, 0–9; auto-stop is a ⏰ toggle button on
   the panel) → add up to 9 custom form items (fill-in or MCQ, optional
   description shown under the question, each 👁 visible-to-recommender or 🔒
   hidden) → **Open Sign-Ups** (creates the spreadsheet in the manager's
   Drive and pings **@everyone** in the participant channel).
2. Participants press **Sign Up/Edit** (one button for both): the built-in
   **MAL/AniList link** field + items 1–4, an optional second modal for items
   5–9, then a summary card to confirm. Re-press to edit, or withdraw, any
   time while sign-ups are open.
3. **Stop Sign-Ups** → arrange the loops → **Validate** → **🎯 Start
   Recommending**. The matching tools are unchanged from v2:
   - **🧩 Grouping** (step 1) splits everyone into G random loops of
     near-equal size (G ≤ ⌊n/2⌋; G = 1 is the classic single loop). Re-roll
     freely.
   - **🔀 Shuffle** (step 2) re-draws the order *within each group
     independently*, preserving membership.
   - **Manual control = two sheet levers**: reorder rows (loop order) and edit
     the **Group** column (loop membership; blank = 1). Each row's Secret Santa
     is simply the next row *within its group's block* — that person picks FOR
     this row.
   - **Validate** parses the Group column (positive integers, normalized to
     1..G by first appearance), blocks on any 1-member group
     (self-assignment), warns on 2-member groups (mutual pair — fine if
     intended), then re-sorts rows into contiguous group blocks and adopts
     order + membership into D1.
   - **🎯 Start Recommending** asks for the **recommendation deadline**
     (modal), validates once more, **locks the assignment**, and runs the
     batched prepare job: one private thread + Santa mission card per
     participant (~`JOB_BATCH`/min). The deadline is display-only (panels,
     cards, nudges, plus a "passed" banner) — consistent with the rest of the
     bot, it never transitions state by itself.
4. **RECOMMENDING**: Santas pick via the MAL wizard; giftees accept
   (**Thank you!😊** — reversible via the red **I changed my mind to decline
   it😞** until Launch) or decline (**Sorry😞**, at most the drafted budget;
   declined titles can't be re-picked; a spent budget removes the decline
   buttons). The sheet's **Recommendation / Rec. Status** columns update live;
   the panel shows `accepted / pending / waiting` counts, refreshable on the
   spot with **🔄 Refresh**. Manager levers: **📣 Remind Now** (nudges Santas
   who owe a pick + giftees who owe a reply) and **↩ Back to Matching** (wipes
   all picks; threads are reused later). **🚀 Launch** refuses only while some
   Santa hasn't sent a pick; ⏳ pending picks are locked by the launch itself
   after a bold **‼️The pending picks will be locked** warning.
5. Launch runs as a batched job: per participant a review doc for their final
   anime (`Review of {Anime} by {name}`, header "given to
   `Display(@username)`", anyone-with-link **editor**), and an assignment card
   in their existing thread — their own pick recap (giftee + list link) on
   top, their anime below, doc link + **⭐ Score it /10** buttons last. The
   panel counts up and flips to RUNNING by itself.
6. During RUNNING: wrote-detection every 30 minutes and on every **🔄 Refresh**
   click (chars written beyond the doc template; the sheet — linked from the
   panel at all times — shows a **Review Length** column), progress panel,
   scheduled reminders (thread ping, optional DM mirror), **Remind Now** for
   laggards, scoring out of 10 until Close.
7. **Close Reviews**: one confirm — final status sync, all docs flip to
   anyone-with-link **viewer** *before* any reveal link is posted, then reveal
   cards — "your Secret Santa was X, they picked Y for you"; unscored reviews
   read "didn't score your pick" — plus the public gallery (always posted),
   one line per participant, per loop.
8. **Finish**: deletes threads and the bot's event data, then re-posts fresh
   IDLE panels at the bottom of both channels (Abort does the same). **The
   sheet and docs stay in the manager's Drive** — nothing to export.

## Operational notes

- **Free-plan budget:** `JOB_BATCH=5` default (a launch unit ≈ 7 external
  subrequests; a prepare unit ≈ 3; D1 ops may also count toward the
  50/invocation cap). On the paid plan raise `JOB_BATCH`/`REMINDERS_PER_TICK`
  freely.
- **Restart-safe by construction:** panels re-render from D1; jobs re-enter on
  per-unit markers (`reco_card_posted`, `assignment_posted`, …); duplicate
  enqueues are blocked by a partial unique index; every state transition is a
  conditional `UPDATE … WHERE state = ?`; every approve/decline/send is a
  conditional `UPDATE … WHERE reco_status = ?` — double-clicks and races
  produce a harmless ephemeral, never a duplicate side effect.
- **Wrong-thread clicks:** thread-card buttons carry the owner's user id
  (`ax:reco*:{uid}`), so a moderator clicking inside someone else's private
  thread is told whose buttons they are instead of acting on their own row.
- **🛑 Abort:** every non-IDLE state has a red Abort button — it cancels any
  in-flight job, purges unsent reminders, deletes threads (batched) and resets
  both panels to IDLE. The sheet and docs always stay in the manager's Drive.
- **Stalls self-heal:** after 5 consecutive failing ticks the manager panel
  shows the job's last error (e.g. the Google reconnect prompt); the dispatcher
  retries every minute, so fixing the cause is sufficient.
- **Privacy caveat:** members with *Manage Threads* (admins/mods) can open
  private threads — missions and picks are hidden from ordinary members, not
  from moderators. Review-doc URLs are capabilities: they only ever appear
  inside the owner's private thread until Close flips docs read-only.
- **Left-server participants:** the row is kept and the loop stays intact. If a
  vanished Santa never picks, the manager's levers are 📣 Remind, ↩ Back to
  Matching (regroup without them after removing their row via Validate), or
  waiting them out; giftees who never reply are covered by the launch sweep
  (pending picks lock at Launch).
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
| Jikan v4 availability (~3 req/s) | Two-source chain: official MAL API v2 (primary when `MAL_CLIENT_ID` set) → Jikan (UA + backed-off retries); 24 h D1 cache; every outcome logged; `/diag/search` probes both from the Worker. The spec's AniList fallback (§9.4) was removed — graphql.anilist.co blocks Workers traffic outright |

## Troubleshooting search ("Try a different keyword…")

The search now runs in the **recommending phase** (Santas picking for their
giftees), but the machinery — and its failure modes — are unchanged. That
message means **every** search source failed. The usual cause on Workers:
Jikan (`api.jikan.moe`) sits behind Cloudflare bot protection, which often
403-challenges traffic from Workers' shared egress IPs — no header fixes
that. (AniList blocks Workers traffic outright, which is why it is not used
at all.)

1. **Set `MAL_CLIENT_ID`** (the real fix). Register a free client id at
   <https://myanimelist.net/apiconfig> (Create ID → app type "other"), put it
   in `wrangler.toml` `[vars]`, redeploy. The bot then talks to the official,
   authenticated MAL API v2 first, which is not subject to those bot walls;
   Jikan remains as the fallback.
2. **Probe from the Worker itself**:
   `https://<worker>/diag/search?q=frieren&k=<last 8 chars of DISCORD_PUBLIC_KEY>`
   returns per-source `ok/error` + timing, plus the running build id — this
   shows exactly which upstream is failing with what status.
3. **Check logs**: `npx wrangler tail` — every search logs one line per source
   attempt (`jikan:ok(20)`, `mal-official:MAL 403`, …).
4. The health route `/` shows the deployed build id — confirm your deploy
   actually went out.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm test            # vitest (tz conversion, re-ranking, loop math, layout, link validation)
npm run dev         # wrangler dev (local)
npm run migrate:local
```
