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
| Modal TextInput value | 4000 chars | **SHARP EDGE:** edit prefill slices legacy text >4000 to fit — saving then truncates it. Inline-authored objectives/lore longer than 4000 lose the tail on a modal edit |
| Modal title / input label | 45 chars | edit title sliced |
| Modal placeholder | 100 chars | |
| showModal rules | must be the FIRST response; cannot defer-then-show; cannot show from a modal submit | activity + quest modals comply |
| **customId** | **100 chars** | **BREACHED by `/gm dc`:** `dcroll:` carries twelve fields including two free-text options, so a long `on_fail`/`on_success` overflows and the reply throws — and a colon inside either shifts every field in the `split(':')`. See HANDOFF.md §7.1. Elsewhere fine: `questcreate:m:p:h:style` well under, values never contain `:` (styleParts.join defends) |
| Autocomplete | ≤25 suggestions · 3 s · name ≤100 · string value ≤100 | quest-number branch slices 25; suggestion source query LIMIT 100 |

## 3 · Messages, embeds, components

| Limit | Value | DDice today |
|---|---|---|
| Message content | 2000 chars | replyLong/sendLong chunk; roster starter sliced |
| Embed totals | 6000 all · 4096 description · 256 title · 25 fields · 1024/field | roll cards & quest embeds comfortable |
| Action rows per message | 5 | activity CHOICE scenes: >5 choices needs multi-row; >25 impossible |
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
3. **Applied forum tags — 5/thread** with GM hand-tags competing.
4. **`/npc` 24/25 and `/quest` 23/25 leaves.** The next subcommand on either
   must join a group. config and gm are already folded.

## Sharp edges to remember
- A `customId` built from user text must budget the 100-char ceiling *and* exclude `:`.
- Modal edit **truncates** any text field longer than 4000 that was authored inline.
- Thread renames are near-once-per-10-min; never automate them.
- Forum pin behaviour across six books needs one live verification.
- NPC names containing "discord" would break their webhook voice.
