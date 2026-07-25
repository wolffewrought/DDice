#!/usr/bin/env python3
"""DDice — Chronicle of Commands. Parchment design, three editions:

  full   → DDice-Commands-Parchment.pdf   (everything)
  player → DDice-Commands-Player.pdf      (no GM/Admin commands)
  gm     → DDice-Commands-GameMaster.pdf  (GM/Admin commands + the rules a GM runs)

Every CONTENT item carries an audience via ('aud', ...) markers; individual code
rows can override with a third element ('cmd', 'comment', 'gm'|'player') so mixed
blocks (like the Fight commands) split cleanly. 'all' items appear in every
edition. Empty headings/sections left behind by filtering are pruned.
"""
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether, PageBreak,
                                CondPageBreak, NextPageTemplate, HRFlowable)
from reportlab.platypus.tableofcontents import TableOfContents
from reportlab.lib.fonts import addMapping
import re as _re

F = '/usr/share/fonts/truetype/dejavu/'
for name, path in [('Serif', 'DejaVuSerif.ttf'), ('Serif-B', 'DejaVuSerif-Bold.ttf'),
                   ('Serif-I', 'DejaVuSerif-Italic.ttf'), ('Serif-BI', 'DejaVuSerif-BoldItalic.ttf'),
                   ('Mono', 'DejaVuSansMono.ttf'), ('Mono-B', 'DejaVuSansMono-Bold.ttf')]:
    pdfmetrics.registerFont(TTFont(name, F + path))
addMapping('Serif', 0, 0, 'Serif'); addMapping('Serif', 1, 0, 'Serif-B')
addMapping('Serif', 0, 1, 'Serif-I'); addMapping('Serif', 1, 1, 'Serif-BI')
addMapping('Serif-I', 0, 0, 'Serif-I'); addMapping('Serif-I', 1, 0, 'Serif-BI')

PARCH=HexColor('#f2e5c2'); PARCH_D=HexColor('#e9d7a8'); INK=HexColor('#3d2e1a')
DIM=HexColor('#6f5b3c'); GOLD=HexColor('#8e6f1c'); GOLD_LT=HexColor('#b3914a')
WINE=HexColor('#6e2230'); T_HEAD=HexColor('#e0cb95'); T_ROW_A=HexColor('#eddcb1')
T_ROW_B=HexColor('#e7d3a2'); T_GRID=HexColor('#a98d52')
GM = 'Game Master'

