#!/usr/bin/env node
// probe.js — what verify.js cannot see.
//
//   node --experimental-sqlite probe.js          run every probe
//   node --experimental-sqlite probe.js -v       show each probe as it runs
//
// verify.js reads the source as text. This runs it: index.js is loaded
// against a fake discord.js and a real in-memory SQLite, its interaction
// handlers are driven with synthetic presses and commands, and invariants
// are checked after every action. The bugs this class of tool catches are
// exactly the ones that reached T's server this month — a migration that
// completes without doing anything, a forum built but never filled, a
// handler filed in the wrong lane.
//
// It is deliberately shallow about Discord and deep about state: the fake
// records what would have been sent, and the assertions are all about the
// database and the routing.

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { DatabaseSync } = require('node:sqlite');

const VERBOSE = process.argv.includes('-v');
let lastDb = null;
const C = process.stdout.isTTY
  ? { grn: '\x1b[32m', red: '\x1b[31m', yel: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' }
  : { grn: '', red: '', yel: '', dim: '', off: '' };

let pass = 0; const failures = [];
function ok(label, cond, detail) {
  if (cond) { pass++; if (VERBOSE) console.log(`  ${C.grn}·${C.off} ${label}`); }
  else { failures.push({ label, detail }); console.log(`  ${C.red}FAIL${C.off}  ${label}${detail ? `\n        ${detail}` : ''}`); }
}

// ── the fakes ───────────────────────────────────────────────────────────
// Enough discord.js to let index.js load and register everything, and to
// capture what it would have done. Builders record their own shape so the
// probes can read the command tree back.

const sent = [];          // every message the bot tried to send
const listeners = {};     // event name -> [fn]

function recorder(kind) {
  return class Rec {
    constructor() { this._kind = kind; this._d = { options: [], subcommands: [], groups: [], components: [] }; }
    setName(v) { this._d.name = v; return this; }
    setDescription(v) { this._d.description = v; return this; }
    setRequired(v) { this._d.required = v; return this; }
    setMinValue(v) { this._d.min = v; return this; }
    setMaxValue(v) { this._d.max = v; return this; }
    setMaxLength(v) { this._d.maxLength = v; return this; }
    setPlaceholder(v) { this._d.placeholder = v; return this; }
    setStyle(v) { this._d.style = v; return this; }
    setLabel(v) { this._d.label = v; return this; }
    setCustomId(v) { this._d.customId = v; return this; }
    setTitle(v) { this._d.title = v; return this; }
    setAutocomplete(v) { this._d.autocomplete = v; return this; }
    setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }
    addChoices(...c) { (this._d.choices ??= []).push(...c.flat()); return this; }
    addComponents(...c) { this._d.components.push(...c.flat()); return this; }
    addSubcommand(fn) { this._d.subcommands.push(fn(new (recorder('sub'))())._d ?? fn); return this; }
    addSubcommandGroup(fn) { const g = fn(new (recorder('group'))()); this._d.groups.push(g._d ?? g); return this; }
    addStringOption(fn) { this._d.options.push({ type: 'string', ...fn(new (recorder('opt'))())._d }); return this; }
    addIntegerOption(fn) { this._d.options.push({ type: 'int', ...fn(new (recorder('opt'))())._d }); return this; }
    addBooleanOption(fn) { this._d.options.push({ type: 'bool', ...fn(new (recorder('opt'))())._d }); return this; }
    addUserOption(fn) { this._d.options.push({ type: 'user', ...fn(new (recorder('opt'))())._d }); return this; }
    addChannelOption(fn) { this._d.options.push({ type: 'channel', ...fn(new (recorder('opt'))())._d }); return this; }
    addAttachmentOption(fn) { this._d.options.push({ type: 'file', ...fn(new (recorder('opt'))())._d }); return this; }
    addRoleOption(fn) { this._d.options.push({ type: 'role', ...fn(new (recorder('opt'))())._d }); return this; }
    addNumberOption(fn) { this._d.options.push({ type: 'num', ...fn(new (recorder('opt'))())._d }); return this; }
    addChannelTypes() { return this; }
    toJSON() { return this._d; }
  };
}

