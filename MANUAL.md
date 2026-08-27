# Anime Exchange Bot — User Manual

A secret-santa-style anime exchange for your Discord server — where the gifts
are **hand-picked recommendations**. You sign up with a link to your
MAL/AniList; the bot secretly matches everyone in loops. You study *your*
person's list and recommend anime just for them — **you decide how many you
want to receive** (up to 3, a maximum, not a quota) — while your own Secret
Santa picks for you. Don't like the pick? Send it back with **Sorry😞**
(a limited number of times!). Once every pick is locked in, everyone watches
their full season, writes a review in a Google Doc, and rates it out of 10.
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

1. Press **📝 Sign Up/Edit** on the pinned panel while sign-ups are open —
   the same button updates an existing sign-up (the form comes pre-filled).
2. The form's **first** field is **"How many anime do you want?" (1–3)** —
   a maximum, entirely your call; your Santa may send fewer, never more.
3. Fill in the built-in **"Link of your MAL/AniList"** field — e.g.
   `https://myanimelist.net/profile/you`, `https://myanimelist.net/animelist/you`
   or `https://anilist.co/user/you`. This is what your Secret Santa studies to
   pick your anime, so a public, up-to-date list gets you better gifts. (List
   somewhere else? The bot warns, but a red **⚠ Proceed anyway** lets you keep
   any link.) Answer the manager's questions (a second step appears if there
   are more than three).
4. Check the **summary card** and press **✅ Confirm Sign-Up**.

Until sign-ups close you can press **📝 Sign Up/Edit** again to change your
answers, or **🚪 Withdraw**. If you wander off mid-wizard, your progress is
kept for 30 minutes.

Some questions are marked **👁 visible to your recommender** — your Secret
Santa sees those answers next to your list when picking for you. **🔒 hidden**
answers are only on the manager's sheet.

### Your mission 🎯

When the manager starts the recommendation phase, a private thread named
`🎁 {your name}` appears with your **mission card** — who you're the Secret
Santa of, with their info as a simple list:

> **🎯 You are the Secret Santa of rabbit**
> 🎨 **Theme:** Nostalgia
> Study **rabbit**'s taste. Recommend **at most 3** anime they'll love — and
> that fit the theme.
> • **list:** https://myanimelist.net/profile/rabbit
> • **favorite genre:** mecha
>
> 🎯 **Your recommendations** (1 approved / 3 at most)
> • Sousou no Frieren (2023) — declined 😞
> • Kaiba (2008) — approved 😊
> ⏰ **Recommend by** {deadline}
> They can send a pick back with Sorry😞. *They don't know it's you.* 🤫
>
>
> 🎁 **Anime you approved**
> **1.** ✅ Love Live! (2013) · TV · 13 episodes · MAL
> Sorry😞s left: **1**
>
> `[🎯 Recommend an anime]` `[I'll change my mind😞]`

Mission and approvals live in the **same** panel — one embed, your whole
status view, updating itself as things happen. (You never see how many declines *they* have left — pick with your
heart.)

Press **🎯 Recommend an anime**, type a title keyword (English and Japanese
both work — "frieren", "Sousou no Frieren" and 「葬送のフリーレン」 all find
the same show), pick the right season, and **📨 Send** it. Repeat while the
Recommend button is there — the number they asked for is a **maximum**, so
stopping early is fine, and one accepted pick is all the exchange needs. You
can't pick the same show twice for the same person, or one they declined.

- If they decline, you get a ping and the panel shows what missed.
- When they accept, you get a 🎉 ping.

### Your pick 🎁

Each pick your Secret Santa sends arrives as its own card in your thread
(cover, year, episodes, MAL link) with two buttons:

- **Thank you!😊** — accepts it. The card disappears and the anime moves into
  the **🎁 Anime you approved** list on your status panel.
- **Sorry😞** — sends it back and your Santa can pick again. Declining spends
  one of your Sorry😞s; the manager sets how many you get, and the budget
  covers all your picks together. Once they're spent, the decline buttons
  disappear.

Changed your mind about something you accepted? The status panel's
**I'll change my mind😞** button lets you send an approved anime back (while
you still have a Sorry😞 and until the manager launches).

Picks that are still unanswered when the manager launches lock in
automatically. At launch, everything is final.

### The event itself

Once the picking is done, the manager launches. Your thread gets the
**assignment** — a header message and then one panel per anime:

- **🎁 Your pick** — on top: what you chose, bulleted, plus who will be
  reviewing it and their MAL/AniList link.
