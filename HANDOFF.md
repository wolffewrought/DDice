# DDice — Handover

Everything a fresh session needs to work on this bot without reconstructing
it first. Written 2026-08-10. Keep it in the repo: the sandbox that builds
this file is wiped between sessions, so anything not committed is lost.

---

## 1 · What this is

A Discord bot for running tabletop campaigns. One file, `index.js`, about
1.2 MB and 19,900 lines. Node 22, discord.js 14, better-sqlite3, deployed on
Railway with auto-deploy from GitHub (`wolffewrought/DDice`, branch `main`).

Sixteen slash commands, 203 subcommands. Two rulesets behind one seam:
**Knightfall** (five stats, opposed rolls) and **D&D 5e** (SRD only, six
abilities, AC, proficiency). A server picks one with
`/config channels ruleset system:` and cannot change it once sheets exist.

Working on a phone: `index.js` goes to GitHub by hand, Railway deploys it.

---

## 2 · Getting a session started

The sandbox starts empty every time. Upload the repo zip, then:

```bash
mkdir -p /home/claude/ddice && cd /home/claude/work
unzip -o /mnt/user-data/uploads/DDice-main.zip
cd DDice-main && for f in index.js verify.js make_pdfs.py LIMITS.md \
  HANDOFF.md package.json nixpacks.toml README.md; do cp "$f" /home/claude/ddice/; done
cd /home/claude/ddice && node --expose-internals verify.js
```

`sh` here has no brace expansion — `cp {a,b}` fails with "cannot stat".
Use the loop above.

---

## 3 · The verify loop

**Run it before delivering anything.** One file, one command:

```bash
node --expose-internals verify.js        # everything
node --expose-internals verify.js scan   # scanners only
node --expose-internals verify.js test   # harnesses only
node --expose-internals verify.js -v     # list every warning
```

Green means 642 assertions passed and no scanner found an ERROR.

`--expose-internals` is not decoration: the scanners parse real JavaScript
with node's bundled acorn at `internal/deps/acorn/acorn/dist/acorn`. There is
no network in the sandbox, so npm cannot supply a parser.

`verify.js` sits beside `index.js` and reads it from there. It has six parts:

| Part | What it does |
|---|---|
| **structure** | A function or top-level binding declared twice (the second silently wins). A repeated object key. A call to a helper that no longer exists. Dead helpers, duplicated 256-char literals, async functions that neither await nor delegate. |
| **wiring** | A command or subcommand registered but never routed. A customId built but not dispatched, or dispatched but never built. An option read that no command declares. |
| **limits** | Every Discord ceiling in LIMITS.md §1–§3 checkable without a network call, plus the per-command character budget, printed every run. |
| **rulesets** | 5e code reachable on a Knightfall server: an ungated entry point, a hard-coded `RULES_DND5E`, a ruleset read bypassing `rulesFor()`. |
| **stubs + loader** | Fake discord.js, better-sqlite3, dotenv and canvas, installed by a require hook, then `index.js` executed for real against them. The discord.js half validates: it refuses anything the real API would refuse, at build time, naming the command. Teach it a new builder method before `index.js` uses one. |
| **harnesses** | `builders` (shape and ceilings, via the stub), `rules` (arithmetic of both damage models, 5e modifiers, `chunkLines`), `pins` (named regressions with the story attached). |

### Severity means something

ERROR fails the run and is provably wrong. WARN reports and does not fail:
it needs a human. Do not silence a WARN to get a green run — the twelve
standing ones are all correct-by-design and are listed in §6.

## 4 · House conventions

- **Patch with Python, not by hand.** Exact-string anchors, a count assert
  per anchor, write at the end. A failed assert persists nothing. Editing a
  1.2 MB file by eye is how functions get clobbered.
- **Deliver only what changed.** Code-only turn: `index.js` alone. Content
  change: the PDFs too. Never zips. Build scripts (`make_pdfs.py`) only when
  asked.
- **PDFs:** parchment is the reference edition. Six books total — Knightfall
  and DnD5e, each in Player / GameMaster / Parchment.
- **Ask before architectural changes.** Questions first, build after.
- **Plain language in user-facing text.** Every refusal explains what to do
  instead.