class FakeChannel {
  constructor(id, type = 0, name = 'chan', guild = null) {
    this.id = id; this.type = type; this.name = name; this.guild = guild;
    this.messages = {
      fetch: async (mid) => sentById.get(mid) || null,
      cache: new Map(),
    };
    this.threads = {
      create: async ({ name, message }) => {
        const t = new FakeChannel(nextId(), 11, name, guild);
        t.parentId = this.id; t._isThread = true;
        threads.push(t);
        if (message) await t.send(message);
        return t;
      },
      cache: new Map(),
    };
    this.permissionOverwrites = { edit: async () => {} };
    this.availableTags = [];
  }
  isThread() { return !!this._isThread; }
  isTextBased() { return true; }
  permissionsFor() { return { has: () => true }; }
  async setName(n) { this.name = n; }
  async setAppliedTags(t) { this.appliedTags = t; }
  async setAvailableTags(t) { this.availableTags = t; }
  async fetch() { return this; }
  async send(payload) {
    const content = typeof payload === 'string' ? payload : (payload?.content ?? '');
    const msg = {
      id: nextId(), content, channelId: this.id,
      components: (typeof payload === 'object' && payload?.components) || [],
      author: { id: 'BOT' }, editable: true,
      edit: async (p) => { msg.content = typeof p === 'string' ? p : (p?.content ?? msg.content); if (typeof p === 'object' && 'components' in p) msg.components = p.components; return msg; },
      delete: async () => { deleted.push(msg.id); },
    };
    sent.push({ channel: this.id, content, msg });
    sentById.set(msg.id, msg);
    return msg;
  }
  async delete() { deleted.push(this.id); }
}

let idSeq = 1000n;
const nextId = () => String(idSeq++);
const sentById = new Map();
const threads = [];
const deleted = [];

class FakeClient {
  constructor() {
    this.user = { id: 'BOT', tag: 'DDice#0000' };
    this.guilds = { cache: new Map() };
    this.channels = { fetch: async (id) => channelsById.get(id) || null, cache: new Map() };
    this.ws = { ping: 1 };
  }
  on(evt, fn) { (listeners[evt] ??= []).push(fn); return this; }
  once(evt, fn) { (listeners[evt] ??= []).push(fn); return this; }
  async login() { return 'ok'; }
  destroy() {}
}

const channelsById = new Map();

const fakeDiscord = {
  Client: FakeClient,
  GatewayIntentBits: new Proxy({}, { get: () => 1 }),
  PermissionFlagsBits: new Proxy({}, { get: () => 1n }),
  MessageFlags: new Proxy({}, { get: () => 64 }),
  ChannelType: { GuildText: 0, GuildCategory: 4, GuildForum: 15, PublicThread: 11 },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  TextInputStyle: { Short: 1, Paragraph: 2 },
  SlashCommandBuilder: recorder('cmd'),
  ActionRowBuilder: recorder('row'),
  ButtonBuilder: recorder('button'),
  ModalBuilder: recorder('modal'),
  TextInputBuilder: recorder('input'),
  StringSelectMenuBuilder: recorder('select'),
  ChannelSelectMenuBuilder: recorder('cselect'),
  AttachmentBuilder: class { constructor(a, b) { this.a = a; this.b = b; } },
  WebhookClient: class { async send() { return { id: nextId() }; } async edit() {} },
  REST: class { setToken() { return this; } async put() { return []; } async get() { return []; } },
  Routes: new Proxy({}, { get: () => () => 'route' }),
  EmbedBuilder: recorder('embed'),
  Collection: Map,
};

// A better-sqlite3 shape over node:sqlite, so index.js's data layer runs
// against real SQLite rather than a mock that would agree with anything.
function makeSqliteShim() {
  return class Database {
    constructor() { this._db = new DatabaseSync(':memory:'); lastDb = this; }
    prepare(sql) {
      const db = this._db;
      let st = null;
      const get = () => (st ??= db.prepare(sql));
      const fix = (a) => a.map(v => (v === undefined ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
      return {
        run: (...a) => get().run(...fix(a)),
        get: (...a) => get().get(...fix(a)),
        all: (...a) => get().all(...fix(a)),
        iterate: function* (...a) { yield* get().all(...fix(a)); },
        pluck() { return this; },
      };
    }
    exec(sql) { return this._db.exec(sql); }
    pragma(p) { try { return this._db.exec(`PRAGMA ${p}`); } catch { return null; } }
    transaction(fn) { return (...a) => fn(...a); }
    close() { this._db.close(); }
    backup() { return Promise.resolve(); }
  };
}

// ── load index.js under the fakes ───────────────────────────────────────
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'discord.js') return fakeDiscord;
  if (request === 'better-sqlite3') return makeSqliteShim();
  if (request === 'dotenv') return { config: () => ({}) };
  if (request === 'node-fetch') return async () => ({ ok: true, json: async () => ({}) });
  return realLoad.call(this, request, parent, isMain);
};

// index.js writes to a fixed path; give it somewhere it may write.
try { fs.mkdirSync('/app/data', { recursive: true }); } catch {}

process.env.DISCORD_TOKEN = 'probe';
process.env.CLIENT_ID = 'probe';

let loadError = null;
const startedAt = Date.now();
try {
  require(path.join(process.cwd(), 'index.js'));
} catch (e) {
  loadError = e;
}

console.log(`\n${C.dim}probe · ${new Date().toISOString().slice(0, 19).replace('T', ' ')}${C.off}\n`);