# ── Content (single source for all editions) ──────────────────────────────────
CONTENT = [
('aud','player'),
('sec', 'Dice Rolling'),
('p', 'Type dice notation directly or use any prefix style (r, !r, !roll):'),
('code', [('1d20', 'bare notation — no prefix needed'),
          ('r1d20+5', ''),
          ('r1d20+5 atk', 'label shows in bold above result'),
          ('r1d20+5 atk\n[flavour text on next line]', 'supports *italic* and **bold**')]),
('h2', 'Advantage & Disadvantage'),
('code', [('ra1d20+5', 'rolls twice, takes higher'),
          ('rd1d20+5', 'rolls twice, takes lower')]),
('h2', 'Rerolls (Player)'),
('code', [('rr', 'costs 1 token'),
          ('rra', 'reroll with advantage'),
          ('rrd', 'reroll with disadvantage')]),
('p', 'Shorthand: append a reroll set to a stat — <b>strrr</b>, <b>dexrra</b> (adv), '
      '<b>conrrd</b> (dis) — to reroll your last roll. A label may follow: <b>strrr atk</b>.'),
('h2', 'Guided Roll (/roll)'),
('code', [('/roll stat:Strength', 'pick a stat from the dropdown'),
          ('/roll stat:Wisdom mode:Advantage', 'advantage / disadvantage'),
          ('/roll dice:2d6+3 label:damage', 'custom notation instead of a stat'),
          ('/roll stat:Dexterity success_check:true\n  label:sneak flavour:*slips into shadow*', 'label + RP text')]),
('p', 'Every part of <b>/roll</b> is a dropdown or field \u2014 stat, advantage, success check, label and '
      'RP flavour \u2014 so nothing has to be memorised. Choose either a <b>stat</b> (rolls 1d20 + that stat '
      'from your sheet) or custom <b>dice</b>. The result uses the same card as a typed roll.'),
('h2', 'Stat Quick Rolls'),
('code', [('str   con   dex   wis   lck', 'on their own — nothing else in the message'),
          ('wisa   dexd', 'advantage / disadvantage · a label may follow'),
          ('r str atk', 'a plain stat roll with a label'),
          ('?str atk', 'the same, as a success check')]),
('p', 'Rolls 1d20 + that stat from your saved character. Add <b>a</b> for advantage or <b>d</b> for '
      'disadvantage — <b>wisa</b>, <b>dexd</b>.'),
('p', '<b>A plain stat name must be the whole message.</b> <b>str</b>, <b>con</b>, <b>dex</b>, <b>wis</b> and '
      '<b>lck</b> are ordinary words in conversation, so anything typed after one means it is treated as '
      'chat and left alone — “Dex or strength can both be used to throw things” is a sentence, not a '
      'roll. To label a plain stat roll, put a prefix on it: <b>r str atk</b> or <b>?str atk</b>.'),
('p', 'Forms that cannot be mistaken for words keep their labels as they always did — <b>wisa sneak</b>, '
      '<b>dexd guard</b>, <b>strrr atk</b>, <b>conrra hold the line</b>.'),
('h2', '? Success Check Rolls'),
('p', 'Prefix <b>?</b> instead of <b>r</b> to get a success outcome:'),
('code', [('?1d20+5   ?ra1d20+5   ?rd1d20+5   ?rr   ?str   ?wisa', '')]),
('table', ['Result', 'Outcome'],
          [['Natural 20 / max face', 'Critical Success (gold)'],
           ['Natural 1 / min face', 'Critical Fail (red)'],
           ['Total 15+', 'Success'],
           ['Total 10–14', 'Partial Success'],
           ['Total 2–9', 'Fail']]),
('h2', 'Critical Hits & Fails (all rolls)'),
('p', 'Natural max on any die → gold label + result.<br/>Natural 1 on any die → red label + result.'),

('sec', 'HP & Healing (Player)'),
('code', [('!hp +5', ''), ('!hp -3', '')]),
('h2', 'Heal (White Knight + WIS 5 only)'),
('p', 'Targets another player — cannot self-heal.'),
('code', [('!heal @user', ''), ('!h @user', '')]),
('table', ['Roll Result', 'Effect', 'Charges Used'],
          [['Natural 20', '+2 HP restored', 'None'],
           ['20+ (modified)', '+2 HP restored', '1'],
           ['2 – 19', 'No heal', '1'],
           ['Natural 1', 'No heal', '2']]),
('h2', 'Rest Commands (Player)'),
('p', 'Append <b>@user</b> to any command for ' + GM + ' targeting. Default amounts shown — '
      + GM + 's can change them with <b>/config rest</b>.'),
('table', ['Command', 'HP', 'Rerolls', 'Heal Charges'],
          [['lrest', 'Full', 'Full', 'Full'],
           ['srest', 'Half', '—', '—'],
           ['hpfull', 'Full', '—', '—'],
           ['hphalf', 'Half', '—', '—']]),
('note', 'Short rest restores HP only by default. A ' + GM + ' can re-enable rerolls/heal or change any amount.'),

('aud','gm'),
('sec', 'Game Master Commands'),
('note', 'All commands in this chapter require the GM role.'),
('h2', GM + ' Rolls'),
('code', [('gmr 1d20+5', 'public roll in channel'),
          ('gmr 1d20+5 perception', 'with label'),
          ('gmrs 1d20+5', 'secret — sent to ' + GM + ' DMs only'),
          ('gmrs 1d20+5 stealth', '')]),
('h2', GM + ' HP & Rerolls Targeting'),
('code', [('!hp @user +5    !hp @user -3', ''),
          ('!hp +5 @user    !hp -3 @user', ''),
          ('!rerolls @user +1    !rerolls @user -1', '')]),
('h2', GM + ' Rest Targeting'),
('code', [('lrest @user   srest @user   hpfull @user   hphalf @user', '')]),
('h2', 'Preset Tags'),
('code', [('/tag assign user:@player tag:Hero of Kalidale', ''),
          ('/tag remove user:@player tag:Hero of Kalidale', ''),
          ('/tag list user:@player', '')]),
('h2', 'Custom Tags'),
('code', [('/tag custom action:Create emoji:[any emoji] name:MyTag', ''),
          ('/tag custom action:Delete name:MyTag', ''),
          ('/tag custom action:List', '')]),
('note', 'For server emojis: type \\:emojiname: in chat to get the full ID.'),

('aud','player'),
('sec', 'Character & Profile'),
('h2', 'Start Here \u2014 Make Your Character'),
('p', '<b>Build your character with /char create.</b> One command sets the whole sheet at once \u2014 every '
      'stat, your order, your class and both weapons \u2014 so it arrives complete instead of in pieces.'),
('code', [('/char create str:14 con:12 dex:10 wis:5 lck:3 \\\n  order:White Knight class:Hero \\\n'
           '  weapon1:Longsword weapon2:Tower Shield', 'the whole character, one command')]),
('p', 'Every option is optional \u2014 fill in what you have decided and run it again later to add the rest. '
      'The values for <b>order</b>, <b>class</b> and the weapon fields are listed further down this chapter.'),
('note', 'This matters most where a GM has switched sheet approval on. /char create sends one request for '
         'the whole character; building the same sheet a field at a time sends a fresh request on every '
         'single change and buries the GMs in them. It matters again afterwards, because once your sheet is '
         'approved every field is locked and only a GM can change it \u2014 so /char create is your one clean '
         'run at the character you want.'),
('h2', 'Changing One Field Later'),
('p', 'Use <b>/char set</b> to adjust a single thing after the fact \u2014 a stat that went up, a weapon you '
      'swapped. It is a touch-up tool, not the way to build a character from nothing.'),
('aud','all'),
('code', [('/char set field:str value:14', 'one field at a time', 'player'),
          ('/char set field:con value:12', 'HP auto-maxes to CON + 2', 'player'),
          ('/char set field:lck value:3', 'rerolls auto-max to LCK', 'player'),
          ('/char set field:str value:14 user:@player', GM + ' only', 'gm')]),
('aud','player'),
('h2', 'Knight Orders'),
('p', 'These are the values to pass to <b>order:</b> on /char create \u2014 or to /char set if this is the '
      'only thing you are changing.'),
('code', [('/char set field:order value:White Knight', 'also: Black, Gold, Grey, Blue,'),
          ('/char set field:order value:Red Knight', 'Purple, Green, Red')]),
('h2', 'Class, Weapons & Emojis'),
('code', [('/char set field:class value:Hero', 'Hero / Vanguard / Defender / Siege Knight'),
          ('/char set field:weapon1 value:Longsword', ''),
          ('/char weaponemoji slot:Weapon 1 emoji:[choose]', 'standard emoji dropdown'),
          ('/char weaponemoji slot:Weapon 1 custom::sword:', 'paste a server emoji')]),
('note', 'Pick a standard emoji from the dropdown, or paste a server custom emoji in the \u201ccustom\u201d '
         'field (it overrides the dropdown). The image export falls back to a sword glyph for custom emojis.'),
('h2', 'Reading & Sharing Your Sheet'),
('code', [('/char create ...', 'see \u201cStart Here\u201d \u2014 builds the whole sheet'),
          ('/char show          /char show user:@player', ''),
          ('/char export        /char export format:Image', '')]),
('p', '<b>With sheet approval switched on, an export goes to the GMs first.</b> Running <b>/char export</b> '
      'posts the sheet block into the approval channel with <b>Release to player</b> / <b>Decline</b> buttons; '
      'the player sees only a private note that it has been sent. When a GM releases it, the block arrives by '
      'DM \u2014 or back in the channel they exported from, if their DMs are closed. Exporting is not an edit: it '
      'never changes a sheet\u2019s approval state and never stops anyone rolling. Exporting again replaces the '
      'previous request, so the channel holds one live entry per player. GMs export straight away, for '
      'themselves and for anyone else, and on servers not using approvals nothing changes.'),
('h2', 'Profile'),
('code', [('/profile on    /p on', 'enable embed, max HP + rerolls'),
          ('/profile off   /p off', 'disable embed, plain text rolls'),
          ('/profile show  /p show', 'preview card without rolling'),
          ('/profile save mysave', 'snapshot current state'),
          ('/profile load mysave', 'restore snapshot in any channel')]),
('aud','all'),
('h2', 'Sheet Import'),
('p', 'Paste an exported sheet into any channel the bot watches.'),
('code', [('[paste sheet into channel]', 'player', 'player'),
          ('[paste sheet] @player', GM + ' importing for another player', 'gm')]),

('sec', 'Config & Maintenance'),
('aud','gm'),
('h2', 'Config (Admin only)'),
('code', [('/config gmrole role:@Role', 'add a GM role \u2014 several can be set'),
          ('/config gmrole role:@Role remove:true', 'remove one'),
          ('/config gmrole role:@Role replace:true', 'make it the only GM role'),
          ('/config gmrole', 'list current GM roles'),
          ('/config heal charges 3', ''),
          ('/config npcchannel #channel', 'set the NPC image bank channel'),
          ('/config npcreroll threshold:8', 'NPC auto-reroll on nat ≤ N — 0 disables'),
          ('/config fightping enabled:true', '@-mention players on their turn — off by default'),
          ('/config rollaudit channel:#gm-rolls', 'mirror every roll — raw input,\nresult and jump link'),
          ('/config rollaudit test:true', 'send a test mirror, report problems'),
          ('/config npcstats enabled:true', 'reveal NPC stat blocks — hidden by default'),
          ('/config approvals channel:#sheet-approvals', 'new sheets need GM sign-off'),
          ('/config approvals disable:true', 'turn approval off'),
          ('/config rest type:Short Rest hp:50% rerolls:0%', '% of max'),
          ('/config rest type:Short Rest hp:3 rerolls:1', 'flat numbers'),
          ('/config cleanwebhooks', 'remove orphaned NPC webhooks')]),
('note', 'NPC roll cards hide STR/CON/DEX/WIS/LCK, the roll modifier and HP totals by default. Players see '
         'the name, order, the final roll total, the exact damage each hit deals, and a condition '
         '(\u2764\ufe0f unhurt / wounded / badly hurt / near death / down) instead of numbers \u2014 so the fight '
         'reads clearly without revealing what an NPC can take. Reveal everything with '
         '<b>/config npcstats enabled:true</b>. NPC management commands are ' + GM + '-only regardless.'),
('note', 'With an approval channel set, a player\u2019s new sheet is posted there for sign-off, pinging '
         'every GM role, with Approve / Reject buttons. Until approved they can\u2019t roll, heal or take '
         'fight actions \u2014 and once approved, their whole sheet can only be changed by a GM. Sheets a GM '
         'creates or edits skip the queue, and sheets made before approval was enabled keep working until '
         'someone edits them.'),
('note', 'Every way a player can write to their own sheet goes to the queue: <b>/char create</b>, '
         '<b>/char set</b> (any field \u2014 stats, order, class and weapons alike), <b>/char weaponemoji</b>, '
         '<b>/profile load</b> and pasting an exported sheet. Building a character one <b>/char set</b> at a '
         'time is not a way past a GM. Editing a sheet that is still pending retires the old request and '
         'posts a fresh one, so the channel holds one live entry per player rather than a pile of stale ones. '
         'A rejected sheet can still be edited by its owner \u2014 that is how they fix it \u2014 and each edit '
         'sends it straight back for another look.'),
('note', 'The roll-audit mirror covers prefix rolls, stat shorthand, success checks, rerolls, heals and '
         'fight rolls \u2014 and <b>' + GM + ' rolls too, including secret <b>gmrs</b> ones</b>, so ' + GM + 's are '
         'accountable to one another. A ' + GM + ' rolling as an NPC is logged under their own name. Only NPC '
         'auto-rolls and rolls made inside the audit channel are skipped. Use <b>/config rollaudit test:true</b> '
         'to check it works. Set the channel\u2019s Discord permissions so only ' + GM + 's can view it.'),
('note', 'Several GM roles can be set at once \u2014 holding any of them grants GM access. Anyone with '
         'the Discord <b>Manage Server</b> permission always counts as a GM, so you can never lock '
         'yourself out by mis-setting a role.'),
('note', 'Each rest value is either a percentage of that resource\u2019s max (e.g. 50%) or a flat whole number '
         'that sets it exactly (e.g. 3). 0% means leave it untouched. Only the values you provide change.'),
('aud','all'),
('h2', 'Help & Maintenance'),
('code', [('/help', 'overview of all command groups'),
          ('/help category:dice', 'detail on a specific group'),
          ('/lastroll', 'recall your last roll in this channel'),
          ('/backup now', 'export the database to this channel — ' + GM, 'gm'),
          ('/backup auto channel:#backups', 'daily automatic backups — ' + GM, 'gm')]),
('aud','gm'),
('note', 'Destructive actions (/npc delete, /fight end, /quest delete, /weapon remove) ask for '
         'Confirm / Cancel before running.'),
('aud','all'),
('h2', 'Derived Stats'),
('table', ['Stat', 'Formula', 'On change'],
          [['Max HP', 'CON + 2', 'HP always maxes'],
           ['Max Rerolls', 'LCK', 'Rerolls always max'],
           ['Heal tracker', 'White Knight + WIS ≥ 5', 'Appears / disappears automatically']]),

('aud','gm'),
('sec', 'NPC System'),
('note', 'All commands in this chapter are ' + GM + '-only.'),
('h2', 'NPC Management'),
('code', [('/npc create name:Cave Orc str:14 con:10 dex:4 wis:2\n  lck:1 order:Black Knight', 'full stat block'),
          ('/npc create name:Mystery Figure', 'name only \u2014 stats added later'),
          ('/npc create name:Mystery Figure str:14 con:10', 'fill stats in over time'),
          ('/npc copy name:Goblin new_name:Goblin 2', 'duplicate an NPC, fresh HP'),
          ('/npc show name:Goblin', 'full stat block for one NPC'),
          ('/npc hero name:Goblin stat:str', 'make an NPC a Hero with a signature stat'),
          ('/npc hero name:Goblin remove:true', 'strip Hero status'),
          ('/npc list', 'shows stats and current HP'),
          ('/npc list category:Bandits', 'only one category\u2019s NPCs'),
          ('/npc delete name:Aldric Vane', '')]),
('h2', 'NPC HP & Healing'),
('code', [('/npc hp name:Goblin value:3', 'set exact HP'),
          ('/npc hp name:Goblin', 'omit value — full heal'),
          ('/npc heal names:all', 'fully heal every NPC'),
          ('/npc heal names:Goblin, Orc', 'fully heal the listed NPCs')]),
('h2', 'Restoring Resources (/gmheal)'),
('code', [('/gmheal user:@a', 'full HP \u2014 the default'),
          ('/gmheal user:@a restore:Everything', 'HP, rerolls and heal charges'),
          ('/gmheal user:@a amount:Half', 'restore half of maximum'),
          ('/gmheal user:@a amount:Add value:3', 'add 3, capped at max'),
          ('/gmheal user:@a amount:Exact value:1', 'set to an exact figure'),
          ('/gmheal npc:Goblin', 'one NPC'),
          ('/gmheal npc:all', 'every NPC at once')]),
('p', 'One command for every restore. Works on a player or an NPC (or <b>all</b> NPCs), and HP changes '
      'sync straight into any active fight. NPCs only have HP; heal charges are skipped for anyone who '
      'isn\u2019t a White Knight with WIS 5+.'),
('note', 'Stats are optional \u2014 an NPC can be registered by name (and given an avatar) with no stats at '
         'all, then statted up later. Re-running <b>/npc create</b> with the same name updates only the '
         'fields you supply and leaves the rest untouched.'),
('note', 'NPC HP persists between fights. Knocked-down NPCs (0 HP or less) are left out of new fights until restored.'),
('h2', 'Speaking as an NPC'),
('code', [('/pr say name:Cave Orc speech:Halt! Who goes there?', 'speech \u2014 in quote marks'),
          ('/pr say name:Cave Orc action:raises its axe', 'action \u2014 italic emote'),
          ('/pr say name:Cave Orc action:raises its axe\n  speech:Halt!', 'both, stacked'),
          ('/pr say name:Cave Orc', 'opens a writing box')]),
('p', 'Posts as the NPC through their webhook \u2014 their name and avatar, no dice rolled. Fill '
      '<b>action</b>, <b>speech</b>, or both: the action is italicised and the speech is wrapped in quote '
      'marks, stacked on separate lines. Leave both blank and a <b>writing box</b> opens with roomy '
      'multi-line fields \u2014 easier for longer roleplay. Use <b>raw</b> to post exactly as typed.'),
('h2', 'Rolling as an NPC (/pr shorthand)'),
('code', [('/pr roll name:Cave Orc notation:1d20+8 label:strike\n  flavour:The orc lunges', ''),
          ('/pr create name:Aldric Vane str:8 con:6 dex:10 wis:4 lck:2', ''),
          ('/pr list', '')]),
('p', 'Posts via webhook — appears as the NPC with their name and avatar.'),
('h2', 'Setting NPC Avatars'),
('p', '1. Admin runs <b>/config npcchannel #channel</b> to set the image bank channel.<br/>'
      '2. ' + GM + ' uploads an image to that channel with the NPC name as the message text.<br/>'
      '3. Bot adds a checkmark reaction to confirm.  4. Re-upload with the same name to update.'),
('note', 'Bot requires Manage Webhooks permission in the server.'),

('aud','gm'),
('h2', 'Heroes & Signature Stats'),
('p', '<b>Hero</b> is a ' + GM + '-granted class, not a player choice \u2014 players who try to set it are '
      'refused. Both player sheets and NPCs can be Heroes.'),
('code', [('/char set field:class value:Hero user:@a', 'grant Hero to a player sheet'),
          ('/char signature user:@a stat:str', 'designate their signature stat'),
          ('/npc hero name:Aldric stat:dex', 'Hero NPC with a signature stat')]),
('p', 'A Hero may have one <b>signature stat</b> with <b>5 or more</b> points. Every roll using that stat '
      '\u2014 typed shorthand, <b>/roll</b>, and both attack and defence in fights, manual or automatic \u2014 '
      'is made with <b>advantage</b>, marked \u2b50 on the roll card. If the stat later drops below 5 the '
      'advantage simply stops applying until it is restored; an explicitly requested disadvantage still wins.'),

('aud','all'),
('sec', 'Fight System'),
('p', 'Structured fights with initiative, turn order, stat-based rolls and damage tracking.'),
('h2', 'Commands'),
('code', [('/fight start players:@a @b npcs:Goblin, Orc', 'any number of each', 'player'),
          ('/fight start ... manual:true', 'skip roll, keep listed order', 'player'),
          ('/fight start ... practice:true', 'friendly bout — fighters yield at 2 HP', 'player'),
          ('/fight addnpc npc:Goblin, Orc', 'add NPC(s) mid-fight, ' + GM, 'gm'),
          ('/fight order sequence:@a, Goblin, @b', 'reorder players + NPCs, ' + GM, 'gm'),
          ('/fight atk stat:str target:@user', 'attack a player', 'player'),
          ('/fight atk stat:str target_npc:Orc', 'attack an NPC', 'player'),
          ('/fight atk stat:str npc:Goblin target:@user', GM + ' attacks AS the NPC', 'gm'),
          ('/fight def stat:dex', 'defend', 'player'),
          ('/fight def stat:dex npc:Goblin', GM + ' defends AS the NPC', 'gm'),
          ('/fight rr', 'reroll last fight roll — 1 token', 'player'),
          ('/fight resolve', 'resolve the exchange', 'player'),
          ('/fight status', 'show turn order and HP', 'player'),
          ('/fight log', 're-post the last finished fight\u2019s recap', 'player'),
          ('/fight skip', 'skip the current turn — fighter stays in, ' + GM, 'gm'),
          ('/fight hp value:3 target_npc:Orc', 'set HP mid-fight, sheet synced, ' + GM, 'gm'),
          ('/fight kick target_npc:Orc', 'remove a fighter, fight continues, ' + GM, 'gm'),
          ('/fight refill npcs:all', '"all" or names — refill reroll tokens, ' + GM, 'gm'),
          ('/fight auto mode:Full ...', 'bot resolves whole fight, ' + GM, 'gm'),
          ('/fight auto mode:Full\n  teams:@a @b vs Goblin, Orc', 'party-vs-monsters sides, ' + GM, 'gm'),
          ('/fight auto mode:NPCs only ...', 'bot plays NPCs, ' + GM, 'gm'),
          ('/fight auto mode:Demo', 'example showcase, ' + GM, 'gm'),
          ('/fight auto ... practice:true', 'a bout in any auto mode, ' + GM, 'gm'),
          ('/fight forfeit', 'concede — HP preserved', 'player'),
          ('/fight end', GM + ' only', 'gm')]),
('pbreak',),
('h2', 'How a Fight Runs'),
('p', 'When a fight starts, the bot rolls DEX initiative (1d20 + DEX) for every fighter and orders the '
      'turn order from highest to lowest, ties broken by the raw d20. Add <b>manual:true</b> to skip the '
      'roll and keep your listed order, or use <b>/fight order</b> with a comma-separated sequence.'),
('p', '<b>Knocked-down fighters:</b> anyone at 0 HP or less is left out when a fight starts or when NPCs '
      'are added, with a warning naming them. Restore NPCs with <b>/npc heal</b> or <b>/npc hp</b>, '
      'players with rests or <b>hpfull @user</b>.'),
('p', '<b>Practice bouts:</b> add <b>practice:true</b> to <b>/fight start</b> or <b>/fight auto</b> and the '
      'fight becomes a friendly spar. Everything runs exactly as normal \u2014 initiative, rolls, damage, '
      'crits, carry-over effects, rerolls, recap \u2014 but the cut-off moves from 0 HP to <b>2 HP</b>. '
      'A fighter bows out the moment they reach 2, and damage never carries anyone below it, so nobody '
      'leaves the yard worse than winded. Sparring partners already at 2 HP or less are left out at the '
      'start, the same way knocked-down fighters are. The bout is announced on start, marked on '
      '<b>/fight status</b>, and noted again in <b>/fight log</b>, so a spar can never be mistaken for '
      'the real thing.'),
('p', '<b>HP stays in sync:</b> any mid-fight HP change — <b>!hp</b>, <b>!heal</b>, rests, <b>/npc hp</b> or '
      'the <b>/fight hp</b> command — is mirrored straight into the fight, so a heal is never overwritten '
      'by the next exchange. Anywhere a command takes NPC names, <b>category:Name</b> adds a whole '
      'category at once.'),
('h2', 'When a Fight Ends'),
('p', 'However a fight finishes — a knockout, a forfeit, a kick, <b>/fight end</b> or an auto-resolve — '
      'a single public <b>result post</b> goes to the channel where everyone can read it. Nothing important '
      'is left in a private reply: the ' + GM + '\u2019s confirmation for <b>/fight end</b> stays private, but '
      'the result itself is posted for the whole table.'),
('p', 'The post names the <b>victor</b>, then lists every combatant\u2019s <b>final standing</b> — exact HP for '
      'players, a condition band for NPCs while their stats are hidden — followed by the recap.'),
('p', 'The <b>recap</b> covers players and NPCs alike, in three parts. <b>Rolls</b>: how many attacks and '
      'defences each fighter made, their average total, and their best and worst natural dice. '
      '<b>Damage</b>: dealt and taken, natural 20s and 1s, and rerolls spent. <b>Blow by blow</b>: every '
      'exchange in order — both rolls, the natural die and the final total for each side, and whether it '
      'landed or was blocked, with natural 20s and 1s marked. Very long fights show the most recent '
      'exchanges and say how many earlier ones were trimmed; the roll and damage figures still cover the '
      'whole fight. Long recaps are split across messages so nothing is lost to Discord\u2019s length limit.'),
('p', '<b>/fight log</b> re-posts the last finished fight\u2019s recap in that channel at any time, blow-by-blow included.'),
('aud','gm'),
('p', '<b>NPCs as combatants:</b> a ' + GM + ' lists NPCs in <b>npcs:</b> (comma-separated) on start '
      'or <b>/fight addnpc</b> later. On an NPC\u2019s turn the ' + GM + ' adds <b>npc:Name</b> to '
      '<b>/fight atk</b> or <b>/fight def</b>; attack an NPC with <b>target_npc:Name</b>.'),
('h2', 'Auto Modes'),
('p', '<b>/fight auto mode:Full</b> rolls attack, defend and damage for everyone and plays the fight '
      'through to a winner, saving HP to each combatant\u2019s sheet as it changes. Add '
      '<b>teams:@a @b vs Goblin, Orc</b> for proper sides — fighters only target the enemy team, and the '
      'last team standing wins. <b>mode:NPCs only</b> starts a normal fight where the bot takes the '
      'NPCs\u2019 turns automatically while players still use <b>/fight atk</b> and <b>/fight def</b>. '
      '<b>mode:Demo</b> runs a throwaway example.'),
('p', '<b>Automatic rolls</b> always use the fighter\u2019s highest of STR or DEX, for attack and defence '
      'alike (ties go to STR), and post the same full roll card as a manual roll. Each NPC\u2019s cards '
      'appear under that NPC\u2019s own name and avatar (via webhook).'),
('p', '<b>NPC rerolls:</b> in auto modes each NPC carries its own reroll tokens — LCK per fight. A token is '
      'spent only when the natural die shows <b>8 or less</b> (server-tunable via <b>/config npcreroll</b>; '
      '0 disables): a defender about to be hit rerolls first, then a blocked attacker may answer — one each '
      'per exchange. <b>/fight status</b> shows remaining tokens, and <b>/fight refill</b> restores them '
      'mid-fight.'),
('aud','all'),
('pbreak',),
('h2', 'Damage'),
('table', ['Situation', 'Damage'],
          [['Attack total ≥ Defence total', '1'],
           ['Attacker natural 20', '+1 bonus'],
           ['Defender natural 1', '+1 bonus'],
           ['Attacker nat 20 + Defender nat 1', '4 total'],
           ['Defence total > Attack total', '0 (blocked)'],
           ['Fighter reaches 0 HP', 'Knocked down, removed from turn order, HP goes negative']]),
('aud','player'),
('p', 'Players can reroll using <b>rr / rra / rrd</b> after their initial roll before <b>/fight resolve</b>.'),
('aud','all'),
('h2', 'Critical Effects (carry-over)'),
('p', 'A natural 1 or natural 20 leaves a mark on the <i>next</i> roll, in both manual and auto fights:'),
('table', ['Trigger', 'Effect on the next roll'],
          [['Natural 1 on an attack', 'The attacker fumbles — their next defence is rolled as a flat d20 (no stat, no advantage).'],
           ['Natural 20 on a defence', 'The defence turns the blow aside and the defender gains +2 on their next attack — unless that attack was itself a natural 20.']]),
('note', 'Each effect is consumed by the affected fighter\u2019s next matching roll and is announced when it '
         'lands (\u201cpresses the riposte\u201d, \u201cdefends on a flat d20\u201d). Leaving a fight clears any '
         'pending effects.'),

('sec', 'Merits & Ranks'),
('p', 'A milestone-style progression system. Merits are a lifetime tally a ' + GM + ' awards; ranks are '
      'named tiers with merit thresholds. The bot tracks progress and flags eligibility, but every '
      'promotion is decided by a ' + GM + '.'),
('h2', 'Merits'),
('code', [('/merit view', 'your merits, rank, and merits to next rank', 'player'),
          ('/merit view user:@player', 'view another player', 'player'),
          ('/merit leaderboard', 'top earners on the server', 'player'),
          ('/merit add user:@player amount:2', 'award merits — ' + GM, 'gm'),
          ('/merit remove user:@player amount:1', 'take merits away — ' + GM, 'gm'),
          ('/merit set user:@player amount:10', 'set an exact total — ' + GM, 'gm'),
          ('/merit history user:@player', 'a player\u2019s merit timeline', 'player'),
          ('/merit history', 'recent server-wide merit activity', 'player')]),
('h2', 'Ranks'),
('code', [('/rank list', 'all ranks and their thresholds', 'player'),
          ('/rank add name:Knight threshold:5', 'create or update a rank — ' + GM, 'gm'),
          ('/rank add name:Squire threshold:0 order:0', 'order sets junior→senior — ' + GM, 'gm'),
          ('/rank promote user:@player rank:Knight', 'set a player\u2019s rank — ' + GM, 'gm'),
          ('/rank eligible', 'who has met a threshold but isn\u2019t promoted — ' + GM, 'gm'),
          ('/rank remove name:Squire', 'delete a rank — ' + GM, 'gm')]),
('note', '<b>/merit view</b> shows current merits and exactly how many more are needed for the next rank, '
         'e.g. \u201cKnight \u00b7 7 merits \u00b7 8 to Paladin\u201d. Every merit change is recorded — '
         'quest rewards show the quest name, manual changes show \u201cby GM\u201d — so <b>/merit history</b> '
         'answers \u201cwho earned what, and when\u201d. Removing a rank doesn\u2019t change players who '
         'already hold its label.'),

('sec', 'Quest Board'),
('p', 'GMs create quests with lore, objectives, details and rewards. Quests are posted as a message '
      'with an Apply button and also appear on the board. Players apply, a ' + GM + ' approves the party, '
      'and on completion merits are auto-awarded while other rewards are listed for the ' + GM + ' to hand out.'),
('aud','player'),
('h2', 'For Players'),
('code', [('/quest board', 'list quests (filter: open/active/completed/all)'),
          ('/quest show number:1', 'full details of one quest'),
          ('/quest roster number:1', 'see applicants and the party'),
          ('/quest apply number:1', 'apply to join — or tap Apply on the post'),
          ('/quest withdraw number:1', 'leave or cancel your application'),
          ('/quest log user:@player', 'completed quests a player was on')]),
('aud','gm'),
('h2', 'For the ' + GM),
('code', [('/quest create name:Goblin Cave objectives:...\n  merit_reward:2 party_size:4 hard_cap:true', 'create a quest'),
          ('/quest post number:1 channel:#board', 'post as an embed with an Apply button'),
          ('/quest approve number:1 user:@a force:true', 'approve an applicant · force past a hard cap'),
          ('/quest kick number:1 user:@a', 'remove a member or applicant'),
          ('/quest runchannel number:1 channel:#thread', 'set where it runs & rewards'),
          ('/quest start number:1', 'lock the party, mark in progress'),
          ('/quest complete number:1', 'finish — auto-award merits, list rewards'),
          ('/quest delete number:1', 'remove a quest permanently')]),
('aud','all'),
('note', 'Quests are auto-numbered for easy recall, e.g. <b>#001-Goblin Cave</b> (repeatable quests keep '
         'the name and get a fresh number each time). Party size is a hard cap or a suggestion — the ' + GM +
         ' chooses with <b>hard_cap</b>, and <b>force:true</b> on approve overrides a cap. Point a quest at '
         'a thread with <b>/quest runchannel</b> and its completion rewards are announced there.'),
]

