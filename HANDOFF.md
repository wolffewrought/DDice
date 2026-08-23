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

Green means 950 assertions passed and no scanner found an ERROR.

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
now is 950 assertions covering structure, registration and ruleset
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

## 7m · Character forum mirrors the NPC forum (2026-08-13)

`ensureCharPage` upgraded to mirror-grade: one thread per character
(existing lore threads upgraded IN PLACE — starter becomes the living
sheet via `charPageBody`, posts below never touched), tags = the eight
colour orders + three classes + `Fallen` (12/20; Kalidale is a force and
Siege Knight a class, per T — neither is an order tag), thread renames
with the player. Every sheet edit re-mirrors through the stats handler's
`done()`; kill/revive re-mirror at dispatch so the Fallen tag follows the
deed; `/gm check build:true` sweeps every character as the manual twin.
`charThreadMigration` (`char_threads_1`) drags all existing characters in
on first boot, born with the v2 discipline: counts, honest flag, first
error named on a vacuous run.

Four-block threads (T-directed): starter = sheet (event-live via done()/
kill/revive), then bot-owned **Inventory · Lore (approved) · Dice** blocks,
ids in char_pages (inv/lore/rolls_msg_id), contents hash-compared
(block_hashes JSON) so unchanged blocks cost zero API traffic. The hourly
sweep (`startCharBlockSweep`, first pass 90s after boot) is the only thing
that touches Dice — the chatty source — answering T's strain question with
a hybrid: rare things live, frequent things batched. ensureCharPage grew a
scope param ('sheet' default for hooks, 'all' for migration/build/sweep). The Dice block
walks the fixed ladder d2/4/6/8/10/12/20 in T's order (unrolled dice say
so; exotic sides append), each row: rolls · average · nat 1 × / nat MAX ×.

## 7n · The rest storm (2026-08-13, live)

The autorest tick's fired branch ran the rest, announced, logged — and
never wrote `last_run`. The advance almost certainly lived inside the old
rest block the resource-mirror rewrite replaced; the excision span
swallowed it. Once the 12h schedule fell due, every 10-minute tick refired
and re-announced forever. Fixed: `upsertSchedule({ last_run })` immediately
after `runAutoRest`, BEFORE the announcement so a failed announce can't
refire; pinned with the ordering. Live mitigation until deploy:
`/gm autorest action:pause` (or `resume`, which resets the clock).

