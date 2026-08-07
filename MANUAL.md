# Anime Exchange Bot — User Manual

A secret-santa-style anime exchange for your Discord server. Everyone submits
one anime recommendation, receives someone else's pick at random, watches the
full season, writes a review in a Google Doc, and scores it out of 10. Who
recommended what stays secret until the reveal at the end.

Assignments form **loops**: by default one big circle over everyone, or several
smaller circles if the manager splits participants into groups. Inside a loop,
you watch the pick of the person "after" you, and the person "before" you
watches yours.

Everything happens through **buttons on two pinned messages** — nobody types
commands except the one-time `/setup`.

---

## The two channels

| Channel | Who sees it | What it's for |
|---|---|---|
| `#anime-exchange-manager` | Managers only (the **Exchange Manager** role) | The control panel — every event action is a button here |
| `#anime-exchange` | Everyone | The sign-up panel, the reveal gallery, and each participant's **private thread** |

Both channels are read-only; you interact by clicking buttons. Private threads
under `#anime-exchange` are where each participant receives their assignment,
reminders, and reveal.

> **Privacy note:** members with the *Manage Threads* permission (admins/mods)
> can technically open private threads. Assignments are hidden from ordinary
> members, not from moderators.

---

## For participants

### Signing up

1. Press **📝 Sign Up** on the pinned panel while sign-ups are open.
2. **Step 1 modal:** type an anime title keyword — English and Japanese both
   work ("frieren", "Sousou no Frieren", and 「葬送のフリーレン」 all find the
   same show) — and answer the first few of the manager's questions.
3. Pick your anime from the search results (year, format and episode count are
   shown so you can pick the right season). **🔍 Search again** reopens the
   form with your answers kept.
4. If the form has more than four questions, a **Continue (2/2)** step shows
   the rest.
5. Review the **summary card** and press **✅ Confirm Sign-Up**.

Until sign-ups close you can press **✏ Edit My Sign-Up** (same wizard,
pre-filled) or **🚪 Withdraw**. If you wander off mid-wizard, your progress is
kept for 30 minutes.

Some questions are marked **👁 visible to your recommender** — the person whose
pick you receive will see those answers (helps them know who they're gifting
to). **🔒 hidden** answers are only on the manager's sheet.

### Your private thread

When the manager launches the event, a private thread named `🎁 {your name}`
appears with your **assignment card**:

- **Your anime** — title, year, episodes, cover, MAL link. Watch the full
  season. *Who recommended it stays secret until the reveal.*
- **📝 Open your review doc** — your personal Google Doc. Write your review
  there any time before the deadline. The link lives on this card permanently.
- **⭐ Score it /10** — rate your given anime (1–10). You can change your
  score any time until reviews close.
- **Your recommendation** — who received it, plus their 👁-visible answers.

Reminders arrive in this thread as the deadline approaches (and optionally by
DM, if the manager enabled mirroring). The wording differs depending on
whether you've started writing yet — you count as "started" once your doc has
about 20 characters beyond the pre-filled template.

### The reveal

When the manager closes reviews, every doc flips to **view-only first**, then
your thread gets the reveal card:

> Your Secret Santa was **J** (@J) — they recommended **Sousou no Frieren** for you.
>
> **rabbit** (@rabbit) gave your recommendation **Kaijuu 8-gou** **⭐ 8 stars**:
> `[📖 Review of Kaijuu 8-gou by rabbit]`

If the manager chose a public gallery, `#anime-exchange` also gets the whole
loop, one section per group:

> 🎁 **J** (@J) recommended **Kaijuu 8-gou** → received **⭐ 7 stars** from
> **rabbit** (@rabbit) ([read review](…))

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
  (IANA, pre-filled `America/Chicago`), and whether sign-ups auto-stop at the
  deadline.
- **➕ Add Item / 🛠 Edit Items** — up to 9 custom questions, fill-in or
  multiple-choice (2–10 options), each visible-to-recommender or hidden.
  Reorder or delete from the item card.
- **📨 Open Sign-Ups** — requires basics + Google connected. Creates the
  spreadsheet and opens the participant panel.
- **🗑 Discard** deletes the draft.

**SIGNUP_OPEN**
- **📋 View Sign-Ups** — count, five most recent names, sheet link.
- The panel's live count updates instantly when things are quiet, and at most
  once per minute during a burst. Participants never see the count.
