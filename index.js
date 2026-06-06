// ============================================================
//  TTRPG Discord Bot — single file edition
//  Requires: discord.js, better-sqlite3, dotenv
// ============================================================

require('dotenv').config();
const { Client, GatewayIntentBits, SlashCommandBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// ─────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────

const fs = require('fs');
// Always write to the persistent volume path, fall back to local for dev
const DB_PATH = '/app/data/ttrpg.db';
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
console.log('Database path:', DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, order_name TEXT DEFAULT NULL,
    str INTEGER DEFAULT 0, con INTEGER DEFAULT 0, dex INTEGER DEFAULT 0,
    wis INTEGER DEFAULT 0, lck INTEGER DEFAULT 0,
    hp_current INTEGER DEFAULT 0, rerolls_current INTEGER DEFAULT 0, profile_enabled INTEGER DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS profile_saves (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, slot_name TEXT NOT NULL,
    snapshot TEXT NOT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, slot_name)
  );
  CREATE TABLE IF NOT EXISTS roll_history (
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, user_id TEXT NOT NULL,
    notation TEXT NOT NULL, label TEXT DEFAULT NULL, saved_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY, gm_role_id TEXT DEFAULT NULL, heal_charges INTEGER DEFAULT 3
  );
  CREATE TABLE IF NOT EXISTS heal_charges (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, current INTEGER DEFAULT 3,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS player_tags (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, tag_name TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, tag_name)
  );
  CREATE TABLE IF NOT EXISTS custom_tags (
    guild_id TEXT NOT NULL, tag_name TEXT NOT NULL, emoji TEXT NOT NULL,
    PRIMARY KEY (guild_id, tag_name)
  );
`);

function getChar(gid, uid) {
  return db.prepare('SELECT * FROM characters WHERE guild_id=? AND user_id=?').get(gid, uid);
}
function upsertChar(gid, uid, fields) {
  const ex = getChar(gid, uid);
  if (!ex) {
    db.prepare(`INSERT INTO characters (guild_id,user_id,order_name,str,con,dex,wis,lck,hp_current,rerolls_current,profile_enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(gid, uid, fields.order_name??null, fields.str??0, fields.con??0, fields.dex??0, fields.wis??0, fields.lck??0, fields.hp_current??0, fields.rerolls_current??0, fields.profile_enabled??1);
  } else {
    const sets = Object.entries(fields).map(([k])=>`${k}=?`).join(',');
    db.prepare(`UPDATE characters SET ${sets} WHERE guild_id=? AND user_id=?`).run(...Object.values(fields), gid, uid);
  }
  return getChar(gid, uid);
}
function setStatAndDerive(gid, uid, stat, val) {
  let ch = getChar(gid, uid);
  if (!ch) { upsertChar(gid, uid, {}); ch = getChar(gid, uid); }
  const upd = { [stat]: val };
  if (stat === 'con') upd.hp_current = val + 2;
  if (stat === 'lck') upd.rerolls_current = val;
  upsertChar(gid, uid, upd);
  return getChar(gid, uid);
}
function saveRoll(gid, cid, uid, notation, label) {
  db.prepare(`INSERT OR REPLACE INTO roll_history (guild_id,channel_id,user_id,notation,label,saved_at) VALUES (?,?,?,?,?,datetime('now'))`).run(gid, cid, uid, notation, label??null);
}
function getLastRoll(gid, cid, uid) {
  return db.prepare('SELECT * FROM roll_history WHERE guild_id=? AND channel_id=? AND user_id=?').get(gid, cid, uid);
}
function getConfig(gid) {
  let c = db.prepare('SELECT * FROM guild_config WHERE guild_id=?').get(gid);
  if (!c) { db.prepare('INSERT INTO guild_config (guild_id) VALUES (?)').run(gid); c = db.prepare('SELECT * FROM guild_config WHERE guild_id=?').get(gid); }
  return c;
}
function setConfig(gid, fields) {
  getConfig(gid);
  const sets = Object.entries(fields).map(([k])=>`${k}=?`).join(',');
  db.prepare(`UPDATE guild_config SET ${sets} WHERE guild_id=?`).run(...Object.values(fields), gid);
}
function getHealCharges(gid, uid, max) {
  let r = db.prepare('SELECT * FROM heal_charges WHERE guild_id=? AND user_id=?').get(gid, uid);
  if (!r) { db.prepare('INSERT INTO heal_charges (guild_id,user_id,current) VALUES (?,?,?)').run(gid, uid, max); r = db.prepare('SELECT * FROM heal_charges WHERE guild_id=? AND user_id=?').get(gid, uid); }
  return r;
}
function setHealCharges(gid, uid, cur) {
  db.prepare('INSERT OR REPLACE INTO heal_charges (guild_id,user_id,current) VALUES (?,?,?)').run(gid, uid, cur);
}
// ── Tag helpers ──────────────────────────────────────────────────────────────
const PRESET_TAGS = {
  'Hero of Kalidale': '⚜️',
  'Expeditioners': '📜',
};

function getPlayerTags(gid, uid) {
  return db.prepare('SELECT tag_name FROM player_tags WHERE guild_id=? AND user_id=?').all(gid, uid).map(r => r.tag_name);
}
function assignTag(gid, uid, tagName) {
  db.prepare('INSERT OR IGNORE INTO player_tags (guild_id, user_id, tag_name) VALUES (?,?,?)').run(gid, uid, tagName);
}
function removeTag(gid, uid, tagName) {
  db.prepare('DELETE FROM player_tags WHERE guild_id=? AND user_id=? AND tag_name=?').run(gid, uid, tagName);
}
function getCustomTags(gid) {
  return db.prepare('SELECT * FROM custom_tags WHERE guild_id=?').all(gid);
}
function addCustomTag(gid, tagName, emoji) {
  db.prepare('INSERT OR REPLACE INTO custom_tags (guild_id, tag_name, emoji) VALUES (?,?,?)').run(gid, tagName, emoji);
}
function deleteCustomTag(gid, tagName) {
  db.prepare('DELETE FROM custom_tags WHERE guild_id=? AND tag_name=?').run(gid, tagName);
  // Also remove from all players
  db.prepare('DELETE FROM player_tags WHERE guild_id=? AND tag_name=?').run(gid, tagName);
}
function resolveTagEmoji(gid, tagName) {
  if (PRESET_TAGS[tagName]) return PRESET_TAGS[tagName];
  const custom = db.prepare('SELECT emoji FROM custom_tags WHERE guild_id=? AND tag_name=?').get(gid, tagName);
  return custom ? custom.emoji : '🏷️';
}
function getAllAvailableTags(gid) {
  const customs = getCustomTags(gid).map(t => t.tag_name);
  return [...Object.keys(PRESET_TAGS), ...customs];
}

