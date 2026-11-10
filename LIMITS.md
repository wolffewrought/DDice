# DDice — Hard Limits Reference

Every ceiling future development can run into, with where the bot stands today
(2026-08-10, suite 595 — rebuilt; see HANDOFF.md §7.4). **Bold** rows are at or within one step of the wall.

## 1 · Command surface (Discord application commands)

| Limit | Value | DDice today |
|---|---|---|
| Global slash commands per app | 100 | 11 |
| **Subcommands + groups per command** | **25** | **measured 2026-08-10: npc 24 · quest 23** — both within two of the wall; the next leaf on either must join a group. config 2 · gm 14 · char 8 · fight 17 · standing 3 groups |
| Subcommands per group | 25 | largest group: standing merit 9 |
| Options per (sub)command | 25 | largest: /quest create ~10 |
| Choices per option | 25 | largest: Knight order 9 |
| **Combined chars per command** (all names + descriptions + choice values, serialized) | **~8000** | **measured 2026-08-10:** config 5266 · gm 5168 · char 4691 · quest 4176 · npc 3740 · fight 3087 — grown since 2026-08-06 but all still under two thirds. `verify.js` measures this every run and prints the table; count the text a human wrote, **not** `JSON.stringify` length, which reads roughly three times high |
| Command / subcommand / option name | 32 chars, `a-z0-9-_`, no spaces | why `/gm test` is a group, not a name |
| Option & choice descriptions | 100 chars | several sit near it |

**Consequences already live:** none — every crowded command has been folded
(config → channels/mechanics groups, quest → run group, fight → act menu).
New verbs join their group; the wall is history until a single group nears 25.

## 2 · Interactions, modals, autocomplete

