// ============================================================
//  TTRPG Discord Bot — single file edition
//  Requires: discord.js, better-sqlite3, dotenv
// ============================================================

require('dotenv').config();
const { Client, GatewayIntentBits, Collection, SlashCommandBuilder, PermissionFlagsBits, REST, Routes } = require('discord.js');
const Database = require('better-sqlite3');
const path = require('path');

// ─────────────────────────────────────────────
//  DATABASE
// ─────────────────────────────────────────────

const db = new Database(path.join(__dirname, 'ttrpg.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS characters (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    order_name TEXT DEFAULT NULL,
    str INTEGER DEFAULT 0,
    con INTEGER DEFAULT 0,
    dex INTEGER DEFAULT 0,
    wis INTEGER DEFAULT 0,
    lck INTEGER DEFAULT 0,
    hp_current INTEGER DEFAULT 0,
    rerolls_current INTEGER DEFAULT 0,
    profile_enabled INTEGER DEFAULT 1,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS profile_saves (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    slot_name TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, user_id, slot_name)
  );
  CREATE TABLE IF NOT EXISTS roll_history (
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    notation TEXT NOT NULL,
    label TEXT DEFAULT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS guild_config (
    guild_id TEXT PRIMARY KEY,
    gm_role_id TEXT DEFAULT NULL,
    heal_charges INTEGER DEFAULT 3
  );
  CREATE TABLE IF NOT EXISTS heal_charges (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    current INTEGER DEFAULT 3,
    PRIMARY KEY (guild_id, user_id)
  );
`);

function getChar(guildId, userId) {
  return db.prepare('SELECT * FROM characters WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

function upsertChar(guildId, userId, fields) {
  const existing = getChar(guildId, userId);
  if (!existing) {
    db.prepare(`INSERT INTO characters (guild_id, user_id, order_name, str, con, dex, wis, lck, hp_current, rerolls_current, profile_enabled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(guildId, userId, fields.order_name ?? null,
        fields.str ?? 0, fields.con ?? 0, fields.dex ?? 0, fields.wis ?? 0, fields.lck ?? 0,
        fields.hp_current ?? 0, fields.rerolls_current ?? 0, fields.profile_enabled ?? 1);
  } else {
    const updates = Object.entries(fields).map(([k]) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE characters SET ${updates} WHERE guild_id = ? AND user_id = ?`)
      .run(...Object.values(fields), guildId, userId);
  }
  return getChar(guildId, userId);
}

function setStatAndDerive(guildId, userId, stat, value) {
  let char = getChar(guildId, userId);
  if (!char) { upsertChar(guildId, userId, {}); char = getChar(guildId, userId); }
  const updates = { [stat]: value };
  if (stat === 'con') updates.hp_current = value + 2;
  if (stat === 'lck') updates.rerolls_current = value;
  upsertChar(guildId, userId, updates);
  return getChar(guildId, userId);
}

function saveRoll(guildId, channelId, userId, notation, label) {
  db.prepare(`INSERT OR REPLACE INTO roll_history (guild_id, channel_id, user_id, notation, label, saved_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))`).run(guildId, channelId, userId, notation, label ?? null);
}

function getLastRoll(guildId, channelId, userId) {
  return db.prepare('SELECT * FROM roll_history WHERE guild_id = ? AND channel_id = ? AND user_id = ?').get(guildId, channelId, userId);
}

function getConfig(guildId) {
  let config = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
  if (!config) { db.prepare('INSERT INTO guild_config (guild_id) VALUES (?)').run(guildId); config = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId); }
  return config;
}

function setConfig(guildId, fields) {
  getConfig(guildId);
  const updates = Object.entries(fields).map(([k]) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE guild_config SET ${updates} WHERE guild_id = ?`).run(...Object.values(fields), guildId);
}

function getHealCharges(guildId, userId, maxCharges) {
  let row = db.prepare('SELECT * FROM heal_charges WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!row) { db.prepare('INSERT INTO heal_charges (guild_id, user_id, current) VALUES (?, ?, ?)').run(guildId, userId, maxCharges); row = db.prepare('SELECT * FROM heal_charges WHERE guild_id = ? AND user_id = ?').get(guildId, userId); }
  return row;
}

function setHealCharges(guildId, userId, current) {
  db.prepare('INSERT OR REPLACE INTO heal_charges (guild_id, user_id, current) VALUES (?, ?, ?)').run(guildId, userId, current);
}

function saveProfile(guildId, userId, slotName, snapshot) {
  db.prepare(`INSERT OR REPLACE INTO profile_saves (guild_id, user_id, slot_name, snapshot, saved_at)
    VALUES (?, ?, ?, ?, datetime('now'))`).run(guildId, userId, slotName, JSON.stringify(snapshot));
}

function loadProfile(guildId, userId, slotName) {
  const row = db.prepare('SELECT * FROM profile_saves WHERE guild_id = ? AND user_id = ? AND slot_name = ?').get(guildId, userId, slotName);
  return row ? JSON.parse(row.snapshot) : null;
}

function listProfiles(guildId, userId) {
  return db.prepare('SELECT slot_name, saved_at FROM profile_saves WHERE guild_id = ? AND user_id = ? ORDER BY saved_at DESC').all(guildId, userId);
}

function maxHp(char) { return (char?.con ?? 0) + 2; }
function maxRerolls(char) { return char?.lck ?? 0; }
function isWhiteKnight(char) { return char?.order_name === 'White Knight' && char?.wis >= 5; }

// ─────────────────────────────────────────────
//  DICE
// ─────────────────────────────────────────────

function parseNotation(notation) {
  const match = notation.trim().match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!match) return null;
  return { dice: parseInt(match[1]), sides: parseInt(match[2]), modifier: match[3] ? parseInt(match[3]) : 0 };
}

function rollDie(sides) { return Math.floor(Math.random() * sides) + 1; }

function rollNotation(notation) {
  const parsed = parseNotation(notation);
  if (!parsed) return null;
  const { dice, sides, modifier } = parsed;
  const rolls = Array.from({ length: dice }, () => rollDie(sides));
  const sum = rolls.reduce((a, b) => a + b, 0);
  return { dice, sides, modifier, rolls, sum, total: sum + modifier, notation };
}

function rollAdvantage(notation) {
  const parsed = parseNotation(notation);
  if (!parsed) return null;
  const { sides, modifier } = parsed;
  const r1 = rollDie(sides), r2 = rollDie(sides);
  const chosen = Math.max(r1, r2), dropped = Math.min(r1, r2);
  return { chosen, dropped, rolls: [r1, r2], modifier, total: chosen + modifier, natural: chosen, notation };
}

function rollDisadvantage(notation) {
  const parsed = parseNotation(notation);
  if (!parsed) return null;
  const { sides, modifier } = parsed;
  const r1 = rollDie(sides), r2 = rollDie(sides);
  const chosen = Math.min(r1, r2), dropped = Math.max(r1, r2);
  return { chosen, dropped, rolls: [r1, r2], modifier, total: chosen + modifier, natural: chosen, notation };
}

// ─────────────────────────────────────────────
//  EMBED BUILDER
// ─────────────────────────────────────────────

const KNIGHT_EMOJIS = {
  'White Knight': '⚪', 'Black Knight': '⚫', 'Gold Knight': '🟡',
  'Grey Knight': '🩶', 'Blue Knight': '🔵', 'Purple Knight': '🟣',
  'Green Knight': '🟢', 'Red Knight': '🔴',
};

function pad(val, width = 10) {
  const str = String(val ?? 0);
  return ' '.repeat(Math.max(1, width - str.length)) + str;
}

function buildRollLine(result, mode = 'normal') {
  const { notation, modifier } = result;
  const modStr = modifier > 0 ? ` +${modifier}` : modifier < 0 ? ` ${modifier}` : '';
  if (mode === 'normal') {
    return `🎲  ${notation} → [${result.rolls.join(', ')}]${modStr} = **${result.total}**`;
  }
  const modeLabel = mode === 'adv' ? '(advantage)' : '(disadvantage)';
  return `🎲  ${notation} ${modeLabel} → [${result.chosen}, ${result.dropped}]${modStr} = **${result.total}**`;
}

function buildRollEmbed({ rollLine, label, isReroll, char, healCharges, maxCharges }) {
  const lines = [];
  if (label) lines.push(`**${label}**${isReroll ? ' *(reroll)*' : ''}`);
  else if (isReroll) lines.push('*(reroll)*');
  lines.push(rollLine);
  lines.push('');
  lines.push('─────────────────────────────');
  lines.push(`⚔️  ${char.displayName}`);
  if (char.order_name) lines.push(`${KNIGHT_EMOJIS[char.order_name] ?? '⚪'}  ${char.order_name}`);
  lines.push(`❤️  HP${pad(char.hp_current)} / ${maxHp(char)}`);
  lines.push(`🔄  Rerolls${pad(char.rerolls_current)} / ${maxRerolls(char)}`);
  if (isWhiteKnight(char)) lines.push(`🛡️  Heal${pad(healCharges)} / ${maxCharges}`);
  lines.push('');
  lines.push(`💪  STR${pad(char.str)}`);
  lines.push(`🫀  CON${pad(char.con)}`);
  lines.push(`⚡  DEX${pad(char.dex)}`);
  lines.push(`🧠  WIS${pad(char.wis)}`);
  lines.push(`🍀  LCK${pad(char.lck)}`);
  return lines.join('\n');
}

function buildPlainRoll({ rollLine, label, isReroll }) {
  const lines = [];
  if (label) lines.push(`**${label}**${isReroll ? ' *(reroll)*' : ''}`);
  else if (isReroll) lines.push('*(reroll)*');
  lines.push(rollLine);
  return lines.join('\n');
}

// ─────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────

function parseRollInput(input) {
  const match = input.match(/^(\d+d\d+(?:[+-]\d+)?)\s*(.*)?$/i);
  if (!match) return null;
  return { notation: match[1], label: match[2]?.trim() || null };
}

async function getDisplayName(guild, userId) {
  try {
    const member = await guild.members.fetch(userId);
    return member.nickname || member.user.username;
  } catch { return 'Unknown'; }
}

async function isGm(guild, userId) {
  const config = getConfig(guild.id);
  if (!config.gm_role_id) return false;
  try {
    const member = await guild.members.fetch(userId);
    return member.roles.cache.has(config.gm_role_id);
  } catch { return false; }
}

async function sendRollEmbed(message, rollLine, label, isReroll, userId) {
  const guildId = message.guild.id;
  const char = getChar(guildId, userId);
  const profileEnabled = char?.profile_enabled === 1;

  if (profileEnabled && char) {
    const config = getConfig(guildId);
    const maxCharges = config.heal_charges ?? 3;
    const healRow = getHealCharges(guildId, userId, maxCharges);
    const displayName = await getDisplayName(message.guild, userId);
    return message.reply(buildRollEmbed({ rollLine, label, isReroll, char: { ...char, displayName }, healCharges: healRow.current, maxCharges }));
  }
  return message.reply(buildPlainRoll({ rollLine, label, isReroll }));
}

// ─────────────────────────────────────────────
//  SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────

const KNIGHTS = ['White Knight', 'Black Knight', 'Gold Knight', 'Grey Knight', 'Blue Knight', 'Purple Knight', 'Green Knight', 'Red Knight'];

const slashCommands = [
  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Server configuration (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(s => s.setName('gmrole').setDescription('Set the GM role').addRoleOption(o => o.setName('role').setDescription('The GM role').setRequired(true)))
    .addSubcommand(s => s.setName('heal').setDescription('Set max Heal charges for White Knights').addIntegerOption(o => o.setName('charges').setDescription('Number of charges').setRequired(true).setMinValue(1).setMaxValue(10))),

  new SlashCommandBuilder()
    .setName('char')
    .setDescription('Character setup and display')
    .addSubcommand(s => s.setName('set').setDescription('Set a character stat or field')
      .addStringOption(o => o.setName('field').setDescription('Field to set').setRequired(true)
        .addChoices({ name: 'Order', value: 'order' }, { name: 'STR', value: 'str' }, { name: 'CON', value: 'con' }, { name: 'DEX', value: 'dex' }, { name: 'WIS', value: 'wis' }, { name: 'LCK', value: 'lck' }))
      .addStringOption(o => o.setName('value').setDescription('Value to set').setRequired(true))
      .addUserOption(o => o.setName('user').setDescription('Target user (GM only)').setRequired(false)))
    .addSubcommand(s => s.setName('show').setDescription('Display a character card').addUserOption(o => o.setName('user').setDescription('User to show').setRequired(false))),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Manage your roll card profile')
    .addSubcommand(s => s.setName('on').setDescription('Enable profile embed, max HP and rerolls'))
    .addSubcommand(s => s.setName('off').setDescription('Disable profile embed'))
    .addSubcommand(s => s.setName('show').setDescription('Preview your profile without rolling'))
    .addSubcommand(s => s.setName('save').setDescription('Snapshot current tracker state').addStringOption(o => o.setName('slotname').setDescription('Name for this save').setRequired(true)))
    .addSubcommand(s => s.setName('load').setDescription('Restore a saved snapshot').addStringOption(o => o.setName('slotname').setDescription('Name of the save to load').setRequired(true)))
    .addSubcommand(s => s.setName('saves').setDescription('List all your saved snapshots')),

  new SlashCommandBuilder()
    .setName('p')
    .setDescription('Shorthand for /profile')
    .addSubcommand(s => s.setName('on').setDescription('Enable profile embed, max HP and rerolls'))
    .addSubcommand(s => s.setName('off').setDescription('Disable profile embed'))
    .addSubcommand(s => s.setName('show').setDescription('Preview your profile without rolling'))
    .addSubcommand(s => s.setName('save').setDescription('Snapshot current tracker state').addStringOption(o => o.setName('slotname').setDescription('Name for this save').setRequired(true)))
    .addSubcommand(s => s.setName('load').setDescription('Restore a saved snapshot').addStringOption(o => o.setName('slotname').setDescription('Name of the save to load').setRequired(true)))
    .addSubcommand(s => s.setName('saves').setDescription('List all your saved snapshots')),
];

// ─────────────────────────────────────────────
//  SLASH COMMAND HANDLERS
// ─────────────────────────────────────────────

async function handleConfig(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  if (sub === 'gmrole') {
    const role = interaction.options.getRole('role');
    setConfig(guildId, { gm_role_id: role.id });
    return interaction.reply({ content: `✅ GM role set to **${role.name}**.`, ephemeral: true });
  }
  if (sub === 'heal') {
    const charges = interaction.options.getInteger('charges');
    setConfig(guildId, { heal_charges: charges });
    return interaction.reply({ content: `✅ White Knight Heal charges set to **${charges}**.`, ephemeral: true });
  }
}

async function handleChar(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const callerId = interaction.user.id;

  if (sub === 'set') {
    const field = interaction.options.getString('field');
    const value = interaction.options.getString('value');
    const targetUser = interaction.options.getUser('user');
    const targetId = targetUser ? targetUser.id : callerId;

    if (targetId !== callerId && !(await isGm(interaction.guild, callerId))) {
      return interaction.reply({ content: '❌ Only GMs can modify other players\' stats.', ephemeral: true });
    }

    if (field === 'order') {
      const knight = KNIGHTS.find(k => k.toLowerCase() === value.toLowerCase());
      if (!knight) return interaction.reply({ content: `❌ Choose from: ${KNIGHTS.join(', ')}`, ephemeral: true });
      upsertChar(guildId, targetId, { order_name: knight });
      const updatedChar = getChar(guildId, targetId);
      if (!isWhiteKnight(updatedChar)) setHealCharges(guildId, targetId, 0);
      else { const cfg = getConfig(guildId); setHealCharges(guildId, targetId, cfg.heal_charges ?? 3); }
      return interaction.reply({ content: `${KNIGHT_EMOJIS[knight] ?? '⚪'} Order set to **${knight}**${targetId !== callerId ? ` for <@${targetId}>` : ''}.` });
    }

    if (['str', 'con', 'dex', 'wis', 'lck'].includes(field)) {
      const num = parseInt(value);
      if (isNaN(num) || num < 0) return interaction.reply({ content: '❌ Value must be a positive number.', ephemeral: true });
      const updatedChar = setStatAndDerive(guildId, targetId, field, num);
      if (field === 'wis') {
        if (isWhiteKnight(updatedChar)) { const cfg = getConfig(guildId); setHealCharges(guildId, targetId, cfg.heal_charges ?? 3); }
        else setHealCharges(guildId, targetId, 0);
      }
      let extra = '';
      if (field === 'con') extra = ` HP maxed to **${updatedChar.hp_current} / ${maxHp(updatedChar)}**`;
      if (field === 'lck') extra = ` Rerolls maxed to **${updatedChar.rerolls_current} / ${maxRerolls(updatedChar)}**`;
      return interaction.reply({ content: `✅ ${field.toUpperCase()} set to **${num}**${targetId !== callerId ? ` for <@${targetId}>` : ''}.${extra}` });
    }
  }

  if (sub === 'show') {
    const targetUser = interaction.options.getUser('user') || interaction.user;
    const targetId = targetUser.id;
    const char = getChar(guildId, targetId);
    if (!char) return interaction.reply({ content: '❌ No character found. Use `/char set` to get started.', ephemeral: true });
    const displayName = await getDisplayName(interaction.guild, targetId);
    const cfg = getConfig(guildId);
    const maxCharges = cfg.heal_charges ?? 3;
    const healRow = getHealCharges(guildId, targetId, maxCharges);
    const knight = char.order_name ? `${KNIGHT_EMOJIS[char.order_name] ?? '⚪'}  ${char.order_name}` : 'No order set';
    const lines = [
      `⚔️  **${displayName}**`, knight,
      `❤️  HP          ${char.hp_current} / ${maxHp(char)}`,
      `🔄  Rerolls      ${char.rerolls_current} / ${maxRerolls(char)}`,
    ];
    if (isWhiteKnight(char)) lines.push(`🛡️  Heal         ${healRow.current} / ${maxCharges}`);
    lines.push('', `💪  STR         ${char.str}`, `🫀  CON         ${char.con}`, `⚡  DEX         ${char.dex}`, `🧠  WIS         ${char.wis}`, `🍀  LCK         ${char.lck}`);
    return interaction.reply({ content: lines.join('\n') });
  }
}

async function handleProfile(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  if (sub === 'on') {
    let char = getChar(guildId, userId);
    if (!char) { upsertChar(guildId, userId, {}); char = getChar(guildId, userId); }
    upsertChar(guildId, userId, { profile_enabled: 1, hp_current: maxHp(char), rerolls_current: maxRerolls(char) });
    if (isWhiteKnight(char)) { const cfg = getConfig(guildId); setHealCharges(guildId, userId, cfg.heal_charges ?? 3); }
    return interaction.reply({ content: '✅ Profile enabled. HP and rerolls maxed out.', ephemeral: true });
  }

  if (sub === 'off') {
    upsertChar(guildId, userId, { profile_enabled: 0 });
    return interaction.reply({ content: '⏸️ Profile disabled. Rolls will post as plain text.', ephemeral: true });
  }

  if (sub === 'show') {
    const char = getChar(guildId, userId);
    if (!char) return interaction.reply({ content: '❌ No character set up. Use `/char set` first.', ephemeral: true });
    const displayName = await getDisplayName(interaction.guild, userId);
    const cfg = getConfig(guildId);
    const maxCharges = cfg.heal_charges ?? 3;
    const healRow = getHealCharges(guildId, userId, maxCharges);
    const knight = char.order_name ? `${KNIGHT_EMOJIS[char.order_name] ?? '⚪'}  ${char.order_name}` : 'No order set';
    const lines = [
      `⚔️  **${displayName}**`, knight,
      `❤️  HP          ${char.hp_current} / ${maxHp(char)}`,
      `🔄  Rerolls      ${char.rerolls_current} / ${maxRerolls(char)}`,
    ];
    if (isWhiteKnight(char)) lines.push(`🛡️  Heal         ${healRow.current} / ${maxCharges}`);
    lines.push('', `💪  STR         ${char.str}`, `🫀  CON         ${char.con}`, `⚡  DEX         ${char.dex}`, `🧠  WIS         ${char.wis}`, `🍀  LCK         ${char.lck}`);
    return interaction.reply({ content: lines.join('\n'), ephemeral: true });
  }

  if (sub === 'save') {
    const slotName = interaction.options.getString('slotname');
    const char = getChar(guildId, userId);
    if (!char) return interaction.reply({ content: '❌ No character to save.', ephemeral: true });
    const cfg = getConfig(guildId);
    const healRow = getHealCharges(guildId, userId, cfg.heal_charges ?? 3);
    saveProfile(guildId, userId, slotName, { ...char, heal_current: healRow.current });
    return interaction.reply({ content: `💾 Profile saved as **${slotName}**.`, ephemeral: true });
  }

  if (sub === 'load') {
    const slotName = interaction.options.getString('slotname');
    const snapshot = loadProfile(guildId, userId, slotName);
    if (!snapshot) return interaction.reply({ content: `❌ No save found with name **${slotName}**.`, ephemeral: true });
    upsertChar(guildId, userId, { hp_current: snapshot.hp_current, rerolls_current: snapshot.rerolls_current, str: snapshot.str, con: snapshot.con, dex: snapshot.dex, wis: snapshot.wis, lck: snapshot.lck, order_name: snapshot.order_name, profile_enabled: snapshot.profile_enabled });
    setHealCharges(guildId, userId, snapshot.heal_current ?? 0);
    return interaction.reply({ content: `📂 Profile **${slotName}** loaded.`, ephemeral: true });
  }

  if (sub === 'saves') {
    const saves = listProfiles(guildId, userId);
    if (!saves.length) return interaction.reply({ content: '❌ No saved profiles found.', ephemeral: true });
    return interaction.reply({ content: `📋 Your saves:\n${saves.map(s => `• **${s.slot_name}** — ${s.saved_at}`).join('\n')}`, ephemeral: true });
  }
}

// ─────────────────────────────────────────────
//  PREFIX COMMAND HANDLERS
// ─────────────────────────────────────────────

async function handleRoll(message, rest, mode, isReroll) {
  const guildId = message.guild.id;
  const channelId = message.channel.id;
  const userId = message.author.id;

  let notation, label;

  if (isReroll) {
    const last = getLastRoll(guildId, channelId, userId);
    if (!last) return message.reply('❌ No previous roll found in this channel.');
    notation = last.notation;
    label = rest.trim() || last.label;
    // Deduct reroll token
    const char = getChar(guildId, userId);
    if (char && char.rerolls_current > 0) upsertChar(guildId, userId, { rerolls_current: char.rerolls_current - 1 });
  } else {
    const parsed = parseRollInput(rest);
    if (!parsed) return message.reply('❌ Invalid notation. Try `r1d20+5 attack` or `r2d6`.');
    notation = parsed.notation;
    label = parsed.label;
  }

  let result;
  if (mode === 'adv') result = rollAdvantage(notation);
  else if (mode === 'dis') result = rollDisadvantage(notation);
  else result = rollNotation(notation);

  if (!result) return message.reply('❌ Could not parse dice notation.');

  saveRoll(guildId, channelId, userId, notation, label);
  const rollLine = buildRollLine(result, mode);
  await sendRollEmbed(message, rollLine, label, isReroll, userId);
}

async function handleHeal(message, rest) {
  const guildId = message.guild.id;
  const userId = message.author.id;

  // Require a target mention: !heal @user
  const mentionMatch = rest.match(/^<@!?(\d+)>/);
  if (!mentionMatch) return message.reply('❌ You must target a player. Usage: `!heal @user`');
  const targetId = mentionMatch[1];
  if (targetId === userId) return message.reply('❌ You cannot heal yourself.');

  const char = getChar(guildId, userId);
  if (!char) return message.reply('❌ No character found. Use `/char set` first.');
  if (!isWhiteKnight(char)) return message.reply('❌ Only White Knights with WIS 5 can use Heal.');

  const targetChar = getChar(guildId, targetId);
  if (!targetChar) return message.reply('❌ Target has no character set up.');

  const cfg = getConfig(guildId);
  const maxCharges = cfg.heal_charges ?? 3;
  const healRow = getHealCharges(guildId, userId, maxCharges);
  if (healRow.current <= 0) return message.reply('❌ No Heal charges remaining.');

  const result = rollNotation(`1d20+${char.wis}`);
  const naturalRoll = result.rolls[0];
  const total = result.total;

  // Get target display name for result text
  const targetName = await getDisplayName(message.guild, targetId);

  let healAmount = 0, chargesUsed = 0, resultText = '';
  if (naturalRoll === 20) { healAmount = 2; chargesUsed = 0; resultText = `*Natural 20! 2 HP restored to ${targetName}. No charge consumed.*`; }
  else if (total >= 20) { healAmount = 2; chargesUsed = 1; resultText = `*2 HP restored to ${targetName}. 1 charge consumed.*`; }
  else if (naturalRoll === 1) { chargesUsed = Math.min(2, healRow.current); resultText = `*Natural 1! No heal. ${chargesUsed} charges consumed.*`; }
  else { chargesUsed = 1; resultText = `*No heal. 1 charge consumed.*`; }

  // Apply heal to target, not caster
  const targetHpMax = maxHp(targetChar);
  const newTargetHp = Math.min(targetChar.hp_current + healAmount, targetHpMax);
  const newCharges = Math.max(0, healRow.current - chargesUsed);

  upsertChar(guildId, targetId, { hp_current: newTargetHp });
  setHealCharges(guildId, userId, newCharges);

  // Embed shows the White Knight's card (caster)
  const updatedChar = getChar(guildId, userId);
  const displayName = await getDisplayName(message.guild, userId);
  const modStr = char.wis > 0 ? ` +${char.wis}` : '';
  const rollLine = `🎲  1d20+${char.wis} → [${naturalRoll}]${modStr} = **${total}**`;

  const profileEnabled = char.profile_enabled === 1;
  let content;
  if (profileEnabled) {
    content = buildRollEmbed({ rollLine, label: 'heal', isReroll: false, char: { ...updatedChar, displayName }, healCharges: newCharges, maxCharges });
    content += `\n${resultText}`;
  } else {
    content = `**heal**\n${rollLine}\n${resultText}`;
  }
  await message.reply(content);
}

async function handleHp(message, rest) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const mentionMatch = rest.match(/^<@!?(\d+)>\s*([+-]\d+)$/);
  const selfMatch = rest.match(/^([+-]\d+)$/);

  let targetId, amount;
  if (mentionMatch) {
    if (!(await isGm(message.guild, userId))) return message.reply('❌ Only GMs can modify other players\' HP.');
    targetId = mentionMatch[1]; amount = parseInt(mentionMatch[2]);
  } else if (selfMatch) {
    targetId = userId; amount = parseInt(selfMatch[1]);
  } else return message.reply('❌ Usage: `!hp +5` or `!hp @user -3`');

  const char = getChar(guildId, targetId);
  if (!char) return message.reply('❌ No character found for that user.');
  const hpMax = maxHp(char);
  const newHp = Math.max(0, Math.min(char.hp_current + amount, hpMax));
  upsertChar(guildId, targetId, { hp_current: newHp });
  const direction = amount > 0 ? '💚 Healed' : '🩸 Damaged';
  await message.reply(`${direction} ${Math.abs(amount)} HP — ${targetId === userId ? 'Your' : `<@${targetId}>'s`} HP: **${newHp} / ${hpMax}**`);
}

async function handleRerolls(message, rest) {
  const guildId = message.guild.id;
  const userId = message.author.id;
  const mentionMatch = rest.match(/^<@!?(\d+)>\s*([+-]\d+)$/);
  const selfMatch = rest.match(/^([+-]\d+)$/);

  let targetId, amount;
  if (mentionMatch) {
    if (!(await isGm(message.guild, userId))) return message.reply('❌ Only GMs can modify other players\' rerolls.');
    targetId = mentionMatch[1]; amount = parseInt(mentionMatch[2]);
  } else if (selfMatch) {
    targetId = userId; amount = parseInt(selfMatch[1]);
  } else return message.reply('❌ Usage: `!rerolls +1` or `!rerolls @user -1`');

  const char = getChar(guildId, targetId);
  if (!char) return message.reply('❌ No character found for that user.');
  const rerollMax = maxRerolls(char);
  const newRerolls = Math.max(0, Math.min(char.rerolls_current + amount, rerollMax));
  upsertChar(guildId, targetId, { rerolls_current: newRerolls });
  await message.reply(`🔄 ${targetId === userId ? 'Your' : `<@${targetId}>'s`} Rerolls: **${newRerolls} / ${rerollMax}**`);
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
  } catch (err) {
    console.error(err);
    if (!interaction.replied) interaction.reply({ content: '❌ Something went wrong.', ephemeral: true });
  }
});

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // Match all prefix variants
  const match = content.match(/^(!?)(roll|r(?:ra|rd|r(?:a|d)?)?|ra|rd|rr(?:a|d)?|heal|h|hp|rerolls)(\d.*|\s.*|$)/i);
  if (!match) return;

  const raw = (match[1] + match[2]).toLowerCase().replace(/^!/, '');
  const rest = (match[3] ?? '').trim();

  try {
    if (raw === 'r' || raw === 'roll') return handleRoll(message, rest, 'normal', false);
    if (raw === 'ra') return handleRoll(message, rest, 'adv', false);
    if (raw === 'rd') return handleRoll(message, rest, 'dis', false);
    if (raw === 'rr') return handleRoll(message, rest, 'normal', true);
    if (raw === 'rra') return handleRoll(message, rest, 'adv', true);
    if (raw === 'rrd') return handleRoll(message, rest, 'dis', true);
    if (raw === 'heal' || raw === 'h') return handleHeal(message, rest);
    if (raw === 'hp') return handleHp(message, rest);
    if (raw === 'rerolls') return handleRerolls(message, rest);
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
  } catch (err) {
    console.error('Failed to register slash commands:', err);
  }
  client.login(process.env.DISCORD_TOKEN);
})();