- **🎬 Your anime** — the intro and the **⏰ review deadline**. Watch the full
  season of each. *Who picked them stays secret until the reveal.*
- **One panel per anime** below that — cover, type, episodes, MAL link — each
  with its own two buttons:
- **📝 Review: {anime}** — each anime gets **its own Google Doc**, on its own
  panel next to its Rate button. Write each review any time before the
  deadline; the links stay in your thread permanently.
- **⭐ Rate: {anime}** — rate that one anime (1–10); pick "— no rating —" to
  clear it and come back later. Changeable until reviews close.

Reminders arrive in this thread as the deadline approaches (and optionally by
DM, if the manager enabled mirroring). You count as "started" once your doc
has about 20 characters beyond the pre-filled template.

### The reveal

When the manager closes reviews, every doc flips to **view-only first**, then
your thread gets the reveal card:

> 🎭 **The reveal**
> Your Secret Santa was **J** (@J). They picked the anime for you.
> • **Kaijuu 8-gou (2024)**
> • **Naruto (2002)**
>
> **rabbit** (@rabbit) appreciated your picks
> • rabbit rated **Sousou no Frieren (2023)** ⭐ 9 ([review](…))
> • rabbit didn't rate **Bocchi the Rock! (2022)** ([review](…))

The gallery goes to `#anime-exchange`, one header per pair and a bullet per
anime:

> 🎁 **J** (@J) was the Secret Santa of **rabbit** (@rabbit)
> • rabbit rated **Kaijuu 8-gou (2024)** ⭐ 9 ([review](…))
> • rabbit didn't rate **Naruto (2002)** ([review](…))

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
- **⚙ Set Basics** — the **Session** (the event's name), an optional
  **Theme** (what picks should aim for — shown to everyone: panels, the
  sign-up announcement, and the mission/pick cards), and the **Sorry😞 budget
  (0–9)**: how many times each participant may send a pick back. `0` means
  first pick = final; `1`–`2` is the sweet spot for most groups. How many
  anime each person wants is **not** yours to set — it's their own choice at
  sign-up (1–3).
- **➕ Add Item / 🛠 Edit Items** — item **1** is the built-in MAL/AniList
  link: it always comes first and stays a validated link, but you can reword
  its label and description. Items 2+ are your own questions (up to 8),
  fill-in or multiple-choice (2–10 options), each with an optional
  description and each visible-to-recommender or hidden.
- **📨 Open Sign-Ups** — asks for the **sign-up deadline and timezone**, then
  confirms. Creates the spreadsheet, opens the participant panel, and
  flips the participant panel to "sign-ups open". **The bot never pings
  @everyone** — announce it yourself, however your server likes it.
- **🗑 Discard** deletes the draft.

**SIGNUP_OPEN**
- The panel shows the live count and links the sheet in its body (as every
  later state does — `Sheet: https://…`); **🔄 Refresh** updates the count
  instantly instead of waiting out the 1-minute throttle.
- **⏰ Auto-stop** — a toggle here (and again during Recommending and Running):
  ON closes sign-ups automatically at the deadline.
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
5. **🎯 Start Recommending** — set the **recommendation deadline**
   (`YYYY-MM-DD HH:mm` + timezone) in the modal, confirm, and the
   assignment **locks** after one more validation. From here the sheet's
   row order and Group column are a dashboard, not an input. The deadline
   is shown everywhere (panels, mission and pick cards, nudges); when it
   passes, both panels flip a "deadline passed" banner — nudging and
   launching remain your call.

**PREPARING** — the bot creates one private thread per participant and posts
their Santa mission card (who they pick for + that person's list link +
👁-visible answers), about 5 per minute; the panel counts up and flips to
RECOMMENDING by itself.

**RECOMMENDING — the heart of the flow.** The panel shows both totals: how
many **participants** have an accepted anime, and how many **picks** are
accepted out of everything people asked for.

- **🔄 Refresh** — queues a repaint; the panel and sheet update within a
  minute or two. The per-person detail (who was picked what, ✅/⏳/😞 status,
  decline counts) lives in the sheet's **Recommendation / Rec. Status**
  columns — the sheet is linked in the panel body.
- **⏰ Auto-stop** — ON locks every ⏳ pending pick at the recommendation
  deadline, so the back-and-forth ends on time. Launching stays your call.
- **📣 Remind Now** — nudges exactly the people who owe an action: Santas who
  haven't picked (or got declined and haven't re-picked), and giftees sitting
  on a pending pick. The nudge lands in their thread with the right buttons.