### The fall-through convention

The last subcommand in a handler is often reached without a comparison:

```js
if (sub === 'list') { … return …; }

// clean
const quests = …
```

This is deliberate and correct. The wiring scanner cannot distinguish it from a
genuinely unrouted subcommand, which is why `unrouted-subcommand` is a WARN.
Both `/gm test clean` and `duelok` work this way.

---

## 5 · Architecture notes

**The ruleset seam.** `RULESETS = { knightfall, dnd5e }`, read through
`rulesFor(gid)`, which defaults to Knightfall and survives a guild with no
config row yet. Each ruleset answers the same keys: `statBonus`, `hpStat`,
`maxHp`, `damage`, `defence`, `profBonus`, `gates`, `vocabulary`. Add a key
to one and you must add it to the other — a missing key reads `undefined`
and changes behaviour without throwing. `audit_rulesets.py` reports parity.

Gate 5e-only handlers on **capability**, not id: `rules.defence !== 'ac'`
reads better than `rules.id !== 'dnd5e'` and survives a third ruleset.
`handle5eStatus` is the model.

**Knightfall damage is a four-rung ladder.** One for a hit, one more for a
natural maximum, one more for the defender's natural 1, and one more again
for both at once. The pair beats the sum of its parts; that fourth rung is
easy to tidy away by accident and `rulestest.js` pins it.

**Colliding leaf names are fine where the group is read.** `/char show`
exists in both `view` and `profile`; `/standing view` in both `renown` and
`merit`. Safe because both commands call `getSubcommandGroup(false)` and
route on it first. A command that collides without reading the group would
send both leaves to whichever branch is written first.

**Dispatch:** `interactionCreate` handles autocomplete, modal submits, the
fight target select, buttons (via `routeButton`, inside a try that logs the
customId), then chat input commands.

---

## 6 · Standing warnings — all correct, do not "fix"

| Warning | Why it is fine |
|---|---|
| structure · `buildMemorial`, `renderDuel` neither await nor delegate | Both build strings. Harmless. |
| wiring · `/gm clean` never compared | Fall-through, §4. |
| wiring · `/config` groups never compared | The leaves route by name; the group is not consulted for `/config`. |
| limits · `/npc` at 24/25, `/quest` at 23/25 | Real headroom warning. See §7. |
| limits · two modals at 5/5 rows | LIMITS.md §2. No sixth field is possible. |
| limits · two descriptions at 95 and 98 of 100 chars | Real headroom warning; both still fit. |
| rulesets · `handleLibrary` ungated | See §7.3 — a judgement call, not a breach. |

---

## 7 · Open items

**1. FIXED — `/gm dc` free text moved onto the card row.** The customId now
carries ten numeric/short tokens; `on_fail` and `on_success` live in
`dc_cards.s_mark` / `f_mark`, keyed by the card's message and read on press.
A card older than the weekly prune loses its marks — the same graceful dark
a pressed button always had after a restart. Pinned so the text cannot creep
back into the id.

**2. `/npc` is at 24 of 25 leaves, `/quest` at 23.** The next subcommand on
either must join a group, as `/config` and `/gm` already do.

**3. `handleLibrary` has no ruleset gate.** A GM on a Knightfall server can
`/library srd` and import 5e spells and monsters. The rows are inert there,
so this may be intended — but the Knightfall books never document the
command. Flagged as a NOTE, not a failure.

**4. The test suite is a rebuild, not the original.** The pre-2026-08-10
suite (~2,500 assertions) lived only in a sandbox and is gone. What exists
now is 642 assertions covering structure, registration and ruleset
arithmetic. Behavioural coverage of quests, fights, the audit ledger and the
quiz system has not been re-accumulated. Add pins to the relevant harness in `verify.js` as each area is touched rather than attempting one large rebuild.

---

## 7b · NPC forum layout

The NPC forum folds **by category**: one thread per category, named after it
and carrying it as the applied tag, with every NPC in that category as a
single message inside. `npc_category_threads` maps `(guild_id, category)` to
a thread; `npc_pages` keeps its `(guild_id, name)` key, but `thread_id` now
points at the category thread and `message_id` at that NPC's own entry.

Three rules hold it together, and each fails quietly if it goes:

