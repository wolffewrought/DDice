#!/usr/bin/env python3
"""DDice — Chronicle of Commands. Parchment design, three editions per system:

  player → DDice-Commands-Player.pdf      (the player's journey; nothing a player cannot run)
  gm     → DDice-Commands-GameMaster.pdf  (the GM's journey; the table's half, then the GM's, chapter by chapter)
  full   → DDice-Commands-Parchment.pdf   (the GM journey with nothing left out)

Content lives in PARTS (bundles by subject) and each edition walks them in the
order BOOKS gives. Items carry an audience via ('aud', ...) markers; individual
code rows can override with a third element ('cmd', 'comment', 'gm'|'player') so
mixed blocks (like the Fight commands) split cleanly. Empty headings left behind
by filtering are pruned.
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
import os as _os

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

# ── Content ──────────────────────────────────────────────────────────────────
# PARTS bundles every item by subject; BOOKS is the journey each edition takes
# through them — a chapter title and the parts it binds, in reading order. The
# same part can sit in both books at different places. Inside a part, ('aud', X)
# says who the items that follow are for ('all' | 'gm' | 'player'); a code row
# may still override with a third element. PART_SYSTEM marks the parts that
# belong to one rule system; everything unmarked is shared by both.
PARTS = {}

PARTS['start'] = [
('aud', 'all'),
('p', 'DDice runs the table. It rolls the dice, keeps every character sheet, runs fights turn by turn, posts quests, pays merits and remembers what happened. You talk to it in two ways. <b>Slash commands</b> begin with <b>/</b> and Discord shows every option as you type — <b>/roll stat:Strength</b> is the command <b>/roll</b> with its <b>stat</b> option filled in. <b>Typed shorthands</b> are plain messages the bot watches for — <b>1d20</b>, <b>str</b>, <b>hp +2</b> — for the things you do fifty times a night.'),
('h2', 'How to Read This Book'),
('p', 'Commands are shown as you would type them. <b>@Players</b> stands for a player picked from the list Discord offers and <b>@GMs</b> for a Game Master (or the GM role); where an example needs real names, <b>Artorius</b>, <b>Meliora</b> and <b>Zeus</b> stand in. <b>name:</b>, <b>number:</b> and the like are options — type the label, then your answer. Where a line reads <b>(GM)</b>, only a Game Master can run it. The chapters follow the order you will meet things: rolling first, then your character, then fights, quests and standing.'),
('code', [('/help', 'overview of all command groups'),
          ('/help category:start', 'the new-player guide — the whole game in one page'),
          ('/help category:dice', 'detail on a specific group'),
          ('/help category:rules', 'the live table rules as the bot enforces them \u2014 the same\nwords the books use, readable by everyone')]),
('note', 'Anywhere a command asks for something that already exists — an NPC, a quest, a weapon, a tag, an activity and its scenes, a category, a recovery schedule, an item someone is carrying, a title, a group, a spell, a saved sheet, a rest amount — a <b>dropdown appears as you type</b>, and you can still type past it freely. Where a new name is the point (create, add, save) what you typed leads the list.'),
('h2', 'Where the News Lands'),
('p', 'A forum called <b>updates</b> carries one dated thread for every change the bot has had — titled by the day it landed, newest at the top — and every entry the bot has ever announced is there from the first. When something in this book looks different from what the bot does, the updates forum says what changed and when.'),
]

PARTS['roll'] = [
('aud', 'all'),
('p', 'Type dice notation directly or use any prefix style (r, !r, !roll):'),
('code', [('1d20', 'bare notation — no prefix needed'),
          ('r1d20+5', ''),
          ('r1d20+5 atk', 'label shows in bold above result'),
          ('r1d20+5 atk\n[flavour text on next line]', 'supports *italic* and **bold**')]),
('h2', 'Advantage & Disadvantage'),
('code', [('ra1d20+5', 'rolls twice, takes higher'),
          ('rd1d20+5', 'rolls twice, takes lower')]),
('h2', 'Guided Roll (/roll)'),
('code', [('/roll', 'bare: a flat 1d20 \u2014 no stat, no modifier'),
          ('/roll stat:Strength', 'pick a stat from the dropdown'),
          ('/roll stat:Wisdom mode:Advantage', 'advantage / disadvantage'),
          ('/roll dice:2d6+3 label:damage', 'custom notation instead of a stat'),
          ('/roll stat:Dexterity success_check:true\n  label:sneak flavour:*slips into shadow*', 'label + RP text'),
          ('/roll last:true', 'recall your last roll in this channel')]),
('p', 'Every part of <b>/roll</b> is a dropdown or field \u2014 stat, advantage, success check, label and '
      'RP flavour \u2014 so nothing has to be memorised. Choose either a <b>stat</b> (rolls 1d20 + that stat '
      'from your sheet) or custom <b>dice</b>. The result uses the same card as a typed roll.'),
]

PARTS['roll-kf'] = [
('aud', 'all'),
('h2', 'Stat Quick Rolls'),
('code', [('str   con   dex   wis   lck', 'on their own — nothing else in the message'),
          ('strength   constitution   dexterity', 'long names roll exactly the same'),
          ('wisdom   luck', ''),
          ('wisa   dexd', 'advantage / disadvantage · a label may follow'),
          ('r str atk', 'a plain stat roll with a label'),
          ('?str atk', 'the same, as a success check')]),
('p', 'Rolls 1d20 + that stat from your saved character. Add <b>a</b> for advantage or <b>d</b> for '
      'disadvantage — <b>wisa</b>, <b>dexd</b>. Every stat answers to its <b>full name</b> as well as its '
      'short one, and they behave identically: <b>strength</b> is <b>str</b>, <b>wisdoma</b> is <b>wisa</b>, '
      '<b>luckrra</b> is <b>lckrra</b>.'),
('p', 'A stat roll <b>always shows your sheet</b> — stats, HP, rerolls and all — even with the profile '
      'embed switched off. A bare <b>1d20+4</b> tells nobody which stat it was or where the 4 came from, so '
      'the card is forced open where the numbers need explaining. Plain dice rolls still honour '
      '<b>/char profile off</b>.'),
('p', '<b>A plain stat name must be the whole message.</b> <b>str</b>, <b>con</b>, <b>dex</b>, <b>wis</b> and '
      '<b>lck</b> are ordinary words in conversation, so anything typed after one means it is treated as '
      'chat and left alone — “Dex or strength can both be used to throw things” is a sentence, not a '
      'roll. To label a plain stat roll, put a prefix on it: <b>r str atk</b> or <b>?str atk</b>.'),
('p', 'Forms that cannot be mistaken for words keep their labels as they always did — <b>wisa sneak</b>, '
      '<b>dexd guard</b>, <b>strrr atk</b>, <b>conrra hold the line</b>.'),
]

PARTS['roll2'] = [
('aud', 'all'),
('h2', '? Success Check Rolls'),
('p', 'Prefix <b>?</b> instead of <b>r</b> to get a success outcome:'),
('code', [('?1d20+5   ?ra1d20+5   ?rd1d20+5   ?rr   ?str   ?wisa', '')]),
('table', ['Result', 'Outcome'],
          [['Natural 20 / max face', 'Critical Success (gold)'],
           ['Natural 1 / min face', 'Critical Fail (red)'],
           ['Total 15+', 'Success'],
           ['Total 10–14', 'Partial Success'],
           ['Total 2–9', 'Fail']]),
('note', 'The same holds for every check against a DC \u2014 a Game Master\u2019s called check, a planted button, a group check, a target: a natural 20 passes and a natural 1 fails, whatever the total. A natural 20 on a target beats it outright.'),
('h2', 'Targets'),
('p', 'A target is something the Game Master plants in the channel for the party to swing at \u2014 a door, a barricade, a Hollow with no sheet. Its card carries the buttons: one for each stat the Game Master allows, all five when they named none, so you pick the stat you swing with. Pressing opens a short form \u2014 what you do, what you say, both optional \u2014 and your words land above the roll. A natural 20 beats the target outright (<i>Roll critically succeeds</i>) and a natural 1 fails (<i>Roll critically fails</i>); anything else reads <i>The roll succeeds</i> or <i>The roll fails</i> and is the Game Master\u2019s call \u2014 <i>The player passes the check \u2014 Roll succeeds</i>, or <i>fails</i> \u2014 with their words on what happens beneath. When a swing fails, the card comes back at the bottom of the channel with its buttons, counting its returns, ready for the next.'),
('h2', 'Critical Hits & Fails (all rolls)'),
('p', 'Natural max on any die → gold label + result.<br/>Natural 1 on any die → red label + result.'),
('h2', 'One Reroll Per Roll'),
('p', 'A roll can be rerolled <b>once</b>. Whatever the second attempt says, it stands \u2014 you cannot keep '
      'spending rerolls on the same roll until the dice agree with you. This holds everywhere: typed rerolls, '
      '<b>/fight rr</b>, and the prompt inside an activity.'),
('p', 'In a fight each side of an exchange gets its own second chance, so an attacker rerolling does not use '
      'up the defender\u2019s. A fresh exchange resets both.'),
('note', 'Rerolls are still a resource \u2014 this is a limit on top of having one to spend, not instead of it.'),
('h2', 'Rerolls'),
('code', [('rr', 'costs 1 token'),
          ('rra', 'reroll with advantage'),
          ('rrd', 'reroll with disadvantage')]),
('p', 'Shorthand: append a reroll set to a stat — <b>strrr</b>, <b>dexrra</b> (adv), '
      '<b>conrrd</b> (dis) — to reroll your last roll. A label may follow: <b>strrr atk</b>.'),
]

PARTS['char'] = [
('aud', 'all'),
('h2', 'Make Your Character'),
('p', '<b>Build your character with /char create.</b> One command sets the whole sheet at once \u2014 every '
      'stat, your order, your class and both weapons \u2014 so it arrives complete instead of in pieces.'),
('code', [('/char create str:14 con:12 dex:10 wis:5 lck:3 \\\n  order:White Knight class:Vanguard \\\n'
           '  weapon1:Longsword weapon2:Tower Shield', 'the whole character, one command')]),
('p', 'Every option is optional \u2014 fill in what you have decided and run it again later to add the rest. '
      'The values for <b>order</b>, <b>class</b> and the weapon fields are listed further down this chapter.'),
('note', 'This matters most where a GM has switched sheet approval on. /char create sends one request for '
         'the whole character; building the same sheet a field at a time sends a fresh request on every '
         'single change and buries the GMs in them. It matters again afterwards, because once your sheet is '
         'approved every field is locked and only a GM can change it \u2014 so /char create is your one clean '
         'run at the character you want.'),
('h2', 'The Point Budget'),
('p', 'A player building their own character spends <b>exactly 15 points</b> across the five stats, and every '
      'stat needs <b>at least 1</b>. Not 14, not 16 \u2014 the full allowance, all of it placed. A ' + GM + ' can '
      'change both numbers for the server with <b>/config mechanics statallowance</b>.'),
('code', [('/char create str:5 con:4 dex:3 wis:2 lck:1', '15 exactly, nothing on zero \u2014 fine'),
          ('/char create str:4 con:4 dex:3 wis:2 lck:1', '14 \u2014 refused, 1 still to place'),
          ('/char create str:6 con:5 dex:3 wis:2 lck:1', '17 \u2014 refused, take 2 back off'),
          ('/char create str:9 con:5 dex:1 wis:0 lck:0', 'over AND stats on 0 \u2014 both reported')]),
('p', 'A sheet also has to be <b>finished</b> before it can go to a ' + GM + ': both weapons named, and an '
      'emoji chosen for each with <b>/char weaponemoji</b>. A weapon emoji has a default, so picking one is '
      'what counts \u2014 leaving it be is not the same as choosing it. Weapons can be set on '
      '<b>/char create</b> in the same breath as your stats.'),
('code', [('/char create str:5 con:4 dex:3 wis:2 lck:1 \\\n  weapon1:Gunlance weapon2:Rifle', 'stats and weapons at once'),
          ('/char weaponemoji slot:Weapon 1 emoji:[choose]', 'then an emoji for each'),
          ('/char weaponemoji slot:Weapon 2 emoji:[choose]', '')]),
('p', 'The refusal is posted <b>in the channel you are working in</b>, not as a private note only you can '
      'see \u2014 so it sits alongside what you typed. A copy also goes to the <b>approval channel</b> with a '
      'jump link back to the attempt, so the ' + GM + 's can see who is wrestling with the budget and step in '
      'without having to be in that channel. Nothing is submitted either way.'),
('p', 'Break a rule and the sheet is refused on the spot with a note saying exactly what is wrong \u2014 both '
      'problems at once if you managed both \u2014 along with your current spread and running total, so you can '
      'see what to move. Nothing is saved and nothing goes to the GMs until it is legal. The same check runs '
      'on <b>/char set</b>, on a pasted sheet, on <b>/char profile load</b> and on <b>/char submit</b>, so there is '
      'no way in around the back.'),
('p', 'Adjusting one stat at a time with <b>/char set</b> only checks the ceiling, so you can shuffle points '
      'between stats freely \u2014 lowering one before raising another would be impossible otherwise. The sheet '
      'is saved either way, but it is held back from the ' + GM + 's until the full allowance is placed, and it '
      'tells you how many points are still loose.'),
('note', GM + 's are not limited by any of this \u2014 building a character for a player, adjusting one, or '
         'making their own. A ' + GM + ' can hand out whatever spread a story calls for, and NPCs are '
         'unaffected entirely.'),
('h2', 'Changing One Field Later'),
('p', 'Use <b>/char set</b> to adjust a single thing after the fact \u2014 a stat that went up, a weapon you '
      'swapped. It is a touch-up tool, not the way to build a character from nothing. Pick the <b>field</b> first: '
      '<b>value</b> then offers what fits it \u2014 the orders, the classes, the weapon list, the weapon emojis.'),
('code', [('/char set field:str value:14', 'one field at a time', 'player'),
          ('/char set field:con value:12', 'HP auto-maxes to CON + 2', 'player'),
          ('/char set field:lck value:3', 'rerolls auto-max to LCK', 'player'),
          ('/char set field:str value:14 user:@Players', GM + ' only', 'gm')]),
('h2', 'Knight Orders'),
('p', 'These are the values to pass to <b>order:</b> on /char create \u2014 or to /char set if this is the '
      'only thing you are changing.'),
('code', [('/char set field:order value:White Knight', 'also: Black, Gold, Grey, Blue,'),
          ('/char set field:order value:Red Knight', 'Purple, Green, Red')]),
('h2', 'Class, Weapons & Emojis'),
('code', [('/char set field:class value:Vanguard', 'Vanguard / Defender / Siege Knight \u2014 Hero is a status a GM grants'),
          ('/char set field:weapon1 value:Longsword', ''),
          ('/char weaponemoji slot:Weapon 1 emoji:[choose]', 'standard emoji dropdown'),
          ('/char weaponemoji slot:Weapon 1 custom::sword:', 'paste a server emoji')]),
('note', 'Pick a standard emoji from the dropdown, or paste a server custom emoji in the \u201ccustom\u201d '
         'field (it overrides the dropdown). The image export falls back to a sword glyph for custom emojis.'),
('h2', 'Is My Sheet Ready?'),
('p', 'Rather than finding out one refusal at a time, ask.'),
('code', [('/char check', 'the whole checklist at once')]),
('p', 'It shows your stats against the point allowance and how far off you are, whether both weapons are '
      'named, whether both emojis are chosen, and then whether the sheet is ready to send, already with a '
      + GM + ', or approved.'),
('h2', 'If a GM Sends It Back'),
('p', 'If a GM <b>rejects</b> your sheet you can fix it and try again yourself \u2014 change whatever they '
      'objected to with <b>/char set</b> or <b>/char create</b> and it goes straight back to them. If you think '
      'it was right as it stood, <b>/char submit</b> sends it again unchanged. There is no limit on how many '
      'times a sheet can go back and forth.'),
]

PARTS['sheet'] = [
('aud', 'all'),
('h2', 'Reading & Sharing Your Sheet'),
('code', [('/char create ...', 'see Making Your Character \u2014 builds the whole sheet'),
          ('/char view show          /char view show user:@Players', ''),
          ('/char export        /char export format:Image', ''),
          ('/char export format:Parchment image', 'the sheet on parchment, in the scroll font \u2014 for\ndisplay; Discord strips an image\u2019s weave on re-upload,\nso use the Parchment PDF or Text block to travel'),
          ('/char export format:Parchment PDF', 'the same parchment as a PDF \u2014 the one file that\nsurvives Discord re-uploads, sheet woven after its EOF'),
          ('/char export format:Career PDF', 'the career record as a native-text parchment PDF,\ncareer woven after its EOF \u2014 survives Discord and\nimports back through /char import'),
          ('/char export format:Summary', 'the career record \u2014 rank, merits, renown, dice\nhistory, pack, quests, lore \u2014 over a paste-able\n[TTRPG SUMMARY] block'),
          ('/char import', 'hand an exported sheet OR career block to this\nserver \u2014 a Parchment PDF (the carrier that survives\nDiscord), a pasted block, or bare for a paste box; a\nGM approves. Careers move merits and renown to the\nimported totals and add dice history, items and lore \u2014\nsheet, rank, quests, tags untouched'),
          ('/char submit', 'resend your sheet after a rejection')]),
('p', '<b>With sheet approval switched on, an export goes to the GMs first.</b> Running <b>/char export</b> '
      'posts the sheet block into the approval channel with <b>Release to player</b> / <b>Decline</b> buttons; '
      'the player sees only a private note that it has been sent. When a GM releases it, the block arrives by '
      'DM \u2014 or back in the channel they exported from, if their DMs are closed. Exporting is not an edit: it '
      'never changes a sheet\u2019s approval state and never stops anyone rolling. Exporting again replaces the '
      'previous request, so the channel holds one live entry per player. GMs export straight away, for '
      'themselves and for anyone else, and on servers not using approvals nothing changes.'),
('h2', 'The Pages of a Sheet'),
('p', 'Beyond the stat block, a character accumulates things worth keeping. Each page can be read for '
      'yourself or for someone else with <b>user:</b>.'),
('code', [('/char view show full:true', 'the card and every page below, on one post'),
          ('/char view inventory', 'what they are carrying'),
          ('/char view standing', 'merit and renown, and where each came from'),
          ('/char view rollhistory', 'every natural die this character has rolled'),
          ('/char view rollhistory sides:6', 'the same for a different die'),
          ('/char lore', 'write your lore and send it to the ' + GM + 's'),
          ('/char view showlore', 'read approved lore')]),
('p', '<b>Inventory</b> holds roleplay items \u2014 things an activity handed over, or a ' + GM + ' gave out by '
      'hand with <b>/char give user:@Players item:A tarnished silver key</b>. Each carries a number, so '
      '<b>/char take user:@Players id:3</b> removes one. Giving and taking are ' + GM + '-only.'),
('p', '<b>Standing</b> puts total merit and renown at the top, then lists every movement beneath it \u2014 the '
      'quest, activity or ' + GM + ' award that caused it, the amount, and how long ago. Merits are a lifetime '
      'tally that only climbs; renown is a currency that is spent again.'),
('p', '<b>Roll history</b> counts every natural die a character has ever rolled, drawn as a bar chart with the '
      'natural 20s and 1s marked. It follows the character, not the player, and covers every roll they make '
      '\u2014 typed, slash, in a fight or in an activity.'),
('p', '<b>Lore</b> opens a writing box, pre-filled with whatever you wrote last time. It goes to the same '
      'channel character sheets do, with Approve / Reject buttons; a rejection asks the ' + GM + ' why and '
      'passes the reason back. Only approved lore shows on <b>/char view showlore</b> \u2014 before that it says it is '
      'waiting, or why it was turned down. Rewriting retires the old request and sends a fresh one.'),
('note', 'Nothing here is required. A character works perfectly well with an empty inventory, no lore and no '
         'renown \u2014 these are for tables that want to track more.'),
('h2', 'Your Thread'),
('p', 'With a character forum set, every approved character gets a thread of their own there — the sheet first, then inventory, lore, standing, titles and associations as posts beneath it — kept current by the bot, so the sheet in your thread changes the moment a stat does. A button on the page asks a GM to update your lore document; everything else writes itself.'),
('h2', 'Your Roll Card'),
('p', 'How much of your sheet appears when you roll is up to you.'),
('code', [('/char profile card style:Full', 'the whole sheet'),
          ('/char profile card style:Compressed', 'one line of stats'),
          ('/char profile card style:Off', 'plain text rolls')]),
('p', 'Compressed puts everything on a single line under the roll \u2014 '
      '<b>STR 5 \u00b7 CON 5 \u00b7 DEX 4 \u00b7 WIS 4 \u00b7 LCK 2 \u00b7 HP 8/8 \u00b7 RR 2/2</b> \u2014 which keeps a busy '
      'channel readable without hiding where a modifier came from.'),
('note', 'A <b>stat roll always shows something</b>, even with your card Off: <b>1d20+4</b> says nothing about '
         'which stat it was or where the 4 came from, so those fall back to the compressed line. Choosing '
         'Compressed is respected rather than overridden \u2014 the bot never upgrades you to Full. Plain dice '
         'rolls honour Off completely.'),
('h2', 'Saved Sheets'),
('code', [('/char profile save slot:vault', 'keep a copy of your sheet'),
          ('/char profile load slot:vault', 'put it back'),
          ('/char profile saves', 'what you have saved')]),
('note', 'Loading a save is checked like any other change \u2014 an old snapshot cannot smuggle in a spread that '
         'breaks the current point allowance.'),
('h2', 'Profile'),
('code', [('/char profile on', 'enable embed, max HP + rerolls'),
          ('/char profile off', 'disable embed, plain text rolls'),
          ('/char profile show', 'preview card without rolling')]),
('h2', 'Sheet Import'),
('p', 'Paste an exported sheet into any channel the bot watches.'),
('code', [('[paste sheet into channel]', 'your own exported sheet, back onto this server', 'player'),
          ('[paste sheet] @Players', GM + ' importing for another player', 'gm')]),
('h2', 'Heroes'),
('p', 'Hero is a <b>status</b>, not a class. A ' + GM + ' grants it, and it sits alongside whatever class '
      'and knight order a character already holds \u2014 a Hero can be a Green Knight Vanguard.'),
('code', [('/char hero user:@Players value:true', GM + ' grants it'),
          ('/char hero user:@Players value:false', 'and takes it away'),
          ('/char signature user:@Players stat:Strength', 'a Hero rolls that stat with advantage')]),
('note', 'It used to occupy the class slot, so a Hero could be nothing else. Anyone whose class said Hero '
         'has been moved across automatically and their class slot freed. Removing Hero status clears the '
         'signature stat with it.'),
]

PARTS['hp'] = [
('aud', 'all'),
('p', 'Your hit points and reroll tokens live on your sheet, and the typed shorthands below move them. The <b>!</b> prefix is optional — <b>hp +5</b> and <b>!hp +5</b> are the same message.'),
('code', [('!hp +5', ''),
          ('!hp -3', ''),
          ('!rerolls +1    !rerolls -1', 'reroll tokens, the same way')]),
('h2', 'Heal (White Knight + WIS 5 only)'),
('p', 'Targets another player — cannot self-heal.'),
('code', [('!heal @Players', ''), ('!h @Players', '')]),
('table', ['Roll Result', 'Effect', 'Charges Used'],
          [['Natural 20', '+2 HP restored', 'None'],
           ['20+ (modified)', '+2 HP restored', '1'],
           ['2 – 19', 'No heal', '1'],
           ['Natural 1', 'No heal', '2']]),
('h2', 'Rest Commands (Player)'),
('p', 'A ' + GM + ' can point any of these at a player by adding their mention — <b>lrest @Players</b>. Default amounts shown — '
      + GM + 's can change them with <b>/config mechanics rest</b>.'),
('table', ['Command', 'HP', 'Rerolls', 'Heal Charges'],
          [['lrest', 'Full', 'Full', 'Full'],
           ['srest', 'Half', '—', '—'],
           ['hpfull', 'Full', '—', '—'],
           ['hphalf', 'Half', '—', '—']]),
('note', 'Short rest restores HP only by default. A ' + GM + ' can re-enable rerolls/heal or change any amount.'),
]

PARTS['fight'] = [
('aud', 'all'),
('p', 'Proper fights: everyone rolls to see who goes first, then takes turns. The bot keeps score.'),
('h2', 'Commands'),
('code', [('/fight start players:@Artorius @Meliora @Zeus npcs:Hollow, Hollow tank', 'any number of each', 'player'),
          ('/fight start ... manual:true', 'skip roll, keep listed order', 'player'),
          ('/fight start ... practice:true', 'friendly bout — fighters yield at 2 HP', 'player'),
          ('/fight addnpc npc:Hollow, Hollow tank', 'add NPC(s) mid-fight, ' + GM, 'gm'),
          ('/fight add user:@Players where:Next', 'bring a player into a running fight \u2014 HP from their\nsheet, initiative rolled for the record; Next puts them\nstraight after this turn, Last at the end, ' + GM, 'gm'),
          ('/fight order sequence:@Artorius, Hollow, @Meliora, @Zeus', 'reorder players + NPCs, ' + GM, 'gm'),
          ('/fight atk stat:str target:@Players', 'attack a player', 'player'),
          ('/fight act action:Grapple target:@Players', 'STR-only grapple attempt — the target answers with\n/fight act action:Save (STR only). If the attempt meets or\nexceeds the save, the hold takes: immobile, 1 strain\nof damage at the end of each of their turns, and any\naction on a flat d20. The grappler may release freely\nand can never strike their own captive', 'player'),
          ('/fight act action:Grapple npc:Hollow tank target:@Players', GM + ' grapples AS the NPC — same STR contest; the\nplayer answers with /fight act action:Save', 'gm'),
          ('/fight act action:Save', 'your STR save against the pending grapple — GMs\nsave for an NPC with npc:Name; auto NPCs save\nthemselves', 'player'),
          ('/fight act action:Save npc:Hollow tank', GM + ' rolls the NPC\u2019s STR save against a player\u2019s\ngrapple; auto NPCs save themselves', 'gm'),
          ('/fight act action:Escape', 'on your turn while held: a live STR contest \u2014 you\nroll 1d20+STR, the grappler\u2019s hold rolls its own\n1d20+STR back (signature advantage honoured), and\nties keep the hold. Break free by beating it; the\nstrain of the struggle lands whether you slip it\nor not', 'player'),
          ('/fight act action:Escape npc:Hollow tank', GM + ' breaks a held NPC free on its turn \u2014 a live\nSTR contest against the holder\u2019s own roll, ties to\nthe grappler; the strain of the struggle lands\neither way', 'gm'),
          ('/fight act action:Release', 'the holder lets go — a free action, the turn stands;\nGMs may part any hold with target:', 'player'),
          ('(the buttons)', 'on your turn: five stat buttons to attack with, then\nGrapple \u00b7 Feint beneath (both ask whom; Feint then asks\nwhat you pretend) \u2014 no Grapple while you are held. When\nan NPC attacks you, the defence row adds Deflect \u00b7 Disarm. Holding someone adds Maintain the hold (an\nopposed STR roll each turn) and Release; being held adds\nBreak free. Save and Insight sit on the card that asks'),
          ('/fight act action:Release npc:Hollow tank', GM + ' releases AS the NPC holder; add target: to\nforce-part any hold from the outside', 'gm'),
          ('/fight act action:Deflect', 'shield deflection against a PvE strike — needs a\nshield equipped and STR 4+ (the gate holds whichever\nstat rolls), once per round, and a natural 20 cannot\nbe turned. Roll STR or DEX (stat:) to beat the attack\nroll; optionally redirect_npc: sends the blow into\nanother enemy for 1 damage. Fall short and it lands\non you for 1. Either way your next attack roll is a\nflat d20', 'player'),
          ('/fight act action:Disarm', 'disarm a PvE attacker — needs a blade equipped\n(swords, polearms, daggers; not maces, shields or\nfirearms) and DEX 4+, once per round. Roll DEX to\nbeat the attack roll — no damage, but the enemy\nspends their next turn retrieving the weapon. Fall\nshort and the strike lands on you for 1. Either way\nyour next defence roll is a flat d20', 'player'),
          ('/fight act action:Deflect \u00b7 /fight act action:Disarm (vs your NPCs)', 'player abilities your NPCs face: a deflected strike\ncan be redirected into ANOTHER of your enemies for\n1 damage, and a disarmed NPC\u2019s next turn — manual\nor auto — is spent retrieving its weapon', 'gm'),
          ('/fight act action:Feint feint:\"...\"', 'a feint spends either half of a fight. On YOUR\nturn it is an attack \u2014 WIS against their insight,\nand if they fall for it the blow lands with normal\ndamage (a natural 20 still crits) AND their next\naction rolls flat. With a strike pending on YOU it\nis a defence roll instead \u2014 WIS in place of your\nusual stat \u2014 and reading the blow leaves the\nattacker off-balance. Either way your own next\ndefence rolls flat. WIS 4+; ties go to the target.\nONE TRICK PER HONEST ROLL: after a feint you must\nmake an ordinary stat roll before you can feint\nor deceive again'),
          ('/deception target:@Players claim:\"...\"', 'deception away from the sword \u2014 the same WIS\ncontest, usable anywhere: a market, a hall, a\ncell. Both roll at once; win and their very next\nroll is a straight d20, whether that is a fight\naction, a chat roll or an activity. Shares the\nfeint\u2019s cooldown \u2014 one trick per honest stat roll'),
          ('/fight act action:Feint feint:"..." npc:Hollow Lieutenant target:@Players', GM + ' feints AS the NPC — WIS vs WIS; the player\nanswers with /fight act action:Insight, and a fooled player\nrolls their very next action flat', 'gm'),
          ('/fight act action:Insight', 'your WIS check against the pending feint — GMs\nroll for an NPC with npc:Name; auto NPCs check\nthemselves. If an earlier feint already fooled you,\neven this roll is flat', 'player'),
          ('/fight act action:Insight npc:Hollow Lieutenant', GM + ' rolls the NPC\u2019s WIS insight against a player\u2019s\nfeint; auto NPCs check themselves', 'gm'),
          ('/fight atk stat:str target_npc:Hollow tank', 'attack an NPC', 'player'),
          ('/fight atk stat:str npc:Hollow target:@Players', GM + ' attacks AS the NPC', 'gm'),
          ('/fight def stat:dex', 'defend', 'player'),
          ('(buttons)', 'every prompt carries its answer: the attack card\noffers five DEFEND stat buttons, the grapple card\na Save, the feint card an Insight, the defence\ncard Resolve \u2014 and Reroll rides along. One press,\nsame rules, same audit trail', 'player'),
          ('/fight def stat:dex npc:Hollow', GM + ' defends AS the NPC', 'gm'),
          ('/fight rr', 'reroll last fight roll — 1 token', 'player'),
          ('/fight resolve', 'resolve the exchange', 'player'),
          ('/fight status', 'show turn order and HP', 'player'),
          ('/fight log', 'repost the recap of the last finished fight in\nthis channel \u2014 only the fighters who actually\ntook part, and only that fight: a new fight always\nstarts a fresh recap'),
          ('/fight skip', 'skip the current turn — fighter stays in, ' + GM, 'gm'),
          ('/fight hp value:3 target_npc:Hollow tank', 'set HP mid-fight, sheet synced, ' + GM, 'gm'),
          ('/fight kick target_npc:Hollow tank', 'remove a fighter, fight continues, ' + GM, 'gm'),
          ('/fight refill npcs:all', '"all" or names — refill reroll tokens, ' + GM, 'gm'),
          ('/fight auto mode:Full ...', 'bot resolves whole fight, ' + GM, 'gm'),
          ('/fight auto mode:Full\n  teams:@Artorius @Meliora @Zeus vs Hollow, Hollow tank', 'party-vs-monsters sides, ' + GM, 'gm'),
          ('/fight auto mode:NPCs only ...', 'bot plays NPCs, ' + GM, 'gm'),
          ('/fight auto mode:Demo', 'example showcase, ' + GM, 'gm'),
          ('/fight auto ... practice:true', 'a bout in any auto mode, ' + GM, 'gm'),
          ('/fight forfeit', 'concede — HP preserved', 'player'),
          ('/fight end', GM + ' only', 'gm')]),
('h2', 'How a Fight Runs'),
('p', 'When a fight starts, the bot rolls DEX initiative (1d20 + DEX) for every fighter and orders the '
      'turn order from highest to lowest, ties broken by the raw d20. Add <b>manual:true</b> to skip the '
      'roll and keep your listed order, or use <b>/fight order</b> with a comma-separated sequence.'),
('p', '<b>Knocked-down fighters:</b> anyone at 0 HP or less is left out when a fight starts or when NPCs '
      'are added, with a warning naming them. Restore NPCs with <b>/npc heal</b> or <b>/npc hp</b>, '
      'players with rests or <b>hpfull @Players</b>.'),
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
('h2', 'Picking a Target'),
('p', 'Leave <b>target</b> off <b>/fight atk</b> and the bot asks who you mean, listing everyone still '
      'standing with their HP \u2014 NPCs marked, the fallen and the already-downed left out, and yourself '
      'excluded. Choosing one hands back the command with the target filled in, ready to send.'),
('note', 'With only one opponent left there is nothing to choose, so it simply names them. The menu belongs '
         'to whoever opened it \u2014 nobody else can pick your target for you.'),
('h2', 'A Custom Roll in a Fight'),
('p', 'When it is your turn, <b>/roll ... fight:true</b> submits that roll in place of <b>/fight atk</b> or '
      '<b>/fight def</b> \u2014 so a ' + GM + ' can call for something unusual without the fight chain breaking and '
      'everyone falling back to rolling by hand.'),
('code', [('/roll dice:2d6+3 fight:true target:@Artorius', 'attack with 2d6+3'),
          ('/roll dice:1d100 fight:true', 'defend with a d100'),
          ('/roll action:Grapple target:@Artorius', 'any fight ability straight from /roll \u2014 the\nsame menu as /fight act (pick Save to answer\na pending grapple, Insight for a feint, and so\non). No advantage option here \u2014 /fight act\nroll: carries that'),
          ('/roll stat:wis fight:true target:@Artorius', 'attack with WIS instead of STR')]),
('p', 'It writes into the same fight the normal commands use, so <b>/fight resolve</b> handles it exactly as '
      'ever \u2014 damage, criticals, carry-over effects and the recap. The die size is remembered, so a natural '
      '20 on a d6 is not mistaken for a critical.'),
('note', 'It has to be asked for. A player rolling casually mid-fight should not accidentally commit their '
         'turn, so nothing is submitted without <b>fight:true</b>. If it is not your moment the roll is '
         'refused with the reason, and stands alone instead.'),
('h2', 'Your Preferred Stats'),
('code', [('/char prefer atk:Dexterity def:Constitution', 'your own, for when auto rolls for you'),
          ('/char prefer', 'see what is set'),
          ('/char prefer atk:Clear it', 'go back to using your best')]),
('p', 'This matters to players as well as ' + GM + 's: <b>/fight auto</b> in full mode rolls for '
      '<b>everyone</b> in the fight, so without a preference your character swings with their strongest '
      'arm whether that suits them or not.'),
('note', 'A preference <b>never overrides a weapon</b>. If what you asked for is not one of the stats your '
         'weapons allow, your best allowed stat is used instead and <b>/char prefer</b> tells you so \u2014 '
         'setting one can only ever narrow a free choice, never break a rule.'),
('h2', 'Damage'),
('table', ['Situation', 'Damage'],
          [['Attack total ≥ Defence total', '1'],
           ['Attacker natural 20', '+1 bonus'],
           ['Defender natural 1', '+1 bonus'],
           ['Attacker nat 20 + Defender nat 1', '4 total'],
           ['Attacker nat 20 + Defender nat 20', 'The attack lands whatever the totals \u2014 2'],
           ['Defence total > Attack total', '0 (blocked)'],
           ['Fighter reaches 0 HP', 'Knocked down, removed from turn order, HP goes negative']]),
('p', 'Players can reroll using <b>rr / rra / rrd</b> after their initial roll before <b>/fight resolve</b>.'),
('h2', 'Critical Effects (carry-over)'),
('p', 'A natural 1 or natural 20 leaves a mark on the <i>next</i> roll, in both manual and auto fights:'),
('table', ['Trigger', 'What happens'],
          [['Natural 1 on an attack', 'The attack fails automatically, whatever the totals say \u2014 and the attacker\u2019s next defence is rolled as a flat d20 (no stat, no advantage)'],
           ['Natural 20 on a defence', 'The blow is parried automatically \u2014 unless the attack was also a natural 20: twenty meets twenty, and the attack lands whatever the totals, for 2. Either way the defender gains +2 TO HIT on their next attack roll (added to the stat modifier \u2014 never to damage)']]),
('note', 'Each carried effect is consumed by that fighter\u2019s next matching roll and announced when it lands (\u201cpresses the riposte\u201d, \u201cdefends on a flat d20\u201d). Leaving a fight clears any pending effects.'),
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
('aud', 'gm'),
('p', '<b>NPCs as combatants:</b> a ' + GM + ' lists NPCs in <b>npcs:</b> (comma-separated) on start '
      'or <b>/fight addnpc</b> later. On an NPC\u2019s turn the ' + GM + ' adds <b>npc:Name</b> to '
      '<b>/fight atk</b> or <b>/fight def</b>; attack an NPC with <b>target_npc:Name</b>.'),
('h2', 'Auto Modes'),
('p', '<b>/fight auto mode:Full</b> rolls attack, defend and damage for everyone and plays the fight '
      'through to a winner, saving HP to each combatant\u2019s sheet as it changes. Add '
      '<b>teams:@Artorius @Meliora @Zeus vs Hollow, Hollow tank</b> for proper sides — fighters only target the enemy team, and the '
      'last team standing wins. <b>mode:NPCs only</b> starts a normal fight where the bot takes the '
      'NPCs\u2019 turns automatically while players still use <b>/fight atk</b> and <b>/fight def</b>. '
      '<b>mode:Demo</b> runs a throwaway example.'),
('p', '<b>Automatic rolls</b> always use the fighter\u2019s highest of STR or DEX, for attack and defence '
      'alike (ties go to STR), and post the same full roll card as a manual roll. Each NPC\u2019s cards '
      'appear under that NPC\u2019s own name and avatar (via webhook).'),
('p', '<b>NPC rerolls:</b> in auto modes each NPC carries its own reroll tokens — LCK per fight. A token is '
      'spent only when the natural die shows <b>8 or less</b> (server-tunable via <b>/config mechanics npcreroll</b>; '
      '0 disables): a defender about to be hit rerolls first, then a blocked attacker may answer — one each '
      'per exchange. <b>/fight status</b> shows remaining tokens, and <b>/fight refill</b> restores them '
      'mid-fight.'),
('aud', 'all'),
('h2', 'Duels'),
('p', 'A challenge between players, put to the ' + GM + 's as one message rather than a scattered argument '
      'in chat.'),
('code', [('/duel', 'raise one'),
          ('/duel terms:First blood, no rerolls', 'and say how it will be fought')]),
('p', 'The post carries four buttons. Others press <b>Stand in</b> to attach themselves, <b>Step out</b> to '
      'leave, and when at least two are in, whoever raised it presses <b>Send to the GMs</b>. It then appears '
      'in the approval channel with <b>Allow it</b> / <b>Decline</b>, so the whole table can see what was '
      'asked and what was answered. <b>Withdraw</b> pulls it at any point.'),
('note', '<b>One duel per player at a time</b> \u2014 you cannot raise a second, nor stand in someone else\u2019s '
         'while yours is open. Withdrawing frees you immediately. A declined duel comes back with the '
         + GM + '\u2019s reason, and an allowed one is announced where it was raised.'),
('p', 'Approval does not start the fight \u2014 it clears it. A ' + GM + ' then runs <b>/fight start</b> with '
      'the fighters, which the approval message spells out ready to copy.'),
]

PARTS['gmfight'] = [
('aud', 'gm'),
('h2', 'Rehearsal, Fight Settings and the Big Red Button'),
('code', [('/gm check rehearse', 'a private sparring thread against a dummy the bot runs,\nso every button can be tried before the table sees it (GM)'),
          ('/config mechanics fightping enabled:true', '@-mention players on their turn — off by default'),
          ('/config mechanics npcreroll threshold:8', 'NPC auto-reroll on nat ≤ N — 0 disables'),
          ('/fight end all:true', 'end every active fight on the server at once \u2014\nrecaps post in their channels; HP states persist')]),
]

PARTS['quest'] = [
('aud', 'all'),
('p', 'GMs create quests with lore, objectives, details and rewards. Quests are posted as a message '
      'with an Apply button and also appear on the board. Players apply, a ' + GM + ' approves the party, '
      'and on completion merits are auto-awarded while other rewards are listed for the ' + GM + ' to hand out.'),
('h2', 'For Players'),
('code', [('/quest board', 'list quests (filter: open/active/completed/all)'),
          ('/quest show number:1', 'full details of one quest'),
          ('/quest roster number:1', 'see applicants and the party'),
          ('/quest party apply number:1', 'apply to join — or tap Apply on the post'),
          ('/quest party withdraw number:1', 'leave or cancel your application'),
          ('/quest record user:@Players', 'one player\u2019s finished quests \u2014 what they have\nbeen on')]),
('note', 'Quests are auto-numbered for easy recall, e.g. <b>#001-Hollow Cave</b> (repeatable quests keep '
         'the name and get a fresh number each time). Party size is a hard cap or a suggestion — the ' + GM +
         ' chooses with <b>hard_cap</b>, and <b>force:true</b> on approve overrides a cap. Point a quest at '
         'a thread with <b>/quest runchannel</b> and its completion rewards are announced there.'),
('h2', 'Your Party’s Thread'),
('p', 'When a run starts it opens its own thread in <b>quest-instances</b> with the whole party pulled in. That thread is where the quest happens: fights fought there log themselves on the quest’s timeline, the Game Master’s rally pings everyone in it, and the ending is written up there before it goes anywhere else. A player holds one seat at a time — you cannot be approved onto a second quest while a run is still live.'),
('h2', 'Encounters'),
('p', 'An encounter is a session on the fly — no board, no applications. The Game Master names it, ticks who is in it from the roster and opens it; it gets a thread of its own in quest-instances like any run, and pays out like one. The seats are the Game Master’s: there is no Join button, so if you want in, ask. An encounter does not count as your one quest, so a party already out on a quest can still be jumped by bandits.'),
('code', [('/encounter list', 'every encounter running now, and where')]),
('h2', 'Campaigns'),
('p', 'A campaign is the long arc — quests and encounters under one name. Its card shows the premise, what is done and your own part in it; the Game Master’s notes and status stay on their side.'),
('code', [('/campaign list', 'every campaign on the server'),
          ('/campaign show campaign:The Falconer’s War', 'the premise, what is done, and your part')]),
('h2', 'The Chronicle and the Review'),
('p', 'When a run is completed, the Game Master’s telling of it lands in your own thread in <b>quest-chronicle</b> — one thread per adventurer, every quest they finished, told by whoever ran it — and the summary is linked on your standing page. The run’s thread then carries a review button: a score out of five and a line or two, for the Game Masters alone to read. <b>/quest record</b> lists what you have been on.'),
]

PARTS['gmquest'] = [
('aud', 'gm'),
('h2', 'Writing a Quest'),
('code', [('/quest create', 'bare, a five-field writing window opens \u2014 name,\nobjectives, lore, details and rewards as full\nparagraphs. Numeric options (merit_reward:,\nparty_size:, hard_cap:, gm_style:) ride along.\nfrom:N seeds the window from an existing quest as\na fresh draft \u2014 a template copy, unlike instance.\nWith name: given, everything stays inline as\nbefore'),
          ('/quest edit number:1', 'the same window, prefilled with what stands \u2014 the\nnatural editor. Saving updates the board embed and\nrenames the board and planning threads. Numeric\noptions apply directly without the window'),
          ('/quest create name:Hollow Cave objectives:...\n  merit_reward:2 party_size:4 hard_cap:true', 'create a quest')]),
('note', 'Every <b>number:</b> option across /quest autocompletes \u2014 start typing a number or part of a name '
         'and the matching quests appear as \u201c#012 \u2014 Hollow Cave (open)\u201d.'),
('h2', 'The Pipeline'),
('code', [('/config channels questforum channel:#forum', 'make the quest board a forum \u2014 one thread per\nposted quest (Admin)'),
          ('/config channels questthreads channel:#forum', 'optional split: per-quest planning threads open in\nthis secondary forum instead, and the pipeline\nstage tags ride along with them \u2014 so the planning\nforum holds only the six books and the DM roster.\nDisable to fold threads back (existing threads\nstay where they are either way) (Admin)'),
          ('/config channels questinstances', 'a forum where every STARTED quest opens its own\nthread for party \u2014 the DM and each member pulled in\nby mention, the clock and reminders following\nthem there. Optional: without it a quest runs in\nits run channel as before'),
          ('/config channels questplanning channel:#gm-forum', 'a private GM forum: /quest create opens a planning\nthread there with the full quest record, and every\napplication and lifecycle event mirrors into it;\n/quest post is the flip that opens the public board\nthread. Setup also creates the seven pinned\npipeline BOOKS \u2014 Concept, Awaiting Approval,\nApproved, In Progress, DMs Available,\nArchived, Completed \u2014 the same way the\nroll-audit forum builds its books, plus the matching\nstage tags. Every quest keeps one index entry (name,\nGM, party, links to its planning thread, board post\nand the party\u2019s room) that moves between books as it\ngoes; a live run shows how long its clock has been\ngoing, anything sitting still for days says so,\nCompleted entries carry the run counter, and the\nDMs book is the roster (Admin)'),
          ('/quest stage number:1 stage:approved', 'move a quest through the hand-set stages \u2014 or just\npress the advance button at the bottom of its\nplanning thread (\u2192\u2192, one press each; at Approved\nit points to /quest post). Posting, archiving and\ncompleting re-tag automatically \u2014 each stage line in the planning\nthread REPLACES the last, so the walk never piles\nup; posting leaves exactly one line: the board link'),
          ('(buttons)', 'each application in the planning thread carries\nApprove / Kick buttons; at the Approved stage the\nthread\u2019s button becomes Post to board \u2014 GM-gated,\nsame checks as the commands'),
          ('/config mechanics questspinoff enabled:true', 'the board becomes listings: approvals stage, and one\nlaunch births a run carrying the whole staged group'),
          ('(who runs it)', 'the first GM to approve an applicant becomes\nthat quest\u2019s DM \u2014 /quest handoff passes it to\nanother GM. When approvals reach the party size,\nthat DM is pinged once in the planning thread'),
          ('/quest dm style:... brief:...', 'your DM card on the DMs Available roster \u2014 style,\na short brief, available:false to step back, and a\nrunning tracker: quests written \u00b7 parties guided\nto completion. Re-rendered on every card change,\nquest creation and completion'),
          ('/quest post number:1', 'post the quest with an Apply button. With a quest\nforum configured this opens the quest\u2019s own thread\non the board \u2014 applications, party changes, start,\npause, public notes and completion all mirror in,\nand the thread archives when the quest completes.\nPass channel: to post plainly instead'),
          ('/quest archive number:1', 'take a quest off the board \u2014 applications close,\nthe Apply button drops, the board thread locks and\narchives; /quest post re-lists it')]),
('h2', 'Applicants and the Launch'),
('code', [('/quest party approve number:1 user:@Players force:true', 'approve · under spin-off this STAGES them on the\nlisting until you launch · force past a hard cap'),
          ('(one quest at a time)', 'a player may hold only one seat: approving someone\nalready on a live run is refused, and a launch leaves them\nan applicant rather than double-booking them'),
          ('/quest party kick number:1 user:@Players', 'remove a member or applicant'),
          ('/quest run start number:1', 'lock the party, mark in progress'),
          ('/quest run start number:1 (listing)', 'the launch: the whole staged group becomes one run\nwith its own thread and clock \u2014 or press on the post'),
          ('/instance add name:X [run:] user:@Players', 'seat a player on a run \u2014 name autocompletes your\nlistings, run blank = the latest active one'),
          ('(naming a run)', 'paste the thread\u2019s own name if you like \u2014 the number\nprefix and \u201cRun 001 \u2026\u201d suffix are ignored. In a run\u2019s own\nthread you may leave name: blank entirely'),
          ('/instance kick/rally/note/pause/resume/complete/show/thread', 'the in-play nine, addressed by name and run \u2014\neach forwards into /quest, so gates and behaviour are identical'),
          ('(run names)', 'every launch is christened \u201c<Quest> Run 001 <GM>\u201d \u2014\nthe thread and the ledger wear the same name'),
          ('/quest thread number:1 \u00b7 /quest thread all:true', 'open a quest thread for one that hasn\u2019t got one.\nUse it for quests that started before the\ninstance forum was set \u2014 all:true catches every\nrunning quest at once. Anything that already has\na room is left alone'),
          ('/quest handoff number:1 gm:@GMs', 'pass a quest to another GM \u2014 they become its DM.\nThe board, the book, the planning thread and the\nparty\u2019s room are all told')]),
('h2', 'Several GMs, the Same Adventure'),
('p', 'A quest holds one party on one clock, so two ' + GM + 's cannot share a quest number. '
      '<b>/quest instance</b> makes a separate run of the same adventure: it copies the writing \u2014 name, lore, '
      'objectives, details, rewards, merit and party rules \u2014 and leaves everything else fresh. A new number, '
      'an empty party, a clock at zero and its own log.'),
('code', [('/quest instance number:1 [label:Blackfen party]', 'run your own copy of an adventure. The copy keeps\nthe ORIGINAL\u2019s number and adds which run it is \u2014\n#002.2-Testing the waters \u00b7 Blackfen party \u2014 so the\nboard reads as one story with several tables.\nFresh party, clock at zero, you as its DM'),
          ('/quest instance number:1 gm_style:Roleplay-focused', 'and advertise how you run it')]),
('note', 'Three ' + GM + 's can run the same adventure at once, each with their own party, channel, clock and '
         'summary. Completing one does nothing to the others. The board marks them: <i>One of 3 separate runs '
         'of this adventure.</i>'),
('h2', 'Running a Quest — the Clock'),
('p', 'Starting a quest with <b>/quest run start</b> begins a stopwatch. From then on the bot posts a public time '
      'check in the quest\u2019s run channel <b>every 15 minutes</b>, and <b>on the hour</b> a recap of everything '
      'that happened during it. Set the channel first with <b>/quest runchannel</b>, or there is nowhere for '
      'them to go.'),
('code', [('/quest run start number:1', 'the clock begins'),
          ('/quest run note number:1 text:They bribed the gatekeeper kind:Roleplay', 'mark a moment'),
          ('/quest run timeline number:1', 'the whole log so far'),
          ('/quest run pause number:1', 'stop the clock, keep the time'),
          ('/quest run resume number:1', 'carry on where it left off'),
          ('/quest run complete number:1', 'stop, award, and write it up')]),
('p', 'A timeline reads back like a ship\u2019s log:'),
('code', [('` 0h 00m` Quest begins \u2014 4 on the party', ''),
          ('` 0h 15m` Time check \u2014 0h 15m', ''),
          ('` 0h 17m` Garrick speaks', ''),
          ('` 0h 44m` Artorius wins the fight', ''),
          ('` 1h 00m` Hourly recap \u2014 3 events', '')]),
('p', '<b>Combat and roleplay log themselves.</b> A fight ending in the quest\u2019s run channel, or an NPC '
      'speaking there through <b>/npc say</b>, is attached to whichever quest is running in that channel. '
      'Anything else you want on the record goes on with <b>/quest run note</b>, taggable as roleplay, combat or a '
      'plain note.'),
('note', '<b>Pause keeps everything.</b> The time already run is banked and the clock stops \u2014 a paused quest '
         'gets no reminders and logs nothing. Resuming picks up at exactly the same figure. Both counters live '
         'on the quest itself, so a restart or redeploy mid-session resumes rather than starting the count '
         'again.'),
('code', [('/quest runchannel number:1 channel:#thread', 'set where it runs & rewards'),
          ('/quest rally number:1 [message:] [here:true]', 'call the party together \u2014 pings every member in\nthe quest thread (or in this channel with here:true),\nwith your message and a line naming their DM'),
          ('/quest run note number:1 text:... public:true', 'log a moment \u2014 planning-thread mirror by default;\npublic:true posts it in the board thread too'),
          ('/quest run recap number:1', 'drafts a \u201cpreviously on\u2026\u201d from everything logged \u2014\nprivate to you; add post:true to read it to the party (GM)'),
          ('/quest npc number:1 name:Hollow Lieutenant', 'attach the NPCs a run involves (remove:true to\ndetach) \u2014 they appear on the completion run record'),
          ('/quest runs number:1', 'the run ledger for a quest and all its instances:\nhow many times it has been completed, and each\nrun\u2019s date, GM, party and NPCs')]),
('h2', 'The Quest Summary'),
('p', 'On <b>/quest run complete</b> the clock stops and the whole run is written up: who ran it, how they run a '
      'table, how long it took, who was on the party, and the full timeline. Set where it goes with '
      '<b>/config channels questlog channel:#chronicle</b>.'),
('code', [('/config channels questlog channel:#chronicle', 'where finished quests are written up'),
          ('/config channels questlog disable:true', 'stop posting them')]),
('p', 'The summary is then <b>linked on every party member\u2019s standing page</b> \u2014 <b>/char view standing</b> and '
      '<b>/char view show full:true</b> both list the quests a character has finished, each one a link straight to its '
      'write-up, with how long it took and how long ago it was.'),
('h2', 'Ending a Run'),
('code', [('/quest run winddown number:1', 'the story is over but the rewards are not settled:\nthe run stays live, its party is released to the rests\nand free to join other quests, and anyone kicked now is\nstill paid at completion. resume:true puts it back (GM)'),
          ('/quest run complete number:1', 'finish — auto-award merits, list rewards'),
          ('/quest run complete number:1 summary:\u2026', 'add your telling \u2014 it lands in each adventurer\u2019s thread in\nquest-chronicle; timings, events and payouts go to the\nGM-only gm-quest-log instead'),
          ('/quest run log number:1 text:\u2026', 'write or rewrite the tale afterwards \u2014 it is mirrored into\nevery adventurer\u2019s own chronicle thread, and rewriting edits\neach copy in place (GM)'),
          ('(\u21A9 Reopen, on a completion message)', 'five minutes to take a completion back: payout reversed,\nthis run\u2019s titles revoked, party released; fix it and\ncomplete again (GM)'),
          ('(reviews)', 'a completed run posts a review button in its own\nthread; `/quest show` then carries the count, the\naverage and the latest few lines (GM)'),
          ('/quest archive number:1 summary:\u2026', 'the final shelf. Blank summary: opens a box for the final\nword \u2014 it goes on the record, into the run\u2019s thread and\nthe GM quest log, and marks the campaign card. A completed\nquest stays completed on everyone\u2019s record (GM)'),
          ('/quest delete number:1', 'remove a quest permanently: its board thread or\npost and its planning thread (applications and\nnotes included) and the party\u2019s room are deleted\nwith it \u2014 and any instances of it go the same way,\nthreads and all. A fight still running in the room\nis stood down first. If the quest is live, the\nconfirmation says so before you commit: the clock\nstops and the party is released. Its number returns\nto the pool: the next quest created takes the\nlowest free number, reborn with a clean history\n(the run ledger keeps counting for DM credit but\nno longer answers to that number)')]),
('h2', 'GM Style'),
('p', 'A quest can advertise how its ' + GM + ' runs a table, so a player knows what they are applying to. Set '
      'it on <b>/quest create</b> or per instance; it shows on the quest card, the board post and the final '
      'summary.'),
('table', ['Tag', 'What it promises'],
          [['Mechanics-focused', 'rules, rolls and tactics to the fore'],
           ['Roleplay-focused', 'character and conversation to the fore'],
           ['Mixed elements', 'a bit of both'],
           ['Combat-heavy', 'expect fighting'],
           ['Puzzle & investigation', 'problems to work out'],
           ['Sandbox', 'the players decide where it goes']]),
('h2', 'Encounters — Sessions on the Fly'),
('code', [('/encounter start name:\u2026 merits:2 campaign:\u2026', 'a session on the fly: no board, no applications. The bot\nlists every living character with HP and what holds\nthem; tick who is in it and press Open the encounter \u2014\nit opens its own thread in quest-instances, the party\npulled in by mention. No Join button, ever (GM)'),
          ('/encounter add user:@Players \u00b7 /encounter remove user:@Players', 'the seats are yours: seat or remove a player, run in\nthe encounter\'s thread (GM)'),
          ('/encounter end summary:\u2026 title:\u2026', 'pays out, writes the chronicle, posts the review button\n\u2014 the ordinary completion (GM)'),
          ('/encounter list', 'every encounter running now and where'),
          ('/encounter preset save name:\u2026 merits:2 npcs:Hollow x3', 'a saved scene; `/encounter start \u2026 preset:` runs it with the\nmerits set and the monsters summoned as temps;\n`preset list` \u00b7 `preset remove` (GM)')]),
('note', 'An encounter left quiet for six hours pings the GM roles in its room; it never ends itself. A preset’s <b>npcs:</b> are summoned from the 5e library where there is one — and where there is not, an NPC of that name is cloned as temporary fighters, so <b>Hollow x3</b> works on a Knightfall server from a single Hollow you made once.'),
('h2', 'Campaigns — the Long Arc'),
('code', [('/campaign create name:\u2026 description:\u2026', 'the long arc: quests and encounters under one name,\nwith a GM-only thread and a live card. add \u00b7 remove \u00b7\nnote \u00b7 status \u00b7 recap \u00b7 complete; `campaign:` on\n`/quest create` and `/encounter start` links at birth (GM)'),
          ('/campaign add campaign:… quest:2', 'link a quest that already exists — old ones too'),
          ('/campaign note campaign:… text:…', 'a beat that happened between runs'),
          ('/campaign status campaign:… text:…', 'where things stand — the present, not the history'),
          ('/campaign recap campaign:…', 'a previously-on across every linked run'),
          ('/campaign complete campaign:…', 'close the arc'),
          ('/campaign show campaign:\u2026', 'players see the premise, what is done and their own part;\nGMs see everything')]),
('h2', 'Stalled Work and the Weekly Digest'),
('code', [('/gm check stalled', 'what is waiting on a GM: winding-down runs, quiet encounters, staged parties never launched, idle campaigns, reviews this week (GM)')]),
('p', 'Once a week the same report is posted on its own, as a thread in the <b>gm-digest</b> forum titled by the Monday of the week it covers — so nothing depends on somebody remembering to ask. A quiet week posts too, saying so; the first boot with the forum posts the week’s digest at once.'),
('h2', 'Feedback Rooms'),
('code', [('/button feedback', 'plant a feedback button in this channel (GM)'),
          ('/feedback category add|remove|list', 'the rooms feedback lands in \u2014 seven to begin with;\nadd your own and its thread opens at once (GM)'),
          ('/feedback category list', 'every room feedback can land in'),
          ('/feedback category remove name:X', 'retire a custom room (GM)')]),
]

PARTS['standing'] = [
('aud', 'all'),
('p', 'A milestone-style progression system. Merits are a lifetime tally a ' + GM + ' awards; ranks are '
      'named tiers with merit thresholds. The bot tracks progress and flags eligibility, but every '
      'promotion is decided by a ' + GM + '.'),
('h2', 'Merits'),
('code', [('/standing merit view', 'your merits, rank, and merits to next rank', 'player'),
          ('/standing merit view user:@Players', 'view another player', 'player'),
          ('/standing merit leaderboard', 'top earners on the server', 'player'),
          ('/standing merit add user:@Players amount:2', 'award merits — ' + GM, 'gm'),
          ('/standing merit remove user:@Players amount:1', 'take merits away — ' + GM, 'gm'),
          ('/standing merit set user:@Players amount:10', 'set an exact total — ' + GM, 'gm'),
          ('/standing merit history user:@Players', 'a player\u2019s merit timeline', 'player'),
          ('/standing merit history', 'recent server-wide merit activity', 'player')]),
('h2', 'Ranks'),
('code', [('/standing rank list', 'all ranks and their thresholds', 'player'),
          ('/standing rank add name:Knight threshold:5', 'create or update a rank — ' + GM, 'gm'),
          ('/standing rank add name:Squire threshold:0 order:0', 'order sets junior→senior — ' + GM, 'gm'),
          ('/standing rank promote user:@Players rank:Knight', 'set a player\u2019s rank — ' + GM, 'gm'),
          ('/standing rank strip user:@Players', 'clear their held rank — merits and renown stay, so they can re-claim whatever they still qualify for (GM)', 'gm'),
          ('/standing rank eligible', 'who has met a threshold but isn\u2019t promoted — ' + GM, 'gm'),
          ('/standing rank remove name:Squire', 'delete a rank — ' + GM, 'gm')]),
('note', '<b>/standing merit view</b> shows current merits and exactly how many more are needed for the next rank, '
         'e.g. \u201cKnight \u00b7 7 merits \u00b7 8 to Paladin\u201d. Every merit change is recorded — '
         'quest rewards show the quest name, manual changes show \u201cby GM\u201d — so <b>/standing merit history</b> '
         'answers \u201cwho earned what, and when\u201d. Removing a rank doesn\u2019t change players who '
         'already hold its label.'),
('h2', 'Titles & Associations'),
('p', 'A title is a name earned — granted by a Game Master, or carried away by every survivor of a quest that offered one, stamped with where it came from. An association is a company, order or cause a character stands with. Both show on the character’s page.'),
('code', [('/standing title list user:@Players', 'the titles they hold'),
          ('/standing association list group:The Falconers', 'who stands with a company'),
          ('/standing title grant user:@Players title:… source:…', 'award a title — it shows on their page, their NPC sheet if they are one, and their roll card (GM)', 'gm'),
          ('/standing title revoke user:@Players title:…', 'take one back (GM)', 'gm'),
          ('/standing association add user:@Players group:… note:…', 'the company, order or cause they stand with (GM)', 'gm'),
          ('/standing association remove user:@Players group:…', 'they part ways (GM)', 'gm'),
          ('/quest run complete number:1 title:…', 'every survivor earns the title, stamped with the quest it came from (GM)', 'gm')]),
('h2', 'Renown'),
('p', '<b>Renown is not a currency.</b> It is a running tally of how a character <b>stands in the world</b> '
      '\u2014 what they have done, who has noticed, and how far their name carries. It is earned from quests, '
      'encounters and activities, and it is not meant to be traded away for goods. Someone with high renown '
      'is <b>known</b>; that is the whole of it.'),
('p', 'A ' + GM + ' can adjust it either way when the story calls for it \u2014 a reputation can be damaged as '
      'well as built \u2014 but it is a record of standing rather than a purse.'),
('code', [('/standing renown view        /standing renown view user:@Players', ''),
          ('/standing renown leaderboard', 'who is best known'),
          ('/standing renown history', 'where a standing came from'),
          ('/standing renown gain user:@Players amount:5 reason:Cleared the Sunken Vault', GM),
          ('/standing renown loss user:@Players amount:3 reason:Disgraced at court', GM),
          ('/standing renown set user:@Players amount:0', GM)]),
('p', 'Every change is logged with its reason, so <b>/standing renown history</b> answers how a reputation was built '
      'and where it was lost.'),
('h2', 'Merit'),
('p', 'Merit is the earned measure of service \u2014 awarded by a ' + GM + ', accumulated across quests and '
      'activities, and the thing rank thresholds are set against. Unlike renown, <b>merit is tradeable</b>: '
      'it can be passed between players, and potentially to and from NPCs, as payment, tribute, a debt '
      'settled or a favour bought.'),
('code', [('/standing merit give user:@Players amount:2 reason:A debt settled', 'offer some of your merit'),
          ('/standing merit trades', 'what is still waiting on a ' + GM),
          ('/standing merit cancel id:3', 'withdraw one \u2014 your own, or any as a ' + GM)]),
('p', '<b>No merit moves until a ' + GM + ' signs it off.</b> An offer is held and posted to the sheet approval '
      'channel with Approve / Refuse buttons; a refusal asks the ' + GM + ' why and passes the reason back. '
      'Both parties are told when it lands, and it is announced in the channel where it was offered so the '
      'table sees the trade happen.'),
('note', 'Your balance is checked twice \u2014 when you offer, and again when a ' + GM + ' approves. If you have '
         'spent the merit in between, the trade is voided rather than pushing anyone into the red.'),
('note', 'Renown says who you are in the world. Merit is what you have earned and may hand on. A character '
         'can be widely known and hold no merit at all, or quietly hold a great deal.'),
]

PARTS['activities'] = [
('aud', 'all'),
('p', 'An activity is a minigame you write for your server: the bot narrates, asks for rolls, branches on the '
      'results and loops until someone stops. Fishing, foraging, a gauntlet in the training yard \u2014 whatever '
      'you script. Only a ' + GM + ' can write one; whether players can <b>start</b> one is a setting.'),
('h2', 'Running One'),
('code', [('/activity run name:Fishing [player:@Players]', 'start an activity here. Name a player and it runs\nfor THEM \u2014 their name on it, their buttons, their\nscore \u2014 which is how you set a quiz for someone\nto sit (GM only). Several runs can go at once in\none channel; each answers only to its own player'),
          ('/activity list      /activity show name:Fishing', 'what exists, and read it back in full'),
          ('/activity stop', 'abandon the run here'),
          ('/activity demo which:Kalidale Lore [player:@Players]', 'play a built-in activity \u2014 the fishing tale or a\nfive-question lore quiz. Name a player and it runs\nfor THEM, so you can hand someone a quiz to sit;\nnothing is awarded either way'),
          ('/activity create', 'write one \u2014 a paste window, or file: a .txt for\nlong scripts (' + GM + ')', 'gm'),
          ('/activity set name:X scene:find field:Roll value:dex', 'tweak one line (' + GM + ')', 'gm'),
          ('/activity delete name:X', 'remove it (' + GM + ', asks first)', 'gm'),
          ('/config mechanics activities players:true', 'let players start them too', 'gm')]),
('p', '<b>/activity demo</b> plays a ready-made fishing game so you can see the whole system working before '
      'writing anything: a difficulty check that loops with a different excuse each time, four sizes of catch '
      'chosen by the roll, a gauntlet per size, natural 20s and 1s, and buttons to keep going or head back. '
      'It awards <b>nothing</b> \u2014 no renown, no merits, no items \u2014 so it is safe to play with.'),
('h2', 'One Run Each'),
('p', 'An activity run belongs to the person who started it. Several people can play in the same channel at '
      'once, each with their own prompts, their own progress and their own rewards \u2014 and one person stopping '
      'or wandering off does nothing to anyone else. Every post is tagged with whose run it is, and a button '
      'only answers for its owner.'),
('code', [('/activity run name:Fishing', 'start your own run'),
          ('/activity stop', 'end yours \u2014 a ' + GM + ' with none running can clear the channel')]),
('h2', 'Answering a Scene'),
('p', 'Press the button, or <b>type the stat and add your own flavour after it</b> \u2014 both roll the same '
      'thing, but typing lets you say what your character is doing.'),
('code', [('wis I survey the reeds where the current slows', 'rolls WIS, prints your words')]),
('p', 'A typed roll only answers the scene if the stat is one that step accepts; anything else falls through '
      'to an ordinary roll, untouched. Your stats are shown alongside the result either way.'),
('h2', 'A Second Chance'),
('p', 'After a roll the tale <b>waits</b> rather than moving straight on. If you have a reroll to spend you '
      'are offered one, alongside a <b>Carry on</b> button:'),
('code', [('Reroll (2 left)', 'spend one and roll again'),
          ('\u25b6 Carry on', 'take the result and continue')]),
('p', 'Only one reroll is offered per roll \u2014 the second result stands, and the tale moves on. If you have '
      'none left, or the scene was an ending, it continues as before without stopping to ask. Your progress '
      'is saved while it waits, so nothing is lost if you take a moment to decide.'),
('note', 'In <b>/activity demo</b> the reroll is <b>free</b> and always offered, even with none left \u2014 a dry '
         'run should not quietly cost a player their real rerolls just to see what the button does.'),
('p', 'Each scene posts with a button per stat it accepts. A press rolls with the presser’s own sheet, honours a Hero’s signature stat, and lands in the roll audit like any other roll. Writing and deleting always need a Game Master; starting one is GM-only until <b>/config mechanics activities players:true</b>.'),
('h2', 'Quizzes'),
('p', 'A quiz is an activity a Game Master sets from the question bank: a question, then a button per answer — or a box to type into — marked right or wrong on the spot, with the explanation after, and a score at the end. The bank prefers questions you have never been asked, so a second sitting is a different quiz.'),
]

PARTS['gmactivities'] = [
('aud', 'gm'),
('h2', 'Writing One'),
('p', '<b>/activity create</b> opens a paste window for your script; long scripts (over 4000 characters) '
      'travel as an attached <b>.txt</b> on its <b>file:</b> option instead. Pasting the script straight into '
      'any channel the bot can read works too. Every route is the same: the script starts with '
      '<b>[ACTIVITY] Name</b>, re-using a name replaces that activity, and the whole thing is checked before '
      'anything is saved.'),
('code', [('[ACTIVITY] Fishing', ''),
          ('TALLY renown', 'a running total, paid out at the end'),
          ('', ''),
          ('SCENE find', ''),
          ('SAY Find a spot to set up.', ''),
          ('ROLL wis DC15', 'a difficulty to beat'),
          ('  PASS -> cast', ''),
          ('  FAIL ONE OF', 'picks a different line each loop'),
          ('    This spot does not look all too lucky...', ''),
          ('    They are not biting here today...', ''),
          ('  FAIL -> find', 'loops back'),
          ('', ''),
          ('SCENE cast', ''),
          ('ROLL str|dex|wis', 'the roller picks the stat'),
          ('  1-5   Small fry.  -> fight_small', 'ranges on the total'),
          ('  16+   A monster!  -> fight_extra', ''),
          ('', ''),
          ('SCENE fight_big', ''),
          ('GAUNTLET str|con 14 12 10', 'three rolls, each harder to fail'),
          ('  NAT20 It leaps aboard. -> caught', ''),
          ('  NAT1  Your line snaps. -> restring', ''),
          ('  PASS -> caught', ''),
          ('  FAIL -> find', ''),
          ('', ''),
          ('SCENE caught', ''),
          ('GAIN renown 3', 'banked on arrival'),
          ('CHOICE', 'buttons, no dice'),
          ('  Carry on      -> cast', ''),
          ('  Call it quits -> depot', ''),
          ('', ''),
          ('SCENE depot', ''),
          ('END TALLY', 'pays the tally out as renown')]),
('h2', 'What Each Line Does'),
('table', ['Line', 'Meaning'],
          [['SCENE name', 'A step. The first one is where a run begins.'],
           ['SAY ...', 'Narration. Runs over as many lines as you like.'],
           ['AS Garrick', 'Speak this scene in an NPC\u2019s voice, through their webhook.'],
           ['ROLL str', 'Ask for a roll. str|dex|wis lets the roller choose.'],
           ['ROLL wis DC15', 'Beat 15 for PASS, else FAIL.'],
           ['GAUNTLET str|con 14 12 10', 'A run of rolls, each with its own DC. All must pass.'],
           ['GAUNTLET 14:str 12:str|con 10:dex', 'The same, but a different check at every step.'],
           ['1-5 text -> scene', 'Branch on the roll total. 16+ is open-ended.'],
           ['PASS / FAIL text -> scene', 'Branch on the outcome band.'],
           ['BAND ONE OF', 'Indented lines below become random variants.'],
           ['NAT20 / NAT1 text -> scene', 'Overrides everything else.'],
           ['CHOICE', 'Buttons instead of dice. Options are label -> scene.'],
           ['TALLY renown', 'Names a running total, declared once at the top.'],
           ['GAIN renown 3', 'Adds to the tally when a player arrives at this scene.'],
           ['END', 'Finishes. END TALLY pays out, merits:2 awards merits,'],
           ['', 'rewards:a silver key is announced for you to hand out.']]),
('p', 'Without a <b>DC</b> or ranges, outcomes fall back to the same bands a <b>?</b> check uses: <b>CRIT</b> a '
      'natural 20, <b>PASS</b> 15+, <b>PARTIAL</b> 10\u201314, <b>FAIL</b> under 10, <b>FUMBLE</b> a natural 1. '
      'You need not define all of them \u2014 a crit falls back to PASS, a fumble to FAIL.'),
('note', 'Validation refuses a branch pointing at a scene that does not exist, a duplicate scene name, a scene '
         'with no roll, choice or ending, a roll on something that is not a stat, a gauntlet longer than eight, '
         'and a <b>GAIN</b> with no <b>TALLY</b> \u2014 each with the reason, so a run can never dead-end.'),
('h2', 'The Anatomy of a Script'),
('p', 'The table above is the quick reference; this is the long walk. Each part of a script, what it does at '
      'the table, and the shapes it can take \u2014 every example below is a working fragment you can lift.'),
('h2', 'The Header'),
('code', [('[ACTIVITY] Fishing', 'the first line \u2014 everything above it is ignored')]),
('p', 'A script begins at <b>[ACTIVITY] Name</b> and the name is how everything else refers to it \u2014 '
      '<b>/activity run name:Fishing</b>, <b>/activity show</b>, <b>/activity set</b>. Writing a script with '
      'a name already in use <b>replaces</b> that activity in one motion; there is no separate edit-and-save. '
      '(<b>[STORY]</b> is accepted as an older spelling of the same header.)'),
('h2', 'SCENE \u2014 the Steps of the Tale'),
('code', [('SCENE find', 'a step, named'),
          ('  ...', ''),
          ('SCENE cast', 'the next \u2014 order on the page does not matter'),
          ('  PASS -> cast', 'branches name their destination')]),
('p', 'A scene is one step: it narrates, asks for something \u2014 a roll, a choice \u2014 and branches. '
      '<b>The first scene in the script is where every run begins</b>; after that, order on the page means '
      'nothing, because movement is only ever by name: <b>-> cast</b> goes to <b>SCENE cast</b> wherever it '
      'was written. Names are single words, and every branch must point at a scene that exists \u2014 '
      'validation refuses the script otherwise, so a run can never walk off the map.'),
('h2', 'SAY \u2014 Narration'),
('code', [('SAY You survey the area for a likely spot,', ''),
          ('reading the water for the promise of fish...', 'bare lines continue the narration')]),
('p', 'Whatever follows <b>SAY</b> is spoken by the bot when a player arrives at the scene, and it runs over '
      'as many lines as you like \u2014 a bare line under a SAY simply continues it. Emoji, **bold** and '
      '*italics* come through as typed.'),
('h2', 'AS \u2014 an NPC\u2019s Voice'),
('code', [('SCENE stall', ''),
          ('AS Garrick', 'this scene speaks through Garrick'),
          ('SAY Fine steel, fair prices. What are you after?', '')]),
('p', 'Give a scene an <b>AS</b> line naming a registered NPC and its narration is delivered through that '
      'NPC\u2019s webhook \u2014 their name, their avatar \u2014 exactly as <b>/npc say</b> would. The rest of the '
      'scene (the roll, the buttons) behaves as normal; only the voice changes.'),
('h2', 'ROLL \u2014 Asking for Dice'),
('code', [('ROLL wis', 'one stat \u2014 outcome read off the bands'),
          ('ROLL str|dex|wis', 'the roller chooses which to use'),
          ('ROLL wis DC15', 'a difficulty: 15+ is PASS, under is FAIL')]),
('p', 'A scene with a <b>ROLL</b> posts a button per stat it accepts; pressing one rolls <b>1d20 + that stat '
      'from the roller\u2019s own sheet</b>, honouring a Hero\u2019s signature advantage and landing in the roll '
      'audit like any other roll. Offer several stats with <b>|</b> and the choice belongs to the player \u2014 '
      'a climb might take <b>str|dex</b>, brute force or nimbleness.'),
('p', 'Typing answers too: <b>wis</b> alone, or <b>wis I read the currents where the reeds thin</b> to roll '
      'and roleplay in one breath \u2014 the flavour is printed with the result. A typed stat only answers the '
      'scene if it is one that step accepts; anything else falls through to an ordinary roll and the tale '
      'keeps waiting.'),
('p', 'With a <b>DC</b>, the total decides: meet or beat it for <b>PASS</b>, fall short for <b>FAIL</b>, and '
      'only those two bands apply. Without one, the outcome falls onto the full five-band ladder described '
      'under Outcome Bands below.'),
('h2', 'Ranges \u2014 Branching on the Number Itself'),
('code', [('ROLL str|dex|wis', ''),
          ('  1-5   Something small brushes the line. -> fight_small', ''),
          ('  6-10  A decent weight takes the bait.   -> fight_medium', ''),
          ('  11-15 The rod bends hard.               -> fight_big', ''),
          ('  16+   The reel screams. Extraordinary!  -> fight_extra', 'open-ended top')]),
('p', 'Instead of bands, a roll can branch on the <b>total itself</b> \u2014 each line gives a span, the text '
      'to speak, and where to go. <b>16+</b> is open at the top. Ranges make graded results natural: the '
      'same cast, four sizes of fish. A natural 20 or 1 still overrides a range if a <b>NAT20</b> or '
      '<b>NAT1</b> line is present.'),
('h2', 'GAUNTLET \u2014 a Run of Rolls'),
('code', [('GAUNTLET str|con 14 12 10', 'three checks: DC 14, then 12, then 10'),
          ('GAUNTLET 14:str 12:str|con 10:dex', 'or a different test at every step'),
          ('  PASS -> caught', 'all steps passed'),
          ('  FAIL -> find', 'any step failed')]),
('p', 'A <b>GAUNTLET</b> is several rolls in a row and <b>all of them must pass</b>. The first shape names '
      'the stats once and lists the DCs; the second gives each step its own DC and its own stats, so a chase '
      'can open on raw speed and end on wits. Eight steps is the ceiling. The scene\u2019s <b>PASS</b> branch '
      'fires only when the whole run is survived; <b>FAIL</b> fires at the first stumble \u2014 and a '
      '<b>NAT20</b> or <b>NAT1</b> on any step can cut straight out of the sequence.'),
('h2', 'Outcome Bands \u2014 CRIT, PASS, PARTIAL, FAIL, FUMBLE'),
('code', [('ROLL wis', ''),
          ('  CRIT    A revelation! -> shortcut', 'natural 20'),
          ('  PASS -> onward', 'total 15+'),
          ('  PARTIAL You manage, at a cost. -> onward', 'total 10\u201314'),
          ('  FAIL -> lost', 'total under 10'),
          ('  FUMBLE  Utter disaster. -> ditch', 'natural 1')]),
('p', 'Without a DC or ranges, a roll\u2019s outcome lands on the same ladder a <b>?</b> success check uses: '
      '<b>CRIT</b> on a natural 20, <b>PASS</b> at 15 or more, <b>PARTIAL</b> from 10 to 14, <b>FAIL</b> '
      'below 10, <b>FUMBLE</b> on a natural 1. You need not write all five \u2014 <b>a missing CRIT falls '
      'back to PASS, a missing FUMBLE to FAIL</b>, and a missing PARTIAL rides with FAIL \u2014 so the common '
      'pair <b>PASS / FAIL</b> is a complete scene on its own. Each band line may carry text to speak, a '
      'destination, or both.'),
('h2', 'ONE OF \u2014 Variety on a Loop'),
('code', [('  FAIL ONE OF', ''),
          ("    This spot doesn't look all too lucky...", 'indented bare lines are the variants'),
          ('    Not a bite. Time to move on.', ''),
          ('    Try, try, try again!', ''),
          ('  FAIL -> find', 'the same band still branches')]),
('p', 'A band that ends in <b>ONE OF</b> collects the indented lines below it and speaks a <b>different one '
      'each time</b> \u2014 the cure for a looping scene repeating itself word for word. The block ends at the '
      'next directive or band name, so <b>FAIL ONE OF</b> followed later by <b>FAIL -> find</b> reads '
      'naturally: varied words, one destination.'),
('h2', 'NAT20 and NAT1 \u2014 the Die Overrides Everything'),
('code', [('  NAT20 It practically leaps into your hands. -> caught', ''),
          ('  NAT1  The line snaps. -> restring', '')]),
('p', 'A <b>NAT20</b> or <b>NAT1</b> line answers the <b>natural die</b>, before modifiers \u2014 and it beats '
      'a DC, a range, and every band. Inside a gauntlet it cuts out of the sequence on the spot. Use them '
      'for the moments that should feel like fate regardless of the arithmetic.'),
('h2', 'CHOICE \u2014 Buttons Instead of Dice'),
('code', [('CHOICE', ''),
          ('  Keep fishing   -> cast', 'label -> destination'),
          ('  Call it a day  -> depot', '')]),
('p', 'A <b>CHOICE</b> scene rolls nothing: it posts one button per line, the label as written, and pressing '
      'one moves the run to its destination. Buttons belong to the run\u2019s owner \u2014 someone else pressing '
      'yours is refused \u2014 so several players can sit in the same channel, each at their own crossroads. A '
      'scene may narrate with SAY first and then offer the choice.'),
('h2', 'TALLY and GAIN \u2014 Keeping Count'),
('code', [('TALLY renown', 'declared once, near the top'),
          ('', ''),
          ('SCENE caught', ''),
          ('GAIN renown 3', 'banked each time a player arrives here')]),
('p', 'Declare a <b>TALLY</b> once and the run carries a counter. Every scene with a <b>GAIN</b> adds its '
      'amount <b>when a player arrives there</b> \u2014 loop through the catch five times and it banks five '
      'times. The count is per-run and per-player, shown as it grows, and it pays out only if an ending '
      'says so; abandoning a run with <b>/activity stop</b> forfeits it. A <b>GAIN</b> without a declared '
      '<b>TALLY</b> is refused at validation.'),
('h2', 'END \u2014 Finishing, and What It Pays'),
('code', [('END', 'the tale simply ends'),
          ('END TALLY', 'pays the counter out as renown'),
          ('END merits:2', 'awards 2 merits to the player'),
          ('END rewards:a silver key', 'announced for you to hand out'),
          ('END TALLY merits:2 rewards:a fine rod', 'all three at once')]),
('p', 'A scene with <b>END</b> stops the run \u2014 after its SAY, so an ending can still speak. What follows '
      'the word is the payout: <b>TALLY</b> converts the banked counter into renown, <b>merits:</b> awards '
      'merits <b>automatically</b>, with the activity\u2019s name on the record, and <b>rewards:</b> is free '
      'text \u2014 an item, a favour, a rumour \u2014 <b>announced</b> for the ' + GM + ' to hand over by hand, '
      'exactly as quest rewards work. All three combine on one line, in any order after END.'),
('note', 'The parts compose. A scene may SAY in an NPC\u2019s voice, ROLL with a choice of stats, override on '
         'the naturals, vary its failures with ONE OF, and GAIN on arrival \u2014 the fishing demo uses nearly '
         'every part in forty lines, and <b>/activity show name:Fishing (demo)</b> after running '
         '<b>/activity demo</b> reads it back scene by scene as a worked answer key.'),
('h2', 'Quizzes & the Question Bank'),
('p', 'A quiz is an activity underneath, so everything here rides the machinery in <b>Activities</b> — buttons, scoring, handing a run to a named player. What is different is the <b>bank</b>: questions written once, kept, and drawn on for ever after. Read the walkthrough first; the rest is reference.'),
('h2', 'Running a Quiz — Step by Step'),
('p', '<b>1. Give the bank a home.</b> Make a <b>Forum</b> channel — call it anything, <i>quiz-bank</i> does nicely — then run <b>/config channels quizforum channel:#quiz-bank</b>. You only ever do this once. Questions written before you do it are still saved; they just have no posted copy yet.'),
('p', '<b>2. Write your first question.</b> Run <b>/quiz add category:Orders</b>. The category is whatever you want to group by — Orders, History, Law. Type a new one and it appears in the dropdown from then on. A window opens with five boxes:'),
('code', [('The question', 'How many knight orders are there?'),
          ('Answer 1', '5'),
          ('Answer 2', '* 8'),
          ('Answer 3', '12'),
          ('Answer 4', '15+')]),
('p', 'The <b>*</b> marks the right answer — one star, and only one. Leave answers 2 to 4 blank and it becomes a question they <i>type</i> the answer to, with answer 1 as what you will accept. Marking is forgiving: capitals, accents, punctuation and a leading “the” are all ignored.'),
('p', '<b>3. Add the trimmings, if you want them.</b> On the command, before the window opens: <b>tags:</b> for finer sorting (heraldry, ranks — comma-separated), <b>difficulty:</b> easy, normal or hard, and <b>explain:</b> a line shown after the answer, which turns a test into teaching.'),
('p', '<b>4. Check what you have.</b> <b>/quiz list</b> shows every category, how many questions are in each, and a link to its thread. <b>/quiz show id:7</b> reads one back; <b>/quiz remove id:7</b> deletes it and its posted copy.'),
('p', '<b>5. Set the quiz.</b> <b>/quiz start</b> on its own draws five from the whole bank for you to try. In practice you will want a few of these:'),
('code', [('category: / tag: / difficulty:', 'draw only from part of the bank'),
          ('count:', 'how many questions — five by default'),
          ('player:', 'hand it to someone to sit; the buttons are theirs'),
          ('mode:', 'tally (carry on) or retry (same question until right)'),
          ('pass: / merit:', 'how many right passes, and what passing earns'),
          ('pool:', 'fresh first, only new, any, or revision'),
          ('save: / set:', 'remember this draw under a name, and reuse it')]),
('p', '<b>6. What the player sees.</b> The question, then a button per answer — or a box to type in. Each answer is marked right or wrong on the spot, your explanation follows it, and the run ends with a score: <b>✅ Score: 4/5 (80%)</b>, and whether they passed.'),
('note', 'A draw normally prefers questions that player has never been asked, so a small bank still feels fresh. <b>pool:Revision</b> flips that on its head and asks only the ones they got wrong before — which is how you send someone away to learn and then test the same ground.'),
('p', '<b>7. Do it again next week.</b> Add <b>save:Induction</b> the first time, and after that <b>/quiz start set:Induction player:@Players</b> repeats the whole thing — same filters, same count, same pass mark — with fresh questions drawn each time.'),
('h2', 'The Question Bank'),
('p', 'Questions can be banked once and drawn on for ever after. <b>/quiz add category:Orders</b> opens a window with five boxes — the question, then up to four answers — and a <b>*</b> in front of an answer marks it correct. Fill only the first and it becomes a typed question with that as the accepted reply. Add <b>tags:</b> for finer sorting, <b>difficulty:</b>, and <b>explain:</b> for a line shown after the answer.'),
('p', 'Set <b>/config channels quizforum</b> and the bank gets a readable home: a thread per category, opened as questions are written. The forum is a copy for reading — the bot keeps its own, which is what makes a draw instant and the dropdowns possible.'),
('code', [('/quiz add category:Orders tags:heraldry', 'write one — a window opens'),
          ('/quiz list [category:] [tag:]', 'what is in the bank, and where'),
          ('/quiz show id:7', 'read one in full'),
          ('/quiz remove id:7', 'delete it, and its posted copy'),
          ('/quiz start count:10 category:Orders pass:8 merit:1', 'draw ten from Orders; eight right passes and\nearns a merit'),
          ('/quiz start set:Induction player:@Players', 'set a saved draw for a named player'),
          ('/config channels quizforum channel:#forum', 'where the bank is posted to read')]),
('p', 'A draw prefers questions that player has never been asked, and only repeats when the bank runs dry. Both the order of the questions and the order of the answers within each are shuffled, so nobody learns that the answer is always B. <b>mode:</b> chooses tally or retry, <b>pass:</b> sets how many right counts as a pass, <b>merit:</b> is what passing earns, <b>player:</b> hands it to someone to sit, and <b>save:</b> remembers the whole draw under a name to set again later. <b>pool:</b> decides which questions they may be asked at all — fresh first, only ones new to them, any at all, or revision: only the ones they got wrong before.'),
('h2', 'Quizzes'),
('p', 'An activity can ask questions and mark the answers. <b>ASK</b> makes a scene a question, <b>ANSWER</b> lists what counts as right (separate several with <b>|</b>), and <b>RIGHT -&gt;</b> and <b>WRONG -&gt;</b> say where each outcome leads. The player types their answer into a box, so a quiz can want words rather than a pick from four. Marking is forgiving: capitals, accents, punctuation, extra spaces and a leading “the” or “a” are all ignored. The score is kept and read out at the end.'),
('code', [('[ACTIVITY] Kalidale History', ''),
          ('SCENE q1', ''),
          ('SAY Who founded the White Order?', ''),
          ('ASK', 'the player types their answer'),
          ('ANSWER Artorius|Artorius of Lyssa', 'any of these count'),
          ('HINT He is still with us.', 'shown under the question'),
          ('RIGHT -> q2', ''),
          ('WRONG -> q1', 'send them round again, or onward — your call')]),
('p', 'Multiple choice works too: put a <b>*</b> in front of the right option in a CHOICE block and the engine marks it. <b>QUIZ tally</b> lets every answer carry on and reads the score out at the end; <b>QUIZ retry</b> sends a wrong answer back to the same question until they get it; <b>QUIZ silent</b> tells them nothing as they go \u2014 each answer is simply recorded \u2014 and marks the whole paper at the end, question by question, with your explanations under the ones they missed. Set it on the script, or pick it with <b>mode:</b> on /quiz start. Try it with <b>/activity demo which:Kalidale Lore</b> — five questions, built in.'),
('code', [('QUIZ tally', 'or QUIZ retry, at the top of the script'),
          ('SCENE q1', ''),
          ('SAY How many knight orders are there?', ''),
          ('CHOICE', ''),
          ('  A — 5 -> q2', ''),
          ('  * B — 8 -> q2', 'the star marks the right answer'),
          ('  C — 12 -> q2', '')]),
]

PARTS['fallen'] = [
('aud', 'all'),
('p', 'When a character is brought to 0 HP they are down, not gone \u2014 whether that is the end is the '
      + GM + '\u2019s call. <b>/gm kill</b> makes it final and writes them up.'),
('aud', 'gm'),
('code', [('/config channels memorial channel:#gm-records public:#the-fallen', 'both halves'),
          ('/gm kill user:@Players', 'call it, once they are down'),
          ('/gm kill npc:Hollow tank', 'NPCs too'),
          ('/gm kill user:@Players anyway:true', 'even while still standing'),
          ('/gm revive user:@Players', 'bring them back')]),
('p', 'It asks for a <b>cause of death</b>, optional <b>last words</b> and an optional <b>epitaph</b>. '
      'Everything else is already known: their name, order, rank at the moment they fell, merit, renown \u2014 '
      'and their <b>deeds</b>, which are not typed out but gathered from what the bot watched them do. Quests '
      'seen through and how long each took, the merit they earned and what for, the standing they won, the '
      'dice of a lifetime, and what they were carrying at the end.'),
('p', 'It is written up <b>twice</b>. The <b>GM record</b> carries the full account \u2014 merit, renown, the '
      'dice of a lifetime, what they carried, when they fell \u2014 with a <b>Revive</b> button attached. The '
      '<b>public hall</b> gets the same life told plainly: name, order, rank, cause, deeds, last words and '
      'epitaph, and <b>no figures at all</b>. No merit or renown totals, no roll history, no inventory, no '
      'dates hanging off the deeds. A hall should hear what someone did, not what they were worth.'),
('p', 'Pressing <b>Revive</b> brings them back at full HP and <b>deletes both posts</b> \u2014 a death that was '
      'undone does not linger in the hall. If the same character falls again, the button carries a tally '
      'beside it: <b>Fallen 3\u00d7 \u00b7 revived 2\u00d7</b>.'),
('aud', 'all'),
('p', '<b>The fallen take no further part.</b> A dead character cannot roll, cannot answer an activity, '
      'cannot fight and cannot apply for new work \u2014 and a dead <b>NPC</b> is the same: it cannot be spoken '
      'as with <b>/npc say</b>, cannot roll, cannot be fought as, and the auto-pilot passes over it rather '
      'than taking its turn. Nobody can attack one either.'),
('note', 'Refusals are private. A slash command answers only to whoever ran it; a typed roll is answered by '
         'DM, falling back to a channel reply if your DMs are shut \u2014 being told your character is dead in '
         'front of the table every time you forget is its own small punishment.'),
('note', 'Nothing is deleted from the character. A fallen one keeps their whole record, so a revival costs '
         'nothing and the account can be rebuilt. Until they are brought back they cannot roll: the fallen '
         'take no more actions.'),
]

PARTS['reference'] = [
('aud', 'all'),
('h2', 'What the Stats Do'),
('code', [('/char stat', 'what each stat is for, in plain words')]),
('h2', 'How Rosters Are Ordered'),
('p', 'Every list of characters reads the same way: <b>Heroes first</b> as their own group, then by '
      '<b>knight order</b>, then by <b>class</b>, then alphabetically. Characters with no order or no class '
      'sort after those that have one, rather than jumping the queue.'),
('note', '<b>NPCs sit below the players</b>, however senior their order \u2014 the two are separate halves of '
         'a list rather than interleaved. Within the NPC half the same ordering applies. Mixed lists like '
         '<b>/gm heal global:Everyone</b> print each group under its own heading.'),
]

PARTS['reference-kf'] = [
('aud', 'all'),
('h2', 'Derived Stats'),
('p', 'Max HP is <b>CON plus a flat base</b>, 2 by default \u2014 so CON 10 gives 12 HP. A ' + GM + ' can change '
      'the base for the whole server with <b>/config mechanics hpbase base:3</b>, making it CON+3; set it to 0 for max HP '
      'equal to CON alone. Everyone\u2019s ceiling moves the moment it is changed, players and NPCs alike, though '
      'current HP is left where it is \u2014 run a rest or <b>hpfull @Players</b> to top people up.'),
('table', ['Stat', 'Formula', 'On change'],
          [['Max HP', 'CON + base', 'HP always maxes'],
           ['Max Rerolls', 'LCK', 'Rerolls always max'],
           ['Heal tracker', 'White Knight + WIS ≥ 5', 'Appears / disappears automatically']]),
]

PARTS['feedback'] = [
('aud', 'all'),
('h2', 'Telling the GMs Something'),
('code', [('/feedback send', 'tell the GMs what you think \u2014 pick a room, score it\n1\u201310, say your piece; they see who wrote it, no one else\nsees it happened'),
          ('/feedback send room:General quest:\u2026', 'name the room to go straight to the form (blank opens a\nmenu); name a run you were on or ran and the GMs\u2019 card\nsays which one')]),
]

PARTS['setup'] = [
('aud', 'gm'),
('p', 'Everything the bot needs can be made in one command, and everything it made can be inspected and repaired in another. Two categories come into being: <b>DDice</b>, open to the table, and <b>DDice · Game Masters</b>, shut to everyone else. Nothing already set is touched, and a channel merely named for a job is taken up rather than doubled, so it is safe on a server set up by hand.'),
('h2', 'The One-Command Setup'),
('code', [('/gm check build', 'the one-command setup: makes every channel and forum the bot needs in the two categories, points the config at each, then fills them with the audit shelves, pipeline books and tags. Needs Manage Channels, for you and for the bot (GM)'),
          ('(pickers)', 'the check report offers channel pickers for unset\nconfigs \u2014 up to five at a time; a pick runs the\nreal config branch, tags and books included\n(Manage Server required)'),
          ('/gm check run', 'build anything missing — audit shelves, pipeline books, pipeline tags — and sweep every channel’s permissions, repairing what it can; never moves or renames anything, and names what only you can grant. Surviving threads are adopted by id, never remade, so run it as often as you like, and after any update that adds a book (GM)'),
          ('/gm check status', 'which channels are set, which await'),
          ('/gm check restart', 'DELETE the whole setup and build it fresh — asks first, and the threads inside do not come back (GM)'),
          ('/gm check order', 'sidebar diagnostic — asks first: apply the plan order, or keep your layout and just report (GM)')]),
('h2', 'What Gets Made'),
('table', ['Channel', 'What it is for'],
          [['quest-board · forum', 'The board: a thread per posted quest.'],
           ['quest-instances · forum', 'Each started quest opens its own instance here, for its party.'],
           ['quest-chronicle · forum', 'A thread per adventurer — every quest they finished, told by the GM who ran it.'],
           ['character-pages · forum', 'A page for each approved character.'],
           ['the-fallen · channel', 'Those who did not come back, remembered by the table.'],
           ['updates · forum', 'What changed for players — one dated thread per update.'],
           ['player-pdf · channel', 'The player book alone, reposted whenever it changes.'],
           ['approvals · forum · GM', 'A thread apiece for sheets, trades, duels, lore and exports — each waiting on a GM.'],
           ['roll-audit · forum · GM', 'A shelf per subject: rolls, checks, duels, items and the rest.'],
           ['npc-pages · forum · GM', 'A thread per category, every NPC in it an entry inside — filter the sidebar to sort them.'],
           ['npc-portraits · forum · GM', 'A thread per category, mirroring npc-pages. Caption an NPC’s exact name for their face, or a bare order or category name for a shared one.'],
           ['quest-planning · forum · GM', 'The pipeline books — concept, awaiting, approved, in progress, DMs, archived, completed.'],
           ['quest-threads · forum · GM', 'A planning thread per quest, so the books keep the planning forum to themselves.'],
           ['gm-quest-log · channel · GM', 'The machine’s account of every finished quest — timings, events, payouts, final words.'],
           ['gm-updates · forum · GM', 'What changed for GMs, and what each deploy mended — one dated thread each.'],
           ['gm-digest · forum · GM', 'The weekly digest of what is waiting on a GM — one thread per week, titled by its Monday.'],
           ['gm-feedback · forum · GM', 'Player feedback, one thread per category; players post with /feedback send.'],
           ['gm-character-sheets · forum · GM', 'GM characters — the same five blocks and tags as the player forum, behind the GM category’s eyes only.'],
           ['campaigns · forum · GM', 'One thread per campaign — the arc, its linked runs, and where things stand.'],
           ['question-bank · forum · GM', 'The quiz bank, a thread per category.'],
           ['scroll-archive · forum · GM', 'Every prop written, kept.'],
           ['memorial · channel · GM', 'The full record of a death — cause, deeds and standing.'],
           ['backups · channel · GM', 'Where the nightly backup of everything is posted.'],
           ['command-reference · channel · GM', 'The command books, reposted whenever they change.']]),
('h2', 'GM Roles'),
('code', [('/config mechanics gmrole role:@GMs', 'add a GM role \u2014 several can be set'),
          ('/config mechanics gmrole role:@GMs remove:true', 'remove one'),
          ('/config mechanics gmrole role:@GMs replace:true', 'make it the only GM role'),
          ('/config mechanics gmrole', 'list current GM roles')]),
('note', 'Several GM roles can be set at once \u2014 holding any of them grants GM access. Anyone with '
         'the Discord <b>Manage Server</b> permission always counts as a GM, so you can never lock '
         'yourself out by mis-setting a role.'),
('h2', 'Mechanics'),
('code', [('/config channels ruleset system:knightfall', 'which rules this server plays by \u2014 Knightfall\n(five stats, blows decided by opposed rolls) or\nD&D 5e by the SRD (six abilities as modifiers,\nproficiency growing with level, attacks rolled\nagainst Armour Class). Set it BEFORE anyone makes a\ncharacter: it refuses to change once sheets exist,\nbecause a sheet written for one system cannot be\nread as another. Run it bare to see which rules\nare in force'),
          ('/config mechanics statallowance points:15 minimum:1', 'player build points (omit both to view)'),
          ('/config mechanics hpbase base:3', 'max HP = CON + this (default 2)'),
          ('/config mechanics heal charges:3', 'max heal charges for White Knights'),
          ('/config mechanics rest type:Short Rest hp:50% rerolls:0%', '% of max'),
          ('/config mechanics rest type:Short Rest hp:3 rerolls:1', 'flat numbers')]),
('note', 'Rest amounts come in two shapes, and the difference matters. A bare value <b>sets</b> the resource: '
         '<b>50%</b> puts them on half their maximum, <b>4</b> puts them on exactly 4 \u2014 even if that is '
         'fewer than they had. Prefix a <b>+</b> and it <b>adds</b> instead: <b>+4</b> gives four more HP, '
         '<b>+25%</b> gives a quarter of their maximum on top of what they have. Both cap at the maximum and '
         'both round down. <b>0%</b> leaves that resource untouched, and only the values you provide change.'),
]

PARTS['gmroll'] = [
('aud', 'gm'),
('h2', GM + ' Rolls'),
('code', [('/gm roll notation:1d20+5', 'public roll in channel'),
          ('/gm roll notation:1d20+5 label:perception', 'with label'),
          ('/gm roll notation:1d20+5 secret:true', 'secret — only you see the result;\nthe roll audit records it either way'),
          ('gmr 1d20+5 perception', 'typed chat shortcut for the same roll'),
          ('gmrs 1d20+5 stealth', 'typed shortcut, secret — sent to your DMs')]),
('h2', 'Calling for a Check'),
('code', [('/gm dc dc:14 stat:dex targets:@Artorius @Meliora npcs:Hollow tank', 'call a check. Players get a roll button each \u2014 a\npress rolls their own d20 (+stat, signature\nhonoured) vs the DC and lands in the audit; named\nNPCs roll instantly on the card. dice: swaps the\nstat for any notation (2d6+1); mode: sets how they roll it \u2014\nadvantage, disadvantage, or a bare d20 (no stat,\nno signature); modifier: adjusts totals \u00b120;\nsecret:true hides the DC (you get it privately)\nand reveal:@Players whispers it to chosen players when\nthey press \u2014 per-player sight on one check;\non_fail: and on_success: each mark their NEXT\nroll \u2014 advantage or disadvantage \u2014 and the\nmark is GENERAL: it rides the character, needs no\nfight to be set, and is spent by whatever they\nroll next, anywhere \u2014 a chat !r, /roll, an\nactivity, any fight action, or another check\n(specialist abilities keep their chosen mode).\nflat stays a fight mark: their next fight\naction as a bare d20. fail_damage: and success_damage:\ncost HP on that outcome, sheet and fight kept in\nsync. Nat 20 always\npasses, nat 1 always fails; pressed buttons go\ndark. Works mid-fight and with /fight auto\nnpconly \u2014 full-auto runs start to finish, so a\ncheck lands after it.\nsuccess_flavour: and fail_flavour: stay hidden on\nthe card and are revealed with each roller\u2019s\nresult; success_sanction: and fail_sanction: shift\na stat by decree (pattern dex-1 or lck+2, \u00b15 at\nmost, floor 0) \u2014 the stakes show on the card, the\nwords wait for the outcome'),
          ('/gm dc target:@Players npcs:Hollow tank', 'leave dc: out and a WRITING WINDOW opens \u2014 the\ncheck as a form: the scene \u00b7 the check line (e.g.\n\u201cdex 14 hidden\u201d, or \u201c2d6+1 8 bare adv -2\u201d) \u00b7 on\nsuccess \u00b7 on failure \u00b7 targets. Each outcome box takes\na tag line first \u2014 [adv] [dis] [bare] [dex-1] [-3hp],\nany order, either outcome \u2014 then the words the\nplayers read. Targets\npicked on the command carry into the form; the last\nbox adds any you missed. Naming dc: keeps the fast\npath with every option instead'),
          ('/gm dc \u2026 hold:true skipfail:true', 'bind the check to the fight: the target\u2019s actions\nwait on the card, and a failed check passes their turn')]),
('h2', 'Buttons and Targets'),
('code', [('/button roll dice:2d6+1 dc:9 reason:\u2026 for:@Players once:true', 'plant a roll: dice OR a stat, an optional DC, the reason\nshown above it, and who it is for \u2014 anyone if left open.\nPressed inside a quest, it joins that quest\u2019s timeline and\nthe GM log (GM)'),
          ('/button group stat:wis dc:12 reason:\u2026', 'one check the whole party rolls \u2014 each presses once, the\nmessage keeps the tally, and Call it closes the scene\nwith how many got through. A natural 20 passes and a\nnatural 1 fails, whatever the total (GM)'),
          ('/target create name:Barricade [dc:12] [stat:Flat d20, STR, DEX] [dice:2d6+1] [success_flavour:\u2026] [fail_flavour:\u2026]', 'plant something to swing at \u2014 no sheet, no roster. A d20 unless dice: says otherwise; stat: lists as few or as many stats as you like, one button each in that order \u2014 leave it out and all five are buttons; leave dc: out and every blow is your call. A press opens a short form \u2014 what they do, what they say, both optional \u2014 and the words land above the roll. A natural 20 beats it (Roll critically succeeds) and a natural 1 fails (Roll critically fails) on their own, posting your flavour if set; anything else says The roll succeeds / fails and asks YOU \u2014 the player passes the check, or fails it \u2014 each opening a What happens? form prefilled with your flavour (blank still sends the verdict). A fail posts the card again below with its buttons and a counter; secret:true asks in the GM channel and tells the players Roll succeeds / fails in theirs (GM)'),
          ('/target list', 'what still stands in this channel (GM)')]),
('h2', 'Overrides'),
('code', [('/gm override skip [reason:]', 'pass the current turn in this channel\u2019s fight \u2014\nannounced as a GM ruling'),
          ('/gm override interject user:@Players amount:2 note:\u2026', 'bend a player\u2019s roll mid-fight, any combination: force their\nstat, adjust the total (\u00b110, stacks), set advantage/dis/flat,\nor DECLARE THE DIE (1\u201320) \u2014 the one lever that rewrites a roll\nalready cast; the total recomputes around their modifier and\nevery automatic honors the declared face; announced, audited (GM)'),
          ('/gm reroll target:@Players stat:dex mode:dis flat:true', 'interrupt and correct a mistaken roll by decree \u2014\nwrong stat, wrong footing, or a bonus they never\nhad. If they hold the pending attack or defence in\na live fight here, the corrected roll REPLACES it\nin the fight (resolve sees the new number);\notherwise their last roll in this channel is\nrerolled on the corrected terms. flat:true forces\na bare d20; signature advantage is honoured unless\nflat; carried riposte/fumble modifiers drop \u2014 the\nGM is re-declaring the terms. NO reroll token is\nspent and the player\u2019s own once-per-roll right\nstays untouched. Mirrors to the audit as a GM\ncorrection')]),
('h2', 'The Roll Audit'),
('code', [('/config channels rollaudit channel:#gm-rolls', 'mirror every roll — raw input,\nresult and jump link'),
          ('/config channels rollaudit test:true', 'send a test mirror, report problems'),
          ('/config channels rollauditforum forum:#roll-audit', 'split the mirror into books \u2014 player rolls,\nGM rolls, NPC rolls, NPC say, and the Scrolls\narchive; rerunning adds any missing book'),
          ('(the books)', 'the audit forum keeps a shelf per subject: Player\nRolls \u00b7 GM Rolls \u00b7 NPC Rolls \u00b7 NPC Say \u00b7\nScrolls \u00b7 Called Checks \u00b7 GM Overrides \u00b7\nDuels \u00b7 Advancement \u00b7 The Fallen \u00b7 Items.\nRe-run the setup after an update and any new\nshelf is added without touching the old ones'),
          ('/config channels rollauditforum disable:true', 'back to the single audit channel')]),
('note', '<b>The roll-audit mirror records every roll, in every channel, with nothing skipped.</b> Prefix '
         'rolls, stat shorthand, success checks, rerolls, heals, <b>/roll</b>, <b>/gm roll</b> and every fight '
         'roll \u2014 plus ' + GM + ' rolls, including secret <b>gmrs</b> ones, so ' + GM + 's are accountable to '
         'one another.'),
('note', 'A ' + GM + ' rolling as an NPC with <b>/npc roll</b> is logged under their own name, tagged with the '
         'NPC they spoke as \u2014 the roll itself goes out through the NPC\u2019s webhook, so the audit is the only '
         'place it ties back to a person.'),
('note', 'Rolls the bot makes for itself are recorded too, attributed to the fighter and tagged <b>auto</b>: '
         'auto-pilot attacks, defences and reroll answers, initiative at the start of every fight and whenever '
         'an NPC joins mid-fight, every roll of a full <b>/fight auto</b>, and demo bouts. Rolls typed inside '
         'the audit channel itself are mirrored as well \u2014 a secret <b>gmrs</b> there goes to the '
         + GM + '\u2019s DMs, so without the mirror it would leave no record at all.'),
('note', 'Use <b>/config channels rollaudit test:true</b> to check it works. Set the channel\u2019s Discord permissions '
         'so only ' + GM + 's can view it. When NPC stats are hidden, manual and auto fight cards mask the stat and modifier \u2014 the audit\u2019s NPC book keeps the full card \u2014 roll line, real HP and all five stats revealed.'),
]

PARTS['gmchar'] = [
('aud', 'gm'),
('h2', 'The Queue'),
('p', 'Everything waiting on a decision, in one place \u2014 character sheets, lore, merit trades and quest '
      'applicants, with jump links to each. It also surfaces any background job that is failing.'),
('code', [('/gm queue', 'what is waiting')]),
('note', 'Pending lore had no listing anywhere else, so a submission whose queue post was deleted was '
         'effectively invisible. This finds it.'),
('h2', 'Approvals'),
('code', [('/config channels approvals channel:#sheet-approvals', 'new sheets need GM sign-off'),
          ('/config channels approvals list:true', 'every sheet still waiting \u2014 from the database'),
          ('/config channels approvals disable:true', 'turn approval off'),
          ('/config channels approvalforum forum:#gm-approvals', 'one forum, a thread per approval type \u2014 sheets, trades, duels, lore, exports'),
          ('/config channels approvalforum disable:true', 'back to the single channel \u2014 posted items keep working')]),
('note', 'With an approval channel set, a player\u2019s new sheet is posted there for sign-off, pinging '
         'every GM role, with Approve / Reject buttons. Until approved they can\u2019t roll, heal or take '
         'fight actions \u2014 and once approved, their whole sheet can only be changed by a GM. Sheets a GM '
         'creates or edits skip the queue, and sheets made before approval was enabled keep working until '
         'someone edits them.'),
('note', 'Every way a player can write to their own sheet goes to the queue: <b>/char create</b>, '
         '<b>/char set</b> (any field \u2014 stats, order, class and weapons alike), <b>/char weaponemoji</b>, '
         '<b>/char profile load</b> and pasting an exported sheet. Building a character one <b>/char set</b> at a '
         'time is not a way past a GM. Editing a sheet that is still pending retires the old request and '
         'posts a fresh one, so the channel holds one live entry per player rather than a pile of stale ones. '
         'A rejected sheet can still be edited by its owner \u2014 that is how they fix it \u2014 and each edit '
         'sends it straight back for another look.'),
('note', 'A sheet that is <b>still waiting</b> can be edited by its owner \u2014 spot a mistake before a '
         + GM + ' gets to it and you can fix it, which retires the old request and posts a fresh one. Only an '
         '<b>approved</b> sheet is frozen to its owner.'),
('note', 'Pressing <b>Reject</b> opens a box asking <b>why</b>. The note is optional, but it travels with the '
         'decision \u2014 it is written onto the request in the approval channel, sent to the player with the '
         'rejection, and shown again if they try to roll before fixing it, so nobody is left guessing at what '
         'to change. Declining an <b>export</b> asks the same way.'),
('note', 'A <b>rejection is never the end of it.</b> A rejected sheet stays editable by its owner, so the player '
         'fixes whatever the GM objected to with <b>/char set</b> or <b>/char create</b> and rejoins the queue on '
         'their own. If they believe it was right as it stood, <b>/char submit</b> sends it again unchanged. There '
         'is no limit \u2014 a sheet can go back and forth as many times as it takes, and each resubmission retires '
         'the previous request so the channel still holds one live entry per player. The rejection notice spells '
         'out both routes, so nobody is left waiting on a GM to do it for them.'),
('note', 'A declined <b>export</b> works the same way \u2014 running <b>/char export</b> again puts a fresh request '
         'in front of the GMs.'),
('note', 'Sheets are accepted from <b>any channel the bot can read</b> \u2014 an ordinary text channel, a thread, a forum post, an announcement channel, or the text chat inside a <b>voice or stage channel</b>. Wherever it came from is recorded with the request, so the decision notice can find its way back there if the player\u2019s DMs are closed.'),
('note', 'The queue lives in the database, not in a Discord message. <b>/config channels approvals list:true</b> shows every sheet still waiting \u2014 who, how long ago, and which channel it came from \u2014 even if the request was never posted, was deleted, or landed somewhere nobody reads. If the bot cannot post to the approval channel it says so on that list and pings the GM roles in the channel the sheet was submitted from, so a player is never left locked out in silence.'),
('h2', 'Items & Pages'),
('code', [('/char give user:@Players item:A tarnished silver key \\\n  note:Cold to the touch', GM + ' only', 'gm'),
          ('/char take user:@Players id:3', 'by the number in their inventory', 'gm'),
          ('/char edit user:@Players id:3 item:Silver key note:Cold', 'reword an item', 'gm'),
          ('/char view show user:@Players full:true', 'their card, and every page below it at once', 'gm'),
          ('/char view standing user:@Players', 'merit and renown, and where each came from', 'gm'),
          ('/char view rollhistory user:@Players', 'every natural die they have rolled', 'gm')]),
('note', 'Items are free text \u2014 whatever a story calls for. Activities can hand them over too, and a '
         'player reads them back with <b>/char view inventory</b>. Lore submitted with <b>/char lore</b> arrives '
         'in the sheet approval channel with Approve / Reject buttons, and a rejection asks you why.'),
('h2', 'Character Pages'),
('p', 'Point the bot at a <b>forum</b> and every approved character gets a post of their own \u2014 somewhere '
      'for lore, art and notes. The link then appears on <b>/char view show</b> and in search results.'),
('code', [('/config channels charforum channel:#character-sheets', 'the forum'),
          ('/config channels gmcharforum channel:#gm-character-sheets', 'GM-only forum for GM sheets \u2014 same five blocks and\ntags, behind the GM category\u2019s permissions'),
          ('(character forum)', 'one thread per character: Sheet \u2192 Inventory \u2192 Lore \u2192\nStanding \u2192 Titles \u2192 Associations \u2192 Dice, all bot-kept (dice hourly: d2\u2013d20, averages,\nnat extremes); tags = order \u00b7 class \u00b7 Fallen \u00b7 Hero; threads are\nstaff-typed (players ask a Moderator/Expeditioner \u2014 a notice\nin every thread says so, with a Request lore update\nbutton \u2014 link your Google Doc and it lands in the GMs\u2019 Lore\nDocs approvals); GM sheets live in the GM-only forum,\nauto-created on update where the GM category exists'),
          ('/char page user:@Players', 'make one now'),
          ('/char page user:@Players thread:#their-thread', 'or link a post that already exists'),
          ('/char page user:@Players unlink:true', 'forget it \u2014 the thread itself is untouched')]),
('note', 'Pages are made when a sheet is <b>approved</b>. If the forum is missing or the bot cannot post '
         'there, the approval still goes through and the ' + GM + ' is told what went wrong \u2014 a broken '
         'forum must never block a character. If a thread is later deleted, the next attempt makes a fresh '
         'one rather than linking to nothing.'),
('h2', 'Searching the Roster'),
('code', [('/gm search order:Green Knight', 'everyone in an order'),
          ('/gm search class:Vanguard hero:true', 'combine filters'),
          ('/gm search order:\u2014 none set \u2014', 'find who still needs one'),
          ('/gm search who:NPCs', 'or narrow to one side'),
          ('/gm search name:mat fallen:true', 'part of a name, including the dead')]),
('p', 'Results read in the same order as everything else, with each character\u2019s page linked beside them. '
      'The fallen are left out unless asked for.'),
('h2', 'Preset Tags'),
('code', [('/char tag assign user:@Players tag:Hero of Kalidale', ''),
          ('/char tag remove user:@Players tag:Hero of Kalidale', ''),
          ('/char tag list user:@Players', '')]),
('h2', 'Custom Tags'),
('code', [('/char tag custom action:Create emoji:[any emoji] name:MyTag', ''),
          ('/char tag custom action:Delete name:MyTag', ''),
          ('/char tag custom action:List', '')]),
('note', 'For server emojis: type \\:emojiname: in chat to get the full ID.'),
('h2', 'Heroes & Signature Stats'),
('p', '<b>Hero</b> is a status a Game Master grants, not a player choice — players who try to set it are refused. It sits alongside whatever class and knight order a character already holds, and both player sheets and NPCs can carry it.'),
('code', [('/char hero user:@Players value:true', 'grant Hero to a player sheet'),
          ('/char signature user:@Players stat:str', 'designate their signature stat'),
          ('/npc hero name:Hollow Lieutenant stat:str', 'Hero NPC with a signature stat \u2014 a boss')]),
('p', 'A Hero may have one <b>signature stat</b> with <b>5 or more</b> points. Every roll using that stat '
      '\u2014 typed shorthand, <b>/roll</b>, and both attack and defence in fights, manual or automatic \u2014 '
      'is made with <b>advantage</b>, marked on the roll card. If the stat later drops below 5 the '
      'advantage simply stops applying until it is restored; an explicitly requested disadvantage still wins.'),
]

PARTS['gmhp'] = [
('aud', 'gm'),
('h2', GM + ' HP & Rerolls Targeting'),
('code', [('!hp @Players +5    !hp @Players -3', ''),
          ('!hp +5 @Players    !hp -3 @Players', ''),
          ('!rerolls @Players +1    !rerolls @Players -1', '')]),
('h2', GM + ' Rest Targeting'),
('code', [('lrest @Players   srest @Players   hpfull @Players   hphalf @Players', '')]),
('h2', 'Restoring Resources (/gm heal)'),
('code', [('/gm heal user:@Players', 'full HP \u2014 the default'),
          ('/gm heal user:@Players restore:Everything', 'HP, rerolls and heal charges'),
          ('/gm heal user:@Players amount:Half', 'restore half of maximum'),
          ('/gm heal user:@Players amount:Add value:3', 'add 3, capped at max'),
          ('/gm heal user:@Players amount:Exact value:1', 'set to an exact figure'),
          ('/gm heal npc:Hollow', 'one NPC'),
          ('/gm heal npc:all', 'every NPC at once')]),
('p', 'One command for every restore. Works on a player or an NPC (or <b>all</b> NPCs), and HP changes '
      'sync straight into any active fight. NPCs only have HP; heal charges are skipped for anyone who '
      'isn\u2019t a White Knight with WIS 5+.'),
('p', '<b>global:</b> restores everyone at once instead of naming a target \u2014 <b>Players</b>, <b>NPCs</b>, '
      'or <b>Everyone</b> together. It takes the same <b>amount</b> and <b>restore</b> options as a single '
      'target, so <b>/gm heal global:Everyone amount:Half</b> puts the whole server on half HP, and '
      '<b>/gm heal global:Players restore:Everything</b> hands every character HP, rerolls and heal charges '
      'back. Pick exactly one of <b>user</b>, <b>npc</b> or <b>global</b>.'),
('note', 'Unlike scheduled recovery, a global heal does <b>not</b> skip players out on a quest. A '
         + GM + ' typing this has decided to heal the room, and a silent exclusion mid-session would be a '
         'nasty surprise. Heal charges still only reach White Knights with WIS 5+, and every change syncs '
         'into any fight already running.'),
('h2', 'Scheduled Recovery'),
('p', 'A server can run <b>any number of named schedules</b>, each with its own timing and its own strength. '
      'A light top-up every few hours and a full recovery overnight can sit side by side.'),
('code', [('/config mechanics autorest action:Add or update name:Breather \\\n  hours:6 hp:50% rerolls:0% heal:0%',
           'half HP, rounded down, every 6h'),
          ('/config mechanics autorest action:Add or update name:Full Recovery \\\n  hours:24 hp:100% rerolls:100% heal:100%',
           'everything back, once a day'),
          ('/config mechanics autorest action:List', 'what is set, and when each next falls'),
          ('/config mechanics autorest action:Run now name:Breather', 'fire one immediately'),
          ('/config mechanics autorest action:Pause name:Breather', 'stop it without deleting it'),
          ('/config mechanics autorest action:Remove name:Breather', 'delete it')]),
('p', 'Amounts use the same tokens as <b>/config mechanics rest</b>. A bare value <b>sets</b> the resource \u2014 '
      '<b>100%</b> full, <b>50%</b> half, <b>4</b> exactly four. A <b>+</b> prefix <b>adds</b> instead: '
      '<b>+4</b> is four more HP, <b>+25%</b> a quarter of their maximum on top. <b>0%</b> leaves it alone. '
      'Everything caps at the maximum and rounds down, so half of 11 HP is 5. A typo is refused when you set '
      'the schedule rather than quietly doing nothing at three in the morning.'),
('p', '<b>Anyone on a quest that is in progress is skipped by every schedule.</b> Their HP, rerolls and charges '
      'stay exactly where they are until the quest is completed, so being out in the field costs something. '
      'Applicants, and members of quests still open or already finished, are restored as normal. Heal charges '
      'only go to White Knights with WIS 5+, as everywhere else.'),
('p', 'Give a schedule a <b>channel:</b> and each run is announced there, naming what it did, who was restored '
      'and who was left out in the field.'),
('p', 'Because schedules are <b>named and independent</b>, the counters need not share a cadence. A common '
      'pair is HP overnight and the charge counters twice a day:'),
('code', [('/config mechanics autorest action:Add name:Night hours:24 \
  hp:100% rerolls:0% heal:0%', 'HP once a day'),
          ('/config mechanics autorest action:Add name:Charges hours:12 \
  hp:0% rerolls:100% heal:100%', 'rerolls and heal charges every 12h')]),
('note', '<b>0%</b> means <i>leave it alone</i>, not <i>set it to nothing</i> \u2014 which is what lets one '
         'schedule move HP and another move only the charges. Both run on their own clocks without '
         'interfering.'),
('p', '<b>NPCs rest on the same schedule.</b> They have only HP \u2014 no rerolls, no heal charges \u2014 so the '
      'HP setting is the whole of it for them, and any change syncs straight into a fight already running.'),
('note', 'Two groups are left alone, players and NPCs alike: anyone <b>out on an active quest</b>, and anyone '
         '<b>standing in a fight</b>. Healing a fighter on a timer would undo an exchange partway through. '
         'The <b>fallen</b> are skipped entirely \u2014 a rest is not a resurrection. Each reason is reported '
         'separately, so it is clear who was passed over and why.'),
('note', 'Each schedule carries its own clock in the database, so a restart or redeploy can neither skip a '
         'cycle nor fire one early. Adding a schedule, or resuming a paused one, starts its count from that '
         'moment.'),
('code', [('/config mechanics autorest action:List', 'every recovery schedule'),
          ('/config mechanics autorest action:Add or update name:Breather \\\n  hours:6 hp:50% rerolls:0% heal:0%', 'a light top-up'),
          ('/config mechanics autorest action:Run now name:Breather', 'fire one immediately'),
          ('(when they land)', 'rests fall ON the hour \u2014 a 12-hour rest set at\n14:37 next falls due at 02:00, not 02:37'),
          ('/config mechanics autorest action:Who is excluded', 'who the next rest will pass over, and why \u2014 the fallen,\nanyone on an active quest, anyone in an active fight, and\nwhich quest or fight is holding them')]),
]

PARTS['npcs'] = [
('aud', 'gm'),
('h2', 'NPC Management'),
('code', [('/npc create name:Hollow Lieutenant str:14 con:12 dex:8\n  wis:4 lck:3 weapon1:Weaponised appendage weapon2:Talon', 'full stat block \u2014 the boss of the Hollows'),
          ('/npc create name:Hollow tank str:8 con:18 dex:3 wis:1 lck:1\n  weapon1:Weaponised appendage', 'an elite: hit points first, reach second,\nno voice at all'),
          ('/npc create name:Hollow str:4 con:3 dex:5 wis:1 lck:1\n  weapon1:Claw weapon2:Talon', 'the common Hollow'),
          ('/npc create name:Mysterious Stranger', 'name only \u2014 stats added later'),
          ('/npc create name:Mysterious Stranger str:14 con:10', 'fill stats in over time'),
          ('/npc manage copy name:Hollow new_name:Hollow 2', 'duplicate an NPC, fresh HP'),
          ('/npc show name:Hollow', 'full stat block for one NPC'),
          ('/npc hero name:Hollow Lieutenant stat:str', 'make an NPC a Hero with a signature stat \u2014 a boss'),
          ('/npc hero name:Hollow Lieutenant remove:true', 'strip Hero status'),
          ('/npc list', 'shows stats and current HP'),
          ('/npc list category:Hollows', 'only one category\u2019s NPCs'),
          ('/npc delete name:Mysterious Stranger', '')]),
('note', 'Stats are optional \u2014 an NPC can be registered by name (and given an avatar) with no stats at '
         'all, then statted up later. Re-running <b>/npc create</b> with the same name updates only the '
         'fields you supply and leaves the rest untouched.'),
('note', 'NPC HP persists between fights. Knocked-down NPCs (0 HP or less) are left out of new fights until restored.'),
('h2', 'NPC HP & Healing'),
('code', [('/npc hp name:Hollow value:3', 'set exact HP'),
          ('/npc hp name:Hollow', 'omit value — full heal'),
          ('/npc heal names:all', 'fully heal every NPC'),
          ('/npc heal names:Hollow, Hollow tank', 'fully heal the listed NPCs')]),
('h2', 'Speaking as an NPC'),
('code', [('/npc say name:Garrick speech:Fine steel, fair prices.', 'speech \u2014 in quote marks'),
          ('/npc say name:Garrick action:polishes a blade', 'action \u2014 italic emote'),
          ('/npc say name:Garrick action:polishes a blade\n  speech:Fine steel.', 'both, stacked'),
          ('/npc say name:Garrick', 'opens a writing box')]),
('note', '<b>Works in threads and forum posts too.</b> A thread cannot own a webhook, so the NPC\u2019s voice is created on the parent channel instead and every message is routed back into the thread it was called from \u2014 several threads under one channel share the same NPC webhook.'),
('p', 'Posts as the NPC through their webhook \u2014 their name and avatar, no dice rolled. Fill '
      '<b>action</b>, <b>speech</b>, or both: the action is italicised and the speech is wrapped in quote '
      'marks, stacked on separate lines. Leave both blank and a <b>writing box</b> opens with roomy '
      'multi-line fields \u2014 easier for longer roleplay. Use <b>raw</b> to post exactly as typed.'),
('h2', 'Rolling as an NPC'),
('code', [('/npc roll name:Hollow tank notation:1d20+8 label:strike\n  flavour:The hollow lunges', ''),
          ('/npc reroll name:Hollow tank [roll:adv]', 'reroll that NPC\u2019s last roll in this channel \u2014\nspends one of its LCK tokens'),
          ('/npc create name:Garrick str:4 con:4 dex:6 wis:8 lck:3 category:Vendor', ''),
          ('/npc list [category:] [compact:true]', 'the roster, paged \u2014 fifteen with full stats a\npage, or sixty names a page in compact; \u25c0 \u25b6 turn\nthe pages and a button swaps the view. Big\nrosters no longer flood the channel')]),
('p', 'Posts via webhook — appears as the NPC with their name and avatar. DDice uses <b>one shared webhook per channel</b>, so any number of NPCs can speak there without meeting Discord’s limit of fifteen webhooks per channel.'),
('code', [('/config mechanics cleanwebhooks', 'reclaim spare NPC webhooks \u2014 DDice keeps one per\nchannel, so anything else it owns there is a\nleftover and can be freed')]),
('note', 'Bot requires Manage Webhooks permission in the server.'),
('h2', 'NPC Pages'),
('p', 'Point the bot at a forum with <b>/config channels npcforum</b> and every NPC gets a page there \u2014 their statblock, their categories, their face and whatever lore is written \u2014 kept up to date as they change. The page wears their categories as Discord\u2019s own <b>tags</b>, so the sidebar filter sorts them for you.'),
('p', 'Say what kind they are when you make them and the category comes into being on the spot: <b>/npc create name:Garrick category:Vendor</b>. The first vendor you write brings <b>Vendor</b> into being; everyone after joins it. Add more later with <b>/npc category assign</b> \u2014 an NPC can belong to several, which is why each has one page rather than one per category.'),
('code', [('/config channels npcforum channel:#npc-pages', 'where the pages live'),
          ('/npc create name:Garrick category:Vendor', 'made, filed, and written up'),
          ('/npc category assign npc:Garrick category:Ally', 'a second category \u2014 a second TAG on their thread:\ntap tags in the forum to filter NPCs natively'),
          ('/npc manage sync [name:]', 'write up everyone already made')]),
('note', 'Twenty tags is Discord\u2019s limit for a forum. Beyond that, NPCs are still given pages \u2014 they simply go untagged rather than the whole thing failing. Deleting an NPC takes their page with them.'),
('h2', 'Setting NPC Avatars'),
('code', [('/config channels npcchannel #channel', 'set the NPC portrait forum \u2014 a thread per category')]),
('p', '1. Admin runs <b>/config channels npcchannel #channel</b> to set the portrait forum.<br/>'
      '2. ' + GM + ' uploads an image to that channel with the NPC name as the message text.<br/>'
      '3. Bot adds a checkmark reaction to confirm.  4. Re-upload with the same name to update.'),
('h2', 'One Face for a Whole Order \u2014 or a Whole Category'),
('p', 'Shared faces come from <b>tags</b>, not names. Post a picture in the portrait forum captioned with a bare <b>order</b> or <b>category</b> name and every member without a personal portrait wears it. Who wears what: their own face first, then their order\u2019s, then the first of their categories that has one. The old <b>Order | Name</b> pipe convention is retired \u2014 a pipe in a name is just a name.'),
('code', [('White Knight', 'caption \u2192 shared face for every White Knight'),
          ('Merchant', 'caption \u2192 shared face for every Merchant-tagged NPC'),
          ('Garrick Vale', 'caption \u2192 that one NPC\u2019s personal face')]),
('h2', 'Hidden Stats'),
('code', [('/config mechanics npcstats enabled:true', 'reveal NPC stat blocks — hidden by default')]),
('note', 'NPC roll cards hide STR/CON/DEX/WIS/LCK, the roll modifier and HP totals by default. Players see '
         'the name, order, the final roll total, the exact damage each hit deals, and a condition '
         '(unhurt / wounded / badly hurt / near death / down) instead of numbers \u2014 so the fight '
         'reads clearly without revealing what an NPC can take. Reveal everything with '
         '<b>/config mechanics npcstats enabled:true</b>. NPC management commands are ' + GM + '-only regardless.'),
('h2', 'NPC Records'),
('p', 'An NPC keeps the same records a player does. <b>/npc sheet</b> shows the lot on one page \u2014 stats and '
      'HP, standing, inventory, lifetime roll history and lore.'),
('code', [('/npc sheet name:Hollow Lieutenant', 'the whole record'),
          ('/npc give name:Hollow Lieutenant item:… note:…', 'hand them something'),
          ('/npc take name:Hollow Lieutenant id:1', 'take it back'),
          ('/npc npclore name:Hollow Lieutenant text:…', 'write their story'),
          ('/npc delete name:Hollow Lieutenant', 'remove them entirely')]),
('p', 'Their dice count too. Every roll the auto-pilot makes for an NPC \u2014 attacks, defences, reroll answers, '
      'initiative \u2014 goes into that NPC\u2019s lifetime tally, so a long-running villain builds a record of their '
      'own luck exactly as a player does.'),
('p', 'Merit and renown work on an NPC the same way they do on a character, so an NPC can hold standing in '
      'the world, be paid in merit, or carry the reward for a job.'),
('h2', 'Categories'),
('code', [('/npc category create name:Hollows', 'make a grouping'),
          ('/npc category assign name:Hollow tank category:Hollows', 'file an NPC under it'),
          ('/npc category remove name:Hollow tank', 'take it out'),
          ('/npc category list', 'every category and who is in it'),
          ('/npc category delete name:Hollows', 'remove the grouping')]),
('h2', 'Temporary NPCs — Enemies for One Fight'),
('p', 'Most enemies exist for one fight and should leave when it ends. A <b>temporary</b> NPC is a throwaway: no page, no roster seat, no record — it fights, and when the fight stands down, however it ends, every temporary NPC is swept away. Make them one at a time, clone a stock enemy by the handful through an encounter preset, or keep one that turned out to matter.'),
('code', [('/npc create name:Hollow str:3 con:2 dex:3 wis:1 lck:1 temp:true', 'a throwaway — no page, swept after the fight'),
          ('/fight addnpc npc:Hollow, Hollow 2', 'into a running fight, or name them on /fight start'),
          ('/encounter preset save name:Ridge hollows merits:2 npcs:Hollow x3', 'a saved scene; starting an encounter from it clones Hollow three times, temporary'),
          ('/npc temp list', 'every throwaway still lying about'),
          ('/npc temp keep name:Hollow 2', 'make one permanent — it gains a page'),
          ('/npc temp clear', 'sweep them all away now')]),
('note', '<b>/gm check rehearse</b> opens a private sparring thread against a <b>Sparring Dummy</b> the bot runs — a temporary NPC of its own, so every button can be tried before the table sees it, and nothing is left behind.'),
]

PARTS['weapons'] = [
('aud', 'gm'),
('p', 'Weapons players can pick from are kept as a server list, so names stay consistent.'),
('code', [('/char weapon add name:Gunlance atk:wis def:dex|con', 'add one, with its rules'),
          ('/char weapon stats name:Gunlance atk:wis', 'set or change them later'),
          ('/char weapon stats name:Gunlance atk:any', 'lift a restriction'),
          ('/char weapon list', 'see them all and what they allow'),
          ('/char weapon remove name:Gunlance', 'take one off'),
          ('/char weapon add name:Weaponised appendage atk:str def:con', 'the Hollows\u2019 own \u2014 NPC weapons sit on the same list'),
          ('/char weapon add name:Talon atk:dex def:dex', 'and a Claw beside it: str|dex')]),
('p', 'A weapon can dictate <b>which stats it fights with</b>, separately for attack and defence. A gunlance '
      'is fired rather than swung, so it might attack with <b>WIS</b> and defend with <b>DEX</b> or '
      '<b>CON</b>. Give several with <b>|</b> \u2014 <b>atk:str|dex</b> \u2014 and use <b>any</b> to lift a '
      'restriction.'),
('p', 'A player carrying that weapon is then held to it: attacking with a stat it does not allow is refused, '
      'and the refusal names what they <i>can</i> use. <b>The auto-pilot obeys the same rules</b> \u2014 an NPC '
      'fighting on automatic picks the best stat its weapons permit rather than always reaching for STR.'),
('note', 'A weapon with nothing set restricts nothing, so a list that predates this carries on unchanged. '
         'Carrying <b>one</b> unrestricted weapon frees the hand entirely; carrying two restricted ones lets '
         'you use either weapon\u2019s stats. An unarmed NPC is unrestricted, exactly as before.'),
('p', 'An NPC can also take a <b>class</b> \u2014 optional, the same three a player picks from \u2014 though a Hollow never does. A <b>Hero</b> NPC '
      'gets a signature stat with advantage on it, which makes for a decent boss. <b>Clear it</b> removes '
      'one, and it shows on their sheet and their fight card.'),
('p', '<b>NPCs carry weapons too.</b> Give one on <b>/npc create</b> and the auto-pilot is bound by exactly '
      'the same rules \u2014 a Hollow with a talon strikes with DEX instead of reaching for its best raw stat. '
      'The slot only accepts weapons already on the server list, so an NPC can never hold something whose '
      'rules are unknown; <b>none</b> clears it, and omitting it leaves whatever they carry alone.'),
('h2', 'Choosing How Auto Fights'),
('p', 'Left alone, the auto-pilot reaches for whichever stat is <b>highest</b>. A character who fights with '
      'finesse over force can say otherwise \u2014 and so can a ' + GM + ' setting up an NPC.'),
('code', [('/npc create name:Hollow tank weapon1:Weaponised appendage', 'arm a Hollow \u2014 the rest of its sheet is left\nas it was'),
          ('/npc edit name:X', 'change an existing NPC \u2014 only the options you pass;\nthe rest stays as it was'),
          ('/npc manage rename name:X to:Y', 'rename an NPC \u2014 page, portrait, items, standing\nand history all follow to the new name'),
          ('/npc reroll name:X', 'spend a reroll token \u2014 the pool is their LCK,\nrefilled by rest like a player\u2019s'),
          ('/npc manage export name:<npc>', 'the villain as a woven parchment PDF \u2014 survives\nDiscord, imports anywhere'),
          ('/npc manage import file:<pdf>', 'unpack an exported NPC here \u2014 applied directly,\nGM-as-approver; stats, class, hero flag, auto-pilot\npreferences and lore travel; standing and webhooks\nstay local; HP full, death gate lifted'),
          ('/npc create name:Hollow tank atk_stat:Strength', 'and how it should fight on auto'),
          ('/npc sheet name:Hollow tank', 'shows what it carries and what that allows')]),
]

PARTS['scrolls'] = [
('aud', 'gm'),
('h2', 'Scrolls'),
('code', [('/gm scroll', 'a modal for title and body; posts the parchment as an\nimage everyone can see plus a PDF with the writing\nwoven invisibly inside \u2014 the PDF survives Discord, so\nscrolls travel between servers on their own. file: hands\nany scroll PDF back: plain text out, plus a readable\nedition in standard type as image and woven PDF. A\nfile-name field on the modal names both files for\narchiving; the readable pair inherits it'),
          ('/config mechanics scrollfont font:<file>', 'store an .otf/.ttf \u2014 the face /gm scroll props are\nwritten in; the reply renders a sample line to prove it'),
          ('/config channels scrollarchive', 'a library for every scroll\u2019s named PDF \u2014 point it\nat a FORUM and each GM\u2019s scrolls file in their own\nthread, opened automatically on first use;\na plain channel keeps the flat archive'),
          ('/gm scroll file:<pdf>', 'read a scroll PDF back as text, and unfurl a fresh copy in this server’s font')]),
('h2', 'Speaking as the Bot'),
('code', [('/dd message:\u2026 header:\u2026 user:@Players channels:#one #two', 'speak AS THE BOT \u2014 so a GM who also plays a character\nnever blurs the two. Plain words by default; a bold\nheader only if you write one; posted in every channel\nyou name, or here. Who said it goes to the roll-audit,\nnot the room (GM)')]),
('h2', 'Fixing What Was Said'),
('code', [('Edit (DDice)  \u2014 long-press a message \u2192 Apps', 'edit anything the bot posted \u2014 its own messages and NPC\nspeech from /npc say alike. The text opens prefilled,\nsave replaces it, and the roll-audit records what\nchanged (GM)'),
          ('/edit [link:\u2026]', 'the same box without the Apps menu: a dropdown only\nyou see lists the last 25 lines the bot and its NPCs\nsaid here, newest first; pick one and the text opens\nprefilled. link: a message link or id goes straight\nto it. Nothing shows in the channel (GM)')]),
('p', 'Only messages the bot itself posted — its own, and NPC speech sent through <b>/npc say</b>. The roll audit records what changed. A line said through a webhook that has since been deleted cannot be edited by anyone — Discord ties the edit to the webhook — so the bot says so: delete it and have the NPC say it again.'),
]

PARTS['keeping'] = [
('aud', 'gm'),
('h2', 'Backups'),
('p', 'With a channel set, the database is posted there <b>every 24 hours</b> \u2014 and each backup '
      '<b>deletes and replaces the last</b>, so the channel holds exactly one file: the newest. '
      '<b>/gm backup now</b> takes one on demand and replaces the standing post the same way; with no channel '
      'set it comes back to you privately as a one-off copy instead.'),
('code', [('/gm backup now', 'take one immediately \u2014 ' + GM, 'gm'),
          ('/gm backup auto channel:#backups', 'automatic backups \u2014 ' + GM, 'gm'),
          ('/gm backup auto channel:#backups hours:12', 'or a different interval \u2014 ' + GM, 'gm'),
          ('/gm backup auto channel:off', 'stop them \u2014 ' + GM, 'gm')]),
('note', 'The cycle is measured from the <b>last backup taken</b>, not from when the bot last started. A '
         'redeploy mid-cycle resumes where it left off, and one that happens while a backup is overdue takes '
         'it shortly after boot \u2014 so a server that redeploys several times a day still gets its daily file. '
         'Switching backups on takes one immediately rather than waiting out the first cycle.'),
('note', 'The file is a <b>settled snapshot</b>, not the live database \u2014 taken with SQLite\u2019s own '
         '<b>VACUUM INTO</b>, so a write landing mid-upload cannot produce a torn file, and unused pages are '
         'dropped so the attachment is as small as it can be. The new backup is posted <b>before</b> the old '
         'one is removed, so a failure part-way leaves the previous file in place rather than none at all.'),
('note', 'Destructive actions (/npc delete, /fight end, /quest delete, /char weapon remove) ask for '
         'Confirm / Cancel before running.'),
('h2', 'Publishing These Books'),
('p', 'The three books are built outside the bot and committed to a repository. Point the bot at that '
      'repository and it will keep <b>one current post</b> of all three in a channel of your choosing \u2014 '
      'when a new build lands, the old post is deleted and replaced rather than the channel filling up with '
      'stale copies.'),
('code', [('/config channels docs channel:#gm-books repo:owner/name', 'set it up'),
          ('/config channels docs player_channel:#rules', 'player book alone, posted silently'),
          ('/config channels docs branch:live path:docs', 'if not on main, or not at the root'),
          ('/config channels docs push:true', 'fetch and repost right now'),
          ('/config channels docs', 'what is being watched, and the current post'),
          ('/config channels docs disable:true', 'stop watching')]),
('p', 'It looks every <b>15 minutes</b>, and <b>pings the ' + GM + ' roles</b> whenever it publishes. Checking '
      'is cheap \u2014 it asks GitHub for the file versions rather than downloading, so a check that finds nothing '
      'new costs three small requests.'),
('p', 'Give it a <b>player_channel</b> as well and the <b>player book alone</b> is kept current there \u2014 '
      'posted <b>silently</b>, with no role pinged and no notification raised, so a reference channel stays up '
      'to date without nagging anyone. It replaces its own previous post the same way.'),
('note', 'The new post goes up <b>before</b> the old one comes down, so a failure part-way leaves the channel '
         'with a copy rather than none at all. The repository must be public and hold the eight books under the '
         'names this script gives them: <b>DDice-Commands-Player.pdf</b>, <b>DDice-Commands-GameMaster.pdf</b> and '
         '<b>DDice-Commands-Parchment.pdf</b> for Knightfall, the same three prefixed <b>DnD5e-</b> for 5e, and the two '
         '<b>DDice-Examples</b> books. A table is handed the set for the rules it plays by, and the Examples either way.'),
('h2', 'Updates and the Deploy Mend'),
('p', 'Every deploy writes two dated threads into the <b>gm-updates</b> forum: <b>What’s new</b> — the one-line summary of each change first, then <b>In detail</b> beneath it: the line again, and under it what changed, why, what you do now and where it lands — and <b>Deploy mend</b>, what the boot built or repaired. The player half of the same news goes to the <b>updates</b> forum. Each thread is titled by its date, <i>[11/10/2026] [WEEK 41] Sunday 11th of October 2026 · What’s new</i>, so the newest sits at the top and the week is readable at a glance. The first boot with the forums in place posts the whole back-catalogue, oldest first, and clears the old update posts out of gm-quest-log. Discord orders a forum by when each thread was made, so the Deploy mend goes up last and a dated thread found out of turn is re-posted into order on the next boot — unless someone has written in it. The mend also keeps the NPC forum to one page per NPC: a duplicate page is folded back into the recorded one and counted in the Deploy mend, unless someone other than the bot has written in it, in which case it is named and left alone. A day with two deploys gets one What’s new: an entry that has grown since its thread was posted is deleted and posted again whole — or, if someone has written in the thread, kept and given the new lines beneath — and the Deploy mend says so.'),
('h2', 'Checks and Reports'),
('code', [('/gm check roster busy:true', 'every player at a glance \u2014 HP, and whether a quest or a\nfight is holding them (red means the next rest will pass\nthem over); busy:true shows only those tied up (GM)'),
          ('/gm check usage', 'sixty days of command use, quietest first \u2014 a report\nonly; nothing is ever removed by it (GM)'),
          ('/gm check migrations', 'the ledger of one-time migrations \u2014 which have run, which\nare pending, and what each did (GM)'),
          ('/gm check pages user:@Players', 'rebuild character pages from scratch \u2014 every bot block\ncleared and re-posted in order; reports what would not\ndelete. Blank does everyone (GM)'),
          ('/gm check portraits', 'move every stored NPC face into its category thread — expired links recovered from history, lost ones named (GM)'),
          ('/gm dicereport', 'the table\u2019s dice health \u2014 top rollers, hot and cold\nd20 hands, nat leaders, the full d20 spread'),
          ('/gm questwipe runs:true', 'delete EVERY quest on the server \u2014 confirm-gated;\nrosters, timelines and book entries go, threads\nstay. The run ledger and the DM cards\u2019 guided\ncounters survive unless runs:true')]),
('h2', 'Test Tools'),
('p', 'Trying a feature out usually means inventing a quest or an NPC you then have to tidy out of the world. '
      '<b>/gm test</b> makes throwaway ones instead. Everything it creates is named <b>[test]</b> and can be '
      'swept away in one command. It is hidden from players entirely.'),
('code', [('/gm test quest', 'a quest with you on the party, in this channel'),
          ('/gm test npc', 'an NPC with items, standing, rolls and lore already on it'),
          ('/gm test list', 'what it has made'),
          ('/gm test forum', 'exercise the NPC forums live, tidying up after itself'),
          ('/gm test clean', 'delete all of it \u2014 asks first')]),
('p', 'The test quest arrives ready to start, so the clock, the reminders, the timeline and the summary can '
      'all be exercised in a few minutes. The test NPC arrives with a record already on it, so '
      '<b>/npc sheet</b> has something to show.'),
('note', 'Cleaning only ever touches rows named <b>[test]</b>, and clears their events, summaries, inventory, '
         'roll tallies and standing log along with them.'),
]

PARTS['rules5e'] = [
('aud', 'all'),
('p', 'A server set to <b>D&amp;D 5e</b> plays by the SRD. Only what the SRD releases freely is built in; anything from the Player\u2019s Handbook alone \u2014 most subclasses, backgrounds, feats \u2014 your GMs add through the same custom routes the bot already has.'),
('p', 'Set it with <b>/config channels ruleset system:dnd5e</b> BEFORE anyone makes a character. It refuses to change once sheets exist, because a sheet written for one system cannot be read as another.'),
('h2', 'Making a 5e Character'),
('p', 'One command builds the sheet: <b>/dnd create</b>. Give the six scores, and it works out the rest \u2014 modifiers, proficiency from level, and hit points from the class die and CON.'),
('code', [('/dnd create name:Artorius str:16 dex:14 con:15\n  int:10 wis:12 cha:8 class:Fighter level:5 ac:16\n  saves:str, con skills:athletics, perception', 'a level 5 fighter in chain mail')]),
('p', 'The class sets the hit die \u2014 d12 for a Barbarian, d10 for Fighter, Paladin and Ranger, d8 for Bard, Cleric, Druid, Monk, Rogue and Warlock, d6 for Sorcerer and Wizard. Leave <b>ac:</b> out and it is 10 plus your DEX modifier. Saves and skills are written as you say them, separated by commas; an unknown skill is refused with the eighteen listed.'),
('p', 'The sheet then reads in 5e terms: each score with its modifier beside it, hit points, Armour Class and proficiency on the face of it, and any saves or skills you are trained in underneath.'),
('h2', 'Abilities and Modifiers'),
('p', 'Six abilities \u2014 <b>STR DEX CON INT WIS CHA</b> \u2014 each a score from which a modifier is taken. Ten is average and adds nothing; every two points either way is one point of modifier.'),
('code', [('score 8', 'modifier \u22121'), ('score 10 or 11', 'modifier +0'), ('score 14', 'modifier +2'), ('score 18', 'modifier +4'), ('score 20', 'modifier +5')]),
('h2', 'Proficiency'),
('p', 'A proficiency bonus is added to anything a character is trained in \u2014 attacks with their weapons, saving throws of their class, skills they have taken. It grows with level.'),
('code', [('levels 1 to 4', '+2'), ('levels 5 to 8', '+3'), ('levels 9 to 12', '+4'), ('levels 13 to 16', '+5'), ('levels 17 to 20', '+6')]),
('h2', 'Hit Points'),
('p', 'At first level, the class hit die plus the CON modifier. Every level after adds half the die (rounded up) plus the CON modifier again. A d10 class with CON 16 has 13 at first level and 22 at second.'),
('h2', 'Attacks and Armour Class'),
('p', 'To attack, roll a d20 and add your modifier and your proficiency. You are trying to reach the target\u2019s <b>Armour Class</b> \u2014 that is just a number, so nobody rolls to defend. Meeting the AC exactly is a hit. A natural 20 always hits and is a critical; a natural 1 always misses, whatever the total.'),
('p', 'Damage is the weapon\u2019s dice plus the ability modifier. A critical rolls the <b>dice</b> twice and leaves the modifier alone \u2014 so a 1d8+3 hit that crits is 2d8+3, never 2d8+6.'),
('h2', 'Levels, Hit Dice and Rest'),
('p', 'A level is not just a bigger number. <b>/dnd levelup</b> raises it and everything follows: the hit points arrive full, another hit die is added, and the proficiency bonus rises when it is due. A GM can level someone else with <b>user:</b>, or jump straight to a level with <b>to:</b>.'),
('p', 'You carry one <b>hit die</b> per level \u2014 the die your class rolls. A <b>short rest</b> spends one: roll it, add your CON modifier, and heal that much. A <b>long rest</b> fills you to full and hands back half your dice, rounded down, never fewer than one.'),
('code', [('!srest', 'spend a hit die and heal'),
          ('!lrest', 'full hit points, half your dice back'),
          ('/dnd levelup', 'gain the next level'),
          ('/dnd levelup user:@Players to:5', 'a GM setting someone to level 5')]),
('p', 'A level 5 Fighter with CON 15 has 44 hit points, +3 proficiency and five d10 hit dice; a short rest heals between 3 and 12 of them.'),
('h2', 'Fighting in 5e'),
('p', 'Combat runs through the same commands as everywhere else \u2014 <b>/fight start</b>, <b>/fight atk</b>, the turn order, the initiative \u2014 but a blow is settled differently. Nobody rolls to defend: the attack is measured against the target\u2019s Armour Class and resolves on the spot.'),
('code', [('/fight atk target:@Players', 'd20 + ability modifier vs their AC'),
          ('18 vs AC 15', 'a hit \u2014 damage follows at once'),
          ('natural 20', 'always hits, and the weapon dice are rolled twice'),
          ('natural 1', 'always misses, whatever the total')]),
('p', 'Damage is the weapon\u2019s dice plus the ability modifier, and the card shows the working \u2014 <b>1d8 [5] +3</b> \u2014 so nobody has to take the total on trust. A weapon with no dice set swings 1d8.'),
('h2', 'Dying'),
('p', 'At nought hit points a 5e character is dying, not dead. <b>/dnd deathsave</b> rolls a d20 \u2014 ten or better is a success, under ten a failure, a natural one counts as two failures, and a natural twenty is not a save at all \u2014 they come back on a single hit point. Three successes and they are stable; three failures and a GM records it with <b>/gm kill</b>, or a healer argues with it first.'),
('p', 'Any healing that lifts them above nought clears the tally, wherever it came from \u2014 a spell, a rest, or a GM\u2019s hand.'),
('h2', 'Saves, Skills and Initiative'),
('p', 'A saving throw or a skill check rides on <b>/roll</b>: <b>/roll save:dex</b> or <b>/roll skill:stealth</b>. The ability modifier is added, and your proficiency bonus on top when your class has that save or you have taken that skill \u2014 the card says so when it applies. All eighteen skills offer a dropdown as you type.'),
('code', [('/roll save:con', 'a Constitution save'),
          ('/roll skill:perception', 'a Wisdom (Perception) check'),
          ('/roll skill:athletics mode:Advantage', 'with advantage')]),
('p', 'Going first: on a 5e server you add your DEX <b>modifier</b>; on Knightfall you add the whole DEX score \u2014 the same command, the right arithmetic for the rules in force.'),
('h2', 'Weapons'),
('p', 'Set what a weapon rolls with <b>/dnd weapondice slot:1 dice:1d12</b>, and an attack uses it for damage instead of the default 1d8. Clear it and it falls back.'),
('h2', 'Conditions, and Being Hard to Kill'),
('p', 'All fifteen SRD conditions are known. <b>/dnd condition add:prone</b> takes one on, <b>remove:</b> lifts it, <b>clear:true</b> lifts them all, and a GM can name a <b>user:</b> or an <b>npc:</b>. They bend the dice on their own \u2014 a prone creature rolls at disadvantage and is easier to hit, an invisible one the reverse \u2014 and one of each cancels out, as the rules say.'),
('p', 'At nought hit points a character is dying, not dead. <b>/dnd deathsave</b> rolls a d20 \u2014 ten or more is a success, under ten a failure, a natural one counts as two failures, and a natural twenty brings them back on a single hit point. Three either way settles it, and any healing above nought clears the tally.'),
('code', [('/dnd deathsave', 'roll while dying'),
          ('/dnd temphp amount:8', 'temporary hit points \u2014 spent first, never stacked'),
          ('/dnd inspiration grant:true', 'a GM granting it'),
          ('/dnd inspiration use:true', 'spending it for advantage')]),
('p', 'Damage types are honoured where a sheet declares them: write <b>fire, immune poison, x2 acid</b> and a blow is halved, spared or doubled, and the card says which it did. Temporary hit points are spent before real ones.'),
('h2', 'Extra Attack'),
('p', 'A Fighter swings twice from fifth level, three times from eleventh and four from twentieth; a Barbarian, Paladin, Ranger or Monk swings twice from fifth. The turn is held until the action is spent, and the card says which swing you are on.'),
('h2', 'Magic'),
('p', 'A caster\u2019s slots follow from their class and level, so the bot works them out. <b>/spell slots</b> shows what is left, with a filled circle for a slot in hand and an empty one for a slot spent, along with the spell save DC (8 + proficiency + the casting ability) and the spell attack bonus.'),
('code', [('/spell slots', 'what magic you have left today'),
          ('/spell cast level:3 name:Fireball', 'spend a third-level slot'),
          ('/spell cast level:1 name:Bless concentration:true', 'and hold it together'),
          ('/spell concentration', 'what you are holding'),
          ('/spell concentration drop:true', 'let it go')]),
('p', 'Three patterns are known. <b>Full casters</b> \u2014 Bard, Cleric, Druid, Sorcerer, Wizard \u2014 read the usual table. <b>Half casters</b> \u2014 Paladin and Ranger \u2014 come in at second level and read it at half theirs. A <b>Warlock\u2019s</b> pact magic is a handful of slots all at one level, and they return on a <b>short</b> rest rather than a long one.'),
('p', 'Clerics, Druids, Wizards and Paladins prepare spells: the ability modifier plus their level, or half their level for a Paladin. <b>/spell prepare add:</b> readies one, <b>drop:</b> lets one go and <b>clear:true</b> starts again \u2014 the list is capped at what you may hold, and it tells you when it is full. A long rest returns every slot.'),
('note', 'Concentration is tracked. Casting a second concentration spell lets the first go, and when a blow lands on a caster the card asks for the save: <b>CON, DC 10 or half the damage taken, whichever is harder</b>.'),
('h2', 'Saves and Skills'),
('p', 'A saving throw means rolling a d20 and adding your modifier. If your class is good at that kind of save, you add your proficiency too. A skill check is the same, against a DC the GM sets. All eighteen SRD skills are known, each tied to its ability: Athletics to STR; Acrobatics, Sleight of Hand and Stealth to DEX; Arcana, History, Investigation, Nature and Religion to INT; Animal Handling, Insight, Medicine, Perception and Survival to WIS; Deception, Intimidation, Performance and Persuasion to CHA.'),
('note', 'What is live today: the rules above are implemented, and a 5e server uses 5e abilities and hit points. Combat still resolves the Knightfall way until the fight engine is wired to attack-versus-AC \u2014 that work, a 5e character sheet, classes and levels, and spellcasting are each still to come.'),
]

PARTS['library5e'] = [
('aud', 'gm'),
('h2', 'The Library'),
('p', 'Rather than typing a monster in every time it appears, keep it. The library holds monsters and spells for the whole server, and <b>/library summon</b> brings one out as an NPC ready to fight \u2014 several at once, numbered, if you name a <b>count:</b>.'),
('code', [('/library srd what:Both', 'load the set that ships with the bot'),
          ('/library list [search:]', 'what the library holds'),
          ('/library show name:Goblin', 'read one entry in full'),
          ('/library summon name:Goblin count:4 as:Scout', 'four Scouts step out, ready to fight'),
          ('/library import file:monsters.txt', 'read in your own'),
          ('/library forget name:Goblin', 'remove an entry')]),
('p', 'The set that ships here is drawn from the <b>System Reference Document</b>, which is released under Creative Commons \u2014 thirty monsters from bandits and goblins to an ancient red dragon and a lich, and twenty spells from Fire Bolt to Wish. It is a working core rather than the whole document; anything else you want, you import.'),
('h3', 'Importing your own'),
('p', 'One entry a line. The name comes first, then any fields you like, separated by pipes, in any order. Anything the parser does not recognise is kept as a note rather than thrown away, so your own wording survives.'),
('code', [('[MONSTER] Goblin | ac 15 | hp 7 | attack +4 | damage 1d6+2\n  | str 8 dex 14 con 10 int 10 wis 8 cha 8 | cr 1/4', 'a monster'),
          ('[SPELL] Fireball | level 3 | school evocation\n  | range 150 ft | 8d6 fire, DEX save halves', 'a spell'),
          ('# lines starting with a hash are ignored', 'a comment')]),
('p', 'Attach a <b>.txt</b> up to 400 KB, or paste entries into <b>paste:</b> separated by <b>;;</b>. A monster needs at least an <b>ac</b> and <b>hp</b>; a spell needs a <b>level</b> (0 for a cantrip). Anything already known is skipped and named, unless you pass <b>replace:true</b>. The reply says what was read, what was skipped and what was refused, so nothing fails quietly.'),
('note', 'Only SRD material ships with the bot. Anything from the Player\u2019s Handbook, Monster Manual or Dungeon Master\u2019s Guide is yours to enter for your own table \u2014 the import command is there for exactly that.'),
('h2', 'Monsters'),
('p', 'A monster is made from the four numbers any statblock leads with: <b>/npc manage create5e name:Orc ac:13 hp:15 attack:5 damage:1d12+3</b>. Its abilities are optional and sit at 10 unless you say otherwise. From then on it fights by its own numbers \u2014 the attack bonus off the block rather than a class it does not have, and the damage dice with their flat bonus.'),
('code', [('/npc manage create5e name:Orc ac:13 hp:15 attack:5\n  damage:1d12+3 str:16 con:16', 'the SRD orc'),
          ('/fight start players:@Players npcs:Orc', 'and it is in the initiative'),
          ('/npc say name:Orc speech:...', 'as ever, with its own face')]),
('note', 'Before this, a monster on a 5e server had no Armour Class of its own and one was guessed from a Knightfall stat \u2014 which put most of them around AC 7, so nearly everything hit. Give a monster its AC and that is settled.'),
]


PART_SYSTEM = {
    'roll-kf': 'knightfall',
    'char': 'knightfall',
    'hp': 'knightfall',
    'fight': 'knightfall',
    'gmfight': 'knightfall',
    'weapons': 'knightfall',
    'fallen': 'knightfall',
    'reference-kf': 'knightfall',
    'rules5e': 'dnd5e',
    'library5e': 'dnd5e',
}

# The journeys. A player meets things in the order they happen to them; a GM
# sets the table first, then meets the same things with their own half added
# after each. The full ("Parchment") edition is the GM journey with nothing
# left out.
BOOKS = {

  'player': [
    ('Start Here', ['start']),
    ('Rolling Dice', ['roll', 'roll-kf', 'roll2']),
    ('The Rules of 5e', ['rules5e']),
    ('Making Your Character', ['char']),
    ('Your Sheet and Your Thread', ['sheet']),
    ('HP, Healing and Rest', ['hp']),
    ('Fighting', ['fight']),
    ('Quests', ['quest']),
    ('Standing', ['standing']),
    ('Activities and Quizzes', ['activities']),
    ('The Fallen', ['fallen']),
    ('Reference', ['reference', 'reference-kf', 'feedback']),
  ],

  'gm': [
    ('Start Here', ['start']),
    ('Setting Up', ['setup']),
    ('Rolling Dice', ['roll', 'roll-kf', 'roll2', 'gmroll']),
    ('The Rules of 5e', ['rules5e']),
    ('Characters and Approvals', ['char', 'sheet', 'gmchar']),
    ('HP, Healing and Rest', ['hp', 'gmhp']),
    ('NPCs', ['npcs', 'library5e']),
    ('Weapons', ['weapons']),
    ('Running Fights', ['fight', 'gmfight']),
    ('Quests', ['quest', 'gmquest']),
    ('Standing', ['standing']),
    ('Activities and Quizzes', ['activities', 'gmactivities']),
    ('Scrolls, the Bot’s Voice, and Fixing What Was Said', ['scrolls']),
    ('Keeping the Server', ['keeping']),
    ('The Fallen', ['fallen']),
    ('Reference', ['reference', 'reference-kf', 'feedback']),
  ],

}


# ── Edition filtering ─────────────────────────────────────────────────────────
def filter_items(items, keep, aud='all'):
    """Keep the items an audience may see. Code rows may override the block audience."""
    out = []
    for item in items:
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
    return out

# The GM's book carries the table's half as well as their own, so a GM never
# has to open the player's book to see what a player sees (T, 2026-10-11).
KEEP = {'full': None, 'player': {'all', 'player'}, 'gm': None}

def filter_book(edition, module):
    """The chapters of one edition, for one rule system, with everything the
    audience may not see left out and emptied headings pruned."""
    keep = KEEP[edition]
    out = []
    for title, keys in BOOKS['gm' if edition == 'full' else edition]:
        chapter = []
        for key in keys:
            system = PART_SYSTEM.get(key, 'core')
            if system != 'core' and system != module:
                continue
            chapter += filter_items(PARTS[key], keep)
        if chapter:
            out += [('sec', title)] + chapter
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
h3=ParagraphStyle('h3',parent=h2,fontSize=11,leading=14.5,spaceBefore=6,spaceAfter=3)
sec_style=ParagraphStyle('h1',fontName='Serif-B',fontSize=19,leading=24,textColor=GOLD,alignment=TA_CENTER,spaceBefore=2,spaceAfter=0)
code_cmd=ParagraphStyle('code',fontName='Mono-B',fontSize=9.2,leading=12.8,textColor=INK)
code_cmt=ParagraphStyle('codec',fontName='Serif-I',fontSize=9.1,leading=12.8,textColor=DIM)
title_st=ParagraphStyle('title',fontName='Serif-B',fontSize=40,leading=48,textColor=GOLD,alignment=TA_CENTER,spaceAfter=4)
sub_st=ParagraphStyle('sub',fontName='Serif-I',fontSize=14,leading=19,textColor=DIM,alignment=TA_CENTER,spaceAfter=4)
toc_h=ParagraphStyle('toch',fontName='Serif-B',fontSize=16,leading=21,textColor=WINE,alignment=TA_CENTER,spaceBefore=16,spaceAfter=10)
foot_st=ParagraphStyle('foot',parent=sub_st,fontSize=11,spaceBefore=22)

def esc(s): return s.replace('&','&amp;').replace('<','&lt;').replace('>','&gt;')

def esc_cmt(s):
    """A comment may carry <b> and <i>; everything else is escaped."""
    return _re.sub(r'&lt;(/?[bi])&gt;', r'<\1>', esc(s))

LONG_COMMENT = 100   # characters; beyond this a comment runs full-width under its command

def code_block(rows):
    data=[]; extra=[]
    for cmd,comment in rows:
        h=esc(cmd).replace('\n','<br/>')
        h=_re.sub(r'  +', lambda m:'&nbsp;'*(len(m.group(0))-1)+' ', h)   # a run of spaces may break at its end
        if comment and len(comment) > LONG_COMMENT:
            r=len(data)
            data.append([Paragraph(h,code_cmd), ''])
            data.append([Paragraph(esc_cmt(comment),code_cmt), ''])
            extra += [('SPAN',(0,r),(1,r)),('SPAN',(0,r+1),(1,r+1)),
                      ('BOTTOMPADDING',(0,r),(1,r),0.6),('TOPPADDING',(0,r+1),(1,r+1),0.6),
                      ('LEFTPADDING',(0,r+1),(1,r+1),22)]
        else:
            data.append([Paragraph(h,code_cmd), Paragraph(('('+esc_cmt(comment)+')') if comment else '', code_cmt)])
    t=Table(data,colWidths=[104*mm,64*mm])
    t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),PARCH_D),('VALIGN',(0,0),(-1,-1),'TOP'),
        ('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),
        ('TOPPADDING',(0,0),(-1,-1),3.4),('BOTTOMPADDING',(0,0),(-1,-1),3.4),
        ('LINEBEFORE',(0,0),(0,-1),2.4,GOLD),('LINEBELOW',(0,-1),(-1,-1),0.5,GOLD_LT),
        ('LINEABOVE',(0,0),(-1,0),0.5,GOLD_LT)]+extra))
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
    if k=='h3': return [Paragraph(item[1],h3)]
    if k=='table': return [Spacer(1,3),data_table(item[1],item[2]),Spacer(1,7)]
    return []

def build(edition, outfile, subtitle, module=None, items=None):
    if items is None:
        items = filter_book(edition, module)
    if not items:
        print(f'  (nothing to print for {outfile} — skipped)')
        return
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
    # A chapter starts where the last one ended unless less than a quarter
    # of a page is left; a heading only needs room for itself and a few
    # lines below it, so blocks split across pages instead of leaving the
    # bottom of a page blank (T, 2026-10-11).
    for item in items:
        k=item[0]
        if k=='sec':
            story.append(CondPageBreak(doc.height/4)); story.append(sec_header(item[1]))
        elif k=='pbreak':
            story.append(CondPageBreak(doc.height/4))
        elif k=='h2':
            story.append(CondPageBreak(92)); story.append(Paragraph(item[1],h2))
        else:
            story+=render(item)
    # The sign-off travels with the last block, so it never sits alone on
    # a page of its own (the GM book did exactly that, 2026-10-13).
    tail=[Spacer(1,6),HRFlowable(width='30%',color=GOLD_LT,thickness=0.8,hAlign='CENTER',spaceBefore=10,spaceAfter=2),
        Paragraph('Penned by the DDice Scriptorium · May your rolls be ever in your favour',foot_st)]
    j=len(story)-1
    while j>0 and isinstance(story[j],Spacer): j-=1
    story[j:]=[KeepTogether(story[j:]+tail)]
    doc.multiBuild(story)
    print(f'built {edition} → {outfile}  ({doc.page} pages)')

# CI (or any caller) can point the build elsewhere; default is the
# interactive-session output directory.
OUT = _os.path.join(_os.environ.get('DDICE_PDF_OUT', '/mnt/user-data/outputs'), '')
# Six books: one set per system, each complete on its own — the shared half
# (quests, NPCs, scrolls, activities, quizzes) bound in with the rules that
# server actually plays by. Knightfall keeps the names it has always had; the
# 5e set is prefaced so both can sit in one folder.

# ── The Examples book ──────────────────────────────────────────────────
# Every other book explains what a command IS. This one shows what happens
# when you use it: what you type on one side, what the bot does on the
# other, in the plainest words we can manage (T, 2026-08-20).
EXAMPLES = [
('sec', 'How to read this book'),
('p', 'Each example shows two things: what you type, and what happens next. '
      'You can copy the line exactly, then change the names to your own.'),
('note', '<b>@Players</b> means any player, picked from the list Discord shows you, and <b>@GMs</b> any Game Master; names like <b>@Artorius</b> and <b>@Meliora</b> are people in the story. '
        'Words like <b>name:</b> are labels \u2014 type the label, then your answer.'),

('sec', 'Rolling dice'),
('code', [('1d20', 'Rolls one twenty-sided die. The bot shows the number.'),
          ('2d6+3', 'Rolls two six-sided dice, adds 3, shows the total.'),
          ('r1d20+5 attack', 'Same roll with a name on it, so everyone knows what it was for.')]),
('p', 'A <b>natural 20</b> is when the die itself shows 20, before you add anything. '
      'A <b>natural 1</b> is when it shows 1. Both matter in fights.'),

('sec', 'Making a character'),
('code', [('/char create', 'The bot asks you questions and builds your sheet.'),
          ('/char view show', 'Shows your sheet: your stats, your things, your dice history.'),
          ('/char view show user:@Artorius', 'Shows somebody else\u2019s sheet.')]),
('p', 'Your sheet also lives in its own thread in the character forum. '
      'It updates itself \u2014 you never have to edit it.'),

('sec', 'Fighting'),
('code', [('/fight start', 'Everyone rolls to see who goes first.'),
          ('/fight atk stat:str target:@Artorius', 'You swing at Artorius using your strength.'),
          ('/fight def stat:dex', 'You try to dodge, using how quick you are.'),
          ('/fight resolve', 'The bot compares the two rolls and says what happened.')]),
('p', 'If your attack roll shows a natural 1, the attack fails and your next defence is weaker \u2014 '
      'you roll the die on its own, with no stat added. If your defence roll shows a natural 20, '
      'you turn the blow aside AND your next attack gets +2.'),

('sec', 'Quests'),
('code', [('/quest create', 'Write a new quest.'),
          ('/quest post number:1', 'Put it on the board so players can ask to join.'),
          ('/quest party approve number:1 user:@Artorius', 'Let Artorius in.'),
          ('/quest run start number:1', 'Begin a run with everyone who was let in.'),
          ('/quest run complete number:1 summary:\u2026', 'Finish it, pay merits, and tell the story.')]),

('aud', 'gm'),
('sec', 'Being an NPC'),
('code', [('/npc create name:Garrick str:3 con:2 dex:2 wis:1 lck:2', 'Make a person for the world.'),
          ('/npc say name:Garrick speech:Hello there', 'Garrick speaks, in his own name and face.'),
          ('/npc create name:Hollow str:3 con:2 dex:3 wis:1 lck:1 temp:true', 'A Hollow for this fight only \u2014 no page, swept away when the fight ends.'),
          ('/npc temp list', 'Every throwaway NPC still lying about.'),
          ('/npc temp keep name:Hollow', 'Keep one \u2014 it becomes permanent and gains a page.'),
          ('/npc temp clear', 'Sweep every temporary NPC away now.')]),

('aud', 'gm'),
('sec', 'Buttons and targets'),
('code', [('/button roll stat:dex dc:12 reason:The ledge is slippery',
           'Puts a button in the channel. Anyone can press it to try climbing.'),
          ('/button roll dice:2d6+1 for:@Artorius once:true',
           'Only Artorius can press it, and only once.'),
          ('/target create name:Barricade dc:12 stat:STR, DEX success_flavour:The planks give way. fail_flavour:It does not budge.',
           'Something to hit, a d20 against 12, STR and DEX as buttons. A press opens a short form \u2014 what you do, what you say \u2014 then rolls. A natural 20 beats it outright and posts the success flavour; otherwise each hit asks the GM to call it, and the verdict opens a What happens? form prefilled with the flavour. A fail brings the card back below with a counter.')]),

('aud', 'gm'),
('sec', 'A check for everybody'),
('code', [('/button group stat:wis dc:12 reason:The bridge groans',
           'Everyone presses once and rolls. The message keeps score.'),
          ('(the presses)', 'Artorius rolls 17 and Meliora 14 \u2014 across. Zeus rolls 6 \u2014 not.'),
          ('(press Call it)', 'The GM closes it, and the bot says how many got across: two of three.')]),
('p', 'This is for moments when the whole party is doing the same thing at once \u2014 '
      'climbing, hiding, holding a door. One message, one answer.'),

('aud', 'gm'),
('sec', 'Remembering last time'),
('code', [('/quest run recap number:1', 'The bot writes up what happened, from its notes.'),
          ('/quest run recap number:1 post:true', 'Same, but it reads it out to the party.')]),
('p', 'The recap is a first draft. Change any of it before you share it \u2014 '
      'the bot only knows what was written down.'),

('aud', 'gm'),
('sec', 'Titles and groups'),
('code', [('/standing title grant user:@Artorius title:Siren\u2019s Bane source:Sirens Redoubt',
           'Artorius earns a title. It shows on their page.'),
          ('/standing association add user:@Artorius group:The Falconers note:Quartermaster',
           'Artorius now stands with the Falconers.')]),

('aud', 'gm'),
('sec', 'Encounters \u2014 sessions on the fly'),
('code', [('/encounter start name:Hollows on the ridge merits:2', 'No board, no applications. The bot lists the roster; tick who is in it, press Open the encounter, and it opens its own thread in quest-instances with the party pulled in.'),
          ('/encounter add user:@Artorius', 'Artorius arrives late. The seats are yours; nobody can press their own way in.'),
          ('/encounter preset save name:Ridge hollows merits:2 npcs:Hollow x3', 'Save the scene once.'),
          ('/encounter start name:Hollows again preset:Ridge hollows', 'Next time it is one command: merits set, three Hollows step out.'),
          ('/encounter end summary:They fled.', 'Pays out, writes the chronicle, posts the review button.')]),
('p', 'An encounter does not count toward one quest at a time, so a player already on a quest can still be jumped by bandits. '
      'Its seats are the GM\'s: no Join button, `/encounter add` and `/encounter remove` in its thread. '
      'One left quiet for six hours pings the GMs in its room; it never ends itself.'),

('sec', 'Campaigns \u2014 the long arc'),
('code', [('/campaign create name:The Falconer\u2019s War description:\u2026', 'A named arc with its own GM-only thread and a live card.'),
          ('/quest create \u2026 campaign:The Falconer\u2019s War', 'Link at birth. Every run of that listing follows it.'),
          ('/campaign add campaign:The Falconer\u2019s War quest:2', 'Or link something that already exists \u2014 old quests too.'),
          ('/campaign note campaign:\u2026 text:A letter arrives from the coast.', 'A beat that happened between runs.'),
          ('/campaign status campaign:\u2026 text:The garrison holds. For now.', 'Where things stand \u2014 the present, not the history.'),
          ('/campaign recap campaign:\u2026', 'A previously-on across every linked run.'),
          ('/campaign show campaign:\u2026', 'Players see the premise, what is done, and their own part. GMs see everything.')]),

('sec', 'Wrapping up'),
('code', [('/quest run winddown number:1', 'The story is over; rewards are not settled. The party may rest and join other quests while you decide.'),
          ('/quest run complete number:1 summary:\u2026 title:\u2026', 'Pays everyone seated when the story ended \u2014 even someone kicked during the winddown.'),
          ('(press \u21A9 Reopen within five minutes)', 'Wrong number? The payout is reversed and the party released. Fix it, complete again.'),
          ('/quest archive number:1', 'A box opens for the final word. It goes on the record, into the thread, and the GM quest log.'),
          ('/gm check stalled', 'What is waiting on a GM: winding-down runs, quiet encounters, staged parties never launched. A weekly digest of the same lands in the gm-digest forum, one thread a week.')]),

('sec', 'Fixing what was said'),
('code', [('(long-press a bot message \u2192 Apps \u2192 Edit (DDice))', 'The text opens already filled in. Fix the spelling, save. Works on NPC speech too.'),
          ('/edit', 'The same from a private list: the last lines the bot and its NPCs said here. Pick one, fix it, save. The table sees only the corrected line.')]),
('p', 'Only messages the bot itself posted. The roll-audit records what changed.'),

('aud', 'all'),
('sec', 'Telling the GMs something'),
('code', [('/feedback send', 'Pick a room, score it out of ten, say your piece. Only GMs see it.'),
          ('(the button on your page)', 'Ask a GM to update your lore document.')]),
]

# The examples book is its own edition: one system-free set of worked
# examples that suits either ruleset, filtered by audience alone.
def build_examples(edition, outfile, subtitle):
    build(edition, outfile, subtitle, items=prune(filter_items(EXAMPLES, KEEP[edition])))

# Two books, because a player should not have to read past commands they
# cannot run to find the one they can (T, 2026-08-21). The player book keeps
# the sections anyone may use; the GM book is the whole thing.
build_examples('player', OUT + 'DDice-Examples-Player.pdf',
               'Worked Examples \u00b7 What to type, and what happens')
build_examples('gm', OUT + 'DDice-Examples-GameMaster.pdf',
               'Worked Examples \u00b7 Everything, including the GM\u2019s side')

for _sys, _prefix, _name in [('knightfall', '', 'Knightfall'), ('dnd5e', 'DnD5e-', 'D&D 5e (SRD)')]:
    build('full',   OUT + _prefix + 'DDice-Commands-Parchment.pdf',
          f'A Chronicle of Commands \u00b7 {_name}', _sys)
    build('player', OUT + _prefix + 'DDice-Commands-Player.pdf',
          f'{_name} \u00b7 Player\u2019s Edition', _sys)
    build('gm',     OUT + _prefix + 'DDice-Commands-GameMaster.pdf',
          f'{_name} \u00b7 Game Master\u2019s Edition', _sys)
