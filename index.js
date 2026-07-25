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
try { db.exec('ALTER TABLE fights ADD COLUMN auto_npc INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN rr_state TEXT DEFAULT '{}'"); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN npc_rr_threshold INTEGER DEFAULT 8'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN fight_ping INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN roll_audit_channel_id TEXT'); } catch {}
try { db.exec('ALTER TABLE characters ADD COLUMN signature_stat TEXT'); } catch {}
try { db.exec('ALTER TABLE npcs ADD COLUMN class TEXT'); } catch {}
try { db.exec('ALTER TABLE npcs ADD COLUMN signature_stat TEXT'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN gm_role_ids TEXT'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN approval_channel_id TEXT'); } catch {}
try { db.exec('ALTER TABLE characters ADD COLUMN approval_state TEXT'); } catch {}
try { db.exec('ALTER TABLE characters ADD COLUMN approval_msg_id TEXT'); } catch {}
try { db.exec('ALTER TABLE characters ADD COLUMN approval_src_channel TEXT'); } catch {}
try { db.exec('ALTER TABLE guild_config ADD COLUMN npc_stats_visible INTEGER DEFAULT 0'); } catch {}
try {
  // Webhooks are bound to the channel they were created in. Storing one per NPC
  // meant every later roll posted back to the ORIGINAL channel, wherever the
  // command was actually run. Key them by channel instead.
  db.exec(`CREATE TABLE IF NOT EXISTS npc_webhooks (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    npc_name TEXT NOT NULL,
    webhook_id TEXT NOT NULL,
    webhook_token TEXT NOT NULL,
    avatar_url TEXT,
    PRIMARY KEY (guild_id, channel_id, npc_name)
  )`);
  try { db.exec('ALTER TABLE npc_webhooks ADD COLUMN avatar_url TEXT'); } catch {}
} catch (e) { console.error('npc_webhooks schema', e); }
try { db.exec("ALTER TABLE fights ADD COLUMN log_state TEXT DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN effect_state TEXT DEFAULT '{}'"); } catch {}
try {
  // Unified event log for merit changes (kind='merit'). Amount is signed; reason
  // is free text; quest_number links quest-driven awards. Read by /merit history.
  db.exec(`CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT,
    amount INTEGER,
    reason TEXT,
    quest_number INTEGER,
    actor_id TEXT,
    created_at INTEGER NOT NULL
  )`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_guild_user ON history (guild_id, user_id, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_history_guild_kind ON history (guild_id, kind, id)');
  // Last finished fight per channel, so a GM can re-post the recap with /fight log.
  db.exec(`CREATE TABLE IF NOT EXISTS fight_archive (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    log_state TEXT NOT NULL DEFAULT '{}',
    roster TEXT NOT NULL DEFAULT '[]',
    ended_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  )`);
} catch (e) { console.error('history schema', e); }
try { db.exec('ALTER TABLE characters ADD COLUMN merits INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE characters ADD COLUMN rank_name TEXT'); } catch {}
try {
  db.exec(`CREATE TABLE IF NOT EXISTS ranks (
    guild_id TEXT NOT NULL,
    name TEXT NOT NULL,
    threshold INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, name)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS quests (
    guild_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    name TEXT NOT NULL,
    lore TEXT,
    objectives TEXT,
    details TEXT,
    rewards TEXT,
    merit_reward INTEGER NOT NULL DEFAULT 0,
    party_size INTEGER,
    party_hard INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open',
    run_channel_id TEXT,
    post_channel_id TEXT,
    post_message_id TEXT,
    created_by TEXT,
    created_at INTEGER,
    PRIMARY KEY (guild_id, number)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS quest_members (
    guild_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    user_id TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'applied',
    PRIMARY KEY (guild_id, number, user_id)
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS quest_counter (
    guild_id TEXT NOT NULL PRIMARY KEY,
    last INTEGER NOT NULL DEFAULT 0
  )`);
} catch (e) { console.error('quest schema', e); }

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
  CREATE TABLE IF NOT EXISTS export_requests (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    payload TEXT NOT NULL, fmt TEXT NOT NULL DEFAULT 'text',
    src_channel TEXT, msg_id TEXT, requested_at INTEGER,
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
    effect_state TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (guild_id, channel_id)
  );
`);

// Columns added to `fights` after it first shipped. These sit AFTER the CREATE
// above (not with the migrations at the top of the file) because on a brand-new
// database the top-of-file ALTERs run before the table exists and are swallowed,
// leaving a fresh install without auto_npc / rr_state / log_state.
try { db.exec('ALTER TABLE fights ADD COLUMN auto_npc INTEGER DEFAULT 0'); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN rr_state TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN log_state TEXT NOT NULL DEFAULT '{}'"); } catch {}
try { db.exec("ALTER TABLE fights ADD COLUMN effect_state TEXT NOT NULL DEFAULT '{}'"); } catch {}
// Practice bouts: HP at or below which a fighter bows out. 0 = a real fight.
try { db.exec('ALTER TABLE fights ADD COLUMN floor_hp INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE fight_archive ADD COLUMN floor_hp INTEGER DEFAULT 0'); } catch {}

function getChar(gid, uid) {
  return db.prepare('SELECT * FROM characters WHERE guild_id=? AND user_id=?').get(gid, uid);
}
// Mirror a fighter's new sheet HP into any active fight that contains them,
// so mid-fight heals / GM adjustments aren't overwritten on the next resolve.
function syncFightHp(gid, fid, newHp) {
  const fights = db.prepare("SELECT channel_id, hp_state FROM fights WHERE guild_id=? AND state='active'").all(gid);
  for (const f of fights) {
    const hpState = JSON.parse(f.hp_state || '{}');
    if (Object.prototype.hasOwnProperty.call(hpState, fid)) {
      hpState[fid] = newHp;
      db.prepare('UPDATE fights SET hp_state=? WHERE guild_id=? AND channel_id=?')
        .run(JSON.stringify(hpState), gid, f.channel_id);
    }
  }
}

// ── History / audit log ───────────────────────────────────────────────────────
// One row per meaningful event. kind='merit' for now; the shape is generic so
// other event kinds can be added later without a migration.
function logHistory(gid, { kind, userId = null, amount = null, reason = null, questNumber = null, actorId = null }) {
  db.prepare(`INSERT INTO history (guild_id, kind, user_id, amount, reason, quest_number, actor_id, created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(gid, kind, userId, amount, reason, questNumber, actorId, Date.now());
}
// Recent merit events for one player, newest first.
function getMeritHistory(gid, uid, limit = 20) {
  return db.prepare("SELECT * FROM history WHERE guild_id=? AND kind='merit' AND user_id=? ORDER BY id DESC LIMIT ?").all(gid, uid, limit);
}
// Recent merit events server-wide, newest first.
function getRecentMeritHistory(gid, limit = 20) {
  return db.prepare("SELECT * FROM history WHERE guild_id=? AND kind='merit' ORDER BY id DESC LIMIT ?").all(gid, limit);
}

// ── Fight archive (last finished fight per channel, for /fight log) ────────────
function archiveFight(gid, cid, logState, roster, floor = 0) {
  db.prepare(`INSERT INTO fight_archive (guild_id, channel_id, log_state, roster, ended_at, floor_hp)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(guild_id, channel_id) DO UPDATE SET log_state=excluded.log_state, roster=excluded.roster, ended_at=excluded.ended_at, floor_hp=excluded.floor_hp`)
    .run(gid, cid, JSON.stringify(logState || {}), JSON.stringify(roster || []), Date.now(), floor || 0);
}
function getArchivedFight(gid, cid) {
  return db.prepare('SELECT * FROM fight_archive WHERE guild_id=? AND channel_id=?').get(gid, cid);
}

// ── Quest archive read (completed quests a player was on) ──────────────────────
function getPlayerCompletedQuests(gid, uid) {
  return db.prepare(`SELECT q.number, q.name, q.merit_reward
                     FROM quests q JOIN quest_members m
                     ON q.guild_id=m.guild_id AND q.number=m.number
                     WHERE q.guild_id=? AND m.user_id=? AND m.state='party' AND q.status='completed'
                     ORDER BY q.number DESC`).all(gid, uid);
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
  if ('hp_current' in fields) syncFightHp(gid, uid, fields.hp_current);
  return getChar(gid, uid);
}

// ── Merits & ranks ───────────────────────────────────────────────────────────
function getMerits(gid, uid) {
  return getChar(gid, uid)?.merits ?? 0;
}
// Change a player's merit total by delta (can be negative). Ensures a character row exists.
function addMerits(gid, uid, delta) {
  const ch = getChar(gid, uid);
  const cur = ch?.merits ?? 0;
  const next = Math.max(0, cur + delta);
  upsertChar(gid, uid, { merits: next });
  return next;
}
function getRanks(gid) {
  return db.prepare('SELECT name, threshold, sort_order FROM ranks WHERE guild_id=? ORDER BY sort_order, threshold').all(gid);
}
function setRank(gid, name, threshold, sortOrder) {
  const ex = db.prepare('SELECT name FROM ranks WHERE guild_id=? AND name=?').get(gid, name);
  if (ex) db.prepare('UPDATE ranks SET threshold=?, sort_order=? WHERE guild_id=? AND name=?').run(threshold, sortOrder, gid, name);
  else db.prepare('INSERT INTO ranks (guild_id, name, threshold, sort_order) VALUES (?,?,?,?)').run(gid, name, threshold, sortOrder);
}
function removeRank(gid, name) {
  return db.prepare('DELETE FROM ranks WHERE guild_id=? AND name=?').run(gid, name).changes;
}
// Given a merit total, the highest rank whose threshold is met, and the next rank (if any).
function rankProgress(gid, merits) {
  const ranks = getRanks(gid); // ascending by sort/threshold
  let current = null, next = null;
  for (const r of ranks) {
    if (merits >= r.threshold) current = r;
    else { next = r; break; }
  }
  return { current, next, ranks };
}

// ── Quests ───────────────────────────────────────────────────────────────────
function nextQuestNumber(gid) {
  const row = db.prepare('SELECT last FROM quest_counter WHERE guild_id=?').get(gid);
  const next = (row?.last ?? 0) + 1;
  if (row) db.prepare('UPDATE quest_counter SET last=? WHERE guild_id=?').run(next, gid);
  else db.prepare('INSERT INTO quest_counter (guild_id, last) VALUES (?,?)').run(gid, next);
  return next;
}
function createQuest(gid, fields) {
  const number = nextQuestNumber(gid);
  db.prepare(`INSERT INTO quests
    (guild_id, number, name, lore, objectives, details, rewards, merit_reward, party_size, party_hard, status, run_channel_id, post_channel_id, post_message_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    gid, number, fields.name, fields.lore ?? null, fields.objectives ?? null, fields.details ?? null,
    fields.rewards ?? null, fields.merit_reward ?? 0, fields.party_size ?? null, fields.party_hard ? 1 : 0,
    'open', fields.run_channel_id ?? null, fields.post_channel_id ?? null, null, fields.created_by ?? null, Date.now());
  return number;
}
function getQuest(gid, number) {
  return db.prepare('SELECT * FROM quests WHERE guild_id=? AND number=?').get(gid, number);
}
function updateQuest(gid, number, fields) {
  const sets = Object.keys(fields).map(k => `${k}=?`).join(',');
  db.prepare(`UPDATE quests SET ${sets} WHERE guild_id=? AND number=?`).run(...Object.values(fields), gid, number);
  return getQuest(gid, number);
}
function deleteQuest(gid, number) {
  db.prepare('DELETE FROM quest_members WHERE guild_id=? AND number=?').run(gid, number);
  return db.prepare('DELETE FROM quests WHERE guild_id=? AND number=?').run(gid, number).changes;
}
function listQuests(gid, status) {
  if (status) return db.prepare('SELECT * FROM quests WHERE guild_id=? AND status=? ORDER BY number').all(gid, status);
  return db.prepare('SELECT * FROM quests WHERE guild_id=? ORDER BY number').all(gid);
}
function getQuestMembers(gid, number, state) {
  if (state) return db.prepare('SELECT user_id FROM quest_members WHERE guild_id=? AND number=? AND state=?').all(gid, number, state).map(r => r.user_id);
  return db.prepare('SELECT user_id, state FROM quest_members WHERE guild_id=? AND number=?').all(gid, number);
}
function setQuestMember(gid, number, uid, state) {
  const ex = db.prepare('SELECT user_id FROM quest_members WHERE guild_id=? AND number=? AND user_id=?').get(gid, number, uid);
  if (ex) db.prepare('UPDATE quest_members SET state=? WHERE guild_id=? AND number=? AND user_id=?').run(state, gid, number, uid);
  else db.prepare('INSERT INTO quest_members (guild_id, number, user_id, state) VALUES (?,?,?,?)').run(gid, number, uid, state);
}
function removeQuestMember(gid, number, uid) {
  return db.prepare('DELETE FROM quest_members WHERE guild_id=? AND number=? AND user_id=?').run(gid, number, uid).changes;
}
// "#001-Goblin Cave"
function questTag(quest) {
  return `#${String(quest.number).padStart(3, '0')}-${quest.name}`;
}
// "12 Jan 2026" — for history timestamps (epoch ms)
function formatHistDate(ms) {
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
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
  // Exact match first, then fall back to case-insensitive so "goblin" finds "Goblin"
  let row = db.prepare('SELECT * FROM npcs WHERE guild_id=? AND name=?').get(gid, name);
  if (!row && name) {
    row = db.prepare('SELECT * FROM npcs WHERE guild_id=? AND LOWER(name)=LOWER(?)').get(gid, name);
  }
  return row;
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
  if ('hp_current' in fields) {
    const canonical = getNpc(gid, name)?.name ?? name;
    syncFightHp(gid, npcFighterId(canonical), fields.hp_current);
  }
  return getNpc(gid, name);
}
function deleteNpc(gid, name) {
  db.prepare('DELETE FROM npcs WHERE guild_id=? AND name=?').run(gid, name);
}
function setNpcImage(gid, name, url) {
  db.prepare('UPDATE npcs SET image_url=? WHERE guild_id=? AND name=?').run(url, gid, name);
}
// Per-channel webhook lookup. Falls back to nothing if the NPC has never
// posted in this channel before, so a fresh one gets made here.
function getNpcWebhookFor(gid, channelId, name) {
  return db.prepare('SELECT webhook_id, webhook_token, avatar_url FROM npc_webhooks WHERE guild_id=? AND channel_id=? AND npc_name=?')
    .get(gid, channelId, name);
}
function setNpcWebhookFor(gid, channelId, name, webhookId, webhookToken, avatarUrl = null) {
  db.prepare(`INSERT INTO npc_webhooks (guild_id, channel_id, npc_name, webhook_id, webhook_token, avatar_url)
              VALUES (?,?,?,?,?,?)
              ON CONFLICT(guild_id, channel_id, npc_name)
              DO UPDATE SET webhook_id=excluded.webhook_id, webhook_token=excluded.webhook_token, avatar_url=excluded.avatar_url`)
    .run(gid, channelId, name, webhookId, webhookToken, avatarUrl);
}
function clearNpcWebhooks(gid, name) {
  db.prepare('DELETE FROM npc_webhooks WHERE guild_id=? AND npc_name=?').run(gid, name);
}

// Resolve (or create) the webhook this NPC should use in THIS channel.
async function npcWebhookIn(channel, gid, npcName, imageUrl) {
  const { WebhookClient } = require('discord.js');
  const row = getNpcWebhookFor(gid, channel.id, npcName);

  if (row?.webhook_id && row?.webhook_token) {
    // The NPC's avatar may have been set (or changed) after this webhook was
    // created. A token-only WebhookClient can't edit the avatar, so recreate
    // the webhook instead — cheap, and guaranteed to carry the right image.
    if ((row.avatar_url ?? null) !== (imageUrl ?? null)) {
      try {
        const fresh = await channel.createWebhook({
          name: npcName,
          avatar: imageUrl ?? BLANK_AVATAR,
          reason: `NPC avatar refresh for ${npcName}`,
        });
        // Bin the stale one — a channel is capped at 15 webhooks.
        try { await new WebhookClient({ id: row.webhook_id, token: row.webhook_token }).delete(); } catch {}
        setNpcWebhookFor(gid, channel.id, npcName, fresh.id, fresh.token, imageUrl ?? null);
        return new WebhookClient({ id: fresh.id, token: fresh.token });
      } catch (e) {
        // Couldn't recreate (permissions, or the 15-webhook channel cap) —
        // keep using the existing one rather than dropping to a plain post.
        console.error('[npcwebhook] avatar refresh failed, reusing existing:', e?.message || e);
      }
    }
    return new WebhookClient({ id: row.webhook_id, token: row.webhook_token });
  }

  const webhook = await channel.createWebhook({
    name: npcName,
    avatar: imageUrl ?? BLANK_AVATAR,
    reason: `NPC webhook for ${npcName}`,
  });
  setNpcWebhookFor(gid, channel.id, npcName, webhook.id, webhook.token, imageUrl ?? null);
  return new WebhookClient({ id: webhook.id, token: webhook.token });
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
// Insert a bare row then apply the caller's fields. Every non-key column has a
// default, so the bare INSERT is safe. The previous version listed columns
// explicitly and silently dropped anything added later (auto_npc, rr_state,
// floor_hp) whenever a channel's very first fight was created.
function upsertFight(gid, cid, fields) {
  if (!getFight(gid, cid)) {
    db.prepare('INSERT INTO fights (guild_id, channel_id) VALUES (?,?)').run(gid, cid);
  }
  const keys = Object.keys(fields || {});
  if (keys.length) {
    const sets = keys.map(k => `${k}=?`).join(',');
    db.prepare(`UPDATE fights SET ${sets} WHERE guild_id=? AND channel_id=?`).run(...keys.map(k => fields[k]), gid, cid);
  }
  return getFight(gid, cid);
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

// Trailing RP flavour: collapse the lines, then restate the result above it.
// Used by both the embed card and the plain-text card.
function flavourBlock(flavour, label, total, critType) {
  const clean = flavour.split(/\n/).map(l => l.trim()).filter(l => l.length > 0).join('\n\n');
  return ['', '─────────────────────────────', `**${label??'roll'}** — ${totalStr(total, critType)}`, '', clean];
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
  { const sig = signatureLine(char); if (sig && !char._isNpc) lines.push(sig); }
  // NPC stat blocks are hidden from players by default so their capabilities stay
  // a mystery. A GM can reveal them with /config npcstats enabled:true.
  const hideNpcStats = char._isNpc && !(gid && getConfig(gid)?.npc_stats_visible);
  if (hideNpcStats) lines.push(`❤️  ${hpCondition(char.hp_current, maxHp(char))}`);
  else lines.push(`❤️  HP${pad(char.hp_current)} / ${maxHp(char)}`);
  if (!char._isNpc) lines.push(`🔄  Rerolls${pad(char.rerolls_current)} / ${maxRerolls(char)}`);
  if (isWhiteKnight(char)) lines.push(`🛡️  Heal${pad(healCharges)} / ${maxCharges}`);
  if (!hideNpcStats) {
    lines.push('');
    lines.push(`💪  STR${pad(char.str)}`);
    lines.push(`🫀  CON${pad(char.con)}`);
    lines.push(`⚡  DEX${pad(char.dex)}`);
    lines.push(`🧠  WIS${pad(char.wis)}`);
    lines.push(`🍀  LCK${pad(char.lck)}`);
  }
  if (char.weapon1 || char.weapon2) {
    lines.push('');
    if (char.weapon1) lines.push(`${char.weapon1emoji??'⚔️'}  ${char.weapon1}`);
    if (char.weapon2) lines.push(`${char.weapon2emoji??'🗡️'}  ${char.weapon2}`);
  }
  if (flavour) lines.push(...flavourBlock(flavour, label, total, critType));
  return lines.join('\n');
}

function buildPlainRoll({ rollLine, label, isReroll, flavour, total, critType }) {
  const lines = [];
  const lc = critPrefix(critType);
  if (label) lines.push(`${lc}**${label}**${isReroll ? ' *(reroll)*' : ''}`);
  else if (isReroll) lines.push('*(reroll)*');
  lines.push(rollLine);
  if (flavour) lines.push(...flavourBlock(flavour, label, total, critType));
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

const STATS = ['str','con','dex','wis','lck'];

function parseRollInput(input, char) {
  const [rollPart, ...fp] = input.split('\n');
  const flavour = fp.join('\n').trim() || null;
  const trimmed = rollPart.trim();
  // Stat quick roll — "str" alone, or "str <label>" (e.g. "str heavy swing")
  const statMatch = trimmed.match(/^(str|con|dex|wis|lck)(?:\s+(.*))?$/i);
  if (statMatch) {
    const stat = statMatch[1].toLowerCase();
    const val = char?.[stat] ?? 0;
    return { notation: `1d20+${val}`, label: statMatch[2]?.trim() || stat, flavour };
  }
  const m = rollPart.trim().match(/^(\d+d\d+(?:[+-]\d+)?)\s*(.*)?$/i);
  if (!m) return null;
  return { notation: m[1], label: m[2]?.trim() || null, flavour };
}

async function getDisplayName(guild, uid) {
  try { const mb = await guild.members.fetch(uid); return mb.nickname || mb.user.username; }
  catch { return 'Unknown'; }
}

// Cache display-name lookups within a single command so a 5-person roster is 5
// fetches, not 10+. Pass the same `cache` object (a Map) through one handler call.
async function getDisplayNameCached(guild, uid, cache) {
  if (cache && cache.has(uid)) return cache.get(uid);
  const name = await getDisplayName(guild, uid);
  if (cache) cache.set(uid, name);
  return name;
}

// interaction.channel is null when Discord omits the channel object from the
// payload (common in threads or uncached channels). interaction.channelId is
// always present, so derive the id from it and lazily fetch the channel only
// when we actually need to send something.
function interactionChannelId(interaction) {
  return interaction.channelId || interaction.channel?.id || null;
}
async function interactionChannel(interaction) {
  if (interaction.channel) return interaction.channel;
  const id = interaction.channelId;
  if (!id) return null;
  return await interaction.client.channels.fetch(id).catch(() => null);
}

// Post content to a channel that may exceed Discord's 2000-char hard limit.
// Same line-boundary chunking as replyLong, for paths that aren't replying to
// an interaction (auto fights, end-of-fight announcements).
// Split content on line boundaries into pieces that fit Discord's 2000-char
// hard limit. Shared by sendLong and replyLong so the two can't drift.
function chunkLines(content, limit = 1900) {
  const src = Array.isArray(content) ? content : String(content).split('\n');
  const chunks = [];
  let buf = '';
  for (const line of src) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (buf.length + piece.length + 1 > limit) { chunks.push(buf); buf = piece; }
    else { buf = buf ? buf + '\n' + piece : piece; }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

async function sendLong(channel, content) {
  if (!channel) return;
  for (const c of chunkLines(content)) await channel.send(c).catch(()=>{});
}

// Reply with content that may exceed Discord's 2000-char hard limit. Splits on
// line boundaries so long lists (quest board, npc list, recaps) never fail
// silently. First chunk is the reply; the rest are follow-ups. Pass an array of
// lines OR a pre-joined string.
async function replyLong(interaction, content, opts = {}) {
  const LIMIT = 1900; // headroom under 2000 for safety
  const text = Array.isArray(content) ? content.join('\n') : String(content);
  if (text.length <= LIMIT) {
    return interaction.reply({ content: text, ...opts });
  }
  // Chunk by lines, never mid-line unless a single line is itself too long.
  const chunks = chunkLines(Array.isArray(content) ? content : text, LIMIT);
  await interaction.reply({ content: chunks[0], ...opts });
  for (let i = 1; i < chunks.length; i++) {
    await interaction.followUp({ content: chunks[i], ...opts }).catch(() => {});
  }
}

// Every configured GM role. gm_role_ids (JSON list) is the modern store; the
// legacy single gm_role_id is folded in so older setups keep working.
function getGmRoleIds(gid) {
  const cfg = getConfig(gid);
  let ids = [];
  try { ids = JSON.parse(cfg.gm_role_ids || '[]'); } catch { ids = []; }
  if (!Array.isArray(ids)) ids = [];
  if (cfg.gm_role_id && !ids.includes(cfg.gm_role_id)) ids = [cfg.gm_role_id, ...ids];
  return ids;
}
function setGmRoleIds(gid, ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  // Keep the legacy column pointing at the first role so nothing else breaks.
  setConfig(gid, { gm_role_ids: JSON.stringify(uniq), gm_role_id: uniq[0] ?? null });
  return uniq;
}

async function isGm(guild, uid) {
  let mb;
  try { mb = await guild.members.fetch(uid); }
  catch { return false; }
  // Server admins are always GMs — this prevents ever locking yourself out of
  // the bot by mis-setting the role.
  if (mb.permissions?.has?.(PermissionFlagsBits.ManageGuild)) return true;
  const ids = getGmRoleIds(guild.id);
  if (!ids.length) return false;
  return ids.some(id => mb.roles.cache.has(id));
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
  let createCanvas;
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
  { const sig = signatureLine(char, true); if (sig) textLines.push(sig); }
  if (approvalEnabled(gid) && char.approval_state === 'pending') textLines.push('  ⏳ Awaiting GM approval');
  if (approvalEnabled(gid) && char.approval_state === 'rejected') textLines.push('  🚫 Rejected by a GM');
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

  // With approvals on, a player's own export goes to the GMs first — they only
  // get the block once a GM releases it. GMs export straight away (they're the
  // ones doing the releasing), and so does anyone exporting on a server that
  // isn't using approvals at all.
  const isGmUser = await isGm(interaction.guild, uid);
  if (approvalEnabled(gid) && !isGmUser && tid === uid) {
    const chId = getConfig(gid)?.approval_channel_id;
    await interaction.reply({ ephemeral: true, content:
      `📤 **Export sent to <#${chId}> for a GM to look over.**\n`
      + `You'll get your sheet as soon as one releases it — by DM, or back here if your DMs are closed.\n`
      + `_This doesn't change your sheet or stop you rolling._` });
    const posted = await requestSheetExport(interaction, gid, uid, textContent, mode);
    if (!posted) {
      await interaction.followUp({ ephemeral: true, content: '⚠️ Couldn\'t reach the approval channel — ask a GM to check `/config approvals`.' }).catch(()=>{});
    }
    return;
  }

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

// Release or decline a queued export. Delivery mirrors sheet decisions: DM
// first, then the channel they ran /char export in, so a closed DM doesn't
// swallow the sheet silently.
async function handleExportRequestButton(interaction) {
  const gid = interaction.guild.id;
  if (!(await isGm(interaction.guild, interaction.user.id)))
    return interaction.reply({ content: '❌ Only GMs can release sheet exports.', ephemeral: true });
  const [action, uid] = interaction.customId.split(':');
  const req = getExportRequest(gid, uid);
  const nm = await getDisplayName(interaction.guild, uid);
  const gmName = await getDisplayName(interaction.guild, interaction.user.id);
  if (!req) {
    await interaction.message.edit({ components: [] }).catch(()=>{});
    return interaction.reply({ content: '⏰ That export request is no longer pending — it was already handled or superseded.', ephemeral: true });
  }
  const released = action === 'exportok';
  clearExportRequest(gid, uid);

  // Mark the request as decided so the queue reads cleanly.
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n${released ? '✅' : '🚫'} **${released ? 'Released' : 'Declined'}** by ${gmName}`,
      components: [],
    });
  } catch {}

  let files = [];
  if (released && req.fmt && req.fmt !== 'text') {
    // The image is drawn fresh at release time; the text block is exactly what
    // the GM read in the queue.
    const ch = getChar(gid, uid);
    if (ch) {
      const cfg = getConfig(gid); const mc = cfg.heal_charges ?? 3;
      const hr = getHealCharges(gid, uid, mc);
      const buf = await generateCharImage(ch, nm, hr.current, mc).catch(()=>null);
      if (buf) {
        const { AttachmentBuilder } = require('discord.js');
        files = [new AttachmentBuilder(buf, { name: `${nm.replace(/\s+/g,'-')}-sheet.png` })];
      }
    }
  }

  const notice = released
    ? `📤 **Your sheet export was released** by ${gmName} in **${interaction.guild.name}**:\n${req.payload}`
    : `🚫 **Your sheet export was declined** by ${gmName} in **${interaction.guild.name}**. Speak to a GM if you need it.`;

  let told = 'DM';
  try {
    const user = await interaction.client.users.fetch(uid);
    await user.send({ content: notice, files });
  } catch {
    told = null;
    if (req.src_channel) {
      try {
        const srcChan = await interaction.client.channels.fetch(req.src_channel);
        await srcChan.send({ content: `<@${uid}> ${notice}`, files, allowedMentions: { users: [uid] } });
        told = 'channel';
      } catch {}
    }
  }
  const delivery = told === 'DM' ? ' _(sent by DM)_'
                 : told === 'channel' ? ' _(DM blocked — posted in the channel they exported from)_'
                 : ' ⚠️ _couldn\'t reach the player — send it to them directly._';
  return interaction.reply({ content: (released
    ? `✅ Export released to <@${uid}> (**${nm}**).`
    : `🚫 Export declined for <@${uid}> (**${nm}**).`) + delivery,
    allowedMentions: { parse: [] } });
}

// ─────────────────────────────────────────────
//  SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────

const KNIGHTS = ['White Knight','Black Knight','Gold Knight','Grey Knight','Blue Knight','Purple Knight','Green Knight','Red Knight'];

const slashCommands = [
  new SlashCommandBuilder()
    .setName('config').setDescription('Server configuration (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s=>s.setName('gmrole').setDescription('Add, remove or list GM roles — several can be set')
      .addRoleOption(o=>o.setName('role').setDescription('Role to add (or remove, with remove:true)').setRequired(false))
      .addBooleanOption(o=>o.setName('remove').setDescription('true = remove this role instead of adding it').setRequired(false))
      .addBooleanOption(o=>o.setName('replace').setDescription('true = make this the ONLY GM role').setRequired(false)))
    .addSubcommand(s=>s.setName('heal').setDescription('Set max Heal charges for White Knights').addIntegerOption(o=>o.setName('charges').setDescription('Number of charges').setRequired(true).setMinValue(1).setMaxValue(10)))
    .addSubcommand(s=>s.setName('npcchannel').setDescription('Set the NPC image bank channel')
      .addChannelOption(o=>o.setName('channel').setDescription('Channel to watch for NPC avatar uploads').setRequired(true)))
    .addSubcommand(s=>s.setName('rest').setDescription('Set how much a rest restores (e.g. 50% or a flat number like 3)')
      .addStringOption(o=>o.setName('type').setDescription('Which rest to configure').setRequired(true)
        .addChoices({name:'Long Rest',value:'lrest'},{name:'Short Rest',value:'srest'}))
      .addStringOption(o=>o.setName('hp').setDescription('HP restored — "50%" of max, or a flat number like "3"').setRequired(false))
      .addStringOption(o=>o.setName('rerolls').setDescription('Rerolls restored — "50%" of max, or a flat number like "1"').setRequired(false))
      .addStringOption(o=>o.setName('heal').setDescription('Heal charges restored — "50%" of max, or a flat number like "2"').setRequired(false)))
    .addSubcommand(s=>s.setName('npcreroll').setDescription('NPC auto-reroll threshold: natural die ≤ N (0 disables)')
      .addIntegerOption(o=>o.setName('threshold').setDescription('1–19, or 0 to disable (default 8); omit to show current').setRequired(false).setMinValue(0).setMaxValue(19)))
    .addSubcommand(s=>s.setName('fightping').setDescription('@-mention players when it becomes their turn in a fight')
      .addBooleanOption(o=>o.setName('enabled').setDescription('true = ping, false = silent (default); omit to show current').setRequired(false)))
    .addSubcommand(s=>s.setName('npcstats').setDescription('Show NPC stat blocks on their roll cards (default: hidden)')
      .addBooleanOption(o=>o.setName('enabled').setDescription('true = players see NPC stats; false = hidden (default)').setRequired(false)))
    .addSubcommand(s=>s.setName('approvals').setDescription('Channel where new character sheets await GM approval')
      .addChannelOption(o=>o.setName('channel').setDescription('Approval channel').setRequired(false))
      .addBooleanOption(o=>o.setName('disable').setDescription('true = turn sheet approval off').setRequired(false)))
    .addSubcommand(s=>s.setName('rollaudit').setDescription('Mirror every player roll to a GM-only channel')
      .addChannelOption(o=>o.setName('channel').setDescription('Channel to mirror rolls into').setRequired(false))
      .addBooleanOption(o=>o.setName('test').setDescription('true = send a test mirror and report any problem').setRequired(false))
      .addBooleanOption(o=>o.setName('disable').setDescription('true = turn the mirror off').setRequired(false)))
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
    .addSubcommand(s=>s.setName('signature').setDescription('Set a Hero\'s signature stat — advantage on that stat (GM)')
      .addUserOption(o=>o.setName('user').setDescription('The Hero').setRequired(true))
      .addStringOption(o=>o.setName('stat').setDescription('Stat to designate (needs 5+); omit to clear').setRequired(false)
        .addChoices(
          {name:'💪 Strength (STR)',value:'str'},
          {name:'🛡️ Constitution (CON)',value:'con'},
          {name:'⚡ Dexterity (DEX)',value:'dex'},
          {name:'🦉 Wisdom (WIS)',value:'wis'},
          {name:'🍀 Luck (LCK)',value:'lck'})))
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
        {name:'Merits & Ranks',value:'progression'},
        {name:'Quest Board',value:'quests'},
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
      .addIntegerOption(o=>o.setName('str').setDescription('Strength').setRequired(false))
      .addIntegerOption(o=>o.setName('con').setDescription('Constitution').setRequired(false))
      .addIntegerOption(o=>o.setName('dex').setDescription('Dexterity').setRequired(false))
      .addIntegerOption(o=>o.setName('wis').setDescription('Wisdom').setRequired(false))
      .addIntegerOption(o=>o.setName('lck').setDescription('Luck').setRequired(false))
      .addStringOption(o=>o.setName('order').setDescription('Knight order (optional)').setRequired(false)
        .addChoices({name:'White Knight',value:'White Knight'},{name:'Black Knight',value:'Black Knight'},{name:'Gold Knight',value:'Gold Knight'},{name:'Grey Knight',value:'Grey Knight'},{name:'Blue Knight',value:'Blue Knight'},{name:'Purple Knight',value:'Purple Knight'},{name:'Green Knight',value:'Green Knight'},{name:'Red Knight',value:'Red Knight'})))
    .addSubcommand(s=>s.setName('delete').setDescription('Delete an NPC').addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true)))
    .addSubcommand(s=>s.setName('hp').setDescription('Set or restore an NPC HP (omit value for a full heal)')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o=>o.setName('value').setDescription('Exact HP to set (omit = full heal)').setRequired(false).setMinValue(-99).setMaxValue(99)))
    .addSubcommand(s=>s.setName('heal').setDescription('Fully heal NPCs — "all" or comma-separated names')
      .addStringOption(o=>o.setName('names').setDescription('"all", or NPC names separated by commas').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('copy').setDescription('Duplicate an NPC under a new name (fresh full HP)')
      .addStringOption(o=>o.setName('name').setDescription('NPC to copy').setRequired(true).setAutocomplete(true))
      .addStringOption(o=>o.setName('new_name').setDescription('Name for the copy').setRequired(true)))
    .addSubcommand(s=>s.setName('show').setDescription('Show one NPC\'s full stat block')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('hero').setDescription('Make an NPC a Hero with a signature stat (GM)')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true).setAutocomplete(true))
      .addStringOption(o=>o.setName('stat').setDescription('Signature stat (needs 5+)').setRequired(false)
        .addChoices(
          {name:'💪 Strength (STR)',value:'str'},
          {name:'🛡️ Constitution (CON)',value:'con'},
          {name:'⚡ Dexterity (DEX)',value:'dex'},
          {name:'🦉 Wisdom (WIS)',value:'wis'},
          {name:'🍀 Luck (LCK)',value:'lck'}))
      .addBooleanOption(o=>o.setName('remove').setDescription('true = strip Hero status from this NPC').setRequired(false)))
    .addSubcommand(s=>s.setName('list').setDescription('List all NPCs on this server')
      .addStringOption(o=>o.setName('category').setDescription('Only show NPCs in this category').setRequired(false).setAutocomplete(true)))
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
    .addSubcommand(s=>s.setName('say').setDescription('Speak or act as an NPC — leave both blank for a writing box')
      .addStringOption(o=>o.setName('name').setDescription('NPC name').setRequired(true).setAutocomplete(true))
      .addStringOption(o=>o.setName('action').setDescription('What the NPC does — posted in italics').setRequired(false))
      .addStringOption(o=>o.setName('speech').setDescription('What the NPC says — wrapped in quote marks').setRequired(false))
      .addStringOption(o=>o.setName('raw').setDescription('Post exactly as typed — overrides action/speech').setRequired(false)))
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
      .addStringOption(o=>o.setName('players').setDescription('Players to include — @mention them, space-separated').setRequired(false))
      .addStringOption(o=>o.setName('npcs').setDescription('GM NPCs to include — names, comma-separated').setRequired(false))
      .addBooleanOption(o=>o.setName('manual').setDescription('Skip initiative roll and use the order you listed fighters in').setRequired(false))
      .addBooleanOption(o=>o.setName('practice').setDescription('Friendly bout — fighters yield at 2 HP and are never driven below it').setRequired(false)))
    .addSubcommand(s=>s.setName('addnpc').setDescription('Add GM NPCs to the current fight (GM only)')
      .addStringOption(o=>o.setName('npc').setDescription('NPC(s) to add — names, comma-separated').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('auto').setDescription('Auto-run a fight (GM only)')
      .addStringOption(o=>o.setName('mode').setDescription('How to run it').setRequired(true)
        .addChoices(
          {name:'Full — bot rolls for everyone to a winner',value:'full'},
          {name:'NPCs only — bot takes NPC turns, players play manually',value:'npconly'},
          {name:'Demo — example fighters, just a showcase',value:'demo'},
        ))
      .addStringOption(o=>o.setName('players').setDescription('Players to include — @mention them, space-separated (full mode)').setRequired(false))
      .addStringOption(o=>o.setName('npcs').setDescription('GM NPCs to include — names, comma-separated').setRequired(false))
      .addStringOption(o=>o.setName('teams').setDescription('Full mode sides: "@a @b vs Goblin, Orc" — overrides players/npcs').setRequired(false))
      .addBooleanOption(o=>o.setName('practice').setDescription('Friendly bout — fighters yield at 2 HP and are never driven below it').setRequired(false)))
    .addSubcommand(s=>s.setName('order').setDescription('Set the turn order (GM) — list fighters in the order you want')
      .addStringOption(o=>o.setName('players').setDescription('Players in order — @mention them, space-separated').setRequired(false))
      .addStringOption(o=>o.setName('sequence').setDescription('Full order incl. NPCs — e.g. @Alice, Goblin, @Bob, Orc').setRequired(false)))
    .addSubcommand(s=>s.setName('atk').setDescription('Attack a target')
      .addStringOption(o=>o.setName('stat').setDescription('Stat to attack with').setRequired(true)
        .addChoices({name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},{name:'WIS',value:'wis'},{name:'LCK',value:'lck'}))
      .addUserOption(o=>o.setName('target').setDescription('Player to attack').setRequired(false))
      .addStringOption(o=>o.setName('target_npc').setDescription('NPC to attack instead of a player').setRequired(false).setAutocomplete(true))
      .addStringOption(o=>o.setName('npc').setDescription('Attack AS this NPC (GM, when it is the NPC\'s turn)').setRequired(false).setAutocomplete(true))
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'}))
      .addStringOption(o=>o.setName('flavour').setDescription('Optional flavour text').setRequired(false)))
    .addSubcommand(s=>s.setName('def').setDescription('Defend against the current attack')
      .addStringOption(o=>o.setName('stat').setDescription('Stat to defend with').setRequired(true)
        .addChoices({name:'STR',value:'str'},{name:'CON',value:'con'},{name:'DEX',value:'dex'},{name:'WIS',value:'wis'},{name:'LCK',value:'lck'}))
      .addStringOption(o=>o.setName('npc').setDescription('Defend AS this NPC (GM, when the NPC is the target)').setRequired(false).setAutocomplete(true))
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'}))
      .addStringOption(o=>o.setName('flavour').setDescription('Optional flavour text').setRequired(false)))
    .addSubcommand(s=>s.setName('rr').setDescription('Reroll last fight roll (costs 1 reroll token)')
      .addStringOption(o=>o.setName('roll').setDescription('Roll type').setRequired(false)
        .addChoices({name:'Normal (default)',value:'normal'},{name:'Advantage',value:'adv'},{name:'Disadvantage',value:'dis'})))
    .addSubcommand(s=>s.setName('resolve').setDescription('Resolve the current exchange'))
    .addSubcommand(s=>s.setName('refill').setDescription('Refill NPC reroll tokens to their LCK (GM)')
      .addStringOption(o=>o.setName('npcs').setDescription('"all", or NPC names separated by commas').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('hp').setDescription('Set a fighter\'s HP mid-fight — sheet and fight stay in sync (GM)')
      .addIntegerOption(o=>o.setName('value').setDescription('Exact HP to set').setRequired(true).setMinValue(-99).setMaxValue(99))
      .addUserOption(o=>o.setName('target').setDescription('Player to adjust').setRequired(false))
      .addStringOption(o=>o.setName('target_npc').setDescription('NPC to adjust').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('kick').setDescription('Remove a fighter from the fight without ending it (GM)')
      .addUserOption(o=>o.setName('target').setDescription('Player to remove').setRequired(false))
      .addStringOption(o=>o.setName('target_npc').setDescription('NPC to remove').setRequired(false).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('forfeit').setDescription('Concede the fight'))
    .addSubcommand(s=>s.setName('status').setDescription('Show current fight status'))
    .addSubcommand(s=>s.setName('log').setDescription('Re-post the recap of the last finished fight in this channel'))
    .addSubcommand(s=>s.setName('skip').setDescription('Skip the current turn without removing anyone (GM)'))
    .addSubcommand(s=>s.setName('end').setDescription('End the fight (GM only)')),

  new SlashCommandBuilder()
    .setName('p').setDescription('Shorthand for /profile')
    .addSubcommand(s=>s.setName('on').setDescription('Enable profile embed, max HP and rerolls'))
    .addSubcommand(s=>s.setName('off').setDescription('Disable profile embed'))
    .addSubcommand(s=>s.setName('show').setDescription('Preview your profile without rolling'))
    .addSubcommand(s=>s.setName('save').setDescription('Snapshot current tracker state').addStringOption(o=>o.setName('slotname').setDescription('Name for this save').setRequired(true)))
    .addSubcommand(s=>s.setName('load').setDescription('Restore a saved snapshot').addStringOption(o=>o.setName('slotname').setDescription('Name of the save to load').setRequired(true)))
    .addSubcommand(s=>s.setName('saves').setDescription('List all your saved snapshots')),

  new SlashCommandBuilder()
    .setName('gmheal').setDescription('Restore HP, rerolls or heal charges — players or NPCs (GM)')
    .addUserOption(o=>o.setName('user').setDescription('Player to restore').setRequired(false))
    .addStringOption(o=>o.setName('npc').setDescription('NPC to restore — or "all" for every NPC').setRequired(false).setAutocomplete(true))
    .addStringOption(o=>o.setName('amount').setDescription('How much to restore (default: full)').setRequired(false)
      .addChoices(
        {name:'❤️ Full — restore to maximum',value:'full'},
        {name:'🩹 Half — restore half of maximum',value:'half'},
        {name:'➕ Add — add the value below',value:'add'},
        {name:'➖ Subtract — remove the value below',value:'sub'},
        {name:'🎯 Exact — set to the value below',value:'exact'}))
    .addIntegerOption(o=>o.setName('value').setDescription('Number used by Add / Subtract / Exact').setRequired(false).setMinValue(-99).setMaxValue(99))
    .addStringOption(o=>o.setName('restore').setDescription('What to restore (default: HP only)').setRequired(false)
      .addChoices(
        {name:'❤️ HP only',value:'hp'},
        {name:'🔄 Rerolls only',value:'rerolls'},
        {name:'🛡️ Heal charges only',value:'charges'},
        {name:'✨ Everything — HP, rerolls and charges',value:'all'})),

  new SlashCommandBuilder()
    .setName('roll').setDescription('Roll dice with optional stat, advantage and RP flavour')
    .addStringOption(o=>o.setName('stat').setDescription('Roll 1d20 + this stat from your sheet').setRequired(false)
      .addChoices(
        {name:'💪 Strength (STR)',value:'str'},
        {name:'🛡️ Constitution (CON)',value:'con'},
        {name:'⚡ Dexterity (DEX)',value:'dex'},
        {name:'🦉 Wisdom (WIS)',value:'wis'},
        {name:'🍀 Luck (LCK)',value:'lck'}))
    .addStringOption(o=>o.setName('dice').setDescription('Custom notation instead of a stat, e.g. 2d6+3').setRequired(false))
    .addStringOption(o=>o.setName('mode').setDescription('Advantage or disadvantage').setRequired(false)
      .addChoices(
        {name:'Normal',value:'normal'},
        {name:'🔼 Advantage (roll twice, keep higher)',value:'adv'},
        {name:'🔽 Disadvantage (roll twice, keep lower)',value:'dis'}))
    .addBooleanOption(o=>o.setName('success_check').setDescription('Show a success/partial/fail outcome').setRequired(false))
    .addStringOption(o=>o.setName('label').setDescription('What the roll is for, e.g. perception').setRequired(false))
    .addStringOption(o=>o.setName('flavour').setDescription('RP text posted with the roll — *italic* and **bold** work').setRequired(false)),

  new SlashCommandBuilder()
    .setName('merit').setDescription('Track player merit / experience (GM only)')
    .addSubcommand(s=>s.setName('add').setDescription('Award merits to a player (GM)')
      .addUserOption(o=>o.setName('user').setDescription('Player').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('How many merits (default 1)').setRequired(false).setMinValue(1).setMaxValue(999)))
    .addSubcommand(s=>s.setName('remove').setDescription('Remove merits from a player (GM)')
      .addUserOption(o=>o.setName('user').setDescription('Player').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('How many to remove (default 1)').setRequired(false).setMinValue(1).setMaxValue(999)))
    .addSubcommand(s=>s.setName('set').setDescription('Set a player\'s merit total exactly (GM)')
      .addUserOption(o=>o.setName('user').setDescription('Player').setRequired(true))
      .addIntegerOption(o=>o.setName('amount').setDescription('Exact merit total').setRequired(true).setMinValue(0).setMaxValue(99999)))
    .addSubcommand(s=>s.setName('view').setDescription('View merits and rank progress')
      .addUserOption(o=>o.setName('user').setDescription('Player (defaults to you)').setRequired(false)))
    .addSubcommand(s=>s.setName('history').setDescription('Merit history — one player\'s timeline, or recent server activity')
      .addUserOption(o=>o.setName('user').setDescription('Player (omit for recent server-wide activity)').setRequired(false)))
    .addSubcommand(s=>s.setName('leaderboard').setDescription('Show the server merit leaderboard')),

  new SlashCommandBuilder()
    .setName('rank').setDescription('Define ranks and promote players (GM only)')
    .addSubcommand(s=>s.setName('add').setDescription('Create or update a rank with a merit threshold (GM)')
      .addStringOption(o=>o.setName('name').setDescription('Rank name, e.g. Knight').setRequired(true))
      .addIntegerOption(o=>o.setName('threshold').setDescription('Merits required to be eligible').setRequired(true).setMinValue(0).setMaxValue(99999))
      .addIntegerOption(o=>o.setName('order').setDescription('Sort order (low = junior). Defaults to threshold order').setRequired(false).setMinValue(0).setMaxValue(999)))
    .addSubcommand(s=>s.setName('remove').setDescription('Delete a rank (GM)')
      .addStringOption(o=>o.setName('name').setDescription('Rank name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('list').setDescription('List all ranks and their thresholds'))
    .addSubcommand(s=>s.setName('promote').setDescription('Set a player\'s rank (GM)')
      .addUserOption(o=>o.setName('user').setDescription('Player').setRequired(true))
      .addStringOption(o=>o.setName('rank').setDescription('Rank to assign').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('eligible').setDescription('List players who meet a rank\'s threshold but don\'t hold it (GM)')),

  new SlashCommandBuilder()
    .setName('quest').setDescription('Quest board — create, post, join and complete quests')
    .addSubcommand(s=>s.setName('create').setDescription('Create a quest (GM)')
      .addStringOption(o=>o.setName('name').setDescription('Quest name, e.g. Goblin Cave').setRequired(true))
      .addStringOption(o=>o.setName('objectives').setDescription('What the party must do').setRequired(false))
      .addStringOption(o=>o.setName('lore').setDescription('Story / background').setRequired(false))
      .addStringOption(o=>o.setName('details').setDescription('Extra details / conditions').setRequired(false))
      .addStringOption(o=>o.setName('rewards').setDescription('Non-merit rewards, distributed by the GM').setRequired(false))
      .addIntegerOption(o=>o.setName('merit_reward').setDescription('Merits each member earns on completion').setRequired(false).setMinValue(0).setMaxValue(999))
      .addIntegerOption(o=>o.setName('party_size').setDescription('Party size (cap or suggestion)').setRequired(false).setMinValue(1).setMaxValue(99))
      .addBooleanOption(o=>o.setName('hard_cap').setDescription('True = enforce party size; false = suggestion (default)').setRequired(false)))
    .addSubcommand(s=>s.setName('post').setDescription('Post a quest to a channel/thread as an embed (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true))
      .addChannelOption(o=>o.setName('channel').setDescription('Where to post (defaults to here)').setRequired(false)))
    .addSubcommand(s=>s.setName('board').setDescription('List quests on the board')
      .addStringOption(o=>o.setName('filter').setDescription('Which quests to show').setRequired(false)
        .addChoices({name:'Open',value:'open'},{name:'In progress',value:'active'},{name:'Completed',value:'completed'},{name:'All',value:'all'})))
    .addSubcommand(s=>s.setName('show').setDescription('Show one quest in full')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('apply').setDescription('Apply to join a quest')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('withdraw').setDescription('Withdraw your application or leave a quest')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('roster').setDescription('Show a quest\'s applicants and party')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('log').setDescription('Completed quests a player was on')
      .addUserOption(o=>o.setName('user').setDescription('Player (defaults to you)').setRequired(false)))
    .addSubcommand(s=>s.setName('approve').setDescription('Approve an applicant onto the party (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true))
      .addUserOption(o=>o.setName('user').setDescription('Applicant to approve').setRequired(true))
      .addBooleanOption(o=>o.setName('force').setDescription('Add even if it exceeds a hard cap').setRequired(false)))
    .addSubcommand(s=>s.setName('kick').setDescription('Remove a member or applicant from a quest (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true))
      .addUserOption(o=>o.setName('user').setDescription('Player to remove').setRequired(true)))
    .addSubcommand(s=>s.setName('runchannel').setDescription('Set where this quest is run and rewarded (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true))
      .addChannelOption(o=>o.setName('channel').setDescription('Thread or channel (defaults to here)').setRequired(false)))
    .addSubcommand(s=>s.setName('start').setDescription('Mark a quest in progress, locking the party (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('complete').setDescription('Complete a quest — award merits to the party (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s=>s.setName('delete').setDescription('Delete a quest permanently (GM)')
      .addIntegerOption(o=>o.setName('number').setDescription('Quest number').setRequired(true).setAutocomplete(true))),
];

// ─────────────────────────────────────────────
//  SLASH HANDLERS
// ─────────────────────────────────────────────

async function handleConfig(interaction) {
  const sub = interaction.options.getSubcommand(), gid = interaction.guild.id;
  if (sub === 'gmrole') {
    const role = interaction.options.getRole('role');
    const remove = interaction.options.getBoolean('remove') ?? false;
    const replace = interaction.options.getBoolean('replace') ?? false;
    const current = getGmRoleIds(gid);

    // No role given → list what's configured
    if (!role) {
      if (!current.length) return interaction.reply({ content: '📋 No GM roles set. Add one with `/config gmrole role:@Role`.\n_Server admins (Manage Server) always count as GMs._', ephemeral: true });
      const names = current.map(id => `<@&${id}>`).join(', ');
      return interaction.reply({ content: `📋 GM roles: ${names}\n_Server admins (Manage Server) always count as GMs._`, ephemeral: true, allowedMentions: { parse: [] } });
    }

    if (remove) {
      if (!current.includes(role.id)) return interaction.reply({ content: `❌ **${role.name}** isn't a GM role.`, ephemeral: true });
      const next = setGmRoleIds(gid, current.filter(id => id !== role.id));
      return interaction.reply({ content: next.length
        ? `✅ Removed **${role.name}**. GM roles: ${next.map(id => `<@&${id}>`).join(', ')}`
        : `✅ Removed **${role.name}**. No GM roles remain — only server admins can use GM commands now.`,
        ephemeral: true, allowedMentions: { parse: [] } });
    }

    if (replace) {
      setGmRoleIds(gid, [role.id]);
      return interaction.reply({ content: `✅ **${role.name}** is now the only GM role.`, ephemeral: true });
    }

    if (current.includes(role.id)) return interaction.reply({ content: `**${role.name}** is already a GM role.`, ephemeral: true });
    const next = setGmRoleIds(gid, [...current, role.id]);
    return interaction.reply({ content: `✅ Added **${role.name}** as a GM role. GM roles: ${next.map(id => `<@&${id}>`).join(', ')}`, ephemeral: true, allowedMentions: { parse: [] } });
  }
  if (sub === 'fightping') {
    const v = interaction.options.getBoolean('enabled');
    if (v === null) {
      const cur = !!getConfig(gid)?.fight_ping;
      return interaction.reply({ content: `🔔 Turn pings are **${cur ? 'on' : 'off'}**${cur ? '' : ' (default)'}. Set with \`/config fightping enabled:true\`.`, ephemeral: true });
    }
    setConfig(gid, { fight_ping: v ? 1 : 0 });
    return interaction.reply({ content: v ? '🔔 Turn pings **on** — players get an @mention when it\'s their turn.' : '🔕 Turn pings **off**.' });
  }
  if (sub === 'npcstats') {
    const v = interaction.options.getBoolean('enabled');
    if (v === null) {
      const cur = !!getConfig(gid)?.npc_stats_visible;
      return interaction.reply({ content: `🎭 NPC stat blocks are **${cur ? 'visible' : 'hidden'}**${cur ? '' : ' (default)'} on roll cards. Change with \`/config npcstats enabled:true\`.`, ephemeral: true });
    }
    setConfig(gid, { npc_stats_visible: v ? 1 : 0 });
    return interaction.reply({ content: v
      ? '🎭 NPC stat blocks are now **visible** to everyone on roll cards.'
      : '🎭 NPC stat blocks are now **hidden** — players see the name, order and HP, but not STR/CON/DEX/WIS/LCK.' });
  }
  if (sub === 'approvals') {
    const channel = interaction.options.getChannel('channel');
    const disable = interaction.options.getBoolean('disable');
    if (disable) {
      setConfig(gid, { approval_channel_id: null });
      return interaction.reply({ content: '✅ Sheet approval **disabled** — new sheets work immediately.' });
    }
    if (!channel) {
      const cur = getConfig(gid)?.approval_channel_id;
      return interaction.reply({ content: cur
        ? `📋 New sheets await approval in <#${cur}>. Turn off with \`/config approvals disable:true\`.`
        : '📋 Sheet approval is **off**. Set a channel with `/config approvals channel:#x`.', ephemeral: true });
    }
    if (!channel.isTextBased?.()) return interaction.reply({ content: '❌ Pick a text channel or thread.', ephemeral: true });
    setConfig(gid, { approval_channel_id: channel.id });
    return interaction.reply({ content: `📋 New character sheets will await GM approval in <#${channel.id}>.\n⚠️ Players can't roll or fight until approved, and stats become GM-only once a sheet exists.` });
  }
  if (sub === 'rollaudit') {
    const channel = interaction.options.getChannel('channel');
    const disable = interaction.options.getBoolean('disable');
    const test = interaction.options.getBoolean('test');

    if (test) {
      const chId = getConfig(gid)?.roll_audit_channel_id;
      if (!chId) return interaction.reply({ content: '🔇 No audit channel is set. Use `/config rollaudit channel:#x` first.', ephemeral: true });
      let target;
      try { target = await interaction.client.channels.fetch(chId); }
      catch (e) { return interaction.reply({ content: `❌ I can't see <#${chId}> (id \`${chId}\`).\n**${e?.message || e}**\nAdd the bot to that channel with View Channel + Send Messages.`, ephemeral: true }); }
      if (!target) return interaction.reply({ content: `❌ Channel \`${chId}\` no longer exists. Set a new one with \`/config rollaudit channel:#x\`.`, ephemeral: true });
      try {
        await target.send({ content: '🎲 **Roll audit test** — mirroring is working. Player rolls will appear here.' });
        return interaction.reply({ content: `✅ Test message sent to <#${chId}>. If you can see it there, mirroring works.\n\n_Mirrored: player rolls, heals, fight rolls, and GM rolls (including secret ones). Not mirrored: NPC auto-rolls and rolls made inside the audit channel itself._`, ephemeral: true });
      } catch (e) {
        return interaction.reply({ content: `❌ I can see <#${chId}> but can't post there.\n**${e?.message || e}**\nGive the bot **Send Messages** in that channel.`, ephemeral: true });
      }
    }
    if (disable) {
      setConfig(gid, { roll_audit_channel_id: null });
      return interaction.reply({ content: '🔇 Roll mirroring **disabled**.' });
    }
    if (!channel) {
      const cur = getConfig(gid)?.roll_audit_channel_id;
      if (!cur) return interaction.reply({ content: '🔇 Roll mirroring is **off**. Set a channel with `/config rollaudit channel:#x`.', ephemeral: true });
      let reach = '❓ unknown';
      try {
        const t = await interaction.client.channels.fetch(cur);
        reach = t ? `✅ reachable (**#${t.name ?? '?'}**)` : '❌ fetch returned nothing';
      } catch (e) { reach = `❌ cannot access — ${e?.message || e}`; }
      return interaction.reply({ content: `🎲 Audit channel: <#${cur}>\nStored id: \`${cur}\`\nBot access: ${reach}\n\nSend a live test with \`/config rollaudit test:true\`.`, ephemeral: true });
    }
    if (!channel.isTextBased?.()) return interaction.reply({ content: '❌ Pick a text channel or thread.', ephemeral: true });
    setConfig(gid, { roll_audit_channel_id: channel.id });
    return interaction.reply({ content: `🎲 Rolls will be mirrored to <#${channel.id}> — raw input, result, and a jump link.\nCovers player rolls **and GM rolls, including secret ones**, so GMs are accountable to each other.\n⚠️ Make sure that channel's permissions only let GMs view it; the bot can't set that for you.` });
  }
  if (sub === 'npcreroll') {
    const v = interaction.options.getInteger('threshold');
    if (v === null) {
      const cur = getNpcRrThreshold(gid);
      const state = cur === 0 ? '**disabled**' : `natural die **≤ ${cur}**`;
      return interaction.reply({ content: `🔁 NPC auto-rerolls: ${state}${cur === NPC_RR_NAT_MAX ? ' (default)' : ''}. Set with \`/config npcreroll threshold:N\` — 0 disables.`, ephemeral: true });
    }
    setConfig(gid, { npc_rr_threshold: v });
    return interaction.reply({ content: v === 0 ? '✅ NPC auto-rerolls **disabled**.' : `✅ NPCs now auto-reroll on a natural die of **${v} or less**.`, ephemeral: true });
  }
  if (sub === 'heal') {
    const charges = interaction.options.getInteger('charges');
    setConfig(gid, { heal_charges: charges });
    return interaction.reply({ content: `✅ White Knight Heal charges set to **${charges}**.`, ephemeral: true });
  }
  if (sub === 'npcchannel') {
    const chan = interaction.options.getChannel('channel');
    if (!chan?.isTextBased?.()) return interaction.reply({ content: '❌ Pick a text channel.', ephemeral: true });
    setConfig(gid, { npc_channel_id: chan.id });
    return interaction.reply({ content: `✅ NPC image channel set to <#${chan.id}> (id \`${chan.id}\`).\nUpload an image there with the NPC's name as the message text to set their avatar.\n⚠️ I need **View Channel**, **Send Messages** and **Read Message History** there.`, ephemeral: true });
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
    const existingSheet = getChar(gid, targetId);
    const charClass = interaction.options.getString('class');
    if (charClass && String(charClass).toLowerCase() === 'hero' && !isGmUser) {
      return interaction.reply({ content: '❌ **Hero** is granted by a GM, not chosen. Pick Vanguard, Defender or Siege Knight.', ephemeral: true });
    }
    if (charClass) updates.class = charClass;
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

    // Approval flow: a player creating/updating their OWN sheet while approval is
    // enabled must have it signed off. Sheets a GM builds are approved outright.
    const needsApproval = approvalEnabled(gid) && !isGmUser && targetId === callerId;
    if (needsApproval) {
      const prev = existingSheet?.approval_state;
      if (prev === 'approved') {
        return interaction.reply({ content: '🔒 Your sheet is already approved — stats can only be changed by a GM now.', ephemeral: true });
      }
      updates.approval_state = 'pending';
    } else if (approvalEnabled(gid) && isGmUser) {
      updates.approval_state = 'approved'; // GM-built sheets skip the queue
    }

    upsertChar(gid, targetId, updates);
    const mention = targetUser ? `<@${targetId}>` : 'Your';
    const summary = Object.entries(updates)
      .filter(([k]) => !['hp_current','rerolls_current','approval_state','approval_msg_id'].includes(k))
      .map(([k,v]) => `**${k.toUpperCase()}**: ${v}`).join(', ');

    if (needsApproval) {
      // Reply first so the approval post can link back to a real message.
      const chId = getConfig(gid)?.approval_channel_id;
      await interaction.reply({ content: chId
        ? `✅ Sheet submitted — ${summary}\n\n⏳ **Awaiting GM approval.** You can't roll or fight until it's approved.\n📬 **You'll get a DM as soon as a GM decides** — if your DMs are closed, the notice will be posted here instead.\n🔒 Once approved, only a GM can change your sheet, so check it over now with \`/char show\`.`
        : `✅ Sheet saved — ${summary}\n\n⚠️ No approval channel set; ask a GM to check \`/config approvals\`.` });
      let submitId = null;
      try { const rep = await interaction.fetchReply(); submitId = rep?.id ?? null; } catch {}
      const posted = await requestSheetApproval(interaction, gid, targetId, submitId);
      if (!posted) {
        await interaction.followUp({ content: '⚠️ Couldn\'t reach the approval channel — ask a GM to check `/config approvals`.', ephemeral: true }).catch(()=>{});
      }
      return;
    }
    return interaction.reply({ content: `✅ ${mention} character updated — ${summary}` });
  }

  if (sub === 'weaponemoji') {
    const slot = interaction.options.getString('slot'); // weapon1emoji or weapon2emoji
    const emoji = interaction.options.getString('emoji');     // from dropdown
    const custom = interaction.options.getString('custom');   // pasted server emoji
    const targetUser = interaction.options.getUser('user');
    const targetId = targetUser ? targetUser.id : callerId;
    const isGmUser = await isGm(interaction.guild, callerId);
    if (targetId !== callerId && !isGmUser)
      return interaction.reply({ content: '❌ Only GMs can modify other players\' characters.', ephemeral: true });
    {
      const lock = sheetEditLock(gid, callerId, targetId, isGmUser);
      if (lock) return interaction.reply({ content: lock, ephemeral: true });
    }
    // Custom (pasted) emoji takes priority over the dropdown
    const chosen = (custom && custom.trim()) ? custom.trim() : emoji;
    if (!chosen) return interaction.reply({ content: `❌ Pick a standard emoji from the dropdown, or paste a server custom emoji in the **custom** field.`, ephemeral: true });
    const cleaned = validateWeaponEmoji(interaction.guild, chosen);
    if (!cleaned) return interaction.reply({ content: `❌ That isn't a valid emoji. Use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or one of this server's own custom emojis.`, ephemeral: true });
    upsertChar(gid, targetId, { [slot]: cleaned });
    const slotLabel = slot === 'weapon1emoji' ? 'Weapon 1' : 'Weapon 2';
    return finishSheetEdit({
      src: interaction, gid, callerId, targetId, isGmCaller: isGmUser,
      content: `✅ ${slotLabel} emoji set to ${cleaned}${targetId!==callerId?` for <@${targetId}>`:''}.`,
      reply: async (c) => {
        await interaction.reply({ content: c });
        try { return await interaction.fetchReply(); } catch { return null; }
      },
    });
  }

  if (sub === 'signature') {
    if (!(await isGm(interaction.guild, callerId)))
      return interaction.reply({ content: '❌ Only GMs can set a Hero\'s signature stat.', ephemeral: true });
    const target = interaction.options.getUser('user');
    const stat = interaction.options.getString('stat');
    const ch = getChar(gid, target.id);
    if (!ch) return interaction.reply({ content: '❌ That player has no character sheet yet.', ephemeral: true });
    const nm = await getDisplayName(interaction.guild, target.id);
    if (!stat) {
      upsertChar(gid, target.id, { signature_stat: null });
      return interaction.reply({ content: `✅ Cleared **${nm}**'s signature stat.` });
    }
    if (!isHero(ch)) return interaction.reply({ content: `❌ **${nm}** isn't a Hero. Set their class first with \`/char set field:class value:Hero\`.`, ephemeral: true });
    const val = ch[stat] ?? 0;
    if (val < SIGNATURE_MIN) return interaction.reply({ content: `❌ **${nm}**'s ${STAT_LABELS[stat]} is **${val}** — a signature stat needs **${SIGNATURE_MIN}+**.`, ephemeral: true });
    upsertChar(gid, target.id, { signature_stat: stat });
    return interaction.reply({ content: `⭐ **${nm}**'s signature stat is **${STAT_LABELS[stat]}** (${val}) — their ${STAT_LABELS[stat]} rolls now have **advantage**.` });
  }

  if (sub === 'set') {
    const field = interaction.options.getString('field');
    const value = interaction.options.getString('value');
    const targetUser = interaction.options.getUser('user');
    const targetId = targetUser ? targetUser.id : callerId;
    const isGmUser = await isGm(interaction.guild, callerId);
    if (targetId !== callerId && !isGmUser)
      return interaction.reply({ content: '❌ Only GMs can modify other players\' stats.', ephemeral: true });
    // Approved sheets are frozen to their owner — every field needs a GM. This
    // has to come before the order branch, which used to write and return above
    // the check and so let an approved player re-pick their Knight Order.
    {
      const lock = sheetEditLock(gid, callerId, targetId, isGmUser);
      if (lock) return interaction.reply({ content: lock, ephemeral: true });
    }
    // Every edit below is a player-writable field, so route the reply through
    // finishSheetEdit — it re-queues the sheet for approval when it needs to be.
    const done = (content) => finishSheetEdit({
      src: interaction, gid, callerId, targetId, isGmCaller: isGmUser, content,
      reply: async (c) => {
        await interaction.reply({ content: c });
        try { return await interaction.fetchReply(); } catch { return null; }
      },
    });
    if (field === 'order') {
      const knight = KNIGHTS.find(k=>k.toLowerCase()===value.toLowerCase());
      if (!knight) return interaction.reply({ content: `❌ Choose from: ${KNIGHTS.join(', ')}`, ephemeral: true });
      upsertChar(gid, targetId, { order_name: knight });
      const upd = getChar(gid, targetId);
      if (!isWhiteKnight(upd)) setHealCharges(gid, targetId, 0);
      else { const cfg = getConfig(gid); setHealCharges(gid, targetId, cfg.heal_charges??3); }
      return done(`${KNIGHT_EMOJIS[knight]??'⚪'} Order set to **${knight}**${targetId!==callerId?` for <@${targetId}>`:''}.`);
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
      return done(`✅ ${field.toUpperCase()} set to **${num}**${targetId!==callerId?` for <@${targetId}>`:''}.${extra}`);
    }
    // Handle class, weapon and weapon emoji fields
    if (['class','weapon1','weapon2','weapon1emoji','weapon2emoji'].includes(field)) {
      if (field === 'weapon1emoji' || field === 'weapon2emoji') {
        const cleaned = validateWeaponEmoji(interaction.guild, value);
        if (!cleaned) return interaction.reply({ content: `❌ Use a standard emoji (${STANDARD_WEAPON_EMOJIS.join(' ')}) or one of this server's custom emojis.`, ephemeral: true });
        upsertChar(gid, targetId, { [field]: cleaned });
        const lbl = field === 'weapon1emoji' ? 'Weapon 1 Emoji' : 'Weapon 2 Emoji';
        return done(`✅ **${lbl}** set to ${cleaned}${targetId!==callerId?` for <@${targetId}>`:''}.`);
      }
      if (field === 'class' && String(value).toLowerCase() === 'hero' && !isGmUser) {
        return interaction.reply({ content: '❌ **Hero** is granted by a GM, not chosen. Pick Vanguard, Defender or Siege Knight.', ephemeral: true });
      }
      if (['class','weapon1','weapon2'].includes(field) && value.length > 50) {
        return interaction.reply({ content: '❌ That name is too long (max 50 characters).', ephemeral: true });
      }
      upsertChar(gid, targetId, { [field]: value });
      const label = { class:'Class', weapon1:'Weapon 1', weapon2:'Weapon 2' }[field];
      return done(`✅ **${label}** set to **${value}**${targetId!==callerId?` for <@${targetId}>`:''}.`);
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
    { const sig = signatureLine(char); if (sig) lines.push(sig); }
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
    // A snapshot restore rewrites stats — it must obey the approval lock, and
    // put the sheet back in the queue, or it'd be a way around both.
    const isGmUser = await isGm(interaction.guild, uid);
    {
      const lock = sheetEditLock(gid, uid, uid, isGmUser);
      if (lock) return interaction.reply({ content: lock, ephemeral: true });
    }
    const snap = loadProfile(gid, uid, slot);
    if (!snap) return interaction.reply({ content: `❌ No save found with name **${slot}**.`, ephemeral: true });
    upsertChar(gid, uid, { hp_current:snap.hp_current, rerolls_current:snap.rerolls_current, str:snap.str, con:snap.con, dex:snap.dex, wis:snap.wis, lck:snap.lck, order_name:snap.order_name, profile_enabled:snap.profile_enabled });
    setHealCharges(gid, uid, snap.heal_current??0);
    return finishSheetEdit({
      src: interaction, gid, callerId: uid, targetId: uid, isGmCaller: isGmUser,
      content: `📂 Profile **${slot}** loaded.`,
      link: false, // the reply is ephemeral, so a jump link would be dead for the GM
      reply: async (c) => { await interaction.reply({ content: c, ephemeral: true }); return null; },
    });
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
  const gateMsg = sheetGate(gid, uid);
  if (gateMsg) return message.reply(gateMsg);
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
    // Hero signature: a stat roll on the designated stat is made with advantage.
    if (parsed && STATS.includes(String(parsed.label || '').toLowerCase())) {
      mode = applySignatureMode(ch, String(parsed.label).toLowerCase(), mode);
    }
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
  mirrorRoll(gid, { userId: uid, channelId: cid, messageId: message.id, input: message.content,
    rollLine, context: isReroll ? 'reroll' : (successCheck ? 'success check' : null) });
  await sendRollEmbed(message, rollLine, label, false, uid, flavour, result.total, critType);
}

async function handleHeal(message, rest) {
  const gid = message.guild.id, uid = message.author.id, cid = message.channel.id;
  const gateMsg = sheetGate(gid, uid);
  if (gateMsg) return message.reply(gateMsg);
  // Accept the mention anywhere in the argument, not just flush at the start —
  // "!heal @user", "!heal  @user" and "!heal please @user" all work.
  const mentionMatch = rest.match(/<@!?(\d+)>/);
  if (!mentionMatch) return message.reply('❌ You must target a player. Usage: `!heal @user`');
  const targetId = mentionMatch[1];
  if (targetId === uid) return message.reply('❌ You cannot heal yourself.');
  const char = getChar(gid, uid);
  // This checks the HEALER's sheet — be explicit so it isn't mistaken for the target's.
  if (!char) return message.reply('❌ **You** have no character sheet yet — the healer needs one to roll WIS. Use `/char create` first.');
  if (!isWhiteKnight(char)) return message.reply('❌ Only **White Knights** with **WIS 5+** can use Heal. Your order and WIS are set with `/char set`.');
  const targetChar = getChar(gid, targetId);
  if (!targetChar) return message.reply(`❌ <@${targetId}> has no character sheet yet.`);
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
  mirrorRoll(gid, { userId: uid, channelId: cid, messageId: message.id, input: message.content, rollLine, context: 'heal' });
  let content;
  if (char.profile_enabled === 1) {
    content = buildRollEmbed({ rollLine, label:'heal', isReroll:false, char:{...upd,displayName:dn}, healCharges:newCharges, maxCharges:mc, flavour:null, total, critType:null });
    content += `\n${resultText}`;
  } else {
    content = `**heal**\n${rollLine}\n${resultText}`;
  }
  await message.reply(content);
}

// Shared by !hp and !rerolls: "+5", "@user -3" and "-3 @user" all parse, and
// targeting anyone else needs the GM role. Returns { targetId, amount } or
// { error } for the caller to reply with.
async function parseTargetAmount(message, rest, resourceLabel, usage) {
  const uid = message.author.id;
  rest = String(rest || '').trim();
  const mm  = rest.match(/^<@!?(\d+)>\s*([+-]\d+)$/);   // @user +5
  const mm2 = rest.match(/^([+-]\d+)\s*<@!?(\d+)>$/);   // +5 @user
  const sm  = rest.match(/^([+-]\d+)$/);                 // +5  (self)
  if (mm || mm2) {
    if (!(await isGm(message.guild, uid)))
      return { error: `❌ Only GMs can modify other players' ${resourceLabel}.` };
    return mm ? { targetId: mm[1], amount: parseInt(mm[2]) }
              : { targetId: mm2[2], amount: parseInt(mm2[1]) };
  }
  if (sm) return { targetId: uid, amount: parseInt(sm[1]) };
  return { error: `❌ Usage: ${usage}` };
}

async function handleHp(message, rest) {
  const gid = message.guild.id, uid = message.author.id;
  const t = await parseTargetAmount(message, rest, 'HP', '`!hp +5` or `!hp @user -3`');
  if (t.error) return message.reply(t.error);
  const { targetId, amount } = t;
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
  const t = await parseTargetAmount(message, rest, 'rerolls', '`!rerolls +1` or `!rerolls @user -1`');
  if (t.error) return message.reply(t.error);
  const { targetId, amount } = t;
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
  const mm = String(rest || '').match(/<@!?(\d+)>/);
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

  // Mirror GM rolls to the audit channel too — including secret ones, so other
  // GMs can see them. Secret rolls stay hidden from players (DM + private
  // audit channel); only the audit copy is marked so it's clear it was secret.
  mirrorRoll(gid, {
    userId: uid, channelId: message.channel.id, messageId: message.id,
    input: message.content, rollLine,
    context: secret ? 'GM roll · 🔒 secret' : 'GM roll',
  });

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

  // Pasting a sheet rewrites everything — respect the approval lock, and send it
  // back to the queue afterwards, so it can't be used to sidestep a GM.
  const isGmImporter = await isGm(message.guild, uid);
  {
    const lock = sheetEditLock(gid, uid, targetId, isGmImporter);
    if (lock) return message.reply(lock);
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
  await finishSheetEdit({
    src: message, gid, callerId: uid, targetId, isGmCaller: isGmImporter,
    content: lines.join('\n'),
    reply: async (c) => message.reply(c).catch(() => null),
  });
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

      // Quest number autocomplete — shows "#001-Goblin Cave" filtered by status per subcommand
      if (interaction.commandName === 'quest' && focusedOption.name === 'number') {
        const sub = interaction.options.getSubcommand(false);
        let quests = listQuests(interaction.guild.id);
        if (sub === 'apply') quests = quests.filter(q => q.status === 'open');
        else if (sub === 'start') quests = quests.filter(q => q.status === 'open');
        else if (sub === 'complete') quests = quests.filter(q => q.status !== 'completed');
        const v = String(focusedOption.value).toLowerCase();
        const choices = quests
          .filter(q => questTag(q).toLowerCase().includes(v) || String(q.number).includes(v))
          .slice(0, 25)
          .map(q => ({ name: `${questTag(q)} · ${questStatusBadge(q.status)}`.slice(0, 100), value: q.number }));
        return await interaction.respond(choices);
      }

      // Rank name autocomplete (/rank remove, /rank promote)
      if ((interaction.commandName === 'rank' && focusedOption.name === 'rank') ||
          (interaction.commandName === 'rank' && focusedOption.name === 'name' && interaction.options.getSubcommand(false) === 'remove')) {
        const v = String(focusedOption.value).toLowerCase();
        const choices = getRanks(interaction.guild.id)
          .filter(r => r.name.toLowerCase().includes(v))
          .slice(0, 25)
          .map(r => ({ name: `${r.name} (${r.threshold})`.slice(0, 100), value: r.name }));
        return await interaction.respond(choices);
      }

      if (interaction.commandName === 'gmheal' && focusedOption.name === 'npc') {
        const v = String(focusedOption.value).toLowerCase();
        const choices = [{ name: 'all', value: 'all' },
          ...getAllNpcs(interaction.guild.id).map(n => ({ name: n.name.slice(0,100), value: n.name }))]
          .filter(c => c.name.toLowerCase().includes(v)).slice(0, 25);
        return await interaction.respond(choices);
      }

      if (interaction.commandName === 'npc' && focusedOption.name === 'category') {
        const v = String(focusedOption.value).toLowerCase();
        const choices = getCategories(interaction.guild.id)
          .filter(c => c.toLowerCase().includes(v))
          .slice(0, 25)
          .map(c => ({ name: c.slice(0, 100), value: c }));
        return await interaction.respond(choices);
      }

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
      // Comma-aware NPC lists (/npc heal names, /fight refill npcs):
      // complete the segment after the last comma, offer "all"
      if ((interaction.commandName === 'npc' && focusedOption.name === 'names') ||
          (interaction.commandName === 'fight' && focusedOption.name === 'npcs')) {
        const typed = (focusedOption.value || '').toString();
        const lastComma = typed.lastIndexOf(',');
        const head = lastComma === -1 ? '' : typed.slice(0, lastComma + 1) + ' ';
        const seg = (lastComma === -1 ? typed : typed.slice(lastComma + 1)).trim().toLowerCase();
        const already = new Set(lastComma === -1 ? [] : parseNpcNames(typed.slice(0, lastComma + 1)).map(s => s.toLowerCase()));
        const npcs = getAllNpcs(interaction.guild.id).filter(n => !already.has(n.name.toLowerCase()));
        const choices = npcs
          .filter(n => n.name.toLowerCase().includes(seg))
          .slice(0, 24)
          .map(n => ({ name: (head + n.name).slice(0, 100), value: (head + n.name).slice(0, 100) }));
        if (!head && 'all'.startsWith(seg)) choices.unshift({ name: 'all — every NPC on the server', value: 'all' });
        return await interaction.respond(choices.slice(0, 25));
      }
      // Fight NPC fields — suggest server NPC names
      if (interaction.commandName === 'fight' &&
          (focusedOption.name === 'npc' || focusedOption.name === 'target_npc')) {
        const focused = (focusedOption.value || '').toString().toLowerCase();
        const npcs = getAllNpcs(interaction.guild.id);
        const filtered = npcs
          .filter(n => n.name.toLowerCase().includes(focused))
          .slice(0, 25)
          .map(n => ({ name: n.name, value: n.name }));
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
  if (interaction.isModalSubmit?.()) {
    if (interaction.customId.startsWith('npcsay:')) return handleNpcSayModal(interaction);
    return;
  }

  if (interaction.isButton()) {
    if (interaction.customId.startsWith('confirm:') || interaction.customId.startsWith('cancel:')) {
      return handleConfirmButton(interaction);
    }
    if (interaction.customId.startsWith('questapply:') || interaction.customId.startsWith('questwithdraw:')) {
      return handleQuestButton(interaction);
    }
    if (interaction.customId.startsWith('sheetok:') || interaction.customId.startsWith('sheetno:')) {
      return handleSheetApprovalButton(interaction);
    }
    if (interaction.customId.startsWith('exportok:') || interaction.customId.startsWith('exportno:')) {
      return handleExportRequestButton(interaction);
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
    if (interaction.commandName === 'gmheal') return await handleGmHeal(interaction);
    if (interaction.commandName === 'roll') return await handleRollSlash(interaction);
    if (interaction.commandName === 'merit') return await handleMerit(interaction);
    if (interaction.commandName === 'rank') return await handleRank(interaction);
    if (interaction.commandName === 'quest') return await handleQuest(interaction);
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

// ── Bare stat shorthand ───────────────────────────────────────────────────────
// Type a stat name to quick-roll 1d20+stat with no prefix. Optional ? prefix for
// a success check, optional suffix:
//   a / d          → fresh roll with advantage / disadvantage   (wisa, dexd)
//   rr / rra / rrd → reroll your last roll (1 token)            (strrr, conrra)
// followed by an optional label / flavour after a space or newline.
//
// The catch: str / con / dex / wis / lck are ordinary words in TTRPG chat, so a
// message that merely *started* with one got rolled — "Dex or strength can both
// be used to throw things" came back as a DEX check labelled with the rest of
// the sentence. A plain stat with no prefix and no suffix must therefore be the
// entire message and nothing else.
//
// Everything unambiguous keeps its label, because no ordinary word looks like
// it: "strrr atk", "dexd guard", "wisa sneak", "?dex atk". For a label on a
// plain stat, use a prefix — `r str atk` or `?str atk`.
//
// Returns null when the message is just conversation.
function parseStatShorthand(content) {
  const m = content.match(/^(\?)?(str|con|dex|wis|lck)(rra|rrd|rr|a|d)?(?:([ \t][\s\S]*)|(\n[\s\S]*))?$/i);
  if (!m) return null;
  const sc = m[1] === '?';
  const stat = m[2].toLowerCase();
  const suffix = (m[3] || '').toLowerCase(); // '', 'a', 'd', 'rr', 'rra', 'rrd'
  const trailing = (m[4] ?? m[5] ?? '').replace(/^[ \t]+/, '');
  // The ambiguous form — bare stat word, no prefix, no suffix — only fires on an
  // exact match. Anything trailing means this is a sentence, not a roll.
  if (!sc && !suffix && trailing.trim()) return null;
  const isReroll = suffix.startsWith('rr');
  const mode = (suffix === 'a' || suffix === 'rra') ? 'adv'
             : (suffix === 'd' || suffix === 'rrd') ? 'dis'
             : 'normal';
  // Fresh roll: hand handleRoll the stat name so it resolves to 1d20+stat.
  // Reroll: the label/flavour ride along; the suffix only selects adv/dis.
  const payload = isReroll ? trailing : (stat + (trailing ? ' ' + trailing : ''));
  return { sc, stat, suffix, mode, isReroll, payload };
}

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.trim();


  // NPC image bank — detect image uploads in the configured NPC channel
  if (message.guild && message.attachments.size > 0) {
    const cfg = getConfig(message.guild.id);
    // Tracing: an avatar upload that does nothing is impossible to diagnose
    // otherwise. These lines show in the Railway logs.
    console.log(`[npcimg] attachment in ${message.channel.id}; configured=${cfg.npc_channel_id || 'NONE'}; text="${message.content}"`);
    if (!cfg.npc_channel_id) {
      await message.reply('⚠️ No NPC image channel is set. An admin needs to run `/config npcchannel`.').catch(()=>{});
      return;
    }
    if (message.channel.id === cfg.npc_channel_id) {
      const npcName = message.content.trim();
      if (!npcName) {
        console.error('[npcimg] message.content is EMPTY — if you did type a name, the Message Content Intent is disabled in the Developer Portal.');
        await message.reply('⚠️ I can\'t read the message text. Either add the NPC\'s name as the caption, or — if you did — a bot admin needs to enable **Message Content Intent** in the Discord Developer Portal.').catch(()=>{});
        return;
      }
      const npc = getNpc(message.guild.id, npcName);
      if (!npc) {
        console.error(`[npcimg] no NPC named "${npcName}" in guild ${message.guild.id}`);
        await message.reply(`⚠️ No NPC named **${npcName}** on this server. Create them first with \`/npc create name:${npcName}\`, then re-upload.`).catch(()=>{});
        return;
      }
      const imageUrl = message.attachments.first().url;
      setNpcImage(message.guild.id, npcName, imageUrl);
      setNpcWebhook(message.guild.id, npcName, null, null);
      clearNpcWebhooks(message.guild.id, npc.name); // recreate everywhere with the new avatar
      console.log(`[npcimg] avatar set for "${npc.name}"`);
      message.react('✅').catch(()=>{});
      await message.reply(`✅ Avatar set for **${npc.name}**.`).catch(()=>{});
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

  // Bare stat shorthand — see parseStatShorthand for the matching rules.
  const statShort = parseStatShorthand(content);
  if (statShort) {
    try { return await handleRoll(message, statShort.payload, statShort.mode, statShort.isReroll, statShort.sc); }
    catch (err) { console.error(err); return message.reply('❌ Something went wrong.'); }
  }

  // Bare (unprefixed) commands must not swallow ordinary chat: without a ! or ?
  // prefix, a command word can't be followed immediately by another letter.
  // "Hmm" / "hey" / "rest" / "right" are conversation; "!h @user", "r1d20",
  // "heal @user" and "hp +5" are commands.
  const match = content.match(/^(!|\?)(gmrs?|lrest|srest|hpfull|hphalf|rerolls|roll|rra|rrd|rr|ra|rd|r|heal|hp|h)([\s\S]*)/i)
    || content.match(/^()(gmrs?|lrest|srest|hpfull|hphalf|rerolls|roll|rra|rrd|rr|ra|rd|r|heal|hp|h)(?![A-Za-z])([\s\S]*)/i);
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
    if (guildId) {
      // Guild-scoped: NPC name choices are per-server, so they must not be
      // pushed globally or one server's NPCs appear in every other server.
      // Guild updates also appear instantly instead of taking up to an hour.
      await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId), { body: commands.map(c => c.toJSON()) });
    } else {
      // Boot-time global registration uses the generic command set (no NPC choices).
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(c => c.toJSON()) });
    }
    console.log('✅ Slash commands registered.');
  } catch (err) { console.error('Failed to register slash commands:', err); }
}

// Commands are registered per-guild (see the ready handler) so that NPC name
// choices stay server-specific. Any previously-registered GLOBAL commands would
// show up as duplicates alongside them, so clear the global set on boot.
async function clearGlobalCommands() {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const existing = await rest.get(Routes.applicationCommands(process.env.CLIENT_ID));
    if (Array.isArray(existing) && existing.length) {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: [] });
      console.log(`🧹 Cleared ${existing.length} global command(s) — guild commands are authoritative.`);
    }
  } catch (err) { console.error('Could not clear global commands:', err?.message || err); }
}

(async () => {
  console.log('Starting up...');
  await clearGlobalCommands();
  client.login(process.env.DISCORD_TOKEN);
})();

// Keep the process alive if a stray promise rejects or a handler throws async.
// Better to log and keep serving other channels than to crash the whole bot.
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
// ─────────────────────────────────────────────
//  FIGHT SYSTEM
// ─────────────────────────────────────────────

const STAT_LABELS = { str:'STR', con:'CON', dex:'DEX', wis:'WIS', lck:'LCK' };
const STAT_EMOJIS = { str:'💪', con:'🫀', dex:'⚡', wis:'🧠', lck:'🍀' };
const STAT_NAMES  = { str:'Strength', con:'Constitution', dex:'Dexterity', wis:'Wisdom', lck:'Luck' };

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

// ── Carry-over combat effects (nat-1 attack / nat-20 defence) ─────────────────
// effect_state is a JSON map { fid: { flatDef?: true, atkBonus?: N } } stored on
// the fight row, mirroring hp_state / rr_state. Effects are SET when an exchange
// resolves and CONSUMED on the affected fighter's next matching roll.
//
//   nat-1 attack  → attacker's NEXT defence is a flat d20 (no stat)   { flatDef:true }
//   nat-20 defence (that blocks) → defender's NEXT attack gets +2,    { atkBonus:2 }
//     UNLESS the incoming attack was itself a nat 20.
// Pull and clear an attacker's pending +N bonus. Returns the bonus (0 if none).
function consumeAtkBonus(gid, cid, fid) {
  const fight = getFight(gid, cid);
  const all = JSON.parse(fight.effect_state || '{}');
  const bonus = all[fid]?.atkBonus ?? 0;
  if (bonus && all[fid]) {
    delete all[fid].atkBonus;
    if (!Object.keys(all[fid]).length) delete all[fid];
    upsertFight(gid, cid, { effect_state: JSON.stringify(all) });
  }
  return bonus;
}
// Pull and clear a defender's pending flat-d20 penalty. Returns true if it applied.
function consumeFlatDef(gid, cid, fid) {
  const fight = getFight(gid, cid);
  const all = JSON.parse(fight.effect_state || '{}');
  const flat = !!all[fid]?.flatDef;
  if (flat && all[fid]) {
    delete all[fid].flatDef;
    if (!Object.keys(all[fid]).length) delete all[fid];
    upsertFight(gid, cid, { effect_state: JSON.stringify(all) });
  }
  return flat;
}
// After an exchange resolves, set any new carry-over effects. atkNat/defNat are
// the natural dice; `blocked` is true when the defence stopped the attack.
function applyExchangeEffects(gid, cid, attackerId, defenderId, atkNat, defNat) {
  const fight = getFight(gid, cid);
  const all = JSON.parse(fight.effect_state || '{}');
  const ensure = (fid) => (all[fid] = all[fid] || {});
  const notes = [];
  // Nat-1 attack: the attacker fumbles — their next defence is a flat d20.
  if (atkNat === 1) {
    ensure(attackerId).flatDef = true;
    notes.push('flat_def');
  }
  // Nat-20 defence that blocks: defender's next attack gets +2, unless the
  // attack was also a nat 20 (a perfect strike negates the riposte bonus).
  if (defNat === 20 && atkNat !== 20) {
    ensure(defenderId).atkBonus = 2;
    notes.push('atk_bonus');
  }
  upsertFight(gid, cid, { effect_state: JSON.stringify(all) });
  return notes;
}
// Drop all effects for a fighter (used when they leave the fight).
function clearEffects(gid, cid, fid) {
  const fight = getFight(gid, cid);
  if (!fight) return;
  const all = JSON.parse(fight.effect_state || '{}');
  if (all[fid]) { delete all[fid]; upsertFight(gid, cid, { effect_state: JSON.stringify(all) }); }
}
// Human-readable lines for newly-applied effects (notes from applyExchangeEffects).
function effectNoteLines(notes, atkName, defName) {
  const out = [];
  if (notes.includes('flat_def')) out.push(`🎲 **Natural 1!** ${atkName} fumbles — their next defence is a flat d20.`);
  if (notes.includes('atk_bonus')) out.push(`✨ **Natural 20 defence!** ${defName} turns it aside and gains **+2** on their next attack.`);
  return out;
}

// ── Fighter identity helpers (mixed players + NPCs) ───────────────────────────
// A fighter id is either a Discord user id (all digits) or "npc:<Name>".
const NPC_PREFIX = 'npc:';
function isNpcFighter(id) { return typeof id === 'string' && id.startsWith(NPC_PREFIX); }
function npcFighterId(name) { return NPC_PREFIX + name; }
function npcNameFromFighter(id) { return isNpcFighter(id) ? id.slice(NPC_PREFIX.length) : null; }

// Resolve a fighter id to { id, name, stats, isNpc }. stats has str/con/dex/wis/lck.
async function resolveFighter(guild, gid, fid) {
  if (isNpcFighter(fid)) {
    const name = npcNameFromFighter(fid);
    const npc = getNpc(gid, name);
    return {
      id: fid, name, isNpc: true,
      stats: npc ? { str:npc.str, con:npc.con, dex:npc.dex, wis:npc.wis, lck:npc.lck } : { str:0,con:0,dex:0,wis:0,lck:0 },
      maxHp: npc ? npc.con + 2 : 0,
    };
  }
  const member = await guild.members.fetch(fid).catch(()=>null);
  const name = member?.nickname || member?.user.username || fid;
  const char = getChar(gid, fid);
  return {
    id: fid, name, isNpc: false,
    stats: char ? { str:char.str, con:char.con, dex:char.dex, wis:char.wis, lck:char.lck } : { str:0,con:0,dex:0,wis:0,lck:0 },
    maxHp: char ? maxHp(char) : 0,
  };
}

// Persist a fighter's current HP to the right table (character vs npc).
function setFighterHp(gid, fid, hp) {
  if (isNpcFighter(fid)) {
    upsertNpc(gid, npcNameFromFighter(fid), { hp_current: hp });
  } else {
    upsertChar(gid, fid, { hp_current: hp });
  }
}

// Parse "@Alice @Bob" (or raw ids) into an ordered, de-duplicated list of user ids.
function parsePlayerMentions(str) {
  if (!str) return [];
  const ids = [];
  const re = /<@!?(\d+)>|\b(\d{15,21})\b/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    const id = m[1] || m[2];
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

// Parse "Goblin, Cave Orc, Boss" into a trimmed, de-duplicated list of names.
function parseNpcNames(str) {
  if (!str) return [];
  const names = [];
  for (const raw of str.split(',')) {
    const n = raw.trim();
    if (n && !names.includes(n)) names.push(n);
  }
  return names;
}

// Pick the stat an auto fighter rolls with — always the highest of STR/DEX,
// for both attack and defence (ties go to STR).
function autoFightStat(stats) {
  return (stats.str ?? 0) >= (stats.dex ?? 0) ? 'str' : 'dex';
}
// Roll a d20 + modifier, returning { nat, total }.
function autoRoll(mod, adv = false) {
  if (adv) {
    const a = rollDie(20), b = rollDie(20);
    const nat = Math.max(a, b);
    return { nat, total: nat + mod, adv: true, dropped: Math.min(a, b) };
  }
  const nat = rollDie(20);
  return { nat, total: nat + mod };
}

// Default: auto NPCs only spend a reroll token when the natural die was this or lower.
const NPC_RR_NAT_MAX = 8;
// Per-guild override via /config npcreroll (0 disables auto rerolls entirely).
function getNpcRrThreshold(gid) {
  const v = getConfig(gid)?.npc_rr_threshold;
  return (v === null || v === undefined) ? NPC_RR_NAT_MAX : v;
}
// One-line summary of a Hero's signature stat, e.g. "⭐  Signature  STR (advantage)".
// Returns null when the row isn't a Hero or has no signature set.
function signatureLine(row, pad = false) {
  if (!isHero(row) || !row?.signature_stat) return null;
  const stat = String(row.signature_stat).toLowerCase();
  const emoji = STAT_EMOJIS[stat] ?? '⭐';
  const name = STAT_NAMES[stat] ?? (STAT_LABELS[stat] ?? stat.toUpperCase());
  const active = hasSignatureAdvantage(row, stat);
  const suffix = active ? 'advantage' : `advantage *(inactive — needs ${SIGNATURE_MIN}+)*`;
  return pad ? `  ${emoji}: ${name} ${active ? 'advantage' : `advantage (inactive — needs ${SIGNATURE_MIN}+)`}`
             : `${emoji}:  ${name} ${suffix}`;
}

// ── NPC HP visibility ─────────────────────────────────────────────────────────
// Players shouldn't know an NPC's HP pool, but damage dealt should still be
// obvious. When hidden we report the damage and a coarse condition instead of
// exact numbers. GMs see real figures via /npc show, /npc list and /fight hp.
function npcStatsVisible(gid) {
  return !!getConfig(gid)?.npc_stats_visible;
}
// ── Practice bouts ────────────────────────────────────────────────────────────
// A friendly spar stops short of real harm: a fighter bows out the moment they
// reach the floor instead of being driven to 0 and beyond, and damage never
// carries anyone below it. The floor lives on the fight row, so a channel can
// run a real fight before and after a bout without any global switch. Every
// downstream check compares against the floor rather than a literal 0 — in a
// real fight the floor is 0 and behaviour is exactly as it always was.
const PRACTICE_FLOOR = 2;
const NO_ACTIVE_FIGHT = '❌ No active fight in this channel.';
function fightFloor(fight) {
  const v = Number(fight?.floor_hp ?? 0);
  return Number.isFinite(v) && v > 0 ? v : 0;
}
// Apply damage without pushing a sparring partner below the floor.
function applyFightDamage(prevHp, dmg, floor) {
  const raw = prevHp - dmg;
  return floor > 0 ? Math.max(floor, raw) : raw;
}
// Vocabulary swap so a bout doesn't read like a killing.
function fightWords(floor) {
  return floor > 0
    ? { icon: '🏳️', out: 'yields the bout', win: 'takes the bout', noun: 'bout',  started: 'Practice bout started!' }
    : { icon: '💀', out: 'has been knocked down', win: 'wins the fight', noun: 'fight', started: 'Fight started!' };
}
// Banner so nobody mistakes a spar for the real thing.
function practiceBanner(floor) {
  return floor > 0
    ? `🏳️ **Practice bout** — friendly sparring. Fighters bow out at **${floor} HP** and are never driven below it.`
    : null;
}

// Coarse health descriptor from a ratio — enough to follow a fight's momentum.
// `floor` is the bout cut-off (0 in a real fight).
function hpCondition(cur, max, floor = 0) {
  if (cur <= floor) return floor > 0 ? '🏳️ yielded' : '💀 down';
  const pct = max > 0 ? cur / max : 1;
  if (pct >= 0.85) return '💚 unhurt';
  if (pct >= 0.55) return '💛 wounded';
  if (pct >= 0.25) return '🧡 badly hurt';
  return '❤️‍🩹 near death';
}
// The "X → Y" line after damage. For hidden NPCs: damage plus condition only.
// "1d20+3 → [3] +3 = 6" gives an NPC's stat away — strip the modifier while NPC
// stats are hidden, leaving the natural die and the final total. One copy, so a
// second roll path can't quietly leak what the first hides.
function maskNpcRollLine(gid, rollLine) {
  if (npcStatsVisible(gid)) return rollLine;
  return rollLine
    .replace(/(\d+d\d+)[+-]\d+/g, '$1')
    .replace(/\]\s*[+-]\d+\s*=/g, '] =');
}

// The NPC block printed under a roll card. `cur` supplies the live reroll/LCK
// figures — the reroll path passes the refreshed row, everyone else the same one.
function npcCardFooter(gid, npc, cur = npc) {
  const lines = ['─────────────────────────────', `⚔️  ${npc.name}`];
  if (npc.order_name) lines.push(`${KNIGHT_EMOJIS[npc.order_name]??'⚪'}  ${npc.order_name}`);
  if (!npcStatsVisible(gid)) {
    lines.push(`❤️  ${hpCondition(npc.hp_current, npc.con + 2)}`);
  } else {
    lines.push(`❤️  HP${pad(npc.hp_current)} / ${npc.con + 2}`);
    lines.push(`🔄  Rerolls${pad(cur.lck)} / ${npc.lck}`);
    lines.push('');
    lines.push(`💪  STR${pad(npc.str)}`);
    lines.push(`🫀  CON${pad(npc.con)}`);
    lines.push(`⚡  DEX${pad(npc.dex)}`);
    lines.push(`🧠  WIS${pad(npc.wis)}`);
    lines.push(`🍀  LCK${pad(cur.lck)}`);
  }
  return lines;
}

function hpChangeLine(gid, isNpc, name, prevHp, newHp, maxHpVal, floor = 0) {
  if (isNpc && !npcStatsVisible(gid)) {
    return `❤️ ${name}: ${hpCondition(newHp, maxHpVal, floor)}`;
  }
  return `❤️ ${name} HP: **${prevHp} → ${newHp}**`;
}

// Once a sheet is approved, EVERY sheet field is GM-only — stats, order, class,
// weapons and weapon emojis alike. Returns an error string, or null if allowed.
function sheetEditLock(gid, callerId, targetId, isGmCaller) {
  if (!approvalEnabled(gid)) return null;      // feature off
  if (targetId !== callerId) return null;      // GM editing someone else (already gated)
  if (isGmCaller) return null;                 // GMs may always edit
  const own = getChar(gid, callerId);
  if (own?.approval_state === 'approved') {
    return '🔒 Your sheet is approved — only a GM can change it now. Ask a GM for any edits.';
  }
  if (own?.approval_state === 'pending') {
    return '⏳ Your sheet is awaiting GM approval — wait for it to be reviewed before editing.';
  }
  return null;
}

// ── Character sheet approval ──────────────────────────────────────────────────
// approval_state: null = legacy sheet (pre-feature, treated as approved),
// 'pending' = awaiting a GM, 'approved' = usable, 'rejected' = blocked.
// Approval is only enforced once a GM has set an approval channel; without one
// the whole feature stays dormant so existing servers are unaffected.
function approvalEnabled(gid) {
  return !!getConfig(gid)?.approval_channel_id;
}
function sheetApproved(gid, ch) {
  if (!ch) return false;
  if (!approvalEnabled(gid)) return true;          // feature off → everything works
  if (!ch.approval_state) return true;             // sheet predates the feature
  return ch.approval_state === 'approved';
}
// Guard for player actions that need a usable sheet. Returns an error string, or null.
function sheetGate(gid, uid) {
  const ch = getChar(gid, uid);
  if (!ch) return null;                            // "no sheet" handled by callers
  if (sheetApproved(gid, ch)) return null;         // single source of truth
  if (ch.approval_state === 'pending') return '⏳ Your character sheet is **awaiting GM approval** — you can\'t roll or fight until it\'s approved.';
  return '🚫 Your character sheet was **rejected** by a GM. Speak to them before rolling.';
}
// ── Character sheet exports ───────────────────────────────────────────────────
// With approvals on, /char export doesn't hand the sheet straight back. The
// export block goes to the approval channel for a GM to read, and the player
// only receives it once a GM presses Release. This is deliberately separate from
// sheet approval: exporting is not a sheet edit, so it never touches
// approval_state and never stops anyone rolling. One live request per player —
// a new export supersedes the last, the same way a re-submitted sheet does.
function setExportRequest(gid, uid, payload, fmt, srcChannel) {
  db.prepare(`INSERT INTO export_requests (guild_id, user_id, payload, fmt, src_channel, msg_id, requested_at)
              VALUES (?,?,?,?,?,NULL,?)
              ON CONFLICT(guild_id, user_id) DO UPDATE SET
                payload=excluded.payload, fmt=excluded.fmt, src_channel=excluded.src_channel,
                msg_id=NULL, requested_at=excluded.requested_at`)
    .run(gid, uid, payload, fmt || 'text', srcChannel || null, Date.now());
}
function getExportRequest(gid, uid) {
  return db.prepare('SELECT * FROM export_requests WHERE guild_id=? AND user_id=?').get(gid, uid);
}
function setExportRequestMsg(gid, uid, msgId) {
  db.prepare('UPDATE export_requests SET msg_id=? WHERE guild_id=? AND user_id=?').run(msgId, gid, uid);
}
function clearExportRequest(gid, uid) {
  db.prepare('DELETE FROM export_requests WHERE guild_id=? AND user_id=?').run(gid, uid);
}
function exportButtons(uid) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`exportok:${uid}`).setLabel('Release to player').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`exportno:${uid}`).setLabel('Decline').setStyle(ButtonStyle.Danger),
  );
}

// Post an export request to the approval channel. Returns the channel id, or
// null if it couldn't be delivered.
async function requestSheetExport(interaction, gid, uid, payload, fmt) {
  const chId = getConfig(gid)?.approval_channel_id;
  if (!chId) return null;
  const nm = await getDisplayName(interaction.guild, uid);
  const roles = getGmRoleIds(gid);
  const ping = roles.length ? roles.map(r => `<@&${r}>`).join(' ') + ' ' : '';
  const prev = getExportRequest(gid, uid);
  setExportRequest(gid, uid, payload, fmt, interactionChannelId(interaction));
  const head = [
    `${ping}📤 **Sheet export requested**`,
    `👤 <@${uid}> (**${nm}**)${fmt !== 'text' ? '  ·  🖼️ image requested' : ''}`,
    '─────────────────────────────',
    'Release sends this to the player; decline and they get nothing.',
  ].join('\n');
  try {
    const channel = await interaction.client.channels.fetch(chId);
    // Retire the player's previous request so only one is live at a time.
    if (prev?.msg_id) {
      try {
        const old = await channel.messages.fetch(prev.msg_id);
        await old.edit({ content: `~~📤 Export request from <@${uid}>~~\n↩️ *Superseded — they exported again; see the newer request below.*`, components: [] });
      } catch {}
    }
    // The block can be long, so the request header and the sheet go separately
    // and the buttons ride on the last message.
    await channel.send({ content: head, allowedMentions: { roles } });
    const msg = await channel.send({ content: payload.length > 1900 ? payload.slice(0, 1900) : payload,
      components: [exportButtons(uid)], allowedMentions: { parse: [] } });
    setExportRequestMsg(gid, uid, msg.id);
    return channel.id;
  } catch { clearExportRequest(gid, uid); return null; }
}

function approvalButtons(uid) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sheetok:${uid}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`sheetno:${uid}`).setLabel('Reject').setStyle(ButtonStyle.Danger),
  );
}
// Post an approval request to the configured channel, pinging every GM role.
// `src` is anything with .client / .guild / .channelId — a ChatInputInteraction
// or a plain Message, since sheets arrive by slash command and by paste.
async function requestSheetApproval(src, gid, uid, submitMessageId = null) {
  const chId = getConfig(gid)?.approval_channel_id;
  if (!chId) return null;
  const ch = getChar(gid, uid);
  if (!ch) return null;
  const nm = await getDisplayName(src.guild, uid);
  const roles = getGmRoleIds(gid);
  const ping = roles.length ? roles.map(r => `<@&${r}>`).join(' ') + ' ' : '';
  const lines = [
    `${ping}📋 **Sheet approval requested**`,
    `👤 <@${uid}> (**${nm}**)`,
    '─────────────────────────────',
    `💪 STR ${ch.str ?? 0}   🛡️ CON ${ch.con ?? 0}   ⚡ DEX ${ch.dex ?? 0}`,
    `🦉 WIS ${ch.wis ?? 0}   🍀 LCK ${ch.lck ?? 0}`,
    `❤️ HP ${ch.hp_current ?? 0} / ${maxHp(ch)}   🔄 Rerolls ${ch.rerolls_current ?? 0} / ${maxRerolls(ch)}`,
    ch.order_name ? `${KNIGHT_EMOJIS[ch.order_name] ?? '⚪'} ${ch.order_name}` : null,
    ch.class ? `🎖️ ${ch.class}` : null,
    (ch.weapon1 || ch.weapon2) ? `⚔️ ${[ch.weapon1, ch.weapon2].filter(Boolean).join(' · ')}` : null,
  ].filter(Boolean);
  // Jump link back to where the sheet was submitted, so a GM can see the context.
  const srcCh = interactionChannelId(src);
  if (srcCh) upsertChar(gid, uid, { approval_src_channel: srcCh }); // for the decision notice
  let jumpId = submitMessageId;
  if (!jumpId && typeof src.fetchReply === 'function') {
    try { const rep = await src.fetchReply(); jumpId = rep?.id ?? null; } catch {}
  }
  if (srcCh && jumpId) lines.push(`\n[↗ Jump to submission](https://discord.com/channels/${gid}/${srcCh}/${jumpId})`);
  try {
    const channel = await src.client.channels.fetch(chId);
    // Editing a pending sheet re-queues it. Retire the previous request so the
    // channel holds one live entry per player instead of a pile of stale ones
    // with working buttons.
    const oldId = ch.approval_msg_id;
    if (oldId) {
      try {
        const old = await channel.messages.fetch(oldId);
        await old.edit({ content: `~~📋 Sheet approval request for <@${uid}>~~\n↩️ *Superseded — they edited the sheet again; see the newer request below.*`, components: [] });
      } catch {}
    }
    const msg = await channel.send({ content: lines.join('\n'), components: [approvalButtons(uid)],
      allowedMentions: { roles } });
    upsertChar(gid, uid, { approval_msg_id: msg.id });
    return channel.id;
  } catch { return null; }
}

// Does this edit put the sheet (back) in the approval queue? Any change a player
// makes to their OWN sheet does, while approvals are on. Without this, /char set,
// /profile load and a pasted sheet were each a way to build a character the GMs
// never saw: they only checked the edit *lock*, which lets a sheet with no
// approval_state through, and nothing ever moved it to 'pending'.
function sheetNeedsResubmit(gid, callerId, targetId, isGmCaller) {
  if (!approvalEnabled(gid)) return false;   // feature off
  if (isGmCaller) return false;              // GM edits are sign-off in themselves
  return targetId === callerId;              // players editing someone else is already blocked
}

// Shared tail for every player-writable sheet edit. `reply` posts the message and
// returns it (or null) so the approval post can link back. Set link:false when
// the reply is ephemeral — a jump link to it would be dead for the GM.
async function finishSheetEdit({ src, gid, callerId, targetId, isGmCaller, content, reply, link = true }) {
  if (!sheetNeedsResubmit(gid, callerId, targetId, isGmCaller)) {
    // A GM building a sheet from nothing shouldn't leave it looking like a
    // pre-feature legacy sheet — approve it outright, as /char create does.
    if (approvalEnabled(gid) && isGmCaller && !getChar(gid, targetId)?.approval_state) {
      upsertChar(gid, targetId, { approval_state: 'approved' });
    }
    return reply(content);
  }
  upsertChar(gid, targetId, { approval_state: 'pending' });
  const chId = getConfig(gid)?.approval_channel_id;
  const sent = await reply(content + (chId
    ? `\n\n⏳ **Sent to <#${chId}> for GM approval.** You can't roll or fight until it's signed off, and you can keep editing until a GM decides.\n📬 You'll get a DM as soon as they do.`
    : '\n\n⚠️ No approval channel set — ask a GM to check `/config approvals`.'));
  await requestSheetApproval(src, gid, targetId, link ? (sent?.id ?? null) : null);
  return sent;
}

// ── Hero signature stat ───────────────────────────────────────────────────────
// A Hero (GM-assigned class) may have one designated stat with 5+ points. Rolls
// using that stat are made with advantage. The 5-point floor is checked live, so
// if the stat later drops below 5 the advantage simply stops applying.
const SIGNATURE_MIN = 5;
function isHero(row) {
  return String(row?.class || '').toLowerCase() === 'hero';
}
// Does this character/NPC row get advantage on `stat` right now?
function hasSignatureAdvantage(row, stat) {
  if (!row || !stat) return false;
  if (!isHero(row)) return false;
  if (String(row.signature_stat || '').toLowerCase() !== String(stat).toLowerCase()) return false;
  return (row[stat] ?? 0) >= SIGNATURE_MIN;
}
// Upgrade a roll mode to advantage when the signature applies. An explicit
// disadvantage from the caller still wins — the two cancel rather than stack.
function applySignatureMode(row, stat, mode) {
  if (mode === 'dis') return mode;
  return hasSignatureAdvantage(row, stat) ? 'adv' : mode;
}

// Optional real @mention when announcing a player's turn (opt-in: /config fightping).
function turnPing(gid, f) {
  if (!f || f.isNpc || !getConfig(gid)?.fight_ping) return '';
  return ` <@${f.id}>`;
}
// Mirror a roll to the GM audit channel (set with /config rollaudit).
// Fire-and-forget: an unset, deleted, or unreadable channel must never break
// the roll itself. Covers player rolls AND GM rolls (including secret ones, so
// GMs are accountable to each other). NPC auto-rolls are not mirrored.
// `messageId` links straight to the roll. For slash commands there's no user
// message, so callers pass the interaction and we resolve its reply instead.
function mirrorRoll(gid, { userId, channelId, messageId = null, input, rollLine, context = null, interaction = null }) {
  const chId = getConfig(gid)?.roll_audit_channel_id;
  // Verbose tracing: a silent mirror is impossible to diagnose otherwise.
  // These lines appear in the Railway logs and pinpoint where it stops.
  if (!chId) { console.log('[rollaudit] skip — no audit channel configured'); return; }
  if (chId === channelId) { console.log('[rollaudit] skip — roll was made inside the audit channel'); return; }
  console.log(`[rollaudit] attempting mirror → channel ${chId} (roll from ${channelId})`);
  (async () => {
    const ch = await client.channels.fetch(chId);
    if (!ch) { console.error(`[rollaudit] fetch returned null for ${chId}`); return; }
    // Slash commands: resolve the bot's reply so the audit entry can still link.
    if (!messageId && interaction) {
      try { const rep = await interaction.fetchReply(); messageId = rep?.id ?? null; } catch {}
    }
    const clean = String(input ?? '').replace(/`/g, "'").slice(0, 120);
    const link = messageId ? `\n[↗ Jump to roll](https://discord.com/channels/${gid}/${channelId}/${messageId})` : '';
    const ctx = context ? ` · ${context}` : '';
    await ch.send({
      content: `🎲 <@${userId}> in <#${channelId}>${ctx} — \`${clean}\`\n${rollLine}${link}`,
      allowedMentions: { parse: [] }, // identity without pinging anyone
    });
    console.log('[rollaudit] mirror sent OK');
  })().catch(err => {
    // Never break the roll itself, but do leave a trace — a silent mirror is
    // impossible to diagnose. Surfaced to the GM by /config rollaudit test.
    console.error(`[rollaudit] mirror to ${chId} FAILED:`, err?.message || err, err?.code ? `(code ${err.code})` : '');
  });
}

// Split a fighter id list into those able to fight (HP above the floor) and
// those who aren't. `floor` is 0 for a real fight, PRACTICE_FLOOR for a bout.
async function partitionDowned(guild, gid, fighters, floor = 0) {
  const active = [], downed = [];
  for (const fid of fighters) {
    const f = await resolveFighter(guild, gid, fid);
    const cur = f.isNpc ? (getNpc(gid, f.name)?.hp_current ?? 0) : (getChar(gid, fid)?.hp_current ?? 0);
    (cur > floor ? active : downed).push({ fid, name: f.name, isNpc: f.isNpc, hp: cur });
  }
  return { active, downed };
}

// Warning line listing fighters left out for sitting at or below the floor.
function downedWarning(downed, gid, floor = 0) {
  if (!downed.length) return null;
  // Don't print an NPC's exact (negative) HP when NPC stats are hidden.
  const hide = gid ? !npcStatsVisible(gid) : false;
  const names = downed.map(d => `**${d.name}**${d.isNpc ? ' 🎭' : ''}${(d.isNpc && hide) ? '' : ` (❤️ ${d.hp})`}`).join(', ');
  const why = floor > 0 ? `not fit to spar (at or below the ${floor} HP bout floor)` : 'knocked down';
  return `⚠️ Left out — ${why}: ${names}. Restore NPCs with \`/npc hp\`, players with \`hpfull @user\` or a rest.`;
}

// Build the same roll card a manual /fight atk or /fight def produces,
// for an automatic best-stat roll (stat tracker + exact dice breakdown).
async function autoFightCard(guild, gid, fighter, kind, stat, nat, total, targetName, isReroll = false, atkBonus = 0, flat = false, adv = false) {
  const statVal = fighter.stats[stat] ?? 0;
  const icon = kind === 'atk' ? '⚔️' : '🛡️';
  let rollLine;
  if (flat) {
    // Flat d20 defence — no stat, no modifier.
    rollLine = `${icon}  1d20 (flat — fumbled last attack) → [${nat}] = ${fightTotalStr(total, nat, 20)}`;
  } else {
    const eff = statVal + (kind === 'atk' ? atkBonus : 0);
    const bonusTag = (kind === 'atk' && atkBonus) ? ` +${atkBonus} riposte` : '';
    const advTag = adv ? ' ⭐ (signature advantage)' : '';
    // When NPC stats are hidden, don't print the modifier — it would give the
    // exact stat away. The natural die and final total still show.
    const hideMods = fighter.isNpc && !getConfig(gid)?.npc_stats_visible;
    const modStr = hideMods ? '' : (eff > 0 ? ` +${eff}` : eff < 0 ? ` ${eff}` : '');
    const statName = hideMods ? '' : `+${STAT_LABELS[stat]}`;
    rollLine = `${icon}  1d20${statName}${bonusTag}${advTag} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
  }
  const who = `${fighter.name}${fighter.isNpc ? ' 🎭' : ''}`;
  const label = kind === 'atk'
    ? `⚔️ ${who} attacks ${targetName} with ${STAT_LABELS[stat]}`
    : `🛡️ ${who} defends with ${STAT_LABELS[stat]}`;
  const critType = nat === 20 ? 'crit' : (nat === 1 ? 'fail' : null);
  const charCard = await fighterCharCard(guild, gid, fighter.id);
  return buildRollEmbed({
    rollLine, label, isReroll,
    char: charCard, healCharges: 0, maxCharges: 0,
    flavour: null, total, critType, tags: null, gid,
  });
}

// Give auto-piloted NPCs their reroll moment before an exchange resolves:
// a defender about to be hit, then an attacker who was blocked, may each
// spend one LCK reroll token (seeded per fight) on a fresh roll.
// Returns the up-to-date fight row.
async function applyAutoNpcRerolls(guild, gid, cid, channel) {
  let fight = getFight(gid, cid);
  if (!fight || !fight.auto_npc) return fight;
  const rr = JSON.parse(fight.rr_state || '{}');
  const turnOrder = JSON.parse(fight.turn_order);
  const attackerId = turnOrder[fight.turn_index];
  const defenderId = fight.current_target;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const tryReroll = async (fid, kind) => {
    if (!isNpcFighter(fid) || (rr[fid] ?? 0) <= 0) return;
    const f = await resolveFighter(guild, gid, fid);
    const stat = kind === 'atk' ? fight.atk_stat : fight.def_stat;
    // Preserve whatever modifier the ORIGINAL roll used (flat-d20 → 0, riposte → stat+2),
    // since carry-over effects were already consumed when that first roll was made.
    const origTotal = kind === 'atk' ? fight.atk_roll : fight.def_roll;
    const origNat = kind === 'atk' ? fight.atk_nat : fight.def_nat;
    const effMod = origTotal - origNat;
    const isFlat = kind === 'def' && effMod === 0 && (f.stats[stat] ?? 0) !== 0;
    const sigRow = f.isNpc ? getNpc(gid, f.name) : getChar(gid, fid);
    const roll = autoRoll(effMod, !isFlat && hasSignatureAdvantage(sigRow, stat));
    rr[fid] = (rr[fid] ?? 0) - 1;
    if (kind === 'atk') upsertFight(gid, cid, { atk_roll: roll.total, atk_nat: roll.nat, rr_state: JSON.stringify(rr) });
    else upsertFight(gid, cid, { def_roll: roll.total, def_nat: roll.nat, rr_state: JSON.stringify(rr) });
    bumpFightLog(gid, cid, (log, ensure) => { ensure(fid).rr++; });
    let targetName = null;
    if (kind === 'atk') {
      const tF = await resolveFighter(guild, gid, defenderId);
      targetName = `${tF.name}${tF.isNpc ? ' 🎭' : ''}`;
    }
    await sleep(700);
    await channel.send(`🔁 **${f.name}** 🎭 spends a reroll token! (${rr[fid]} left)`).catch(()=>{});
    const bonus = kind === 'atk' ? Math.max(0, effMod - (f.stats[stat] ?? 0)) : 0;
    const card = await autoFightCard(guild, gid, f, kind, stat, roll.nat, roll.total, targetName, true, bonus, isFlat, !!roll.adv);
    await postAsNpc(channel, gid, f.name, card);
    fight = getFight(gid, cid);
  };

  // Defender reacts first — only when the hit would land AND its natural die was poor (≤ guild threshold)
  const rrMax = getNpcRrThreshold(gid);
  let { hit } = resolveDamage(fight.atk_roll, fight.atk_nat, 20, fight.def_roll, fight.def_nat, 20);
  if (hit && fight.def_nat <= rrMax) await tryReroll(defenderId, 'def');
  // Attacker answers a block — likewise only on a poor natural die
  ({ hit } = resolveDamage(fight.atk_roll, fight.atk_nat, 20, fight.def_roll, fight.def_nat, 20));
  if (!hit && fight.atk_nat <= rrMax) await tryReroll(attackerId, 'atk');
  return getFight(gid, cid);
}

// Resolve a /fight subcommand's target / target_npc pair to a fighter id in
// the given fight, or an error string. Exactly one of the two must be set.
function resolveFightTarget(interaction, gid, fight) {
  const targetUser = interaction.options.getUser('target');
  const targetNpcName = interaction.options.getString('target_npc');
  if (!!targetUser === !!targetNpcName) return { error: '❌ Pick exactly one of `target` or `target_npc`.' };
  let fid;
  if (targetUser) fid = targetUser.id;
  else {
    const npc = getNpc(gid, targetNpcName);
    if (!npc) return { error: `❌ NPC **${targetNpcName}** not found.` };
    fid = npcFighterId(npc.name);
  }
  if (!JSON.parse(fight.turn_order).includes(fid)) return { error: '❌ That fighter is not in this fight.' };
  return { fid };
}

// ── Fight log & recap ────────────────────────────────────────────────────────
// log_state: {
//   exchanges: n,
//   f: { fid: { dealt, taken, crit, fumble, rr, atk: TALLY, def: TALLY } },
//   r: [ { n, a, d, an, at, as, dn, dt, ds, h, dm } ]   // blow-by-blow
// }
// TALLY = { n, totSum, natHi, natLo } — enough for counts, averages and extremes.
const ROLL_TALLY = () => ({ n: 0, totSum: 0, natHi: 0, natLo: 99 });
const FIGHTER_LOG = () => ({ dealt: 0, taken: 0, crit: 0, fumble: 0, rr: 0, atk: ROLL_TALLY(), def: ROLL_TALLY() });
// Stored exchanges are capped so log_state can't grow without bound on a very
// long auto fight; the summary tallies still cover every exchange.
const ROLL_LOG_MAX = 150;
const ROLL_LOG_SHOW = 40;

function bumpFightLog(gid, cid, mutate) {
  const fight = getFight(gid, cid);
  if (!fight) return;
  const log = JSON.parse(fight.log_state || '{}');
  log.f = log.f || {};
  mutate(log, (fid) => (log.f[fid] = log.f[fid] || FIGHTER_LOG()));
  upsertFight(gid, cid, { log_state: JSON.stringify(log) });
}

// Record one resolved exchange into a log object (shared by DB fights and
// full-auto's in-memory log). `meta` carries the roll detail the recap needs:
// { atkTotal, defTotal, atkStat, defStat }.
function recordExchange(log, ensure, attackerId, defenderId, atkNat, defNat, hit, dmg, meta = {}) {
  log.exchanges = (log.exchanges || 0) + 1;
  const a = ensure(attackerId), d = ensure(defenderId);
  if (atkNat === 20) a.crit++;
  if (atkNat === 1) a.fumble++;
  if (defNat === 20) d.crit++;
  if (defNat === 1) d.fumble++;
  if (hit) { a.dealt += dmg; d.taken += dmg; }

  // Roll tallies, attack and defence kept apart. Seeded defensively so a fight
  // already in progress when this shipped doesn't blow up mid-exchange.
  const tally = (t, nat, total) => {
    t.n++;
    t.totSum += (typeof total === 'number' ? total : (nat || 0));
    if (typeof nat === 'number') {
      if (nat > (t.natHi ?? 0)) t.natHi = nat;
      if (nat < (t.natLo ?? 99)) t.natLo = nat;
    }
  };
  a.atk = a.atk || ROLL_TALLY();
  d.def = d.def || ROLL_TALLY();
  tally(a.atk, atkNat, meta.atkTotal);
  tally(d.def, defNat, meta.defTotal);

  // Blow-by-blow entry.
  log.r = Array.isArray(log.r) ? log.r : [];
  if (log.r.length < ROLL_LOG_MAX) {
    log.r.push({
      n: log.exchanges, a: attackerId, d: defenderId,
      an: atkNat, at: meta.atkTotal ?? null, as: meta.atkStat ?? null,
      dn: defNat, dt: meta.defTotal ?? null, ds: meta.defStat ?? null,
      h: hit ? 1 : 0, dm: hit ? dmg : 0,
    });
  } else {
    log.rTrim = (log.rTrim || 0) + 1;
  }
}

// Render the recap lines for a finished fight: how the dice fell for each
// fighter, the damage ledger, and the full blow-by-blow of every exchange.
// Pass { rolls: false } to omit the blow-by-blow.
async function buildFightRecap(guild, gid, log, opts = {}) {
  const entries = Object.entries(log?.f ?? {});
  if (!entries.length) return [];
  const ex = log.exchanges ?? 0;
  const lines = ['', `📜 **Fight Recap** — ${ex} exchange${ex === 1 ? '' : 's'}`];

  // Resolve every name once — used by all three sections.
  const rolls = Array.isArray(log.r) ? log.r : [];
  const ids = [...new Set([...entries.map(e => e[0]), ...rolls.flatMap(r => [r.a, r.d])])];
  const nameOf = {}, isNpcOf = {};
  for (const fid of ids) {
    const f = await resolveFighter(guild, gid, fid);
    nameOf[fid] = `${f.name}${f.isNpc ? ' 🎭' : ''}`;
    isNpcOf[fid] = f.isNpc;
  }
  const hideNpc = !npcStatsVisible(gid);
  // NPC stat names stay hidden here exactly as they are on the roll cards.
  const statTag = (fid, st) => (!st || (isNpcOf[fid] && hideNpc)) ? '' : ` ${STAT_LABELS[st] ?? ''}`;

  entries.sort((x, y) => (y[1].dealt ?? 0) - (x[1].dealt ?? 0));

  // ── Rolls: how the dice treated each fighter ──
  const tallyBits = (t) => {
    if (!t || !t.n) return null;
    const out = [`avg **${(t.totSum / t.n).toFixed(1)}**`];
    if (t.natHi) out.push(`best nat ${t.natHi}`);
    // Only worth printing when it differs — a single roll isn't a range.
    if (t.natLo != null && t.natLo < 99 && t.natLo !== t.natHi) out.push(`worst nat ${t.natLo}`);
    return out.join(' · ');
  };
  const rollLines = [];
  for (const [fid, st] of entries) {
    const bits = [];
    const a = tallyBits(st.atk), d = tallyBits(st.def);
    if (a) bits.push(`⚔️ ${st.atk.n} atk · ${a}`);
    if (d) bits.push(`🛡️ ${st.def.n} def · ${d}`);
    if (bits.length) rollLines.push(`**${nameOf[fid] ?? fid}** — ${bits.join('   ')}`);
  }
  if (rollLines.length) lines.push('', '**🎲 Rolls**', ...rollLines);

  // ── Damage ledger ──
  lines.push('', '**💥 Damage**');
  for (const [fid, st] of entries) {
    const bits = [`dealt **${st.dealt ?? 0}**`, `taken **${st.taken ?? 0}**`];
    if (st.crit) bits.push(`💥 ${st.crit} nat-20${st.crit > 1 ? 's' : ''}`);
    if (st.fumble) bits.push(`🔻 ${st.fumble} nat-1${st.fumble > 1 ? 's' : ''}`);
    if (st.rr) bits.push(`🔁 ${st.rr} reroll${st.rr > 1 ? 's' : ''}`);
    lines.push(`**${nameOf[fid] ?? fid}** — ${bits.join(' · ')}`);
  }

  // ── Blow by blow: every roll both sides made, in order ──
  if (opts.rolls !== false && rolls.length) {
    const shown = rolls.slice(-ROLL_LOG_SHOW);
    const trimmed = (rolls.length - shown.length) + (log.rTrim ?? 0);
    lines.push('', '**⚔️ Blow by blow**');
    if (trimmed > 0) lines.push(`*(earliest ${trimmed} exchange${trimmed === 1 ? '' : 's'} trimmed)*`);
    const nat = (v) => v === 20 ? `[**20**]💥` : v === 1 ? `[**1**]🔻` : `[${v}]`;
    for (const r of shown) {
      const res = r.h ? `💥 **${r.dm}**` : `🛡️ blocked`;
      lines.push(`\`${String(r.n).padStart(2, ' ')}\` ${nameOf[r.a] ?? '?'} ⚔️${statTag(r.a, r.as)} ${nat(r.an)}→**${r.at ?? '?'}**  ·  ${nameOf[r.d] ?? '?'} 🛡️${statTag(r.d, r.ds)} ${nat(r.dn)}→**${r.dt ?? '?'}**  ·  ${res}`);
    }
  }
  return lines;
}

// ── End-of-fight announcement ────────────────────────────────────────────────
// Every way a fight can finish — knockout, forfeit, kick, GM end, full auto —
// funnels through here, so the result is always posted publicly in the channel
// where everyone can read it, never buried in an ephemeral reply only the GM
// sees. Carries the victor, everyone's final standing, and the full recap.
async function announceFightEnd(guild, gid, cid, channel, opts = {}) {
  const { headline = null, log = {}, roster = [], hpState = {}, floor = 0 } = opts;
  const W = fightWords(floor);
  const lines = ['═════════════════════════════', floor > 0 ? '🏁 **Bout Over**' : '🏁 **Fight Over**'];
  if (headline) lines.push('', headline);

  // Everyone who took part: the roster passed in, plus anyone recorded in the
  // log or HP state — fighters knocked out earlier already left the turn order.
  const ids = [];
  for (const fid of [...(roster || []), ...Object.keys(log?.f ?? {}), ...Object.keys(hpState || {})]) {
    if (fid && !ids.includes(fid)) ids.push(fid);
  }
  if (ids.length) {
    lines.push('', '**Final standing**');
    for (const fid of ids) {
      const f = await resolveFighter(guild, gid, fid);
      const known = hpState && Object.prototype.hasOwnProperty.call(hpState, fid);
      const live = known ? hpState[fid]
        : (f.isNpc ? (getNpc(gid, f.name)?.hp_current ?? 0) : (getChar(gid, fid)?.hp_current ?? 0));
      const text = (f.isNpc && !npcStatsVisible(gid))
        ? hpCondition(live, f.maxHp, floor)
        : `❤️ ${live} / ${f.maxHp || '?'}${live <= floor ? ` ${W.icon}` : ''}`;
      lines.push(`**${f.name}${f.isNpc ? ' 🎭' : ''}** — ${text}`);
    }
  }

  lines.push(...await buildFightRecap(guild, gid, log));
  await sendLong(channel, lines);
}

// Expand category tokens in an NPC list, keeping unknown tokens as-is so the
// caller's normal "NPC not found" handling reports them.
function expandNpcList(gid, str) {
  const { names, missingCats } = expandNpcTokens(gid, str);
  // Unknown categories fall through as literal names → caller's not-found error fires
  return [...names, ...missingCats.map(c => 'category:' + c)];
}

// Expand "category:Bandits" tokens in a comma-separated NPC list into the
// category's members (case-insensitive category match). Returns { names, missingCats }.
function expandNpcTokens(gid, str) {
  const names = [], missingCats = [];
  for (const tok of parseNpcNames(str)) {
    const m = /^category:(.+)$/i.exec(tok);
    if (m) {
      const wanted = m[1].trim().toLowerCase();
      const cat = getCategories(gid).find(c => c.toLowerCase() === wanted);
      const members = cat ? getNpcsInCategory(gid, cat) : [];
      if (!members.length) missingCats.push(m[1].trim());
      for (const n of members) if (!names.includes(n)) names.push(n);
    } else if (!names.includes(tok)) names.push(tok);
  }
  return { names, missingCats };
}

// Build a character-shaped object for buildRollEmbed from any fighter id.
// Players use their real character row; NPCs are adapted from the NPC record.
async function fighterCharCard(guild, gid, fid) {
  if (isNpcFighter(fid)) {
    const name = npcNameFromFighter(fid);
    const npc = getNpc(gid, name) || {};
    return {
      displayName: name + ' 🎭',
      order_name: npc.order_name || null,
      class: null,
      hp_current: npc.hp_current ?? 0,
      rerolls_current: 0,
      str: npc.str ?? 0, con: npc.con ?? 0, dex: npc.dex ?? 0, wis: npc.wis ?? 0, lck: npc.lck ?? 0,
      weapon1: null, weapon2: null, weapon1emoji: null, weapon2emoji: null,
      _isNpc: true,
    };
  }
  const member = await guild.members.fetch(fid).catch(()=>null);
  const displayName = member?.nickname || member?.user.username || fid;
  const char = getChar(gid, fid);
  return char ? { ...char, displayName } : { displayName, order_name:null, class:null, hp_current:0, rerolls_current:0, str:0,con:0,dex:0,wis:0,lck:0, weapon1:null,weapon2:null };
}

// Post a message into a channel AS an NPC (via its webhook, with name + avatar),
// matching how /pr posts. Falls back to a plain channel.send if the webhook fails.
async function postAsNpc(channel, gid, npcName, content) {
  const npc = getNpc(gid, npcName);
  try {
    const webhookClient = await npcWebhookIn(channel, gid, npcName, npc?.image_url);
    await webhookClient.send({ content, username: npcName, avatarURL: npc?.image_url ?? BLANK_AVATAR });
    return true;
  } catch (err) {
    // A stored webhook can be deleted server-side; drop it and retry once.
    console.error('postAsNpc webhook error:', err.message);
    try {
      db.prepare('DELETE FROM npc_webhooks WHERE guild_id=? AND channel_id=? AND npc_name=?').run(gid, channel.id, npcName);
      const fresh = await npcWebhookIn(channel, gid, npcName, npc?.image_url);
      await fresh.send({ content, username: npcName, avatarURL: npc?.image_url ?? BLANK_AVATAR });
      return true;
    } catch (err2) {
      console.error('postAsNpc retry failed:', err2.message);
      await channel.send(content).catch(()=>{});
      return false;
    }
  }
}

// In an auto_npc fight, perform the current NPC's attack automatically against a
// random living opponent, then leave the (human) target to defend manually.
// If the next current fighter is also an NPC after resolution, the resolve handler
// will call this again. Returns true if it acted.
async function runAutoNpcTurn(guild, gid, cid, channel) {
  const fight = getFight(gid, cid);
  if (!fight || fight.state !== 'active' || !fight.auto_npc) return false;
  if (fight.phase !== 'attack') return false;
  const order = JSON.parse(fight.turn_order);
  const hpState = JSON.parse(fight.hp_state);
  const attackerId = order[fight.turn_index];
  if (!isNpcFighter(attackerId)) return false; // current fighter is a player — wait for them

  const attacker = await resolveFighter(guild, gid, attackerId);
  // pick a random opponent still standing (above the bout floor / 0)
  const npcFloor = fightFloor(fight);
  const opponents = order.filter(fid => fid !== attackerId && (hpState[fid] ?? 0) > npcFloor);
  if (!opponents.length) return false;
  const targetId = opponents[Math.floor(Math.random() * opponents.length)];
  const targetF = await resolveFighter(guild, gid, targetId);

  const stat = autoFightStat(attacker.stats);
  const atkBonus = consumeAtkBonus(gid, cid, attackerId);
  const attRow = attacker.isNpc ? getNpc(gid, attacker.name) : getChar(gid, attackerId);
  const a = autoRoll((attacker.stats[stat] ?? 0) + atkBonus, hasSignatureAdvantage(attRow, stat));

  upsertFight(gid, cid, {
    phase: 'defend', current_target: targetId,
    atk_roll: a.total, atk_nat: a.nat, atk_stat: stat, atk_mode: 'normal', atk_sides: 20,
    def_roll: null, def_nat: null, def_stat: null, def_mode: 'normal',
  });

  // The NPC's own roll card posts AS the NPC (webhook), matching manual rolls.
  const atkCard = await autoFightCard(guild, gid, attacker, 'atk', stat, a.nat, a.total, `${targetF.name}${targetF.isNpc ? ' 🎭' : ''}`, false, atkBonus, false, !!a.adv);
  await postAsNpc(channel, gid, attacker.name, atkCard);
  if (atkBonus) await channel.send(`✨ **${attacker.name}** presses the riposte (+${atkBonus}).`).catch(()=>{});

  // NPC targets are defended automatically by the chain — only prompt players.
  if (!targetF.isNpc) {
    await channel.send(`🛡️ **${targetF.name}** — use \`/fight def\` to defend, then \`/fight resolve\`.`).catch(()=>{});
  }
  return true;
}

// In an auto_npc fight, roll the targeted NPC's defence automatically
// (best of STR/DEX) and post it under the NPC's name. Returns true if it acted.
async function autoNpcDefend(guild, gid, cid, channel) {
  const fight = getFight(gid, cid);
  if (!fight || fight.state !== 'active' || !fight.auto_npc) return false;
  if (fight.phase !== 'defend' || !isNpcFighter(fight.current_target)) return false;

  const defender = await resolveFighter(guild, gid, fight.current_target);
  const stat = autoFightStat(defender.stats);
  const flat = consumeFlatDef(gid, cid, fight.current_target);
  const defRow = defender.isNpc ? getNpc(gid, defender.name) : getChar(gid, fight.current_target);
  const d = autoRoll(flat ? 0 : (defender.stats[stat] ?? 0), !flat && hasSignatureAdvantage(defRow, stat));

  upsertFight(gid, cid, { def_roll: d.total, def_nat: d.nat, def_stat: stat, def_mode: 'normal', def_sides: 20 });

  const defCard = await autoFightCard(guild, gid, defender, 'def', stat, d.nat, d.total, null, false, 0, flat, !!d.adv);
  await postAsNpc(channel, gid, defender.name, defCard);
  if (flat) await channel.send(`🎲 **${defender.name}** defends on a flat d20 (fumbled last attack).`).catch(()=>{});
  return true;
}

// Auto-mode twin of the `/fight resolve` handler (channel-send based).
// Computes damage from the stored rolls, persists HP, handles knockdown /
// win / turn advance, and posts the summary. Returns true if the fight continues.
// Keep the rules here in lockstep with the `resolve` subcommand in handleFight.
// ── Exchange resolution ───────────────────────────────────────────────────────
// One implementation of the combat rules, shared by /fight resolve and the NPC
// auto-pilot. These used to be two ~90-line copies that had to be edited in
// lockstep for every rules change; anything that touched damage, crit carry-over,
// the bout floor or the recap had to be applied twice and could silently drift.
//
// This computes the whole exchange and hands back what to say and what happened.
// The caller owns delivery (an interaction reply vs a channel post) and whether
// to keep the auto chain running.
//
// Returns { lines, ended, announce } where `announce` is the payload for
// announceFightEnd when the fight finished, and `nextF` is the fighter whose
// turn it now is (null when the fight ended).
async function resolveExchange(guild, gid, cid, fight) {
  const turnOrder = JSON.parse(fight.turn_order);
  const attackerId = turnOrder[fight.turn_index];
  const defenderId = fight.current_target;
  const hpState = JSON.parse(fight.hp_state);
  const floor = fightFloor(fight);
  const W = fightWords(floor);
  const autoOn = !!fight.auto_npc;

  const { hit, dmg } = resolveDamage(
    fight.atk_roll, fight.atk_nat, 20,
    fight.def_roll, fight.def_nat, 20
  );

  // Carry-over effects from this exchange (nat-1 attack, nat-20 defence), and
  // the running fight log. Neither depends on the other's writes.
  const effNotes = applyExchangeEffects(gid, cid, attackerId, defenderId, fight.atk_nat, fight.def_nat);
  bumpFightLog(gid, cid, (log, ensure) =>
    recordExchange(log, ensure, attackerId, defenderId, fight.atk_nat, fight.def_nat, hit, dmg,
      { atkTotal: fight.atk_roll, defTotal: fight.def_roll, atkStat: fight.atk_stat, defStat: fight.def_stat }));

  const atkF = await resolveFighter(guild, gid, attackerId);
  const defF = await resolveFighter(guild, gid, defenderId);
  const atkName = atkF.name + (atkF.isNpc ? ' 🎭' : '');
  const defName = defF.name + (defF.isNpc ? ' 🎭' : '');

  const lines = ['─────────────────────────────', '⚔️  **Exchange Resolved**', ''];
  lines.push(`${atkName} (**${STAT_LABELS[fight.atk_stat]}**): ${fightTotalStr(fight.atk_roll, fight.atk_nat, 20)}`);
  lines.push(`${defName} (**${STAT_LABELS[fight.def_stat]}**): ${fightTotalStr(fight.def_roll, fight.def_nat, 20)}`);
  lines.push('');

  // Whose turn it becomes, and the reminder a GM needs when they're driving an
  // NPC by hand. Shared by the "fighter went down" and "fight continues" paths.
  const handOver = async (order, index) => {
    const nextF = await resolveFighter(guild, gid, order[index]);
    const hint = (nextF.isNpc && !autoOn) ? ` (GM acts with \`npc:${nextF.name}\`)` : '';
    lines.push(`\n🎯 **${nextF.name}${nextF.isNpc ? ' 🎭' : ''}**'s turn to attack!${hint}${turnPing(gid, nextF)}`);
    return nextF;
  };
  const clearRolls = {
    phase: 'attack', current_target: null,
    atk_roll: null, atk_nat: null, atk_stat: null,
    def_roll: null, def_nat: null, def_stat: null,
  };

  if (hit) {
    const prevHp = hpState[defenderId] ?? 0;
    const newHp = applyFightDamage(prevHp, dmg, floor);
    hpState[defenderId] = newHp;
    setFighterHp(gid, defenderId, newHp);           // persist to character or NPC
    lines.push(`💥 **${atkName}** hits **${defName}** for **${dmg}** damage!`);
    lines.push(hpChangeLine(gid, defF.isNpc, defName, prevHp, newHp, defF.maxHp, floor));
    for (const l of effectNoteLines(effNotes, atkName, defName)) lines.push(l);

    if (newHp <= floor) {
      lines.push('', `${W.icon} **${defName}** ${W.out}! HP: **${newHp}**`);
      const newOrder = turnOrder.filter(id => id !== defenderId);

      if (newOrder.length <= 1) {
        const winF = await resolveFighter(guild, gid, newOrder[0]);
        const endLog = JSON.parse(getFight(gid, cid)?.log_state || '{}');
        archiveFight(gid, cid, endLog, turnOrder, floor);
        upsertFight(gid, cid, { state: 'idle', turn_order: '[]', hp_state: JSON.stringify(hpState) });
        return { lines, ended: true, nextF: null, announce: {
          headline: `🏆 **${winF.name}${winF.isNpc ? ' 🎭' : ''}** ${W.win}!`,
          log: endLog, roster: turnOrder, hpState, floor,
        } };
      }

      const newIndex = fight.turn_index % newOrder.length;
      const nextF = await handOver(newOrder, newIndex);
      upsertFight(gid, cid, { ...clearRolls,
        turn_order: JSON.stringify(newOrder), turn_index: newIndex,
        hp_state: JSON.stringify(hpState),
      });
      return { lines, ended: false, nextF, announce: null };
    }
  } else {
    lines.push(`🛡️ **${defName}** blocks the attack! No damage.`);
    for (const l of effectNoteLines(effNotes, atkName, defName)) lines.push(l);
  }

  // Advance to the next fighter still standing (above the bout floor / 0).
  let nextIndex = (fight.turn_index + 1) % turnOrder.length;
  let safety = 0;
  while (hpState[turnOrder[nextIndex]] !== undefined && hpState[turnOrder[nextIndex]] <= floor && safety < turnOrder.length) {
    nextIndex = (nextIndex + 1) % turnOrder.length;
    safety++;
  }
  const nextF = await handOver(turnOrder, nextIndex);
  upsertFight(gid, cid, { ...clearRolls, turn_index: nextIndex, hp_state: JSON.stringify(hpState) });
  return { lines, ended: false, nextF, announce: null };
}

// Auto-pilot wrapper: posts to the channel. Returns whether the fight goes on.
async function autoResolveExchange(guild, gid, cid, channel) {
  let fight = getFight(gid, cid);
  if (!fight || fight.state !== 'active' || fight.phase !== 'defend' || fight.def_roll === null) return false;

  fight = await applyAutoNpcRerolls(guild, gid, cid, channel);
  if (!fight || fight.state !== 'active') return false;

  const r = await resolveExchange(guild, gid, cid, fight);
  await sendLong(channel, r.lines);
  if (r.ended) await announceFightEnd(guild, gid, cid, channel, r.announce);
  return !r.ended;
}

// Drive automatic NPC actions in an NPCs-only fight: take NPC attacks,
// auto-defend when an NPC is the target, and resolve — looping until a
// player needs to act or the fight ends.
async function runAutoNpcChain(guild, gid, cid, channel) {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  let safety = 0;
  while (safety++ < 300) {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active' || !fight.auto_npc) return;
    if (fight.phase === 'attack') {
      const acted = await runAutoNpcTurn(guild, gid, cid, channel);
      if (!acted) return; // a player's turn — wait for them
      await sleep(1100);
    } else if (fight.phase === 'defend') {
      if (!isNpcFighter(fight.current_target)) return; // a player defends manually
      const defended = await autoNpcDefend(guild, gid, cid, channel);
      if (!defended) return;
      await sleep(900);
      const cont = await autoResolveExchange(guild, gid, cid, channel);
      if (!cont) return;
      await sleep(1100);
    } else return;
  }
  // Safety cap reached — tell the GM instead of stalling silently
  await channel.send('⚠️ Auto chain paused after a very long fight (safety limit). Use `/fight status` to review, `/fight resolve` to continue a pending exchange, or `/fight end`.').catch(()=>{});
}

async function handleFight(interaction) {
  const sub = interaction.options.getSubcommand();
  const gid = interaction.guild.id;
  const cid = interactionChannelId(interaction);
  const uid = interaction.user.id;
  // Unapproved sheets can't take fight actions. Read-only and GM subcommands pass.
  if (['atk','def','rr','forfeit','start'].includes(sub)) {
    const gateMsg = sheetGate(gid, uid);
    if (gateMsg && !(await isGm(interaction.guild, uid))) return interaction.reply({ content: gateMsg, ephemeral: true });
  }
  // interaction.channel can be null (thread / uncached); fetch it lazily so the
  // fight flow can still post its cards and prompts.
  const chan = await interactionChannel(interaction);
  if (!chan) return interaction.reply({ content: '❌ I can\'t access this channel. Check my View Channel and Send Messages permissions here.', ephemeral: true });

  // ── START ──────────────────────────────────────────────────────────────────
  if (sub === 'start') {
    const existing = getFight(gid, cid);
    if (existing && existing.state !== 'idle') {
      return interaction.reply({ content: '❌ A fight is already in progress in this channel. Use `/fight end` to stop it first.', ephemeral: true });
    }

    const fighters = [];
    // Players from the @mention list
    for (const id of parsePlayerMentions(interaction.options.getString('players'))) {
      fighters.push(id);
    }
    // GM NPCs from the comma list (only a GM may add NPCs)
    const npcNames = expandNpcList(gid, interaction.options.getString('npcs'));
    if (npcNames.length && !(await isGm(interaction.guild, uid))) {
      return interaction.reply({ content: '❌ Only GMs can add NPCs to a fight.', ephemeral: true });
    }
    for (const n of npcNames) {
      const npc = getNpc(gid, n);
      if (!npc) return interaction.reply({ content: `❌ NPC **${n}** not found. Separate multiple NPCs with **commas** (e.g. \`npcs:Goblin, Orc, Rat\`), and check the spelling. Create new ones with \`/npc create\`.`, ephemeral: true });
      const fid = npcFighterId(npc.name); // use the canonical stored name, not the typed casing
      if (!fighters.includes(fid)) fighters.push(fid);
    }
    // Guard against duplicate fighters
    if (new Set(fighters).size !== fighters.length) {
      return interaction.reply({ content: '❌ A fighter was listed more than once.', ephemeral: true });
    }

    if (fighters.length < 2) return interaction.reply({ content: '❌ Need at least 2 fighters. Add players via `players:` (@mention them) and/or NPCs via `npcs:` (comma-separated names).', ephemeral: true });

    // A practice bout stops at the floor instead of 0 — nobody gets hurt.
    const floor = (interaction.options.getBoolean('practice') ?? false) ? PRACTICE_FLOOR : 0;
    const W = fightWords(floor);
    const banner = practiceBanner(floor);

    // Leave out anyone who can't take the field (below the floor / already down)
    const { active: startActive, downed: startDowned } = await partitionDowned(interaction.guild, gid, fighters, floor);
    const startWarn = downedWarning(startDowned, gid, floor);
    if (startActive.length < 2) {
      return interaction.reply({ content: `❌ Need at least 2 fighters with HP above ${floor}.${startWarn ? `\n${startWarn}` : ''}`, ephemeral: true });
    }
    fighters.length = 0; fighters.push(...startActive.map(a => a.fid));
    if (startWarn) await chan.send(startWarn).catch(()=>{});

    const manual = interaction.options.getBoolean('manual') ?? false;

    if (manual) {
      // Skip initiative — keep the order the fighters were listed in
      const hpState = {};
      const rrState = {};
      const ordered = [];
      for (const fid of fighters) {
        const f = await resolveFighter(interaction.guild, gid, fid);
        hpState[fid] = f.isNpc ? (getNpc(gid, f.name)?.hp_current ?? 0) : (getChar(gid, fid)?.hp_current ?? 0);
        if (f.isNpc) rrState[fid] = Math.max(0, f.stats.lck ?? 0);
        ordered.push({ id: fid, name: f.name, isNpc: f.isNpc });
      }
      const turnOrder = ordered.map(o => o.id);
      const lines = [`⚔️ **${W.started} Turn order (manual):**`, ''];
      if (banner) { lines.splice(1, 0, banner); }
      ordered.forEach((f,i) => lines.push(`${i+1}. **${f.name}**${f.isNpc ? ' 🎭' : ''}`));
      lines.push('', `🎯 **${ordered[0].name}** goes first!${ordered[0].isNpc ? ' (GM acts with `npc:`)' : ' Use `/fight atk` to attack.'}${turnPing(gid, ordered[0])}`);
      upsertFight(gid, cid, {
        state: 'active', turn_order: JSON.stringify(turnOrder), turn_index: 0,
        phase: 'attack', current_target: null,
        atk_roll: null, atk_nat: null, atk_stat: null,
        def_roll: null, def_nat: null, def_stat: null,
        hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState),
        floor_hp: floor,
      });
      return interaction.reply({ content: lines.join('\n') });
    }

    // Roll initiative for each fighter (players and NPCs alike)
    const initiatives = [];
    const hpState = {};
    const rrState = {};
    for (const fid of fighters) {
      const f = await resolveFighter(interaction.guild, gid, fid);
      const dex = f.stats.dex ?? 0;
      const roll = rollDie(20);
      const total = roll + dex;
      hpState[fid] = f.isNpc ? (getNpc(gid, f.name)?.hp_current ?? 0) : (getChar(gid, fid)?.hp_current ?? 0);
      if (f.isNpc) rrState[fid] = Math.max(0, f.stats.lck ?? 0);
      initiatives.push({ id: fid, name: f.name, roll, dex, total, isNpc: f.isNpc });
    }

    // Sort by total descending, ties broken by raw roll
    initiatives.sort((a,b) => b.total - a.total || b.roll - a.roll);

    const turnOrder = initiatives.map(i => i.id);
    const npcCount = initiatives.filter(i => i.isNpc).length;
    const playerCount = initiatives.length - npcCount;
    const lines = [`⚔️ **${W.started}** ${playerCount} player${playerCount===1?'':'s'} + ${npcCount} NPC${npcCount===1?'':'s'} — initiative order:`, ''];
    if (banner) lines.splice(1, 0, banner);
    initiatives.forEach((f,i) => {
      lines.push(`${i+1}. **${f.name}**${f.isNpc ? ' 🎭' : ''} — 🎲 [${f.roll}] + ⚡ ${f.dex} DEX = **${f.total} initiative**`);
    });
    lines.push('');
    const first = initiatives[0];
    lines.push(`🎯 **${first.name}** goes first!${first.isNpc ? ' (GM acts with `npc:`)' : ' Use `/fight atk` to attack.'}${turnPing(gid, first)}`);

    upsertFight(gid, cid, {
      state: 'active',
      turn_order: JSON.stringify(turnOrder),
      turn_index: 0,
      phase: 'attack',
      current_target: null,
      atk_roll: null, atk_nat: null, atk_stat: null,
      def_roll: null, def_nat: null, def_stat: null,
      hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState),
      floor_hp: floor,
    });

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── ADDNPC (add one or more GM NPCs to an active fight) ───────────────────
  if (sub === 'addnpc') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can add NPCs to a fight.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });

    const names = expandNpcList(gid, interaction.options.getString('npc'));
    if (!names.length) return interaction.reply({ content: '❌ Name at least one NPC.', ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const hpState = JSON.parse(fight.hp_state);
    const rrState = JSON.parse(fight.rr_state || '{}');
    const added = [];
    for (const npcName of names) {
      const npc = getNpc(gid, npcName);
      if (!npc) return interaction.reply({ content: `❌ NPC **${npcName}** not found.`, ephemeral: true });
      const addFloor = fightFloor(fight);
      if ((npc.hp_current ?? 0) <= addFloor) return interaction.reply({ content: `❌ **${npc.name}** ${addFloor > 0 ? `isn't fit to spar (❤️ ${npc.hp_current}, bout floor is ${addFloor})` : `is knocked down (❤️ ${npc.hp_current})`}. Restore with \`/npc hp name:${npc.name}\` first.`, ephemeral: true });
      const fid = npcFighterId(npc.name); // canonical stored name
      if (turnOrder.includes(fid)) return interaction.reply({ content: `❌ **${npc.name}** is already in this fight.`, ephemeral: true });
      const roll = rollDie(20);
      const total = roll + (npc.dex ?? 0);
      hpState[fid] = npc.hp_current;
      rrState[fid] = Math.max(0, npc.lck ?? 0);
      turnOrder.push(fid);
      added.push(`🎭 **${npc.name}** — 🎲 [${roll}] + ⚡ ${npc.dex} DEX = **${total} initiative**`);
    }
    upsertFight(gid, cid, { turn_order: JSON.stringify(turnOrder), hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState) });
    return interaction.reply({ content: [`**Joined the fight** (added to the end of the turn order — use \`/fight order\` to reposition):`, '', ...added].join('\n') });
  }

  // ── HP (GM sets a fighter's HP mid-fight; sheet + fight stay in sync) ─────
  if (sub === 'hp') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can adjust fight HP.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    const t = resolveFightTarget(interaction, gid, fight);
    if (t.error) return interaction.reply({ content: t.error, ephemeral: true });
    const fid = t.fid;
    const f = await resolveFighter(interaction.guild, gid, fid);
    const value = interaction.options.getInteger('value');
    const newHp = Math.min(value, f.maxHp || value);
    const prev = JSON.parse(fight.hp_state)[fid] ?? '?';
    setFighterHp(gid, fid, newHp); // sheet write → syncFightHp mirrors into hp_state
    const note = value > (f.maxHp || value) ? ' (capped at max)' : '';
    const hpFloor = fightFloor(fight);
    const down = newHp <= hpFloor
      ? (hpFloor > 0 ? ` 🏳️ **${f.name}** is at or below the ${hpFloor} HP bout floor and will be skipped.`
                     : ` 💀 **${f.name}** is at 0 or less and will be skipped.`)
      : '';
    return interaction.reply({ content: `❤️ **${f.name}${f.isNpc ? ' 🎭' : ''}** HP: **${prev} → ${newHp}**${note}.${down}` });
  }

  // ── KICK (remove a fighter without ending the fight) ──────────────────────
  if (sub === 'kick') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can kick fighters.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    const t = resolveFightTarget(interaction, gid, fight);
    if (t.error) return interaction.reply({ content: t.error, ephemeral: true });
    const fid = t.fid;
    const turnOrder = JSON.parse(fight.turn_order);
    const removedPos = turnOrder.indexOf(fid);

    const f = await resolveFighter(interaction.guild, gid, fid);
    const hpState = JSON.parse(fight.hp_state);
    const rrState = JSON.parse(fight.rr_state || '{}');
    const newOrder = turnOrder.filter(id => id !== fid);
    delete hpState[fid]; delete rrState[fid];
    clearEffects(gid, cid, fid);
    const lines = [`👢 **${f.name}${f.isNpc ? ' 🎭' : ''}** has been removed from the fight.`];

    if (newOrder.length <= 1) {
      const kickFloor = fightFloor(fight);
      const kickW = fightWords(kickFloor);
      let headline = `👢 **${f.name}${f.isNpc ? ' 🎭' : ''}** was removed by the GM.`;
      if (newOrder.length === 1) {
        const winF = await resolveFighter(interaction.guild, gid, newOrder[0]);
        headline = `🏆 **${winF.name}${winF.isNpc ? ' 🎭' : ''}** ${kickW.win} — last one standing after the GM removed **${f.name}**.`;
      }
      const kickLog = JSON.parse(fight.log_state || '{}');
      archiveFight(gid, cid, kickLog, turnOrder, kickFloor);
      upsertFight(gid, cid, { state: 'idle', turn_order: '[]', hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState) });
      await interaction.reply({ content: lines.join('\n') });
      await announceFightEnd(interaction.guild, gid, cid, chan, {
        headline, log: kickLog, roster: turnOrder, hpState: JSON.parse(fight.hp_state), floor: kickFloor,
      });
      return;
    }

    let newIndex = (removedPos < fight.turn_index ? fight.turn_index - 1 : fight.turn_index) % newOrder.length;
    const patch = { turn_order: JSON.stringify(newOrder), turn_index: newIndex,
                    hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState) };
    // If the pending exchange involved them, reset it
    const attackerId = turnOrder[fight.turn_index];
    if (fight.phase === 'defend' && (fid === attackerId || fid === fight.current_target)) {
      Object.assign(patch, { phase: 'attack', current_target: null,
        atk_roll: null, atk_nat: null, atk_stat: null, def_roll: null, def_nat: null, def_stat: null });
      lines.push('↩️ The pending exchange was reset.');
    }
    upsertFight(gid, cid, patch);
    const nextF = await resolveFighter(interaction.guild, gid, newOrder[newIndex]);
    lines.push(`🎯 **${nextF.name}${nextF.isNpc ? ' 🎭' : ''}**'s turn to attack.${turnPing(gid, nextF)}`);
    return interaction.reply({ content: lines.join('\n') });
  }

  // ── REFILL (restore NPC reroll tokens mid-fight) ──────────────────────────
  if (sub === 'refill') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can refill NPC rerolls.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    const turnOrder = JSON.parse(fight.turn_order);
    const rrState = JSON.parse(fight.rr_state || '{}');
    const raw = (interaction.options.getString('npcs') || '').trim();
    let targets;
    if (raw.toLowerCase() === 'all') {
      targets = turnOrder.filter(isNpcFighter).map(fid => getNpc(gid, npcNameFromFighter(fid))).filter(Boolean);
      if (!targets.length) return interaction.reply({ content: '❌ No NPCs in this fight.', ephemeral: true });
    } else {
      targets = [];
      for (const n of expandNpcList(gid, raw)) {
        const npc = getNpc(gid, n);
        if (!npc) return interaction.reply({ content: `❌ NPC **${n}** not found.`, ephemeral: true });
        if (!turnOrder.includes(npcFighterId(npc.name))) return interaction.reply({ content: `❌ **${npc.name}** isn't in this fight.`, ephemeral: true });
        if (!targets.some(t => t.name === npc.name)) targets.push(npc);
      }
      if (!targets.length) return interaction.reply({ content: '❌ Name at least one NPC, or use `npcs:all`.', ephemeral: true });
    }
    const lines = targets.map(npc => {
      const fid = npcFighterId(npc.name);
      rrState[fid] = Math.max(0, npc.lck ?? 0);
      return `🔁 **${npc.name}** 🎭 — **${rrState[fid]}** reroll token${rrState[fid] === 1 ? '' : 's'}`;
    });
    upsertFight(gid, cid, { rr_state: JSON.stringify(rrState) });
    return interaction.reply({ content: ['✨ **NPC rerolls refilled:**', '', ...lines].join('\n') });
  }

  // ── AUTO (auto-run a fight: full / npconly / demo) ────────────────────────
  if (sub === 'auto') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can use /fight auto.', ephemeral: true });
    const mode = interaction.options.getString('mode');
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const channel = chan;
    const send = async (txt) => { await channel.send(txt).catch(()=>{}); };
    // A practice bout stops at the floor instead of 0, in every auto mode.
    const floor = (interaction.options.getBoolean('practice') ?? false) ? PRACTICE_FLOOR : 0;
    const W = fightWords(floor);
    const banner = practiceBanner(floor);

    // ---- DEMO: throwaway example fighters, nothing persisted ----
    if (mode === 'demo') {
      const existing = getFight(gid, cid);
      if (existing && existing.state !== 'idle') return interaction.reply({ content: '❌ Finish or `/fight end` the current fight first.', ephemeral: true });
      await interaction.reply({ content: `🎬 **Running a demo ${W.noun} with two example combatants...**` });
      const A = { name: 'Sir Aldric (demo)', dex: 4, str: 5, hp: 7 };
      const B = { name: 'Cave Troll (demo)', dex: 2, str: 6, hp: 8 };
      const aInit = rollDie(20) + A.dex, bInit = rollDie(20) + B.dex;
      const order = aInit >= bInit ? [A, B] : [B, A];
      await sleep(900);
      await send([`⚔️ **Demo ${W.noun} — initiative:**`, ...(banner ? [banner] : []), '', `1. **${order[0].name}**`, `2. **${order[1].name}**`, '', `🎯 **${order[0].name}** goes first!`].join('\n'));
      let turn = 0, round = 1, safety = 0;
      while (A.hp > floor && B.hp > floor && safety < 12) {
        safety++;
        const atk = order[turn % 2], def = order[(turn + 1) % 2];
        await sleep(1100);
        const aStat = autoFightStat(atk), dStat = autoFightStat(def);
        const a = autoRoll(atk[aStat]), d = autoRoll(def[dStat]);
        const { hit, dmg } = resolveDamage(a.total, a.nat, 20, d.total, d.nat, 20);
        const lines = ['─────────────────────────────', `**Round ${round}** — ${atk.name} attacks ${def.name}`,
          `⚔️ ${STAT_LABELS[aStat]} → [${a.nat}] +${atk[aStat]} = ${fightTotalStr(a.total, a.nat, 20)}`,
          `🛡️ ${STAT_LABELS[dStat]} → [${d.nat}] +${def[dStat]} = ${fightTotalStr(d.total, d.nat, 20)}`];
        if (hit) { const was = def.hp; def.hp = applyFightDamage(def.hp, dmg, floor); lines.push('', `💥 Hit for **${dmg}**! ${def.name} HP: **${was} → ${def.hp}**`); if (def.hp <= floor) lines.push('', `${W.icon} **${def.name}** ${W.out}!`); }
        else lines.push('', `🛡️ **${def.name}** blocks — no damage.`);
        await send(lines.join('\n'));
        turn++; if (turn % 2 === 0) round++;
      }
      await sleep(900);
      const winner = A.hp > floor ? A : B;
      await send(`\n🏆 **${winner.name}** wins the demo ${W.noun}!\n\n*That's the basic flow: initiative → attack vs defend → damage on a hit. In a real fight, players use \`/fight atk\` and \`/fight def\`, and a GM acts for NPCs with the \`npc:\` option (or runs \`/fight auto\` in full / NPCs-only mode).*`);
      return;
    }

    // ---- Build the real fighter roster from the named players + NPCs ----
    // Parse one side of a teams string into fighter ids (mentions + NPC names/categories)
    const parseSide = (text) => {
      const ids = [];
      for (const id of parsePlayerMentions(text)) ids.push(id);
      const rest = text.replace(/<@!?\d+>/g, ' ');
      for (const n of expandNpcList(gid, rest)) {
        const npc = getNpc(gid, n);
        if (!npc) return { error: `❌ NPC **${n}** not found.` };
        const fid = npcFighterId(npc.name);
        if (!ids.includes(fid)) ids.push(fid);
      }
      return { ids };
    };

    const teamsRaw = (interaction.options.getString('teams') || '').trim();
    const sideOf = {}; // fid -> 1|2 when teams are in play (full mode only)
    let useTeams = false;
    const fighters = [];

    if (teamsRaw && mode === 'full') {
      const parts = teamsRaw.split(/\s+vs\s+/i);
      if (parts.length !== 2) return interaction.reply({ content: '❌ Teams format: `teams:@a @b vs Goblin, Orc` (exactly one "vs").', ephemeral: true });
      const s1 = parseSide(parts[0]), s2 = parseSide(parts[1]);
      if (s1.error) return interaction.reply({ content: s1.error, ephemeral: true });
      if (s2.error) return interaction.reply({ content: s2.error, ephemeral: true });
      if (!s1.ids.length || !s2.ids.length) return interaction.reply({ content: '❌ Both teams need at least one fighter.', ephemeral: true });
      for (const fid of s1.ids) { if (sideOf[fid]) return interaction.reply({ content: '❌ A fighter appears on both teams.', ephemeral: true }); sideOf[fid] = 1; fighters.push(fid); }
      for (const fid of s2.ids) { if (sideOf[fid]) return interaction.reply({ content: '❌ A fighter appears on both teams.', ephemeral: true }); sideOf[fid] = 2; fighters.push(fid); }
      useTeams = true;
    } else {
      if (teamsRaw) return interaction.reply({ content: '❌ `teams:` only applies to `mode:Full`.', ephemeral: true });
      for (const id of parsePlayerMentions(interaction.options.getString('players'))) fighters.push(id);
      const npcNames = expandNpcList(gid, interaction.options.getString('npcs'));
      for (const n of npcNames) {
        const npc = getNpc(gid, n);
        if (!npc) return interaction.reply({ content: `❌ NPC **${n}** not found. Tip: \`category:Name\` adds a whole category.`, ephemeral: true });
        const fid = npcFighterId(npc.name); // canonical stored name
        if (!fighters.includes(fid)) fighters.push(fid);
      }
    }
    if (new Set(fighters).size !== fighters.length) return interaction.reply({ content: '❌ A fighter was listed more than once.', ephemeral: true });

    if (fighters.length < 2) return interaction.reply({ content: '❌ Need at least 2 fighters. Use `players:` (@mention) and/or `npcs:` (comma-separated).', ephemeral: true });

    // Leave out anyone who can't take the field (below the floor / already down)
    const { active: autoActive, downed: autoDowned } = await partitionDowned(interaction.guild, gid, fighters, floor);
    const autoWarn = downedWarning(autoDowned, gid, floor);
    if (autoActive.length < 2) {
      return interaction.reply({ content: `❌ Need at least 2 fighters with HP above ${floor}.${autoWarn ? `\n${autoWarn}` : ''}`, ephemeral: true });
    }
    fighters.length = 0; fighters.push(...autoActive.map(a => a.fid));
    if (useTeams) {
      const t1 = fighters.some(fid => sideOf[fid] === 1), t2 = fighters.some(fid => sideOf[fid] === 2);
      if (!t1 || !t2) return interaction.reply({ content: `❌ Team ${t1 ? 2 : 1} has no able fighters.${autoWarn ? `\n${autoWarn}` : ''}`, ephemeral: true });
    }
    if (autoWarn) await chan.send(autoWarn).catch(()=>{});

    // Resolve everyone up front
    const F = {}; // fid -> resolved fighter (+ live hp)
    for (const fid of fighters) {
      const rf = await resolveFighter(interaction.guild, gid, fid);
      F[fid] = rf;
    }

    // Initiative for all
    const inits = fighters.map(fid => ({ fid, roll: 0, total: 0 }));
    for (const it of inits) { const r = rollDie(20); it.roll = r; it.total = r + (F[it.fid].stats.dex ?? 0); }
    inits.sort((a,b) => b.total - a.total || b.roll - a.roll);
    const order = inits.map(i => i.fid);

    // Live HP for each fighter (from their sheet's current HP)
    const hp = {};
    const rrTokens = {}; // per-fight NPC reroll tokens (LCK) — full mode
    const fxState = {};  // carry-over effects (nat-1 atk / nat-20 def) — full mode
    for (const fid of fighters) {
      hp[fid] = F[fid].isNpc ? (getNpc(gid, F[fid].name)?.hp_current ?? 0) : (getChar(gid, fid)?.hp_current ?? 0);
      if (F[fid].isNpc) rrTokens[fid] = Math.max(0, F[fid].stats.lck ?? 0);
    }

    // ---- NPCONLY: set up a real, persisted fight where the bot will auto-take NPC turns ----
    if (mode === 'npconly') {
      const existing = getFight(gid, cid);
      if (existing && existing.state !== 'idle') return interaction.reply({ content: '❌ Finish or `/fight end` the current fight first.', ephemeral: true });
      const hpState = {}; for (const fid of fighters) hpState[fid] = hp[fid];
      const rrState = {}; for (const fid of fighters) if (F[fid].isNpc) rrState[fid] = Math.max(0, F[fid].stats.lck ?? 0);
      upsertFight(gid, cid, {
        state: 'active', turn_order: JSON.stringify(order), turn_index: 0,
        phase: 'attack', current_target: null,
        atk_roll: null, atk_nat: null, atk_stat: null,
        def_roll: null, def_nat: null, def_stat: null,
        hp_state: JSON.stringify(hpState), rr_state: JSON.stringify(rrState), auto_npc: 1,
        floor_hp: floor,
      });
      const lines = [`⚔️ **${W.started} (NPCs auto-piloted)**`, ...(banner ? [banner] : []), '', '**Initiative:**'];
      inits.forEach((it,i)=>{ const f=F[it.fid]; lines.push(`${i+1}. **${f.name}${f.isNpc?' 🎭':''}** — 🎲 [${it.roll}] + ⚡ ${f.stats.dex} DEX = **${it.total}**`); });
      const firstF = F[order[0]];
      lines.push('', firstF.isNpc ? `🤖 **${firstF.name}** is an NPC — the bot will take its turn automatically.` : `🎯 **${firstF.name}** goes first! Use \`/fight atk\` to attack.${turnPing(gid, firstF)}`);
      await interaction.reply({ content: lines.join('\n') });
      // If the first fighter is an NPC, kick off its turn
      if (firstF.isNpc) { await sleep(1200); await runAutoNpcChain(interaction.guild, gid, cid, channel); }
      return;
    }

    // ---- FULL: bot rolls everything to a winner, persists final HP, stores nothing ongoing ----
    await interaction.reply({ content: `🎬 **Auto-resolving the ${W.noun}...**` });
    const lines0 = ['⚔️ **Initiative:**', ...(banner ? [banner] : [])];
    inits.forEach((it,i)=>{ const f=F[it.fid]; lines0.push(`${i+1}. **${f.name}${f.isNpc?' 🎭':''}** — 🎲 [${it.roll}] + ⚡ ${f.stats.dex} DEX = **${it.total}**`); });
    await sleep(800); await send(lines0.join('\n'));

    const alive = () => order.filter(fid => hp[fid] > floor);
    const sideAlive = (t) => order.some(fid => sideOf[fid] === t && hp[fid] > floor);
    const fightOn = () => useTeams ? (sideAlive(1) && sideAlive(2)) : alive().length > 1;
    const autoLog = { exchanges: 0, f: {} };
    const ensureLog = (fid) => (autoLog.f[fid] = autoLog.f[fid] || FIGHTER_LOG());
    let idx = 0, round = 1, safety = 0, exchanges = 0;
    while (fightOn() && safety < 200) {
      safety++;
      // find next living attacker starting at idx
      let guard = 0;
      while (hp[order[idx]] <= floor && guard < order.length) { idx = (idx + 1) % order.length; guard++; }
      const attackerId = order[idx];
      // One round = every living fighter has taken one attack. Count completed
      // exchanges against the current number of living fighters rather than
      // watching the index wrap, which mislabelled the second half of a round.
      const livingCount = Math.max(1, order.filter(fid => hp[fid] > floor).length);
      round = Math.floor(exchanges / livingCount) + 1;
      exchanges++;
      // pick a random living opponent
      const opponents = alive().filter(fid => useTeams ? sideOf[fid] !== sideOf[attackerId] : fid !== attackerId);
      if (!opponents.length) break;
      const defenderId = opponents[Math.floor(Math.random() * opponents.length)];

      const atkF = F[attackerId], defF = F[defenderId];
      const aStat = autoFightStat(atkF.stats), dStat = autoFightStat(defF.stats);
      // Consume carry-over effects: attacker's riposte bonus, defender's flat-d20.
      const atkBonus = fxState[attackerId]?.atkBonus ?? 0;
      const defFlat = !!fxState[defenderId]?.flatDef;
      if (fxState[attackerId]) delete fxState[attackerId].atkBonus;
      if (fxState[defenderId]) delete fxState[defenderId].flatDef;
      const atkRow = atkF.isNpc ? getNpc(gid, atkF.name) : getChar(gid, attackerId);
      const defRow = defF.isNpc ? getNpc(gid, defF.name) : getChar(gid, defenderId);
      const atkAdv = hasSignatureAdvantage(atkRow, aStat);
      const defAdv = !defFlat && hasSignatureAdvantage(defRow, dStat);
      let a = autoRoll((atkF.stats[aStat] ?? 0) + atkBonus, atkAdv);
      let d = autoRoll(defFlat ? 0 : (defF.stats[dStat] ?? 0), defAdv);
      let { hit, dmg } = resolveDamage(a.total, a.nat, 20, d.total, d.nat, 20);

      // Round header (system line)
      await sleep(900);
      await send(`─────────────────────────────\n**Round ${round}**`);

      // Attacker's roll card — posts AS the NPC if it's an NPC, else a normal card
      const atkCard = await autoFightCard(interaction.guild, gid, atkF, 'atk', aStat, a.nat, a.total, `${defF.name}${defF.isNpc?' 🎭':''}`, false, atkBonus, false, !!a.adv);
      await sleep(700);
      if (atkF.isNpc) await postAsNpc(channel, gid, atkF.name, atkCard);
      else await send(atkCard);
      if (atkBonus) await send(`✨ **${atkF.name}** presses the riposte (+${atkBonus}).`);

      // Defender's roll card — same treatment
      const defCard = await autoFightCard(interaction.guild, gid, defF, 'def', dStat, d.nat, d.total, null, false, 0, defFlat, !!d.adv);
      await sleep(700);
      if (defF.isNpc) await postAsNpc(channel, gid, defF.name, defCard);
      else await send(defCard);
      if (defFlat) await send(`🎲 **${defF.name}** defends on a flat d20 (fumbled last attack).`);

      // NPC reroll window: only on a poor natural die (≤ guild threshold) —
      // defender answers an incoming hit, attacker a block
      const rrMax = getNpcRrThreshold(gid);
      if (hit && d.nat <= rrMax && defF.isNpc && (rrTokens[defenderId] ?? 0) > 0) {
        rrTokens[defenderId]--;
        d = autoRoll(defFlat ? 0 : (defF.stats[dStat] ?? 0), defAdv);
        await sleep(800);
        await send(`🔁 **${defF.name}** 🎭 spends a reroll token! (${rrTokens[defenderId]} left)`);
        const rrCard = await autoFightCard(interaction.guild, gid, defF, 'def', dStat, d.nat, d.total, null, true, 0, defFlat, !!d.adv);
        await postAsNpc(channel, gid, defF.name, rrCard);
        ensureLog(defenderId).rr++;
        ({ hit, dmg } = resolveDamage(a.total, a.nat, 20, d.total, d.nat, 20));
      }
      if (!hit && a.nat <= rrMax && atkF.isNpc && (rrTokens[attackerId] ?? 0) > 0) {
        rrTokens[attackerId]--;
        a = autoRoll((atkF.stats[aStat] ?? 0) + atkBonus, atkAdv);
        await sleep(800);
        await send(`🔁 **${atkF.name}** 🎭 spends a reroll token! (${rrTokens[attackerId]} left)`);
        const rrCard = await autoFightCard(interaction.guild, gid, atkF, 'atk', aStat, a.nat, a.total, `${defF.name}${defF.isNpc?' 🎭':''}`, true, atkBonus, false, !!a.adv);
        await postAsNpc(channel, gid, atkF.name, rrCard);
        ensureLog(attackerId).rr++;
        ({ hit, dmg } = resolveDamage(a.total, a.nat, 20, d.total, d.nat, 20));
      }

      recordExchange(autoLog, ensureLog, attackerId, defenderId, a.nat, d.nat, hit, dmg,
        { atkTotal: a.total, defTotal: d.total, atkStat: aStat, defStat: dStat });

      // Set carry-over effects from this exchange (in-memory mirror of applyExchangeEffects)
      const fxNotes = [];
      if (a.nat === 1) { (fxState[attackerId] = fxState[attackerId] || {}).flatDef = true; fxNotes.push('flat_def'); }
      if (d.nat === 20 && a.nat !== 20) { (fxState[defenderId] = fxState[defenderId] || {}).atkBonus = 2; fxNotes.push('atk_bonus'); }

      // Outcome (system line)
      let outcome;
      if (hit) {
        const wasHp = hp[defenderId];
        hp[defenderId] = applyFightDamage(hp[defenderId], dmg, floor);
        setFighterHp(gid, defenderId, hp[defenderId]); // keep sheets live so the next card is accurate
        outcome = `💥 Hit for **${dmg}**! ` + (defF.isNpc && !npcStatsVisible(gid)
          ? `${defF.name}: ${hpCondition(hp[defenderId], defF.maxHp, floor)}`
          : `${defF.name} HP: **${wasHp} → ${hp[defenderId]}**`);
        if (hp[defenderId] <= floor) outcome += `\n${W.icon} **${defF.name}** ${W.out}!`;
      } else {
        outcome = `🛡️ **${defF.name}** blocks — no damage.`;
      }
      for (const l of effectNoteLines(fxNotes, `**${atkF.name}${atkF.isNpc?' 🎭':''}**`, `**${defF.name}${defF.isNpc?' 🎭':''}**`)) outcome += `\n${l}`;
      await sleep(700); await send(outcome);

      idx = (idx + 1) % order.length;
    }

    // Persist final HP to real sheets
    for (const fid of fighters) setFighterHp(gid, fid, hp[fid]);

    await sleep(800);
    const survivors = alive();
    let winLine;
    if (useTeams && (sideAlive(1) !== sideAlive(2))) {
      const winner = sideAlive(1) ? 1 : 2;
      const names = survivors.filter(fid => sideOf[fid] === winner).map(fid => `**${F[fid].name}${F[fid].isNpc?' 🎭':''}**`).join(', ');
      winLine = `🏆 **Team ${winner}** ${W.win}! Survivors: ${names}. Final HP has been saved to all combatants' sheets.`;
    } else if (!useTeams && survivors.length === 1) {
      const w = F[survivors[0]];
      winLine = `🏆 **${w.name}${w.isNpc?' 🎭':''}** ${W.win}! Final HP has been saved to all combatants' sheets.`;
    } else {
      winLine = `⚖️ The ${W.noun} ended without a clear winner. Final HP saved to all combatants' sheets.`;
    }
    archiveFight(gid, interactionChannelId(interaction), autoLog, order, floor);
    await announceFightEnd(interaction.guild, gid, interactionChannelId(interaction), channel, {
      headline: winLine, log: autoLog, roster: order, hpState: hp, floor,
    });
    return;
  }

  // ── ORDER (rearrange turn order of an active fight) ───────────────────────
  if (sub === 'order') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can change the turn order.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });

    const currentOrder = JSON.parse(fight.turn_order);
    const seqStr = interaction.options.getString('sequence');
    const playersStr = interaction.options.getString('players');

    let newOrder = [];
    if (seqStr) {
      // Comma-separated, preserving order. Each item is either a mention or an NPC name.
      for (const raw of seqStr.split(',')) {
        const item = raw.trim();
        if (!item) continue;
        const m = item.match(/<@!?(\d+)>|^(\d{15,21})$/);
        if (m) {
          newOrder.push(m[1] || m[2]);
        } else {
          // Treat as an NPC name — match against the fight's NPC fighters (case-insensitive)
          const match = currentOrder.find(fid => isNpcFighter(fid) && npcNameFromFighter(fid).toLowerCase() === item.toLowerCase());
          newOrder.push(match || npcFighterId(item));
        }
      }
    } else if (playersStr) {
      newOrder = parsePlayerMentions(playersStr);
    } else {
      return interaction.reply({ content: '❌ Provide a `sequence` (e.g. `@Alice, Goblin, @Bob`) or a `players` list.', ephemeral: true });
    }

    // The new order must contain exactly the same fighters as the current fight
    const sameSet = newOrder.length === currentOrder.length &&
      newOrder.every(id => currentOrder.includes(id)) &&
      new Set(newOrder).size === newOrder.length;
    if (!sameSet) {
      const roster = [];
      for (const fid of currentOrder) {
        const f = await resolveFighter(interaction.guild, gid, fid);
        roster.push(`• ${f.name}${f.isNpc ? ' (NPC)' : ''}`);
      }
      return interaction.reply({ content: `❌ The new order must list every current fighter exactly once — no additions, removals, or duplicates.\n\n**Current fighters:**\n${roster.join('\n')}\n\nList them in order in \`sequence\`, separated by commas — @mention players and type NPC names (e.g. \`@Alice, Goblin, @Bob\`).`, ephemeral: true });
    }

    // Keep the same fighter on their turn if possible, else reset to the top
    const currentActiveId = currentOrder[fight.turn_index];
    const newIndex = Math.max(0, newOrder.indexOf(currentActiveId));

    upsertFight(gid, cid, { turn_order: JSON.stringify(newOrder), turn_index: newIndex });

    const lines = ['🔀 **Turn order updated:**', ''];
    for (let i = 0; i < newOrder.length; i++) {
      const f = await resolveFighter(interaction.guild, gid, newOrder[i]);
      const marker = i === newIndex ? '  ⬅️ current turn' : '';
      lines.push(`${i+1}. **${f.name}${f.isNpc ? ' 🎭' : ''}**${marker}`);
    }
    return interaction.reply({ content: lines.join('\n') });
  }

  // ── ATK (normal / adv / dis) ──────────────────────────────────────────────
  if (sub === 'atk') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const currentId = turnOrder[fight.turn_index];
    const npcActAs = interaction.options.getString('npc'); // GM acting as an NPC

    // Determine who is acting (a user, or a GM-controlled NPC)
    let actorId;
    if (npcActAs) {
      if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can act as an NPC.', ephemeral: true });
      actorId = npcFighterId(npcActAs);
      if (!isNpcFighter(currentId) || currentId !== actorId) {
        const cur = await resolveFighter(interaction.guild, gid, currentId);
        return interaction.reply({ content: `⚠️ It's **${cur.name}**'s turn, not **${npcActAs}**'s.`, ephemeral: true });
      }
    } else {
      actorId = uid;
      if (uid !== currentId) {
        const cur = await resolveFighter(interaction.guild, gid, currentId);
        const hint = cur.isNpc ? ` (a GM must act with \`npc:${cur.name}\`)` : '';
        return interaction.reply({ content: `⚠️ It's **${cur.name}**'s turn to attack.${hint}`, ephemeral: false });
      }
    }

    if (fight.phase !== 'attack') return interaction.reply({ content: '❌ Waiting for defender to roll first.', ephemeral: true });

    const stat = interaction.options.getString('stat');
    const targetUser = interaction.options.getUser('target');
    const targetNpc = interaction.options.getString('target_npc');
    const flavour = interaction.options.getString('flavour') ?? null;
    let mode = interaction.options.getString('roll') ?? 'normal';

    if (!targetUser && !targetNpc) return interaction.reply({ content: '❌ Pick a `target` (player) or `target_npc` (NPC) to attack.', ephemeral: true });
    if (targetUser && targetNpc) return interaction.reply({ content: '❌ Choose either a player target or an NPC target, not both.', ephemeral: true });
    const targetId = targetNpc ? npcFighterId(targetNpc) : targetUser.id;

    if (!turnOrder.includes(targetId)) return interaction.reply({ content: '❌ That target is not in this fight.', ephemeral: true });
    if (targetId === actorId) return interaction.reply({ content: '❌ You cannot target yourself.', ephemeral: true });

    const hpState = JSON.parse(fight.hp_state);
    const atkFloor = fightFloor(fight);
    if (hpState[targetId] !== undefined && hpState[targetId] <= atkFloor) {
      return interaction.reply({ content: atkFloor > 0 ? '❌ That fighter has already yielded the bout.' : '❌ That target is already down.', ephemeral: true });
    }

    const actor = await resolveFighter(interaction.guild, gid, actorId);
    const targetF = await resolveFighter(interaction.guild, gid, targetId);
    const statVal = actor.stats[stat] ?? 0;
    // Consume a pending riposte bonus from a previous nat-20 defence.
    const atkBonus = consumeAtkBonus(gid, cid, actorId);
    // Hero signature advantage (players and Hero NPCs alike)
    const sigRowA = isNpcFighter(actorId) ? getNpc(gid, npcNameFromFighter(actorId)) : getChar(gid, actorId);
    mode = applySignatureMode(sigRowA, stat, mode);
    const effTotal = statVal + atkBonus;
    let nat, total, rollLine;
    const bonusTag = atkBonus ? ` +${atkBonus} riposte` : '';
    const modStr = effTotal > 0 ? ` +${effTotal}` : effTotal < 0 ? ` ${effTotal}` : '';

    if (mode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + effTotal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]}${bonusTag} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (mode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + effTotal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]}${bonusTag} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + effTotal;
      rollLine = `⚔️  1d20+${STAT_LABELS[stat]}${bonusTag} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }
    mirrorRoll(gid, { userId: uid, channelId: cid, interaction,
      input: `/fight atk stat:${stat}${isNpcFighter(actorId) ? ` npc:${actor.name}` : ''}`, rollLine,
      context: isNpcFighter(actorId) ? `fight · GM as ${actor.name} 🎭 attacks ${targetF.name}` : `fight · attacks ${targetF.name}` });

    const targetName = targetF.name + (targetF.isNpc ? ' 🎭' : '');
    const critType = nat === 20 ? 'crit' : (nat === 1 ? 'fail' : null);
    const actorCard = await fighterCharCard(interaction.guild, gid, actorId);

    const headerLabel = `⚔️ Attacks ${targetName} with ${STAT_LABELS[stat]}`;
    const card = buildRollEmbed({
      rollLine, label: headerLabel, isReroll: false,
      char: actorCard, healCharges: 0, maxCharges: 0,
      flavour: flavour || null, total, critType, tags: null, gid,
    });
    const autoOn = !!fight.auto_npc;
    const defHint = targetF.isNpc
      ? (autoOn ? `🤖 **${targetF.name}** defends automatically...` : `🛡️ A GM defends for **${targetF.name}** with \`/fight def npc:${targetF.name}\`.`)
      : `🛡️ **${targetF.name}** — use \`/fight def\` to defend.`;

    upsertFight(gid, cid, {
      phase: 'defend', current_target: targetId,
      atk_roll: total, atk_nat: nat, atk_stat: stat, atk_mode: mode, atk_sides: 20,
      def_roll: null, def_nat: null, def_stat: null, def_mode: 'normal',
    });
    if (!actor.isNpc) saveRoll(gid, cid, uid, `1d20+${statVal}`, `atk ${STAT_LABELS[stat]}`);
    if (actor.isNpc) {
      // Post the NPC's card through its webhook, ack the GM privately
      await postAsNpc(chan, gid, actor.name, card);
      await chan.send(defHint).catch(()=>{});
      await interaction.reply({ content: `✅ Attacked as **${actor.name}**.`, ephemeral: true });
    } else {
      await interaction.reply({ content: `${card}\n\n${defHint}` });
    }
    // NPCs-only mode: the bot rolls the targeted NPC's defence and resolves.
    if (autoOn && targetF.isNpc) {
      await new Promise(r=>setTimeout(r,1200));
      await runAutoNpcChain(interaction.guild, gid, cid, chan);
    }
    return;
  }

  // ── DEF (normal / adv / dis) ──────────────────────────────────────────────
  if (sub === 'def') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    if (fight.phase !== 'defend') return interaction.reply({ content: '❌ No attack to defend against yet.', ephemeral: true });

    const npcActAs = interaction.options.getString('npc'); // GM defending as an NPC
    const targetId = fight.current_target;

    let defenderId;
    if (npcActAs) {
      if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can defend as an NPC.', ephemeral: true });
      defenderId = npcFighterId(npcActAs);
      if (!isNpcFighter(targetId) || targetId !== defenderId) {
        const tf = await resolveFighter(interaction.guild, gid, targetId);
        return interaction.reply({ content: `⚠️ **${tf.name}** is the one defending, not **${npcActAs}**.`, ephemeral: true });
      }
    } else {
      defenderId = uid;
      if (uid !== targetId) {
        const tf = await resolveFighter(interaction.guild, gid, targetId);
        const hint = tf.isNpc ? ` (a GM defends with \`npc:${tf.name}\`)` : '';
        return interaction.reply({ content: `⚠️ **${tf.name}** is the one defending.${hint}`, ephemeral: false });
      }
    }

    const stat = interaction.options.getString('stat');
    const flavour = interaction.options.getString('flavour') ?? null;
    let mode = interaction.options.getString('roll') ?? 'normal';

    const defender = await resolveFighter(interaction.guild, gid, defenderId);
    const statVal = defender.stats[stat] ?? 0;
    // A previous nat-1 attack forces this defence to be a flat d20 (no stat, no adv/dis).
    const flat = consumeFlatDef(gid, cid, defenderId);
    // Hero signature advantage (ignored when the roll is forced flat)
    const sigRowD = isNpcFighter(defenderId) ? getNpc(gid, npcNameFromFighter(defenderId)) : getChar(gid, defenderId);
    if (!flat) mode = applySignatureMode(sigRowD, stat, mode);
    const effVal = flat ? 0 : statVal;
    const effMode = flat ? 'normal' : mode;
    const modStr = flat ? '' : (effVal > 0 ? ` +${effVal}` : effVal < 0 ? ` ${effVal}` : '');
    const flatTag = flat ? ' (flat d20 — fumbled last attack)' : '';
    let nat, total, rollLine;

    if (effMode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + effVal;
      rollLine = `🛡️  1d20+${STAT_LABELS[stat]} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (effMode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + effVal;
      rollLine = `🛡️  1d20+${STAT_LABELS[stat]} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + effVal;
      const label = flat ? `🛡️  1d20${flatTag}` : `🛡️  1d20+${STAT_LABELS[stat]}`;
      rollLine = `${label} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }
    mirrorRoll(gid, { userId: uid, channelId: cid, interaction,
      input: `/fight def stat:${stat}${isNpcFighter(defenderId) ? ` npc:${defender.name}` : ''}`, rollLine,
      context: isNpcFighter(defenderId) ? `fight · GM as ${defender.name} 🎭 defends` : 'fight · defends' });

    const critType = nat === 20 ? 'crit' : (nat === 1 ? 'fail' : null);
    const defCard = await fighterCharCard(interaction.guild, gid, defenderId);
    const card = buildRollEmbed({
      rollLine, label: `🛡️ Defends with ${STAT_LABELS[stat]}`, isReroll: false,
      char: defCard, healCharges: 0, maxCharges: 0,
      flavour: flavour || null, total, critType, tags: null, gid,
    });

    upsertFight(gid, cid, { def_roll: total, def_nat: nat, def_stat: stat, def_mode: mode, def_sides: 20 });
    if (!defender.isNpc) saveRoll(gid, cid, uid, `1d20+${statVal}`, `def ${STAT_LABELS[stat]}`);
    if (defender.isNpc) {
      await postAsNpc(chan, gid, defender.name, card);
      await chan.send('⚡ Use `/fight resolve` to resolve this exchange.').catch(()=>{});
      return interaction.reply({ content: `✅ Defended as **${defender.name}**.`, ephemeral: true });
    }
    return interaction.reply({ content: `${card}\n\n⚡ Use \`/fight resolve\` to resolve this exchange.` });
  }

  // ── REROLLS ────────────────────────────────────────────────────────────────
  if (sub === 'rr') {
    let fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    const isAttacker = turnOrder[fight.turn_index] === uid;
    const isDefender = fight.current_target === uid && fight.phase === 'defend';

    if (!isAttacker && !isDefender) return interaction.reply({ content: '❌ It is not your turn to reroll.', ephemeral: true });

    // Make sure there's actually a roll to reroll BEFORE spending the token
    const stat = isAttacker ? fight.atk_stat : fight.def_stat;
    if (!stat) return interaction.reply({ content: '❌ No roll to reroll yet.', ephemeral: true });

    // Check reroll tokens
    const char = getChar(gid, uid);
    if (!char || char.rerolls_current <= 0) return interaction.reply({ content: '❌ No rerolls remaining.', ephemeral: true });
    upsertChar(gid, uid, { rerolls_current: char.rerolls_current - 1 });
    bumpFightLog(gid, cid, (log, ensure) => { ensure(uid).rr++; });

    const mode = interaction.options.getString('roll') ?? 'normal';

    // Preserve whatever modifier the ORIGINAL roll used: a nat-1 fumble made the
    // defence a flat d20 (mod 0), a nat-20 riposte gave the attack +2. Those effects
    // were consumed when the first roll was made, so reconstruct the modifier from it.
    const rawStat = char?.[stat] ?? 0;
    const origTotal = isAttacker ? fight.atk_roll : fight.def_roll;
    const origNat = isAttacker ? fight.atk_nat : fight.def_nat;
    const effMod = (origTotal != null && origNat != null) ? (origTotal - origNat) : rawStat;
    // A flat-d20 defence has mod 0 while the fighter's stat is non-zero — keep it flat
    // (no stat, no advantage/disadvantage) on the reroll too.
    const isFlat = !isAttacker && effMod === 0 && rawStat !== 0;
    const bonus = isAttacker ? Math.max(0, effMod - rawStat) : 0; // riposte carried into the reroll
    const effMode = isFlat ? 'normal' : mode;
    const modStr = isFlat ? '' : (effMod > 0 ? ` +${effMod}` : effMod < 0 ? ` ${effMod}` : '');
    const bonusTag = bonus ? ` +${bonus} riposte` : '';
    let nat, total, rollLine;
    const icon = isAttacker ? '⚔️' : '🛡️';

    if (effMode === 'adv') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.max(r1, r2); const dropped = Math.min(r1, r2);
      total = nat + effMod;
      rollLine = `${icon}  1d20+${STAT_LABELS[stat]}${bonusTag} (advantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else if (effMode === 'dis') {
      const r1 = rollDie(20), r2 = rollDie(20);
      nat = Math.min(r1, r2); const dropped = Math.max(r1, r2);
      total = nat + effMod;
      rollLine = `${icon}  1d20+${STAT_LABELS[stat]}${bonusTag} (disadvantage) → [${nat}, ~~${dropped}~~]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    } else {
      nat = rollDie(20); total = nat + effMod;
      const label = isFlat ? `${icon}  1d20 (flat — fumbled last attack)` : `${icon}  1d20+${STAT_LABELS[stat]}${bonusTag}`;
      rollLine = `${label} → [${nat}]${modStr} = ${fightTotalStr(total, nat, 20)}`;
    }
    mirrorRoll(gid, { userId: uid, channelId: cid, interaction,
      input: `/fight rr${mode !== 'normal' ? ` roll:${mode}` : ''}`, rollLine, context: 'fight · reroll' });

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
  // Rule changes here must be mirrored in autoResolveExchange (the auto-mode twin).
  if (sub === 'resolve') {
    let fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    if (fight.phase !== 'defend' || fight.def_roll === null) return interaction.reply({ content: '❌ Both attack and defend rolls needed before resolving.', ephemeral: true });

    // NPC reroll window in auto mode: defender may answer an incoming hit, attacker a block
    if (fight.auto_npc) {
      fight = await applyAutoNpcRerolls(interaction.guild, gid, cid, chan);
      if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ The fight is no longer active.', ephemeral: true });
    }

    const r = await resolveExchange(interaction.guild, gid, cid, fight);
    await replyLong(interaction, r.lines);
    if (r.ended) {
      await announceFightEnd(interaction.guild, gid, cid, chan, r.announce);
      return;
    }
    // Hand straight back to the bot when the next fighter is an auto-piloted NPC.
    if (fight.auto_npc && r.nextF?.isNpc) {
      await new Promise(res => setTimeout(res, 1200));
      await runAutoNpcChain(interaction.guild, gid, cid, chan);
    }
    return;
  }

  // ── FORFEIT ────────────────────────────────────────────────────────────────
  if (sub === 'forfeit') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });

    const turnOrder = JSON.parse(fight.turn_order);
    if (!turnOrder.includes(uid)) return interaction.reply({ content: '❌ You are not in this fight.', ephemeral: true });

    const member = await interaction.guild.members.fetch(uid).catch(()=>null);
    const name = member?.nickname || member?.user.username || uid;
    const hpState = JSON.parse(fight.hp_state);

    // HP state preserved as-is
    const newOrder = turnOrder.filter(id => id !== uid);
    const lines = [`🏳️ **${name}** forfeits the fight! Their HP remains at **${hpState[uid] ?? 0}**.`];

    let ffAnnounce = null;
    if (newOrder.length <= 1) {
      const ffFloor = fightFloor(fight);
      const ffW = fightWords(ffFloor);
      let headline = `🏳️ **${name}** conceded — the ${ffW.noun} is over.`;
      if (newOrder.length === 1) {
        const winF = await resolveFighter(interaction.guild, gid, newOrder[0]);
        headline = `🏆 **${winF.name}${winF.isNpc ? ' 🎭' : ''}** ${ffW.win} — **${name}** conceded.`;
      }
      const ffLog = JSON.parse(fight.log_state || '{}');
      archiveFight(gid, cid, ffLog, turnOrder, ffFloor);
      upsertFight(gid, cid, { state: 'idle', turn_order: '[]' });
      ffAnnounce = { headline, log: ffLog, roster: turnOrder, hpState, floor: ffFloor };
    } else {
      let newIndex = fight.turn_index % newOrder.length;
      const nextF = await resolveFighter(interaction.guild, gid, newOrder[newIndex]);
      const nextHint = nextF.isNpc ? ` (GM acts with \`npc:${nextF.name}\`)` : '';
      lines.push(`🎯 Fight continues — **${nextF.name}${nextF.isNpc ? ' 🎭' : ''}**'s turn!${nextHint}${turnPing(gid, nextF)}`);
      upsertFight(gid, cid, {
        turn_order: JSON.stringify(newOrder),
        turn_index: newIndex,
        phase: 'attack',
        current_target: null,
        atk_roll: null, atk_nat: null, def_roll: null, def_nat: null,
      });
    }

    await interaction.reply({ content: lines.join('\n') });
    if (ffAnnounce) await announceFightEnd(interaction.guild, gid, cid, chan, ffAnnounce);
    return;
  }

  // ── STATUS ─────────────────────────────────────────────────────────────────
  if (sub === 'status') {
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: false });

    const turnOrder = JSON.parse(fight.turn_order);
    const hpState = JSON.parse(fight.hp_state);
    const rrState = JSON.parse(fight.rr_state || '{}');
    const fxState = JSON.parse(fight.effect_state || '{}');
    const currentId = turnOrder[fight.turn_index];
    const floor = fightFloor(fight);
    const stBanner = practiceBanner(floor);

    const lines = [floor > 0 ? '🏳️ **Practice Bout Status**' : '⚔️ **Fight Status**', ...(stBanner ? [stBanner] : []), ''];
    for (let i = 0; i < turnOrder.length; i++) {
      const fid = turnOrder[i];
      const f = await resolveFighter(interaction.guild, gid, fid);
      const rawHp = hpState[fid] ?? 0;
      const hideHp = f.isNpc && !npcStatsVisible(gid);
      const hp = hpState[fid] ?? '?';
      const arrow = fid === currentId ? ' ◀ current' : '';
      const hpMax = f.maxHp || '?';
      const rrNote = f.isNpc && fight.auto_npc ? ` · 🔁 ${rrState[fid] ?? 0}` : '';
      const fx = fxState[fid] || {};
      const fxBits = [];
      if (fx.atkBonus) fxBits.push(`✨ +${fx.atkBonus} next attack`);
      if (fx.flatDef) fxBits.push('🎲 flat-d20 next defence');
      const fxNote = fxBits.length ? ` · ${fxBits.join(' · ')}` : '';
      const hpText = hideHp ? hpCondition(rawHp, f.maxHp, floor) : `❤️ ${hp} / ${hpMax}${floor > 0 && rawHp <= floor ? ' 🏳️ yielded' : ''}`;
      lines.push(`${i+1}. **${f.name}${f.isNpc ? ' 🎭' : ''}** — ${hpText}${rrNote}${fxNote}${arrow}`);
    }
    lines.push('');
    lines.push(`Phase: **${fight.phase === 'attack' ? 'Waiting for attack' : 'Waiting for defence'}**`);
    if (fight.atk_roll) lines.push(`Latest attack roll: **${fight.atk_roll}** (${STAT_LABELS[fight.atk_stat] ?? '?'})`);
    if (fight.def_roll) lines.push(`Latest defence roll: **${fight.def_roll}** (${STAT_LABELS[fight.def_stat] ?? '?'})`);

    return interaction.reply({ content: lines.join('\n') });
  }

  // ── LOG (re-post the last finished fight's recap) ──────────────────────────
  if (sub === 'log') {
    const arch = getArchivedFight(gid, cid);
    if (!arch) return interaction.reply({ content: '📋 No finished fight recorded in this channel yet.', ephemeral: true });
    const log = JSON.parse(arch.log_state || '{}');
    const recap = await buildFightRecap(interaction.guild, gid, log);
    if (!recap.length) return interaction.reply({ content: '📋 The last fight here ended before any exchanges were resolved.', ephemeral: true });
    const archFloor = Number(arch.floor_hp ?? 0) > 0 ? Number(arch.floor_hp) : 0;
    // (recap already includes the roll tables and blow-by-blow)
    const lines = [`📜 **Last ${archFloor > 0 ? 'practice bout' : 'fight'} in this channel** — ended ${formatHistDate(arch.ended_at)}`,
                   ...(archFloor > 0 ? [`🏳️ Friendly sparring — fighters bowed out at ${archFloor} HP.`] : []),
                   ...recap.slice(1)];
    return replyLong(interaction, lines);
  }

  // ── SKIP (pass the current turn; the fighter stays in the fight) ───────────
  if (sub === 'skip') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can skip turns.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: NO_ACTIVE_FIGHT, ephemeral: true });
    const turnOrder = JSON.parse(fight.turn_order);
    const hpState = JSON.parse(fight.hp_state || '{}');
    const attackerId = turnOrder[fight.turn_index];
    const waitedOnId = fight.phase === 'defend' ? fight.current_target : attackerId;
    const waitedF = await resolveFighter(interaction.guild, gid, waitedOnId);
    const lines = [`⏭️ **${waitedF.name}${waitedF.isNpc ? ' 🎭' : ''}**'s turn skipped by the GM — they stay in the fight.`];

    const patch = {};
    if (fight.phase === 'defend') {
      Object.assign(patch, { phase: 'attack', current_target: null,
        atk_roll: null, atk_nat: null, atk_stat: null, def_roll: null, def_nat: null, def_stat: null });
      lines.push('↩️ The pending exchange was reset.');
    }
    // Advance past the current attacker, skipping anyone at or below the floor
    const skipFloor = fightFloor(fight);
    let nextIndex = (fight.turn_index + 1) % turnOrder.length;
    let safety = 0;
    while ((hpState[turnOrder[nextIndex]] ?? 0) <= skipFloor && safety < turnOrder.length) {
      nextIndex = (nextIndex + 1) % turnOrder.length; safety++;
    }
    patch.turn_index = nextIndex;
    upsertFight(gid, cid, patch);
    const nextF = await resolveFighter(interaction.guild, gid, turnOrder[nextIndex]);
    lines.push(`🎯 **${nextF.name}${nextF.isNpc ? ' 🎭' : ''}**'s turn to attack.${turnPing(gid, nextF)}`);
    return interaction.reply({ content: lines.join('\n') });
  }

  // ── END (GM only) ──────────────────────────────────────────────────────────
  if (sub === 'end') {
    if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can end a fight.', ephemeral: true });
    const fight = getFight(gid, cid);
    if (!fight || fight.state !== 'active') return interaction.reply({ content: '❌ No active fight to end.', ephemeral: true });
    return requestConfirm(interaction, 'End the current fight? Turn order clears but HP states are preserved.', async () => {
      const endRow = getFight(gid, cid);
      const endLog = JSON.parse(endRow?.log_state || '{}');
      const endFloor = fightFloor(endRow);
      const endRoster = JSON.parse(endRow?.turn_order || '[]');
      const endHp = JSON.parse(endRow?.hp_state || '{}');
      archiveFight(gid, cid, endLog, endRoster, endFloor);
      upsertFight(gid, cid, { state: 'idle', turn_order: '[]' });
      // The confirm reply is ephemeral — only the GM who pressed the button can
      // see it. Post the real result to the channel so the table sees it too.
      const gmName = await getDisplayName(interaction.guild, interaction.user.id);
      await announceFightEnd(interaction.guild, gid, cid, chan, {
        headline: `🛑 Called by **${gmName}** — no victor. HP states are preserved.`,
        log: endLog, roster: endRoster, hpState: endHp, floor: endFloor,
      });
      return '✅ Fight ended — the result and recap have been posted in the channel.';
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
    const last = getLastRoll(gid, interactionChannelId(interaction), uid);
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

  saveRoll(gid, interactionChannelId(interaction), uid, finalNotation, finalLabel);
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
    const existed = !!getNpc(gid, name);

    // Only write what was actually supplied — omitting a stat leaves it as-is
    // (so an NPC can be registered by name now and statted up later).
    const fields = {};
    for (const [k, v] of [['str',str],['con',con],['dex',dex],['wis',wis],['lck',lck]]) {
      if (v !== null) fields[k] = v;
    }
    if (order) fields.order_name = order;
    upsertNpc(gid, name, fields);

    // A brand-new NPC with no CON has 0 max HP, which would exclude them from
    // fights — start them at full so they're usable straight away.
    if (!existed) {
      const made = getNpc(gid, name);
      upsertNpc(gid, name, { hp_current: (made?.con ?? 0) + 2 });
    }

    const orderLine = order ? ` | ${KNIGHT_EMOJIS[order]??'⚪'} ${order}` : '';
    const statsSet = Object.keys(fields).filter(k => k !== 'order_name').length;
    const statNote = statsSet === 0
      ? '\n📋 No stats set yet — add them any time with `/npc create name:' + name + ' str:… con:…`.'
      : statsSet < 5
        ? '\n📋 Some stats still unset (showing as 0) — fill them in later with `/npc create`.'
        : '';
    await interaction.reply({ content: `✅ NPC **${name}** ${existed ? 'updated' : 'created'}.${orderLine}${statNote}\n💡 Upload an image to the NPC channel with \`${name}\` as the message text to set their avatar.` });
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

  if (sub === 'hp') {
    const name = interaction.options.getString('name');
    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });
    const max = npc.con + 2;
    const raw = interaction.options.getInteger('value');
    const newHp = raw === null ? max : Math.min(raw, max);
    upsertNpc(gid, npc.name, { hp_current: newHp });
    const note = raw !== null && raw > max ? ` (capped at max)` : raw === null ? ' — fully healed' : '';
    return interaction.reply({ content: `❤️ **${npc.name}** HP set to **${newHp} / ${max}**${note}.` });
  }

  if (sub === 'heal') {
    const raw = (interaction.options.getString('names') || '').trim();
    let targets;
    if (raw.toLowerCase() === 'all') {
      targets = getAllNpcs(gid);
      if (!targets.length) return interaction.reply({ content: '❌ No NPCs created yet. Use `/npc create` to add one.', ephemeral: true });
    } else {
      targets = [];
      for (const n of expandNpcList(gid, raw)) {
        const npc = getNpc(gid, n);
        if (!npc) return interaction.reply({ content: `❌ NPC **${n}** not found. Separate multiple NPCs with **commas** (e.g. \`names:Goblin, Orc\`), or use \`names:all\`.`, ephemeral: true });
        if (!targets.some(t => t.name === npc.name)) targets.push(npc);
      }
      if (!targets.length) return interaction.reply({ content: '❌ Name at least one NPC, or use `names:all`.', ephemeral: true });
    }
    const lines = targets.map(npc => {
      const max = npc.con + 2;
      upsertNpc(gid, npc.name, { hp_current: max });
      return `❤️ **${npc.name}** — **${max} / ${max}**`;
    });
    return interaction.reply({ content: [`✨ Fully healed **${targets.length}** NPC${targets.length === 1 ? '' : 's'}:`, '', ...lines].join('\n') });
  }

  if (sub === 'copy') {
    const srcName = interaction.options.getString('name');
    const newName = (interaction.options.getString('new_name') || '').trim();
    const src = getNpc(gid, srcName);
    if (!src) return interaction.reply({ content: `❌ NPC **${srcName}** not found.`, ephemeral: true });
    if (!newName) return interaction.reply({ content: '❌ Give the copy a name.', ephemeral: true });
    if (newName.length > 60) return interaction.reply({ content: '❌ Name too long (max 60 characters).', ephemeral: true });
    if (getNpc(gid, newName)) return interaction.reply({ content: `❌ An NPC named **${getNpc(gid, newName).name}** already exists.`, ephemeral: true });
    upsertNpc(gid, newName, {
      order_name: src.order_name, str: src.str, con: src.con, dex: src.dex, wis: src.wis, lck: src.lck,
      hp_current: src.con + 2, image_url: src.image_url ?? null,
    });
    return interaction.reply({ content: `🎭 Copied **${src.name}** → **${newName}** (fresh ❤️ ${src.con + 2} / ${src.con + 2}${src.image_url ? ', avatar carried over' : ''}).` });
  }

  if (sub === 'hero') {
    const name = interaction.options.getString('name');
    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });
    if (interaction.options.getBoolean('remove')) {
      upsertNpc(gid, npc.name, { class: null, signature_stat: null });
      return interaction.reply({ content: `✅ **${npc.name}** is no longer a Hero.` });
    }
    const stat = interaction.options.getString('stat');
    if (!stat) {
      upsertNpc(gid, npc.name, { class: 'Hero' });
      return interaction.reply({ content: `🦸 **${npc.name}** is now a **Hero**. Give them a signature stat with \`/npc hero name:${npc.name} stat:…\`.` });
    }
    const val = npc[stat] ?? 0;
    if (val < SIGNATURE_MIN) return interaction.reply({ content: `❌ **${npc.name}**'s ${STAT_LABELS[stat]} is **${val}** — a signature stat needs **${SIGNATURE_MIN}+**.`, ephemeral: true });
    upsertNpc(gid, npc.name, { class: 'Hero', signature_stat: stat });
    return interaction.reply({ content: `⭐ **${npc.name}** is a **Hero** with signature **${STAT_LABELS[stat]}** (${val}) — their ${STAT_LABELS[stat]} rolls now have **advantage**.` });
  }

  if (sub === 'show') {
    const name = interaction.options.getString('name');
    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found.`, ephemeral: true });
    const cats = getCategoriesForNpc(gid, npc.name);
    const lines = [
      `🎭 **${npc.name}**${npc.order_name ? ` · ${npc.order_name}` : ''}`,
      '─────────────────────────────',
      `💪 STR ${npc.str}   🛡️ CON ${npc.con}   ⚡ DEX ${npc.dex}`,
      `🦉 WIS ${npc.wis}   🍀 LCK ${npc.lck}`,
      `❤️ HP **${npc.hp_current} / ${npc.con + 2}**   🔁 ${Math.max(0, npc.lck ?? 0)} reroll token${(npc.lck ?? 0) === 1 ? '' : 's'} per fight`,
      `🖼️ Avatar: ${npc.image_url ? 'set' : '—'}${cats.length ? `   📁 ${cats.join(', ')}` : ''}`,
      ...(isHero(npc) ? [`🦸 **Hero**${npc.signature_stat ? ` · ⭐ signature **${STAT_LABELS[npc.signature_stat]}**${hasSignatureAdvantage(npc, npc.signature_stat) ? ' (advantage active)' : ` (inactive — needs ${SIGNATURE_MIN}+)`}` : ''}`] : []),
    ];
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'list') {
    let npcs = getAllNpcs(gid);
    if (!npcs.length) return interaction.reply({ content: '❌ No NPCs created yet. Use `/npc create` to add one.', ephemeral: true });
    const wantCat = (interaction.options.getString('category') || '').trim();
    let header = '**🎭 NPCs on this server:**';
    if (wantCat) {
      const cat = getCategories(gid).find(c => c.toLowerCase() === wantCat.toLowerCase());
      if (!cat) return interaction.reply({ content: `❌ No category named **${wantCat}**. Categories: ${getCategories(gid).join(', ') || 'none'}.`, ephemeral: true });
      const members = new Set(getNpcsInCategory(gid, cat));
      npcs = npcs.filter(n => members.has(n.name));
      if (!npcs.length) return interaction.reply({ content: `📁 Category **${cat}** has no NPCs.`, ephemeral: true });
      header = `**🎭 NPCs — 📁 ${cat}:**`;
    }
    const lines = [header, ''];
    npcs.forEach(n => {
      const order = n.order_name ? ` ${KNIGHT_EMOJIS[n.order_name]??'⚪'} ${n.order_name}` : '';
      const img = n.image_url ? ' 🖼️' : '';
      lines.push(`• **${n.name}**${order}${img} — STR ${n.str} CON ${n.con} DEX ${n.dex} WIS ${n.wis} LCK ${n.lck} | ❤️ ${n.hp_current}/${n.con+2}`);
    });
    return replyLong(interaction, lines);
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
    const last = getLastRoll(gid, interactionChannelId(interaction), `npc_${name}`);
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
    saveRoll(gid, interactionChannelId(interaction), `npc_${name}`, last.notation, last.label);

    const critType = detectCrit(result, mode);
    const rollLine = maskNpcRollLine(gid, buildRollLine(result, mode, critType, null));
    const lines = [];
    if (last.label) lines.push(`${critPrefix(critType)}**${last.label}** *(reroll)*`);
    else lines.push('*(reroll)*');
    lines.push(rollLine, '');
    lines.push(...npcCardFooter(gid, npc, updatedNpc));

    const content2 = lines.join('\n');

    try {
      const { WebhookClient } = require('discord.js');
      await interaction.deferReply({ ephemeral: true });
      let webhookClient;
      if (npc.webhook_id && npc.webhook_token) {
        webhookClient = new WebhookClient({ id: npc.webhook_id, token: npc.webhook_token });
      } else {
        const prChan = await interactionChannel(interaction);
        if (!prChan) return interaction.editReply({ content: '❌ I can\'t access this channel.' }).catch(()=>{});
        const webhook = await prChan.createWebhook({ name: npc.name, avatar: npc.image_url ?? BLANK_AVATAR, reason: `NPC webhook for ${npc.name}` });
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

  if (sub === 'say') {
    const name = interaction.options.getString('name');
    const action = interaction.options.getString('action');
    const speech = interaction.options.getString('speech');
    const raw = interaction.options.getString('raw');
    const npc = getNpc(gid, name);
    if (!npc) return interaction.reply({ content: `❌ NPC **${name}** not found. Create one with \`/npc create\`.`, ephemeral: true });

    // Nothing supplied → open a proper writing box with multi-line fields.
    if (!action && !speech && !raw) {
      const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
      const modal = new ModalBuilder()
        .setCustomId(`npcsay:${npc.name}`.slice(0, 100))
        .setTitle(`Speak as ${npc.name}`.slice(0, 45));
      const actionInput = new TextInputBuilder()
        .setCustomId('action').setLabel('Action (optional)')
        .setPlaceholder('draws his blade').setStyle(TextInputStyle.Paragraph)
        .setRequired(false).setMaxLength(900);
      const speechInput = new TextInputBuilder()
        .setCustomId('speech').setLabel('Speech (optional)')
        .setPlaceholder('Halt! Who goes there?').setStyle(TextInputStyle.Paragraph)
        .setRequired(false).setMaxLength(900);
      modal.addComponents(
        new ActionRowBuilder().addComponents(actionInput),
        new ActionRowBuilder().addComponents(speechInput),
      );
      return interaction.showModal(modal);
    }

    const text = composeNpcSay({ action, speech, raw });
    if (!text) return interaction.reply({ content: '❌ Nothing to post.', ephemeral: true });
    if (text.length > 1800) return interaction.reply({ content: '❌ Message too long (max 1800 characters).', ephemeral: true });

    const body = text;

    const chan = await interactionChannel(interaction);
    if (!chan) return interaction.reply({ content: '❌ I can\'t access this channel.', ephemeral: true });
    await postAsNpc(chan, gid, npc.name, body);
    return interaction.reply({ content: `🎭 Spoke as **${npc.name}**.`, ephemeral: true });
  }

  if (sub === 'roll') {
    const category = interaction.options.getString('category') ?? 'all';
    const name     = interaction.options.getString('name');
    // Creating an NPC's webhook is slow; defer so we never miss the 3s ack.
    let prDeferred = false;
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
    await interaction.deferReply({ ephemeral: true }).catch(()=>{});
    prDeferred = true;

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
    if (!result) return interaction.editReply({ content: '❌ Invalid dice notation.' });

    const critType = detectCrit(result, mode);
    const rollLine = maskNpcRollLine(gid, buildRollLine(result, mode, critType, null));

    // Build embed text
    const lines = [];
    if (label) lines.push(`${critPrefix(critType)}**${label}**`);
    lines.push(rollLine);
    lines.push('');
    lines.push(...npcCardFooter(gid, npc));
    if (flavour) {
      lines.push('');
      lines.push('─────────────────────────────');
      lines.push(`**${label??'roll'}** — ${totalStr(result.total, critType)}`);
      lines.push(flavour);
    }
    const content = lines.join('\n');

    // Save roll history for NPC reroll
    saveRoll(gid, interactionChannelId(interaction), `npc_${npc.name}`, notation, label);

    // Get or create webhook for this NPC
    try {
      const prChan2 = await interactionChannel(interaction);
      if (!prChan2) return interaction.editReply({ content: '❌ I can\'t access this channel.' }).catch(()=>{});
      // Webhook for THIS channel — otherwise the post lands wherever the NPC
      // first spoke, which looked like "nothing happened".
      const webhookClient = await npcWebhookIn(prChan2, gid, npc.name, npc.image_url);

      await webhookClient.send({
        content,
        username: npc.name,
        avatarURL: npc.image_url ?? BLANK_AVATAR,
      });
      return interaction.editReply({ content: `✅ Posted as **${npc.name}**.` });
    } catch (err) {
      console.error('Webhook error:', err);
      // A stored webhook may have been deleted server-side — drop it and retry.
      const fallbackChan = await interactionChannel(interaction);
      if (fallbackChan) {
        try {
          db.prepare('DELETE FROM npc_webhooks WHERE guild_id=? AND channel_id=? AND npc_name=?').run(gid, fallbackChan.id, npc.name);
          const fresh = await npcWebhookIn(fallbackChan, gid, npc.name, npc.image_url);
          await fresh.send({ content, username: npc.name, avatarURL: npc.image_url ?? BLANK_AVATAR });
          return interaction.editReply({ content: `✅ Posted as **${npc.name}**.` }).catch(()=>{});
        } catch (err2) {
          console.error('Webhook retry failed:', err2.message);
          await interaction.editReply({ content: '⚠️ Webhook failed — posting normally.' }).catch(()=>{});
          await fallbackChan.send({ content }).catch(()=>{});
        }
      }
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
      '`/roll` — guided roll: pick a stat, advantage, success check, label and RP flavour',
      '`str` / `con` / `dex` / `wis` / `lck` — quick stat roll. On its own with nothing else, so ordinary chat that starts with a stat name isn\'t rolled',
      '`r str atk` or `?str atk` — a plain stat roll **with a label**',
      '`wisa` / `dexd` — quick stat roll with **advantage** / **disadvantage** (a label may follow: `dexd guard`)',
      '`strrr` / `dexrra` / `conrrd` — reroll using a stat set · add a label like `strrr atk`',
      '`?1d20+5` — success check (crit/success/fail tiers)',
      '`/dr` — slash version with dropdowns for roll type & success',
    ],
  },
  character: {
    title: '📜 Character Sheet',
    body: [
      '`/char create` — set up a full character at once (stats, order, class, weapons, weapon emojis)',
      '`/char set field:STR value:14` — set one field at a time (with approvals on, any change to your own sheet goes back to the GMs)',
      '`/char weaponemoji slot:Weapon 1 emoji:⚔️` — pick a weapon slot emoji',
      '`/char show [user]` — view a character sheet',
      '`/char export [format:Image]` — export your sheet as text or image. With approvals on it goes to the GMs first and reaches you when one releases it',
      '`/char signature user:@a stat:str` — set a Hero\'s signature stat (GM)',
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
      '`/fight start players:@a @b npcs:Goblin, Orc` — begin a fight with any number of players and GM NPCs (auto-rolls DEX initiative)',
      '`/fight start ... manual:true` — keep the order you listed fighters in (no roll)',
      '`/fight start ... practice:true` — friendly bout: fighters yield at 2 HP and are never driven below it',
      '`/fight auto ... practice:true` — the same floor in any auto mode',
      '`/fight addnpc npc:Goblin, Orc` — add one or more NPCs mid-fight',
      '`/fight order sequence:@a, Goblin, @b` — set the turn order, players and NPCs (GM)',
      '`/fight atk stat:str target:@user` — attack a player · add `target_npc:Name` to hit an NPC',
      '`/fight atk stat:str npc:Goblin target:@user` — GM attacks AS an NPC on its turn',
      '`/fight def stat:dex` — defend · GM defends as an NPC with `npc:Name`',
      '`/fight rr` — reroll (costs a token) · `/fight resolve` — resolve a clash',
      '`/fight status` — show current fight · `/fight forfeit` — drop out',
      '`/fight auto mode:Full players:@a npcs:Orc` — bot resolves the whole fight (GM)',
      '`/fight refill npcs:all` — refill NPC reroll tokens to their LCK (GM)',
      '`/fight hp value:N target:@a` / `target_npc:Orc` — set HP mid-fight, sheet synced (GM)',
      '`/fight kick target:@a` / `target_npc:Orc` — remove a fighter, fight continues (GM)',
      '`/fight auto mode:Full teams:@a @b vs Goblin, Orc` — party-vs-monsters sides (GM)',
      'NPC lists accept `category:Name` to add a whole category at once',
      'When a fight ends a public 🏁 result posts in the channel — victor, everyone\'s final HP, and a 📜 recap',
      'The recap covers both players and NPCs: roll averages, best/worst naturals, damage dealt and taken, and a blow-by-blow of every exchange',
      '`/fight log` — re-post the last finished fight\'s recap in this channel',
      '`/fight skip` — skip the current turn; the fighter stays in the fight (GM)',
      '`/fight auto mode:NPCs only ...` — bot plays NPC turns, players play manually (GM)',
      '`/fight auto mode:Demo` — example showcase fight · `/fight end` — end the fight (GM)',
    ],
  },
  npc: {
    title: '🎭 NPCs',
    body: [
      '`/npc create name:X str:N ...` — create an NPC (GM)',
      '`/npc hp name:X value:N` — set an NPC\'s HP · omit value for a full heal (GM)',
      '`/npc heal names:all` · `/npc heal names:Goblin, Orc` — fully heal NPCs (GM)',
      '`/gmheal user:@a` / `npc:all` — restore HP, rerolls or charges, any amount (GM)',
      '`/npc copy name:Goblin new_name:Goblin 2` — duplicate an NPC (GM)',
      '`/npc show name:Goblin` — full stat block for one NPC',
      '`/npc hero name:X stat:str` — make an NPC a Hero with a signature stat (GM)',
      '`/pr say name:X message:...` — speak or act as an NPC, no dice (GM)',
      '`/npc list category:Bandits` — list only one category\'s NPCs',
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
      '`/config gmrole role:@Role` — add a GM role · `remove:true` · `replace:true` · omit to list',
      '_Server admins (Manage Server) always count as GMs._',
      '`/config heal charges:N` — set default heal charges',
      '`/config npcreroll threshold:N` — NPC auto-reroll on nat ≤ N · 0 disables · omit to show',
      '`/config fightping enabled:true` — @-mention players on their turn · off by default (Admin)',
      '`/config rollaudit channel:#x` — mirror all rolls (players + GMs) to a GM-only channel (Admin)',
      '`/config rollaudit test:true` — send a test mirror and report any problem (Admin)',
      '`/config approvals channel:#x` — new sheets need GM approval before use (Admin)',
      '`/config npcstats enabled:true` — reveal NPC stat blocks on roll cards · hidden by default (Admin)',
      '`/config npcchannel #channel` — set the NPC avatar channel',
      '`/config rest type:Short Rest hp:50% rerolls:0%` — tune what a rest restores (use % of max or a flat number)',
      '`/config cleanwebhooks` — remove orphaned NPC webhooks',
      '`gmr` / `gmrs 1d20+5` — public / secret GM roll',
      '`/backup now` — export the database · `/backup auto` — daily backups',
      '`/stat` — show stat descriptions · `/help` — this menu',
    ],
  },
  progression: {
    title: '🎖️ Merits & Ranks',
    body: [
      '`/merit view [user]` — see merits, current rank, and how many to the next',
      '`/merit leaderboard` — top earners on the server',
      '`/merit history [user]` — a player\'s merit timeline, or recent server activity',
      '`/merit add @user [amount]` — award merits (GM) · `/merit remove` · `/merit set`',
      '`/rank list` — view ranks and thresholds',
      '`/rank add name:Knight threshold:5` — create/update a rank (GM)',
      '`/rank promote @user rank:Knight` — set a player\'s rank (GM, fully manual)',
      '`/rank eligible` — players who\'ve met a threshold but aren\'t promoted yet (GM)',
      '`/rank remove name:X` — delete a rank (GM)',
      '_Merits are a lifetime tally; promotions are always GM-decided._',
    ],
  },
  quests: {
    title: '📜 Quest Board',
    body: [
      '`/quest board [filter]` — list quests (open / active / completed / all)',
      '`/quest show number:N` — full quest details · `/quest roster number:N` — applicants & party',
      '`/quest apply number:N` — apply to join (or tap **Apply** on the post)',
      '`/quest withdraw number:N` — leave or cancel your application',
      '`/quest log [user]` — completed quests a player was on',
      '`/quest create name:Goblin Cave objectives:... merit_reward:2 party_size:4 hard_cap:true` — (GM)',
      '`/quest post number:N [channel]` — post it as an embed with an Apply button (GM)',
      '`/quest approve number:N @user [force]` — approve an applicant; `force` overrides a hard cap (GM)',
      '`/quest kick number:N @user` — remove a member/applicant (GM)',
      '`/quest runchannel number:N [channel]` — set where the quest runs & rewards (GM)',
      '`/quest start number:N` — lock the party and mark in progress (GM)',
      '`/quest complete number:N` — finish it; merits auto-awarded, other rewards listed (GM)',
      '`/quest delete number:N` — remove a quest (GM)',
    ],
  },
};

