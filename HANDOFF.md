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

Green means 742 assertions passed and no scanner found an ERROR.

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
now is 742 assertions covering structure, registration and ruleset
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

- **Home is: first assigned category, else the coloured order on the sheet,
  else Uncategorised.** The order fallback means knights file under their
  colour automatically; a deliberate category assignment always outranks
  it, so splitting a shared pile like "Knights" into the coloured threads
  is one `categorydelete` — the orphans re-home to their orders. Both
  forums pre-create a thread per category AND per known order
  (`knownOrders` = distinct `npcs.order_name` ∪ `npc_orders` prefixes —
  data-driven, so a D&D server never grows knight threads and order threads
  carry no forum tag, protecting the 20-tag ceiling).
- **Within categories, home is the first one assigned**, by `rowid`, not alphabetical —
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

`ensurePortraitThreads` runs on `/npc categorycreate`, inside
`rebuildNpcForum`, and on `/config channels npcchannel` when it is pointed at
a forum — the manual set lays the threads out on the spot. That handler
accepts a forum or a plain text channel; `isTextBased()` is false for forums,
and the original text-only guard shipped a full day rejecting the intended
channel while `build:true` wrote the same config without complaint. If a
config subcommand's channel guard predates a type conversion, check it.

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

## 7j · /instance — one brain, two addresses (2026-08-12)

`/instance <verb> name: [run:] …` is a pure address translator: resolve the
listing by name (autocomplete shows "Name · #012", value IS the number, so
twins can't ambiguate; free-typed exact names accepted, ambiguity refused),
resolve the run by `run_seq` (blank = latest ACTIVE, else latest, else
"launch first"), then FORWARD into handleQuest with the run's number forced
— option names mirror /quest's own (`user`, `text`, `message`, `here`,
`force`) so the native reads inside the real handlers keep working. Verbs:
add(→approve)/kick/rally/note/pause/resume/complete/show/thread; every GM
gate is inherited, none reimplemented. Seventeen commands now; /instance
registers under both rulesets. Run naming locked at launch:
`<Quest name> Run 001 <GM display name>` (padded seq, first launch = 001,
questTag drops its dot-suffix — the name carries the convention, and the
thread wears it). A one-time christening (`meta.run_rename_1`, on ready)
sweeps every pre-existing instance: per adventure, runs renumber 001-up in
birth order, names recompose with the GM's display name, threads rename to
match, and the quest book resyncs. `/fight end all:true` (GM, confirm-gated)
ends every active fight on the server through the SAME closer as
single-end; every ended channel also releases any dc binds still holding
fighters there. Discord ordering rule bit once: required options must
precede optional `run` in add/kick/note.

## 7i · Listings stage; launches birth (confirmed revision, 2026-08-12)

Under `questspinoff`, approving used to birth a run PER APPROVAL — two
presses made two half-empty instances, live. The confirmed model:
**apply → hands up · approve → staged on the listing · launch → one run.**
`spinOffRun` now carries an array of seats; `launchListing` (shared by
`/quest start` on a listing and the 🚀 button on its post, GM-gated,
label wearing the staged count) clones once, seats the whole group, opens
the thread with everyone mentioned in, starts the clone's clock, announces,
and leaves the listing clean and recruiting — launch CONSUMES the stage.
Un-approved applicants ride along as the run's applicants. Listings carry
no clock and render their ledger: `Runs so far: K · Staged: N`. Spin-off
OFF is untouched. `questApplyButton(number, gid)` grew the gid so the
button can know what it sits on; all three callers pass it.

## 7h · Full cross-reference audit (2026-08-12)

Mandated sweep after the phantom table: every reference must have a
definition. Verify now carries four ERROR-class schema scans permanently —
tables in any SQL verb (SQL-keyword-anchored, so log prose is not a table),
literal INSERT column lists, literal UPDATE SET columns, and object keys
into the two dynamic upserts. Dynamic `${}` SQL is skipped.