- **Home category is the first one assigned**, by `rowid`, not alphabetical —
  "designate them an enemy" is a decision and later categories are additions
  to it. An NPC in several still lists them all on their entry.
- **A moved NPC leaves the old thread before joining the new one.** Skip that
  and they stand in two threads at once, one of them stale.
- **Deleting an NPC deletes their message, never the thread.** The thread
  belongs to the category and the other NPCs are still in it.

`rebuildNpcForum` lays the whole forum out again and closes any per-NPC
threads the old layout left behind. It runs on `/config channels npcforum
channel:#…` (which defers first — the pass can outrun three seconds on a
large roster) and on `/gm check build:true`, so a server that adopts an
existing forum during setup gets it laid out rather than left half-migrated.

It is safe to run repeatedly, and that rests on one thing: **it must never
clear `npc_pages` first.** An early version did, which made every NPC look
new, so the second run posted a fresh entry beside the existing one and
orphaned it — the whole forum duplicated, silently. `mirrorNpcSheet` already
moves entries correctly on its own; the rebuild just walks the roster.

Uncategorised NPCs go to a single `Uncategorised` thread.

### The portrait forum mirrors it

`npc-portraits` (config key `npc_channel_id`) is laid out to match: the same
categories, the same thread names, the same tags. A GM hunting for a face
looks where they look for the statblock. `npc_portrait_threads` is its own
table — a category has a thread in each forum and they are not the same
thread — and `ensureCategoryThread` picks between them on a `kind` argument
resolved through the `NPC_THREAD_TABLES` whitelist, never from user input.

`ensurePortraitThreads` runs on `/npc categorycreate`, so a category's thread
exists in both forums before any NPC is in it, and again inside
`rebuildNpcForum`.

Three things to know if you touch the upload path:

- **Uploads land in threads, not the forum.** The handler accepts
  `message.channel.parentId === bankId` as well as a direct channel match.
  Only the parentId form fires for a forum bank.
- **Which thread does not matter.** The caption names the NPC; being
  forgiving beats refusing a portrait posted one thread over.
- **A text channel is still a valid bank.** Servers set one before this was
  a forum. `ensurePortraitThreads` returns 0 unless the channel is a forum
  (type 15), and captioned uploads in a text channel work as they always did.

Also fixed there: the handler used to answer *every* image posted anywhere on
the server with a warning when no bank was set, and then `return` — which
swallowed the rest of `messageCreate` for any message carrying an attachment.
It now stays silent outside the bank.

## 7d · Naming settled 2026-08-10

`/quest instance` already meant "run your own copy of a quest". The
subcommand that opens a thread for a started quest is therefore
**`/quest thread`**, not `/quest instance` — the forum is `quest-instances`
and this opens one thread inside it. The builders harness caught the clash;
without it, `/quest` would have carried two subcommands with one name and the
quest-copy feature would have died silently.

User-facing wording follows the channel: "party room" is now "quest thread"
throughout. Internal variable names (`const room = opened.thread`,
`born.room`) still say room and are invisible to users.

### `/gm check restart:true`

Tears down **everything the config points at** — all seventeen channels,
JSON-mapped forums included, plus the two DDice categories — then rebuilds
through the same `buildAllSetup` body that `build:true` uses. Scope is
deliberate and total: config at the moment of the confirm press decides the
list, regardless of who made the channels or what happened to them since.

Four guards, all pinned: it runs through `requestConfirm` with the cost
spelled out (**threads are unrecoverable — Discord has no undelete**; the DB
survives, the channels do not); it refuses to run from a channel on its own
teardown list, or the report would die mid-flight; it nulls every plan key
plus `docs_msg_id`/`docs_sha`/`quest_plan_tags` so the rebuild starts clean
instead of adopting ghost ids; and it wipes the derived maps (`npc_pages`,
both category-thread tables, `char_pages`, `npc_webhooks`) and nulls
per-quest thread references so nothing edits deleted threads. Quests,
sheets, rolls and history all stay.

### Sidebar order is enforced