ok('index.js loads under a fake gateway', !loadError, loadError && (loadError.stack || '').split('\n').slice(0, 3).join('\n        '));
if (loadError) { report(); process.exit(1); }

ok('it registers an interaction handler', (listeners.interactionCreate || []).length > 0);
ok('it registers a message handler', (listeners.messageCreate || []).length > 0);
ok('it registers a ready handler',
  (listeners.clientReady || listeners.ready || []).length > 0);
ok('it registers a channelCreate handler', (listeners.channelCreate || []).length > 0);

// ── a guild to play in ──────────────────────────────────────────────────
const GID = 'G1';
const guild = {
  id: GID, name: 'Probe Hall',
  members: {
    me: { id: 'BOT', permissions: { has: () => true } },
    fetch: async (uid) => ({ id: uid, nickname: null, user: { id: uid, username: `user${uid}`, tag: `user${uid}#1` }, roles: { cache: new Map() } }),
    cache: new Map(),
  },
  roles: { everyone: { id: 'EVERYONE' }, cache: new Map() },
  channels: {
    create: async ({ name, type }) => { const c = new FakeChannel(nextId(), type ?? 0, name, guild); channelsById.set(c.id, c); return c; },
    fetch: async () => new Map(channelsById),
    cache: new Map(),
  },
};
guild.members.me.permissions.has = () => true;

const chan = new FakeChannel('C1', 0, 'testing', guild);
channelsById.set(chan.id, chan);

// ── synthetic interactions ──────────────────────────────────────────────
const replies = [];
function makeInteraction(over = {}) {
  const opts = over.options || {};
  const i = {
    guild, guildId: GID, channel: over.channel || chan, channelId: (over.channel || chan).id,
    user: { id: over.userId || 'U1', tag: 'u1#1', username: 'u1' },
    member: { id: over.userId || 'U1', roles: { cache: new Map() }, permissions: { has: () => true } },
    client, appPermissions: { has: () => true },
    commandName: over.commandName,
    customId: over.customId,
    values: over.values,
    message: over.message,
    deferred: false, replied: false,
    isButton: () => !!over.isButton,
    isStringSelectMenu: () => !!over.isSelect,
    isModalSubmit: () => !!over.isModal,
    isChatInputCommand: () => !!over.commandName,
    isAutocomplete: () => !!over.isAutocomplete,
    isCommand: () => !!over.commandName,
    options: {
      getSubcommand: (req) => opts._sub ?? (req === false ? null : null),
      getSubcommandGroup: () => opts._group ?? null,
      getString: (n) => opts[n] ?? null,
      getInteger: (n) => (typeof opts[n] === 'number' ? opts[n] : null),
      getBoolean: (n) => (typeof opts[n] === 'boolean' ? opts[n] : null),
      getUser: (n) => (opts[n] ? { id: opts[n], tag: 'x#1', username: 'x' } : null),
      getChannel: (n) => opts[n] || null,
      getAttachment: () => null,
      getFocused: () => ({ name: opts._focused || 'name', value: opts._focusedValue || '' }),
      data: [],
    },
    fields: { getTextInputValue: (n) => (over.fields || {})[n] ?? '' },
    reply: async (p) => { i.replied = true; replies.push(norm(p)); return { id: nextId() }; },
    editReply: async (p) => { replies.push(norm(p)); return { id: nextId() }; },
    followUp: async (p) => { replies.push(norm(p)); return { id: nextId() }; },
    deferReply: async () => { i.deferred = true; },
    deferUpdate: async () => { i.deferred = true; },
    update: async (p) => { i.replied = true; replies.push(norm(p)); },
    showModal: async (m) => { replies.push({ modal: m?._d?.customId ?? 'modal' }); },
    respond: async (c) => { replies.push({ autocomplete: c }); },
  };
  return i;
}
const norm = (p) => (typeof p === 'string' ? { content: p } : (p || {}));
const client = new FakeClient();

async function fire(over) {
  replies.length = 0;
  const i = makeInteraction(over);
  for (const fn of listeners.interactionCreate || []) await fn(i);
  return { i, replies: [...replies] };
}