# ── Edition filtering ─────────────────────────────────────────────────────────
def filter_content(edition):
    """full → everything; player → aud in (all, player); gm → aud in (all, gm).
    Code rows may override the block audience with a third element."""
    keep = {'full': None, 'player': {'all', 'player'}, 'gm': {'all', 'gm'}}[edition]
    out, aud = [], 'all'
    for item in CONTENT:
        if item[0] == 'aud':
            aud = item[1]; continue
        if item[0] == 'code':
            rows = []
            for row in item[1]:
                row_aud = row[2] if len(row) > 2 else aud
                if keep is None or row_aud in keep:
                    rows.append((row[0], row[1]))
            if rows:
                out.append(('code', rows))
            continue
        if keep is None or aud in keep:
            out.append(item)
    return prune(out)

def prune(items):
    """Drop headings/sections/breaks left empty by filtering."""
    changed = True
    while changed:
        changed = False
        res = []
        for i, item in enumerate(items):
            nxt = items[i + 1][0] if i + 1 < len(items) else None
            k = item[0]
            if k == 'h2' and nxt in ('h2', 'sec', 'pbreak', None):
                changed = True; continue
            if k == 'pbreak' and (nxt in ('sec', 'pbreak', None) or (res and res[-1][0] == 'sec')):
                changed = True; continue
            if k == 'sec' and nxt in ('sec', None):
                changed = True; continue
            res.append(item)
        items = res
    return items

