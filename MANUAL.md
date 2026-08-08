# Anime Exchange Bot — User Manual

A secret-santa-style anime exchange for your Discord server — where the gifts
are **hand-picked recommendations**. You sign up with a link to your
MAL/AniList; the bot secretly matches everyone in loops. You study *your*
person's list and recommend an anime just for them, while your own Secret
Santa picks one for you. Don't like the pick? Send it back with **Sorry😞**
(a limited number of times!). Once every pick is locked in, everyone watches
their full season, writes a review in a Google Doc, and scores it out of 10.
Who picked what for whom stays secret until the reveal at the end.

Matches form **loops**: by default one big circle over everyone, or several
smaller circles if the manager splits participants into groups. Inside a loop,
the person *after* you picks **for you**, and *you* pick for the person
*before* you.

Everything happens through **buttons on two pinned messages** and your private
thread — nobody types commands except the one-time `/setup`.

---

## The two channels

| Channel | Who sees it | What it's for |
|---|---|---|
| `#anime-exchange-manager` | Managers only (the **Exchange Manager** role) | The control panel — every event action is a button here |
| `#anime-exchange` | Everyone | The sign-up panel, the reveal gallery, and each participant's **private thread** |

Both channels are read-only; you interact by clicking buttons. Private threads
under `#anime-exchange` are where each participant receives their Santa
mission, their pick, reminders, and the reveal.

> **Privacy note:** members with the *Manage Threads* permission (admins/mods)
> can technically open private threads. Missions and picks are hidden from
> ordinary members, not from moderators. (Buttons still refuse them — each
> card's buttons only work for their owner.)

---

## For participants

### Signing up

1. Press **📝 Sign Up** on the pinned panel while sign-ups are open.
2. Fill in the built-in **"Link of your MAL/AniList"** field — e.g.
   `https://myanimelist.net/profile/you`, `https://myanimelist.net/animelist/you`
   or `https://anilist.co/user/you`. This is what your Secret Santa studies to
   pick your anime, so a public, up-to-date list gets you better gifts. (List
   somewhere else? The bot warns, but a red **⚠ Proceed anyway** lets you keep
   any link.) Answer the manager's questions (a second step appears if there
   are more than four).
3. Review the **summary card** and press **✅ Confirm Sign-Up**.

Until sign-ups close you can press **✏ Edit My Sign-Up** (same form,
pre-filled) or **🚪 Withdraw**. If you wander off mid-wizard, your progress is
kept for 30 minutes.

Some questions are marked **👁 visible to your recommender** — your Secret
Santa sees those answers next to your list when picking for you. **🔒 hidden**
answers are only on the manager's sheet.

### Your mission 🎯

When the manager starts the recommendation phase, a private thread named
`🎁 {your name}` appears with your **mission card**:

> 🎯 You are the Secret Santa of **rabbit** — here's their list
> (`📚 Open their list`) and what they shared. They can send a pick back
> **2** times. They don't know it's you. 🤫

Press **🎯 Recommend an anime**, type a title keyword (English and Japanese
both work — "frieren", "Sousou no Frieren" and 「葬送のフリーレン」 all find
the same show), pick the right season from the results, and **📨 Send** it.

- If they decline, you get a ping with the round count and which titles
  they've already sent back (you can't re-pick those).
- When they accept, you get a 🎉 ping.

### Your pick 🎁

When *your* Secret Santa sends a pick, your thread gets a card with the anime
(cover, year, episodes, MAL link) and two buttons:

- **Thank you!😊** — accepts it. Accepting is **not** a hard lock: a red
  **No. I'll decline it.😞** button stays on the card, so you can change your
  mind any time **until the manager launches** the event.
- **Sorry😞** — sends it back and your Santa picks again. Declining (before
  *or* after accepting) spends one of your Sorry😞s; the manager sets how many
  you get. Once they're spent, the buttons to send picks back disappear.

Picks that are still unanswered when the manager launches lock in
automatically. At launch, everything is final.

Lost a thread? Press **🎯 My Status** on the pinned panel — it shows both your
mission and your pick, with the same buttons.

