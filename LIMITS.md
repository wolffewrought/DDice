# DDice — Hard Limits Reference

Every ceiling future development can run into, with where the bot stands today
(2026-08-05, suite 2,581). **Bold** rows are at or within one step of the wall.

## 1 · Command surface (Discord application commands)

| Limit | Value | DDice today |
|---|---|---|
| Global slash commands per app | 100 | 17 |
| **Subcommands + groups per command** | **25** | nothing at the wall: config 2 (channels 13 + mechanics 12) · quest 20 · fight 17 · char 23 · npc 21 · gm 8 · standing 3 groups |
| Subcommands per group | 25 | largest group: standing merit 9 |
| Options per (sub)command | 25 | largest: /quest create ~10 |
| Choices per option | 25 | largest: Knight order 9 |
| **Combined chars per command** (all names + descriptions + choice values, serialized) | **~8000** | **measured 2026-08-06:** config 4321 · char 4068 · quest 3644 · fight 3087 · npc 2877 · gm 2241 — all roughly half the budget; re-measure via the stub's `__BUILDERS__` walk when adding prose-heavy descriptions |
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
| customId | 100 chars | `questcreate:m:p:h:style` well under; values must never contain `:` (styleParts.join defends) — any future payload-in-id pattern must budget this |
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
| Test stub validations | tests/node_modules/discord.js | throws on >25 options, missing descriptions, required-after-optional; **now supports subcommand groups** (SubGroup, type 2) — new Discord builder features must be taught to the stub first |
| PDF table cells | make_pdfs.py table renderer | **no markup** — `<b>` renders literally (fixed once already); bold only in `p`/`note` |
| PDF code-row widths | manual `\n` wraps ~52 chars | rows must be pre-wrapped or they overflow the column |
| Duplicate-block scanner | tools/scan | fires at ~256 identical chars — shared helpers required (questTextRow exists for this reason) |
| Patch discipline | house rule | exact-string anchors + count asserts + write-at-end; a failed assert persists nothing |

## At the ceiling right now
1. **Quest modals — 5/5 rows.** Text fields are full; anything new rides options or customId.
2. **Applied forum tags — 5/thread** with GM hand-tags competing.
No command sits at the 25 wall any more: config folded into channels(13) + mechanics(12), quest holds 20 with the run group, fight 17 with the act menu (bridged onto /roll).

## Sharp edges to remember
- Modal edit **truncates** any text field longer than 4000 that was authored inline.
- Thread renames are near-once-per-10-min; never automate them.
- Forum pin behaviour across six books needs one live verification.
- NPC names containing "discord" would break their webhook voice.