// Help categories that document GM-only tooling. Players shouldn't be able to
// browse them — both the listing and the detail view are gated.
const GM_HELP_CATEGORIES = ['gm', 'npc'];

async function handleHelp(interaction) {
  const cat = interaction.options.getString('category');
  const gm = await isGm(interaction.guild, interaction.user.id);

  if (cat && HELP_CATEGORIES[cat]) {
    if (GM_HELP_CATEGORIES.includes(cat) && !gm) {
      return interaction.reply({ content: '❌ That help section covers GM-only commands.', ephemeral: true });
    }
    const c = HELP_CATEGORIES[cat];
    return interaction.reply({ content: `**${c.title}**\n${c.body.join('\n')}`, ephemeral: true });
  }
  // Overview — hide GM sections from players entirely
  const lines = ['**🎲 DDice — Command Help**', '', 'Use `/help category:X` for details on each group.', ''];
  for (const key of Object.keys(HELP_CATEGORIES)) {
    if (GM_HELP_CATEGORIES.includes(key) && !gm) continue;
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
  const last = getLastRoll(gid, interactionChannelId(interaction), uid);
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


// ── /gmheal ───────────────────────────────────────────────────────────────────
// One GM command for restoring resources, on a player or an NPC (or every NPC).
// HP changes go through setFighterHp so any active fight stays in sync.
async function handleGmHeal(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  if (!(await isGm(interaction.guild, uid)))
    return interaction.reply({ content: '❌ Only GMs can use `/gmheal`.', ephemeral: true });

  const targetUser = interaction.options.getUser('user');
  const npcArg = (interaction.options.getString('npc') || '').trim();
  if (!!targetUser === !!npcArg)
    return interaction.reply({ content: '❌ Pick exactly one of `user` or `npc`.', ephemeral: true });

  const amount = interaction.options.getString('amount') || 'full';
  const restore = interaction.options.getString('restore') || 'hp';
  const value = interaction.options.getInteger('value');
  if (['add','sub','exact'].includes(amount) && value === null)
    return interaction.reply({ content: `❌ \`amount:${amount}\` needs a \`value\`.`, ephemeral: true });

  // Work out a new figure from the chosen mode.
  const compute = (cur, max) => {
    if (amount === 'full') return max;
    if (amount === 'half') return Math.ceil(max / 2);
    if (amount === 'add') return Math.min(max, cur + value);
    if (amount === 'sub') return cur - value;           // may go negative — GM's call
    return Math.min(max, value);                        // exact
  };

  // ── NPC(s) ──
  if (npcArg) {
    const targets = npcArg.toLowerCase() === 'all'
      ? getAllNpcs(gid)
      : expandNpcList(gid, npcArg).map(n => getNpc(gid, n)).filter(Boolean);
    if (!targets.length) return interaction.reply({ content: `❌ No NPC matched **${npcArg}**.`, ephemeral: true });
    if (restore !== 'hp' && restore !== 'all')
      return interaction.reply({ content: '❌ NPCs only have HP — use `restore:HP only`.', ephemeral: true });

    const lines = [];
    for (const npc of targets) {
      const max = (npc.con ?? 0) + 2;
      const before = npc.hp_current ?? 0;
      const after = compute(before, max);
      setFighterHp(gid, npcFighterId(npc.name), after); // keeps any live fight in sync
      lines.push(`🎭 **${npc.name}** — ❤️ ${before} → **${after}** / ${max}`);
    }
    return replyLong(interaction, [`✨ Restored ${targets.length} NPC${targets.length === 1 ? '' : 's'}:`, '', ...lines]);
  }

  // ── Player ──
  const ch = getChar(gid, targetUser.id);
  if (!ch) return interaction.reply({ content: `❌ <@${targetUser.id}> has no character sheet yet.`, ephemeral: true });
  const nm = await getDisplayName(interaction.guild, targetUser.id);
  const cfg = getConfig(gid);
  const maxCharges = cfg.heal_charges ?? 3;
  const lines = [];

  if (restore === 'hp' || restore === 'all') {
    const max = maxHp(ch), before = ch.hp_current ?? 0;
    const after = compute(before, max);
    setFighterHp(gid, targetUser.id, after);
    lines.push(`❤️ HP: **${before} → ${after}** / ${max}`);
  }
  if (restore === 'rerolls' || restore === 'all') {
    const max = maxRerolls(ch), before = ch.rerolls_current ?? 0;
    const after = Math.max(0, compute(before, max));
    upsertChar(gid, targetUser.id, { rerolls_current: after });
    lines.push(`🔄 Rerolls: **${before} → ${after}** / ${max}`);
  }
  if (restore === 'charges' || restore === 'all') {
    if (!isWhiteKnight(ch)) {
      lines.push('🛡️ Heal charges: _skipped — not a White Knight with WIS 5+_');
    } else {
      const before = getHealCharges(gid, targetUser.id, maxCharges).current;
      const after = Math.max(0, compute(before, maxCharges));
      setHealCharges(gid, targetUser.id, after);
      lines.push(`🛡️ Heal charges: **${before} → ${after}** / ${maxCharges}`);
    }
  }
  const downed = (getChar(gid, targetUser.id)?.hp_current ?? 0) <= 0;
  if (downed) lines.push('💀 _Still at 0 or less — they\'ll be left out of new fights._');
  return interaction.reply({ content: [`✨ **${nm}** restored:`, '', ...lines].join('\n') });
}

// ── /roll (slash) ─────────────────────────────────────────────────────────────
// Same roll engine and card format as the prefix commands, but every part is a
// dropdown or field so nothing has to be memorised. `stat` and `dice` are
// alternatives; a stat resolves to 1d20+STAT from the caller's sheet.
async function handleRollSlash(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const cid = interactionChannelId(interaction);
  const stat = interaction.options.getString('stat');
  const dice = (interaction.options.getString('dice') || '').trim();
  const mode = interaction.options.getString('mode') || 'normal';
  const successCheck = interaction.options.getBoolean('success_check') ?? false;
  const label = (interaction.options.getString('label') || '').trim() || null;
  const flavour = (interaction.options.getString('flavour') || '').trim() || null;

  if (stat && dice) return interaction.reply({ content: '❌ Pick either a **stat** or custom **dice**, not both.', ephemeral: true });
  if (!stat && !dice) return interaction.reply({ content: '❌ Choose a **stat** or enter **dice** (e.g. `2d6+3`).', ephemeral: true });

  const gateMsg = sheetGate(gid, uid);
  if (gateMsg) return interaction.reply({ content: gateMsg, ephemeral: true });

  const char = getChar(gid, uid);
  let notation;
  if (stat) {
    if (!char) return interaction.reply({ content: '❌ No character sheet found. Use `/char create` first, or roll custom `dice`.', ephemeral: true });
    notation = `1d20+${char[stat] ?? 0}`;
  } else {
    const m = dice.match(/^\d+d\d+(?:[+-]\d+)?$/i);
    if (!m) return interaction.reply({ content: '❌ Invalid notation. Try `1d20`, `1d20+5` or `2d6+3`.', ephemeral: true });
    notation = dice;
  }

  // Hero signature advantage applies to stat rolls
  const effMode = stat ? applySignatureMode(char, stat, mode) : mode;

  let result;
  if (effMode === 'adv') result = rollAdvantage(notation);
  else if (effMode === 'dis') result = rollDisadvantage(notation);
  else result = rollNotation(notation);
  if (!result) return interaction.reply({ content: '❌ Could not parse dice notation.', ephemeral: true });

  const finalLabel = label || (stat ? stat : null);
  saveRoll(gid, cid, uid, notation, finalLabel);
  const critType = detectCrit(result, effMode);
  const naturalRoll = effMode === 'normal' ? result.rolls[0] : result.chosen;
  const successResult = successCheck ? getSuccessResult(result.total, naturalRoll, result.sides) : null;
  const rollLine = buildRollLine(result, effMode, critType, successResult);

  mirrorRoll(gid, { userId: uid, channelId: cid, interaction,
    input: `/roll ${stat ? `stat:${stat}` : `dice:${dice}`}${effMode !== 'normal' ? ` mode:${effMode}` : ''}${successCheck ? ' success_check:true' : ''}`,
    rollLine, context: successCheck ? 'success check' : null });

  if (char?.profile_enabled === 1) {
    const cfg = getConfig(gid);
    const maxCharges = cfg.heal_charges ?? 3;
    const healRow = getHealCharges(gid, uid, maxCharges);
    const displayName = await getDisplayName(interaction.guild, uid);
    const tags = getPlayerTags(gid, uid);
    return interaction.reply({ content: buildRollEmbed({ rollLine, label: finalLabel, isReroll: false,
      char: { ...char, displayName }, healCharges: healRow.current, maxCharges, flavour,
      total: result.total, critType, tags, gid }) });
  }
  return interaction.reply({ content: buildPlainRoll({ rollLine, label: finalLabel, isReroll: false, flavour, total: result.total, critType }) });
}

// ── MERIT ─────────────────────────────────────────────────────────────────────
async function handleMerit(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'view') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const merits = getMerits(gid, target.id);
    const ch = getChar(gid, target.id);
    const { current, next } = rankProgress(gid, merits);
    const name = await getDisplayName(interaction.guild, target.id);
    const heldRank = ch?.rank_name;
    const lines = [`🎖️ **${name}** — **${merits}** merit${merits === 1 ? '' : 's'}`];
    if (heldRank) lines.push(`🏅 Current rank: **${heldRank}**`);
    if (current && current.name !== heldRank) lines.push(`✅ Eligible for: **${current.name}** (needs ${current.threshold})`);
    if (next) {
      const togo = next.threshold - merits;
      lines.push(`📈 Next rank: **${next.name}** — **${togo}** more merit${togo === 1 ? '' : 's'} (at ${next.threshold})`);
    } else if (current) {
      lines.push('🏔️ Highest rank threshold reached.');
    }
    if (!current && !next) lines.push('_No ranks defined yet — a GM can add them with `/rank add`._');
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'leaderboard') {
    const rows = db.prepare('SELECT user_id, merits FROM characters WHERE guild_id=? AND merits > 0 ORDER BY merits DESC LIMIT 15').all(gid);
    if (!rows.length) return interaction.reply({ content: '📋 No merits awarded yet.', ephemeral: true });
    const medals = ['🥇','🥈','🥉'];
    const lines = ['🏆 **Merit Leaderboard**', ''];
    for (let i = 0; i < rows.length; i++) {
      const nm = await getDisplayName(interaction.guild, rows[i].user_id);
      const ch = getChar(gid, rows[i].user_id);
      const rankTag = ch?.rank_name ? ` · ${ch.rank_name}` : '';
      lines.push(`${medals[i] ?? `**${i+1}.**`} ${nm} — **${rows[i].merits}**${rankTag}`);
    }
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'history') {
    const target = interaction.options.getUser('user');
    const nameCache = new Map();
    if (target) {
      const rows = getMeritHistory(gid, target.id, 20);
      if (!rows.length) return interaction.reply({ content: `📋 No merit history for **${await getDisplayName(interaction.guild, target.id)}** yet.`, ephemeral: true });
      const nm = await getDisplayNameCached(interaction.guild, target.id, nameCache);
      const lines = [`🎖️ **${nm}** — merit history (latest ${rows.length})`, ''];
      for (const r of rows) {
        const sign = (r.amount ?? 0) >= 0 ? `+${r.amount}` : `${r.amount}`;
        lines.push(`**${sign}** — ${r.reason ?? '—'} · ${formatHistDate(r.created_at)}`);
      }
      return replyLong(interaction, lines);
    }
    const rows = getRecentMeritHistory(gid, 20);
    if (!rows.length) return interaction.reply({ content: '📋 No merit activity recorded yet.', ephemeral: true });
    const lines = ['🎖️ **Recent merit activity**', ''];
    for (const r of rows) {
      const nm = await getDisplayNameCached(interaction.guild, r.user_id, nameCache);
      const sign = (r.amount ?? 0) >= 0 ? `+${r.amount}` : `${r.amount}`;
      lines.push(`**${sign}** ${nm} — ${r.reason ?? '—'} · ${formatHistDate(r.created_at)}`);
    }
    return replyLong(interaction, lines);
  }

  // add / remove / set are GM-only
  if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can change merits.', ephemeral: true });
  const target = interaction.options.getUser('user');
  const name = await getDisplayName(interaction.guild, target.id);

  if (sub === 'add' || sub === 'remove') {
    const amt = interaction.options.getInteger('amount') ?? 1;
    const before = getMerits(gid, target.id);
    const after = addMerits(gid, target.id, sub === 'add' ? amt : -amt);
    logHistory(gid, { kind: 'merit', userId: target.id, amount: after - before, reason: 'manual by GM', actorId: uid });
    const { current, next } = rankProgress(gid, after);
    const ch = getChar(gid, target.id);
    const lines = [`🎖️ **${name}**: ${before} → **${after}** merit${after === 1 ? '' : 's'} (${sub === 'add' ? '+' : '−'}${amt}).`];
    if (sub === 'add' && current && current.name !== ch?.rank_name) {
      lines.push(`✅ Now eligible for **${current.name}** — promote with \`/rank promote\`.`);
    } else if (next) {
      const togo = next.threshold - after;
      if (togo > 0) lines.push(`📈 ${togo} more to **${next.name}**.`);
    }
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'set') {
    const amt = interaction.options.getInteger('amount');
    const before = getMerits(gid, target.id);
    upsertChar(gid, target.id, { merits: amt });
    logHistory(gid, { kind: 'merit', userId: target.id, amount: amt - before, reason: `set to ${amt} by GM`, actorId: uid });
    const { current, next } = rankProgress(gid, amt);
    const lines = [`🎖️ **${name}** merits set to **${amt}**.`];
    if (current) lines.push(`✅ Eligible for **${current.name}**.`);
    if (next) lines.push(`📈 ${next.threshold - amt} more to **${next.name}**.`);
    return interaction.reply({ content: lines.join('\n') });
  }
}