### The event itself

Once the picking is done, the manager launches. Your thread gets the
**assignment card**:

- **Your pick** — on top: who will be reviewing what you chose, with their
  MAL/AniList link.
- **Your anime** — below it: your own pick. Watch the full season. *Who picked
  it stays secret until the reveal.*
- **📝 Open your review doc** — your personal Google Doc. Write your review
  there any time before the deadline. The link lives on this card permanently.
- **⭐ Score it /10** — rate your given anime (1–10), changeable until reviews
  close.

Reminders arrive in this thread as the deadline approaches (and optionally by
DM, if the manager enabled mirroring). You count as "started" once your doc
has about 20 characters beyond the pre-filled template.

### The reveal

When the manager closes reviews, every doc flips to **view-only first**, then
your thread gets the reveal card:

> Your Secret Santa was **J** (@J) — they picked **Sousou no Frieren** for you.
>
> **rabbit** (@rabbit) gave your pick **Kaijuu 8-gou** **⭐ 8 stars**:
> `[📖 Review of Kaijuu 8-gou by rabbit]`

If the manager chose a public gallery, `#anime-exchange` also gets the whole
loop, one line per participant:

> 🎁 **J** (@J) picked **Kaijuu 8-gou** for **rabbit** (@rabbit) — **⭐ 8
> stars** ([read review](…))

---

## For managers

### One-time setup

1. A server **Administrator** runs **`/setup init`**. The bot creates the
   `Exchange Manager` role (assigned to you), both channels, and the two
   pinned panels. Give the role to anyone who should co-manage.
2. Press **🔗 Connect Google** and approve the consent screen. The event
   spreadsheet and all review docs are created **in that Google account's
   Drive** and stay yours forever. One Google account is connected per server;
   reconnecting replaces it.
3. If panels or channels ever go missing, **`/setup repair`** recreates them.

### Running an event, state by state

**IDLE → 🆕 New Event** creates a draft.

**DRAFTING — build the sign-up form**
- **⚙ Set Basics** — topic, sign-up deadline (`YYYY-MM-DD HH:mm`), timezone
  (IANA, pre-filled `America/Chicago`), auto-stop on/off, and the
  **Sorry😞 budget (0–9)**: how many times each participant may decline a
  pick. `0` means first pick = final; `1`–`2` is the sweet spot for most
  groups.
- **➕ Add Item / 🛠 Edit Items** — up to 9 custom questions, fill-in or
  multiple-choice (2–10 options), each visible-to-recommender or hidden. The
  **MAL/AniList link is built-in** and always first — you don't add it.
- **📨 Open Sign-Ups** — requires basics + Google connected. Creates the
  spreadsheet and opens the participant panel.
- **🗑 Discard** deletes the draft.

**SIGNUP_OPEN**
- **📋 View Sign-Ups** — count, five most recent names, sheet link.
- If the deadline passes with auto-stop off, the participant panel shows
  "⏰ Deadline passed — still accepting until the manager closes sign-ups."
- **⏸ Stop Sign-Ups** moves to Matching (reversible via Reopen).

**MATCHING — arrange the loops.** The flow is **Grouping → Shuffle →
hand-tune → Validate → Start Recommending**:

1. **🧩 Grouping** — split everyone into G random loops of near-equal size
   (G up to half the participant count; G = 1 is one big loop). Re-roll freely.
2. **🔀 Shuffle** — re-draws the order *within* each loop without changing who
   is in which loop.
3. **Hand-tune in the sheet** (optional) — two levers: **reorder rows** to
   change a loop's order, and **edit the Group column** to move someone
   between loops. Each row's Secret Santa is the next row within its group's
   block — that person will pick *for* this row. The derived columns are never
   read back.
4. **✅ Validate** — reconciles the sheet with the bot: checks for edited
   IDs, duplicates, and removed rows (with a removal/restore flow), parses the
   Group column (blank = 1), **blocks** any 1-person group, **warns** on
   2-person groups (a mutual pair — you pick for each other; fine if
   intended), then re-sorts rows into clean blocks.
