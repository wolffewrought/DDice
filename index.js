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

// ── Schema migrations ─────────────────────────────────────────────────────────
try { db.exec('ALTER TABLE guild_config ADD COLUMN npc_channel_id TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN backup_channel_id TEXT DEFAULT NULL'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN heal_charges INTEGER DEFAULT 3'); } catch {}
// Rest restore amounts. Stored as text tokens so GMs can use either form:
//   "100%" = percentage of that resource's max   |   "3" = flat, set the value to exactly 3
// Defaults: Long rest = full (100%). Short rest = HP only (50%), no rerolls/heal.
try { db.exec("ALTER TABLE guild_config ADD COLUMN lrest_hp TEXT DEFAULT '100%'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN lrest_rerolls TEXT DEFAULT '100%'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN lrest_heal TEXT DEFAULT '100%'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN srest_hp TEXT DEFAULT '50%'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN srest_rerolls TEXT DEFAULT '0%'"); } catch {}
try { db.exec("ALTER TABLE guild_config ADD COLUMN srest_heal TEXT DEFAULT '0%'"); } catch {}
try { db.exec("ALTER TABLE characters ADD COLUMN class TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE characters ADD COLUMN weapon1 TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE characters ADD COLUMN weapon2 TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE characters ADD COLUMN weapon1emoji TEXT DEFAULT '⚔️'"); } catch {}
try { db.exec("ALTER TABLE characters ADD COLUMN weapon2emoji TEXT DEFAULT '🗡️'"); } catch {}
try { db.exec("CREATE TABLE IF NOT EXISTS weapons (guild_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (guild_id, name))"); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN atk_mode TEXT DEFAULT 'normal'"); } catch {}
try { db.exec('ALTER TABLE fights ADD COLUMN atk_sides INTEGER DEFAULT 20'); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN def_mode TEXT DEFAULT 'normal'"); } catch {}
try { db.exec('ALTER TABLE fights ADD COLUMN def_sides INTEGER DEFAULT 20'); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, order_name TEXT DEFAULT NULL,
    class TEXT DEFAULT NULL, weapon1 TEXT DEFAULT NULL, weapon2 TEXT DEFAULT NULL,
    weapon1emoji TEXT DEFAULT '⚔️', weapon2emoji TEXT DEFAULT '🗡️',
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
    guild_id TEXT PRIMARY KEY, gm_role_id TEXT DEFAULT NULL, heal_charges INTEGER DEFAULT 3, npc_channel_id TEXT DEFAULT NULL
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
  CREATE TABLE IF NOT EXISTS weapons (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS npc_categories (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS npc_category_members (
    guild_id TEXT NOT NULL,
    category TEXT NOT NULL,
    npc_name TEXT NOT NULL,
    PRIMARY KEY (guild_id, category, npc_name)
  );
  CREATE TABLE IF NOT EXISTS npcs (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    order_name TEXT DEFAULT NULL,
    str INTEGER DEFAULT 0,
    con INTEGER DEFAULT 0,
    dex INTEGER DEFAULT 0,
    wis INTEGER DEFAULT 0,
    lck INTEGER DEFAULT 0,
    hp_current INTEGER DEFAULT 0,
    image_url TEXT DEFAULT NULL,
    webhook_id TEXT DEFAULT NULL,
    webhook_token TEXT DEFAULT NULL,
    PRIMARY KEY (guild_id, name)
  );
  CREATE TABLE IF NOT EXISTS fights (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'idle',
    turn_order TEXT NOT NULL DEFAULT '[]',
    turn_index INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'attack',
    current_target TEXT DEFAULT NULL,
    atk_roll INTEGER DEFAULT NULL,
    atk_nat INTEGER DEFAULT NULL,
    atk_stat TEXT DEFAULT NULL,
    atk_mode TEXT DEFAULT 'normal',
    atk_sides INTEGER DEFAULT 20,
    def_roll INTEGER DEFAULT NULL,
    def_nat INTEGER DEFAULT NULL,
    def_stat TEXT DEFAULT NULL,
    def_mode TEXT DEFAULT 'normal',
    def_sides INTEGER DEFAULT 20,
    hp_state TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (guild_id, channel_id)
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
// ── NPC helpers ───────────────────────────────────────────────────────────────
function getNpc(gid, name) {
  return db.prepare('SELECT * FROM npcs WHERE guild_id=? AND name=?').get(gid, name);
}
function getAllNpcs(gid) {
  return db.prepare('SELECT * FROM npcs WHERE guild_id=? ORDER BY name').all(gid);
}
function upsertNpc(gid, name, fields) {
  const ex = getNpc(gid, name);
  if (!ex) {
    db.prepare('INSERT INTO npcs (guild_id, name, order_name, str, con, dex, wis, lck, hp_current, image_url, webhook_id, webhook_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(gid, name, fields.order_name??null, fields.str??0, fields.con??0, fields.dex??0, fields.wis??0, fields.lck??0,
        (fields.con??0)+2, fields.image_url??null, fields.webhook_id??null, fields.webhook_token??null);
  } else {
    const sets = Object.entries(fields).map(([k])=>`${k}=?`).join(',');
    db.prepare(`UPDATE npcs SET ${sets} WHERE guild_id=? AND name=?`).run(...Object.values(fields), gid, name);
  }
  return getNpc(gid, name);
}
function deleteNpc(gid, name) {
  db.prepare('DELETE FROM npcs WHERE guild_id=? AND name=?').run(gid, name);
}
function setNpcImage(gid, name, url) {
  db.prepare('UPDATE npcs SET image_url=? WHERE guild_id=? AND name=?').run(url, gid, name);
}
function setNpcWebhook(gid, name, webhookId, webhookToken) {
  db.prepare('UPDATE npcs SET webhook_id=?, webhook_token=? WHERE guild_id=? AND name=?').run(webhookId, webhookToken, gid, name);
}

// Blank silhouette as base64 data URI fallback
const BLANK_AVATAR = 'https://cdn.discordapp.com/embed/avatars/0.png';

// ── Weapon helpers ────────────────────────────────────────────────────────────
function getWeapons(gid) {
  return db.prepare('SELECT name FROM weapons WHERE guild_id=? ORDER BY name').all(gid).map(r=>r.name);
}
function addWeapon(gid, name) {
  db.prepare('INSERT OR IGNORE INTO weapons (guild_id, name) VALUES (?,?)').run(gid, name);
}
function removeWeapon(gid, name) {
  db.prepare('DELETE FROM weapons WHERE guild_id=? AND name=?').run(gid, name);
}

// ── Weapon emoji validation ───────────────────────────────────────────────────
const STANDARD_WEAPON_EMOJIS = ['⚔️', '🗡️', '🏹', '🔱', '⛏️', '🛡️', '🪄'];
// Accept a standard emoji, OR a custom emoji tag (<:name:id> / <a:name:id>) that
// belongs to this guild. Returns the cleaned value to store, or null if invalid.
function validateWeaponEmoji(guild, value) {
  if (!value) return null;
  const v = value.trim();
  if (STANDARD_WEAPON_EMOJIS.includes(v)) return v;
  // Custom emoji tag?
  const m = v.match(/^<(a?):(\w+):(\d+)>$/);
  if (m) {
    const id = m[3];
    // Confirm the emoji exists on this server
    if (guild?.emojis?.cache?.has(id)) return v;
    return null;
  }
  // Allow any single standard unicode emoji the user typed (lenient fallback)
  // Reject long strings / plain text
  if (v.length <= 8 && !/[a-zA-Z0-9]/.test(v)) return v;
  return null;
}

// ── NPC Category helpers ──────────────────────────────────────────────────────
function getCategories(gid) {
  return db.prepare('SELECT name FROM npc_categories WHERE guild_id=? ORDER BY name').all(gid).map(r=>r.name);
}
function createCategory(gid, name) {
  db.prepare('INSERT OR IGNORE INTO npc_categories (guild_id, name) VALUES (?,?)').run(gid, name);
}
function deleteCategory(gid, name) {
  db.prepare('DELETE FROM npc_categories WHERE guild_id=? AND name=?').run(gid, name);
  db.prepare('DELETE FROM npc_category_members WHERE guild_id=? AND category=?').run(gid, name);
}
function assignNpcToCategory(gid, npcName, category) {
  db.prepare('INSERT OR IGNORE INTO npc_category_members (guild_id, category, npc_name) VALUES (?,?,?)').run(gid, category, npcName);
}
function removeNpcFromCategory(gid, npcName, category) {
  db.prepare('DELETE FROM npc_category_members WHERE guild_id=? AND category=? AND npc_name=?').run(gid, category, npcName);
}
function getNpcsInCategory(gid, category) {
  return db.prepare('SELECT npc_name FROM npc_category_members WHERE guild_id=? AND category=? ORDER BY npc_name').all(gid, category).map(r=>r.npc_name);
}
function getCategoriesForNpc(gid, npcName) {
  return db.prepare('SELECT category FROM npc_category_members WHERE guild_id=? AND npc_name=? ORDER BY category').all(gid, npcName).map(r=>r.category);
}
function getUncategorisedNpcs(gid) {
  const all = getAllNpcs(gid).map(n=>n.name);
  const categorised = db.prepare('SELECT DISTINCT npc_name FROM npc_category_members WHERE guild_id=?').all(gid).map(r=>r.npc_name);
  return all.filter(n => !categorised.includes(n));
}

// ── Fight helpers ─────────────────────────────────────────────────────────────
function getFight(gid, cid) {
  return db.prepare('SELECT * FROM fights WHERE guild_id=? AND channel_id=?').get(gid, cid);
}
function upsertFight(gid, cid, fields) {
  const ex = getFight(gid, cid);
  if (!ex) {
    db.prepare('INSERT INTO fights (guild_id, channel_id, state, turn_order, turn_index, phase, current_target, atk_roll, atk_nat, atk_stat, def_roll, def_nat, def_stat, hp_state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(gid, cid, fields.state??'idle', fields.turn_order??'[]', fields.turn_index??0, fields.phase??'attack',
        fields.current_target??null, fields.atk_roll??null, fields.atk_nat??null, fields.atk_stat??null,
        fields.def_roll??null, fields.def_nat??null, fields.def_stat??null, fields.hp_state??'{}');
  } else {
    const sets = Object.entries(fields).map(([k])=>`${k}=?`).join(',');
    db.prepare(`UPDATE fights SET ${sets} WHERE guild_id=? AND channel_id=?`).run(...Object.values(fields), gid, cid);
  }
  return getFight(gid, cid);
}
function deleteFight(gid, cid) {
  db.prepare('DELETE FROM fights WHERE guild_id=? AND channel_id=?').run(gid, cid);
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
  const dice = parseInt(m[1]), sides = parseInt(m[2]);
  // Sane limits to prevent abuse (e.g. r999999d999999)
  if (dice < 1 || dice > 100) return null;
  if (sides < 1 || sides > 1000) return null;
  return { dice, sides, modifier: m[3] ? parseInt(m[3]) : 0 };
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
//  SUCCESS SYSTEM
// ─────────────────────────────────────────────

function getSuccessResult(total, naturalRoll, sides) {
  // Natural max or min override modifiers
  if (naturalRoll === sides) return { label: 'Critical Success', emoji: '🌟', crit: 'crit' };
  if (naturalRoll === 1)     return { label: 'Critical Fail',    emoji: '💀', crit: 'fail' };
  // Final total determines outcome
  if (total >= 15) return { label: 'Success',         emoji: '✅',  crit: null };
  if (total >= 10) return { label: 'Partial Success', emoji: '⚡',  crit: null };
  return            { label: 'Fail',            emoji: '❌',  crit: null };
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

function buildRollLine(result, mode, critType, successResult) {
  const mod = result.modifier;
  const modStr = mod > 0 ? ` +${mod}` : mod < 0 ? ` ${mod}` : '';
  const ts = totalStr(result.total, critType);
  const suffix = successResult ? `  ${successResult.emoji} ${successResult.label}` : '';
  if (mode === 'normal') return `🎲  ${result.notation} → [${result.rolls.join(', ')}]${modStr} = ${ts}${suffix}`;
  const ml = mode === 'adv' ? '(advantage)' : '(disadvantage)';
  return `🎲  ${result.notation} ${ml} → [${result.chosen}, ~~${result.dropped}~~]${modStr} = ${ts}${suffix}`;
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
  if (char.class) lines.push(`🏅  ${char.class}`);
  lines.push(`❤️  HP${pad(char.hp_current)} / ${maxHp(char)}`);
  lines.push(`🔄  Rerolls${pad(char.rerolls_current)} / ${maxRerolls(char)}`);
  if (isWhiteKnight(char)) lines.push(`🛡️  Heal${pad(healCharges)} / ${maxCharges}`);
  lines.push('');
  lines.push(`💪  STR${pad(char.str)}`);
  lines.push(`🫀  CON${pad(char.con)}`);
  lines.push(`⚡  DEX${pad(char.dex)}`);
  lines.push(`🧠  WIS${pad(char.wis)}`);
  lines.push(`🍀  LCK${pad(char.lck)}`);
  if (char.weapon1 || char.weapon2) {
    lines.push('');
    if (char.weapon1) lines.push(`${char.weapon1emoji??'⚔️'}  ${char.weapon1}`);
    if (char.weapon2) lines.push(`${char.weapon2emoji??'🗡️'}  ${char.weapon2}`);
  }
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
  const W = 420;
  // Dynamic height: base + extra for class line + weapon lines
  let H = 620;
  if (char.class) H += 18;
  const weaponCount = (char.weapon1?1:0) + (char.weapon2?1:0);
  if (weaponCount) H += 16 + weaponCount * 26;
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

  // ── Class ────────────────────────────────────────────────────────────────────
  if (char.class) {
    ctx.fillStyle = pal.text;
    ctx.font = '13px serif';
    ctx.fillText(`🏅 ${char.class}`, W/2, 168);
  }

  // ── Divider ──────────────────────────────────────────────────────────────────
  ctx.strokeStyle = pal.border;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(30, char.class ? 180 : 162); ctx.lineTo(W-30, char.class ? 180 : 162); ctx.stroke();

  // ── Tracker rows ─────────────────────────────────────────────────────────────
  const trackers = [
    { label: '❤️  HP', value: `${char.hp_current} / ${maxHp(char)}` },
    { label: '🔄  Rerolls', value: `${char.rerolls_current} / ${maxRerolls(char)}` },
  ];
  if (isWhiteKnight(char)) trackers.push({ label: '🛡️  Heal', value: `${healCharges} / ${maxCharges}` });

  let y = char.class ? 213 : 195;
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

  // ── Weapons ──────────────────────────────────────────────────────────────────
  if (char.weapon1 || char.weapon2) {
    // Canvas can't render Discord custom emojis (<:name:id>) — fall back to a sword glyph
    const imgEmoji = (e, fallback) => (e && /^<a?:\w+:\d+>$/.test(e)) ? fallback : (e || fallback);
    y += 4;
    ctx.strokeStyle = pal.border; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(30, y-12); ctx.lineTo(W-30, y-12); ctx.stroke();
    y += 6;
    if (char.weapon1) {
      ctx.fillStyle = pal.text; ctx.font = '15px serif'; ctx.textAlign = 'left';
      ctx.fillText(`${imgEmoji(char.weapon1emoji, '⚔️')}  ${char.weapon1}`, 40, y); y += 26;
    }
    if (char.weapon2) {
      ctx.fillStyle = pal.text; ctx.font = '15px serif'; ctx.textAlign = 'left';
      ctx.fillText(`${imgEmoji(char.weapon2emoji, '🗡️')}  ${char.weapon2}`, 40, y); y += 26;
    }
  }

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
    `CLASS:${char.class || ''}`,
    `STR:${char.str}`,
    `CON:${char.con}`,
    `DEX:${char.dex}`,
    `WIS:${char.wis}`,
    `LCK:${char.lck}`,
    `HP:${char.hp_current}`,
    `REROLLS:${char.rerolls_current}`,
    `WEAPON1:${char.weapon1 || ''}`,
    `WEAPON1EMOJI:${char.weapon1emoji || '⚔️'}`,
    `WEAPON2:${char.weapon2 || ''}`,
    `WEAPON2EMOJI:${char.weapon2emoji || '🗡️'}`,
    '',
    `  ${dn}`,
    `  ${char.order_name || 'No Order'}`,
  ];
  if (char.class) textLines.push(`  ${char.class}`);
  textLines.push(
    '',
    `  HP       ${char.hp_current} / ${hm}`,
    `  Rerolls  ${char.rerolls_current} / ${rm}`,
  );
  if (isWhiteKnight(char)) textLines.push(`  Heal     ${hr.current} / ${mc}`);
  textLines.push('', `  STR  ${char.str}`, `  CON  ${char.con}`, `  DEX  ${char.dex}`, `  WIS  ${char.wis}`, `  LCK  ${char.lck}`);
  if (char.weapon1 || char.weapon2) {
    textLines.push('');
    if (char.weapon1) textLines.push(`  ${char.weapon1emoji||'⚔️'}  ${char.weapon1}`);
    if (char.weapon2) textLines.push(`  ${char.weapon2emoji||'🗡️'}  ${char.weapon2}`);
  }
  textLines.push('```');
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
    .addSubcommand(s=>s.setName('heal').setDescription('Set max Heal charges for White Knights').addIntegerOption(o=>o.setName('charges').setDescription('Number of charges').setRequired(true).setMinValue(1).setMaxValue(10)))
    .addSubcommand(s=>s.setName('npcchannel').setDescription('Set the NPC image bank channel').addStringOption(o=>o.setName('channel').setDescription('Channel ID or #channel mention').setRequired(true)))
    .addSubcommand(s=>s.setName('rest').setDescription('Set how much a rest restores (e.g. 50% or a flat number like 3)')
      .addStringOption(o=>o.setName('type').setDescription('Which rest to configure').setRequired(true)
        .addChoices({name:'Long Rest',value:'lrest'},{name:'Short Rest',value:'srest'}))
      .addStringOption(o=>o.setName('hp').setDescription('HP restored — "50%" of max, or a flat number like "3"').setRequired(false))
      .addStringOption(o=>o.setName('rerolls').setDescription('Rerolls restored — "50%" of max, or a flat number like "1"').setRequired(false))
      .addStringOption(o=>o.setName('heal').setDescription('Heal charges restored — "50%" of max, or a flat number like "2"').setRequired(false)))
    .addSubcommand(s=>s.setName('cleanwebhooks').setDescription('Remove orphaned NPC webhooks to free up Discord limits')),

  new SlashCommandBuilder()
    .setName('char').setDescription('Character setup and display')
    .addSubcommand(s=>s.setName('set').setDescription('Set a character stat or field')
      .addStringOption(o=>o.setName('field').setDescription('Field to set').setRequired(true)
        .addChoices(
          {name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},
          {name:'WIS',value:'wis'},{name:'LCK',value:'lck'},{name:'Order',value:'order'},
          {name:'Class',value:'class'},{name:'Weapon 1',value:'weapon1'},{name:'Weapon 2',value:'weapon2'},
          {name:'Weapon 1 Emoji',value:'weapon1emoji'},{name:'Weapon 2 Emoji',value:'weapon2emoji'}
        ))
      .addStringOption(o=>o.setName('value').setDescription('Value to set').setRequired(true))
      .addUserOption(o=>o.setName('user').setDescription('Target user (GM only)').setRequired(false)))
    .addSubcommand(s=>s.setName('create').setDescription('Set up a full character at once')
      .addIntegerOption(o=>o.setName('str').setDescription('Strength').setRequired(false))
      .addIntegerOption(o=>o.setName('con').setDescription('Constitution').setRequired(false))
      .addIntegerOption(o=>o.setName('dex').setDescription('Dexterity').setRequired(false))
      .addIntegerOption(o=>o.setName('wis').setDescription('Wisdom').setRequired(false))
      .addIntegerOption(o=>o.setName('lck').setDescription('Luck').setRequired(false))
      .addStringOption(o=>o.setName('order').setDescription('Knight order').setRequired(false)
        .addChoices({name:'White Knight',value:'White Knight'},{name:'Black Knight',value:'Black Knight'},{name:'Gold Knight',value:'Gold Knight'},{name:'Grey Knight',value:'Grey Knight'},{name:'Blue Knight',value:'Blue Knight'},{name:'Purple Knight',value:'Purple Knight'},{name:'Green Knight',value:'Green Knight'},{name:'Red Knight',value:'Red Knight'}))
      .addStringOption(o=>o.setName('class').setDescription('Character class').setRequired(false)
        .addChoices({name:'Hero',value:'Hero'},{name:'Vanguard',value:'Vanguard'},{name:'Defender',value:'Defender'},{name:'Siege Knight',value:'Siege Knight'}))
      .addStringOption(o=>o.setName('weapon1emoji').setDescription('Emoji for weapon slot 1').setRequired(false)
        .addChoices({name:'⚔️ Swords',value:'⚔️'},{name:'🗡️ Dagger',value:'🗡️'},{name:'🏹 Bow',value:'🏹'},{name:'🔱 Trident',value:'🔱'},{name:'⛏️ Pickaxe',value:'⛏️'},{name:'🛡️ Shield',value:'🛡️'},{name:'🪄 Wand',value:'🪄'}))
      .addStringOption(o=>o.setName('weapon1').setDescription('Weapon slot 1 — pick from list or type your own').setRequired(false).setAutocomplete(true))
      .addStringOption(o=>o.setName('weapon2emoji').setDescription('Emoji for weapon slot 2').setRequired(false)
        .addChoices({name:'⚔️ Swords',value:'⚔️'},{name:'🗡️ Dagger',value:'🗡️'},{name:'🏹 Bow',value:'🏹'},{name:'🔱 Trident',value:'🔱'},{name:'⛏️ Pickaxe',value:'⛏️'},{name:'🛡️ Shield',value:'🛡️'},{name:'🪄 Wand',value:'🪄'}))
      .addStringOption(o=>o.setName('weapon2').setDescription('Weapon slot 2 — pick from list or type your own').setRequired(false).setAutocomplete(true))
      .addUserOption(o=>o.setName('user').setDescription('Target player (GM only)').setRequired(false)))
    .addSubcommand(s=>s.setName('weaponemoji').setDescription('Set the emoji for a weapon slot')
      .addStringOption(o=>o.setName('slot').setDescription('Which weapon slot').setRequired(true)
        .addChoices({name:'Weapon 1',value:'weapon1emoji'},{name:'Weapon 2',value:'weapon2emoji'}))
      .addStringOption(o=>o.setName('emoji').setDescription('Pick a standard emoji').setRequired(false)
        .addChoices({name:'⚔️ Swords',value:'⚔️'},{name:'🗡️ Dagger',value:'🗡️'},{name:'🏹 Bow',value:'🏹'},{name:'🔱 Trident',value:'🔱'},{name:'⛏️ Pickaxe',value:'⛏️'},{name:'🛡️ Shield',value:'🛡️'},{name:'🪄 Wand',value:'🪄'}))
      .addStringOption(o=>o.setName('custom').setDescription('Or paste a server custom emoji (overrides the dropdown)').setRequired(false))
      .addUserOption(o=>o.setName('user').setDescription('Target player (GM only)').setRequired(false)))
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
    .setName('stat').setDescription('Show stat descriptions'),

  new SlashCommandBuilder()
    .setName('help').setDescription('Show all commands by category')
    .addStringOption(o=>o.setName('category').setDescription('Specific category to view').setRequired(false)
      .addChoices(
        {name:'Dice Rolling',value:'dice'},
        {name:'Character Sheet',value:'character'},
        {name:'HP, Healing & Rerolls',value:'hp'},
        {name:'Fights',value:'fight'},
        {name:'NPCs',value:'npc'},
        {name:'Tags',value:'tags'},
        {name:'GM & Config',value:'gm'}
      )),

  new SlashCommandBuilder()
    .setName('lastroll').setDescription('Show your most recent roll in this channel'),

  new SlashCommandBuilder()
    .setName('backup').setDescription('Database backup (GM only)')
    .addSubcommand(s=>s.setName('now').setDescription('Export the database to this channel'))
    .addSubcommand(s=>s.setName('auto').setDescription('Toggle daily automatic backups')
      .addStringOption(o=>o.setName('channel').setDescription('Channel for backups (or type off to disable)').setRequired(true))),

  new SlashCommandBuilder()
    .setName('weapon').setDescription('Manage the server weapon list (GM only)')
    .addSubcommand(s=>s.setName('add').setDescription('Add a weapon to the server list')
      .addStringOption(o=>o.setName('name').setDescription('Weapon name').setRequired(true)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove a weapon from the server list')
      .addStringOption(o=>o.setName('name').setDescription('Weapon name').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List all server weapons')),

  new SlashCommandBuilder()
    .setName('dr').setDescription('Roll dice with full options')
    .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
      .addChoices(
        {name:'Normal (default)',value:'normal'},
        {name:'Advantage',value:'adv'},
        {name:'Disadvantage',value:'dis'},
        {name:'Reroll',value:'rr'},
        {name:'Reroll with Advantage',value:'rra'},
        {name:'Reroll with Disadvantage',value:'rrd'}
      ))
    .addStringOption(o=>o.setName('notation').setDescription('Dice notation e.g. 1d20+5').setRequired(false))
    .addStringOption(o=>o.setName('label').setDescription('Roll label e.g. atk').setRequired(false))
    .addStringOption(o=>o.setName('flavour').setDescription('Flavour text').setRequired(false))
    .addBooleanOption(o=>o.setName('success').setDescription('Show success outcome').setRequired(false)),

  new SlashCommandBuilder()
    .setName('npc').setDescription('Manage NPCs (GM only)')
    .addSubcommand(s=>s.setName('create').setDescription('Create an NPC')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true))
      .addIntegerOption(o=>o.setName('str').setDescription('Strength').setRequired(true))
      .addIntegerOption(o=>o.setName('con').setDescription('Constitution').setRequired(true))
      .addIntegerOption(o=>o.setName('dex').setDescription('Dexterity').setRequired(true))
      .addIntegerOption(o=>o.setName('wis').setDescription('Wisdom').setRequired(true))
      .addIntegerOption(o=>o.setName('lck').setDescription('Luck').setRequired(true))
      .addStringOption(o=>o.setName('order').setDescription('Knight order (optional)').setRequired(false)
        .addChoices({name:'White Knight',value:'White Knight'},{name:'Black Knight',value:'Black Knight'},{name:'Gold Knight',value:'Gold Knight'},{name:'Grey Knight',value:'Grey Knight'},{name:'Blue Knight',value:'Blue Knight'},{name:'Purple Knight',value:'Purple Knight'},{name:'Green Knight',value:'Green Knight'},{name:'Red Knight',value:'Red Knight'})))
    .addSubcommand(s=>s.setName('delete').setDescription('Delete an NPC').addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List all NPCs on this server'))
    .addSubcommand(s=>s.setName('categorylist').setDescription('List all NPC categories'))
    .addSubcommand(s=>s.setName('categorycreate').setDescription('Create a new NPC category')
      .addStringOption(o=>o.setName('name').setDescription('Category name').setRequired(true)))
    .addSubcommand(s=>s.setName('categorydelete').setDescription('Delete an NPC category')
      .addStringOption(o=>o.setName('name').setDescription('Category name').setRequired(true)))
    .addSubcommand(s=>s.setName('categoryassign').setDescription('Assign an NPC to a category')
      .addStringOption(o=>o.setName('npc').setDescription('NPC name').setRequired(true))
      .addStringOption(o=>o.setName('category').setDescription('Category name').setRequired(true)))
    .addSubcommand(s=>s.setName('categoryremove').setDescription('Remove an NPC from a category')
      .addStringOption(o=>o.setName('npc').setDescription('NPC name').setRequired(true))
      .addStringOption(o=>o.setName('category').setDescription('Category name').setRequired(true))),

  new SlashCommandBuilder()
    .setName('pr').setDescription('Roll or manage NPCs as a GM persona (GM only)')
    .addSubcommand(s=>s.setName('roll').setDescription('Roll as an NPC via webhook')
      .addStringOption(o=>o.setName('category').setDescription('Filter NPCs by category').setRequired(true)
        .addChoices({name:'All',value:'all'}))
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true).setAutocomplete(true))
      .addStringOption(o=>o.setName('notation').setDescription('Dice notation e.g. 1d20+5 (default: 1d20)').setRequired(false))
      .addStringOption(o=>o.setName('stat').setDescription('Stat label (optional — auto adds modifier)').setRequired(false)
        .addChoices({name:'STR',value:'STR'},{name:'CON',value:'CON'},{name:'DEX',value:'DEX'},{name:'WIS',value:'WIS'},{name:'LCK',value:'LCK'}))
      .addStringOption(o=>o.setName('label').setDescription('Additional label (optional)').setRequired(false))
      .addStringOption(o=>o.setName('flavour').setDescription('Flavour text').setRequired(false))
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'})))
    .addSubcommand(s=>s.setName('create').setDescription('Create an NPC')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true))
      .addIntegerOption(o=>o.setName('str').setDescription('Strength').setRequired(true))
      .addIntegerOption(o=>o.setName('con').setDescription('Constitution').setRequired(true))
      .addIntegerOption(o=>o.setName('dex').setDescription('Dexterity').setRequired(true))
      .addIntegerOption(o=>o.setName('wis').setDescription('Wisdom').setRequired(true))
      .addIntegerOption(o=>o.setName('lck').setDescription('Luck').setRequired(true))
      .addStringOption(o=>o.setName('order').setDescription('Knight order (optional)').setRequired(false)
        .addChoices({name:'White Knight',value:'White Knight'},{name:'Black Knight',value:'Black Knight'},{name:'Gold Knight',value:'Gold Knight'},{name:'Grey Knight',value:'Grey Knight'},{name:'Blue Knight',value:'Blue Knight'},{name:'Purple Knight',value:'Purple Knight'},{name:'Green Knight',value:'Green Knight'},{name:'Red Knight',value:'Red Knight'})))
    .addSubcommand(s=>s.setName('delete').setDescription('Delete an NPC').addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List all NPCs on this server')),

  new SlashCommandBuilder()
    .setName('fight').setDescription('Manage a fight between players')
    .addSubcommand(s=>s.setName('start').setDescription('Start a fight')
      .addUserOption(o=>o.setName('p1').setDescription('Fighter 1').setRequired(true))
      .addUserOption(o=>o.setName('p2').setDescription('Fighter 2').setRequired(true))
      .addUserOption(o=>o.setName('p3').setDescription('Fighter 3').setRequired(false))
      .addUserOption(o=>o.setName('p4').setDescription('Fighter 4').setRequired(false))
      .addUserOption(o=>o.setName('p5').setDescription('Fighter 5').setRequired(false))
      .addUserOption(o=>o.setName('p6').setDescription('Fighter 6').setRequired(false)))
    .addSubcommand(s=>s.setName('atk').setDescription('Attack a target')
      .addStringOption(o=>o.setName('stat').setDescription('Stat to attack with').setRequired(true)
        .addChoices({name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},{name:'WIS',value:'wis'},{name:'LCK',value:'lck'}))
      .addUserOption(o=>o.setName('target').setDescription('Player to attack').setRequired(true))
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'}))
      .addStringOption(o=>o.setName('flavour').setDescription('Optional flavour text').setRequired(false)))
    .addSubcommand(s=>s.setName('def').setDescription('Defend against the current attack')
      .addStringOption(o=>o.setName('stat').setDescription('Stat to defend with').setRequired(true)
        .addChoices({name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},{name:'WIS',value:'wis'},{name:'LCK',value:'lck'}))
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'}))
      .addStringOption(o=>o.setName('flavour').setDescription('Optional flavour text').setRequired(false)))
    .addSubcommand(s=>s.setName('rr').setDescription('Reroll last fight roll (costs 1 reroll token)')
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'})))
    .addSubcommand(s=>s.setName('resolve').setDescription('Resolve the current exchange'))
    .addSubcommand(s=>s.setName('forfeit').setDescription('Concede the fight'))
    .addSubcommand(s=>s.setName('status').setDescription('Show current fight status'))
    .addSubcommand(s=>s.setName('end').setDescription('End the fight (GM only)')),

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
  if (sub === 'npcchannel') {
    const raw = interaction.options.getString('channel');
    const channelId = raw.replace(/[<#>]/g, '').trim();
    setConfig(gid, { npc_channel_id: channelId });
    return interaction.reply({ content: `✅ NPC image channel set to <#${channelId}>. Upload images there with the NPC name as the message text to set avatars.`, ephemeral: true });
  }

  if (sub === 'rest') {
    const type = interaction.options.getString('type'); // lrest or srest
    const hp = interaction.options.getString('hp');
    const rerolls = interaction.options.getString('rerolls');
    const heal = interaction.options.getString('heal');
    const cfg = getConfig(gid);
    const restName = type === 'lrest' ? 'Long Rest' : 'Short Rest';

    // Defaults for display when a column is null
    const dFallback = type === 'lrest' ? {hp:'100%',rr:'100%',heal:'100%'} : {hp:'50%',rr:'0%',heal:'0%'};
    const cur = {
      hp:   cfg[`${type}_hp`]      ?? dFallback.hp,
      rr:   cfg[`${type}_rerolls`] ?? dFallback.rr,
      heal: cfg[`${type}_heal`]    ?? dFallback.heal,
    };

    // Describe a stored token in plain language
    const describe = (tok) => {
      const t = String(tok).trim();
      if (t.endsWith('%')) return t === '0%' ? 'nothing' : `${t} of max`;
      return `set to ${t}`;
    };

    // If no values supplied, just show current settings
    if (hp === null && rerolls === null && heal === null) {
      return interaction.reply({ content: `⚙️ **${restName}** currently restores:\n❤️ HP: **${describe(cur.hp)}**\n🔄 Rerolls: **${describe(cur.rr)}**\n🛡️ Heal: **${describe(cur.heal)}**\n\nProvide \`hp\`, \`rerolls\`, and/or \`heal\` to change them. Use a percentage like \`50%\` or a flat number like \`3\`.`, ephemeral: true });
    }

    // Validate a token: must be "N%" or a plain whole number N (>= 0)
    const validTok = (v) => {
      const t = String(v).trim();
      if (/^\d+%$/.test(t)) return t;
      if (/^\d+$/.test(t)) return t;
      return null;
    };

    const updates = {};
    for (const [opt, col, key] of [[hp,'hp','hp'],[rerolls,'rerolls','rr'],[heal,'heal','heal']]) {
      if (opt === null) continue;
      const v = validTok(opt);
      if (v === null) {
        return interaction.reply({ content: `❌ \`${opt}\` isn't valid. Use a percentage like \`50%\` or a flat whole number like \`3\`.`, ephemeral: true });
      }
      updates[`${type}_${col}`] = v;
      cur[key] = v;
    }
    setConfig(gid, updates);
    return interaction.reply({ content: `✅ **${restName}** now restores:\n❤️ HP: **${describe(cur.hp)}**\n🔄 Rerolls: **${describe(cur.rr)}**\n🛡️ Heal: **${describe(cur.heal)}**`, ephemeral: true });
  }

  if (sub === 'cleanwebhooks') {
    await interaction.deferReply({ ephemeral: true });
    try {
      // Gather webhook IDs currently in use by NPCs
      const activeWebhookIds = new Set(
        db.prepare('SELECT webhook_id FROM npcs WHERE guild_id=? AND webhook_id IS NOT NULL').all(gid).map(r => r.webhook_id)
      );
      let removed = 0, checked = 0;
      // Scan all text channels for webhooks created by this bot
      const channels = await interaction.guild.channels.fetch();
      for (const [, ch] of channels) {
        if (!ch || typeof ch.fetchWebhooks !== 'function') continue;
        let hooks;
        try { hooks = await ch.fetchWebhooks(); } catch { continue; }
        for (const [, hook] of hooks) {
          // Only touch webhooks this bot owns
          if (hook.owner?.id !== client.user.id) continue;
          checked++;
          if (!activeWebhookIds.has(hook.id)) {
            try { await hook.delete('DDice orphaned webhook cleanup'); removed++; } catch {}
          }
        }
      }
      return interaction.editReply({ content: `🧹 Webhook cleanup complete. Checked ${checked} bot webhook(s), removed ${removed} orphaned one(s).` });
    } catch (err) {
      console.error('Webhook cleanup error:', err);
      return interaction.editReply({ content: `❌ Cleanup failed: ${err.message}` });
    }
  }

}

async function handleChar(interaction) {
  const sub = interaction.options.getSubcommand(), gid = interaction.guild.id, callerId = interaction.user.id;
  if (sub === 'create') {
    const targetUser = interaction.options.getUser('user');
    const isGmUser = await isGm(interaction.guild, callerId);
    if (targetUser && !isGmUser) return interaction.reply({ content: '❌ Only GMs can set stats for other players.', ephemeral: true });
    const targetId = targetUser?.id ?? callerId;
    const updates = {};
    // Validate stat ranges (0-99)
    for (const stat of ['str','con','dex','wis','lck']) {
      const v = interaction.options.getInteger(stat);
      if (v !== null && (v < 0 || v > 99)) return interaction.reply({ content: `❌ ${stat.toUpperCase()} must be between 0 and 99.`, ephemeral: true });
    }
    const str = interaction.options.getInteger('str'); if (str !== null) updates.str = str;
    const con = interaction.options.getInteger('con'); if (con !== null) { updates.con = con; updates.hp_current = con + 2; }
    const dex = interaction.options.getInteger('dex'); if (dex !== null) updates.dex = dex;
    const wis = interaction.options.getInteger('wis'); if (wis !== null) updates.wis = wis;
    const lck = interaction.options.getInteger('lck'); if (lck !== null) { updates.lck = lck; updates.rerolls_current = lck; }
    const order = interaction.options.getString('order'); if (order) updates.order_name = order;
    const charClass = interaction.options.getString('class'); if (charClass) updates.class = charClass;
    const weapon1 = interaction.options.getString('weapon1'); if (weapon1) updates.weapon1 = weapon1;
    const weapon2 = interaction.options.getString('weapon2'); if (weapon2) updates.weapon2 = weapon2;
    const weapon1emoji = interaction.options.getString('weapon1emoji');
    if (weapon1emoji) {
      const c1 = validateWeaponEmoji(interaction.guild, weapon1emoji);
      if (!c1) return interaction.reply({ content: `❌ Weapon 1 emoji invalid — use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or a server custom emoji.`, ephemeral: true });
      updates.weapon1emoji = c1;
    }
    const weapon2emoji = interaction.options.getString('weapon2emoji');
    if (weapon2emoji) {
      const c2 = validateWeaponEmoji(interaction.guild, weapon2emoji);
      if (!c2) return interaction.reply({ content: `❌ Weapon 2 emoji invalid — use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or a server custom emoji.`, ephemeral: true });
      updates.weapon2emoji = c2;
    }
    if (Object.keys(updates).length === 0) return interaction.reply({ content: '❌ No fields provided.', ephemeral: true });
    upsertChar(gid, targetId, updates);
    const mention = targetUser ? `<@${targetId}>` : 'Your';
    const summary = Object.entries(updates)
      .filter(([k]) => !['hp_current','rerolls_current'].includes(k))
      .map(([k,v]) => `**${k.toUpperCase()}**: ${v}`).join(', ');
    return interaction.reply({ content: `✅ ${mention} character updated — ${summary}` });
  }

  if (sub === 'weaponemoji') {
    const slot = interaction.options.getString('slot'); // weapon1emoji or weapon2emoji
    const emoji = interaction.options.getString('emoji');     // from dropdown
    const custom = interaction.options.getString('custom');   // pasted server emoji
    const targetUser = interaction.options.getUser('user');
    const targetId = targetUser ? targetUser.id : callerId;
    if (targetId !== callerId && !(await isGm(interaction.guild, callerId)))
      return interaction.reply({ content: '❌ Only GMs can modify other players\' characters.', ephemeral: true });
    // Custom (pasted) emoji takes priority over the dropdown
    const chosen = (custom && custom.trim()) ? custom.trim() : emoji;
    if (!chosen) return interaction.reply({ content: `❌ Pick a standard emoji from the dropdown, or paste a server custom emoji in the **custom** field.`, ephemeral: true });
    const cleaned = validateWeaponEmoji(interaction.guild, chosen);
    if (!cleaned) return interaction.reply({ content: `❌ That isn't a valid emoji. Use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or one of this server's own custom emojis.`, ephemeral: true });
    upsertChar(gid, targetId, { [slot]: cleaned });
    const slotLabel = slot === 'weapon1emoji' ? 'Weapon 1' : 'Weapon 2';
    return interaction.reply({ content: `✅ ${slotLabel} emoji set to ${cleaned}${targetId!==callerId?` for <@${targetId}>`:''}.` });
  }

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
      if (num > 99) return interaction.reply({ content: '❌ Stat values are capped at 99.', ephemeral: true });
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
    // Handle class, weapon and weapon emoji fields
    if (['class','weapon1','weapon2','weapon1emoji','weapon2emoji'].includes(field)) {
      if (field === 'weapon1emoji' || field === 'weapon2emoji') {
        const cleaned = validateWeaponEmoji(interaction.guild, value);
        if (!cleaned) return interaction.reply({ content: `❌ Use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or one of this server's custom emojis.`, ephemeral: true });
        upsertChar(gid, targetId, { [field]: cleaned });
        const lbl = field === 'weapon1emoji' ? 'Weapon 1 Emoji' : 'Weapon 2 Emoji';
        return interaction.reply({ content: `✅ **${lbl}** set to ${cleaned}${targetId!==callerId?` for <@${targetId}>`:''}.` });
      }
      if (['class','weapon1','weapon2'].includes(field) && value.length > 50) {
        return interaction.reply({ content: '❌ That name is too long (max 50 characters).', ephemeral: true });
      }
      upsertChar(gid, targetId, { [field]: value });
      const label = { class:'Class', weapon1:'Weapon 1', weapon2:'Weapon 2' }[field];
      return interaction.reply({ content: `✅ **${label}** set to **${value}**${targetId!==callerId?` for <@${targetId}>`:''}.` });
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
    const lines = [`⚔️  **${dn}**`, kn];
    if (char.class) lines.push(`🏅  ${char.class}`);
    lines.push(`❤️  HP          ${char.hp_current} / ${maxHp(char)}`, `🔄  Rerolls      ${char.rerolls_current} / ${maxRerolls(char)}`);
    if (isWhiteKnight(char)) lines.push(`🛡️  Heal         ${hr.current} / ${mc}`);
    lines.push('', `💪  STR         ${char.str}`, `🫀  CON         ${char.con}`, `⚡  DEX         ${char.dex}`, `🧠  WIS         ${char.wis}`, `🍀  LCK         ${char.lck}`);
    if (char.weapon1 || char.weapon2) {
      lines.push('');
      if (char.weapon1) lines.push(`${char.weapon1emoji??'⚔️'}  ${char.weapon1}`);
      if (char.weapon2) lines.push(`${char.weapon2emoji??'🗡️'}  ${char.weapon2}`);
    }
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
    const lines = [`⚔️  **${dn}**`, kn];
    if (ch.class) lines.push(`🏅  ${ch.class}`);
    lines.push(`❤️  HP          ${ch.hp_current} / ${maxHp(ch)}`, `🔄  Rerolls      ${ch.rerolls_current} / ${maxRerolls(ch)}`);
    if (isWhiteKnight(ch)) lines.push(`🛡️  Heal         ${hr.current} / ${mc}`);
    lines.push('', `💪  STR         ${ch.str}`, `🫀  CON         ${ch.con}`, `⚡  DEX         ${ch.dex}`, `🧠  WIS         ${ch.wis}`, `🍀  LCK         ${ch.lck}`);
    if (ch.weapon1 || ch.weapon2) {
      lines.push('');
      if (ch.weapon1) lines.push(`${ch.weapon1emoji??'⚔️'}  ${ch.weapon1}`);
      if (ch.weapon2) lines.push(`${ch.weapon2emoji??'🗡️'}  ${ch.weapon2}`);
    }
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

async function handleRoll(message, rest, mode, isReroll, successCheck = false) {
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
  const naturalRoll = mode === 'normal' ? result.rolls[0] : result.chosen;
  const sides = result.sides ?? (mode === 'normal' ? result.sides : result.sides);
  const successResult = successCheck ? getSuccessResult(result.total, naturalRoll, result.sides ?? result.sides) : null;
  const rollLine = buildRollLine(result, mode, critType, successResult);
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

// Resolve a rest token against a resource max.
//   "100%" / "50%" -> percentage of max (capped at max, uncapped input allowed)
//   "3"            -> flat: set the resource to exactly 3 (capped at max)
// Returns { value, changed } — changed=false means "don't touch this resource".
function resolveRestToken(token, max, fallback) {
  let raw = (token === null || token === undefined || token === '') ? fallback : String(token).trim();
  if (raw === null || raw === undefined) return { value: null, changed: false };
  raw = String(raw).trim();
  if (raw.endsWith('%')) {
    const p = parseInt(raw.slice(0, -1), 10);
    if (isNaN(p) || p <= 0) return { value: null, changed: false };
    return { value: Math.min(max, Math.floor(max * p / 100)), changed: true };
  }
  // Flat whole number — set the value to exactly this (clamped to max)
  const n = parseInt(raw, 10);
  if (isNaN(n) || n < 0) return { value: null, changed: false };
  return { value: Math.min(max, n), changed: true };
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

  let label, hpTok, rTok, healTok;
  if (type==='lrest') {
    label = '🌙 Long Rest';
    hpTok = cfg.lrest_hp; rTok = cfg.lrest_rerolls; healTok = cfg.lrest_heal;
    hpTok ??= '100%'; rTok ??= '100%'; healTok ??= '100%';
  } else if (type==='srest') {
    label = '☀️ Short Rest';
    hpTok = cfg.srest_hp; rTok = cfg.srest_rerolls; healTok = cfg.srest_heal;
    hpTok ??= '50%'; rTok ??= '0%'; healTok ??= '0%';
  } else if (type==='hpfull') {
    // HP-only commands ignore rest config entirely
    upsertChar(gid, targetId, { hp_current: hm });
    return message.reply([`❤️ HP Restored applied to ${tn} character.`, `❤️ HP: **${hm} / ${hm}**`].join('\n'));
  } else if (type==='hphalf') {
    const half = Math.floor(hm/2);
    upsertChar(gid, targetId, { hp_current: half });
    return message.reply([`❤️ HP Half Restored applied to ${tn} character.`, `❤️ HP: **${half} / ${hm}**`].join('\n'));
  }

  // Long / short rest: resolve each resource's token and only touch ones that change
  const lines = [`${label} applied to ${tn} character.`];
  const updates = {};
  const hpR = resolveRestToken(hpTok, hm, '0%');
  if (hpR.changed) { updates.hp_current = hpR.value; lines.push(`❤️ HP: **${hpR.value} / ${hm}**`); }
  const rR = resolveRestToken(rTok, rm, '0%');
  if (rR.changed) { updates.rerolls_current = rR.value; lines.push(`🔄 Rerolls: **${rR.value} / ${rm}**`); }
  if (Object.keys(updates).length) upsertChar(gid, targetId, updates);
  const healR = resolveRestToken(healTok, mc, '0%');
  if (healR.changed && isWhiteKnight(ch)) {
    setHealCharges(gid, targetId, healR.value);
    lines.push(`🛡️ Heal: **${healR.value} / ${mc}**`);
  }
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
    class: data['CLASS'] || null,
    str: parseInt(data['STR']),
    con: parseInt(data['CON']),
    dex: parseInt(data['DEX']),
    wis: parseInt(data['WIS']),
    lck: parseInt(data['LCK']),
    hp_current: data['HP'] ? parseInt(data['HP']) : null,
    rerolls_current: data['REROLLS'] ? parseInt(data['REROLLS']) : null,
    weapon1: data['WEAPON1'] || null,
    weapon1emoji: data['WEAPON1EMOJI'] || null,
    weapon2: data['WEAPON2'] || null,
    weapon2emoji: data['WEAPON2EMOJI'] || null,
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
    class: parsed.class || null,
    str: parsed.str, con: parsed.con, dex: parsed.dex,
    wis: parsed.wis, lck: parsed.lck,
    hp_current: hpCurrent,
    rerolls_current: rerollsCurrent,
    weapon1: parsed.weapon1 || null,
    weapon1emoji: validateWeaponEmoji(message.guild, parsed.weapon1emoji) || '⚔️',
    weapon2: parsed.weapon2 || null,
    weapon2emoji: validateWeaponEmoji(message.guild, parsed.weapon2emoji) || '🗡️',
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

async function handleStat(interaction) {
  const lines = [
    '**Strength** (**STR**) – Physical power, melee combat.',
    '',
    '**Constitution** (**CON**) – Durability, health.',
    '',
    '**Dexterity** (**DEX**) – Agility, ranged/finesse combat.',
    '',
    '**Wisdom** (**WIS**) – Insight, tactical awareness.',
    '',
    '**Luck** (**LUCK**) – Fortune, chance-based effects.',
  ];
  return interaction.reply({ content: lines.join('\n'), ephemeral: false });
}

// ─────────────────────────────────────────────
//  BOT CLIENT
// ─────────────────────────────────────────────

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers],
});

client.on('ready', async () => {
  console.log(`✅ Bot online as ${client.user.tag}`);
  // Re-register commands for each guild with current NPC list
  for (const guild of client.guilds.cache.values()) {
    await registerSlashCommands(guild.id).catch(console.error);
  }
  startBackupScheduler();
  console.log('✅ Backup scheduler started');
});

client.on('interactionCreate', async interaction => {
  // Handle autocomplete for NPC name fields
  if (interaction.isAutocomplete()) {
    try {
      const focusedOption = interaction.options.getFocused(true);
      console.log(`Autocomplete: cmd=${interaction.commandName} sub=${interaction.options.getSubcommand(false)} focused=${focusedOption.name} value=${focusedOption.value}`);
      if ((interaction.commandName === 'pr' || interaction.commandName === 'npc') && focusedOption.name === 'name') {
        const focused = focusedOption.value;
        const npcs = getAllNpcs(interaction.guild.id);
        const filtered = npcs
          .filter(n => n.name.toLowerCase().includes(focused.toLowerCase()))
          .slice(0, 25)
          .map(n => ({ name: n.name, value: n.name }));
        console.log(`Autocomplete responding with ${filtered.length} NPCs`);
        return await interaction.respond(filtered);
      }
      // Weapon name autocomplete — server weapon list + whatever the user is typing
      if (interaction.commandName === 'char' && (focusedOption.name === 'weapon1' || focusedOption.name === 'weapon2')) {
        const focused = (focusedOption.value || '').toString();
        const weapons = getWeapons(interaction.guild.id);
        const matches = weapons.filter(w => w.toLowerCase().includes(focused.toLowerCase()));
        const choices = matches.slice(0, 24).map(w => ({ name: w, value: w }));
        // Always let the player keep their own free text as the first option
        if (focused.trim() && !weapons.some(w => w.toLowerCase() === focused.toLowerCase())) {
          choices.unshift({ name: `✏️ Use: ${focused.slice(0, 80)}`, value: focused.slice(0, 100) });
        }
        return await interaction.respond(choices.slice(0, 25));
      }
    } catch (err) { console.error('Autocomplete error:', err); }
    return;
  }

  // Handle confirmation buttons
  if (interaction.isButton()) {
    if (interaction.customId.startsWith('confirm:') || interaction.customId.startsWith('cancel:')) {
      return handleConfirmButton(interaction);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  try {
    if (interaction.commandName === 'config') return await handleConfig(interaction);
    if (interaction.commandName === 'char') return await handleChar(interaction);
    if (interaction.commandName === 'profile' || interaction.commandName === 'p') return await handleProfile(interaction);
    if (interaction.commandName === 'tag') return await handleTag(interaction);
    if (interaction.commandName === 'stat') return await handleStat(interaction);
    if (interaction.commandName === 'dr') return await handleSlashRoll(interaction);
    if (interaction.commandName === 'fight') return await handleFight(interaction);
    if (interaction.commandName === 'npc') return await handleNpc(interaction);
    if (interaction.commandName === 'pr') return await handlePr(interaction);
    if (interaction.commandName === 'weapon') return await handleWeapon(interaction);
    if (interaction.commandName === 'help') return await handleHelp(interaction);
    if (interaction.commandName === 'lastroll') return await handleLastRoll(interaction);
    if (interaction.commandName === 'backup') return await handleBackup(interaction);
  } catch (err) {
    console.error(`[${interaction.commandName}] error:`, err);
    // Build a helpful error message
    let msg = '❌ Something went wrong';
    if (err.code === 50013) msg = '❌ I don\'t have permission to do that. Check my role permissions.';
    else if (err.code === 50001) msg = '❌ I can\'t access that channel.';
    else if (err.code === 10003) msg = '❌ That channel no longer exists.';
    else if (err.code === 50035) msg = '❌ Invalid input — please check the values you entered.';
    else if (err.message?.includes('Missing Permissions')) msg = '❌ I\'m missing permissions for that action.';
    else if (err.message) msg = `❌ ${err.message.slice(0, 150)}`;
    const payload = { content: msg, ephemeral: true };
    if (interaction.replied || interaction.deferred) interaction.followUp(payload).catch(()=>{});
    else interaction.reply(payload).catch(()=>{});
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.trim();


  // NPC image bank — detect image uploads in npc channel
  if (message.attachments.size > 0) {
    const cfg = getConfig(message.guild.id);
    if (cfg.npc_channel_id && message.channel.id === cfg.npc_channel_id) {
      const npcName = message.content.trim();
      if (npcName) {
        const npc = getNpc(message.guild.id, npcName);
        if (npc) {
          const imageUrl = message.attachments.first().url;
          setNpcImage(message.guild.id, npcName, imageUrl);
          // Reset webhook so it gets recreated with new avatar
          setNpcWebhook(message.guild.id, npcName, null, null);
          message.react('✅').catch(()=>{});
        }
      }
      return; // Don't process as commands
    }
  }

  // Sheet import detection — check before prefix matching
  if (content.includes('[TTRPG SHEET]')) {
    const parsed = parseSheetImport(content);
    if (parsed) {
      try { return await handleSheetImport(message, parsed); }
      catch (err) { console.error(err); return message.reply('\u274c Failed to import sheet.'); }
    }
  }


  // Bare dice notation — check before prefix matching so 1d20 works with no prefix
  const earlyBareMatch = content.match(/^(\d+d\d+(?:[+-]\d+)?)([ \t].*)?([\s\S]*)?$/i);
  if (earlyBareMatch) {
    const sameLineRest = (earlyBareMatch[2] ?? '').trim();
    const flavourRest = earlyBareMatch[3] ?? '';
    const bareRest = earlyBareMatch[1] + (sameLineRest ? ' ' + sameLineRest : '') + flavourRest;
    try { return await handleRoll(message, bareRest, 'normal', false); }
    catch (err) { console.error(err); return message.reply('\u274c Something went wrong.'); }
  }

  const match = content.match(/^(!?|\?)(gmrs?|lrest|srest|hpfull|hphalf|rerolls|roll|rra|rrd|rr|ra|rd|r|heal|hp|h)([\s\S]*)/i);
  if (!match) return;
  const prefix = match[1];
  const successCheck = prefix === '?';
  const raw = match[2].toLowerCase();
  // Preserve newlines for flavour text — only trim leading spaces on first line
  const rest = (match[3] ?? '').replace(/^[ \t]+/, '');
  try {
    if (raw==='r'||raw==='roll') return handleRoll(message, rest, 'normal', false, successCheck);
    if (raw==='ra') return handleRoll(message, rest, 'adv', false, successCheck);
    if (raw==='rd') return handleRoll(message, rest, 'dis', false, successCheck);
    if (raw==='rr') return handleRoll(message, rest, 'normal', true, successCheck);
    if (raw==='rra') return handleRoll(message, rest, 'adv', true, successCheck);
    if (raw==='rrd') return handleRoll(message, rest, 'dis', true, successCheck);
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

async function registerSlashCommands(guildId) {
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    let commands = slashCommands;
    if (guildId) {
      const npcList = getAllNpcs(guildId);
      const categories = getCategories(guildId);
      const uncategorised = getUncategorisedNpcs(guildId);

      if (npcList.length > 0 || categories.length > 0) {
        commands = slashCommands.map(cmd => {
          if (cmd.name !== 'pr') return cmd;
          const json = JSON.parse(JSON.stringify(cmd.toJSON()));

          json.options.forEach(sub => {
            if (sub.name === 'roll' || sub.name === 'reroll') {
              // Set category choices — All + each category + Uncategorised
              const catOpt = sub.options?.find(o => o.name === 'category');
              if (catOpt) {
                const catChoices = [
                  { name: 'All', value: 'all' },
                  ...categories.map(c => ({ name: c, value: c })),
                  { name: 'Uncategorised', value: 'Uncategorised' }
                ].slice(0, 25);
                catOpt.choices = catChoices;
              }

              // NPC names with category prefix — categorised first, then uncategorised
              const nameOpt = sub.options?.find(o => o.name === 'name');
              if (nameOpt && npcList.length > 0) {
                nameOpt.autocomplete = false;
                const categorised = [];
                const uncatNpcs = [];
                npcList.forEach(n => {
                  const cats = getCategoriesForNpc(guildId, n.name);
                  if (cats.length > 0) {
                    cats.forEach(c => categorised.push({ name: `[${c}] ${n.name}`, value: n.name }));
                  } else {
                    uncatNpcs.push({ name: n.name, value: n.name });
                  }
                });
                const seen = new Set();
                nameOpt.choices = [...categorised, ...uncatNpcs].filter(c => {
                  if (seen.has(c.value)) return false;
                  seen.add(c.value); return true;
                }).slice(0, 25);
              }
            }
          });
          return { toJSON: () => json };
        });
      }

    }
    await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    console.log('✅ Slash commands registered.');
  } catch (err) { console.error('Failed to register slash commands:', err); }
}

(async () => {
  console.log('Registering slash commands...');
  await registerSlashCommands(null);
  client.login(process.env.DISCORD_TOKEN);
})();
// ─────────────────────────────────────────────
//  FIGHT SYSTEM
// ─────────────────────────────────────────────

const STAT_LABELS = { str:'STR', con:'CON', dex:'DEX', wis:'WIS', lck:'LCK' };

function fightTotalStr(total, nat, sides) {
  const isCrit = nat === sides;
  const isFail = nat === 1;
  if (isCrit) return `🟡 **${total}**`;
  if (isFail) return `🔴 **${total}**`;
  return `**${total}**`;
}

function resolveDamage(atkRoll, atkNat, atkSides, defRoll, defNat, defSides) {
  let dmg = 0;
  const hit = atkRoll >= defRoll;
  if (hit) {
    dmg = 1;
    if (atkNat === atkSides) dmg += 1; // attacker nat max
    if (defNat === 1) dmg += 1;        // defender nat 1
    if (atkNat === atkSides && defNat === 1) dmg += 1; // both — total 4
  }
  return { hit, dmg };
}

async function handleFight(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const cid = interaction.channel.id;
  const uid = interaction.user.id;

  // ── START ──────────────────────────────────────────────────────────────────
  if (sub === 'start') {
    const existing = getFight(gid, cid);
    if (existing && existing.state !== 'idle') {
      return interaction.reply({ content: '❌ A fight is already in progress in this channel. Use `/fight end` to stop it first.', ephemeral: true });
    }

    const playerOptions = ['p1','p2','p3','p4','p5','p6'];
    const fighters = [];
    for (const opt of playerOptions) {
      const u = interaction.options.getUser(opt);
      if (u) fighters.push(u.id);
    }
    if (fighters.length < 2) return interaction.reply({ content: '❌ Need at least 2 fighters.', ephemeral: true });

    // Roll initiative for each fighter
    const initiatives = [];
    const hpState = {};
    for (const fid of fighters) {
      const char = getChar(gid, fid);
      const dex = char?.dex ?? 0;
      const roll = rollDie(20);
      const total = roll + dex;
      const member = await interaction.guild.members.fetch(fid).catch(()=>null);
      const name = member?.nickname || member?.user.username || fid;
      const hp = char ? char.hp_current : 0;
      hpState[fid] = hp;
      initiatives.push({ id: fid, name, roll, dex, total });
    }

    // Sort by total descending, ties broken by raw roll
    initiatives.sort((a,b) => b.total - a.total || b.roll - a.roll);

    const turnOrder = initiatives.map(i => i.id);
    const lines = ['⚔️ **Fight started! Initiative order:**', ''];
    initiatives.forEach((f,i) => {
      lines.push(`${i+1}. **${f.name}** — 1d20+${f.dex} → [${f.roll}] = **${f.total}**`);
    });
    lines.push('');
    const first = initiatives[0];
    lines.push(`🎯 **${first.name}** goes first! Use \`/fight atk\` to attack.`);

    upsertFight(gid, cid, {
      state: 'active',
      turn_order: JSON.stringify(turnOrder),
      turn_index: 0,
      phase: 'attack',
      current_target: null,
      atk_roll: null, atk_nat: null, atk_stat: null,
      def_roll: null, def_nat: null, def_stat: null,
      hp_state: JSON.stringify(hpState),
    });

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── ATK (normal / adv / dis) ──────────────────────────────────────────────
  if (sub === 'atk') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const currentId = turnOrder[fight.turn_index];

    if (uid !== currentId) {
      const member = await interaction.guild.members.fetch(currentId).catch(()=>null);
      const name = member?.nickname || member?.user.username || 'their turn';
      return interaction.reply({ content: `⚠️ It's **${name}**'s turn to attack.`, ephemeral: false });
    }

    if (fight.phase !== 'attack') return interaction.reply({ content: '❌ Waiting for defender to roll first.', ephemeral: true });

    const stat = interaction.options.getString('stat');
    const target = interaction.options.getUser('target');
    const flavour = interaction.options.getString('flavour') ?? null;
    const mode = interaction.options.getString('roll') ?? 'normal';

    if (!turnOrder.includes(target.id)) return interaction.reply({ content: '❌ That player is not in this fight.', ephemeral: true });
    if (target.id === uid) return interaction.reply({ content: '❌ You cannot target yourself.', ephemeral: true });

    const hpState = JSON.parse(fight.hp_state);
    if (hpState[target.id] !== undefined && hpState[target.id] <= 0) {
      return interaction.reply({ content: '❌ That player is already down.', ephemeral: true });
    }

    const char = getChar(gid, uid);
    const statVal = char?.[stat] ?? 0;
    let nat, total, rollLine;
    const modStr = statVal > 0 ? ` +${statVal}` : statVal < 0 ? ` ${statVal}` : '';

    if (mode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + statVal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (mode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + statVal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + statVal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }

    const member = await interaction.guild.members.fetch(uid).catch(()=>null);
    const name = member?.nickname || member?.user.username || uid;
    const targetMember = await interaction.guild.members.fetch(target.id).catch(()=>null);
    const targetName = targetMember?.nickname || targetMember?.user.username || target.id;

    const lines = [`**${name}** attacks **${targetName}** with ${STAT_LABELS[stat]}!`, rollLine];
    if (flavour) lines.push('', `*${flavour}*`);
    lines.push('', `🛡️ **${targetName}** — use \`/fight def\` to defend.`);

    upsertFight(gid, cid, {
      phase: 'defend', current_target: target.id,
      atk_roll: total, atk_nat: nat, atk_stat: stat, atk_mode: mode, atk_sides: 20,
      def_roll: null, def_nat: null, def_stat: null, def_mode: 'normal',
    });
    saveRoll(gid, cid, uid, `1d20+${statVal}`, `atk ${STAT_LABELS[stat]}`);
    return interaction.reply({ content: lines.join('\n') });
  }

  // ── DEF (normal / adv / dis) ──────────────────────────────────────────────
  if (sub === 'def') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: true });
    if (fight.phase !== 'defend') return interaction.reply({ content: '❌ No attack to defend against yet.', ephemeral: true });

    if (uid !== fight.current_target) {
      const member = await interaction.guild.members.fetch(fight.current_target).catch(()=>null);
      const name = member?.nickname || member?.user.username || 'the target';
      return interaction.reply({ content: `⚠️ **${name}** is the one defending.`, ephemeral: false });
    }

    const stat = interaction.options.getString('stat');
    const flavour = interaction.options.getString('flavour') ?? null;
    const mode = interaction.options.getString('roll') ?? 'normal';

    const char = getChar(gid, uid);
    const statVal = char?.[stat] ?? 0;
    const modStr = statVal > 0 ? ` +${statVal}` : statVal < 0 ? ` ${statVal}` : '';
    let nat, total, rollLine;

    if (mode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + statVal;
      rollLine = `🛡️  1d20+${STAT_LABELS[stat]} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (mode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + statVal;
      rollLine = `🛡️  1d20+${STAT_LABELS[stat]} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + statVal;
      rollLine = `🛡️  1d20+${STAT_LABELS[stat]} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }

    const member = await interaction.guild.members.fetch(uid).catch(()=>null);
    const name = member?.nickname || member?.user.username || uid;

    const lines = [`**${name}** defends with ${STAT_LABELS[stat]}!`, rollLine];
    if (flavour) lines.push('', `*${flavour}*`);
    lines.push('', '⚡ Use \`/fight resolve\` to resolve this exchange.');

    upsertFight(gid, cid, { def_roll: total, def_nat: nat, def_stat: stat, def_mode: mode, def_sides: 20 });
    saveRoll(gid, cid, uid, `1d20+${statVal}`, `def ${STAT_LABELS[stat]}`);
    return interaction.reply({ content: lines.join('\n') });
  }

  // ── REROLLS ────────────────────────────────────────────────────────────────
  if (sub === 'rr') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const isAttacker = turnOrder[fight.turn_index] === uid;
    const isDefender = fight.current_target === uid && fight.phase === 'defend';

    if (!isAttacker && !isDefender) return interaction.reply({ content: '❌ It is not your turn to reroll.', ephemeral: true });

    // Check reroll tokens
    const char = getChar(gid, uid);
    if (!char || char.rerolls_current <= 0) return interaction.reply({ content: '❌ No rerolls remaining.', ephemeral: true });
    upsertChar(gid, uid, { rerolls_current: char.rerolls_current - 1 });

    const mode = interaction.options.getString('roll') ?? 'normal';
    const stat = isAttacker ? fight.atk_stat : fight.def_stat;
    if (!stat) return interaction.reply({ content: '❌ No roll to reroll yet.', ephemeral: true });

    const statVal = char?.[stat] ?? 0;
    const modStr = statVal > 0 ? ` +${statVal}` : statVal < 0 ? ` ${statVal}` : '';
    let nat, total, rollLine;
    const icon = isAttacker ? '⚔️' : '🛡️';

    if (mode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + statVal;
      rollLine = `${icon}  1d20+${STAT_LABELS[stat]} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (mode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + statVal;
      rollLine = `${icon}  1d20+${STAT_LABELS[stat]} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + statVal;
      rollLine = `${icon}  1d20+${STAT_LABELS[stat]} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }

    const member = await interaction.guild.members.fetch(uid).catch(()=>null);
    const name = member?.nickname || member?.user.username || uid;
    const lines = [`**${name}** rerolls *(reroll)* — ${isAttacker ? 'attack' : 'defence'} with ${STAT_LABELS[stat]}!`, rollLine];
    lines.push('', '⚡ Use \`/fight resolve\` to resolve this exchange.');

    if (isAttacker) {
      upsertFight(gid, cid, { atk_roll: total, atk_nat: nat, atk_mode: mode });
    } else {
      upsertFight(gid, cid, { def_roll: total, def_nat: nat, def_mode: mode });
    }

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── RESOLVE ────────────────────────────────────────────────────────────────
  if (sub === 'resolve') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: true });
    if (fight.phase !== 'defend' || fight.def_roll === null) return interaction.reply({ content: '❌ Both attack and defend rolls needed before resolving.', ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const attackerId = turnOrder[fight.turn_index];
    const defenderId = fight.current_target;
    const hpState = JSON.parse(fight.hp_state);

    const { hit, dmg } = resolveDamage(
      fight.atk_roll, fight.atk_nat, 20,
      fight.def_roll, fight.def_nat, 20
    );

    const atkMember = await interaction.guild.members.fetch(attackerId).catch(()=>null);
    const defMember = await interaction.guild.members.fetch(defenderId).catch(()=>null);
    const atkName = atkMember?.nickname || atkMember?.user.username || attackerId;
    const defName = defMember?.nickname || defMember?.user.username || defenderId;

    const lines = ['─────────────────────────────', '⚔️  **Exchange Resolved**', ''];
    lines.push(`${atkName} (**${STAT_LABELS[fight.atk_stat]}**): ${fightTotalStr(fight.atk_roll, fight.atk_nat, 20)}`);
    lines.push(`${defName} (**${STAT_LABELS[fight.def_stat]}**): ${fightTotalStr(fight.def_roll, fight.def_nat, 20)}`);
    lines.push('');

    if (hit) {
      const prevHp = hpState[defenderId] ?? 0;
      const newHp = prevHp - dmg;
      hpState[defenderId] = newHp;
      // Also update character db
      upsertChar(gid, defenderId, { hp_current: newHp });
      lines.push(`💥 **${atkName}** hits **${defName}** for **${dmg}** damage!`);
      lines.push(`❤️ ${defName} HP: **${prevHp} → ${newHp}**`);

      if (newHp <= 0) {
        lines.push('', `💀 **${defName}** has been knocked down! HP: **${newHp}**`);
        // Remove from turn order
        const newOrder = turnOrder.filter(id => id !== defenderId);
        if (newOrder.length <= 1) {
          const winnerId = newOrder[0];
          const winMember = await interaction.guild.members.fetch(winnerId).catch(()=>null);
          const winName = winMember?.nickname || winMember?.user.username || winnerId;
          lines.push(`\n🏆 **${winName}** wins the fight!`);
          upsertFight(gid, cid, { state: 'idle', turn_order: '[]', hp_state: JSON.stringify(hpState) });
          return interaction.reply({ content: lines.join('\n') });
        }
        // Advance turn
        const newIndex = fight.turn_index % newOrder.length;
        const nextId = newOrder[newIndex];
        const nextMember = await interaction.guild.members.fetch(nextId).catch(()=>null);
        const nextName = nextMember?.nickname || nextMember?.user.username || nextId;
        lines.push(`\n🎯 **${nextName}**'s turn to attack!`);
        upsertFight(gid, cid, {
          turn_order: JSON.stringify(newOrder),
          turn_index: newIndex,
          phase: 'attack',
          current_target: null,
          atk_roll: null, atk_nat: null, atk_stat: null,
          def_roll: null, def_nat: null, def_stat: null,
          hp_state: JSON.stringify(hpState),
        });
        return interaction.reply({ content: lines.join('\n') });
      }
    } else {
      lines.push(`🛡️ **${defName}** blocks the attack! No damage.`);
    }

    // Advance turn to next active fighter
    let nextIndex = (fight.turn_index + 1) % turnOrder.length;
    // Skip downed fighters
    let safety = 0;
    while (hpState[turnOrder[nextIndex]] !== undefined && hpState[turnOrder[nextIndex]] <= 0 && safety < turnOrder.length) {
      nextIndex = (nextIndex + 1) % turnOrder.length;
      safety++;
    }
    const nextId = turnOrder[nextIndex];
    const nextMember = await interaction.guild.members.fetch(nextId).catch(()=>null);
    const nextName = nextMember?.nickname || nextMember?.user.username || nextId;
    lines.push(`\n🎯 **${nextName}**'s turn to attack!`);

    upsertFight(gid, cid, {
      turn_index: nextIndex,
      phase: 'attack',
      current_target: null,
      atk_roll: null, atk_nat: null, atk_stat: null,
      def_roll: null, def_nat: null, def_stat: null,
      hp_state: JSON.stringify(hpState),
    });

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── FORFEIT ────────────────────────────────────────────────────────────────
  if (sub === 'forfeit') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    if (!turnOrder.includes(uid)) return interaction.reply({ content: '❌ You are not in this fight.', ephemeral: true });

    const member = await interaction.guild.members.fetch(uid).catch(()=>null);
    const name = member?.nickname || member?.user.username || uid;
    const hpState = JSON.parse(fight.hp_state);

    // HP state preserved as-is
    const newOrder = turnOrder.filter(id => id !== uid);
    const lines = [`🏳️ **${name}** forfeits the fight! Their HP remains at **${hpState[uid] ?? 0}**.`];

    if (newOrder.length <= 1) {
      if (newOrder.length === 1) {
        const winMember = await interaction.guild.members.fetch(newOrder[0]).catch(()=>null);
        const winName = winMember?.nickname || winMember?.user.username || newOrder[0];
        lines.push(`🏆 **${winName}** wins!`);
      }
      upsertFight(gid, cid, { state: 'idle', turn_order: '[]' });
    } else {
      let newIndex = fight.turn_index % newOrder.length;
      const nextId = newOrder[newIndex];
      const nextMember = await interaction.guild.members.fetch(nextId).catch(()=>null);
      const nextName = nextMember?.nickname || nextMember?.user.username || nextId;
      lines.push(`🎯 Fight continues — **${nextName}**'s turn!`);
      upsertFight(gid, cid, {
        turn_order: JSON.stringify(newOrder),
        turn_index: newIndex,
        phase: 'attack',
        current_target: null,
        atk_roll: null, atk_nat: null, def_roll: null, def_nat: null,
      });
    }

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── STATUS ─────────────────────────────────────────────────────────────────
  if (sub === 'status') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight in this channel.', ephemeral: false });

    const turnOrder = JSON.parse(fight.turn_order);
    const hpState = JSON.parse(fight.hp_state);
    const currentId = turnOrder[fight.turn_index];

    const lines = ['⚔️ **Fight Status**', ''];
    for (let i = 0; i < turnOrder.length; i++) {
      const fid = turnOrder[i];
      const m = await interaction.guild.members.fetch(fid).catch(()=>null);
      const n = m?.nickname || m?.user.username || fid;
      const hp = hpState[fid] ?? '?';
      const arrow = fid === currentId ? ' ◀ current' : '';
      const char = getChar(gid, fid);
      const hpMax = char ? maxHp(char) : '?';
      lines.push(`${i+1}. **${n}** — ❤️ ${hp} / ${hpMax}${arrow}`);
    }
    lines.push('');
    lines.push(`Phase: **${fight.phase === 'attack' ? 'Waiting for attack' : 'Waiting for defence'}**`);
    if (fight.atk_roll) lines.push(`Latest attack roll: **${fight.atk_roll}** (${STAT_LABELS[fight.atk_stat] ?? '?'})`);
    if (fight.def_roll) lines.push(`Latest defence roll: **${fight.def_roll}** (${STAT_LABELS[fight.def_stat] ?? '?'})`);

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── END (GM only) ──────────────────────────────────────────────────────────
  if (sub === 'end') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can end a fight.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight to end.', ephemeral: true });
    return requestConfirm(interaction, 'End the current fight? Turn order clears but HP states are preserved.', async () => {
      upsertFight(gid, cid, { state: 'idle', turn_order: '[]' });
      return '🛑 Fight ended by GM. HP states preserved.';
    });
  }
}

async function handleSlashRoll(interaction) {
  const gid = interaction.guild.id;
  const uid = interaction.user.id;
  const rollType = interaction.options.getString('roll') ?? 'normal';
  const notation = interaction.options.getString('notation');
  const label = interaction.options.getString('label') ?? null;
  const flavour = interaction.options.getString('flavour') ?? null;
  const successCheck = interaction.options.getBoolean('success') ?? false;

  const isReroll = rollType === 'rr' || rollType === 'rra' || rollType === 'rrd';
  const mode = rollType === 'adv' || rollType === 'rra' ? 'adv'
             : rollType === 'dis' || rollType === 'rrd' ? 'dis'
             : 'normal';

  let finalNotation = notation;
  let finalLabel = label;
  let finalFlavour = flavour;

  if (isReroll) {
    const last = getLastRoll(gid, interaction.channel.id, uid);
    if (!last) return interaction.reply({ content: '❌ No previous roll found in this channel.', ephemeral: true });
    const char = getChar(gid, uid);
    if (!char || char.rerolls_current <= 0) return interaction.reply({ content: '❌ No rerolls remaining.', ephemeral: true });
    upsertChar(gid, uid, { rerolls_current: char.rerolls_current - 1 });
    finalNotation = last.notation;
    finalLabel = label || last.label;
  } else {
    // Stat quick roll
    if (notation && ['str','con','dex','wis','lck'].includes(notation.toLowerCase())) {
      const char = getChar(gid, uid);
      const statVal = char?.[notation.toLowerCase()] ?? 0;
      finalNotation = `1d20+${statVal}`;
      finalLabel = label || notation.toLowerCase();
    } else if (!notation) {
      return interaction.reply({ content: '❌ Please provide a dice notation e.g. 1d20+5', ephemeral: true });
    }
  }

  let result;
  if (mode === 'adv') result = rollAdvantage(finalNotation);
  else if (mode === 'dis') result = rollDisadvantage(finalNotation);
  else result = rollNotation(finalNotation);

  if (!result) return interaction.reply({ content: '❌ Could not parse dice notation.', ephemeral: true });

  saveRoll(gid, interaction.channel.id, uid, finalNotation, finalLabel);
  const critType = detectCrit(result, mode);
  const naturalRoll = mode === 'normal' ? result.rolls?.[0] : result.chosen;
  const successResult = successCheck ? getSuccessResult(result.total, naturalRoll, result.sides ?? 20) : null;
  const rollLine = buildRollLine(result, mode, critType, successResult);

  // Build flavour lines
  let cleanFlavour = null;
  if (finalFlavour) {
    cleanFlavour = finalFlavour.split('\n').map(l => l.trim()).filter(l => l.length > 0).join('\n\n');
  }

  const char = getChar(gid, uid);
  const profileEnabled = char?.profile_enabled === 1;
  let content;
  if (profileEnabled && char) {
    const cfg = getConfig(gid);
    const maxCharges = cfg.heal_charges ?? 3;
    const healRow = getHealCharges(gid, uid, maxCharges);
    const tags = getPlayerTags(gid, uid);
    let displayName = interaction.user.username;
    try { const m = await interaction.guild.members.fetch(uid); displayName = m.nickname || m.user.username; } catch {}
    content = buildRollEmbed({ rollLine, label: finalLabel, isReroll, char: { ...char, displayName }, healCharges: healRow.current, maxCharges, flavour: cleanFlavour, total: result.total, critType, tags, gid });
  } else {
    content = buildPlainRoll({ rollLine, label: finalLabel, isReroll, flavour: cleanFlavour, total: result.total, critType });
  }

  await interaction.reply({ content });
}

// ─────────────────────────────────────────────
//  NPC SYSTEM
// ─────────────────────────────────────────────

async function handleNpc(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const uid = interaction.user.id;

  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can manage NPCs.', ephemeral: true });

  if (sub === 'create' || sub === 'pr_create') {
    const name = interaction.options.getString('name');
    if (name.length > 50) return interaction.reply({ content: '❌ NPC name is too long (max 50 characters).', ephemeral: true });
    const str  = interaction.options.getInteger('str');
    const con  = interaction.options.getInteger('con');
    const dex  = interaction.options.getInteger('dex');
    const wis  = interaction.options.getInteger('wis');
    const lck  = interaction.options.getInteger('lck');
    for (const [n,v] of [['STR',str],['CON',con],['DEX',dex],['WIS',wis],['LCK',lck]]) {
      if (v !== null && (v < 0 || v > 99)) return interaction.reply({ content: `❌ ${n} must be between 0 and 99.`, ephemeral: true });
    }
    const order = interaction.options.getString('order') ?? null;
    upsertNpc(gid, name, { str, con, dex, wis, lck, order_name: order });
    const orderLine = order ? ` | ${KNIGHT_EMOJIS[order]??'⚪'} ${order}` : '';
    await interaction.reply({ content: `✅ NPC **${name}** created.${orderLine}\n💡 Upload an image to the NPC channel with \`${name}\` as the message text to set their avatar.` });
    registerSlashCommands(gid).catch(console.error);
  }

  if (sub === 'delete') {
    const name = interaction.options.getString('name');
    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });
    return requestConfirm(interaction, `Delete NPC **${name}**? This removes their stats and avatar permanently.`, async () => {
      // Delete webhook if exists
      if (npc.webhook_id && npc.webhook_token) {
        try {
          const { WebhookClient } = require('discord.js');
          const wh = new WebhookClient({ id: npc.webhook_id, token: npc.webhook_token });
          await wh.delete();
        } catch {}
      }
      deleteNpc(gid, name);
      registerSlashCommands(gid).catch(console.error);
      return `🗑️ NPC **${name}** deleted.`;
    });
  }

  if (sub === 'list') {
    const npcs = getAllNpcs(gid);
    if (!npcs.length) return interaction.reply({ content: '❌ No NPCs created yet. Use `/npc create` to add one.', ephemeral: true });
    const lines = ['**🎭 NPCs on this server:**', ''];
    npcs.forEach(n => {
      const order = n.order_name ? ` ${KNIGHT_EMOJIS[n.order_name]??'⚪'} ${n.order_name}` : '';
      const img = n.image_url ? ' 🖼️' : '';
      lines.push(`• **${n.name}**${order}${img} — STR ${n.str} CON ${n.con} DEX ${n.dex} WIS ${n.wis} LCK ${n.lck} | ❤️ ${n.hp_current}/${n.con+2}`);
    });
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'categorycreate') {
    const name = interaction.options.getString('name');
    createCategory(gid, name);
    await interaction.reply({ content: `✅ Category **${name}** created. Menus updating...` });
    registerSlashCommands(gid).catch(console.error);
    return;
  }
  if (sub === 'categorydelete') {
    const name = interaction.options.getString('name');
    if (!getCategories(gid).includes(name)) return interaction.reply({ content: `❌ Category **${name}** not found.`, ephemeral: true });
    return requestConfirm(interaction, `Delete category **${name}**? NPCs in it won't be deleted — they'll just become uncategorised.`, async () => {
      deleteCategory(gid, name);
      registerSlashCommands(gid).catch(console.error);
      return `🗑️ Category **${name}** deleted.`;
    });
  }
  if (sub === 'categorylist') {
    const cats = getCategories(gid);
    const uncategorised = getUncategorisedNpcs(gid);
    const lines2 = ['**📂 NPC Categories:**', ''];
    cats.forEach(c => { const m = getNpcsInCategory(gid, c); lines2.push(`• **${c}** (${m.length}): ${m.join(', ')||'empty'}`); });
    if (uncategorised.length) lines2.push(`• **Uncategorised** (${uncategorised.length}): ${uncategorised.join(', ')}`);
    return interaction.reply({ content: lines2.join('\n') });
  }
  if (sub === 'categoryassign') {
    const npcName = interaction.options.getString('npc');
    const category = interaction.options.getString('category');
    if (!getNpc(gid, npcName)) return interaction.reply({ content: `❌ NPC **${npcName}** not found.`, ephemeral: true });
    if (!getCategories(gid).includes(category)) return interaction.reply({ content: `❌ Category **${category}** not found.`, ephemeral: true });
    assignNpcToCategory(gid, npcName, category);
    await interaction.reply({ content: `✅ **${npcName}** added to **${category}**. Menus updating...` });
    registerSlashCommands(gid).catch(console.error);
    return;
  }
  if (sub === 'categoryremove') {
    const npcName = interaction.options.getString('npc');
    const category = interaction.options.getString('category');
    removeNpcFromCategory(gid, npcName, category);
    await interaction.reply({ content: `✅ **${npcName}** removed from **${category}**. Menus updating...` });
    registerSlashCommands(gid).catch(console.error);
    return;
  }
}

async function handlePr(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const uid = interaction.user.id;

  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can use NPC commands.', ephemeral: true });

  // Delegate create/delete/list to handleNpc
  if (sub === 'create' || sub === 'delete' || sub === 'list') {
    return handleNpc(interaction);
  }

  if (sub === 'reroll') {
    const name     = interaction.options.getString('name');
    const rollType = interaction.options.getString('roll') ?? 'normal';
    const mode     = rollType === 'adv' ? 'adv' : rollType === 'dis' ? 'dis' : 'normal';

    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });

    // Check NPC reroll tokens (based on LCK)
    if (npc.lck <= 0) return interaction.reply({ content: `❌ **${name}** has no reroll tokens (LCK is 0).`, ephemeral: true });

    // Get last roll for this NPC in this channel
    const last = getLastRoll(gid, interaction.channel.id, `npc_${name}`);
    if (!last) return interaction.reply({ content: `❌ No previous roll found for **${name}** in this channel.`, ephemeral: true });

    // Deduct reroll — track via hp_current field repurposed as reroll tracker
    // Actually use a separate counter: store in npc rerolls_used field
    // For simplicity track rerolls remaining as lck - used; decrement lck by 1 temporarily
    upsertNpc(gid, name, { lck: npc.lck - 1 });

    let result;
    if (mode === 'adv') result = rollAdvantage(last.notation);
    else if (mode === 'dis') result = rollDisadvantage(last.notation);
    else result = rollNotation(last.notation);
    if (!result) return interaction.reply({ content: '❌ Could not reroll.', ephemeral: true });

    const updatedNpc = getNpc(gid, name);
    saveRoll(gid, interaction.channel.id, `npc_${name}`, last.notation, last.label);

    const critType = detectCrit(result, mode);
    const rollLine = buildRollLine(result, mode, critType, null);
    const lines = [];
    if (last.label) lines.push(`${critPrefix(critType)}**${last.label}** *(reroll)*`);
    else lines.push('*(reroll)*');
    lines.push(rollLine, '');
    lines.push('─────────────────────────────');
    lines.push(`⚔️  ${npc.name}`);
    if (npc.order_name) lines.push(`${KNIGHT_EMOJIS[npc.order_name]??'⚪'}  ${npc.order_name}`);
    lines.push(`❤️  HP${pad(npc.hp_current)} / ${npc.con + 2}`);
    lines.push(`🔄  Rerolls${pad(updatedNpc.lck)} / ${npc.lck}`);
    lines.push('');
    lines.push(`💪  STR${pad(npc.str)}`);
    lines.push(`🫀  CON${pad(npc.con)}`);
    lines.push(`⚡  DEX${pad(npc.dex)}`);
    lines.push(`🧠  WIS${pad(npc.wis)}`);
    lines.push(`🍀  LCK${pad(updatedNpc.lck)}`);

    const content2 = lines.join('\n');

    try {
      const { WebhookClient } = require('discord.js');
      await interaction.deferReply({ ephemeral: true });
      let webhookClient;
      if (npc.webhook_id && npc.webhook_token) {
        webhookClient = new WebhookClient({ id: npc.webhook_id, token: npc.webhook_token });
      } else {
        const webhook = await interaction.channel.createWebhook({ name: npc.name, avatar: npc.image_url ?? BLANK_AVATAR, reason: `NPC webhook for ${npc.name}` });
        setNpcWebhook(gid, npc.name, webhook.id, webhook.token);
        webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
      }
      await webhookClient.send({ content: content2, username: npc.name, avatarURL: npc.image_url ?? BLANK_AVATAR });
      return interaction.editReply({ content: `✅ Rerolled as **${npc.name}**. Rerolls remaining: ${updatedNpc.lck}` });
    } catch (err) {
      console.error('Webhook error:', err);
      return interaction.reply({ content: content2 });
    }
  }

  if (sub === 'roll') {
    const category = interaction.options.getString('category') ?? 'all';
    const name     = interaction.options.getString('name');
    const notationRaw = interaction.options.getString('notation') ?? '1d20';
    const stat     = interaction.options.getString('stat') ?? null;

    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });

    // Validate NPC is in selected category
    if (category !== 'all') {
      const npcCats = getCategoriesForNpc(gid, name);
      const inCategory = category === 'Uncategorised' ? npcCats.length === 0 : npcCats.includes(category);
      if (!inCategory) return interaction.reply({ content: `❌ **${name}** is not in the **${category}** category.`, ephemeral: true });
    }
    const labelRaw = interaction.options.getString('label') ?? null;
    const flavour  = interaction.options.getString('flavour') ?? null;
    const rollType = interaction.options.getString('roll') ?? 'normal';
    const mode     = rollType === 'adv' ? 'adv' : rollType === 'dis' ? 'dis' : 'normal';
    // Combine stat and label: stat first, then label, separated by ' — '
    const label = stat && labelRaw ? `${stat} — ${labelRaw}` : stat ?? labelRaw ?? null;

    // Apply stat modifier to notation
    let notation = notationRaw;
    if (stat) {
      const statKey = stat.toLowerCase();
      const statVal = npc[statKey] ?? 0;
      if (statVal !== 0) {
        // Check if notation already has a modifier
        if (/[+-]\d+$/.test(notation)) {
          notation = notation + (statVal >= 0 ? `+${statVal}` : `${statVal}`);
        } else {
          notation = notation + (statVal >= 0 ? `+${statVal}` : `${statVal}`);
        }
      }
    }

    let result;
    if (mode === 'adv') result = rollAdvantage(notation);
    else if (mode === 'dis') result = rollDisadvantage(notation);
    else result = rollNotation(notation);
    if (!result) return interaction.reply({ content: '❌ Invalid dice notation.', ephemeral: true });

    const critType = detectCrit(result, mode);
    const rollLine = buildRollLine(result, mode, critType, null);

    // Build embed text
    const lines = [];
    if (label) lines.push(`${critPrefix(critType)}**${label}**`);
    lines.push(rollLine);
    lines.push('');
    lines.push('─────────────────────────────');
    lines.push(`⚔️  ${npc.name}`);
    if (npc.order_name) lines.push(`${KNIGHT_EMOJIS[npc.order_name]??'⚪'}  ${npc.order_name}`);
    lines.push(`❤️  HP${pad(npc.hp_current)} / ${npc.con + 2}`);
    lines.push(`🔄  Rerolls${pad(npc.lck)} / ${npc.lck}`);
    lines.push('');
    lines.push(`💪  STR${pad(npc.str)}`);
    lines.push(`🫀  CON${pad(npc.con)}`);
    lines.push(`⚡  DEX${pad(npc.dex)}`);
    lines.push(`🧠  WIS${pad(npc.wis)}`);
    lines.push(`🍀  LCK${pad(npc.lck)}`);
    if (flavour) {
      lines.push('');
      lines.push('─────────────────────────────');
      lines.push(`**${label??'roll'}** — ${totalStr(result.total, critType)}`);
      lines.push(flavour);
    }
    const content = lines.join('\n');

    // Save roll history for NPC reroll
    saveRoll(gid, interaction.channel.id, `npc_${npc.name}`, notation, label);

    // Get or create webhook for this NPC
    let webhookClient;
    try {
      const { WebhookClient } = require('discord.js');
      if (npc.webhook_id && npc.webhook_token) {
        webhookClient = new WebhookClient({ id: npc.webhook_id, token: npc.webhook_token });
      } else {
        // Create a new webhook in this channel
        const webhook = await interaction.channel.createWebhook({
          name: npc.name,
          avatar: npc.image_url ?? BLANK_AVATAR,
          reason: `NPC webhook for ${npc.name}`,
        });
        setNpcWebhook(gid, npc.name, webhook.id, webhook.token);
        webhookClient = new WebhookClient({ id: webhook.id, token: webhook.token });
      }

      await interaction.deferReply({ ephemeral: true });
      await webhookClient.send({
        content,
        username: npc.name,
        avatarURL: npc.image_url ?? BLANK_AVATAR,
      });
      return interaction.editReply({ content: `✅ Posted as **${npc.name}**.` });
    } catch (err) {
      console.error('Webhook error:', err);
      // Fallback to regular reply if webhook fails
      await interaction.reply({ content });
    }
  }
}


// ─────────────────────────────────────────────
//  WEAPON SYSTEM
// ─────────────────────────────────────────────

async function handleWeapon(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const uid = interaction.user.id;

  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can manage the weapon list.', ephemeral: true });

  if (sub === 'add') {
    const name = interaction.options.getString('name');
    addWeapon(gid, name);
    await interaction.reply({ content: `✅ **${name}** added to the weapon list. Menus updating...` });
    registerSlashCommands(gid).catch(console.error);
    return;
  }
  if (sub === 'remove') {
    const name = interaction.options.getString('name');
    if (!getWeapons(gid).includes(name)) return interaction.reply({ content: `❌ **${name}** isn't in the weapon list.`, ephemeral: true });
    return requestConfirm(interaction, `Remove **${name}** from the server weapon list?`, async () => {
      removeWeapon(gid, name);
      registerSlashCommands(gid).catch(console.error);
      return `🗑️ **${name}** removed from the weapon list.`;
    });
  }
  if (sub === 'list') {
    const weapons = getWeapons(gid);
    if (!weapons.length) return interaction.reply({ content: '❌ No weapons added yet. Use `/weapon add` to add one.', ephemeral: true });
    return interaction.reply({ content: `**⚔️ Server Weapons:**\n${weapons.map(w=>`• ${w}`).join('\n')}` });
  }
}

// ─────────────────────────────────────────────
//  HELP COMMAND
// ─────────────────────────────────────────────

const HELP_CATEGORIES = {
  dice: {
    title: '🎲 Dice Rolling',
    body: [
      '`1d20` or `r1d20+5` — roll dice (prefix `r`, `!r`, `!roll`, or bare notation)',
      '`r1d20+5 label` — add a label; new lines become *italic* / **bold** flavour',
      '`ra1d20+5` — roll with **advantage** (drops lowest)',
      '`rd1d20+5` — roll with **disadvantage** (drops highest)',
      '`rr` / `rra` / `rrd` — reroll (costs a token)',
      '`r str` / `con` / `dex` / `wis` / `lck` — quick stat roll',
      '`?1d20+5` — success check (crit/success/fail tiers)',
      '`/dr` — slash version with dropdowns for roll type & success',
    ],
  },
  character: {
    title: '📜 Character Sheet',
    body: [
      '`/char create` — set up a full character at once (stats, order, class, weapons, weapon emojis)',
      '`/char set field:STR value:14` — set one field at a time',
      '`/char weaponemoji slot:Weapon 1 emoji:⚔️` — pick a weapon slot emoji',
      '`/char show [user]` — view a character sheet',
      '`/char export [format:Image]` — export your sheet as text or image',
      '`/profile on/off/show/save/load/saves` — manage profile display & snapshots',
      '`/weapon add/remove/list` — manage the server weapon list (GM)',
    ],
  },
  hp: {
    title: '❤️ HP, Healing & Rerolls',
    body: [
      '`!hp +5` / `!hp -3` — adjust your HP (or `!hp @user +5`)',
      '`!heal @user` / `!h @user` — White Knight heal (WIS ≥ 5 only)',
      '`!rerolls +1` / `!rerolls @user -1` — adjust reroll tokens',
      '`lrest` — full rest (HP, rerolls, heal) · `srest` — short rest (HP only by default) · `hpfull` / `hphalf` — set HP',
    ],
  },
  fight: {
    title: '⚔️ Fights',
    body: [
      '`/fight start @p1 @p2 npc:Name` — begin a fight',
      '`/fight atk stat:str target:@user` — attack',
      '`/fight def stat:dex` — defend',
      '`/fight rr` — reroll (costs a token) · `/fight resolve` — resolve a clash',
      '`/fight status` — show current fight · `/fight forfeit` — drop out',
      '`/fight end` — end the fight (GM)',
    ],
  },
  npc: {
    title: '🎭 NPCs',
    body: [
      '`/npc create name:X str:N ...` — create an NPC (GM)',
      '`/npc list` · `/npc delete name:X`',
      '`/npc categorycreate/categorydelete/categorylist` — manage categories',
      '`/npc categoryassign/categoryremove` — sort NPCs into categories',
      '`/pr roll category:X name:Y notation:1d20 stat:STR` — roll as an NPC',
      '`/pr reroll name:X` — reroll an NPC roll (costs a token)',
      '💡 Upload an image to the NPC channel with the NPC name to set an avatar',
    ],
  },
  tags: {
    title: '🏷️ Tags',
    body: [
      '`/tag assign user:@player tag:X` — give a player a tag (GM)',
      '`/tag remove user:@player tag:X` — remove a tag',
      '`/tag list` — show all tags',
      '`/tag custom action:Create emoji:⚜️ name:MyTag` — manage custom tags',
    ],
  },
  gm: {
    title: '🛠️ GM & Config',
    body: [
      '`/config gmrole @role` — set the GM role',
      '`/config heal charges:N` — set default heal charges',
      '`/config npcchannel #channel` — set the NPC avatar channel',
      '`/config rest type:Short Rest hp:50% rerolls:0%` — tune what a rest restores (use % of max or a flat number)',
      '`/config cleanwebhooks` — remove orphaned NPC webhooks',
      '`gmr` / `gmrs 1d20+5` — public / secret GM roll',
      '`/backup now` — export the database · `/backup auto` — daily backups',
      '`/stat` — show stat descriptions · `/help` — this menu',
    ],
  },
};

async function handleHelp(interaction) {
  const cat = interaction.options.getString('category');
  if (cat && HELP_CATEGORIES[cat]) {
    const c = HELP_CATEGORIES[cat];
    return interaction.reply({ content: `**${c.title}**\n${c.body.join('\n')}`, ephemeral: true });
  }
  // Overview of all categories
  const lines = ['**🎲 DDice — Command Help**', '', 'Use `/help category:X` for details on each group.', ''];
  for (const key of Object.keys(HELP_CATEGORIES)) {
    const c = HELP_CATEGORIES[key];
    lines.push(`${c.title} — \`/help category:${key}\``);
  }
  lines.push('', '_Most dice commands also work with the `r` prefix or bare notation (e.g. `1d20`)._');
  return interaction.reply({ content: lines.join('\n'), ephemeral: true });
}

// ─────────────────────────────────────────────
//  LAST ROLL COMMAND
// ─────────────────────────────────────────────

async function handleLastRoll(interaction) {
  const gid = interaction.guild.id;
  const uid = interaction.user.id;
  const last = getLastRoll(gid, interaction.channel.id, uid);
  if (!last) return interaction.reply({ content: '❌ You haven\'t rolled anything in this channel yet.', ephemeral: true });
  const label = last.label ? ` *(${last.label})*` : '';
  return interaction.reply({ content: `🎲 Your last roll here: \`${last.notation}\`${label}\n_Rolled at ${last.saved_at} UTC._\nUse \`rr\` to reroll it (costs a token).`, ephemeral: true });
}

// ─────────────────────────────────────────────
//  BACKUP SYSTEM
// ─────────────────────────────────────────────

async function handleBackup(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const uid = interaction.user.id;

  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can manage backups.', ephemeral: true });

  if (sub === 'now') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const { AttachmentBuilder } = require('discord.js');
      const dbPath = DB_PATH;
      const fs = require('fs');
      if (!fs.existsSync(dbPath)) return interaction.editReply({ content: '❌ Database file not found.' });
      const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
      const attachment = new AttachmentBuilder(dbPath, { name: `ddice-backup-${stamp}.db` });
      await interaction.editReply({ content: `✅ Database backup (${(fs.statSync(dbPath).size/1024).toFixed(1)} KB). Save this file somewhere safe.`, files: [attachment] });
    } catch (err) {
      console.error('Backup error:', err);
      return interaction.editReply({ content: `❌ Backup failed: ${err.message}` });
    }
    return;
  }

  if (sub === 'auto') {
    const raw = interaction.options.getString('channel');
    if (raw.toLowerCase() === 'off') {
      setConfig(gid, { backup_channel_id: null });
      return interaction.reply({ content: '✅ Daily automatic backups disabled.', ephemeral: true });
    }
    const channelId = raw.replace(/[<#>]/g, '').trim();
    setConfig(gid, { backup_channel_id: channelId });
    return interaction.reply({ content: `✅ Daily automatic backups enabled — will post to <#${channelId}> every 24 hours.`, ephemeral: true });
  }
}

// Daily automatic backup task
function startBackupScheduler() {
  setInterval(async () => {
    try {
      const fs = require('fs');
      const { AttachmentBuilder } = require('discord.js');
      const dbPath = DB_PATH;
      if (!fs.existsSync(dbPath)) return;
      const rows = db.prepare('SELECT guild_id, backup_channel_id FROM guild_config WHERE backup_channel_id IS NOT NULL').all();
      for (const row of rows) {
        try {
          const ch = await client.channels.fetch(row.backup_channel_id);
          if (!ch) continue;
          const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
          const attachment = new AttachmentBuilder(dbPath, { name: `ddice-backup-${stamp}.db` });
          await ch.send({ content: `🗄️ Daily automatic backup — ${new Date().toUTCString()}`, files: [attachment] });
        } catch (e) { console.error('Auto-backup failed for guild', row.guild_id, e.message); }
      }
    } catch (err) { console.error('Backup scheduler error:', err.message); }
  }, 24 * 60 * 60 * 1000); // every 24 hours
}

// ─────────────────────────────────────────────
//  CONFIRMATION BUTTON SYSTEM
// ─────────────────────────────────────────────

// Pending destructive actions keyed by a short token
const pendingConfirms = new Map();

function makeConfirmButtons(token) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`confirm:${token}`).setLabel('Confirm').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  return row;
}

// Ask for confirmation. `action` is an async fn run if confirmed.
async function requestConfirm(interaction, promptText, action) {
  const token = `${interaction.user.id}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  pendingConfirms.set(token, { action, userId: interaction.user.id, expires: Date.now() + 60000 });
  // Auto-expire after 60s
  setTimeout(() => pendingConfirms.delete(token), 60000);
  await interaction.reply({ content: `⚠️ ${promptText}`, components: [makeConfirmButtons(token)], ephemeral: true });
}

async function handleConfirmButton(interaction) {
  const [decision, token] = interaction.customId.split(':');
  const pending = pendingConfirms.get(token);

  if (!pending) {
    return interaction.update({ content: '⏰ This confirmation has expired. Please run the command again.', components: [] }).catch(()=>{});
  }
  if (interaction.user.id !== pending.userId) {
    return interaction.reply({ content: '❌ This confirmation isn\'t for you.', ephemeral: true }).catch(()=>{});
  }

  pendingConfirms.delete(token);

  if (decision === 'cancel') {
    return interaction.update({ content: '❌ Cancelled — nothing was changed.', components: [] }).catch(()=>{});
  }

  // Confirmed — run the action
  try {
    await interaction.update({ content: '⏳ Working...', components: [] });
    const result = await pending.action();
    await interaction.editReply({ content: result || '✅ Done.', components: [] });
  } catch (err) {
    console.error('Confirm action error:', err);
    await interaction.editReply({ content: `❌ Action failed: ${err.message}`, components: [] }).catch(()=>{});
  }
}