- If the deadline passes with auto-stop off, the participant panel shows
  "⏰ Deadline passed — still accepting until the manager closes sign-ups."
- **⏸ Stop Sign-Ups** moves to Matching (reversible via Reopen).

**MATCHING — arrange the loops.** The flow is **Grouping → Shuffle →
hand-tune → Validate**:

1. **🧩 Grouping** — split everyone into G random loops of near-equal size
   (G up to half the participant count; G = 1 is one big loop). Re-roll freely.
2. **🔀 Shuffle** — re-draws the order *within* each loop without changing who
   is in which loop.
3. **Hand-tune in the sheet** (optional) — two levers: **reorder rows** to
   change a loop's order, and **edit the Group column** to move someone
   between loops. Your santa is simply the next row within your group's block.
   The Secret Santa / Given Anime columns are always derived — never type in
   them.
4. **✅ Validate** — reconciles the sheet with the bot: checks for edited
   IDs, duplicates, and removed rows (with a removal/restore flow), parses the
   Group column (blank = 1), **blocks** any 1-person group, **warns** on
   2-person groups (a mutual pair — fine if intended), then re-sorts rows into
   clean blocks.
5. **🚀 Launch** — set the review deadline, timezone, reminder days
   (default `7,3,1`), and optional DM mirroring; confirm. Validation runs
   again automatically.

**LAUNCHING** — the bot creates one review doc + one private thread per
participant, about 5 per minute; the panel counts up and flips to RUNNING by
itself. Redeploys or crashes lose nothing — it resumes where it left off.

**RUNNING**
- **📊 View Event** — per-participant status (`✍ 2,431 chars · ⭐ 8/10` /
  `❌ not started`). **Each click also queues a status refresh** — click,
  wait a minute, click again for fresh numbers. Status also refreshes on its
  own every 30 minutes.
- **📣 Remind Now** — immediate nudge to everyone who hasn't started.
- **🏁 Close Reviews** — choose **Close & post gallery** (public reveal in
  `#anime-exchange`) or **Close quietly** (reveals only in private threads).

**CLOSING** — a final status snapshot is taken, then **all docs flip to
view-only before any reveal link is posted**, then reveal cards (and the
gallery, if chosen) go out.

**REVEALED → 🧹 Finish** — deletes the private threads and the bot's event
data, and resets both panels. **Your Google Sheet and Docs stay in your
Drive.** A new event can start immediately.

**🛑 Abort** — available in every state as the red escape hatch. It cancels
any stuck launch/close/sync, removes threads, wipes the bot's event data, and
resets the panels — Drive files are never touched. Use it whenever an event is
wedged; it cannot be undone.

### The spreadsheet

One tab, `Sign-Ups`. The bot rewrites it as things change and heals it
automatically if it drifts.

| Column | Who writes it | Meaning |
|---|---|---|
| Row # | bot | display only |
| User ID 🔑 | bot | immutable key — **never edit** |
| Username, Anime, MAL | bot | the signup |
| *your custom items* | bot | answers (🔒 marks hidden ones) |
| **Group** | **you** (during Matching) | loop membership — positive integer, blank = 1 |
| Secret Santa / Given Anime | bot | derived from row order — never edit |
| Review Link | bot | each participant's doc |
| Review Length | bot | characters written beyond the template |
| Score | bot | the participant's ⭐/10 for their given anime |

**Row order and the Group column are the only inputs.** Everything else you
type in the derived block gets overwritten.

---

## Timing cheat-sheet

| Thing | How fast |
|---|---|
| Sign-up count on the manager panel | instant when quiet; ≤ ~1–2 min during a burst |
| Assignments delivered at Launch | ~5 participants per minute |
| Review Length / started-writing / Score in sheet & panel | every 30 min, plus on every **View Event** click |
| Reminders | up to 30 messages per minute |
| Close (flips + reveals) | ~5 participants per minute, docs flip first |
| Auto-stop / deadline banner | checked every 15 min |

The bot runs on Cloudflare's free tier — everything that touches many
participants is deliberately batched, which is why big actions take a few
minutes and the panels show live progress.

---

## FAQ & troubleshooting

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

**Someone shows "❌ not started" but they've written plenty.**
Status updates every 30 minutes; click **View Event** twice (a minute apart)
to force it. "Started" means ~20+ characters beyond the doc template.

**A participant left the server mid-event.**
Their row, doc, and assignment stay — the loop is unaffected, and their review
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