// ── RANK ──────────────────────────────────────────────────────────────────────
async function handleRank(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'list') {
    const ranks = getRanks(gid);
    if (!ranks.length) return interaction.reply({ content: '📋 No ranks defined. A GM can add them with `/rank add`.', ephemeral: true });
    const lines = ['🏅 **Ranks** (junior → senior)', ''];
    ranks.forEach((r, i) => lines.push(`**${i+1}. ${r.name}** — ${r.threshold} merit${r.threshold === 1 ? '' : 's'}`));
    return replyLong(interaction, lines);
  }

  // everything else GM-only
  if (!(await isGm(interaction.guild, uid))) return interaction.reply({ content: '❌ Only GMs can manage ranks.', ephemeral: true });

  if (sub === 'add') {
    const name = interaction.options.getString('name').trim();
    if (!name || name.length > 50) return interaction.reply({ content: '❌ Rank name must be 1–50 characters.', ephemeral: true });
    const threshold = interaction.options.getInteger('threshold');
    const order = interaction.options.getInteger('order') ?? threshold;
    const existed = getRanks(gid).some(r => r.name.toLowerCase() === name.toLowerCase());
    setRank(gid, name, threshold, order);
    return interaction.reply({ content: `🏅 Rank **${name}** ${existed ? 'updated' : 'created'} — threshold **${threshold}** merit${threshold === 1 ? '' : 's'}.` });
  }

  if (sub === 'remove') {
    const name = interaction.options.getString('name');
    const removed = removeRank(gid, name);
    if (!removed) return interaction.reply({ content: `❌ No rank named **${name}**.`, ephemeral: true });
    return interaction.reply({ content: `🗑️ Rank **${name}** removed. (Players keeping this rank label aren't changed.)` });
  }

  if (sub === 'promote') {
    const target = interaction.options.getUser('user');
    const rankName = interaction.options.getString('rank');
    const ranks = getRanks(gid);
    const rank = ranks.find(r => r.name.toLowerCase() === rankName.toLowerCase());
    if (!rank) return interaction.reply({ content: `❌ No rank named **${rankName}**. See \`/rank list\`.`, ephemeral: true });
    upsertChar(gid, target.id, { rank_name: rank.name });
    const name = await getDisplayName(interaction.guild, target.id);
    const merits = getMerits(gid, target.id);
    const note = merits < rank.threshold ? ` _(note: they have ${merits}/${rank.threshold} merits)_` : '';
    return interaction.reply({ content: `🎉 **${name}** is now **${rank.name}**!${note}` });
  }

  if (sub === 'eligible') {
    const ranks = getRanks(gid);
    if (!ranks.length) return interaction.reply({ content: '📋 No ranks defined yet.', ephemeral: true });
    const chars = db.prepare('SELECT user_id, merits, rank_name FROM characters WHERE guild_id=? AND merits > 0').all(gid);
    const out = [];
    for (const c of chars) {
      const { current } = rankProgress(gid, c.merits);
      if (current && current.name !== c.rank_name) {
        const nm = await getDisplayName(interaction.guild, c.user_id);
        out.push(`• **${nm}** — ${c.merits} merits → eligible for **${current.name}**${c.rank_name ? ` (currently ${c.rank_name})` : ''}`);
      }
    }
    if (!out.length) return interaction.reply({ content: '✅ No one is awaiting a promotion right now.', ephemeral: true });
    return replyLong(interaction, ['📋 **Awaiting promotion:**', '', ...out]);
  }
}