| Limit | Value | DDice today |
|---|---|---|
| First response window | 3 s | deferReply used on slow paths (gm heal, questplanning setup) |
| Interaction token life / followups | 15 min | long loops must finish inside it |
| **Modal rows** | **5** | **quest create & edit use 5/5** — a sixth field is impossible; numbers can never join the modal, which is why they ride the customId / stay slash-side |
| Modal TextInput value | 4000 chars | **SHARP EDGE:** edit prefill slices legacy text >4000 to fit — saving then truncates it. Inline-authored objectives/lore longer than 4000 lose the tail on a modal edit. Activity scripts: the whole-script box opens only when the source fits; longer ones edit scene by scene (a block over 4000 is refused, not sliced), or as a file |
| Modal title / input label | 45 chars | edit title sliced |
| Modal placeholder | 100 chars | |
| showModal rules | must be the FIRST response; cannot defer-then-show; cannot show from a modal submit | activity + quest modals comply |
| Modal label components (discord.js 14.22+) | 5 per modal; a label wraps one text input or select; old action-row modals still accepted | two boxes use the label style, both able to reach **5/5**: `/npc say` (action, speech, To picker of 25, Groups when there are any, Interaction when there are activities) and `/rp` (action, speech, Roll, Dice, and a GM's To picker); `package.json` floor `^14.27.0`, `engines` node >=20 |
| **customId** | **100 chars** | activity ids carry the run key beside the presser (`storyrr:<uid>:<rk>:<scene>:<stat>:<next>:<n>`), so a scene name over ~20 characters risks the ceiling; the shelf and NPC buttons use ten-hex keys instead of names |
| **customId (gm dc)** | **100 chars** | **BREACHED by `/gm dc`:** `dcroll:` carries twelve fields including two free-text options, so a long `on_fail`/`on_success` overflows and the reply throws — and a colon inside either shifts every field in the `split(':')`. See HANDOFF.md §7.1. Elsewhere fine: `questcreate:m:p:h:style` well under, values never contain `:` (styleParts.join defends) |
| Autocomplete | ≤25 suggestions · 3 s · name ≤100 · string value ≤100 | quest-number branch slices 25; suggestion source query LIMIT 100 |
| Select menu options | 25 | the shelf's Edit-scene pick lists the first 25 scenes; `/activity edit scene:` reaches the rest; the NPC box's Groups list shows the first 25 orders and associations with someone living (orders first); its To picker and the GM's /rp picker take 25 people |
| Mentions per message | 100 users in `allowedMentions` | `ADDRESS_CAP` 50 on one NPC or GM /rp line, the rest named back to the GM as not pinged |
| Story scroll | 150 events, 12000 characters | a recorded run's table talk shares them with every other beat — a long recorded session is cut at the cap; the GM record only counts talk |
| Forum tags | 20 | the activity shelf asks for nine and only adds what fits; NPC pages the categories |

## 3 · Messages, embeds, components

| Limit | Value | DDice today |
|---|---|---|
| Message content | 2000 chars | replyLong/sendLong chunk; roster starter sliced |
| Embed totals | 6000 all · 4096 description · 256 title · 25 fields · 1024/field | roll cards & quest embeds comfortable |
| Action rows per message | 5 | activity CHOICE scenes: more than five choices is refused by the parser (2026-10-20); practice adds a second row of force buttons; the board holds 25 Play buttons at most |
| Buttons per row / label | 5 / 80 chars | |
| Reactions, attachments | 20 each | backup exports single-file |

## 4 · Threads & forums

| Limit | Value | DDice today |
|---|---|---|
| **Available tags per forum** | **20** | pipeline claims 6; a GM's own tags share the pool — `ensurePlanTags` will fail to add missing ones past 20 |
| **Applied tags per thread** | **5** | `syncPlanStage` slices to 5 — a GM with 4+ hand tags can silently push the stage tag out |
| Thread name | 100 chars | sliced everywhere |
| Auto-archive | 10080 min max (7 d) | used everywhere; wakeThread compensates |
| Active threads per guild | 1000 | thread-per-quest + books + audit books + char pages all share this pool — a very large old server could approach it; archived threads don't count |
| Forum pinned posts | historically 1 per forum | six books all call `.pin()` catch-guarded — **verify live which actually pin; ordering may need the index books unpinned** |
| Starter message | shares thread id in forums | load-bearing: quest post plumbing depends on it |

## 5 · Webhooks (NPC voices)

| Limit | Value | DDice today |
|---|---|---|
| **Webhooks per channel** | **15** | per-channel NPC webhooks — a channel where 15+ distinct NPCs have spoken hits the wall unless the bot reuses one webhook per channel (it should; verify before adding per-NPC webhooks) |
| Webhook name | 1–80, no "discord"/"clyde" | NPC named "Discord Devil" would fail — no guard today |
| Webhook posts | ~30/min/channel bucket | rapid `[ACTIVITY]` AS-scenes or npc say bursts can throttle |

## 6 · Rate limits & registration

| Limit | Value | DDice today |
|---|---|---|
| Global REST | 50 req/s | sequential awaits keep us far under |
| **thread.setName** | **~2 per 10 min per thread** | quest edit renames two threads per save — fine once, but repeated renames of the SAME quest inside 10 min silently fail (catch-guarded). Don't build anything that renames threads on a timer |
| channel.edit family | similar tight buckets | tag syncs are setAppliedTags (same family) — batched, low frequency |
| Guild command registration | 200 create actions/day/guild | one PUT per restart = one action; many restarts/day still fine |
| messages.delete/send in book moves | normal buckets | delete-and-repost per stage change is 2 calls — fine |
| Initiative turns (2026-11-07) | normal buckets | one send per turn, one edit of the order card, a button strip on the card before; a reminder once a turn — far inside the buckets |
| GM run archive header | normal buckets | edited at run start, pause, resume, finish and hourly; the thread name is set only when it changes (see thread.setName) |

## 7 · Data & files

| Limit | Value | DDice today |
|---|---|---|
| SQLite row / TEXT | 1 GB theoretical | JSON columns (grapples, effect_state, party, books map) tiny |
| better-sqlite3 | synchronous | long loops (gm heal global) block the event loop briefly — acceptable at current server sizes |
| quest_runs / quest_events growth | unbounded | history renders all runs via replyLong; fine to thousands. `/quest start` wipes prior events per run |
| fetchBytes cap | 512 KB | activity file: route; larger scripts refused |
| Attachment upload (bot) | 25 MB (boost-dependent) | DB backups: watch the .db size on old servers |
| index.js | ~892 KB, single file | node fine; the real coupled wall is §1's 8000-char command JSON, not file size |

## 8 · Build & test pipeline (self-imposed)

| Limit | Where | Note |
|---|---|---|
| Test stub validations | verify.js §3 | throws on >25 options, missing descriptions, required-after-optional, over-long customIds and labels; supports subcommand groups — new Discord builder features must be taught to the stub first |
| PDF table cells | make_pdfs.py table renderer | **no markup** — `<b>` renders literally (fixed once already); bold only in `p`/`note` |
| PDF code-row widths | manual `\n` wraps ~52 chars | rows must be pre-wrapped or they overflow the column |
| Duplicate-block scanner | verify.js §2.1 | fires at ~256 identical chars — shared helpers required (questTextRow exists for this reason) |
| Scanners need node internals | verify.js | run with `node --expose-internals`; it parses with node's bundled acorn, and the sandbox has no network to fetch one |
| Verify loop | verify.js | parse → 4 scanners → 3 harnesses, one file. ERROR fails; WARN needs a human. The twelve standing warnings are listed in HANDOFF.md §6 |
| Patch discipline | house rule | exact-string anchors + count asserts + write-at-end; a failed assert persists nothing |

## At the ceiling right now
1. **`/gm dc` customId — over 100 chars for long free text.** The one live
   breach. HANDOFF.md §7.1 has the fix and the trade.
2. **Quest modals — 5/5 rows.** Text fields are full; anything new rides options or customId.
   The `/npc say` box and a GM's `/rp` box can reach 5/5 labels too (2026-11-06).
3. **Applied forum tags — 5/thread** with GM hand-tags competing.
4. **`/npc` 24/25 and `/quest` 23/25 leaves.** The next subcommand on either
   must join a group. config and gm are already folded.

## Sharp edges to remember
- A `customId` built from user text must budget the 100-char ceiling *and* exclude `:`.
- A message's buttons are kept by an edit only because the edit sends content alone; `/edit` relies on it for lines carrying Reply, GM or Interaction.
- Modal edit **truncates** any text field longer than 4000 that was authored inline.
- Thread renames are near-once-per-10-min; never automate them.
- Forum pin behaviour across six books needs one live verification.
- NPC names containing "discord" would break their webhook voice.
- Typing holds a turn only through the `GuildMessageTyping` intent (not privileged). A modal sends no typing: the press that opened a fight form holds the turn, and fifteen minutes inside an open form the clock acts.
- The turn clock acts on the minute tick, so a turn passes up to a minute after its mark; after an outage every quiet turn is acted on at the first tick, one step each.
- On a 5e server grapple, feint, deflect and disarm still roll the Knightfall way (STR, WIS, an opposed d20).
- `characters` has no name column: a 5e export carries the name, an import ignores it.
- `/rp roll:` answers a called check only on a plain ability; a skill or a saving-throw card is answered by its own button.
- The 🎭 GM answer box has no Interaction pick: the NPC's default activity button rides under the answer.
- A held roll is run again from what was asked, not from the moment: a typed `rra` rerolls whatever roll is last by the time it is allowed, and a denied fight command answers in the channel (what would have been the player's alone is said aloud to them).
- `/roll action:` ignores `mode:` (the fight bridge reads `roll:`), so it is never held — and never rolls with advantage either.
- An allowed Roll that opens a form stays live until the form comes back or the ten minutes run out; a form opened in time still rolls with advantage after the button has gone.
- Keeping a hold by roll is a player's: an NPC holder has no Maintain, and the auto-pilot may still swing at its own captive. A held NPC on auto never tries Escape on its own turn (it swings flat); it struggles when a player keeps the hold.
- A feint's or a deception's price in a fight is the fight's flag: it waits for the fighter's next fight roll, and goes with the fight if it ends first. Outside a fight it shares the sheet's one mark with a GM's 🔼 or 🔽: whichever is set later stands. An NPC's sheet mark is the same one slot.
- The Break free and Stay buttons stay on the hold card after the answer; a late press is told no hold is waiting. A reroll of the hold's roll changes the total to beat; a 20 is read at the answer, and a 1 slips the hold at once.
- In a fight a feint re-arms on your own turn's action (an attack, a grab, a disarm, Maintain, Escape), flat or not; a defence roll does not, flat or not. A retrieval is no roll and re-arms nothing.
- A 5e skill check or saving throw does not strip the stat for a flat mark (a 5e sheet only gets one from a GM's check outcome).
- A custom `/roll` standing in for a fight roll counts its first die as the natural, read against 20 whatever the dice: a d100 that shows 20 is a natural 20, and lands whatever the totals.
- A disarmed fighter's turn carries Retrieve alone: one holding someone types `/fight act action:Release` (still free) — there is no button for it that turn.
- Disarm on your own turn and a grapple against a strike are players' moves; NPCs never disarm, and an NPC never grapples a blow.
- `/deception`'s form lives in memory for 15 minutes: a restart, or a late submit, says it has expired.
- `/fight rr` of a flat attack that carried a banked +2 reads it from the numbers: with a stat of exactly 2 it labels the reroll as an honest roll (the total is right either way).
- Disarm's grip roll for the NPC has no naturals; its flat defence, a fooled flag or a sheet mark clamps it to a straight d20.