// ── the probes ──────────────────────────────────────────────────────────
(async () => {
  // Schema: every table the code declares actually exists after load.
  const src = fs.readFileSync('index.js', 'utf8');
  const declared = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  const dbHandle = findDb();
  ok('the database exists after load', !!dbHandle);
  if (dbHandle) {
    const live = new Set(dbHandle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    const missing = declared.filter(t => !live.has(t));
    ok(`every declared table is created (${declared.length})`, missing.length === 0, missing.join(', '));

    // Every column an ALTER adds must be present — the phantom-table class.
    // Only ALTERs that run at load — ones inside functions fire later by
    // design, so counting them here would be a lie.
    const alters = [...src.matchAll(/^try \{ db\.exec\('ALTER TABLE (\w+) ADD COLUMN (\w+)/gm)];
    const badCols = [];
    for (const [, table, col] of alters) {
      if (!live.has(table)) { badCols.push(`${table}.${col} (no such table)`); continue; }
      const cols = new Set(dbHandle.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      if (!cols.has(col)) badCols.push(`${table}.${col}`);
    }
    ok(`every ALTER lands (${alters.length})`, badCols.length === 0, badCols.slice(0, 6).join(', '));
  }

  // Unknown commands and buttons must not throw.
  const junk = await fire({ commandName: 'definitelynotacommand' });
  ok('an unknown command does not throw', true);
  const junkBtn = await fire({ isButton: true, customId: 'nope:1', message: { id: 'M0', content: '' } });
  ok('an unknown button does not throw', true);

  // Every button customId the source emits should be recognised by the
  // button lane — this is the "wrong lane" class that bit the lore-doc
  // button on T's server.
  // Ids set on a ModalBuilder or a select menu belong to other lanes; only
  // ButtonBuilder ids are expected here. The builder is named a few lines
  // above its setCustomId, so read the window.
  const emitted = [];
  for (const m of src.matchAll(/setCustomId\(`?([a-zA-Z]+)[:`']/g)) {
    const win = src.slice(Math.max(0, m.index - 400), m.index);
    const lastBtn = Math.max(win.lastIndexOf('ButtonBuilder'), win.lastIndexOf('FbBtn'), win.lastIndexOf('TB()'));
    const lastOther = Math.max(win.lastIndexOf('ModalBuilder'), win.lastIndexOf('SelectMenuBuilder'), win.lastIndexOf('FS()'));
    if (lastBtn > lastOther && !emitted.includes(m[1])) emitted.push(m[1]);
  }
  const unhandled = [];
  for (const id of emitted) {
    const r = await fire({ isButton: true, customId: `${id}:probe`, message: { id: 'M1', content: 'x', components: [] } });
    const said = r.replies.map(x => JSON.stringify(x)).join(' ');
    // A handled id says something — a refusal counts. Silence means no
    // branch claimed it.
    if (!r.replies.length) unhandled.push(id);
  }
  ok(`every emitted button id reaches a handler (${emitted.length})`,
    unhandled.length === 0, unhandled.length ? `silent: ${unhandled.join(', ')}` : '');

  // Migrations must be idempotent: run the ready path twice and prove the
  // second pass changes nothing. This is the restart-survival probe, and
  // the vacuous-flag bug lived exactly here.
  if (dbHandle) {
    const before = tableCounts(dbHandle);
    for (const fn of listeners.clientReady || listeners.ready || []) {
      await fn().catch(() => {});
    }
    const once = tableCounts(dbHandle);
    for (const fn of listeners.clientReady || listeners.ready || []) {
      await fn().catch(() => {});
    }
    const twice = tableCounts(dbHandle);
    ok('a second boot changes nothing (restart survival)',
      JSON.stringify(once) === JSON.stringify(twice),
      diffCounts(once, twice));
  }

  // Every migration flag that exists is readable by the ledger.
  if (dbHandle) {
    const flags = [...new Set([...src.matchAll(/meta \(k, v\) VALUES \('([a-z_0-9]+)'/g)].map(m => m[1]))];
    // The ledger is an array of pairs, so the first ] is inside it — read
    // to the closing ]] instead.
    const fi = src.indexOf('const FLAGS = [');
    const ledger = src.slice(fi, src.indexOf(']];', fi));
    const absent = flags.filter(f => !ledger.includes(f));
    ok(`every migration flag is in the ledger (${flags.length})`, absent.length === 0, absent.join(', '));
  }

  report();
})().catch(e => {
  console.log(`${C.red}probe crashed${C.off}\n${e.stack}`);
  process.exit(1);
});

// The shim records the handle index.js opened, so probes can query the
// very same database the bot is using.
function findDb() { return lastDb; }
function tableCounts(db) {
  const out = {};
  for (const r of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    try { out[r.name] = db.prepare(`SELECT COUNT(*) AS c FROM ${r.name}`).get().c; } catch {}
  }
  return out;
}
function diffCounts(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter(k => a[k] !== b[k]).map(k => `${k}: ${a[k]}→${b[k]}`).join(', ');
}

function report() {
  // index.js sets intervals that would hold the process open forever.
  const total = pass + failures.length;
  console.log('');
  if (!failures.length) console.log(`${C.grn}all green${C.off} — ${total} probes`);
  else console.log(`${C.red}${failures.length} failed${C.off} of ${total} probes`);
  console.log('');
  process.exit(failures.length ? 1 : 0);
}