// Compose an NPC's post from an optional action and an optional speech line.
// Action is italicised, speech is wrapped in quote marks (unless the writer
// already quoted it), and both together stack on separate lines.
function composeNpcSay({ action, speech, raw }) {
  if (raw && raw.trim()) return raw.trim();
  const parts = [];
  const act = (action || '').trim();
  const say = (speech || '').trim();
  if (act) parts.push(`*${act}*`);
  if (say) {
    const alreadyQuoted = /^["\u201c][\s\S]*["\u201d]$/.test(say);
    parts.push(alreadyQuoted ? say : `"${say}"`);
  }
  return parts.join('\n');
}

// ── QUEST helpers (rendering + routing) ───────────────────────────────────────
function questStatusBadge(status) {
  return status === 'open' ? '🟢 Open' : status === 'active' ? '🟡 In progress' : status === 'completed' ? '🔵 Completed' : status;
}

// Build the full text block for a quest (used by post/show).
async function renderQuest(guild, quest) {
  const gid = guild.id;
  const party = getQuestMembers(gid, quest.number, 'party');
  const applied = getQuestMembers(gid, quest.number, 'applied');
  const lines = [];
  lines.push(`📜 **${questTag(quest)}**`);
  lines.push(`${questStatusBadge(quest.status)}`);
  lines.push('─────────────────────────────');
  if (quest.lore) lines.push(`📖 *${quest.lore}*\n`);
  if (quest.objectives) lines.push(`🎯 **Objectives**\n${quest.objectives}\n`);
  if (quest.details) lines.push(`📋 **Details**\n${quest.details}\n`);

  const rewardBits = [];
  if (quest.merit_reward > 0) rewardBits.push(`🎖️ **${quest.merit_reward}** merit${quest.merit_reward === 1 ? '' : 's'} each (auto-awarded)`);
  if (quest.rewards) rewardBits.push(`🎁 ${quest.rewards}`);
  if (rewardBits.length) lines.push(`**Rewards**\n${rewardBits.join('\n')}\n`);

  if (quest.party_size) {
    const kind = quest.party_hard ? 'cap' : 'suggested';
    lines.push(`👥 Party: **${party.length}/${quest.party_size}** (${kind})`);
  } else {
    lines.push(`👥 Party: **${party.length}**`);
  }

  if (party.length) {
    const names = [];
    for (const id of party) names.push(`✅ ${await getDisplayName(guild, id)}`);
    lines.push(names.join('  '));
  }
  if (applied.length && quest.status === 'open') {
    const names = [];
    for (const id of applied) names.push(`⏳ ${await getDisplayName(guild, id)}`);
    lines.push(`Applicants: ${names.join('  ')}`);
  }
  if (quest.run_channel_id) lines.push(`\n📍 Runs in <#${quest.run_channel_id}>`);
  if (quest.status === 'open') lines.push(`\n_Apply with the button below or_ \`/quest apply number:${quest.number}\``);
  return lines.join('\n');
}