function saveProfile(gid, uid, slot, snap) {
  db.prepare(`INSERT OR REPLACE INTO profile_saves (guild_id,user_id,slot_name,snapshot,saved_at) VALUES (?,?,?,?,datetime('now'))`).run(gid, uid, slot, JSON.stringify(snap));
}
function loadProfile(gid, uid, slot) {
  const r = db.prepare('SELECT * FROM profile_saves WHERE guild_id=? AND user_id=? AND slot_name=?').get(gid, uid, slot);
  return r ? JSON.parse(r.snapshot) : null;
}
function listProfiles(gid, uid) {
  return db.prepare('SELECT slot_name,saved_at FROM profile_saves WHERE guild_id=? AND user_id=? ORDER BY saved_at DESC').all(gid, uid);
}
function maxHp(ch) { return (ch?.con ?? 0) + 2; }
function maxRerolls(ch) { return ch?.lck ?? 0; }
function isWhiteKnight(ch) { return ch?.order_name === 'White Knight' && ch?.wis >= 5; }

// ─────────────────────────────────────────────
//  DICE
// ─────────────────────────────────────────────

function parseNotation(n) {
  const m = n.trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return { dice: parseInt(m[1]), sides: parseInt(m[2]), modifier: m[3] ? parseInt(m[3]) : 0 };
}
function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }
function rollNotation(notation) {
  const p = parseNotation(notation);
  if (!p) return null;
  const rolls = Array.from({ length: p.dice }, () => rollDie(p.sides));
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { dice: p.dice, sides: p.sides, modifier: p.modifier, rolls, sum, total: sum + p.modifier, notation };
}
function rollAdvantage(notation) {
  const p = parseNotation(notation); if (!p) return null;
  const r1 = rollDie(p.sides), r2 = rollDie(p.sides);
  const chosen = Math.max(r1, r2), dropped = Math.min(r1, r2);
  return { chosen, dropped, rolls: [r1, r2], modifier: p.modifier, total: chosen + p.modifier, sides: p.sides, notation };
}
function rollDisadvantage(notation) {
  const p = parseNotation(notation); if (!p) return null;
  const r1 = rollDie(p.sides), r2 = rollDie(p.sides);
  const chosen = Math.min(r1, r2), dropped = Math.max(r1, r2);
  return { chosen, dropped, rolls: [r1, r2], modifier: p.modifier, total: chosen + p.modifier, sides: p.sides, notation };
}

// ─────────────────────────────────────────────
//  CRIT DETECTION
// ─────────────────────────────────────────────

function detectCrit(result, mode) {
  if (mode === 'adv' || mode === 'dis') {
    if (result.chosen === result.sides) return 'crit';
    if (result.chosen === 1) return 'fail';
    return null;
  }
  if (result.rolls.length === 1) {
    if (result.rolls[0] === result.sides) return 'crit';
    if (result.rolls[0] === 1) return 'fail';
  }
  return null;
}

// ─────────────────────────────────────────────
//  EMBED BUILDER
// ─────────────────────────────────────────────

const KNIGHT_EMOJIS = {
  'White Knight':'⚪','Black Knight':'⚫','Gold Knight':'🟡',
  'Grey Knight':'🩶','Blue Knight':'🔵','Purple Knight':'🟣',
  'Green Knight':'🟢','Red Knight':'🔴',
};

function pad(val, w=10) {
  const s = String(val??0);
  return ' '.repeat(Math.max(1, w - s.length)) + s;
}

function critPrefix(critType) {
  if (critType === 'crit') return '🟡 ';
  if (critType === 'fail') return '🔴 ';
  return '';
}

function totalStr(total, critType) {
  if (critType === 'crit') return `🟡 **${total}**`;
  if (critType === 'fail') return `🔴 **${total}**`;
  return `**${total}**`;
}

function buildRollLine(result, mode, critType) {
  const mod = result.modifier;
  const modStr = mod > 0 ? ` +${mod}` : mod < 0 ? ` ${mod}` : '';
  const ts = totalStr(result.total, critType);
  if (mode === 'normal') return `🎲  ${result.notation} → [${result.rolls.join(', ')}]${modStr} = ${ts}`;
  const ml = mode === 'adv' ? '(advantage)' : '(disadvantage)';
  return `🎲  ${result.notation} ${ml} → [${result.chosen}, ${result.dropped}]${modStr} = ${ts}`;
}

function buildRollEmbed({ rollLine, label, isReroll, char, healCharges, maxCharges, flavour, total, critType, tags, gid }) {
  const lines = [];
  const lc = critPrefix(critType);
  if (label) lines.push(`${lc}**${label}**${isReroll ? ' *(reroll)*' : ''}`);
  else if (isReroll) lines.push('*(reroll)*');
  lines.push(rollLine, '');
  lines.push('─────────────────────────────');
  lines.push(`⚔️  ${char.displayName}`);
  // Tags above knight order
  if (tags && tags.length > 0 && gid) {
    tags.forEach(t => lines.push(`${resolveTagEmoji(gid, t)}  ${t}`));
  }
  if (char.order_name) lines.push(`${KNIGHT_EMOJIS[char.order_name]??'⚪'}  ${char.order_name}`);
  lines.push(`❤️  HP${pad(char.hp_current)} / ${maxHp(char)}`);
  lines.push(`🔄  Rerolls${pad(char.rerolls_current)} / ${maxRerolls(char)}`);
  if (isWhiteKnight(char)) lines.push(`🛡️  Heal${pad(healCharges)} / ${maxCharges}`);
  lines.push('');
  lines.push(`💪  STR${pad(char.str)}`);
  lines.push(`🫀  CON${pad(char.con)}`);
  lines.push(`⚡  DEX${pad(char.dex)}`);
  lines.push(`🧠  WIS${pad(char.wis)}`);
  lines.push(`🍀  LCK${pad(char.lck)}`);
  if (flavour) {
    // Collapse multiline flavour into single block, strip trailing asterisks from markdown collisions
    const cleanFlavour = flavour.split(/\n/).map(l => l.trim()).filter(l => l.length > 0).join('\n\n');
    lines.push('', '─────────────────────────────');
    lines.push(`**${label??'roll'}** — ${totalStr(total, critType)}`);
    lines.push('');
    lines.push(cleanFlavour);
  }
  return lines.join('\n');
}