# ── Styles ──
body=ParagraphStyle('body',fontName='Serif',fontSize=10.4,leading=14.8,textColor=INK,spaceAfter=5)
note=ParagraphStyle('note',parent=body,fontName='Serif-I',fontSize=9.6,leading=13.4,textColor=DIM,spaceBefore=2,spaceAfter=7)
h2=ParagraphStyle('h2',fontName='Serif-B',fontSize=12.4,leading=16,textColor=WINE,spaceBefore=10,spaceAfter=4)
sec_style=ParagraphStyle('h1',fontName='Serif-B',fontSize=19,leading=24,textColor=GOLD,alignment=TA_CENTER,spaceBefore=2,spaceAfter=0)
code_cmd=ParagraphStyle('code',fontName='Mono-B',fontSize=9.2,leading=12.8,textColor=INK)
code_cmt=ParagraphStyle('codec',fontName='Serif-I',fontSize=9.1,leading=12.8,textColor=DIM)
title_st=ParagraphStyle('title',fontName='Serif-B',fontSize=40,leading=48,textColor=GOLD,alignment=TA_CENTER,spaceAfter=4)
sub_st=ParagraphStyle('sub',fontName='Serif-I',fontSize=14,leading=19,textColor=DIM,alignment=TA_CENTER,spaceAfter=4)
toc_h=ParagraphStyle('toch',fontName='Serif-B',fontSize=16,leading=21,textColor=WINE,alignment=TA_CENTER,spaceBefore=16,spaceAfter=10)
foot_st=ParagraphStyle('foot',parent=sub_st,fontSize=11,spaceBefore=22)