function questApplyButton(number) {
  const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`questapply:${number}`).setLabel('Apply to Quest').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`questwithdraw:${number}`).setLabel('Withdraw').setStyle(ButtonStyle.Secondary),
  );
}

// Refresh a quest's posted message in place, if one exists.
async function refreshQuestPost(client, guild, quest) {
  if (!quest.post_channel_id || !quest.post_message_id) return;
  try {
    const ch = await client.channels.fetch(quest.post_channel_id);
    const msg = await ch.messages.fetch(quest.post_message_id);
    const components = quest.status === 'open' ? [questApplyButton(quest.number)] : [];
    await msg.edit({ content: await renderQuest(guild, quest), components });
  } catch { /* message deleted or inaccessible — ignore */ }
}

// Shared apply logic for both the slash command and the button.
async function questApply(guild, quest, uid) {
  const gid = guild.id;
  if (quest.status !== 'open') return { error: '❌ This quest isn\'t open for applications.' };
  const members = getQuestMembers(gid, quest.number);
  const mine = members.find(m => m.user_id === uid);
  if (mine?.state === 'party') return { error: 'You\'re already on this quest\'s party.' };
  if (mine?.state === 'applied') return { error: 'You\'ve already applied — hang tight for the GM.' };
  setQuestMember(gid, quest.number, uid, 'applied');
  return { ok: `⏳ Applied to **${questTag(quest)}**. A GM will review.` };
}
async function questWithdraw(guild, quest, uid) {
  const gid = guild.id;
  const removed = removeQuestMember(gid, quest.number, uid);
  if (!removed) return { error: 'You\'re not on this quest.' };
  return { ok: `↩️ Withdrawn from **${questTag(quest)}**.` };
}