Five-block order (T): Sheet (starter) · Inventory · Lore · **Standing**
(merits/renown totals + last 8 renown_log lines) · Dice; standing_msg_id
joined char_pages. **GM sheets are private by absence** — forums cannot
hide a thread, so a GM's character simply has none (existing thread deleted
on next touch; demotion/promotion self-heals). **Hero** joined the tag
canon (13/20), applied from characters.is_hero. GM privacy upgraded from
absence to LOCATION: `gm_char_forum` (config `gmcharforum`, SETUP_PLAN
`gm-character-sheets` #18 under the GM category, inheriting its perms).
ensureCharPage routes by role; a thread in the wrong forum after
promotion/demotion is deleted and rebuilt where they belong. No GM forum
set → absence, exactly as before.

All-automatic on push (T): `forumSetupMigration` (`gm_forum_lock_1`) births
gm-character-sheets under the GM category wherever it exists and locks the
player forum staff-only (deny @everyone SendMessagesInThreads/Create*,
allow gm_role_id; skipped with a log if no gm role — Discord cannot let a
bot grant itself permissions). A sixth **notice** block ends every thread
with T's exact wording ("…contact a Moderator or Expeditioner. Thank
you!"); notice_msg_id joined char_pages. New-server arrival now audits the
bot's own permissions and names anything missing in the greeting; existing
servers are never audited unprompted — build:true remains their lever.

## 8e · Two quest logs, two audiences (2026-08-16)

Per T: the auto summary (timings, events, payouts) now posts to a NEW
GM-only channel `gm-quest-log` (quest_log_gm, plan gm:true);
`quest-chronicle` stays player-facing and carries the GM's OWN telling.
`complete` gained `summary:`; `/quest run log number: text:` writes or
rewrites afterwards — postQuestTale edits the existing post in place
(found via the stored url) rather than stacking tellings, and UPDATEs
quest_summaries.url so every participant's record points at the tale.
Records prefer taleUrl, falling back to the GM summary only if no tale
exists. The completion reply nudges for a tale when none was given.

### 8e addendum · chronicle as a per-player forum (2026-08-16)

quest-chronicle is now a FORUM with one thread per adventurer
(chronicle_threads ledger; thread named after them and renamed if they
rename). A tale is MIRRORED into the thread of everyone who was there —
each copy located via that player's own quest_summaries.url and edited in
place on a rewrite, so retelling never stacks; every record links that
player's own copy. 150ms paced. Cost accepted knowingly: a six-player
quest stores six copies, which is what makes each thread readable alone.

## 9a · Two examples books, published to their own channels (2026-08-21)

The Examples book split in two by AUDIENCE, using the existing ('aud', ...)
marker rather than a new mechanism: DDice-Examples-Player.pdf keeps dice,
characters, fighting, quests and feedback (7 pages); DDice-Examples-
GameMaster.pdf adds NPCs, buttons and targets, group checks, recaps and
titles (12 pages). Verified by reading the built PDFs back — '/npc say'
and '/button group' appear only in the GM one.

Both joined DOC_FILES, and docFilesFor now exempts anything starting
'DDice-Examples-' from the DnD5e/Knightfall prefix filter, since the pair
is system-free. publishDocs already split GM channel from player channel;
the player side now sends TWO files (commands + examples) instead of one.
Pinned all three facts.

NOTE for T: the books are fetched from GitHub by publishDocs, so both new
PDFs must be committed to the repo alongside index.js or the player
channel post will fail to find them.

## 8z · Rests land on the hour (2026-08-21)

T: the auto-rest should go off the nearest hour, not the minute the
schedule happened to be created. `floorHour(ms)` now floors BOTH sides of
every comparison and every write — the due check, the seeding write, the
advance after a rest fires, `resume`, and the 'next due' display, which
would otherwise promise a time the bot no longer keeps. A 12-hour rest set
at 14:37 now falls due at 02:00, and 14:00 thereafter.

Granularity worth knowing: the tick runs every 5 minutes, so a rest lands
between :00 and :04 rather than on the stroke. The rest-storm pin was
UPDATED to the aligned form rather than deleted, so it still guards the
clock-advance whose absence caused the 10-minute announcement spam.

## 8y · Audit after the clarity batch (2026-08-21)

946 assertions, 13 probes, warnings 19 — all previously documented.
Cross-checked the batch rather than trusting it: fighterStateLine guards a
missing fight, handles NPC fighters, parses effect_state defensively and
bounds its output; making announceNextTurn async propagated correctly —
both call sites await, including through the handOver arrow; the group
tally and the recap both cap their length and their item counts; three
database reads per turn announcement, which is nothing.

NEW PERMANENT RULE, born from my own near-miss: the habits scanner now
walks the AST for plain strings containing ${...} — a template literal
written with the wrong quotes, which prints the braces verbatim. I nearly
shipped exactly that in the disarm headline yesterday and caught it by
eye. The file is clean of them today (0 across 1.4MB), and none can be
added silently now. This is the second scanner rule this month written
from a mistake rather than a theory, which is the right way round.

### 8x addendum · every ability names both sides (2026-08-21)

Deception already read '**Deception** — A vs B'; the rest were bare nouns
('Disarming Attempt', 'Shield Deflection', 'Feint Resolved', 'Escape
Attempt') that made a busy channel unreadable. All four now name the doer
and the done-to, in Deception's shape: **Disarm** — A vs B, **Deflect** —
A shields against B, **Feint** — A vs B, **Escape** — A against B's hold.
Pinned positively (each new form present) AND negatively (no bare-noun
headline survives), so a future card cannot quietly regress to one.

## 8x · Fight state, said out loud (2026-08-21)

T: a grapple persists until released, escaped, or someone falls — so the
table should not have to remember it for five rounds. New
`fighterStateLine(guild, gid, cid, fid)` renders everything currently true
about a fighter and rides the TURN ANNOUNCEMENT, where people are already
looking: held by whom (with the consequences), holding whom (with the
release/no-strike rule), a pending flat-d20 defence, a banked +2 riposte,
a GM adjustment or forced stat, a feint they fell for, and any adv/dis/
flat mark on their sheet. Indented under the turn line so it reads as
context rather than noise.

Also: the end-of-turn strain now names the holder every round ('X is still
held by Y — 1 strain') instead of an anonymous 'the hold takes its toll',
and the disarm card titles itself with both sides ('Disarm — A vs B').
Note the near-miss: the disarm headline was inside SINGLE quotes, so the
names would have printed as literal ${actorName}; converted to a template
literal and eyeballed before pinning.

## 8w · [undefined, undefined] and a 14 that failed a DC 10 (2026-08-21)

T's screenshot: a WIS check vs DC 10 printed '1d20+5 (disadvantage) ->
[undefined, undefined] +5 = 14' and then 'Failed.'

Investigated by EXTRACTING the real functions (parseNotation, rollDie,
rollNotation, rollAdvantage/Disadvantage, buildRollLine, rollDcCheck) into
a scratch file and running them — the current path is correct in all three
modes and judges 14 vs 10 as a pass, so that card came from a build older
than the workspace. Rather than leave it at that, both symptoms are now
impossible by construction:

1. buildRollLine falls back to result.rolls when `chosen`/`dropped` are
absent, so a caller pairing an adv/dis MODE with a plain roll prints the
faces it actually rolled instead of a hole. Verified against exactly that
mismatched call.
2. rollDcCheck treats a non-finite DC as NO DC (passed = null) rather than
comparing against NaN, which is the only way a 14 can lose to a 10; and
`nat` falls back to rolls[0] so an absent `chosen` cannot silently skip
the crit rules.

Both pinned. Worth keeping the extraction trick: pulling functions out and
running them answered in two minutes what three rounds of reading could
not.

## 8v · Group checks and session recaps (2026-08-20)

Two RP tools T picked from six suggestions, both free of any external
service.

**`/button group stat:|dice: dc: reason:`** — one check the whole party
rolls. Everyone presses once (group_check_rolls enforces it), the message
itself is the scoreboard and re-renders on every press, and a GM-only
'Call it' closes the scene with a verdict counting passes against the DC
('4 of 6 made it. Most of the party is through.'). Nat 20s and 1s are
marked. Rides the shared rollDcCheck, so it cannot drift from /gm dc, and
presses log into the quest timeline like every other roll.

**`/quest run recap number: [post:]`** — drafts a 'previously on…' from
quest_events: the party by name, up to twelve roleplay/combat/note beats,
then how the rolls fell. DRAFTS, deliberately: it replies privately for
the GM to edit, and only reaches the party with post:true. It can only
know what was written down, which is itself an argument for logging.

Both documented in the GM books and in the Examples book.

## 8u · Plain language and the Examples book (2026-08-20)

Measured the books rather than guessing: Flesch reading ease across every
prose block, median 71.6 (plain English) but a tail at 40-58 — the 5e
rules paragraphs, which packed three ideas into one sentence. Rewrote the
four hardest into short sentences with one idea each (saving throws,
attacks, initiative, what a fight is). Median now 71.9 and the tail is
52+. The remaining hard blocks are 5e TERMINOLOGY, where the jargon is the
subject and simplifying it further would make it wrong.

New seventh book: **DDice-Examples.pdf** — a worked 'what you type / what
happens' pair for every part of the bot, written for a child: dice,
characters, fighting (including nat 1 and nat 20 in plain words), quests,
NPCs, buttons and targets, titles and groups, feedback. It reuses the
existing build() by swapping CONTENT, so it inherits the covers, contents
page and furniture for free; system-free, so one copy suits both
rulesets. Median reading ease in the low 80s.

## 8t · Audit: the fifth idle path (2026-08-20)

Sweeping the fight-effect fix rather than trusting it found a FIFTH
transition to idle — the quest-thread stand-down, which stands a fight
down when its run ends. It still left the carries behind, so the leak
survived in one lane after being fixed in four. Closed, and the pin now
counts every `state: 'idle'` declaration and demands an effect_state reset
inside the same upsert, so a sixth path cannot be added without one.

That is twice in one day a pin written by counting MATCHES rather than
DECLARATIONS would have passed a broken file. Worth remembering as a
habit: pin the property over every site, never over the sites you happen
to have found.

Everything else cross-checked clean: the Associations block is plumbed
through bodies/ids/order/seq/update//char show, rebuildCharPages routes,
the mend lock wraps the inner function, the stray sweep runs after the
ids are written, titles purge with their subject, /dd routes and
autocompletes. Warnings 19, all documented — nine are the fall-through
class from the folds, which the scanner cannot see through by design.

## 8s · Carried effects leaked between fights (2026-08-20, live)

T's screenshot: a practice bout began at 01:14, Fenrir had not attacked,
and at 01:17 his first defence rolled a FLAT d20 'fumbled last attack'.
The sanction was real — from an earlier brawl in the same channel.

Cause: effect_state lives on the fight ROW, which is reused per channel.
Two of the three start paths reset it; the third (practice bouts and
duels) did not, and NO end path cleared it at all — so carries survived
both the end of one fight and the start of the next. The books have
promised 'leaving a fight clears any pending effects' since the carries
were written; the code never did it.

Fixed at both ends: all four idle-transitions now write effect_state
'{}', and the third start path clears effect_state AND grapples like its
siblings. Pinned by counting declarations rather than blocks — the first
attempt matched only two of three start sites and would have passed a
broken file.

## 8r · /dd — a GM writing as the bot (2026-08-20)

T's reason, and a good one: when a GM also plays a character, a DM from
their personal account blurs the two and the player has to guess which is
speaking. `/dd user: message: [as:] [quiet:]` sends it through the bot
instead, headed either 'The Game Masters of <server>' or a named NPC
(`as:` autocompletes the roster). The footer names the GM who sent it
unless quiet:true, and the roll-audit book records sender, recipient,
voice and text EITHER WAY — an unattributable channel to players is a bad
thing to build, so quiet hides it from the player, never from the record.
Closed DMs are reported to the GM rather than swallowed. Commands 20->21.

## 8q · Titles and Associations split apart (2026-08-20)

T: they are meant to be separate. Two renderers now (`titlesOnly`,
`assocsOnly`) feeding two blocks — Titles and Associations — with
assocs_msg_id joining char_pages and the order becoming Sheet, Inventory,
Lore, Standing, Titles, Associations, Dice, Notice (eight blocks).
`titlesLine` survives for the NPC SHEET, which is a single message and
shows both together — splitting there would mean two messages per NPC for
no gain. /char show renders both, in order. Existing threads gain the new
block on the next mend; the order contract reshuffles them.

## 8p · /gm check pages — the blunt instrument (2026-08-20)

T's threads were still doubled after deploying the lock+stray fix. From
here I cannot tell whether the fix was actually live or whether the sweep
failed for a reason the code does not surface — so rather than guess a
third time, this adds a lever that REPORTS. `/gm check pages [user:]`
deletes every bot message in a character thread except the starter
(author-checked; players' posts are never touched), forgets the recorded
ids and hashes, and re-posts a clean set in order. It replies with counts
— pages rebuilt, blocks cleared, any that REFUSED to delete and why — so
a thread that will not clean tells us what is stopping it.

A probe for the stray sweep was attempted and abandoned: driving the
whole /gm check run path through the fake gateway needed more scaffolding
than the answer was worth. Noted as the honest limit of the probe harness
today — it can prove structure and idempotency, not yet whole workflows.

## 8o · The duplicate-block race (2026-08-19, live)

T's threads showed two of every block. Cause: adding `bootMend` put a
second mender on the same characters as the 90-second sweep. Both read
char_pages before either wrote it, both saw the new Titles block missing,
and both posted a full set — a textbook read-modify-write race, created
by me the same day the Titles block landed.

Two fixes. `charMendLocks` (an in-process Set keyed guild:user) admits one
mender per character; the loser returns 0 rather than queueing, because a
mend that just ran has nothing left to do. And a stray sweep: the char
forum is locked to players, so EVERY bot message in a thread is a block —
anything not currently recorded in char_pages, and not the starter, is a
leftover and is deleted (50-message window, 150ms paced). That clears the
duplicates already posted on T's server without anyone tidying by hand.
Both pinned.

## 8n · Audit: the deleteNpc scope bug (2026-08-19)

Three findings, all fixed.

**1. deleteNpc was reaching for `interaction`** — a variable never in its
scope (the function takes gid, name). The ReferenceError fell straight
into the surrounding try/catch, so the code after it never ran: an NPC's
forum thread AND their npc_pages row survived every deletion, and a
same-named replacement would adopt the orphaned thread. My edit had
landed in the helper instead of the handler weeks ago. Now takes an
optional `client`; all four callers thread one through (sweepTempNpcs
gained a client option so the fight-end sweep passes the guild's).
Pinned that the body contains no `interaction.` at all.

**2. Titles and associations were not purged with their subject** — only
the revoke commands deleted rows, so deleting a character or NPC left
theirs orphaned and inheritable by a same-named successor. Added to
purgeSubjectRecords, which both deletion paths already call.

**3. handleTitles fell through** on revoke/remove rather than naming the
leaves — the same smell fixed for /feedback send. Named explicitly;
unrouted-subcommand warnings 6→5.

## 8m · Mend on boot (2026-08-19)

Root cause of T's missing Titles block: `/gm check run` never rebuilt
character or NPC pages. The full-scope rebuild lived only in ANOTHER
function, so the lever a GM naturally reaches for after an update did the
forums and skipped the pages — new blocks could only arrive on the hourly
sweep. Now one `mendEverything(client, guild)` does the lot: forum
threads (approvals, feedback, quest books), every character page and NPC
page at full scope, and the permission sweep. `/gm check run` calls it and
reports what it did.

`bootMend(client)` runs it on EVERY boot for guilds that are already set
up — T's ask: an update should bring new threads, channels and features
into being by itself. Two guarantees, both pinned: it only ADDS (the body
contains no setPosition/setParent/setName/setConfig, so a quest board you
moved and renamed stays exactly where you put it), and a guild that has
never pointed the bot at anything is skipped entirely, so the bot never
conjures channels into a server that did not ask.

## 8l · Titles & Associations (2026-08-19)

Two tables keyed by FIGHTER ID (subject_titles, subject_assocs), so a
player and an NPC are recorded identically — bare user id, or npc:Name.
One renderer, `titlesLine(gid, sid)`, feeds all three surfaces: the
character thread's new block, the NPC page body, and /char show. Block
order is now Sheet · Inventory · Lore · Standing · **Titles** · Dice ·
Notice — titles sit beside Standing because both are what someone has
earned; titles_msg_id joined char_pages and the order-repair sequence.

Commands on /standing (which already held renown): `title grant|revoke|
list` and `association add|remove|list`, each taking `user:` OR `npc:`
and refusing both. `association list group:` inverts the question and
names everyone standing with a company. GM-gated for changes, open for
looking. `/quest run complete title:…` grants a title to every survivor,
stamped with the quest it came from.

Found while building: the quest completion's `summary:` option had been
LOST in an earlier rewrite — the handler read it, nothing declared it, so
a GM's telling could never be given at completion. Restored, and pinned
that the options the handler reads are actually declared.

## 8k · The /npc manage fold (2026-08-19)

/npc was at 23/25; folded to 18 by grouping the WORKSHOP verbs — copy ·
rename · export · import · sync · create5e — under `/npc manage`. The
principle, chosen deliberately: fold what is rare, keep what is daily.
say, show, list, hp, heal, roll, hero, edit and the rest stay one
keystroke away; only the things a GM does occasionally moved. Dispatch
unchanged (getSubcommand returns the leaf; names stay unique). 21 taught
strings regrammared across index.js and the books.

Pin replaced: '/npc is now the most crowded command' asserted a fact the
fold made false — it now reads 'no command is within two leaves of the
25 ceiling' (max is 22, /gm), which is the property actually worth
holding. A second pin keeps the daily verbs out of any group.

## 8j · Audit after the temp-NPC layer (2026-08-19)

892 assertions, 13 probes, warnings 19->18. One real finding, fixed: a
dead `handleNpcTemp()` — a superseded first draft of the temp group's
handler, 2091 bytes, never called because the live routing folds the
group into templist/tempkeep/tempclear and handles them inline. Two
truths in one file is how they drift; deleted, and the structure scanner
is clean of dead-function again.

Also noted, NOT acted on (T's call): **/npc sits at 23/25 leaves+groups**
— the same wall /gm and /quest already hit. The natural fold when it
comes is a `roster` group (list · show · copy · rename · delete) or a
`sheet` group (hp · heal · hero · edit). Deciding before the wall is
cheaper than deciding at it. The `library-ungated` warning is
pre-existing and documented in §6.

## 8i · The GM log tells the whole evening (2026-08-19)

T asked what reaches the quest summary; the honest answer was: NPC speech
(rp) and combat headlines did, via noteQuestActivity, but `/gm dc` — the
most-used tool at the table — did not, leaving silent stretches in the
GM log where the party had been rolling all evening. Now runDcRollPress
writes a 'roll' event (who, face, total vs DC, passed/failed) into every
active quest in that channel. Temporary NPCs joined too: `/library summon`
logs what stepped out of the library, and `/target` logs both the thing
standing up and the moment it falls (with its hit count). All go through
noteQuestActivity, so a PAUSED quest still records nothing — that
contract is unchanged. Pinned.

## 8h · The audit setup, ported from Sec-Track (2026-08-19)

Three tools, T's ask. The Sec-Track originals were browser-PWA specific,
so the ideas ported, not the code.

**probe.js** (`node --experimental-sqlite probe.js`) — the runtime half
verify.js never had. Loads index.js against a fake discord.js (builders
that record their own shape, channels that record what was sent) and a
REAL in-memory SQLite via node:sqlite behind a better-sqlite3 shim, then
drives the captured interactionCreate handler with synthetic commands and
presses. 13 probes: schema completeness, every ALTER lands, every emitted
BUTTON id reaches a handler (modal/select ids excluded by reading the
builder above each setCustomId), unknown command/button safety, migration
ledger completeness, and RESTART SURVIVAL — the ready path run twice with
table counts compared, which is precisely where the vacuous-migration bug
lived.

**FIRST RUN FOUND A REAL BUG:** 173 of 178 top-level schema ALTERs sat
ABOVE the CREATE TABLE block. On T's live database the columns exist (the
tables predated the statements), but on any FRESH install each ALTER fails
into its own catch and the column never appears — six of them (backup_*,
npcs.rerolls_current, fights.auto_npc) were in no CREATE either, so a new
server would query columns it did not have. All ALTERs moved below the
whole schema; pinned so it cannot regress.

**check.js** — runs both, compares against .check-baseline.json, prints
the DELTA: assertions/warnings/commands/customIds moved, and crucially
what DISAPPEARED (a pin, a table, a command, a migration flag). Absolute
health looks identical whether a pin is deleted or not; the delta does
not. `--save` accepts current state; commit the baseline with the source.

**verify.js gained a fifth scanner, `habits`** — the transferable layers
from audit.js: swallowed writes, drift (copy teaching an unregistered
command), stale grammar (pre-fold `check x:true` forms), and triplicated
long strings. Warnings 13→16, all three new ones triplicated-copy.

## 8g · /target — temporary targets (2026-08-16)

T's design, and a good one: no HP, no sheet, no roster entry — the GM's
verdict IS the death check. `/target create name: dice:|stat: dc: reason:
for: secret:` plants a message with an Attack button; temp_targets is
keyed by that message id, so the button carries no state and a restart
loses nothing. Each press rolls (rollNotation or the shared rollDcCheck),
posts publicly, bumps hits, logs into the quest timeline via
logButtonPress, then asks the GM — in-channel by default so the table
feels it, in quest_log_gm (falling back to roll-audit) when secret:true.
Option A-with-switch, chosen by T over DMs. 'It falls' disables the
target's own button (edited to a struck-through corpse line) and marks it
dead; 'It holds' leaves it standing. Only GMs may answer; a fallen target
refuses further swings; `for:` addresses it as buttons do.
Commands 19->20.

## 8f · /button — planted buttons (2026-08-16)

GM plants a button in a channel; anyone may press it. Three kinds:
`check` (stat or flat d20 vs DC, riding the shared rollDcCheck so it
cannot drift from /gm dc), `roll` (a validated dice expression), and
`feedback` (opens the exact picker /feedback send opens). Everything a
press needs is encoded in the customId — btnchk:<stat>:<dc>:<once>,
btnroll:<dice>:<once>, btnfb — so buttons survive restarts with no state
to lose; button_presses exists solely so `once:true` can hold a player to
a single go. Handlers live in routeButton per the lane discipline.
Commands 18→19. Extended same day: `for:@player` addresses a
check or roll button to one person — encoded as the customId's last
segment ('any' when open), enforced on press, and the planted message
mentions them. Note the near-miss caught in build: the first splice left
TWO allowedMentions keys in one send object, where the later would have
silently won and killed the mention. Then merged per T into ONE leaf
`/button roll` taking dice OR stat (never both, refused rather than
guessed), an optional dc, `reason` for flavour, then `for`/`once`/`label`
— T's order. Both kinds now carry the dc in the customId
(btnroll:<dice>:<dc>:<once>:<owner>). New: `logButtonPress` writes a
`roll` quest event when the press happens in an active quest's channel or
thread, so presses reach /quest timeline and the GM's completion log;
outside a quest nothing is written. QUEST_EVENT_ICON gained `roll`.

## 8d · Third-pass audit (2026-08-16)

Structural angles this time. No duplicate function or top-level const
declarations anywhere in 1.36MB (the silent-override class). 32 sites build
SQL with interpolated COLUMN names; every dynamic key traced to either an
internal constant or a Discord choice-constrained option (Discord validates
choices server-side), so no arbitrary column can reach a statement — and an
unknown key would throw loudly rather than corrupt. Process-level
unhandledRejection/uncaughtException nets present. Message ceilings hold:
feedback card worst case ~1830/2000, blocks capped 1900, modal inputs
1500. ONE finding fixed: stacked `/gm override interject` notes concatenated
unbounded into the exchange card — now capped at 200 chars, pinned.

Diminishing returns noted: three passes over the same batch; the next
audit should wait for new code rather than re-reading this one.

## 8c · Second-pass audit (2026-08-16)

Deeper sweep, different angles from 8b. Lane placement verified against
the loredoc lesson — fbq in routeButton, fbcat in the select lane (first
branch, reachable), fbm after isModalSubmit; no customId prefix emitted
more than twice. Migration flags all appear in the ledger (5/5). Permission
sweep covers what forums need (CreatePublicThreads, ManageThreads). One
real finding fixed: `/feedback send` was never compared — anything not in
the category group fell through to the picker, so a future leaf would have
silently opened it. Now named explicitly with an unknown-leaf refusal;
warnings 14→13. Everything else green.

## 8b · Feedback post-audit (2026-08-16)

Two of my own defects found by audit, both fixed. (1) The forum was built
but EMPTY on T's server: neither setup path called ensureFeedbackThreads.
Now called beside ensureApprovalThreads in both, outcome reported in run,
pinned at both sites. (2) The plan entry invented a `feedback_forum`
column plus a bridge, when siblings (approvals, roll-audit) declare
`json: 'forum'` and let the planner write the routes blob directly —
realigned to the idiom; the legacy column is still read once so anyone who
ran the interim build is carried over. Everything else verified clean:
three customIds round-trip, select menu within Discord's 25/100/100 caps,
slug collision guarded, built-ins unremovable, quest button id bounded at
80 chars, card sends to exactly one thread with mentions suppressed.

## 8a · Player feedback (2026-08-16)

`gm-feedback` forum (SETUP_PLAN, GM category — so players cannot see the
threads at all), one thread per room via the shared ensureForumThreads
mender: General · Quests · Encounters · System · Mechanics · DDice bot ·
GMs, plus custom rooms from `/feedback category add` (slug-keyed in
feedback_cats so renames keep thread ids; built-ins cannot be retired).
`/feedback send` → ephemeral category SELECT → modal (scale 1-10 +
prose) — Discord modals cannot hold dropdowns, hence the two-step. A
finished quest posts a feedback button (fbq:<questTag>) straight to the
same modal with the room pre-set to Quests and the run named on the card.
The card shows the author (T: GMs see who spoke) with a star bar; every
player-facing step is ephemeral (T: other players see nothing) — pinned
by reading whole reply statements, after a naive up-to-first-brace regex
gave three false positives on ${name} template holes. Commands 17->18.

## 7z · Post-batch audit (2026-08-15)

Clean. 826 assertions, 102 pins, four schema scans, config keys, 13
warnings (3 = check-fold artifacts, documented in 7x). Cross-checks:
healChannelPerms proven position-safe by scan (no setPosition/setParent/
position:, writes me.id only — T's explicit worry, now machine-enforced);
channelCreate watcher carries both guards; interject's three consumption
seams verified (stat in runFightAttack covering slash AND button replay,
plus the def handler; mode via next_mark; die guarded to cast rolls only);
new columns all defined before use. ONE open question left with T, not
changed: /gm reroll rewrites atk_nat/def_nat, so a rerolled roll discards
a GM's `interject die:` declaration — reroll currently wins.

## 7y · Channel permission sweep (2026-08-15)

`healChannelPerms(guild)` walks every non-category channel, computes the
bot's missing CHANNEL_PERMS, and writes its OWN overwrite where it holds
ManageRoles in that channel — granting only what it already holds
guild-wide (Discord's rule). Called by `/gm check run` and `/gm check
build`; `channelCreate` heals new channels at birth; `/gm check status`
audits read-only and names the gaps. 150ms paced. **Pinned: permissions
only — the heal never touches position or parent** (T asked explicitly
whether this would reorganise anything; it cannot). What code cannot do is
grant the bot permissions it lacks: blocked channels are named for T to
fix on the role. Recommended to T: hold the working set guild-wide on the
DDice role so new channels inherit and nothing needs healing.

## 7x · The /gm check fold (2026-08-15)

The prophesied fold, executed: check is a GROUP of seven leaves (status ·
run · build · restart · order · migrations · portraits). handleCheck gains
a two-line shim — `opt(name)` returns leaf===name when the group routed,
else the old boolean — so registrations still propagating keep working and
the handler bodies moved zero lines. Route: gmSub==='check' OR
group==='check'. Every taught string regrammared (14 in index, 6 PDF rows;
bare `/gm check` references now say `check status`). gm budget 6147/6200 —
breathing again. Warnings 10→13: three `unrouted-subcommand` on
build/restart/migrations are fold artifacts — they route through the
dynamic `opt()` comparison the scanner can't see; the warn class exists
exactly for human-confirmed fall-throughs, confirmed here.

## 7w · /gm override interject (2026-08-15)

T's ask: interrupt auto paths and bend a player's current-or-next roll.
One mechanism, no timing option: the adjustment (±10, sums, note joins)
is stored in effect_state as gmAdj and CONSUMED AT THE RESOLVER — the one
choke every path (manual, NPCs-only, full auto, feint) flows through — so
"current" and "next" collapse into "earliest unresolved roll". Applied to
atk_roll/def_roll by role, announced on the exchange card ("⚖️ GM
interjection: +2 to @X's roll — reason"), publicly announced at apply
time, roll-audited, cleared with the other effects on leaving. Budget pin
raised 6000→6200 for the leaf's legible prose (Discord wall is 8000);
pin's variable corrected to the local `budget` after two timeout scares
that were actually a ReferenceError plus sandbox slowness.

Extended same day per T: interject now wields THREE levers in any
combination — amount (as before), mode (adv/dis/flat, written to
characters.next_mark so the existing mark machinery consumes and speaks
it), and a FORCED STAT (effect_state.gmStat). The stat force is consumed
inside runFightAttack (covering the slash command AND the target-picker
button replay with one seam) and in-handler on the defence side; the roll
label says "⚖️ stat set to DEX by the GM". Honest boundary, documented:
amount can bend a pending roll; mode and stat bind the NEXT roll made — a
cast die keeps its shape. gm budget 6198/6200 after option prose — the fold of /gm check's options
into a group is now MANDATORY before the next /gm tenant.

Same day again: option order set to T's sequence (user · stat · amount ·
mode · die · note), and the **die declaration** added — `die:1-20` rewrites
a roll already on the table: fights keep natural and total apart until
resolve, so `delta = die - was` recomputes the total around the standing
modifier and the automatics (parry/fumble/crit damage) honor the declared
face. Refuses plainly when nothing is cast. This is the only lever that
touches a cast die; mode and stat still bind the next roll made.

## 7v · Combat automatics per T's rules doc (2026-08-15)

T's canonical doc (Atk Fumble / Crit Def) layered onto the original damage
table, superseding one interim turn: (1) nat-1 ATTACK fails automatically
(new — was totals-only) and still carries the flat-d20 next defence;
(2) nat-20 DEFENCE auto-parries UNLESS the attack was also a 20 (then
totals decide — the "unless" belongs to the PARRY, not the carry), and the
+2 riposte now banks on EVERY defending 20; (3) damage numbers untouched
(1 / +1 atk-20 / +1 def-1 / 4 both). The interim symmetric attacker-side
next-roll carry (built from T's earlier sentence, before the doc arrived)
was removed — an attacking 20 pays out as damage, not tempo. Carry key
renamed rollBonus with legacy atkBonus honoured mid-fight; consumption
stays at the two attack sites. New card voices: "turns the blow aside — a
perfect parry!" / "fumbles the attack — it fails outright!". Books' Fights
table rewritten to match.

## 7u · Approved docs land on the page (2026-08-14)

The Approve button stamped and DMed but wrote nothing — a player watched
the ✅ land and their page stayed "none approved yet" (Imigun). Now
approval parses the card's 🔗 line into characters.lore_doc_url and
re-mirrors scope 'all' immediately. Per T's shape: /char lore text stays a
SHORT INTRO; the doc gets its own titled "📄 Lore doc" section beneath,
inside the Lore block (no new message, order contract untouched). Newer
approvals replace the link; re-pressing an old card is idempotent — so
Imigun's existing approved card just needs one more press after deploy.

## 7t · Stale approval routes heal (2026-08-14, live)

"The Lore Docs thread is unreachable": approval_routes held a loredoc id
whose thread had since died — my handler only mended ABSENT keys, not dead
ones. Now absence and death heal identically: drop the stale key, run the
shared mender, re-resolve, retry once; only then error, and the error
names the GM lever (build:true). NOTE: other approval types share the
fetch-without-liveness pattern at their send sites; GM-facing, lower
stakes, left as-is — same recipe applies if one ever surfaces.

## 7s · Rank strip (2026-08-14)

rank_name had one writer (the claim button) and no eraser — a claimed rank
was permanent (Skol vs "Bingus"). `/standing rank strip user:` (GM) clears
the held title only; merits/renown untouched so re-claiming stays open;
sheet re-mirrors on the spot. Player-side self-unclaim deliberately not
added — offered, unconfirmed. NOTE for T: the 🏅 sheet line
is the merit RANK, not hero regalia — the two look alike and confused a
player; a distinct emoji for one of them is a one-line change if wanted.

## 7r · Button lane and block order (2026-08-14, live)

Two live defects. (1) 10062 "Unknown interaction" on sheetok: the approval
ok-paths (sheet/import/export) do thread builds, card edits and DMs before
speaking — past the 3s window. All three now defer-first with a respond()
helper (editReply-or-reply by ack state); reject paths stay un-acked for
their reason modals; loredocok defers via deferUpdate. NOTE: the failed
press had fully applied — only the final ephemeral confirmation died.
(2) "didn't respond in time" on Request lore update: the loredoc BUTTON
routes were filed under isModalSubmit, so presses never reached a handler.
Relocated into routeButton (modals stay in the modal lane), pinned.
Plus the order contract: block snowflake ids must ascend in
inv·lore·standing·rolls·notice order; a disordered thread (the mixed-era
births) has its BOT block messages cleared (author-checked) and re-sent in
sequence on the next sweep. Starter and player posts untouched.

## 7q · The seven-improvement batch (2026-08-13/14)

All landed workspace-only. (1) `/gm backup now verify:true`: snapshot →
read-only open → PRAGMA integrity_check → row counts vs live for eight
core tables. (2) `/gm check migrations:true`: the FLAGS ledger reads every
meta flag; each migration now stamps its counts INTO meta.v at set-time
(e.g. run_rename_2 = "3/3"), dead v1 flags shown retired. (3) PACE_MS=300
`pace()` between write-loop iterations in all three migrations + christen
loop; 150ms per block edit in the sweep. (4) `[char-sweep] N edit(s) · F
failed`, non-zero passes only. (5) Lore Docs cards carry GM-gated
✅ Approve / ❌ Deny (deny takes a reasoned modal `loredonm:uid:msgId`);
both stamp the card and DM the player, DM-closed noted on the card.
(7a) `/gm override skip` and `/gm dc hold` write roll-audit lines — the
standing debt is cleared. (6) The party fold: `/quest party
apply|withdraw|approve|kick` under one group ("Hands up, seats, and the
door"), quest 23→20 leaves, npc (22) now the most crowded; dispatch
unchanged because getSubcommand() returns the leaf and buttons + /instance
force sub names, both pinned. The quest near-wall warning retired:
warnings 11→10. Debt remaining: T's order:true → Keep screenshot (7b).

## 7p · Post-run audit (2026-08-13)

Sweep over everything since §7h: four permanent schema scans green, config
key cross-reference clean, warnings steady at 11 (all documented). New
features reconciled pairwise — sweep×GM-privacy (no churn after first
clear), lock×button (interactions bypass SendMessages, by design),
migration ordering, ruleset edges on charPageBody. ONE conflict found and
fixed: the notice's button "self-heal" was unreachable — the hash-skip
fired before the components check — so the notice is now exempt from the
early skip (one fetch per character per hour) and heals for real. /char
show gained all five aspects + page link; the Lore Docs approval tab and
request button shipped owner-gated through approvalDestination.

## 7l · Faces come from tags; the pipe retires (2026-08-12)

`sharedFaceLabelFor(gid, npc)`: sheet ORDER first (if it has a face), then
their assigned CATEGORIES in assignment order, first with a face wins;
`npcFace` = personal ?? that label's image. The `Order | Name` pipe tier is
deleted from the chain, the membership counters, the wearer-refresh loops
and the show line — a pipe in a name is just a name. Bare-caption uploads
now set CATEGORY faces through the same store (`npc_orders`, label-keyed):
order-membership checked first (the nine colours outrank a same-named
category), category members gate otherwise, and the refresh loop is
unified: everyone whose resolved label matches, personal faces untouched.
Unmatched captions refuse plainly without teaching the pipe. Docs updated
in BOTH places per T: /help npc section gained a Faces block; the PDF
'One Face for a Whole Order' section rewrote to tags-first. Deprecation
note: an NPC whose only shared-face claim was their pipe-name goes blank
until tagged or ordered.

Placement postmortem: both one-time migrations were first hooked beside
`startQuestClock(client)` on the assumption it sat in the ready handler —
it sits inside `registerSlashCommands`, so they rode registration
(flag-guarded, harmless, wrong). Rehomed into the real `client.on('ready')`
after the registration loop; pinned there. `startQuestClock`'s own odd home
is pre-existing and untouched. Cleanup is deliberately reachable by hand
too: `/gm check build:true` sweeps recorded pages-forum category threads
and mirrors every NPC, so a hiccuped migration is never a dead end.

Deploy postmortem (03:33, from T's Railway log): the "nothing happened"
scare was Railway's 15-minute build/queue — the new code went live AFTER
the screenshots (the `restored 49` autorest line is the resource mirror's
signature). Two fixes fell out anyway: both migrations now LOG success
("[run-rename] christened N", "[npc-threads] N built, M swept", "already
done" on the flag) because silent success was indistinguishable from
silent failure; and `buildFightRecap` no longer dies on a fighter who left
the server ('reading username of undefined', live crash in the log) — a
departed fighter is named "A departed adventurer". The ready handler is
now `client.once('clientReady')` per the deprecation in the same log.

The 03:33 run set both flags while achieving nothing — every failure was
swallowed, so the loops "completed". Migrations are now **v2 flags**
(`run_rename_2`, `npc_threads_2`; the v1 flags are ignored and honestly
dead) with a vacuity guard: the flag is set only when work was done or
there was truly none, otherwise the boot log prints
`[npc-threads] VACUOUS — 0/N built, flag NOT set · first error: <named>`.
The mirror is idempotent — a row pointing at a foreign (old category)
thread reads as "no thread yet", so re-running cannot duplicate and live
edits stop feeding the retired shape. Diagnosis of WHY 03:33 was vacuous is
deliberately deferred to the next boot's named error rather than guessed.

## 7k · Pages forum: one NPC, one thread, tags that filter (2026-08-12)

Discord tags stick to THREADS, so the old shape (thread per category, NPC
as a message) could never be tag-filtered. Restructure: the pages forum
holds one thread per NPC — thread name = NPC name, starter message = the
sheet (a forum starter shares its thread's id), appliedTags = their
categories (∩ forum tags, ≤5; forum carries ≤20 category tags via
ensureNpcTags, orders deliberately untagged). mirrorNpcSheet is the single
choke: creates the thread, edits the sheet in place, keeps name and tags in
step; assign/remove re-mirror on the spot; delete deletes the thread;
category rename renames the TAG in place (id kept — wearers follow free);
category delete retires the tag (Discord strips it from threads).
`npc_threads_1` migration on ready: per NPC, clear the stale npc_pages row
(it points into a category thread) then mirror; then the old pages-forum
category/order threads are deleted and npc_category_threads cleared. The
PORTRAIT forum is untouched — categories, coloured orders, captions all as
before. npc_category_threads lives on portrait-side only. Retired pin:
"a moved NPC leaves their old thread first" — nobody moves any more.

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
fighters there.

`/gm check order:true` now ASKS before it sorts: two buttons, owner-locked
to the GM who ran it — Apply plan order (the old behaviour, then report) or
Keep my layout (report only, via `observeSidebarOrder`, the applier's
observer twin that force-fetches the same entries and speaks the same
report language but never edits a channel). Hand-arranged servers are a
choice the bot respects; `build:true`/`restart:true` still position by
design. Discord ordering rule bit once: required options must
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