**UNRESOLVED — under live investigation.** The plan order has failed to
land twice, two different ways: bulk `setPositions` over adopted channels
(18:36) and the per-channel edit walk over freshly-created channels after a
restart (21:21) produced the *same* systematic interleave — text channels at
every other slot among the forums, regardless of the numbers sent. Two
stories fit: the individual edits are being refused (Railway would show
`[setup] order <name> -> <pos>` lines), or Discord keeps **separate position
sequences per channel type** and merges them by raw value, in which case no
number assignment through these endpoints can force an arbitrary text/forum
interleave.

`applySidebarOrder` therefore now collects evidence instead of guessing:
every edit is verified against a `force: true` refetch, refusals are counted
and surfaced in the setup report, and **`/gm check order:true`** re-applies
the plan and prints wanted slot, type, raw position before → after per
channel, plus each category's raw sequences split by type. One screenshot of
that output settles which story is true. If it is the per-type model, the
plan must stop interleaving types within a category (the GM category already
complies: forums 7–14, texts 15–17) — reorder the open category to
forums-then-texts or texts-then-forums and the problem dissolves.

`run:true` still never touches positions. `lockPermissions` stays false
everywhere — re-parenting must never rewrite a channel's own overwrites.

### PDF source auto-seeded

`buildAllSetup` sets `docs_repo` to `wolffewrought/DDice` when nothing is
configured — the repo that ships all six books at its root — so the two PDF
channels fill themselves within the half hour instead of sitting empty until
someone finds `/config channels docs`. The watcher fires 30s after boot and
every 15 minutes; a fork overrides with `/config channels docs repo:`.

### Live-fire: `/gm test forum`

The structural pins prove the code says the right things; only Discord
proves it does them. `/gm test forum` runs the whole lifecycle against the
real API with `[test]`-prefixed fixtures: two categories open threads in both
forums, two NPCs land as entries, one moves home (the entry must change
threads), one is deleted (entry gone, thread stays), a category is deleted
(thread closes), then everything tears itself down. Each step reports ✅/❌
inline. Run it on a test server after any forum-path change.

### Category rename

`/npc categoryrename name: to:` renames **in place** — three UPDATEs across
`npc_categories`, `npc_category_members` and both thread tables. In place
matters: membership **rowids decide every member's home category**, so
delete-and-recreate would silently re-home NPCs whose first category this
is. The Discord thread and the forum tag follow, best-effort — thread
renames are rate-limited to ~2 per 10 minutes, so a second rename inside
that window keeps the mapping and the name catches up on the next sweep.
Renaming onto an existing category is refused; merging is `/npc
categoryassign` plus deleting the empty one.

### Portrait discoverability

`portraitHint(gid, npcName)` closes the loop: every NPC creation reply ends
with where to post their face — the exact category thread if the bank is a
forum, the channel if not, the config command if nothing is set.

## 7c · Patching discipline

Use `patchlib.py`. The house rule is "a failed assert persists nothing", and
`io.open(path, 'w')` breaks it: the file is truncated the moment it opens, so
an encoding error raised mid-write leaves zero bytes. `node --check` passes
on an empty file, so the loop reports green over a destroyed source. That
happened on 2026-08-10 — a mistyped surrogate escape (`\uD83C\uDFAD`
instead of `\U0001F3AD`) wiped `index.js`, and only a staged copy in the
outputs directory saved it.

`patchlib.save()` encodes the whole string to bytes first, refuses anything
implausibly small, writes to a temp file and renames it into place. The
target is never open for writing until the bytes exist.

Two habits alongside it: prefer literal characters over escapes when
anchoring on emoji, and never treat a passing `node --check` as proof a file
survived — check its size.

## 8 · Fixed 2026-08-10

**`sendLong` was declared twice**, twelve lines apart. The second won and
had lost the first's `if (!target) return` guard and its `.catch()`. Call
sites were written against the tolerant version — one hands it the result of
`channels.fetch()` unchecked — so a deleted channel took down the whole
interaction. Merged: the rich signature keeps `files` and `opts`, and
regains the guard plus a `console.error` so failures are visible rather than
silent. Pinned in `structuretest.js`.

Also this session: the whole verify loop rebuilt from scratch after the
previous sandbox was lost, and this document written so it cannot happen
again. **Commit `verify.js` and `HANDOFF.md` to the repo.**