// ── QUEST command ─────────────────────────────────────────────────────────────
async function handleQuest(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  const gm = await isGm(interaction.guild, uid);

  // Player-facing reads first
  if (sub === 'board') {
    const filter = interaction.options.getString('filter') ?? 'open';
    const quests = filter === 'all' ? listQuests(gid) : listQuests(gid, filter);
    if (!quests.length) return interaction.reply({ content: `📋 No ${filter === 'all' ? '' : filter + ' '}quests on the board.`, ephemeral: true });
    const lines = [`📜 **Quest Board** — ${filter === 'all' ? 'all quests' : filter}`, ''];
    for (const q of quests) {
      const party = getQuestMembers(gid, q.number, 'party').length;
      const cap = q.party_size ? `${party}/${q.party_size}${q.party_hard ? '' : '~'}` : `${party}`;
      const merit = q.merit_reward > 0 ? ` · 🎖️${q.merit_reward}` : '';
      lines.push(`${questStatusBadge(q.status)} **${questTag(q)}** — 👥 ${cap}${merit}`);
    }
    lines.push('', '_Use_ `/quest show number:N` _for full details._');
    return replyLong(interaction, lines);
  }

  if (sub === 'show' || sub === 'roster') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    if (sub === 'show') return interaction.reply({ content: await renderQuest(interaction.guild, quest) });
    // roster
    const party = getQuestMembers(gid, number, 'party');
    const applied = getQuestMembers(gid, number, 'applied');
    const lines = [`👥 **${questTag(quest)}** — roster`, ''];
    if (party.length) {
      lines.push('**Party:**');
      for (const id of party) lines.push(`✅ ${await getDisplayName(interaction.guild, id)}`);
    } else lines.push('_No party members yet._');
    if (applied.length) {
      lines.push('', '**Applicants:**');
      for (const id of applied) lines.push(`⏳ ${await getDisplayName(interaction.guild, id)}`);
    }
    return interaction.reply({ content: lines.join('\n') });
  }

  if (sub === 'apply' || sub === 'withdraw') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    const res = sub === 'apply' ? await questApply(interaction.guild, quest, uid) : await questWithdraw(interaction.guild, quest, uid);
    if (res.error) return interaction.reply({ content: res.error, ephemeral: true });
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
    return interaction.reply({ content: res.ok, ephemeral: true });
  }

  if (sub === 'log') {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const done = getPlayerCompletedQuests(gid, target.id);
    const nm = await getDisplayName(interaction.guild, target.id);
    if (!done.length) return interaction.reply({ content: `📋 **${nm}** hasn't completed any quests yet.`, ephemeral: true });
    const totalMerits = done.reduce((a, q) => a + (q.merit_reward ?? 0), 0);
    const lines = [`📜 **${nm}** — ${done.length} completed quest${done.length === 1 ? '' : 's'}${totalMerits ? ` · 🎖️ ${totalMerits} earned from quests` : ''}`, ''];
    for (const q of done) {
      const merit = q.merit_reward > 0 ? ` · 🎖️${q.merit_reward}` : '';
      lines.push(`🔵 **${questTag(q)}**${merit}`);
    }
    return replyLong(interaction, lines);
  }

  // ── GM-only from here ──
  if (!gm) return interaction.reply({ content: '❌ Only GMs can manage quests.', ephemeral: true });

  if (sub === 'create') {
    const name = interaction.options.getString('name').trim();
    if (!name || name.length > 80) return interaction.reply({ content: '❌ Quest name must be 1–80 characters.', ephemeral: true });
    const number = createQuest(gid, {
      name,
      objectives: interaction.options.getString('objectives'),
      lore: interaction.options.getString('lore'),
      details: interaction.options.getString('details'),
      rewards: interaction.options.getString('rewards'),
      merit_reward: interaction.options.getInteger('merit_reward') ?? 0,
      party_size: interaction.options.getInteger('party_size'),
      party_hard: interaction.options.getBoolean('hard_cap') ?? false,
      created_by: uid,
    });
    const quest = getQuest(gid, number);
    return interaction.reply({ content: `✅ Created **${questTag(quest)}**.\n\n${await renderQuest(interaction.guild, quest)}\n\n_Post it with_ \`/quest post number:${number}\`_._` });
  }

  if (sub === 'post') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    const channel = interaction.options.getChannel('channel') ?? await interactionChannel(interaction);
    if (!channel) return interaction.reply({ content: '❌ I can\'t access that channel. Pick one explicitly with `channel:`.', ephemeral: true });
    if (!channel.isTextBased?.() && !channel.isThread?.()) return interaction.reply({ content: '❌ Pick a text channel or thread.', ephemeral: true });
    const components = quest.status === 'open' ? [questApplyButton(number)] : [];
    const msg = await channel.send({ content: await renderQuest(interaction.guild, quest), components });
    updateQuest(gid, number, { post_channel_id: channel.id, post_message_id: msg.id });
    return interaction.reply({ content: `📌 Posted **${questTag(quest)}** to <#${channel.id}>.`, ephemeral: true });
  }

  if (sub === 'runchannel') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    const channel = interaction.options.getChannel('channel') ?? await interactionChannel(interaction);
    if (!channel) return interaction.reply({ content: '❌ I can\'t access that channel. Pick one explicitly with `channel:`.', ephemeral: true });
    updateQuest(gid, number, { run_channel_id: channel.id });
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
    return interaction.reply({ content: `📍 **${questTag(quest)}** will be run and rewarded in <#${channel.id}>.` });
  }

  if (sub === 'approve') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    const target = interaction.options.getUser('user');
    const force = interaction.options.getBoolean('force') ?? false;
    const party = getQuestMembers(gid, number, 'party');
    if (party.includes(target.id)) return interaction.reply({ content: 'They\'re already on the party.', ephemeral: true });
    if (quest.party_size && quest.party_hard && party.length >= quest.party_size && !force) {
      return interaction.reply({ content: `❌ Party is at the hard cap (${quest.party_size}). Re-run with \`force:true\` to override.`, ephemeral: true });
    }
    setQuestMember(gid, number, target.id, 'party');
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
    const nm = await getDisplayName(interaction.guild, target.id);
    const over = quest.party_size && party.length + 1 > quest.party_size ? ' (over suggested size)' : '';
    return interaction.reply({ content: `✅ **${nm}** added to **${questTag(quest)}**${over}.` });
  }

  if (sub === 'kick') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    const target = interaction.options.getUser('user');
    const removed = removeQuestMember(gid, number, target.id);
    if (!removed) return interaction.reply({ content: 'They\'re not on this quest.', ephemeral: true });
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
    const nm = await getDisplayName(interaction.guild, target.id);
    return interaction.reply({ content: `👢 Removed **${nm}** from **${questTag(quest)}**.` });
  }

  if (sub === 'start') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    if (quest.status === 'completed') return interaction.reply({ content: '❌ That quest is already completed.', ephemeral: true });
    const party = getQuestMembers(gid, number, 'party');
    if (!party.length) return interaction.reply({ content: '❌ No party members yet — approve applicants first.', ephemeral: true });
    updateQuest(gid, number, { status: 'active' });
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
    return interaction.reply({ content: `🟡 **${questTag(quest)}** is now in progress with ${party.length} member${party.length === 1 ? '' : 's'}. Applications are closed.` });
  }

  if (sub === 'complete') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    if (quest.status === 'completed') return interaction.reply({ content: '❌ That quest is already completed.', ephemeral: true });
    const party = getQuestMembers(gid, number, 'party');
    if (!party.length) return interaction.reply({ content: '❌ No party members to reward. Approve applicants first.', ephemeral: true });

    // This does several network round-trips (name lookups, post refresh, optional
    // cross-channel announce) — defer so we never miss Discord's 3s ack window.
    await interaction.deferReply();
    const nameCache = new Map();

    // Auto-award merits to each party member
    const awarded = [];
    for (const id of party) {
      const after = quest.merit_reward > 0 ? addMerits(gid, id, quest.merit_reward) : getMerits(gid, id);
      if (quest.merit_reward > 0) {
        logHistory(gid, { kind: 'merit', userId: id, amount: quest.merit_reward, reason: questTag(quest), questNumber: quest.number, actorId: uid });
      }
      awarded.push({ id, after });
    }
    updateQuest(gid, number, { status: 'completed' });
    await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));

    const lines = [`🎉 **${questTag(quest)}** complete!`, ''];
    if (quest.merit_reward > 0) {
      lines.push(`🎖️ **+${quest.merit_reward}** merit${quest.merit_reward === 1 ? '' : 's'} awarded to:`);
      for (const a of awarded) {
        const nm = await getDisplayNameCached(interaction.guild, a.id, nameCache);
        const { current } = rankProgress(gid, a.after);
        const ch = getChar(gid, a.id);
        const elig = current && current.name !== ch?.rank_name ? ` ✅ eligible for **${current.name}**` : '';
        lines.push(`• ${nm} — now **${a.after}**${elig}`);
      }
    } else {
      lines.push('_No merit reward set for this quest._');
    }
    if (quest.rewards) {
      const partyNames = [];
      for (const id of party) partyNames.push(await getDisplayNameCached(interaction.guild, id, nameCache));
      lines.push('', `🎁 **GM to distribute:** ${quest.rewards}`);
      lines.push(`Party: ${partyNames.join(', ')}`);
    }

    // Announce in the designated run channel if set and different from here
    const announce = lines.join('\n');
    if (quest.run_channel_id && quest.run_channel_id !== interactionChannelId(interaction)) {
      try { const rc = await interaction.client.channels.fetch(quest.run_channel_id); await rc.send(announce); } catch {}
      return interaction.editReply({ content: `${announce}\n\n_(Also posted in <#${quest.run_channel_id}>.)_` });
    }
    return interaction.editReply({ content: announce });
  }

  if (sub === 'delete') {
    const number = interaction.options.getInteger('number');
    const quest = getQuest(gid, number);
    if (!quest) return interaction.reply({ content: `❌ No quest #${String(number).padStart(3,'0')}.`, ephemeral: true });
    return requestConfirm(interaction, `Delete **${questTag(quest)}** permanently? This clears its roster and removes it from the board.`, async () => {
      // Best-effort: strip buttons from the posted message
      if (quest.post_channel_id && quest.post_message_id) {
        try { const ch = await interaction.client.channels.fetch(quest.post_channel_id); const m = await ch.messages.fetch(quest.post_message_id); await m.edit({ content: `~~${questTag(quest)}~~ _(deleted)_`, components: [] }); } catch {}
      }
      deleteQuest(gid, number);
      return `🗑️ **${questTag(quest)}** deleted.`;
    });
  }
}