Six conflicts found and fixed, in order of teeth: **npcs never had
`rerolls_current`** — the resource mirror shipped writing to a phantom
column, backfill swallowed, first live spend would have crashed exactly
like the arena; the audit's first run caught its own author. One `FROM
chars` survivor meant a character count read 0 since it shipped. The
reroll backfill ran per-boot — spent pools would refill on every redeploy;
now once, behind `meta.npc_rr_backfill_1` (spent-to-zero and never-filled
are the same value, so the flag is the only honest guard). The heal grant
fired on any edit — a stat tweak refilled a spent healer; now only when
creation or the gate's own inputs (order/wis) move. And rename/delete
refuse while the NPC stands in an active fight, because fight state keys
by the name-derived fighter id and both would orphan it.

All eleven standing warnings re-reviewed: known, documented, none stale.
One is half-retired by side-effect: `library-ungated` (§7.3) no longer
reaches Knightfall players, since `/library` never registers on Knightfall
guilds — the runtime gate question remains open only for mixed edges.

## 7g · The phantom table (2026-08-12, live outage)

Twenty-one ALTERs targeted `chars`; the table is `characters`. "No such
table" was swallowed by their catch on every boot since the day each
shipped, so **none of those columns ever existed**: the entire 5e character
layer (int/cha, level, class, hit die, AC, proficiencies, hit dice, spell
slots, concentration, weapon dice, prepared spells, conditions, temp HP,
inspiration, damage type, resistances) and two Knightfall fields
(`next_mark`, `deception_spent`). Reads survived because `SELECT *` simply
omits missing columns — undefined reads as 0 — so features half-worked;
the first live WRITE to name one crashed the arena mid-exchange
(`no such column: death_success`). All corrected, and verify now carries an
ERROR-class scan: every `ALTER TABLE x` must name a table some
`CREATE TABLE IF NOT EXISTS x` defines. Anything 5e-side written before
this fix was never persisted — those fields silently stored nothing.

## 7f · NPC resource mirror + GM overrides (2026-08-11)

NPCs now mirror player sheets in full: **rerolls** (pool = LCK, stored in
`npcs.rerolls_current`), **heal charges** for White Knights with WIS ≥ 5
(same `heal_charges` table, keyed by fighter id, granted on create/edit),
and **rest refills all three** under the same schedule settings as
characters. Three silent faults died here: `/npc reroll` decremented the
LCK **stat** itself ("temporarily", said the comment) and nothing restored
it; the rest loop `continue`d past any full-HP NPC, so resources behind HP
never refilled; and every fight seeded reroll tokens fresh from LCK, so
spends evaporated at fight's end. A one-time startup backfill sets every
pool to full (`rerolls_current = lck WHERE rerolls_current = 0`), which
also quietly amnesties the eaten-LCK era. `heal_charges` joined the delete
purge list and the rename migration in the same stroke.

**Overrides.** `/gm override skip [reason]` passes the current turn by the
same clear-and-advance idiom the machine uses, announced as a ruling.
`/gm dc … hold:true` binds the check to the fight in that channel: the
named target's fight actions wait (a choke at the top of `handleFight`)
until the card is pressed; `skipfail:true` makes a failed bound check pass
their turn too — but only if it is genuinely their turn at resolution.
The bind lives on the `dc_cards` row and clears either way; a pruned card
simply stops holding. The planned `/gm check` fold did NOT trigger: the
batch landed at 5796/8000, under the 6000 margin, so the promise stays
armed for the actual trip rather than breaking `build:true` syntax early.

## 7e · /npc folded, /npc edit, ruleset-pure pickers (2026-08-10)

The six `category*` leaves folded into one `category` group (25 leaves →
20), and `/npc edit` took a freed slot (21). Leaf names inside the group
deliberately reuse top-level ones — dispatch reads
`getSubcommandGroup(false)` FIRST and prefixes it back onto the leaf, so
the six category branches run unchanged. `/npc create` now refuses an
existing name (pointing at edit and copy) and `/npc edit` refuses a missing
one; both share one body via a `wantsEdit` alias. `/quest` (23) inherited
the most-crowded seat; the fold arithmetic is pinned so it cannot silently
unfold.

`/npc rename name: to:` (leaf 22) migrates by mirroring deleteNpc's purge
list as UPDATEs — inventory, roll_tally, renown_log, lore, deaths,
quest_members, quest_summaries, history — under the fighter id, then the
name-keyed layer: npcs, category members, page map, portrait record. The
page entry rewrites in place, the portrait caption is edited to the new
name, and webhooks are cleared (they bake the display name in) to remake on
the next say. A case-variant of another NPC is refused; changing only this
NPC's own casing is allowed. **If purgeSubjectRecords gains a table, the
rename's list gains the row** — the pin holds the two in step. Note the
earlier claim that export→import could rename was wrong: import applies the
payload's embedded name.

Registration is ruleset-pure per guild: `DND5E_ONLY` (`dnd`, `spell`,
`library`) never registers on Knightfall guilds, `KNIGHTFALL_ONLY` (`duel`,
`deception`, `standing`) never on 5e guilds, and `/config channels ruleset`
re-registers so the picker flips with the setting. Subcommands register
with their command and cannot be hidden this way — runtime gates remain the
backstop for `/npc create5e` and kin. The per-guild choice-injection map
chains off the filtered list (`commands.map`, not `slashCommands.map`) or
the filter silently un-applies; pinned.

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

### Portrait migration — `/gm check portraits:true`

Moves every stored NPC face into its category thread in the portrait forum
and repoints the NPC row at the re-hosted copy, making the forum the
canonical host. Discord signs attachment URLs with an expiry now, so
recovery is tiered: stored URL first; failing that, walk the source
channel's history for the attachment id and take the freshly signed URL;
only when both fail is the NPC named on the lost list. Idempotent by
`npc_portrait_posts` — live posts kept, re-homed NPCs moved, hand-deleted
posts replaced. Reads the old channel, never writes to it.

Two live faults found on first real run, both fixed and pinned. The
kept-check originally sniffed the stored URL for the thread id and fell
through to a fresh post when the sniff failed — duplicating the same face
into the thread on every run. **The record is the truth now**: a live
recorded message is kept and merely repointed at its freshly signed
attachment URL; nothing is ever reposted while the recorded message stands.
And `npc_orders` keys prefixes case-sensitively while the wear-time lookup
is `COLLATE NOCASE`, so `Black knight` beside `Black Knight` was one face
with an arbitrary winner — serving the stale dead URL after a fresh upload.
`setOrderFace` now collapses case-variants before writing, and the
migration's verdict folds stale variants into their healthy sibling instead
of telling the GM to re-upload a face they just set.

An export/delete/import round trip exposed three linked faults, all fixed:
`npcFace` read the order only from a pipe in the *name*, never from the
sheet's `order_name` — so a plain-named White Knight never inherited the
White Knight face, and pipe-named NPCs only appeared to inherit because
their personal face masked the gap. The chain is now personal → sheet order
→ name prefix → blank. The export payload never carried `image_url`, so
import rebuilt NPCs faceless; it now travels as `image`, behind a validator
that accepts only Discord CDN attachment URLs (imports are typed by hand —
the field must not make the bot wear arbitrary links; old payloads without
it import fine, faceless as before). And the migration filtered on
`image_url` alone, skipping exactly the resurrection case — an NPC deleted
and re-imported while their portrait still stands in the forum. It now
includes record-holders and repoints them from the live post.

Setting an order face is a bare-name caption (`White Knight`, no pipe) on an
image in the portrait bank. The set path now agrees with the wear-chain:
membership counts the sheet's `order_name` as well as pipe names, and a set
refreshes the webhooks of every wearer without a personal face.

**Order faces are deliberately not migrated** — `npc_orders` holds the
shared portrait each coloured order wears, not gallery entries. The verdict
therefore checks them: "safe to delete the old channel" is only said when
the lost list is empty AND no order face points outside the forum;
otherwise the channel is called load-bearing and the leaning prefixes are
named (re-upload each as `Order | Name` in the forum to free it).

The `/gm` budget margin pin moved 5400 → 6000 when this option landed
(5482/8000). Next trip of that line, fold `/gm check`'s options into a
group instead of moving the line again.

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