- **↩ Back to Matching** — the undo: wipes **all** picks, approvals and
  declines, and unlocks the assignment for regrouping. Threads stay and are
  reused; old thread cards become stale (their buttons politely refuse).
- **🚀 Launch** — set the review deadline, timezone, reminder days
  (default `7,3,1`), and optional DM mirroring; confirm. Launch only refuses
  while someone **has no anime at all**. Picks that are still ⏳ awaiting a
  reply get locked in by the launch itself — the confirmation warns you first
  with **‼️The pending picks will be locked**.

**LAUNCHING** — the bot creates **one review doc per accepted anime** and then
posts each participant's assignment (a header message plus one panel per
anime) into their existing thread. The panel counts **docs** and **cards**
separately — they are different totals — and flips to RUNNING by itself.
Redeploys or crashes lose nothing — it resumes where it left off.

**RUNNING**
- The panel body links the sheet — the detail view (per-anime Rating, Review
  Link and Review Length, `⚠ missing` flags).
- **🔄 Refresh** — queues a status refresh; the panel and sheet update within
  a minute or two. Status also refreshes on its own every 30 minutes.
- **📣 Remind Now** — immediate nudge to everyone who hasn't started writing.
- **⏰ Auto-stop** — ON closes reviews by itself at the review deadline: docs
  flip read-only, reveals and the gallery go out, exactly as if you had pressed
  🏁 Close Reviews. OFF leaves it to you.
- **🏁 Close Reviews** — one confirm; closing always posts the public gallery
  in `#anime-exchange` along with the private reveal cards.

**CLOSING** — a final status snapshot is taken, then **all docs flip to
view-only before any reveal link is posted**, then reveal cards (and the
gallery, if chosen) go out.

**REVEALED → 🧹 Finish** — deletes the private threads and the bot's event
data, then **re-posts fresh panels at the bottom of both channels** (the old
pinned ones are removed, so nobody has to scroll up to find them). **Your
Google Sheet and Docs stay in your Drive.** A new event can start immediately.

**🛑 Abort** — available in every state as the red escape hatch. It cancels
any stuck job, removes threads, wipes the bot's event data, and re-posts
fresh panels at the bottom of both channels — Drive files are never touched.
Use it whenever an event is wedged; it cannot be undone.

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
| Recommendation *k* | bot | their *k*-th live pick (declined ones don't take a column) |
| Rec. Status *k* | bot | `⏳ awaiting reply` / `✅ accepted` / `⏩ locked at launch` (blank if that slot holds no pick) |
| Rating *k* | bot | the participant's ⭐/10 for that anime |
| Review Link *k* | bot | the Google Doc for that anime |
| Review Length *k* | bot | characters written in it beyond the template |

The Recommendation / Rec. Status / Rating / Review Link / Review Length block
repeats as many times as the greediest participant asked for, numbered
(`Recommendation 1`, …, `Review Length 1`, `Recommendation 2`, …). If everyone
wants a single anime, the headers stay unnumbered. Live picks always sit left-packed,
so after launch each row reads cleanly from `Recommendation 1`.

**Row order and the Group column are the only inputs, and only while the
event is in Matching.** Once recommendations start, the assignment is locked
and the whole sheet is a dashboard.

---

## Timing cheat-sheet

| Thing | How fast |
|---|---|
| Sign-up count on the manager panel | instant when quiet; ≤ ~1–2 min during a burst |
| Threads + Santa missions at Start Recommending | ~5 participants per minute |
| Picks per person | 1–3, chosen by each participant at sign-up |
| Pick sent / approved / declined | instant (card + sheet cell update on the spot) |
| Recommending progress counts on the panels | instant at milestones; otherwise ≤ ~1 min |
| Review docs + assignment cards at Launch | ~5 docs per minute, then ~5 cards per minute |
| Review Length / started-writing / Rating in sheet & panel | every 30 min, plus on every **🔄 Refresh** click |
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

**How many anime do I get / do I recommend?**
You choose your own maximum (1–3) at sign-up; your Santa sees it on their
mission panel and may send fewer. You recommend for someone else up to *their*
maximum.

**I used up my Sorry😞s. Can I still decline?**
No — declining (even of a pick you first accepted) spends the budget, which
is shared across all your picks; when it's gone the decline buttons disappear. You can still press
**Thank you!😊**; either way the pick locks in at launch. Choose your
declines wisely.

**I said Thank you!😊 but changed my mind.**
Press the red **I changed my mind to decline it😞** on the card in your
thread — it works until the manager launches, as long as you have Sorry😞s
left.

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
Cards only obey their owner — find your own private thread and use the
buttons there.

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