// Ask for confirmation. `action` is an async fn run if confirmed.
async function requestConfirm(interaction, promptText, action) {
  const token = `${interaction.user.id}_${Date.now()}_${Math.floor(Math.random()*1000)}`;
  pendingConfirms.set(token, { action, userId: interaction.user.id, expires: Date.now() + 60000 });
  // Auto-expire after 60s
  setTimeout(() => pendingConfirms.delete(token), 60000);
  await interaction.reply({ content: `⚠️ ${promptText}`, components: [makeConfirmButtons(token)], ephemeral: true });
}

async function handleSheetApprovalButton(interaction) {
  const gid = interaction.guild.id;
  if (!(await isGm(interaction.guild, interaction.user.id)))
    return interaction.reply({ content: '❌ Only GMs can approve sheets.', ephemeral: true });
  const [action, uid] = interaction.customId.split(':');
  const ch = getChar(gid, uid);
  if (!ch) return interaction.reply({ content: '❌ That character sheet no longer exists.', ephemeral: true });
  const nm = await getDisplayName(interaction.guild, uid);
  const gmName = await getDisplayName(interaction.guild, interaction.user.id);
  const approved = action === 'sheetok';
  upsertChar(gid, uid, { approval_state: approved ? 'approved' : 'rejected' });

  // Update the request post so the queue reflects the decision
  try {
    await interaction.message.edit({
      content: `${interaction.message.content}\n\n${approved ? '✅' : '🚫'} **${approved ? 'Approved' : 'Rejected'}** by ${gmName}`,
      components: [],
    });
  } catch {}

  // Let the player know — the GM's reply lands in a channel they can't see.
  // Try a DM first, then fall back to the channel they submitted from.
  const notice = approved
    ? `✅ **Your character sheet was approved** by ${gmName} in **${interaction.guild.name}** — you can roll and fight now.`
    : `🚫 **Your character sheet was rejected** by ${gmName} in **${interaction.guild.name}**. Speak to a GM; they'll need to adjust it for you.`;
  let told = 'DM';
  try {
    const user = await interaction.client.users.fetch(uid);
    await user.send(notice);
  } catch {
    told = null;
    const srcId = getChar(gid, uid)?.approval_src_channel;
    if (srcId) {
      try {
        const srcChan = await interaction.client.channels.fetch(srcId);
        await srcChan.send({ content: `<@${uid}> ${notice}`, allowedMentions: { users: [uid] } });
        told = 'channel';
      } catch {}
    }
  }

  const delivery = told === 'DM' ? ' _(player notified by DM)_'
                 : told === 'channel' ? ' _(DM blocked — notified in their submission channel)_'
                 : ' ⚠️ _couldn\'t reach the player — tell them directly._';
  return interaction.reply({ content: (approved
    ? `✅ <@${uid}> (**${nm}**) approved — they can roll and fight now.`
    : `🚫 <@${uid}> (**${nm}**) rejected — they'll need a GM to adjust the sheet.`) + delivery,
    allowedMentions: { parse: [] } });
}