def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def code_block(rows):
    data=[]
    for cmd,comment in rows:
        h=esc(cmd).replace('\n','<br/>')
        h=_re.sub(r'  +', lambda m:'&nbsp;'*len(m.group(0)), h)
        data.append([Paragraph(h,code_cmd), Paragraph(('('+esc(comment)+')') if comment else '', code_cmt)])
    t=Table(data,colWidths=[110*mm,58*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),PARCH_D),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),
        ('TOPPADDING',(0,0),(-1,-1),3.4),('BOTTOMPADDING',(0,0),(-1,-1),3.4),
        ('LINEBEFORE',(0,0),(0,-1),2.4,GOLD),('LINEBELOW',(0,-1),(-1,-1),0.5,GOLD_LT),
        ('LINEABOVE',(0,0),(-1,0),0.5,GOLD_LT)]))
    return t

def data_table(header,rows):
    th=ParagraphStyle('th',parent=body,fontName='Serif-B',fontSize=10,leading=13.4,textColor=WINE,spaceAfter=0)
    td=ParagraphStyle('td',parent=body,fontSize=9.9,leading=13.4,spaceAfter=0)
    data=[[Paragraph(esc(c),th) for c in header]]+[[Paragraph(esc(c),td) for c in r] for r in rows]
    n=len(header)
    widths={2:[84*mm,84*mm],3:[50*mm,61*mm,57*mm],4:[42*mm,42*mm,42*mm,42*mm]}[n]
    t=Table(data,colWidths=widths,repeatRows=1)
    style=[('BACKGROUND',(0,0),(-1,0),T_HEAD),('GRID',(0,0),(-1,-1),0.7,T_GRID),('BOX',(0,0),(-1,-1),1.4,GOLD),
        ('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
        ('TOPPADDING',(0,0),(-1,-1),3.8),('BOTTOMPADDING',(0,0),(-1,-1),3.8)]
    for i in range(1,len(data)): style.append(('BACKGROUND',(0,i),(-1,i),T_ROW_A if i%2 else T_ROW_B))
    t.setStyle(TableStyle(style))
    return t

def sec_header(title):
    return KeepTogether([
        Paragraph('◈',ParagraphStyle('orn',fontName='Serif',fontSize=13,leading=14,textColor=GOLD,alignment=TA_CENTER,spaceAfter=1)),
        Paragraph(title,sec_style),
        HRFlowable(width='46%',color=GOLD,thickness=1,hAlign='CENTER',spaceBefore=3,spaceAfter=3),
        Spacer(1,8)])

def furniture(running):
    def draw(canv,doc):
        w,h=A4
        canv.saveState()
        canv.setFillColor(PARCH); canv.rect(0,0,w,h,stroke=0,fill=1)
        m1,m2=9*mm,11.5*mm
        canv.setStrokeColor(GOLD); canv.setLineWidth(1.6); canv.rect(m1,m1,w-2*m1,h-2*m1)
        canv.setStrokeColor(GOLD_LT); canv.setLineWidth(0.6); canv.rect(m2,m2,w-2*m2,h-2*m2)
        for (cx,cy) in [(m1,m1),(w-m1,m1),(m1,h-m1),(w-m1,h-m1)]:
            for s,col in [(3.8*mm,GOLD),(1.7*mm,PARCH),(0.8*mm,WINE)]:
                canv.setFillColor(col); p=canv.beginPath()
                p.moveTo(cx,cy-s); p.lineTo(cx+s,cy); p.lineTo(cx,cy+s); p.lineTo(cx-s,cy); p.close()
                canv.drawPath(p,stroke=0,fill=1)
        if running:
            canv.setFillColor(DIM); canv.setFont('Serif-I',9)
            canv.drawCentredString(w/2,h-7.6*mm,'DDice · A Chronicle of Commands')
        canv.setFillColor(DIM); canv.setFont('Serif-I',10)
        canv.drawCentredString(w/2,4.8*mm,f'~ {doc.page} ~')
        canv.restoreState()
    return draw

class ChronicleDoc(BaseDocTemplate):
    def afterFlowable(self, flowable):
        flows = flowable._content if isinstance(flowable, KeepTogether) else [flowable]
        for fl in flows:
            if isinstance(fl, Paragraph) and fl.style.name == 'h1':
                text = fl.getPlainText()
                key = 'sec-' + text.replace(' ', '-')
                self.canv.bookmarkPage(key)
                self.canv.addOutlineEntry(text, key, level=0, closed=False)
                self.notify('TOCEntry', (0, text, self.page, key))

def render(item):
    k=item[0]
    if k=='h2': return [Paragraph(item[1],h2)]
    if k=='code': return [code_block(item[1]),Spacer(1,5)]
    if k=='p': return [Paragraph(item[1],body)]
    if k=='note': return [Paragraph(item[1],note)]
    if k=='table': return [Spacer(1,3),data_table(item[1],item[2]),Spacer(1,7)]
    return []

def build(edition, outfile, subtitle):
    items = filter_content(edition)
    margin=18*mm
    doc=ChronicleDoc(outfile,pagesize=A4,leftMargin=margin,rightMargin=margin,topMargin=margin,bottomMargin=margin)
    frame=Frame(doc.leftMargin,doc.bottomMargin,doc.width,doc.height,id='main')
    doc.addPageTemplates([
        PageTemplate(id='cover',frames=[frame],onPage=furniture(False)),
        PageTemplate(id='page',frames=[frame],onPage=furniture(True))])
    toc=TableOfContents()
    toc.levelStyles=[ParagraphStyle('toc0',fontName='Serif',fontSize=12.4,leading=20,textColor=INK,leftIndent=6)]
    toc.dotsMinLevel=0
    story=[Spacer(1,30*mm),Paragraph('· DDice ·',title_st),
        HRFlowable(width='34%',color=GOLD,thickness=1.2,hAlign='CENTER',spaceBefore=6,spaceAfter=6),
        Paragraph(subtitle,sub_st),
        Spacer(1,14*mm),Paragraph('— Contents —',toc_h),toc,NextPageTemplate('page')]
    i=0
    while i<len(items):
        item=items[i]; k=item[0]
        if k=='sec':
            story.append(CondPageBreak(doc.height - 24)); story.append(sec_header(item[1]))
        elif k=='pbreak':
            story.append(CondPageBreak(doc.height - 24)); story.append(Spacer(1,2))
        elif k=='h2':
            group=[Paragraph(item[1],h2)]
            if i+1<len(items) and items[i+1][0] in ('code','p','table','note'):
                group+=render(items[i+1]); i+=1
            story.append(KeepTogether(group))
        else:
            story+=render(item)
        i+=1
    story+=[Spacer(1,6),HRFlowable(width='30%',color=GOLD_LT,thickness=0.8,hAlign='CENTER',spaceBefore=10,spaceAfter=2),
        Paragraph('Penned by the DDice Scriptorium · May your rolls be ever in your favour',foot_st)]
    doc.multiBuild(story)
    print(f'built {edition} → {outfile}')

OUT = '/mnt/user-data/outputs/'
build('full',   OUT + 'DDice-Commands-Parchment.pdf',  'A Chronicle of Commands for the Tabletop Herald')
build('player', OUT + 'DDice-Commands-Player.pdf',     'A Chronicle of Commands · Player\u2019s Edition')
build('gm',     OUT + 'DDice-Commands-GameMaster.pdf', 'A Chronicle of Commands · Game Master\u2019s Edition')