5. **🎯 Start Recommending** — validates once more, then **locks the
   assignment**. From here the sheet's row order and Group column are a
   dashboard, not an input.

**PREPARING** — the bot creates one private thread per participant and posts
their Santa mission card (who they pick for + that person's list link +
👁-visible answers), about 5 per minute; the panel counts up and flips to
RECOMMENDING by itself.

**RECOMMENDING — the heart of v3.** The panel shows
`accepted / awaiting reply / waiting on their Santa` counts live.

- **📊 View Status** — one line per participant: what they were picked,
  whether it's ✅ accepted / ⏳ awaiting reply / 🎁 still waiting (with
  decline counts).
- **📣 Remind Now** — nudges exactly the people who owe an action: Santas who
  haven't picked (or got declined and haven't re-picked), and giftees sitting
  on a pending pick. The nudge lands in their thread with the right buttons.
- **↩ Back to Matching** — the undo: wipes **all** picks, approvals and
  declines, and unlocks the assignment for regrouping. Threads stay and are
  reused; old thread cards become stale (their buttons politely refuse).
- **🚀 Launch** — set the review deadline, timezone, reminder days
  (default `7,3,1`), and optional DM mirroring; confirm. Launch only refuses
  while some **Santa hasn't sent a pick at all**. Picks that are still
  ⏳ awaiting a reply get locked in by the launch itself — the confirmation
  warns you first with **‼️The pending picks will be locked**.

**LAUNCHING** — the bot creates one review doc per participant (for their
locked-in anime) and posts the assignment card in their existing thread,
about 5 per minute; the panel counts up and flips to RUNNING by itself.
Redeploys or crashes lose nothing — it resumes where it left off.

**RUNNING**
- The panel always links **📋 View Sheet** — the sheet is the detail view
  (per-participant Review Length, Score, `⚠ missing` flags).
- **🔄 Refresh** — queues a status refresh; the panel and sheet update within
  a minute or two. Status also refreshes on its own every 30 minutes.
- **📣 Remind Now** — immediate nudge to everyone who hasn't started writing.
- **🏁 Close Reviews** — one confirm; closing always posts the public gallery
  in `#anime-exchange` along with the private reveal cards.

**CLOSING** — a final status snapshot is taken, then **all docs flip to
view-only before any reveal link is posted**, then reveal cards (and the
gallery, if chosen) go out.

**REVEALED → 🧹 Finish** — deletes the private threads and the bot's event
data, and resets both panels. **Your Google Sheet and Docs stay in your
Drive.** A new event can start immediately.

**🛑 Abort** — available in every state as the red escape hatch. It cancels
any stuck job, removes threads, wipes the bot's event data, and resets the
panels — Drive files are never touched. Use it whenever an event is wedged; it
cannot be undone.

### The spreadsheet

One tab, `Sign-Ups`. The bot rewrites it as things change and heals it
automatically if it drifts.

| Column | Who writes it | Meaning |
|---|---|---|
| Row # | bot | display only |
| User ID 🔑 | bot | immutable key — **never edit** |
| Username | bot | the participant |
| MAL/AniList | bot | their list link (the built-in signup item) |
| *your custom items* | bot | answers (🔒 marks hidden ones) |
| **Group** | **you** (during Matching only) | loop membership — positive integer, blank = 1 |
| Secret Santa | bot | derived from row order (the next row picks for this one) — never edit |
| Recommendation | bot | the anime this row's Santa picked for them (live during Recommending) |
| Rec. Status | bot | `⏳ awaiting reply` / `😞 declined ×k` / `✅ accepted` / `⏩ locked at launch` |
| Review Link | bot | each participant's doc |
| Review Length | bot | characters written beyond the template |
| Score | bot | the participant's ⭐/10 for their given anime |

**Row order and the Group column are the only inputs, and only while the
event is in Matching.** Once recommendations start, the assignment is locked
and the whole sheet is a dashboard.

---

## Timing cheat-sheet