// Submission from the /pr say writing box.
async function handleNpcSayModal(interaction) {
  const gid = interaction.guild.id;
  if (!(await isGm(interaction.guild, interaction.user.id)))
    return interaction.reply({ content: '❌ Only GMs can post as NPCs.', ephemeral: true });
  const npcName = interaction.customId.slice('npcsay:'.length);
  const npc = getNpc(gid, npcName);
  if (!npc) return interaction.reply({ content: `❌ NPC **${npcName}** no longer exists.`, ephemeral: true });

  const action = interaction.fields.getTextInputValue('action');
  const speech = interaction.fields.getTextInputValue('speech');
  const body = composeNpcSay({ action, speech });
  if (!body) return interaction.reply({ content: '❌ Both boxes were empty — nothing posted.', ephemeral: true });
  if (body.length > 1800) return interaction.reply({ content: '❌ Too long (max 1800 characters).', ephemeral: true });

  const chan = await interactionChannel(interaction);
  if (!chan) return interaction.reply({ content: '❌ I can\'t access this channel.', ephemeral: true });
  await postAsNpc(chan, gid, npc.name, body);
  return interaction.reply({ content: `🎭 Posted as **${npc.name}**.`, ephemeral: true });
}

async function handleQuestButton(interaction) {
  const gid = interaction.guild.id, uid = interaction.user.id;
  const [action, numStr] = interaction.customId.split(':');
  const number = parseInt(numStr, 10);
  const quest = getQuest(gid, number);
  if (!quest) return interaction.reply({ content: '\u274c That quest no longer exists.', ephemeral: true });
  const res = action === 'questapply'
    ? await questApply(interaction.guild, quest, uid)
    : await questWithdraw(interaction.guild, quest, uid);
  if (res.error) return interaction.reply({ content: res.error, ephemeral: true });
  await refreshQuestPost(interaction.client, interaction.guild, getQuest(gid, number));
  return interaction.reply({ content: res.ok, ephemeral: true });
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