function buildPlainRoll({ rollLine, label, isReroll, flavour, total, critType }) {
  const lines = [];
  const lc = critPrefix(critType);
  if (label) lines.push(`${lc}**${label}**${isReroll ? ' *(reroll)*' : ''}`);
  else if (isReroll) lines.push('*(reroll)*');
  lines.push(rollLine);
  if (flavour) {
    const cleanFlavour = flavour.split(/\n/).map(l => l.trim()).filter(l => l.length > 0).join('\n\n');
    lines.push('', '─────────────────────────────');
    lines.push(`**${label??'roll'}** — ${totalStr(total, critType)}`);
    lines.push('');
    lines.push(cleanFlavour);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

const STATS = ['str','con','dex','wis','lck'];

function parseRollInput(input, char) {
  const [rollPart, ...fp] = input.split('\n');
  const flavour = fp.join('\n').trim() || null;
  const trimmed = rollPart.trim().toLowerCase();
  // Stat quick roll
  if (STATS.includes(trimmed)) {
    const val = char?.[trimmed] ?? 0;
    return { notation: `1d20+${val}`, label: trimmed, flavour };
  }
  const m = rollPart.trim().match(/^(\d+d\d+(?:[+-]\d+)?)\s*(.*)?$/i);
  if (!m) return null;
  return { notation: m[1], label: m[2]?.trim() || null, flavour };
}

async function getDisplayName(guild, uid) {
  try { const mb = await guild.members.fetch(uid); return mb.nickname || mb.user.username; }
  catch { return 'Unknown'; }
}

async function isGm(guild, uid) {
  const cfg = getConfig(guild.id);
  if (!cfg.gm_role_id) return false;
  try { const mb = await guild.members.fetch(uid); return mb.roles.cache.has(cfg.gm_role_id); }
  catch { return false; }
}

async function sendRollEmbed(message, rollLine, label, isReroll, uid, flavour, total, critType) {
  const gid = message.guild.id;
  const char = getChar(gid, uid);
  if (char?.profile_enabled === 1) {
    const cfg = getConfig(gid);
    const maxCharges = cfg.heal_charges ?? 3;
    const healRow = getHealCharges(gid, uid, maxCharges);
    const displayName = await getDisplayName(message.guild, uid);
    const tags = getPlayerTags(gid, uid);
    return message.reply(buildRollEmbed({ rollLine, label, isReroll, char: { ...char, displayName }, healCharges: healRow.current, maxCharges, flavour, total, critType, tags, gid }));
  }
  return message.reply(buildPlainRoll({ rollLine, label, isReroll, flavour, total, critType }));
}


// ─────────────────────────────────────────────
//  CHARACTER SHEET EXPORT
// ─────────────────────────────────────────────

const ORDER_PALETTE = {
  'White Knight':  { bg: '#f5f0e8', accent: '#c0c0c0', text: '#2a2a2a', border: '#a0a0a0', crest: '⚪' },
  'Black Knight':  { bg: '#1a1a1a', accent: '#4a4a4a', text: '#e8e8e8', border: '#666666', crest: '⚫' },
  'Gold Knight':   { bg: '#fdf3d0', accent: '#c8971a', text: '#2a1a00', border: '#c8971a', crest: '🟡' },
  'Grey Knight':   { bg: '#e8e8e8', accent: '#7a8a9a', text: '#2a2a2a', border: '#7a8a9a', crest: '🩶' },
  'Blue Knight':   { bg: '#e8f0f8', accent: '#1a5fa8', text: '#0a1a2a', border: '#1a5fa8', crest: '🔵' },
  'Purple Knight': { bg: '#f0e8f8', accent: '#6a1a9a', text: '#1a0a2a', border: '#6a1a9a', crest: '🟣' },
  'Green Knight':  { bg: '#e8f5e8', accent: '#1a7a3a', text: '#0a1a0a', border: '#1a7a3a', crest: '🟢' },
  'Red Knight':    { bg: '#f8e8e8', accent: '#9a1a1a', text: '#2a0a0a', border: '#9a1a1a', crest: '🔴' },
};
const DEFAULT_PALETTE = { bg: '#f5f0e8', accent: '#8b7355', text: '#2a2a2a', border: '#8b7355', crest: '⚔️' };


async function generateCharImage(char, displayName, healCharges, maxCharges) {
  let createCanvas, loadImage;
  try {
    ({ createCanvas } = require('@napi-rs/canvas'));
  } catch {
    return null; // canvas not available
  }

  const pal = ORDER_PALETTE[char.order_name] || DEFAULT_PALETTE;
  const W = 420, H = 620;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = pal.bg;
  ctx.fillRect(0, 0, W, H);

  // Parchment texture overlay (subtle noise via gradient bands)
  for (let i = 0; i < H; i += 3) {
    const alpha = (Math.random() * 0.03).toFixed(3);
    ctx.fillStyle = `rgba(0,0,0,${alpha})`;
    ctx.fillRect(0, i, W, 1);
  }

  // ── Outer border ────────────────────────────────────────────────────────────
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, W - 20, H - 20);

  // Inner border
  ctx.lineWidth = 1.5;
  ctx.strokeRect(16, 16, W - 32, H - 32);

  // ── Corner ornaments ────────────────────────────────────────────────────────
  const corners = [[22,22],[W-22,22],[22,H-22],[W-22,H-22]];
  ctx.fillStyle = pal.accent;
  corners.forEach(([x,y]) => {
    ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill();
  });

  // ── Crest / Order symbol ─────────────────────────────────────────────────────
  ctx.font = '52px serif';
  ctx.textAlign = 'center';
  ctx.fillText(pal.crest, W/2, 90);

  // ── Player name ──────────────────────────────────────────────────────────────
  ctx.fillStyle = pal.text;
  ctx.font = 'bold 26px serif';
  ctx.textAlign = 'center';
  ctx.fillText(displayName, W/2, 125);

  // ── Order name ───────────────────────────────────────────────────────────────
  ctx.fillStyle = pal.accent;
  ctx.font = 'italic 16px serif';
  ctx.fillText(char.order_name || 'No Order', W/2, 148);

  // ── Divider ──────────────────────────────────────────────────────────────────
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(30, 162); ctx.lineTo(W-30, 162); ctx.stroke();

  // ── Tracker rows ─────────────────────────────────────────────────────────────
  const trackers = [
    { label: '❤️  HP', value: `${char.hp_current} / ${maxHp(char)}` },
    { label: '🔄  Rerolls', value: `${char.rerolls_current} / ${maxRerolls(char)}` },
  ];
  if (isWhiteKnight(char)) trackers.push({ label: '🛡️  Heal', value: `${healCharges} / ${maxCharges}` });

  let y = 195;
  trackers.forEach(({ label, value }) => {
    ctx.fillStyle = pal.text;
    ctx.font = '16px serif';
    ctx.textAlign = 'left'; ctx.fillText(label, 40, y);
    ctx.font = 'bold 16px serif';
    ctx.textAlign = 'right'; ctx.fillText(value, W-40, y);
    y += 30;
  });

  // ── Divider ──────────────────────────────────────────────────────────────────
  y += 8;
  ctx.strokeStyle = pal.border; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(30, y); ctx.lineTo(W-30, y); ctx.stroke();
  y += 20;

  // ── Stat rows ────────────────────────────────────────────────────────────────
  const stats = [
    { label: '💪  STR', value: char.str },
    { label: '🫀  CON', value: char.con },
    { label: '⚡  DEX', value: char.dex },
    { label: '🧠  WIS', value: char.wis },
    { label: '🍀  LCK', value: char.lck },
  ];
  stats.forEach(({ label, value }) => {
    ctx.fillStyle = pal.text;
    ctx.font = '16px serif';
    ctx.textAlign = 'left'; ctx.fillText(label, 40, y);
    ctx.font = 'bold 20px serif';
    ctx.fillStyle = pal.accent;
    ctx.textAlign = 'right'; ctx.fillText(String(value), W-40, y);
    y += 32;
  });

  // ── Footer ───────────────────────────────────────────────────────────────────
  ctx.strokeStyle = pal.border; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(30, H-35); ctx.lineTo(W-30, H-35); ctx.stroke();
  ctx.fillStyle = pal.accent;
  ctx.font = 'italic 11px serif';
  ctx.textAlign = 'center';
  ctx.fillText('Knight Order Registry', W/2, H-18);

  return canvas.toBuffer('image/png');
}

async function handleCharExport(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const mode = interaction.options.getString('format') || 'text';
  const tu = interaction.options.getUser('user') || interaction.user;
  const tid = tu.id;
  const char = getChar(gid, tid);
  if (!char) return interaction.reply({ content: '❌ No character found. Use `/char set` to get started.', ephemeral: true });

  const dn = await getDisplayName(interaction.guild, tid);
  const cfg = getConfig(gid); const mc = cfg.heal_charges ?? 3;
  const hr = getHealCharges(gid, tid, mc);
  const kn = char.order_name ? `${KNIGHT_EMOJIS[char.order_name]??'⚪'}  ${char.order_name}` : 'No order set';
  const hm = maxHp(char), rm = maxRerolls(char);

  // ── Text export ──────────────────────────────────────────────────────────────
  const textLines = [
    '```',
    '[TTRPG SHEET]',
    `NAME:${dn}`,
    `ORDER:${char.order_name || ''}`,
    `STR:${char.str}`,
    `CON:${char.con}`,
    `DEX:${char.dex}`,
    `WIS:${char.wis}`,
    `LCK:${char.lck}`,
    `HP:${char.hp_current}`,
    `REROLLS:${char.rerolls_current}`,
    '',
    `  ${dn}`,
    `  ${char.order_name || 'No Order'}`,
    '',
    `  HP       ${char.hp_current} / ${hm}`,
    `  Rerolls  ${char.rerolls_current} / ${rm}`,
  ];
  if (isWhiteKnight(char)) textLines.push(`  Heal     ${hr.current} / ${mc}`);
  textLines.push('', `  STR  ${char.str}`, `  CON  ${char.con}`, `  DEX  ${char.dex}`, `  WIS  ${char.wis}`, `  LCK  ${char.lck}`, '```');
  const textContent = textLines.join('\n');

  if (mode === 'text') {
    return interaction.reply({ content: textContent });
  }

  // ── Image export ─────────────────────────────────────────────────────────────
  await interaction.deferReply();
  const imgBuffer = await generateCharImage(char, dn, hr.current, mc);
  if (!imgBuffer) {
    return interaction.editReply({ content: textContent + '\n*Image generation unavailable — install `@napi-rs/canvas` to enable.*' });
  }

  const { AttachmentBuilder } = require('discord.js');
  const attachment = new AttachmentBuilder(imgBuffer, { name: `${dn.replace(/\s+/g,'-')}-sheet.png` });
  return interaction.editReply({ content: textContent, files: [attachment] });
}

// ─────────────────────────────────────────────
//  SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────

const KNIGHTS = ['White Knight','Black Knight','Gold Knight','Grey Knight','Blue Knight','Purple Knight','Green Knight','Red Knight'];

const slashCommands = [
  new SlashCommandBuilder()
    .setName('config').setDescription('Server configuration (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('gmrole').setDescription('Set the GM role').addRoleOption(o=>o.setName('role').setDescription('The GM role').setRequired(true)))
    .addSubcommand(s=>s.setName('heal').setDescription('Set max Heal charges for White Knights').addIntegerOption(o=>o.setName('charges').setDescription('Number of charges').setRequired(true).setMinValue(1).setMaxValue(10))),

  new SlashCommandBuilder()
    .setName('char').setDescription('Character setup and display')
    .addSubcommand(s=>s.setName('set').setDescription('Set a character stat or field')
      .addStringOption(o=>o.setName('field').setDescription('Field to set').setRequired(true)
        .addChoices({name:'Order',value:'order'},{name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},{name:'WIS',value:'wis'},{name:'LCK',value:'lck'}))
      .addStringOption(o=>o.setName('value').setDescription('Value to set').setRequired(true))
      .addUserOption(o=>o.setName('user').setDescription('Target user (GM only)').setRequired(false)))
    .addSubcommand(s=>s.setName('show').setDescription('Display a character card').addUserOption(o=>o.setName('user').setDescription('User to show').setRequired(false)))
    .addSubcommand(s=>s.setName('export').setDescription('Export your character sheet')
      .addStringOption(o=>o.setName('format').setDescription('Export format').setRequired(false)
        .addChoices({name:'Text',value:'text'},{name:'Image',value:'image'}))
      .addUserOption(o=>o.setName('user').setDescription('User to export').setRequired(false))),

  new SlashCommandBuilder()
    .setName('profile').setDescription('Manage your roll card profile')
    .addSubcommand(s=>s.setName('on').setDescription('Enable profile embed, max HP and rerolls'))
    .addSubcommand(s=>s.setName('off').setDescription('Disable profile embed'))
    .addSubcommand(s=>s.setName('show').setDescription('Preview your profile without rolling'))
    .addSubcommand(s=>s.setName('save').setDescription('Snapshot current tracker state').addStringOption(o=>o.setName('slotname').setDescription('Name for this save').setRequired(true)))
    .addSubcommand(s=>s.setName('load').setDescription('Restore a saved snapshot').addStringOption(o=>o.setName('slotname').setDescription('Name of the save to load').setRequired(true)))
    .addSubcommand(s=>s.setName('saves').setDescription('List all your saved snapshots')),

  new SlashCommandBuilder()
    .setName('tag').setDescription('Manage player tags (GM only)')
    .addSubcommand(s=>s.setName('assign').setDescription('Assign a tag to a player')
      .addUserOption(o=>o.setName('user').setDescription('Target player').setRequired(true))
      .addStringOption(o=>o.setName('tag').setDescription('Tag name').setRequired(true)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove a tag from a player')
      .addUserOption(o=>o.setName('user').setDescription('Target player').setRequired(true))
      .addStringOption(o=>o.setName('tag').setDescription('Tag name').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List tags for a player')
      .addUserOption(o=>o.setName('user').setDescription('Target player').setRequired(false)))
    .addSubcommand(s=>s.setName('custom').setDescription('Manage custom tags')
      .addStringOption(o=>o.setName('action').setDescription('Action').setRequired(true)
        .addChoices({name:'Create',value:'create'},{name:'Delete',value:'delete'},{name:'List',value:'list'}))
      .addStringOption(o=>o.setName('emoji').setDescription('Emoji for the tag (create only)').setRequired(false))
      .addStringOption(o=>o.setName('name').setDescription('Tag name (create/delete)').setRequired(false))),

  new SlashCommandBuilder()
    .setName('p').setDescription('Shorthand for /profile')
    .addSubcommand(s=>s.setName('on').setDescription('Enable profile embed, max HP and rerolls'))
    .addSubcommand(s=>s.setName('off').setDescription('Disable profile embed'))
    .addSubcommand(s=>s.setName('show').setDescription('Preview your profile without rolling'))
    .addSubcommand(s=>s.setName('save').setDescription('Snapshot current tracker state').addStringOption(o=>o.setName('slotname').setDescription('Name for this save').setRequired(true)))
    .addSubcommand(s=>s.setName('load').setDescription('Restore a saved snapshot').addStringOption(o=>o.setName('slotname').setDescription('Name of the save to load').setRequired(true)))
    .addSubcommand(s=>s.setName('saves').setDescription('List all your saved snapshots')),
];

// ─────────────────────────────────────────────
//  SLASH HANDLERS
// ─────────────────────────────────────────────

async function handleConfig(interaction) {
  const sub = interaction.options.getSubcommand(), gid = interaction.guild.id;
  if (sub === 'gmrole') {
    const role = interaction.options.getRole('role');
    setConfig(gid, { gm_role_id: role.id });
    return interaction.reply({ content: `✅ GM role set to **${role.name}**.`, ephemeral: true });
  }
  if (sub === 'heal') {
    const charges = interaction.options.getInteger('charges');
    setConfig(gid, { heal_charges: charges });
    return interaction.reply({ content: `✅ White Knight Heal charges set to **${charges}**.`, ephemeral: true });
  }
}

async function handleChar(interaction) {
  const sub = interaction.options.getSubcommand(), gid = interaction.guild.id, callerId = interaction.user.id;
  if (sub === 'set') {
    const field = interaction.options.getString('field');
    const value = interaction.options.getString('value');
    const targetUser = interaction.options.getUser('user');
    const targetId = targetUser ? targetUser.id : callerId;
    if (targetId !== callerId && !(await isGm(interaction.guild, callerId)))
      return interaction.reply({ content: '❌ Only GMs can modify other players\' stats.', ephemeral: true });
    if (field === 'order') {
      const knight = KNIGHTS.find(k=>k.toLowerCase()===value.toLowerCase());
      if (!knight) return interaction.reply({ content: `❌ Choose from: ${KNIGHTS.join(', ')}`, ephemeral: true });
      upsertChar(gid, targetId, { order_name: knight });
      const upd = getChar(gid, targetId);
      if (!isWhiteKnight(upd)) setHealCharges(gid, targetId, 0);
      else { const cfg = getConfig(gid); setHealCharges(gid, targetId, cfg.heal_charges??3); }
      return interaction.reply({ content: `${KNIGHT_EMOJIS[knight]??'⚪'} Order set to **${knight}**${targetId!==callerId?` for <@${targetId}>`:''}.` });
    }
    if (STATS.includes(field)) {
      const num = parseInt(value);
      if (isNaN(num)||num<0) return interaction.reply({ content: '❌ Value must be a positive number.', ephemeral: true });
      const upd = setStatAndDerive(gid, targetId, field, num);
      if (field==='wis') {
        if (isWhiteKnight(upd)) { const cfg=getConfig(gid); setHealCharges(gid,targetId,cfg.heal_charges??3); }
        else setHealCharges(gid,targetId,0);
      }
      let extra = '';
      if (field==='con') extra=` HP maxed to **${upd.hp_current} / ${maxHp(upd)}**`;
      if (field==='lck') extra=` Rerolls maxed to **${upd.rerolls_current} / ${maxRerolls(upd)}**`;
      return interaction.reply({ content: `✅ ${field.toUpperCase()} set to **${num}**${targetId!==callerId?` for <@${targetId}>`:''}.${extra}` });
    }
  }
  if (sub === 'export') return handleCharExport(interaction);
  if (sub === 'show') {
    const tu = interaction.options.getUser('user') || interaction.user, tid = tu.id;
    const char = getChar(gid, tid);
    if (!char) return interaction.reply({ content: '❌ No character found. Use `/char set` to get started.', ephemeral: true });
    const dn = await getDisplayName(interaction.guild, tid);
    const cfg = getConfig(gid); const mc = cfg.heal_charges??3;
    const hr = getHealCharges(gid, tid, mc);
    const kn = char.order_name ? `${KNIGHT_EMOJIS[char.order_name]??'⚪'}  ${char.order_name}` : 'No order set';
    const lines = [`⚔️  **${dn}**`, kn, `❤️  HP          ${char.hp_current} / ${maxHp(char)}`, `🔄  Rerolls      ${char.rerolls_current} / ${maxRerolls(char)}`];
    if (isWhiteKnight(char)) lines.push(`🛡️  Heal         ${hr.current} / ${mc}`);
    lines.push('', `💪  STR         ${char.str}`, `🫀  CON         ${char.con}`, `⚡  DEX         ${char.dex}`, `🧠  WIS         ${char.wis}`, `🍀  LCK         ${char.lck}`);
    return interaction.reply({ content: lines.join('\n') });
  }
}

async function handleProfile(interaction) {
  const sub = interaction.options.getSubcommand(), gid = interaction.guild.id, uid = interaction.user.id;
  if (sub === 'on') {
    let ch = getChar(gid, uid);
    if (!ch) { upsertChar(gid, uid, {}); ch = getChar(gid, uid); }
    upsertChar(gid, uid, { profile_enabled:1, hp_current:maxHp(ch), rerolls_current:maxRerolls(ch) });
    if (isWhiteKnight(ch)) { const cfg=getConfig(gid); setHealCharges(gid,uid,cfg.heal_charges??3); }
    return interaction.reply({ content: '✅ Profile enabled. HP and rerolls maxed out.', ephemeral: true });
  }
  if (sub === 'off') {
    upsertChar(gid, uid, { profile_enabled: 0 });
    return interaction.reply({ content: '⏸️ Profile disabled. Rolls will post as plain text.', ephemeral: true });
  }
  if (sub === 'show') {
    const ch = getChar(gid, uid);
    if (!ch) return interaction.reply({ content: '❌ No character set up. Use `/char set` first.', ephemeral: true });
    const dn = await getDisplayName(interaction.guild, uid);
    const cfg = getConfig(gid); const mc = cfg.heal_charges??3;
    const hr = getHealCharges(gid, uid, mc);
    const kn = ch.order_name ? `${KNIGHT_EMOJIS[ch.order_name]??'⚪'}  ${ch.order_name}` : 'No order set';
    const lines = [`⚔️  **${dn}**`, kn, `❤️  HP          ${ch.hp_current} / ${maxHp(ch)}`, `🔄  Rerolls      ${ch.rerolls_current} / ${maxRerolls(ch)}`];
    if (isWhiteKnight(ch)) lines.push(`🛡️  Heal         ${hr.current} / ${mc}`);
    lines.push('', `💪  STR         ${ch.str}`, `🫀  CON         ${ch.con}`, `⚡  DEX         ${ch.dex}`, `🧠  WIS         ${ch.wis}`, `🍀  LCK         ${ch.lck}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }
  if (sub === 'save') {
    const slot = interaction.options.getString('slotname');
    const ch = getChar(gid, uid);
    if (!ch) return interaction.reply({ content: '❌ No character to save.', ephemeral: true });
    const cfg = getConfig(gid);
    const hr = getHealCharges(gid, uid, cfg.heal_charges??3);
    saveProfile(gid, uid, slot, { ...ch, heal_current: hr.current });
    return interaction.reply({ content: `💾 Profile saved as **${slot}**.`, ephemeral: true });
  }
  if (sub === 'load') {
    const slot = interaction.options.getString('slotname');
    const snap = loadProfile(gid, uid, slot);
    if (!snap) return interaction.reply({ content: `❌ No save found with name **${slot}**.`, ephemeral: true });
    upsertChar(gid, uid, { hp_current:snap.hp_current, rerolls_current:snap.rerolls_current, str:snap.str, con:snap.con, dex:snap.dex, wis:snap.wis, lck:snap.lck, order_name:snap.order_name, profile_enabled:snap.profile_enabled });
    setHealCharges(gid, uid, snap.heal_current??0);
    return interaction.reply({ content: `📂 Profile **${slot}** loaded.`, ephemeral: true });
  }
  if (sub === 'saves') {
    const saves = listProfiles(gid, uid);
    if (!saves.length) return interaction.reply({ content: '❌ No saved profiles found.', ephemeral: true });
    return interaction.reply({ content: `📋 Your saves:\n${saves.map(s=>`• **${s.slot_name}** — ${s.saved_at}`).join('\n')}`, ephemeral: true });
  }
}

// ─────────────────────────────────────────────
//  PREFIX HANDLERS
// ─────────────────────────────────────────────

async function handleRoll(message, rest, mode, isReroll) {
  const gid = message.guild.id, cid = message.channel.id, uid = message.author.id;
  let notation, label, flavour;

  if (isReroll) {
    const last = getLastRoll(gid, cid, uid);
    if (!last) return message.reply('❌ No previous roll found in this channel.');
    const ch = getChar(gid, uid);
    if (!ch || ch.rerolls_current <= 0) return message.reply('❌ No rerolls remaining.');
    notation = last.notation;
    const [rl, ...fp] = rest.split('\n');
    label = rl.trim() || last.label;
    flavour = fp.join('\n').trim() || null;
    upsertChar(gid, uid, { rerolls_current: ch.rerolls_current - 1 });
  } else {
    const ch = getChar(gid, uid);
    const parsed = parseRollInput(rest, ch);
    if (!parsed) return message.reply('❌ Invalid notation. Try `r1d20+5 attack`, `r2d6`, or `r str`.');
    notation = parsed.notation;
    label = parsed.label;
    flavour = parsed.flavour;
  }

  let result;
  if (mode === 'adv') result = rollAdvantage(notation);
  else if (mode === 'dis') result = rollDisadvantage(notation);
  else result = rollNotation(notation);
  if (!result) return message.reply('❌ Could not parse dice notation.');

  saveRoll(gid, cid, uid, notation, label);
  const critType = detectCrit(result, mode);
  const rollLine = buildRollLine(result, mode, critType);
  await sendRollEmbed(message, rollLine, label, false, uid, flavour, result.total, critType);
}

async function handleHeal(message, rest) {
  const gid = message.guild.id, uid = message.author.id;
  const mentionMatch = rest.match(/^<@!?(\d+)>/);
  if (!mentionMatch) return message.reply('❌ You must target a player. Usage: `!heal @user`');
  const targetId = mentionMatch[1];
  if (targetId === uid) return message.reply('❌ You cannot heal yourself.');
  const char = getChar(gid, uid);
  if (!char) return message.reply('❌ No character found. Use `/char set` first.');
  if (!isWhiteKnight(char)) return message.reply('❌ Only White Knights with WIS 5 can use Heal.');
  const targetChar = getChar(gid, targetId);
  if (!targetChar) return message.reply('❌ Target has no character set up.');
  const cfg = getConfig(gid); const mc = cfg.heal_charges??3;
  const hr = getHealCharges(gid, uid, mc);
  if (hr.current <= 0) return message.reply('❌ No Heal charges remaining.');
  const result = rollNotation(`1d20+${char.wis}`);
  const nat = result.rolls[0], total = result.total;
  const tn = await getDisplayName(message.guild, targetId);
  let healAmount = 0, chargesUsed = 0, resultText = '';
  if (nat === 20) { healAmount=2; chargesUsed=0; resultText=`*Natural 20! 2 HP restored to ${tn}. No charge consumed.*`; }
  else if (total >= 20) { healAmount=2; chargesUsed=1; resultText=`*2 HP restored to ${tn}. 1 charge consumed.*`; }
  else if (nat === 1) { chargesUsed=Math.min(2,hr.current); resultText=`*Natural 1! No heal. ${chargesUsed} charges consumed.*`; }
  else { chargesUsed=1; resultText=`*No heal. 1 charge consumed.*`; }
  const newTHp = Math.min(targetChar.hp_current + healAmount, maxHp(targetChar));
  const newCharges = Math.max(0, hr.current - chargesUsed);
  upsertChar(gid, targetId, { hp_current: newTHp });
  setHealCharges(gid, uid, newCharges);
  const upd = getChar(gid, uid);
  const dn = await getDisplayName(message.guild, uid);
  const modStr = char.wis > 0 ? ` +${char.wis}` : '';
  const rollLine = `🎲  1d20+${char.wis} → [${nat}]${modStr} = **${total}**`;
  let content;
  if (char.profile_enabled === 1) {
    content = buildRollEmbed({ rollLine, label:'heal', isReroll:false, char:{...upd,displayName:dn}, healCharges:newCharges, maxCharges:mc, flavour:null, total, critType:null });
    content += `\n${resultText}`;
  } else {
    content = `**heal**\n${rollLine}\n${resultText}`;
  }
  await message.reply(content);
}

async function handleHp(message, rest) {
  const gid = message.guild.id, uid = message.author.id;
  const mm  = rest.match(/^<@!?(\d+)>\s*([+-]\d+)$/);
  const mm2 = rest.match(/^([+-]\d+)\s*<@!?(\d+)>$/);
  const sm  = rest.match(/^([+-]\d+)$/);
  let targetId, amount;
  if (mm) {
    if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can modify other players\' HP.');
    targetId=mm[1]; amount=parseInt(mm[2]);
  } else if (mm2) {
    if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can modify other players\' HP.');
    targetId=mm2[2]; amount=parseInt(mm2[1]);
  } else if (sm) { targetId=uid; amount=parseInt(sm[1]); }
  else return message.reply('❌ Usage: `!hp +5` or `!hp @user -3`');
  const ch = getChar(gid, targetId);
  if (!ch) return message.reply('❌ No character found for that user.');
  const hm = maxHp(ch);
  const newHp = Math.max(0, Math.min(ch.hp_current + amount, hm));
  upsertChar(gid, targetId, { hp_current: newHp });
  const dir = amount > 0 ? '💚 Healed' : '🩸 Damaged';
  await message.reply(`${dir} ${Math.abs(amount)} HP — ${targetId===uid?'Your':`<@${targetId}>'s`} HP: **${newHp} / ${hm}**`);
}

async function handleRerolls(message, rest) {
  const gid = message.guild.id, uid = message.author.id;
  const mm  = rest.match(/^<@!?(\d+)>\s*([+-]\d+)$/);
  const mm2 = rest.match(/^([+-]\d+)\s*<@!?(\d+)>$/);
  const sm  = rest.match(/^([+-]\d+)$/);
  let targetId, amount;
  if (mm) {
    if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can modify other players\' rerolls.');
    targetId=mm[1]; amount=parseInt(mm[2]);
  } else if (mm2) {
    if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can modify other players\' rerolls.');
    targetId=mm2[2]; amount=parseInt(mm2[1]);
  } else if (sm) { targetId=uid; amount=parseInt(sm[1]); }
  else return message.reply('❌ Usage: `!rerolls +1` or `!rerolls @user -1`');
  const ch = getChar(gid, targetId);
  if (!ch) return message.reply('❌ No character found for that user.');
  const rm = maxRerolls(ch);
  const newR = Math.max(0, Math.min(ch.rerolls_current + amount, rm));
  upsertChar(gid, targetId, { rerolls_current: newR });
  await message.reply(`🔄 ${targetId===uid?'Your':`<@${targetId}>'s`} Rerolls: **${newR} / ${rm}**`);
}

async function handleRest(message, rest, type) {
  const gid = message.guild.id, uid = message.author.id;
  const mm = rest.match(/^<@!?(\d+)>/);
  let targetId = uid;
  if (mm) {
    if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can apply rests to other players.');
    targetId = mm[1];
  }
  const ch = getChar(gid, targetId);
  if (!ch) return message.reply('❌ No character found.');
  const cfg = getConfig(gid); const mc = cfg.heal_charges??3;
  const hm = maxHp(ch), rm = maxRerolls(ch);
  const tn = targetId === uid ? 'Your' : `<@${targetId}>'s`;
  let newHp, newR, newHeal, label;
  if (type==='lrest') { newHp=hm; newR=rm; newHeal=mc; label='🌙 Long Rest'; }
  else if (type==='srest') { newHp=Math.floor(hm/2); newR=Math.floor(rm/2); newHeal=Math.floor(mc/2); label='☀️ Short Rest'; }
  else if (type==='hpfull') { newHp=hm; newR=ch.rerolls_current; newHeal=null; label='❤️ HP Restored'; }
  else if (type==='hphalf') { newHp=Math.floor(hm/2); newR=ch.rerolls_current; newHeal=null; label='❤️ HP Half Restored'; }
  upsertChar(gid, targetId, { hp_current:newHp, rerolls_current:newR });
  if (newHeal !== null && isWhiteKnight(ch)) setHealCharges(gid, targetId, newHeal);
  const lines = [`${label} applied to ${tn} character.`, `❤️ HP: **${newHp} / ${hm}**`, `🔄 Rerolls: **${newR} / ${rm}**`];
  if (newHeal !== null && isWhiteKnight(ch)) lines.push(`🛡️ Heal: **${newHeal} / ${mc}**`);
  await message.reply(lines.join('\n'));
}

async function handleGmRoll(message, rest, secret) {
  const gid = message.guild.id, uid = message.author.id;
  if (!(await isGm(message.guild, uid))) return message.reply('❌ Only GMs can use GM rolls.');
  const parsed = parseRollInput(rest, null);
  if (!parsed) return message.reply('❌ Invalid notation. Try `gmr 1d20+5 perception`.');
  const result = rollNotation(parsed.notation);
  if (!result) return message.reply('❌ Could not parse dice notation.');
  const critType = detectCrit(result, 'normal');
  const rollLine = buildRollLine(result, 'normal', critType);
  const lc = critPrefix(critType);
  const lines = [];
  if (parsed.label) lines.push(`${lc}**${parsed.label}**`);
  lines.push(rollLine);
  if (parsed.flavour) {
    lines.push('', '─────────────────────────────');
    lines.push(`**${parsed.label??'roll'}** — ${totalStr(result.total, critType)}`);
    lines.push(`*${parsed.flavour}*`);
  }
  const content = lines.join('\n');
  if (secret) {
    try {
      await message.author.send(`🔒 **Secret GM Roll**\n${content}`);
      await message.reply('🔒 Roll sent to your DMs.');
    } catch { await message.reply('❌ Could not DM you. Check your privacy settings.'); }
  } else {
    await message.reply(content);
  }
}


function parseSheetImport(text) {
  // Strip code block markers
  const clean = text.replace(/```/g, '').trim();
  if (!clean.includes('[TTRPG SHEET]')) return null;

  const lines = clean.split('\n');
  const data = {};
  lines.forEach(line => {
    const [key, ...rest] = line.split(':');
    if (key && rest.length) data[key.trim()] = rest.join(':').trim();
  });

  // Validate required fields
  const required = ['STR','CON','DEX','WIS','LCK'];
  for (const f of required) {
    if (data[f] === undefined || isNaN(parseInt(data[f]))) return null;
  }

  return {
    order_name: data['ORDER'] || null,
    str: parseInt(data['STR']),
    con: parseInt(data['CON']),
    dex: parseInt(data['DEX']),
    wis: parseInt(data['WIS']),
    lck: parseInt(data['LCK']),
    hp_current: data['HP'] ? parseInt(data['HP']) : null,
    rerolls_current: data['REROLLS'] ? parseInt(data['REROLLS']) : null,
  };
}

async function handleSheetImport(message, parsed) {
  const gid = message.guild.id, uid = message.author.id;

  // Check if GM is importing for someone else via mention
  const mentionMatch = message.content.match(/<@!?(\d+)>/);
  let targetId = uid;
  if (mentionMatch && mentionMatch[1] !== uid) {
    if (!(await isGm(message.guild, uid))) return message.reply('\u274c Only GMs can import sheets for other players.');
    targetId = mentionMatch[1];
  }

  const KNIGHTS = ['White Knight','Black Knight','Gold Knight','Grey Knight','Blue Knight','Purple Knight','Green Knight','Red Knight'];

  // Validate order
  if (parsed.order_name && !KNIGHTS.includes(parsed.order_name)) {
    parsed.order_name = null;
  }

  // Apply stats — derive HP max and reroll max from CON and LCK
  const hpMax = parsed.con + 2;
  const rerollMax = parsed.lck;

  // Use imported current values if valid, otherwise max out
  const hpCurrent = (parsed.hp_current !== null && parsed.hp_current <= hpMax) ? parsed.hp_current : hpMax;
  const rerollsCurrent = (parsed.rerolls_current !== null && parsed.rerolls_current <= rerollMax) ? parsed.rerolls_current : rerollMax;

  upsertChar(gid, targetId, {
    order_name: parsed.order_name,
    str: parsed.str, con: parsed.con, dex: parsed.dex,
    wis: parsed.wis, lck: parsed.lck,
    hp_current: hpCurrent,
    rerolls_current: rerollsCurrent,
  });

  // Handle heal charges for White Knight
  const updatedChar = getChar(gid, targetId);
  if (isWhiteKnight(updatedChar)) {
    const cfg = getConfig(gid);
    setHealCharges(gid, targetId, cfg.heal_charges ?? 3);
  } else {
    setHealCharges(gid, targetId, 0);
  }

  const targetName = targetId === uid ? 'Your' : `<@${targetId}>'s`;
  const orderLine = parsed.order_name ? `${KNIGHT_EMOJIS[parsed.order_name]??'⚪'} ${parsed.order_name}` : 'No order';
  const lines = [
    `\u2705 ${targetName} character sheet imported.`,
    orderLine,
    `\u2764\ufe0f HP: **${hpCurrent} / ${hpMax}**`,
    `\U0001f504 Rerolls: **${rerollsCurrent} / ${rerollMax}**`,
    '',
    `\U0001f4aa STR ${parsed.str}  \U0001fac0 CON ${parsed.con}  \u26a1 DEX ${parsed.dex}  \U0001f9e0 WIS ${parsed.wis}  \U0001f340 LCK ${parsed.lck}`,
  ];
  await message.reply(lines.join('\n'));
}

async function handleTag(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  // All tag commands are GM only
  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can manage tags.', ephemeral: true });

  if (sub === 'assign') {
    const targetUser = interaction.options.getUser('user');
    const tagName = interaction.options.getString('tag');
    const available = getAllAvailableTags(gid);
    if (!available.includes(tagName))
      return interaction.reply({ content: `❌ Unknown tag. Available: ${available.join(', ')}`, ephemeral: true });
    assignTag(gid, targetUser.id, tagName);
    const emoji = resolveTagEmoji(gid, tagName);
    return interaction.reply({ content: `${emoji} **${tagName}** assigned to <@${targetUser.id}>.` });
  }

  if (sub === 'remove') {
    const targetUser = interaction.options.getUser('user');
    const tagName = interaction.options.getString('tag');
    removeTag(gid, targetUser.id, tagName);
    return interaction.reply({ content: `✅ **${tagName}** removed from <@${targetUser.id}>.` });
  }

  if (sub === 'list') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const tags = getPlayerTags(gid, targetUser.id);
    if (!tags.length) return interaction.reply({ content: `<@${targetUser.id}> has no tags assigned.`, ephemeral: true });
    const lines = tags.map(t => `${resolveTagEmoji(gid, t)}  ${t}`);
    return interaction.reply({ content: `**Tags for <@${targetUser.id}>:**\n${lines.join('\n')}`, ephemeral: true });
  }

  if (sub === 'custom') {
    const action = interaction.options.getString('action');

    if (action === 'create') {
      const emoji = interaction.options.getString('emoji');
      const name = interaction.options.getString('name');
      if (!emoji || !name) return interaction.reply({ content: '❌ Please provide both an emoji and a name.', ephemeral: true });

      // Validate emoji format
      const isUnicodeEmoji = /^\p{Emoji}/u.test(emoji);
      const isCustomEmoji = /^<a?:[a-zA-Z0-9_]+:\d+>$/.test(emoji);
      const looksLikeName = /^:[a-zA-Z0-9_]+:$/.test(emoji);

      if (looksLikeName) {
        return interaction.reply({
          content: `❌ **${emoji}** looks like an emoji name, not the emoji itself.\n\nTo get the correct format:\n1. Type \`\\${emoji}\` in any channel and send it\n2. Discord will show the full ID like \`<:name:123456789>\`\n3. Copy that and use it as the emoji`,
          ephemeral: true
        });
      }

      if (!isUnicodeEmoji && !isCustomEmoji) {
        return interaction.reply({
          content: `❌ Invalid emoji format. Use either:\n• A standard emoji: \`⚔️\`\n• A server emoji ID: \`<:emojiname:123456789012345678>\`\n\nTo get a server emoji ID, type \`\\:emojiname:\` in chat and copy the result.`,
          ephemeral: true
        });
      }

      addCustomTag(gid, name, emoji);
      return interaction.reply({ content: `${emoji} Custom tag **${name}** created.` });
    }

    if (action === 'delete') {
      const name = interaction.options.getString('name');
      if (!name) return interaction.reply({ content: '❌ Please provide the tag name to delete.', ephemeral: true });
      deleteCustomTag(gid, name);
      return interaction.reply({ content: `✅ Custom tag **${name}** deleted and removed from all players.` });
    }

    if (action === 'list') {
      const customs = getCustomTags(gid);
      const presets = Object.entries(PRESET_TAGS).map(([n,e]) => `${e}  ${n} *(preset)*`);
      const customLines = customs.map(t => `${t.emoji}  ${t.tag_name}`);
      const all = [...presets, ...customLines];
      if (!all.length) return interaction.reply({ content: 'No tags defined for this server.', ephemeral: true });
      return interaction.reply({ content: `**Available Tags:**\n${all.join('\n')}`, ephemeral: true });
    }
  }
}

// ─────────────────────────────────────────────
//  BOT CLIENT
// ─────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
});

client.on('ready', () => console.log(`✅ Bot online as ${client.user.tag}`));

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'config') return handleConfig(interaction);
    if (interaction.commandName === 'char') return handleChar(interaction);
    if (interaction.commandName === 'profile' || interaction.commandName === 'p') return handleProfile(interaction);
    if (interaction.commandName === 'tag') return handleTag(interaction);
  } catch (err) {
    console.error(err);
    if (!interaction.replied) interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // Sheet import detection — check before prefix matching
  if (content.includes('[TTRPG SHEET]')) {
    const parsed = parseSheetImport(content);
    if (parsed) {
      try { return await handleSheetImport(message, parsed); }
      catch (err) { console.error(err); return message.reply('\u274c Failed to import sheet.'); }
    }
  }

  const match = content.match(/^(!?)(gmrs?|lrest|srest|hpfull|hphalf|rerolls|roll|rra|rrd|rr|ra|rd|r|heal|hp|h)([\s\S]*)/i);
  if (!match) return;
  const raw = (match[1] + match[2]).toLowerCase().replace(/^!/, '');
  // Preserve newlines for flavour text — only trim leading spaces on first line
  const rest = (match[3] ?? '').replace(/^[ \t]+/, '');
  try {
    if (raw==='r'||raw==='roll') return handleRoll(message, rest, 'normal', false);
    if (raw==='ra') return handleRoll(message, rest, 'adv', false);
    if (raw==='rd') return handleRoll(message, rest, 'dis', false);
    if (raw==='rr') return handleRoll(message, rest, 'normal', true);
    if (raw==='rra') return handleRoll(message, rest, 'adv', true);
    if (raw==='rrd') return handleRoll(message, rest, 'dis', true);
    if (raw==='heal'||raw==='h') return handleHeal(message, rest);
    if (raw==='hp') return handleHp(message, rest);
    if (raw==='rerolls') return handleRerolls(message, rest);
    if (raw==='lrest') return handleRest(message, rest, 'lrest');
    if (raw==='srest') return handleRest(message, rest, 'srest');
    if (raw==='hpfull') return handleRest(message, rest, 'hpfull');
    if (raw==='hphalf') return handleRest(message, rest, 'hphalf');
    if (raw==='gmr') return handleGmRoll(message, rest, false);
    if (raw==='gmrs') return handleGmRoll(message, rest, true);
    // Bare dice notation fallback e.g. 1d20+5
    const bareMatch = content.match(/^(\d+d\d+(?:[+-]\d+)?)([ \t].*)?(\n[\s\S]*)?$/i);
    if (bareMatch) {
      const sameLineRest = (bareMatch[2] ?? '').trim();
      const flavourRest = bareMatch[3] ?? '';
      const bareRest = bareMatch[1] + (sameLineRest ? ' ' + sameLineRest : '') + flavourRest;
      return handleRoll(message, bareRest, 'normal', false);
    }
  } catch (err) {
    console.error(err);
    message.reply('❌ Something went wrong.');
  }
});

// ─────────────────────────────────────────────
//  REGISTER SLASH COMMANDS + LOGIN
// ─────────────────────────────────────────────

(async () => {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: slashCommands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered.');
  } catch (err) { console.error('Failed to register slash commands:', err); }
  client.login(process.env.DISCORD_TOKEN);
})();