| Thing | How fast |
|---|---|
| Sign-up count on the manager panel | instant when quiet; ≤ ~1–2 min during a burst |
| Threads + Santa missions at Start Recommending | ~5 participants per minute |
| Pick sent / approved / declined | instant (card + sheet cell update on the spot) |
| Recommending progress counts on the panels | instant at milestones; otherwise ≤ ~1 min |
| Review docs + assignment cards at Launch | ~5 participants per minute |
| Review Length / started-writing / Score in sheet & panel | every 30 min, plus on every **🔄 Refresh** click |
| Reminders | up to 30 messages per minute |
| Close (flips + reveals) | ~5 participants per minute, docs flip first |
| Auto-stop / deadline banner | checked every 15 min |

The bot runs on Cloudflare's free tier — everything that touches many
participants is deliberately batched, which is why big actions take a few
minutes and the panels show live progress.

---

## FAQ & troubleshooting

**What link can I use at sign-up?**
Any `myanimelist.net` or `anilist.co` URL that isn't just the bare domain —
your profile (`/profile/you`, `/user/you`) or your list (`/animelist/you`).
The scheme is optional; the bot normalizes it. Other sites are rejected.

**I used up my Sorry😞s. Can I still decline?**
No — declining (even of a pick you first accepted) spends the budget, and
when it's gone the decline buttons disappear. You can still press
**Thank you!😊**; either way the pick locks in at launch. Choose your
declines wisely.

**I said Thank you!😊 but changed my mind.**
Press the red **No. I'll decline it.😞** on the card (or via **🎯 My
Status**) — it works until the manager launches, as long as you have
Sorry😞s left.

**My giftee declined everything and now won't respond.**
They can't decline forever (the budget), and a pick stuck **⏳ awaiting
reply** simply locks in when the manager launches. If your pick was declined
and *you're* stuck, just recommend again — declined titles are shown so you
don't repeat them.

**A Santa never sends a pick.**
The manager can 📣 Remind them (the nudge has the Recommend button in it). If
they're truly gone, the manager can **↩ Back to Matching**, remove them via
Validate's removal flow, regroup, and start recommending again.

**I clicked a button in a thread and it said the buttons belong to someone
else.**
Cards only obey their owner. Find your own thread, or use **🎯 My Status** on
the pinned panel.

**Search says "Try a different keyword — or try again in a minute."**
All search sources failed for that query. Very short keywords (under 3
characters) can be rejected — try a longer or different spelling (Japanese
titles work). If it persists for every search, the admin should check that
`MAL_CLIENT_ID` is set (see README → Troubleshooting search).

**The panel shows "⚠ Google disconnected."**
The connected account's access was revoked or its stored token became
unreadable. Press **🔗 Connect Google** and re-approve — any stalled work
resumes automatically within a minute. Remember it's one Google account per
server; reconnecting with a different account only affects *new* files.

**A button replies "this control is from an older version."**
The panel was mid-update — it repaints itself; just click again.

**Someone shows "not started" but they've written plenty.**
Status updates every 30 minutes; press **🔄 Refresh** and check the sheet a
minute later. "Started" means ~20+ characters beyond the doc template.

**A participant left the server mid-event.**
Their row stays and the loop is unaffected. If it happens before their pick
was locked, see "A Santa never sends a pick" above; after Launch, their doc
still counts at the reveal.

**Someone deleted their review doc.**
The sheet shows `⚠ missing`; the reveal still posts, minus the link.

**Panels or channels got deleted.**
Run **`/setup repair`**.

**Something is truly stuck.**
The manager panel surfaces the exact error after a few failed retries, and it
retries forever — fixing the cause (usually Google reconnect) is enough. If
you just want out, **🛑 Abort**.

**Is my review doc link private?**
While the event runs, your doc is "anyone with the link can edit" — but the
link only ever appears inside *your* private thread, so keep it there. At
close, every doc becomes view-only before any link is shared.

For deployment and configuration (Cloudflare, Google Cloud, `MAL_CLIENT_ID`,
diagnostics endpoints), see [README.md](README.md).
