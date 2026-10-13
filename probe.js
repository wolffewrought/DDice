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
// No interval ever really ticks in the probe: each is captured here and run
// once, by hand, in the tick walk — including the ones a boot starts only once.
const ticks = [];
globalThis.setInterval = (fn, ms) => { ticks.push({ fn, ms }); return 0; };
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
    setDisabled(v) { this._d.disabled = v; return this; }
    setDefaultMemberPermissions() { return this; }
    setDMPermission() { return this; }
    addChoices(...c) { (this._d.choices ??= []).push(...c.flat()); return this; }
    addOptions(...c) { (this._d.options ??= []).push(...c.flat()); return this; }
    setValue(v) { this._d.value = v; return this; }
    setMinLength(v) { this._d.minLength = v; return this; }
    setMinValues(v) { this._d.min = v; return this; }
    setMaxValues(v) { this._d.max = v; return this; }
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

// discord.js hands back Collections, which are Maps with find/filter/some.
class FakeCollection extends Map {
  find(fn) { for (const v of this.values()) if (fn(v)) return v; return undefined; }
  filter(fn) { const c = new FakeCollection(); for (const [k, v] of this) if (fn(v)) c.set(k, v); return c; }
  some(fn) { for (const v of this.values()) if (fn(v)) return true; return false; }
  map(fn) { return [...this.values()].map(fn); }
  first() { return this.values().next().value; }
  last() { let v; for (v of this.values()); return v; }
}
class FakeChannel {
  constructor(id, type = 0, name = 'chan', guild = null) {
    this.id = id; this.type = type; this.name = name; this.guild = guild;
    this.members = { add: async () => {}, remove: async () => {}, cache: new FakeCollection() };
    this.messages = {
      // By id, as before; with a { limit, before } query, the channel's own
      // history newest first, as discord.js returns it — the update sweep
      // reads back through gm-quest-log this way.
      fetch: async (arg) => {
        if (typeof arg === 'string') return sentById.get(arg) || null;
        const mine = sent.filter(x => x.channel === this.id && !deleted.includes(x.msg.id)).map(x => x.msg).reverse();
        const from = arg?.before ? mine.findIndex(m => m.id === arg.before) + 1 : 0;
        const page = mine.slice(from, from + (arg?.limit || 50));
        const col = new FakeCollection(page.map(m => [m.id, m]));
        return col;
      },
      cache: new Map(),
    };
    this.threads = {
      create: async ({ name, message }) => {
        const t = new FakeChannel(nextId(), 11, name, guild);
        t.parentId = this.id; t._isThread = true; t.ownerId = 'BOT';
        threads.push(t);
        channelsById.set(t.id, t);   // fetchable by id, as a real thread is
        if (message) await t.send(message);
        return t;
      },
      // The forum's live threads, as discord.js hands them back.
      fetchActive: async () => ({ threads: new FakeCollection(threads.filter(t => t.parentId === this.id && !deleted.includes(t.id) && !t.archived).map(t => [t.id, t])), hasMore: false }),
      fetchArchived: async () => ({ threads: new FakeCollection(threads.filter(t => t.parentId === this.id && !deleted.includes(t.id) && t.archived).map(t => [t.id, t])), hasMore: false }),
      cache: new Map(),
    };
    this.permissionOverwrites = { edit: async () => {} };
    this.availableTags = [];
    // The channel's webhooks, as Discord hands them back: the bot's own carry a token.
    this._hooks = [];
    this.fetchWebhooks = async () => new FakeCollection(this._hooks.map(h => [h.id, h]));
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

let lastClient = null;      // the instance index.js made — the one the ready handler walks
class FakeClient {
  constructor() {
    this.user = { id: 'BOT', tag: 'DDice#0000' };
    this.guilds = { cache: new Map() };
    if (!lastClient) lastClient = this;   // index.js's own instance comes first; the probe's own, below, is a second
    this.channels = { fetch: async (id) => channelsById.get(id) || null, cache: new Map() };
    this.users = { fetch: async (id) => ({ id, username: `user${id}`, send: async () => ({ id: nextId() }) }) };
    this.ws = { ping: 1 };
  }
  on(evt, fn) { (listeners[evt] ??= []).push(fn); return this; }
  once(evt, fn) { (listeners[evt] ??= []).push(fn); return this; }
  async login() { return 'ok'; }
  destroy() {}
}

const channelsById = new Map();
const registered = [];      // every command set handed to REST.put — the picker as Discord would see it

const fakeDiscord = {
  Client: FakeClient,
  GatewayIntentBits: new Proxy({}, { get: () => 1 }),
  PermissionFlagsBits: new Proxy({}, { get: () => 1n }),
  MessageFlags: new Proxy({}, { get: () => 64 }),
  ChannelType: { GuildText: 0, GuildCategory: 4, GuildForum: 15, PublicThread: 11 },
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  TextInputStyle: { Short: 1, Paragraph: 2 },
  SlashCommandBuilder: recorder('cmd'),
  ContextMenuCommandBuilder: class { setName(n) { this._d = { name: n, contextMenu: true }; return this; } setType(t) { this._d.type = t; return this; } toJSON() { return this._d; } },
  ApplicationCommandType: { ChatInput: 1, User: 2, Message: 3 },
  ActionRowBuilder: recorder('row'),
  ButtonBuilder: recorder('button'),
  ModalBuilder: recorder('modal'),
  TextInputBuilder: recorder('input'),
  StringSelectMenuBuilder: recorder('select'),
  ChannelSelectMenuBuilder: recorder('cselect'),
  AttachmentBuilder: class { constructor(a, b) { this.a = a; this.b = b; } },
  WebhookClient: class { constructor(o) { this.id = o?.id; } async send() { return { id: nextId() }; } async edit() {} async editMessage(id, p) { const m = sentById.get(id); if (m) m.content = p?.content ?? m.content; return m; } },
  REST: class { setToken() { return this; } async put(route, opts) { if (opts?.body) registered.push(opts.body); return []; } async get() { return []; } },
  Routes: new Proxy({}, { get: () => () => 'route' }),
  EmbedBuilder: recorder('embed'),
  Collection: FakeCollection,
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
    // Every fake member is an admin, so GM-gated paths can be walked.
    fetch: async (uid) => ({ id: uid, nickname: null, user: { id: uid, username: `user${uid}`, tag: `user${uid}#1` }, roles: { cache: new Map() }, permissions: { has: () => true } }),
    cache: new Map(),
  },
  roles: { everyone: { id: 'EVERYONE' }, cache: new Map() },
  channels: {
    create: async ({ name, type }) => { const c = new FakeChannel(nextId(), type ?? 0, name, guild); channelsById.set(c.id, c); return c; },
    fetch: async () => new FakeCollection(channelsById),
    cache: new FakeCollection(),
  },
};
guild.members.me.permissions.has = () => true;
// The bot's own client sees the probe guild, so the ready path registers
// its commands (what the leaf walk reads back) and mends it like a real one.
if (lastClient) { lastClient.guilds.cache.set(GID, guild); guild.client = lastClient; }

const chan = new FakeChannel('C1', 0, 'testing', guild);
channelsById.set(chan.id, chan);

// ── synthetic interactions ──────────────────────────────────────────────
const replies = [];
// A second acknowledgement throws, as discord.js's does: InteractionAlreadyReplied
// was the grapple picker's death in September. Every one is recorded.
const doubleAcks = [];
const already = (over, what) => { doubleAcks.push(`${over.commandName || over.customId}: ${what}`); return new Error('InteractionAlreadyReplied'); };
function makeInteraction(over = {}) {
  const opts = over.options || {};
  const i = {
    guild, guildId: GID, channel: over.channel || chan, channelId: (over.channel || chan).id,
    user: { id: over.userId || 'U1', tag: 'u1#1', username: 'u1' },
    member: over.member || { id: over.userId || 'U1', roles: { cache: new Map() }, permissions: { has: () => true } },
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
    isMessageContextMenuCommand: () => !!over.isContextMenu,
    targetMessage: over.targetMessage,
    isFromMessage: () => !!over.fromMessage,
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
    reply: async (p) => { if (i.replied || i.deferred) throw already(over, `reply after ${i.deferred ? 'defer' : 'reply'}`); i.replied = true; replies.push(norm(p)); return { id: nextId() }; },
    fetchReply: async () => ({ id: nextId(), channelId: (over.channel || chan).id, edit: async () => {} }),
    editReply: async (p) => { replies.push(norm(p)); return { id: nextId() }; },
    followUp: async (p) => { replies.push(norm(p)); return { id: nextId() }; },
    deferReply: async () => { if (i.replied || i.deferred) throw already(over, 'defer after ack'); i.deferred = true; },
    deferUpdate: async () => { if (i.replied || i.deferred) throw already(over, 'deferUpdate after ack'); i.deferred = true; },
    update: async (p) => { if (i.replied) throw already(over, 'update after reply'); i.replied = true; replies.push(norm(p)); },
    showModal: async (m) => { if (i.replied || i.deferred) throw already(over, 'showModal after ack'); i.replied = true;
      const modalFields = {}; for (const row of m?._d?.components || []) for (const c of (row._d || row).components || []) { const d = c._d || c; if (d.customId) modalFields[d.customId] = d.value; }
      replies.push({ modal: m?._d?.customId ?? 'modal', modalFields }); },
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
    const boot = async () => { for (const fn of listeners.clientReady || listeners.ready || []) await fn().catch(() => {}); await (lastClient?.mendDone || null); };
    await boot();
    const once = tableCounts(dbHandle);
    await boot();
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

  // ── The fight walk ────────────────────────────────────────────────────
  // Every button the bot offers in a fight is pressed against a seeded
  // fight, through the real interaction handler. Two failures are hunted:
  // SILENCE (no reply at all — Discord shows "didn't respond in time") and
  // the generic error reply ("Something went wrong"), which means a throw.
  // The three bugs of 2026-09-12 were all of these kinds, and no static
  // pin can see them.
  if (dbHandle) {
    const seedChar = (uid) => dbHandle.prepare(
      `INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current)
       VALUES ('G1', ?, 3, 3, 3, 3, 3, 7)`).run(uid);
    seedChar('U1'); seedChar('U2');
    dbHandle.prepare(`INSERT OR REPLACE INTO fights (guild_id, channel_id, state, turn_order, turn_index, phase, hp_state)
                      VALUES ('G1', 'C1', 'active', '["U1","U2"]', 0, 'attack', '{"U1":7,"U2":7}')`).run();

    // Strict: silence is a timeout, the generic error reply is a throw, and
    // so is ANYTHING the bot logged to console.error while handling the
    // press — the listener swallows throws into a log line and a reply.
    let logged = [];
    const realErr = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(' ')); };
    const silentOrThrew = (r) => {
      if (logged.length) return `THREW: ${logged[0].slice(0, 90)}`;
      if (!r.replies.length) return 'SILENT';
      const said = r.replies.map(x => JSON.stringify(x)).join(' ');
      if (/Something went wrong/.test(said)) return 'THREW';
      return null;
    };
    const walk = [
      ['fatk:str  (attack, no target → picker)', { isButton: true, customId: 'fatk:str' }],
      ['fact:feint (opens target picker)',       { isButton: true, customId: 'fact:feint' }],
      ['fact:grapple (opens target picker)',     { isButton: true, customId: 'fact:grapple' }],
      ['fightact:feint select → modal',          { isSelect: true, customId: 'fightact:feint:U1', values: ['U2'] }],
      ['fightfeint modal → runs the feint',      { isModal: true, customId: 'fightfeint:U2', fields: { claim: 'a lunge at the knee' } }],
      ['fightact:grapple select → runs it',      { isSelect: true, customId: 'fightact:grapple:U1', values: ['U2'] }],
      ['fighttarget select → attack lands',      { isSelect: true, customId: 'fighttarget:U1:str:normal:', values: ['U2'] }],
      ['fdef:dex (defend after that attack)',    { isButton: true, customId: 'fdef:dex', userId: 'U2', keepState: true }],
      ['fact:maintain (not holding → refusal)',  { isButton: true, customId: 'fact:maintain' }],
      ['grpfree (not holding → refusal)',        { isButton: true, customId: 'grpfree' }],
      ['fact:escape (not held → refusal)',       { isButton: true, customId: 'fact:escape' }],
    ];
    const broken = [];
    for (const [label, over] of walk) {
      // reset to a clean attack phase before each press
      if (!over.keepState)
        dbHandle.prepare(`UPDATE fights SET phase='attack', current_target=NULL, effect_state='{}', turn_index=0 WHERE guild_id='G1' AND channel_id='C1'`).run();
      logged = [];
      const r = await fire({ ...over, userId: over.userId || 'U1', message: { id: 'M9', content: '', components: [] } });
      const bad = silentOrThrew(r);
      if (bad) broken.push(`${label}: ${bad}`);
      if (VERBOSE) {
        const first = r.replies[0] || {};
        const gist = (first.content || (first.modal ? `modal ${first.modal}` : '') || JSON.stringify(first)).replace(/\s+/g, ' ').slice(0, 88);
        console.log(`      ${label.padEnd(42)} → ${gist}`);
      }
    }
    console.error = realErr;
    ok(`every fight button answers (${walk.length} presses)`, broken.length === 0, broken.join('\n        '));
  }

  // ── The encounter walk ────────────────────────────────────────────
  // Start one, join it, note into it, end it — through the real handler.
  if (dbHandle) {
    const broken = [];
    let logged = [];
    const realErr = console.error;
    console.error = (...a) => { logged.push(a.map(String).join(' ')); };
    const press = async (label, over) => {
      logged = [];
      const r = await fire(over);
      const said = r.replies.map(x => JSON.stringify(x)).join(' ');
      const bad = logged.length ? `THREW: ${logged[0].slice(0, 90)}` : !r.replies.length ? 'SILENT' : /Something went wrong/.test(said) ? 'THREW' : null;
      if (bad) broken.push(`${label}: ${bad}`);
      if (VERBOSE) console.log(`      ${label.padEnd(42)} → ${(r.replies[0]?.content || JSON.stringify(r.replies[0] || {})).replace(/\s+/g, ' ').slice(0, 300)}`);
      return r;
    };
    // Autocomplete for the room must answer with the rooms.
    const ac = await press('feedback room autocomplete', { commandName: 'feedback', isAutocomplete: true, options: { _sub: 'send', _focused: 'room', _focusedValue: '' } });
    const choices = ac.replies.find(r => r.autocomplete)?.autocomplete || [];
    ok('the room autocomplete lists the rooms', choices.length > 0 && choices.every(c => typeof c.name === 'string' && !/object/.test(c.name)),
      `got ${choices.length}: ${choices.slice(0, 3).map(c => c.name).join(' | ')}`);
    // /char set value: offers a list that follows the field (T, 2026-10-12: the emoji field had nothing to pick from).
    const acOf = async (field, typed = '') => (await press(`/char set ${field} value autocomplete`, { commandName: 'char', isAutocomplete: true, options: { _sub: 'set', field, _focused: 'value', _focusedValue: typed } })).replies.find(r => r.autocomplete)?.autocomplete || [];
    const acEmoji = await acOf('weapon2emoji'), acOrder = await acOf('order'), acClass = await acOf('class'), acStat = await acOf('str', '4'), acOrderTyped = await acOf('order', 'gre');
    ok('/char set value: lists the weapon emojis for an emoji field, the orders for order, the classes for class, and echoes a number for a stat',
      acEmoji.length >= 7 && acEmoji.some(c => c.value === '⚔️') && acOrder.length === 8 && acClass.length === 3 && acClass.some(c => c.value === 'Siege Knight')
        && acStat.length === 1 && acStat[0].value === '4' && acOrderTyped.length === 2 && acOrderTyped.every(c => /Green|Grey/.test(c.name)),
      `emoji ${acEmoji.length} · order ${acOrder.length} · class ${acClass.length} · stat ${JSON.stringify(acStat)} · 'gre' ${acOrderTyped.map(c => c.name).join(',')}`);
    // Every field that used to be bare text now answers with a list (T, 2026-10-12).
    const acAny = async (commandName, options) => (await press(`${commandName} ${options._focused} autocomplete`, { commandName, isAutocomplete: true, options })).replies.find(r => r.autocomplete)?.autocomplete;
    await fire({ commandName: 'char', options: { _group: 'profile', _sub: 'save', slotname: 'vault' }, userId: 'U1' });
    const acCases = [
      ['char profile load slotname', await acAny('char', { _group: 'profile', _sub: 'load', _focused: 'slotname', _focusedValue: '' }), (c) => c.some(x => x.value === 'vault')],
      ['char weapon add atk', await acAny('char', { _group: 'weapon', _sub: 'add', _focused: 'atk', _focusedValue: '' }), (c) => c.some(x => x.value === 'str|dex') && c.some(x => x.value === 'any')],
      ['dnd create saves', await acAny('dnd', { _sub: 'create', _focused: 'saves', _focusedValue: 'str, ' }), (c) => c.length === 5 && c.every(x => x.value.startsWith('str, '))],
      ['dnd create skills', await acAny('dnd', { _sub: 'create', _focused: 'skills', _focusedValue: 'perc' }), (c) => c.length === 1 && c[0].value === 'perception'],
      ['config mechanics rest hp', await acAny('config', { _group: 'mechanics', _sub: 'rest', _focused: 'hp', _focusedValue: '' }), (c) => c.some(x => x.value === '100%')],
      ['gm backup auto channel', await acAny('gm', { _group: 'backup', _sub: 'auto', _focused: 'channel', _focusedValue: '' }), (c) => c[0]?.value === 'off'],
      ['standing title grant title (free)', await acAny('standing', { _group: 'title', _sub: 'grant', _focused: 'title', _focusedValue: 'Siren', user: 'U2' }), (c) => c.some(x => x.value === 'Siren')],
      ['char weaponemoji custom', await acAny('char', { _sub: 'weaponemoji', _focused: 'custom', _focusedValue: '' }), (c) => Array.isArray(c)],
      ['char tag custom emoji', await acAny('char', { _group: 'tag', _sub: 'custom', _focused: 'emoji', _focusedValue: '' }), (c) => c.some(x => x.value === '⚔️')],
      ['activity set value (roll)', await acAny('activity', { _sub: 'set', name: 'Probe', scene: 'start', field: 'roll', _focused: 'value', _focusedValue: '' }), (c) => c.some(x => x.value === 'str|dex|wis')],
      ['encounter preset save npcs', await acAny('encounter', { _group: 'preset', _sub: 'save', _focused: 'npcs', _focusedValue: 'Gob' }), (c) => Array.isArray(c)],
      ['gm search name', await acAny('gm', { _sub: 'search', _focused: 'name', _focusedValue: '' }), (c) => c.length > 0],
      ['spell prepare add', await acAny('spell', { _sub: 'prepare', _focused: 'add', _focusedValue: 'Fire' }), (c) => c.some(x => x.value === 'Fire')],
    ];
    const acBad = acCases.filter(([, c, test]) => !Array.isArray(c) || !test(c)).map(([n, c]) => `${n}: ${JSON.stringify(c)?.slice(0, 80)}`);
    ok(`every field that used to be bare text answers with a list (${acCases.length} checked)`, acBad.length === 0, acBad.join(' | '));
    // Edit (DDice): a bot message opens a prefilled modal; the save edits it.
    const botMsg = await chan.send({ content: 'after much effort and some accidents, the party would make it' });
    const e1 = await press('Edit (DDice) on a bot message', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: botMsg });
    ok('editing a bot message opens the modal', /botedit:C1:/.test(JSON.stringify(e1.replies)));
    const e2 = await press('botedit modal → saved',   { isModal: true, customId: `botedit:C1:${botMsg.id}`, fields: { text: 'After much effort and some accidents, the party made it.' } });
    ok('the edit lands on the message', /^After much effort/.test(botMsg.content), `content now: ${botMsg.content.slice(0, 40)}`);
    // NPC speech: a webhook message whose hook the bot holds is editable too.
    dbHandle.prepare(`INSERT OR REPLACE INTO npc_webhooks (guild_id, channel_id, npc_name, webhook_id, webhook_token) VALUES ('G1','C1','__shared__','WH1','tok')`).run();
    const npcMsg = await chan.send({ content: 'Thats the beauty of it' });
    npcMsg.author = { id: 'WH1' }; npcMsg.webhookId = 'WH1';
    const e3 = await press('Edit (DDice) on NPC speech', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: npcMsg });
    ok('NPC speech opens the modal', /botedit:C1:/.test(JSON.stringify(e3.replies)));
    await press('botedit modal on NPC speech → saved', { isModal: true, customId: `botedit:C1:${npcMsg.id}`, fields: { text: "That's the beauty of it" } });
    ok('the NPC edit lands through the webhook', /^That's/.test(npcMsg.content), `content: ${npcMsg.content}`);
    const notMine = { id: 'X1', content: 'hi', author: { id: 'U2' }, channelId: 'C1', components: [] };
    await press('Edit (DDice) on a player message → refusal', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: notMine });
    // A hook the table has forgotten (a clean-up, a restore from backup) that the
    // channel still carries: the channel is asked, the hook remembered, the edit lands.
    chan._hooks = [{ id: 'WH2', token: 'tok2', owner: { id: 'BOT' } }, { id: 'WHX', token: 'tokx', owner: { id: 'SOMEONE' } }];
    const npcMsg2 = await chan.send({ content: 'The road is closed' });
    npcMsg2.author = { id: 'WH2' }; npcMsg2.webhookId = 'WH2';
    const e4 = await press('Edit (DDice) on NPC speech through a forgotten hook', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: npcMsg2 });
    ok('NPC speech through a hook the table forgot still opens the modal — the channel is asked for it', /botedit:C1:/.test(JSON.stringify(e4.replies)), JSON.stringify(e4.replies).slice(0, 140));
    ok('the forgotten hook is remembered once found', !!dbHandle.prepare("SELECT 1 FROM npc_webhooks WHERE guild_id='G1' AND channel_id='C1' AND webhook_id='WH2' AND webhook_token='tok2'").get());
    await press('botedit modal through the remembered hook → saved', { isModal: true, customId: `botedit:C1:${npcMsg2.id}`, fields: { text: 'The road is open' } });
    ok('the edit lands through the remembered hook', /^The road is open/.test(npcMsg2.content), npcMsg2.content);
    // Someone else's hook, and one gone from Discord altogether: refused, with the reason and the remedy.
    const npcMsgX = await chan.send({ content: 'Not ours' }); npcMsgX.author = { id: 'WHX' }; npcMsgX.webhookId = 'WHX';
    const e5 = await press('Edit (DDice) on speech through another app\'s hook → refusal', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: npcMsgX });
    const npcMsg3 = await chan.send({ content: 'Said through a hook that is gone' }); npcMsg3.author = { id: 'WH3' }; npcMsg3.webhookId = 'WH3';
    const e6 = await press('Edit (DDice) on speech through a hook that no longer exists → refusal', { isContextMenu: true, commandName: 'Edit (DDice)', targetMessage: npcMsg3 });
    ok('speech through a hook that is not the bot\'s, or no longer exists, is refused with the reason and the remedy',
      [e5, e6].every(e => /no longer hold/.test(JSON.stringify(e.replies)) && /\/npc say/.test(JSON.stringify(e.replies)) && !/botedit:/.test(JSON.stringify(e.replies)))
        && !dbHandle.prepare("SELECT 1 FROM npc_webhooks WHERE guild_id='G1' AND webhook_id IN ('WHX','WH3')").get(),
      JSON.stringify([e5.replies, e6.replies]).slice(0, 200));
    // /edit: the same box from a private dropdown — no Apps menu, nothing the table sees (T, 2026-10-13).
    const withButtons = await chan.send({ content: 'a card with buttons', components: [{ _d: { components: [] } }] });
    const edL = await press('/edit lists the last lines here', { commandName: 'edit', options: {} });
    const edMenu = edL.replies[0]?.components?.[0]?._d?.components?.[0]?._d;
    const edOpts = edMenu?.options || [];
    ok('/edit answers privately with a dropdown of the bot\'s and NPCs\' lines here, newest first, buttons left out',
      edL.replies[0]?.ephemeral === true && edMenu?.customId === 'editpick' && edOpts.length > 0 && edOpts.length <= 25
        && edOpts.some(o => o.value === npcMsg2.id) && edOpts.some(o => o.value === botMsg.id)
        && !edOpts.some(o => o.value === notMine.id) && !edOpts.some(o => o.value === withButtons.id)
        && edOpts.every(o => o.label.length <= 100 && o.label.length > 0)
        && edOpts.map(o => o.value).join(',') === [...edOpts].sort((a, b) => (BigInt(a.value) < BigInt(b.value) ? 1 : -1)).map(o => o.value).join(','),
      `${edOpts.length} option(s): ${JSON.stringify(edOpts.slice(0, 3))}`);
    const edP = await press('editpick → modal', { isSelect: true, customId: 'editpick', values: [npcMsg2.id], message: edL.replies[0] });
    ok('picking a line opens the box prefilled', /botedit:C1:/.test(JSON.stringify(edP.replies)), JSON.stringify(edP.replies).slice(0, 120));
    const edS = await press('botedit modal from the dropdown → saved', { isModal: true, fromMessage: true, customId: `botedit:C1:${npcMsg2.id}`, fields: { text: 'The road is open again' } });
    ok('a save from the dropdown edits the line and turns the dropdown into the receipt',
      /^The road is open again/.test(npcMsg2.content) && edS.replies.some(r => /Edited/.test(r.content || '') && Array.isArray(r.components) && r.components.length === 0),
      `${npcMsg2.content} · ${JSON.stringify(edS.replies).slice(0, 120)}`);
    const edLink = await press('/edit link: → modal straight away', { commandName: 'edit', options: { link: `https://discord.com/channels/G1/C1/${botMsg.id}` } });
    ok('/edit link: opens the box for that message without the list', /botedit:C1:/.test(JSON.stringify(edLink.replies)), JSON.stringify(edLink.replies).slice(0, 120));
    const edBad = await press('/edit link: from another server → refusal', { commandName: 'edit', options: { link: `https://discord.com/channels/G9/C1/${botMsg.id}` } });
    ok('/edit link: refuses a link from another server', /not a message link or id from this server/.test(JSON.stringify(edBad.replies)), JSON.stringify(edBad.replies).slice(0, 120));
    // Archive: a bare archive opens the final-word box; the modal replays it.
    dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at) VALUES ('G1', 903, 'Done Run', 'completed', 'quest', 0)`).run();
    const a1 = await press('archive without summary → modal', { commandName: 'quest', options: { _sub: 'archive', number: 903 } });
    ok('archiving invites a final word', /questarch:903/.test(JSON.stringify(a1.replies)));
    await press('questarch modal → shelved with the word', { isModal: true, customId: 'questarch:903', fields: { summary: 'The siren sleeps. For now.' } });
    const rowA = dbHandle.prepare("SELECT status, archived_at, archive_summary FROM quests WHERE guild_id='G1' AND number=903").get();
    ok('a completed quest keeps its status and gains the word', rowA?.status === 'completed' && !!rowA?.archived_at && /siren/.test(rowA?.archive_summary || ''), JSON.stringify(rowA));
    // Presets → start → complete → Reopen → stalled: the whole new loop.
    // Encounters open in the instance forum from a roster picker (2026-10-08):
    // start → the picker lists the roster → tick → press → a thread opens.
    const forum = new FakeChannel('FORUM1', 15, 'quest-instances', guild);
    channelsById.set(forum.id, forum);
    setConfigProbe('quest_instance_forum', 'FORUM1');
    const openEncounter = async (label, options, users) => {
      const r0 = await press(`${label} (picker)`, { commandName: 'encounter', options: { _sub: 'start', ...options } });
      const rows = r0.replies[0]?.components || [];
      const menu = rows[0]?._d?.components?.[0]?._d || {};
      const sel = menu.customId || '';
      const anyJoin = rows.some(rw => (rw._d?.components || []).some(c => /encjoin|encleave/.test(c._d?.customId || '')));
      ok(`${label}: the picker lists the roster and offers no Join`, /^encpick:/.test(sel) && (menu.options || []).length >= 2 && !anyJoin, `${sel} · ${(menu.options || []).length} listed`);
      const key = sel.split(':')[1];
      if (!key) return { room: null, r: r0 };
      const n = threads.length;
      await press(`${label} (tick)`, { isSelect: true, customId: sel, values: users, message: { id: nextId(), content: 'x', components: [] } });
      const r2 = await press(`${label} (open)`, { isButton: true, customId: `encgo:${key}`, message: { id: nextId(), content: 'x', components: [] } });
      return { room: threads.length > n ? threads[threads.length - 1] : null, r: r2 };
    };
    dbHandle.prepare(`INSERT OR REPLACE INTO library_monsters (guild_id, name, hp, ac, attack, damage, str, dex, con, int, wis, cha) VALUES ('G1','Goblin',7,13,4,'1d6',8,14,10,10,8,8)`).run();
    await press('preset save',   { commandName: 'encounter', options: { _group: 'preset', _sub: 'save', name: 'Ridge bandits', merits: 3, npcs: 'Goblin x2' } });
    const { room: roomP } = await openEncounter('start from preset', { name: 'Bandits again', preset: 'Ridge bandits' }, ['U2']);
    const goblins = dbHandle.prepare("SELECT COUNT(*) AS n FROM npcs WHERE guild_id='G1' AND name LIKE 'Goblin %' AND is_temp=1").get()?.n || 0;
    ok('a preset summons its monsters as temps', goblins === 2, `got ${goblins}`);
    const enc2 = dbHandle.prepare("SELECT number, merit_reward FROM quests WHERE guild_id='G1' AND kind='encounter' ORDER BY number DESC LIMIT 1").get();
    ok('a preset carries its merits', enc2?.merit_reward === 3, `merits ${enc2?.merit_reward}`);
    const encRow = dbHandle.prepare("SELECT run_thread_id, run_channel_id FROM quests WHERE guild_id='G1' AND number=?").get(enc2?.number);
    ok('a picked encounter opens its own room in the instance forum', !!roomP && roomP.parentId === 'FORUM1' && /^🎯 /.test(roomP.name)
      && encRow?.run_thread_id === roomP.id && encRow?.run_channel_id === roomP.id, `${roomP?.name} · thread ${encRow?.run_thread_id}`);
    const seatedP = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=? AND user_id='U2'").get(enc2?.number);
    ok('the ticked player is seated by the press', seatedP?.state === 'party', `state ${seatedP?.state}`);
    ok('the room carries the card and the party is pulled in by mention', !!roomP && sent.some(x => x.channel === roomP.id && /<@U2>/.test(x.content))
      && sent.some(x => x.channel === roomP.id && /merits each at the end/.test(x.content)));
    ok('one pointer line lands where the command was run', sent.some(x => x.channel === 'C1' && /has begun/.test(x.content) && x.content.includes(`<#${roomP?.id}>`)));
    const before = dbHandle.prepare("SELECT merits FROM characters WHERE guild_id='G1' AND user_id='U2'").get()?.merits ?? 0;
    await press('encounter end (pays 3)', { commandName: 'encounter', options: { _sub: 'end' }, channel: roomP });
    const paid = dbHandle.prepare("SELECT merits FROM characters WHERE guild_id='G1' AND user_id='U2'").get()?.merits ?? 0;
    ok('completion pays the preset merits', paid - before === 3, `delta ${paid - before}`);
    await press('qreopen press (5-min undo)', { isButton: true, customId: `qreopen:${enc2.number}`, message: { id: 'M6', content: '', components: [], edit: async () => {} } });
    const back = dbHandle.prepare("SELECT merits FROM characters WHERE guild_id='G1' AND user_id='U2'").get()?.merits ?? 0;
    const st = dbHandle.prepare("SELECT status, winding_down FROM quests WHERE guild_id='G1' AND number=?").get(enc2.number);
    ok('reopen reverses the payout and releases the party', back === before && st?.status === 'active' && st?.winding_down === 1, `merits ${back}, ${JSON.stringify(st)}`);
    const st1 = await press('gm check stalled', { commandName: 'gm', options: { _group: 'check', _sub: 'stalled' } });
    ok('the stalled view names the reopened run', /Winding down, not completed/.test(JSON.stringify(st1.replies)));
    // The new GM views answer, and /help rules prints the table.
    await press('gm check usage',    { commandName: 'gm', options: { _group: 'check', _sub: 'usage' } });
    const hr = await press('help category:rules', { commandName: 'help', options: { category: 'rules' } });
    ok('/help rules prints the live table', /Ties keep the hold/.test(JSON.stringify(hr.replies)));
    const uses = dbHandle.prepare("SELECT SUM(count) AS n FROM command_uses WHERE guild_id='G1'").get()?.n || 0;
    ok('command use is being counted', uses > 0, `total ${uses}`);
    // Feedback: a named room goes straight to the modal; a bad name refuses.
    const fb1 = await press('feedback send room:general → modal', { commandName: 'feedback', options: { _sub: 'send', room: 'general' } });
    ok('a named feedback room opens the modal directly', /"modal":"fbm:general:0"/.test(JSON.stringify(fb1.replies)));
    await press('feedback send room:nope → refusal',   { commandName: 'feedback', options: { _sub: 'send', room: 'nope' } });
    await press('campaign create',   { commandName: 'campaign', options: { _sub: 'create', name: 'The Probe War', description: 'A test arc' } });
    const { room: roomW } = await openEncounter('encounter start', { name: 'Bandits on the ridge', merits: 2, campaign: 'The Probe War' }, ['U2']);
    const enc = dbHandle.prepare("SELECT number FROM quests WHERE guild_id='G1' AND kind='encounter' ORDER BY number DESC LIMIT 1").get();
    ok('an encounter row exists after start', !!enc);
    if (enc) {
      // Seats are the GM's: add from elsewhere lands in the room, remove from
      // inside it is the reply itself.
      await press('encounter add U1 (from C1)', { commandName: 'encounter', options: { _sub: 'add', user: 'U1' } });
      const addRow = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=? AND user_id='U1'").get(enc.number);
      ok('/encounter add seats a player', addRow?.state === 'party' && !!roomW && sent.some(x => x.channel === roomW.id && /<@U1> is seated/.test(x.content)), `state ${addRow?.state}`);
      await press('encounter add U1 again → already', { commandName: 'encounter', options: { _sub: 'add', user: 'U1' } });
      await press('encounter remove U1 (in the room)', { commandName: 'encounter', options: { _sub: 'remove', user: 'U1' }, channel: roomW });
      const remRow = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=? AND user_id='U1'").get(enc.number);
      ok('/encounter remove takes them out', !remRow, `state ${remRow?.state}`);
      await press('campaign show (GM)',       { commandName: 'campaign', options: { _sub: 'show', campaign: 'The Probe War' } });
      // The seat override: a second quest for U1 while the encounter runs
      // is allowed (encounters are exempt), so make a real clash first.
      dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at) VALUES ('G1', 900, 'Other Run', 'active', 'quest', 0)`).run();
      dbHandle.prepare(`INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 900, 'U2', 'party')`).run();
      dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at) VALUES ('G1', 901, 'Second Run', 'active', 'quest', 0)`).run();
      const r1 = await press('approve U2 onto a second quest → prompt', { commandName: 'quest', options: { _group: 'party', _sub: 'approve', number: 901, user: 'U2' } });
      ok('a clashing seat prompts for a second press', /Seat them anyway|One quest at a time/.test(JSON.stringify(r1.replies)));
      await press('seatover press → seated with audit',  { isButton: true, customId: 'seatover:901:U2', message: { id: 'M7', content: '', components: [] } });
      const seated = dbHandle.prepare("SELECT 1 FROM quest_members WHERE guild_id='G1' AND number=901 AND user_id='U2' AND state='party'").get();
      ok('the override actually seats them', !!seated);
      // Winding down: a kick departs rather than removes, the seat no
      // longer blocks another quest, and completion still pays them.
      dbHandle.prepare(`UPDATE quests SET winding_down=1 WHERE guild_id='G1' AND number=901`).run();
      await press('kick during winddown → departed', { commandName: 'quest', options: { _group: 'party', _sub: 'kick', number: 901, user: 'U2' } });
      const dep = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=901 AND user_id='U2'").get();
      ok('a kick from a winding-down run marks departed, not gone', dep?.state === 'departed', `state ${dep?.state}`);
      dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at) VALUES ('G1', 902, 'Third Run', 'active', 'quest', 0)`).run();
      dbHandle.prepare(`INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 900, 'U2', 'applied')`).run();
      const r2 = await press('approve U2 elsewhere while 901 winds down', { commandName: 'quest', options: { _group: 'party', _sub: 'approve', number: 902, user: 'U2' } });
      ok('a winding-down seat does not block another quest', !/Seat them anyway/.test(JSON.stringify(r2.replies)));
      await press('encounter end',            { commandName: 'encounter', options: { _sub: 'end', summary: 'They fled.' }, channel: roomW });
      const after = dbHandle.prepare("SELECT status FROM quests WHERE guild_id='G1' AND number=?").get(enc.number);
      ok('ending an encounter completes it', after?.status === 'completed', `status ${after?.status}`);
    }
    console.error = realErr;
    ok(`the encounter walk answers everywhere`, broken.length === 0, broken.join('\n        '));
  }

  // ── Every leaf answers ──────────────────────────────────────────────
  // The walks above press what they know about. This presses EVERYTHING
  // Discord was told exists — every subcommand of every command, with a
  // dummy value in every option — and fails on a throw or a silence. A
  // refusal is a fine answer; "the application did not respond" is not.
  // Five ReferenceErrors lived in unwalked leaves until 2026-10-11, each
  // one a command that had never once worked.
  ok('the ready path registered a command set to read back', registered.length > 0);
  if (dbHandle && registered.length) {
    const byName = new Map();
    for (const body of registered) for (const c of body) byName.set(c.name, c);
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));   // handlers that pace themselves run flat out
    const realErr = console.error;
    const logged = [];
    console.error = (...a) => { logged.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 3).join(' | ') : String(x)).join(' ')); };
    const dummy = (o, cmd, sub) => {
      if (o.choices?.length) return o.choices[0].value;
      switch (o.type) {
        case 'int': case 'num': return o.min ?? 1;
        case 'bool': return true;
        case 'user': return 'U2';
        case 'channel': return chan;
        case 'role': case 'file': return null;
        default: {
          const n = o.name;
          if (/^(npc|npcs|target_npc|redirect_npc)$/.test(n)) return 'Goblin';
          if (n === 'name') return cmd === 'npc' || cmd === 'library' ? 'Goblin' : 'Probe';
          if (n === 'dice' || n === 'notation') return '1d20';
          if (n === 'stat') return 'str';
          if (/^(players|targets|reveal)$/.test(n)) return '<@U2>';
          if (n === 'number') return '1';
          if (n === 'room') return 'general';
          return 'probe';
        }
      }
    };
    const leaves = [];
    for (const c of byName.values()) {
      if (c.contextMenu) continue;   // Edit (DDice) is a message context menu, not a slash leaf
      const subs = [...(c.subcommands || []).map(sc => ({ group: null, sub: sc })),
                    ...(c.groups || []).flatMap(g => (g.subcommands || []).map(sc => ({ group: g.name, sub: sc })))];
      if (!subs.length) leaves.push({ cmd: c.name, group: null, sub: null, opts: c.options || [] });
      for (const { group, sub } of subs) leaves.push({ cmd: c.name, group, sub: sub.name, opts: sub.options || [] });
    }
    const dead = [];
    let answered = 0;
    for (const leaf of leaves) {
      const options = { _group: leaf.group ?? undefined, _sub: leaf.sub ?? undefined };
      for (const o of leaf.opts) { const v = dummy(o, leaf.cmd, leaf.sub); if (v !== null && v !== undefined) options[o.name] = v; }
      logged.length = 0;
      let r;
      try { r = await fire({ commandName: leaf.cmd, options }); }
      catch (e) { dead.push(`/${leaf.cmd}${leaf.group ? ' ' + leaf.group : ''}${leaf.sub ? ' ' + leaf.sub : ''}: THREW ${String(e?.message || e).slice(0, 80)}`); continue; }
      const said = r.replies.map(x => JSON.stringify(x)).join(' ');
      const label = `/${leaf.cmd}${leaf.group ? ' ' + leaf.group : ''}${leaf.sub ? ' ' + leaf.sub : ''}`;
      if (VERBOSE) console.log(`      ${label.padEnd(34)} → ${(r.replies[0]?.content || JSON.stringify(r.replies[0] || {})).replace(/\s+/g, ' ').slice(0, 200)}`);
      const threw = logged.find(l => /Error|error|TypeError|ReferenceError/.test(l) && !/\[(temp-npcs|npcforum|quest|feedback-threads|setup|docs|backup)\]/.test(l));
      if (threw) dead.push(`${label}: THREW ${threw.slice(0, 100)}`);
      else if (!r.replies.length && !r.i.deferred) dead.push(`${label}: SILENT`);
      else if (/Something went wrong|hit an error/.test(said)) dead.push(`${label}: THREW ${said.slice(0, 100)}`);
      else answered++;
    }
    console.error = realErr;
    globalThis.setTimeout = realTimeout;
    ok(`every registered leaf answers (${answered} of ${leaves.length})`, dead.length === 0, dead.join('\n        '));
  }


  // ── Every static SQL statement compiles against the real schema ────
  if (dbHandle) {
    const bad = []; let n = 0; const seenSql = new Set();
    for (const m of src.matchAll(/(['"`])((?:SELECT|INSERT|UPDATE|DELETE|WITH)\b[\s\S]*?)\1/g)) {
      const sql = m[2];
      if (sql.includes('${') || (sql.includes('\n') && m[1] !== '`') || seenSql.has(sql)) continue;
      seenSql.add(sql); n++;
      try { dbHandle.prepare(sql); } catch (e) { bad.push(`${sql.replace(/\s+/g, ' ').slice(0, 90)} → ${e.message}`); }
    }
    ok(`every static SQL statement compiles (${n})`, bad.length === 0, bad.join('\n        '));
  }

  // ── The GM gate, and what a plain player can reach ──────────────────
  // Every leaf whose description marks it (GM) is fired by a member with no
  // permissions and no role; anything but a refusal fails, except the few
  // reads that are open on purpose. Three write leaves and all of /config
  // were open until 2026-10-11; nothing had ever tested the gate.
  if (dbHandle && registered.length) {
    const OPEN_ON_PURPOSE = new Set(['/encounter list', '/encounter preset list', '/campaign show', '/campaign list', '/npc sheet']);
    const byName = new Map();
    for (const body of registered) for (const c of body) byName.set(c.name, c);
    const plain = 'U7';
    const plainMember = { id: plain, roles: { cache: new Map() }, permissions: { has: () => false } };
    const realFetch = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetch(uid); if (uid === plain) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const realTimeoutG = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    const realErrG = console.error; console.error = () => {};
    const dummy = (o, cmd) => {
      if (o.choices?.length) return o.choices[0].value;
      switch (o.type) { case 'int': case 'num': return o.min ?? 1; case 'bool': return true; case 'user': return 'U2'; case 'channel': return chan; case 'role': case 'file': return null;
        default: return /npc/.test(o.name) ? 'Goblin' : o.name === 'name' ? (cmd === 'npc' ? 'Goblin' : 'Probe') : o.name === 'dice' || o.name === 'notation' ? '1d20' : o.name === 'stat' ? 'str' : o.name === 'number' ? '1' : 'probe'; }
    };
    const open = []; let checked = 0;
    for (const c of byName.values()) {
      if (c.contextMenu) continue;
      const leaves = [...(c.subcommands || []).map(s => ({ g: null, s })), ...(c.groups || []).flatMap(g => (g.subcommands || []).map(s => ({ g: g.name, s })))];
      const cmdGm = /\(GM|GM only|Admin/i.test(c.description || '');
      for (const { g, s } of (leaves.length ? leaves : [{ g: null, s: null }])) {
        const label = `/${c.name}${g ? ' ' + g : ''}${s ? ' ' + s.name : ''}`;
        if (!cmdGm && !/\(GM|GM only|GM\)|Admin/i.test(`${s?.description || ''}`)) continue;
        if (OPEN_ON_PURPOSE.has(label)) continue;
        checked++;
        const options = { _group: g ?? undefined, _sub: s?.name ?? undefined };
        for (const o of (s ? s.options : c.options) || []) { const v = dummy(o, c.name); if (v != null) options[o.name] = v; }
        const r = await fire({ commandName: c.name, options, userId: plain, member: plainMember }).catch(() => ({ replies: [] }));
        const said = r.replies.map(x => x.content || JSON.stringify(x)).join(' ');
        if (!/❌|⛔|⚠️/.test(said)) open.push(`${label} → ${said.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
    // The NPC sheet is open, but a hidden stat block stays hidden from a player.
    dbHandle.prepare("UPDATE guild_config SET npc_stats_visible=0 WHERE guild_id='G1'").run();
    const sheetR = await fire({ commandName: 'npc', options: { _sub: 'sheet', name: 'Goblin' }, userId: plain, member: plainMember }).catch(() => ({ replies: [] }));
    const sheetSaid = sheetR.replies.map(x => x.content || '').join(' ');
    ok('a player reading an NPC sheet does not see hidden stats', /Stats are the GM/.test(sheetSaid) && !/STR\s+\d/.test(sheetSaid), sheetSaid.slice(0, 120));
    guild.members.fetch = realFetch; globalThis.setTimeout = realTimeoutG; console.error = realErrG;
    ok(`every GM-marked leaf refuses a plain player (${checked} checked)`, open.length === 0, open.join('\n        '));
  }

  // ── Every chat shorthand answers ────────────────────────────────────
  {
    const realErrC = console.error; const loggedC = [];
    console.error = (...a) => { loggedC.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const bad = [];
    const mk = (text, uid = 'U1') => ({ content: text, author: { id: uid, bot: false }, guild, channel: chan, channelId: chan.id, member: { id: uid, roles: { cache: new Map() }, permissions: { has: () => true } }, attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    const lines = ['r 1d20+3 perception', 'ra 1d20', 'rd 1d20', '!r', 'r', 'rr', 'rra', 'rrd', '?r 1d20 dc:12', 'h @U2', 'heal @U2', 'hp', 'hp +2', 'hp 5 @U2', 'rerolls', 'srest', 'lrest', 'srest @U2', 'hpfull @U2', 'hphalf @U2', 'gmr 1d20+5 stealth', 'gmrs 1d20', '1d20', '2d6+1', 'str', 'dexa', 'wisd', '?lck', '!roll 3d6'];
    for (const text of lines) {
      replies.length = 0; loggedC.length = 0; const sentBefore = sent.length;
      try { for (const fn of listeners.messageCreate || []) await fn(mk(text)); }
      catch (e) { bad.push(`${text}: THREW ${e.message}`); continue; }
      const threw = loggedC.find(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined/.test(l));
      if (threw) bad.push(`${text}: ${threw.slice(0, 100)}`);
      else if (!replies.length && sent.length === sentBefore) bad.push(`${text}: SILENT`);
    }
    console.error = realErrC;
    ok(`every chat shorthand answers (${lines.length})`, bad.length === 0, bad.join('\n        '));
  }

  // ── Every scheduled tick runs once; the digest lands as a dated thread ──
  if (dbHandle) {
    const bad = [];
    // The leaf walk above unset most channels (every /config leaf fired with a
    // dummy); bootMend only mends a server that is set up, so point it back at
    // the character forum it made. Then a third boot: the one that seeds.
    const charForum = [...channelsById.values()].find(c => c.name === 'character-pages');
    if (charForum) dbHandle.prepare("UPDATE guild_config SET char_forum=? WHERE guild_id='G1'").run(charForum.id);
    // Two old update posts in gm-quest-log, one of them a player's own message, so the sweep has something to judge.
    const logId = dbHandle.prepare("SELECT quest_log_gm FROM guild_config WHERE guild_id='G1'").get()?.quest_log_gm;
    const logCh = logId ? channelsById.get(logId) : null;
    let oldPost = null, keepPost = null, humanPost = null;
    if (logCh) {
      oldPost = await logCh.send({ content: '📰 **What\'s new**\n\n**2026-09-29**\n· old lines' });
      keepPost = await logCh.send({ content: '🎉 **#001-Bandits again** complete! — a completion summary that must stay' });
      humanPost = await logCh.send({ content: '📰 **What\'s new** — but typed by a person' }); humanPost.author = { id: 'U1' };
    }
    // A Deploy mend thread already in gm-updates, made BEFORE the back-catalogue
    // will be (the seeding boot of 2026-10-11 did exactly this), so the tidy
    // pass has something to put right.
    const gmForumBefore = dbHandle.prepare("SELECT gm_updates_forum, gm_digest_forum FROM guild_config WHERE guild_id='G1'").get() || {};
    const gmForumCh = gmForumBefore.gm_updates_forum ? channelsById.get(gmForumBefore.gm_updates_forum) : null;
    const planted = gmForumCh ? await gmForumCh.threads.create({ name: '[11/10/2026] [WEEK 41] Sunday 11th of October 2026 · Deploy mend', message: { content: '🔧 **Deploy mend**\n\n· planted out of turn' } }) : null;
    const realTimeoutB = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    for (const fn of listeners.clientReady || listeners.ready || []) await fn().catch(e => bad.push('ready: ' + e.message));
    await (lastClient?.mendDone || null);
    globalThis.setTimeout = realTimeoutB;
    {
      const fid = dbHandle.prepare("SELECT gm_updates_forum FROM guild_config WHERE guild_id='G1'").get()?.gm_updates_forum;
      const live = threads.filter(t => t.parentId === fid && !deleted.includes(t.id)).sort((a, b) => Number(a.id) - Number(b.id));
      const keyOf = (t) => { const m = /^\[(\d\d)\/(\d\d)\/(\d{4})\].* · (.+)$/.exec(t.name); return m ? `${m[3]}${m[2]}${m[1]}${m[4] === "What's new" ? 0 : 1}` : null; };
      const keys = live.map(keyOf);
      const ordered = keys.every((k, i) => k && (i === 0 || k >= keys[i - 1]));
      ok('gm-updates reads in date order after the boot — What\'s new before Deploy mend on a day, the Deploy mend of the boot on top',
        ordered && live.length > 0 && / · Deploy mend$/.test(live[live.length - 1].name), live.map(t => t.name).join(' | '));
      ok('a dated thread that sat out of turn is re-posted into order and the old one deleted',
        !!planted && deleted.includes(planted.id) && live.some(t => t.name === planted.name && t.id !== planted.id)
          && sent.some(x => /re-posted into date order/.test(x.content)),
        planted ? `planted ${planted.id} deleted=${deleted.includes(planted.id)}` : 'no gm-updates forum before the boot');
      const dForum = dbHandle.prepare("SELECT gm_digest_forum, gm_digest_seeded_at FROM guild_config WHERE guild_id='G1'").get() || {};
      const seededDigests = threads.filter(t => t.parentId === dForum.gm_digest_forum && !deleted.includes(t.id));
      ok('the first boot with a digest forum posts this week\'s digest at once', !!dForum.gm_digest_seeded_at && seededDigests.length === 1 && / · Weekly digest$/.test(seededDigests[0].name), `${seededDigests.length} digest thread(s), seeded_at ${dForum.gm_digest_seeded_at}`);
    }
    ok('the forum-opening boot sweeps the bot\'s old update posts out of gm-quest-log and nothing else',
      !!oldPost && deleted.includes(oldPost.id) && !deleted.includes(keepPost.id) && !deleted.includes(humanPost.id),
      `old ${oldPost && deleted.includes(oldPost.id)} · summary kept ${keepPost && !deleted.includes(keepPost.id)} · human kept ${humanPost && !deleted.includes(humanPost.id)}`);
    ok('the sweep is reported in the Deploy mend thread', threads.some(t => / · Deploy mend$/.test(t.name)) && sent.some(x => /1 old update post removed from/.test(x.content)));
    dbHandle.prepare("UPDATE guild_config SET gm_digest_at=0 WHERE guild_id='G1'").run();   // a week has passed
    const realErrT = console.error; const loggedT = [];
    console.error = (...a) => { loggedT.push(a.map(String).join(' ')); };
    for (const t of ticks) {
      loggedT.length = 0;
      try { await t.fn(); } catch (e) { bad.push(`tick(${t.ms}ms): THREW ${e.message}`); continue; }
      const threw = loggedT.find(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined/.test(l));
      if (threw) bad.push(`tick(${t.ms}ms): ${threw.slice(0, 120)}`);
    }
    console.error = realErrT;
    ok(`every scheduled tick runs once (${ticks.length})`, bad.length === 0, bad.join('\n        '));
    const digestForum = dbHandle.prepare("SELECT gm_digest_forum FROM guild_config WHERE guild_id='G1'").get()?.gm_digest_forum;
    const digests = threads.filter(t => t.parentId === digestForum);
    ok('the weekly digest is a dated thread in gm-digest, titled by a Monday — the seeded one and the tick\'s', digests.length === 2 && digests.every(t => /\] Monday \d{1,2}(st|nd|rd|th) of [A-Z][a-z]+ \d{4} · Weekly digest$/.test(t.name)), digests.map(t => t.name).join(' | ') || 'none');
  }

  // ── The three update forums ─────────────────────────────────────────
  // The boot made them from the plan; the first boot with them posts the
  // whole back-catalogue as dated threads; the second boot posted nothing
  // more (the restart-survival pass above ran the ready path twice).
  if (dbHandle) {
    const cfgU = dbHandle.prepare("SELECT updates_forum, gm_updates_forum, gm_digest_forum, updates_seeded_at, changelog_seen FROM guild_config WHERE guild_id='G1'").get() || {};
    ok('the boot makes the updates, gm-updates and gm-digest forums', !!(cfgU.updates_forum && cfgU.gm_updates_forum && cfgU.gm_digest_forum), JSON.stringify(cfgU));
    const entries = [...src.matchAll(/\{ key: '(\d{4}-\d{2}-\d{2})', gm: \[/g)].map(m => m[1]);
    const inForum = (fid) => threads.filter(t => t.parentId === fid && !deleted.includes(t.id));   // the tidy pass re-posts; the old copy is gone
    const DATE_RE = /^\[\d{2}\/\d{2}\/\d{4}\] \[WEEK \d{1,2}\] (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}(st|nd|rd|th) of [A-Z][a-z]+ \d{4} · /;
    const gmAll = inForum(cfgU.gm_updates_forum), plT = inForum(cfgU.updates_forum);
    const gmT = gmAll.filter(t => / · What's new$/.test(t.name));
    ok('the deploy mend is a dated thread in gm-updates, reporting what the boot built', gmAll.some(t => / · Deploy mend$/.test(t.name) && DATE_RE.test(t.name)), gmAll.map(t => t.name).join(' | '));
    ok(`the back-catalogue is seeded once, oldest first, one dated thread per entry (${entries.length} entries)`,
      gmT.length === entries.length && gmT.every(t => DATE_RE.test(t.name)) && !!cfgU.updates_seeded_at && cfgU.changelog_seen === entries[0]
        && gmT.map(t => t.name.slice(1, 11)).join(',') === [...entries].reverse().map(k => k.split('-').reverse().join('/')).join(','),
      `gm threads ${gmT.length}: ${gmT.map(t => t.name).join(' | ')}`);
    ok('player entries go to the players\' forum, dated the same way', plT.length > 0 && plT.length <= entries.length && plT.every(t => DATE_RE.test(t.name)), plT.map(t => t.name).join(' | '));
    {
      // Nothing of the kind remains in gm-quest-log: whatever is there was swept (the seeded old post), nothing new was posted.
      const qlog = dbHandle.prepare("SELECT quest_log_gm FROM guild_config WHERE guild_id='G1'").get()?.quest_log_gm;
      const stray = sent.filter(x => x.channel === qlog && /What's new|Deploy mend|Weekly digest/.test(x.content) && x.msg.author?.id === 'BOT' && !deleted.includes(x.msg.id));
      ok('no What\'s new, Deploy mend or Weekly digest remains in gm-quest-log', stray.length === 0, stray.map(x => x.content.slice(0, 60)).join(' | '));
    }
  }

  // ── The clean slate: a fourth boot re-posts What's new with the detail beneath ──
  if (dbHandle) {
    const bad = [];
    const cfgR = dbHandle.prepare("SELECT gm_updates_forum, updates_forum FROM guild_config WHERE guild_id='G1'").get() || {};
    const gmForum = cfgR.gm_updates_forum ? channelsById.get(cfgR.gm_updates_forum) : null;
    const live = (fid) => threads.filter(t => t.parentId === fid && !deleted.includes(t.id));
    const msgsOf = (t) => sent.filter(x => x.channel === t.id && !deleted.includes(x.msg.id)).map(x => x.content);
    // Every What's new thread already carries the detail: a seeding boot posts the new shape from the start.
    const whatsNew = live(cfgR.gm_updates_forum).filter(t => / · What's new$/.test(t.name));
    const entries = [...src.matchAll(/\{ key: '(\d{4}-\d{2}-\d{2})', gm: \[/g)].map(m => m[1]);
    const gmEntryCount = (() => { const i = src.indexOf('const CHANGELOG = ['); const j = src.indexOf('\n];', i); return (src.slice(i, j).match(/\{ line: /g) || []).length; })();
    const detailed = whatsNew.filter(t => msgsOf(t).some(c => c.startsWith('**In detail**')));
    const bulletsMatch = whatsNew.every(t => { const ms = msgsOf(t); const bullets = (ms[0] || '').split('\n').filter(l => l.startsWith('· ')); const detail = ms.slice(1).join('\n'); return bullets.every(b => detail.includes(b)) && (detail.match(/^> /gm) || []).length >= bullets.length; });
    ok(`every GM What's new thread carries In detail beneath the bullets — each bullet repeated, a quoted paragraph under it (${gmEntryCount} entries)`,
      whatsNew.length === entries.length && detailed.length === whatsNew.length && bulletsMatch && gmEntryCount >= 25,
      `${whatsNew.length} threads, ${detailed.length} detailed, bullets ${bulletsMatch}, ${gmEntryCount} entry lines`);
    // A server seeded in the old shape: an old-form What's new thread (one archived, as a week-old one would be),
    // the re-seed marker unset. The fourth boot removes them and posts the catalogue again.
    const before = live(cfgR.gm_updates_forum).map(t => t.id);
    let oldA = null, oldB = null;
    if (gmForum) {
      oldA = await gmForum.threads.create({ name: '[25/09/2026] [WEEK 39] Friday 25th of September 2026 · What\'s new', message: { content: '📰 **What\'s new for GMs**\n\n· old shape, no detail' } });
      oldB = await gmForum.threads.create({ name: '[29/09/2026] [WEEK 40] Tuesday 29th of September 2026 · What\'s new', message: { content: '📰 **What\'s new for GMs**\n\n· old shape, archived' } });
      oldB.archived = true;
    }
    dbHandle.prepare("UPDATE guild_config SET gm_updates_reseeded_at=NULL WHERE guild_id='G1'").run();
    const realTimeoutR = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    for (const fn of listeners.clientReady || listeners.ready || []) await fn().catch(e => bad.push('ready: ' + e.message));
    await (lastClient?.mendDone || null);
    globalThis.setTimeout = realTimeoutR;
    const afterR = dbHandle.prepare("SELECT gm_updates_reseeded_at, changelog_seen FROM guild_config WHERE guild_id='G1'").get() || {};
    const nowNew = live(cfgR.gm_updates_forum).filter(t => / · What's new$/.test(t.name));
    const oldGone = !!oldA && !!oldB && deleted.includes(oldA.id) && deleted.includes(oldB.id) && before.filter(id => threads.find(t => t.id === id && / · What's new$/.test(t.name))).every(id => deleted.includes(id));
    const allNew = nowNew.every(t => !before.includes(t.id) && t.id !== oldA?.id && t.id !== oldB?.id);
    ok('the clean slate: old-shape What\'s new threads, archived ones included, are removed and the catalogue posted again, oldest first, detail beneath',
      bad.length === 0 && oldGone && allNew && nowNew.length === entries.length && nowNew.every(t => msgsOf(t).some(c => c.startsWith('**In detail**')))
        && nowNew.sort((a, b) => Number(a.id) - Number(b.id)).map(t => t.name.slice(1, 11)).join(',') === [...entries].reverse().map(k => k.split('-').reverse().join('/')).join(',')
        && !!afterR.gm_updates_reseeded_at && afterR.changelog_seen === entries[0],
      `${bad.join(' | ')} old gone ${oldGone} · all new ${allNew} · ${nowNew.length}/${entries.length} · marker ${afterR.gm_updates_reseeded_at}`);
    const plThreads = live(cfgR.updates_forum).filter(t => / · What's new$/.test(t.name));
    ok('the players\' forum is untouched by the clean slate — no thread removed, none posted twice',
      plThreads.length > 0 && plThreads.every(t => before.includes(t.id) || t.parentId !== cfgR.gm_updates_forum) && new Set(plThreads.map(t => t.name)).size === plThreads.length,
      plThreads.map(t => t.name).join(' | '));
    const mends = live(cfgR.gm_updates_forum).filter(t => / · Deploy mend$/.test(t.name)).sort((a, b) => Number(a.id) - Number(b.id));
    const last = live(cfgR.gm_updates_forum).sort((a, b) => Number(a.id) - Number(b.id)).pop();
    ok('the reseed boot\'s Deploy mend reports the clean slate and tops the forum',
      !!last && / · Deploy mend$/.test(last.name) && msgsOf(last).some(c => /What.s new thread\(s\) removed and the catalogue re-posted/.test(c)) && mends.length >= 1,
      last ? `${last.name}: ${msgsOf(last)[0]?.slice(0, 160)}` : 'no threads');
  }

  // ── An entry that grew after its thread was posted (two pushes in a day) ──
  // The newest entry's threads are made to look older than the entry: the
  // GM one loses its last bullet in the starter and its ledger row (as a
  // thread from before the ledger would); the players' one loses a bullet
  // too but has a GM's reply in it. A fifth boot re-posts the first whole
  // and appends beneath the second.
  if (dbHandle) {
    const bad = [];
    const cfgG = dbHandle.prepare("SELECT gm_updates_forum, updates_forum FROM guild_config WHERE guild_id='G1'").get() || {};
    const live = (fid) => threads.filter(t => t.parentId === fid && !deleted.includes(t.id));
    const msgsOf = (t) => sent.filter(x => x.channel === t.id && !deleted.includes(x.msg.id)).map(x => x.msg);
    const newest = [...src.matchAll(/\{ key: '(\d{4}-\d{2}-\d{2})', gm: \[/g)].map(m => m[1]).sort().pop();
    const title = (fid) => live(fid).find(t => t.name.startsWith(`[${newest.split('-').reverse().join('/')}]`) && / · What's new$/.test(t.name));
    const gmT = title(cfgG.gm_updates_forum), plT = title(cfgG.updates_forum);
    const dropLast = (t) => { const starter = msgsOf(t)[0]; const ls = starter.content.split('\n'); const last = ls.filter(l => l.startsWith('· ')).pop(); starter.content = ls.filter(l => l !== last).join('\n'); return last; };
    const gmLost = gmT ? dropLast(gmT) : null;
    dbHandle.prepare("DELETE FROM changelog_posted WHERE guild_id='G1' AND key=? AND audience='gm'").run(newest);
    const plLost = plT ? dropLast(plT) : null;
    const plRow = plT ? dbHandle.prepare("SELECT lines FROM changelog_posted WHERE guild_id='G1' AND key=? AND audience='player'").get(newest) : null;
    if (plT && plRow) dbHandle.prepare("UPDATE changelog_posted SET lines=? WHERE guild_id='G1' AND key=? AND audience='player'").run(JSON.stringify(JSON.parse(plRow.lines).filter(l => l !== plLost.slice(2))), newest);
    let human = null;
    if (plT) { human = await plT.send('thanks for this'); human.author = { id: 'U1' }; }
    const beforeMends = live(cfgG.gm_updates_forum).filter(t => / · Deploy mend$/.test(t.name)).length;
    const realTimeoutG = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    for (const fn of listeners.clientReady || listeners.ready || []) await fn().catch(e => bad.push('ready: ' + e.message));
    await (lastClient?.mendDone || null);
    globalThis.setTimeout = realTimeoutG;
    const gmNow = title(cfgG.gm_updates_forum);
    const gmRow = dbHandle.prepare("SELECT thread_id, lines FROM changelog_posted WHERE guild_id='G1' AND key=? AND audience='gm'").get(newest);
    const mendsNow = live(cfgG.gm_updates_forum).filter(t => / · Deploy mend$/.test(t.name)).sort((a, b) => Number(a.id) - Number(b.id));
    const mendText = mendsNow.length ? msgsOf(mendsNow[mendsNow.length - 1]).map(m => m.content).join('\n') : '';
    ok('a GM What\'s new thread that lacks a line the entry now has (and no ledger row) is deleted and posted again whole, the ledger written, the Deploy mend saying so',
      bad.length === 0 && !!gmT && !!gmLost && deleted.includes(gmT.id) && !!gmNow && gmNow.id !== gmT.id
        && msgsOf(gmNow)[0]?.content.includes(gmLost) && msgsOf(gmNow).some(m => m.content.startsWith('**In detail**'))
        && gmRow?.thread_id === gmNow.id && JSON.parse(gmRow?.lines || '[]').includes(gmLost.slice(2))
        && new RegExp(`What.s new ${newest.slice(8, 10)}/${newest.slice(5, 7)} re-posted with 1 new line\\(s\\)`).test(mendText),
      `${bad.join(' | ')} lost "${(gmLost || '').slice(0, 50)}" · old deleted ${gmT && deleted.includes(gmT.id)} · new ${gmNow?.id} · row ${gmRow?.thread_id} · mend: ${mendText.slice(0, 200)}`);
    const plNow = title(cfgG.updates_forum);
    const plMsgs = plT ? msgsOf(plT) : [];
    ok('a players\' thread someone has written in stays and gains "Added since this was posted" with the missing line',
      !!plT && !!plLost && !deleted.includes(plT.id) && plNow?.id === plT.id && !deleted.includes(human?.id)
        && plMsgs.some(m => m.content.startsWith('**Added since this was posted**') && m.content.includes(plLost))
        && /gained 1 line\(s\) beneath/.test(mendText),
      `kept ${plT && !deleted.includes(plT.id)} · ${plMsgs.map(m => m.content.slice(0, 40)).join(' | ')}`);
    ok('the Deploy mend of a boot that grew nothing says nothing about What\'s new',
      mendsNow.length === beforeMends + 1 && !/re-posted with 0 new|gained 0 line/.test(mendText), `${mendsNow.length} mends (was ${beforeMends})`);
  }

  // ── A target settles itself on a natural 20 or 1; anything else is the GM's call ──
  // Since 2026-10-13 a press opens the roleplay form and the form strikes;
  // nothing named is a d20 with every stat a button; stat: lists as few or
  // as many as the GM likes; a verdict opens the What-happens form,
  // prefilled with the flavour set at creation; a fail brings the card back
  // with a counter.
  if (dbHandle) {
    const realRandom = Math.random;
    const plant = async (name, opts = { stat: 'str', dc: 12 }) => {
      await fire({ commandName: 'target', options: { _sub: 'create', name, ...opts }, userId: 'U1' });
      return dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name=? ORDER BY at DESC").get(name);
    };
    const rowOf = (t) => dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND message_id=?").get(t.message_id);
    const cardOf = (t) => sentById.get(rowOf(t)?.card_id || t.card_id || t.message_id);
    const labelsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).label || ''));
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    // Press a button on the live card, fill the form, read what came of it.
    const strike = async (t, die, { stat = null, action = '', speech = '', userId = 'U2' } = {}) => {
      const card = cardOf(t);
      const press = await fire({ isButton: true, customId: stat ? `tgtatk:${stat}` : (idsOf(card)[0] || 'tgtatk'), message: card, userId }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] }));
      const modalId = press.replies.find(x => x.modal)?.modal;
      if (!modalId) return { said: press.replies.map(x => x.content || '').join(' '), modal: null, asked: false, dead: null, buttons: [] };
      Math.random = () => die;                      // rollDie = floor(r * sides) + 1
      const before = sent.length;
      const r = await fire({ isModal: true, fromMessage: true, customId: modalId, fields: { action, speech }, message: card, userId }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] }));
      Math.random = realRandom;
      const said = r.replies.map(x => x.content || '').join(' ');
      const asked = sent.slice(before).some(x => /Your call:/.test(x.content));
      const row = rowOf(t);
      return { said, modal: modalId, asked, dead: row?.dead, hits: row?.hits, cardId: row?.card_id, buttons: sent.slice(before).flatMap(x => labelsOf(x.msg)), verdictIds: sent.slice(before).flatMap(x => idsOf(x.msg)), prompt: sent.slice(before).find(x => /Your call:/.test(x.content))?.msg };
    };
    // The GM's call: press a verdict, fill (or leave) the What-happens form.
    const call = async (strikeR, fell, what = undefined) => {
      const id = strikeR?.verdictIds.find(x => new RegExp(`^tgtdie:.*:${fell ? 1 : 0}$`).test(x));
      if (!id) return null;
      const press = await fire({ isButton: true, customId: id, message: strikeR.prompt, userId: 'U1' }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] }));
      const modalId = press.replies.find(x => x.modal)?.modal;
      const prefill = press.replies.find(x => x.modal)?.modalFields?.what;
      if (!modalId) return { press, modal: null };
      const before = sent.length;
      // A real client submits the prefilled text unless the GM changes it: undefined = sent as is, '' = cleared.
      const r = await fire({ isModal: true, fromMessage: true, customId: modalId, fields: { what: what === undefined ? (prefill || '') : what }, message: strikeR.prompt, userId: 'U1' }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] }));
      return { press, modal: modalId, prefill, replies: r.replies, posted: sent.slice(before).map(x => x.content) };
    };
    if (!dbHandle.prepare("SELECT 1 FROM characters WHERE guild_id='G1' AND user_id='U2'").get())
      await fire({ commandName: 'char', options: { _sub: 'create', str: 3, con: 3, dex: 3, wis: 3, lck: 3 }, userId: 'U2' });
    const d20 = await plant('Probe door twenty', { stat: 'str', dc: 12, success_flavour: 'The door bursts inward.' });
    const r20 = d20 ? await strike(d20, 0.9999, { action: 'kicks the door', speech: 'Open, damn you' }) : null;
    ok('a press opens the action/speech form; the form strikes with the words above the roll',
      !!r20 && /^tgtrp:/.test(r20.modal || '') && /\*kicks the door\*/.test(r20.said) && /\u201COpen, damn you\u201D/.test(r20.said) && /with \*\*STR\*\*/.test(r20.said),
      r20 ? `modal ${r20.modal} · ${r20.said.slice(0, 120)}` : 'no target planted');
    ok('a natural 20 passes on its own — "Roll critically succeeds", the success flavour posted with it, the target beaten, the GM not asked',
      !!r20 && /Roll critically succeeds/.test(r20.said) && /\*The door bursts inward\.\*/.test(r20.said) && !r20.asked && r20.dead === 1,
      r20 ? `said ${r20.said.slice(0, 160)} · asked ${r20.asked} · dead ${r20.dead}` : 'no target planted');
    const d1 = await plant('Probe door one', { stat: 'str', dc: 12, fail_flavour: 'Not so much as a groan.' });
    const r1 = d1 ? await strike(d1, 0) : null;
    const d1row = d1 ? rowOf(d1) : null;
    ok('a natural 1 fails on its own — "Roll critically fails", the fail flavour with it — and the card comes back below with its buttons and a counter',
      !!r1 && /Roll critically fails/.test(r1.said) && /\*Not so much as a groan\.\*/.test(r1.said) && !r1.asked && r1.dead === 0
        && !!d1row?.card_id && d1row.card_id !== d1.message_id && idsOf(sentById.get(d1row.card_id)).length === 1
        && /Reposted 1\u00d7/.test(sentById.get(d1row.card_id)?.content || '') && /1 swing so far/.test(sentById.get(d1row.card_id)?.content || '')
        && (sentById.get(d1.message_id)?.components || []).length === 0 && /continues below/.test(sentById.get(d1.message_id)?.content || ''),
      r1 ? `said ${r1.said.slice(0, 120)} · dead ${r1.dead} · card ${d1.message_id}→${d1row?.card_id} · ${(sentById.get(d1row?.card_id)?.content || '').slice(0, 120)}` : 'no target planted');
    const dMid = await plant('Probe door middling', { stat: 'str', dc: 12, success_flavour: 'It gives.', fail_flavour: 'It holds.' });
    const rMid = dMid ? await strike(dMid, 0.5) : null;
    ok('any other roll says "The roll succeeds/fails" and asks the GM, naming the swing, with the two verdict buttons',
      !!rMid && rMid.asked && rMid.dead === 0 && /The roll (succeeds|fails)\./.test(rMid.said) && !/telling blow|glances off/.test(rMid.said)
        && /\(swing 1\)\. Your call:/.test(rMid.prompt?.content || '')
        && rMid.buttons.some(l => /The player passes the check/.test(l)) && rMid.buttons.some(l => /The player fails the check/.test(l)),
      rMid ? `asked ${rMid.asked} · ${rMid.said.slice(0, 80)} · ${(rMid.prompt?.content || '').slice(0, 80)} · buttons ${rMid.buttons.join(' | ')}` : 'no target planted');
    // The GM calls a fail: the form opens prefilled with the fail flavour; sent as is → the verdict line, the words, the card again.
    const failCall = rMid ? await call(rMid, false, 'It holds. Dust falls.') : null;
    const midRow = dMid ? rowOf(dMid) : null;
    ok('the GM\'s fail opens the What-happens form prefilled with the fail flavour; submit posts "Roll fails" with the words under it and brings the card back',
      !!failCall && /^tgtnar:.*:0$/.test(failCall.modal || '') && failCall.prefill === 'It holds.'
        && failCall.replies.some(r => /The player fails the check \\?\u2014? ?Roll fails\./.test(r.content || '') || /Roll fails\./.test(r.content || ''))
        && failCall.replies.some(r => /\*It holds\. Dust falls\.\*/.test(r.content || ''))
        && !!midRow && midRow.card_id !== dMid.message_id && midRow.dead === 0 && /Reposted 1\u00d7/.test(sentById.get(midRow.card_id)?.content || ''),
      `${failCall?.modal} · prefill ${JSON.stringify(failCall?.prefill)} · ${JSON.stringify(failCall?.replies).slice(0, 160)} · card ${dMid?.message_id}→${midRow?.card_id}`);
    const again = midRow ? await strike(midRow, 0.5) : null;
    ok('the next swing lands on the new card, hits carried, the prompt naming swing 2', !!again && again.asked && again.hits === 2 && /\(swing 2\)/.test(again.prompt?.content || ''), `asked ${again?.asked} hits ${again?.hits} · ${(again?.prompt?.content || '').slice(0, 80)}`);
    // The GM calls a pass with the form left blank: the bare verdict, the target beaten.
    const passCall = again ? await call(again, true, '') : null;
    const midRow2 = dMid ? rowOf(dMid) : null;
    ok('the GM\'s pass with the form cleared still posts "Roll succeeds", nothing under it, and beats the target',
      !!passCall && /^tgtnar:.*:1$/.test(passCall.modal || '') && passCall.prefill === 'It gives.' && passCall.replies.some(r => /Roll succeeds\./.test(r.content || '') && !/\*It gives\.\*/.test(r.content || '')) && midRow2?.dead === 1
        && /beaten after 2 hits/.test(sentById.get(midRow2.card_id)?.content || ''),
      `${passCall?.modal} · ${JSON.stringify(passCall?.replies).slice(0, 120)} · dead ${midRow2?.dead} · ${(sentById.get(midRow2?.card_id)?.content || '').slice(0, 60)}`);
    // Nothing named: a d20, every stat a button, no DC — the GM calls each blow.
    const dAny = await plant('Probe door bare', {});
    const anyCard = dAny ? cardOf(dAny) : null;
    const anyIds = idsOf(anyCard);
    ok('/target create with nothing but a name posts a d20 target with the five stat buttons and no DC',
      !!dAny && dAny.dc === null && dAny.stat === null && dAny.dice === null && anyIds.join(',') === 'tgtatk:str,tgtatk:con,tgtatk:dex,tgtatk:wis,tgtatk:lck'
        && /any stat/.test(anyCard?.content || '') && /the GM calling each blow/.test(anyCard?.content || ''),
      dAny ? `dc ${dAny.dc} stat ${dAny.stat} dice ${dAny.dice} · ${anyIds.join(',')} · ${(anyCard?.content || '').slice(0, 80)}` : 'no target planted');
    const rDex = dAny ? await strike(dAny, 0.5, { stat: 'dex' }) : null;
    ok('pressing a stat button swings with that stat, and with no DC the GM is asked',
      !!rDex && /with \*\*DEX\*\*/.test(rDex.said) && rDex.asked && !/The roll (succeeds|fails)/.test(rDex.said),
      rDex ? `${rDex.said.slice(0, 100)} · asked ${rDex.asked}` : 'no target planted');
    // A listed set: as few or as many as the GM likes, Flat d20 among them, in the order typed.
    const dTwo = await plant('Probe door two', { stat: 'Flat d20, STR, dex', dc: 10 });
    const twoCard = dTwo ? cardOf(dTwo) : null;
    ok('stat: lists stats — "Flat d20, STR, dex" gives three buttons in that order, the card naming them',
      !!dTwo && dTwo.stat === 'x,str,dex' && idsOf(twoCard).join(',') === 'tgtatk:x,tgtatk:str,tgtatk:dex' && /a flat d20\*\*, \*\*STR\*\* or \*\*DEX/.test(twoCard?.content || ''),
      `stat ${dTwo?.stat} · ${idsOf(twoCard).join(',')} · ${(twoCard?.content || '').slice(0, 100)}`);
    const rFlat = dTwo ? await strike(dTwo, 0.5, { stat: 'x' }) : null;
    ok('the flat button rolls a bare d20', !!rFlat && /with a flat d20/.test(rFlat.said), rFlat?.said.slice(0, 80));
    const acT = await fire({ commandName: 'target', isAutocomplete: true, options: { _sub: 'create', _focused: 'stat', _focusedValue: 'Flat d20, s' } });
    const acTc = acT.replies.find(r => r.autocomplete)?.autocomplete || [];
    ok('stat: autocompletes item by item, Flat d20 first in the full list', acTc.some(c => c.value === 'Flat d20, STR') && !acTc.some(c => /Flat d20, Flat/.test(c.value)),
      JSON.stringify(acTc).slice(0, 120));
    const acT0 = await fire({ commandName: 'target', isAutocomplete: true, options: { _sub: 'create', _focused: 'stat', _focusedValue: '' } });
    const acT0c = acT0.replies.find(r => r.autocomplete)?.autocomplete || [];
    ok('an empty stat: offers Flat d20 then the five stats', acT0c.map(c => c.value).join('|') === 'Flat d20|STR|CON|DEX|WIS|LCK', acT0c.map(c => c.value).join('|'));
    const bad = await fire({ commandName: 'target', options: { _sub: 'create', name: 'Probe door bad', stat: 'str, charisma' }, userId: 'U1' });
    ok('a word that is not a stat is refused with the list', /Stats I know/.test(JSON.stringify(bad.replies)), JSON.stringify(bad.replies).slice(0, 100));
    const dDice = await plant('Probe door dice', { dice: '2d6+1' });
    const diceCard = dDice ? cardOf(dDice) : null;
    ok('dice named: one attack button, the roll is the dice', !!dDice && idsOf(diceCard).join(',') === 'tgtatk' && /\*\*2d6\+1\*\*/.test(diceCard?.content || ''), idsOf(diceCard).join(','));
    // secret: the prompt goes to the checks shelf, the players get their own line with the words.
    const chk = new FakeChannel(nextId(), 0, 'gm-checks', guild); channelsById.set(chk.id, chk);
    dbHandle.prepare("INSERT INTO guild_config (guild_id, roll_audit_channel_id) VALUES ('G1', ?) ON CONFLICT(guild_id) DO UPDATE SET roll_audit_channel_id=excluded.roll_audit_channel_id").run(chk.id);
    const dSec = await plant('Probe door secret', { stat: 'str', dc: 12, secret: true, success_flavour: 'The lock clicks.' });
    const rSec = dSec ? await strike(dSec, 0.5) : null;
    const secPrompt = sent.slice().reverse().find(x => /Probe door secret.*Your call:/.test(x.content));
    const secCall = rSec ? await call({ ...rSec, prompt: secPrompt?.msg, verdictIds: idsOf(secPrompt?.msg) }, true) : null;
    const playersLine = sent.slice().reverse().find(x => x.channel === 'C1' && /^\u2705 \*\*Roll succeeds\.\*\*/.test(x.content));
    ok('secret: the prompt leaves the channel and the players still get "Roll succeeds" with the words in theirs',
      !!rSec && !!secPrompt && secPrompt.channel !== 'C1' && !sent.some(x => x.channel === 'C1' && /Probe door secret.*Your call:/.test(x.content))
        && !!secCall?.modal && secCall.prefill === 'The lock clicks.' && !!playersLine && /\*The lock clicks\.\*/.test(playersLine.content),
      `asked-here ${rSec?.asked} · prompt in ${secPrompt?.channel} · modal ${secCall?.modal} · ${playersLine?.content?.slice(0, 80)}`);
  }

  // ── One NPC, one page ───────────────────────────────────────────────
  // T's screenshot (2026-10-13): every NPC page twice, sixteen minutes old —
  // two boot tasks writing the forum at once, and a page whose row was lost
  // being made again. Three guards: one writer per page at a time, adoption
  // of the thread already bearing the name, and the mend folding copies back.
  if (dbHandle) {
    let npcForum = [...channelsById.values()].find(c => c.type === 15 && c.name === 'npc-character-sheets');
    if (!npcForum) { npcForum = new FakeChannel(nextId(), 15, 'npc-character-sheets', guild); channelsById.set(npcForum.id, npcForum); }
    dbHandle.prepare("UPDATE guild_config SET npc_forum=? WHERE guild_id='G1'").run(npcForum.id);
    const NAME = 'Probe Hollow';
    dbHandle.prepare("INSERT OR REPLACE INTO npcs (guild_id, name, str, con, dex, wis, lck, hp_current) VALUES ('G1', ?, 3, 3, 3, 3, 3, 7)").run(NAME);
    dbHandle.prepare("DELETE FROM npc_pages WHERE guild_id='G1' AND name=?").run(NAME);
    const pages = () => threads.filter(t => t.parentId === npcForum.id && !deleted.includes(t.id) && t.name === NAME);
    const rowOf = () => dbHandle.prepare("SELECT thread_id, message_id FROM npc_pages WHERE guild_id='G1' AND name=?").get(NAME);
    const sync = () => fire({ commandName: 'npc', options: { _group: 'manage', _sub: 'sync', name: NAME }, userId: 'U1' }).catch(() => null);
    const realTimeoutN = globalThis.setTimeout; globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    const realErrN = console.error; const loggedN = []; console.error = (...a) => { loggedN.push(a.map(String).join(' ')); };
    await Promise.all([sync(), sync()]);
    ok('two writers making one NPC\'s page at once make one thread, not two', pages().length === 1 && rowOf()?.thread_id === pages()[0]?.id, `${pages().length} page(s) · row ${rowOf()?.thread_id} · ${loggedN[0] || ''}`);
    const firstId = pages()[0]?.id;
    dbHandle.prepare("DELETE FROM npc_pages WHERE guild_id='G1' AND name=?").run(NAME);
    await sync();
    ok('a page whose row was lost is adopted by its name, not made again', pages().length === 1 && pages()[0].id === firstId && rowOf()?.thread_id === firstId, `${pages().length} page(s) · row ${rowOf()?.thread_id} · first ${firstId}`);
    // Two stray copies, one archived, and a third someone wrote in: the mend folds the first two, reports the third.
    const dup1 = await npcForum.threads.create({ name: NAME, message: { content: 'copy one' } });
    const dup2 = await npcForum.threads.create({ name: NAME, message: { content: 'copy two' } }); dup2.archived = true;
    const dup3 = await npcForum.threads.create({ name: NAME, message: { content: 'copy three' } });
    const human = await dup3.send('a GM wrote here'); human.author = { id: 'U1' };
    const mendR = await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'run' }, userId: 'U1' }).catch(() => ({ replies: [] }));
    const mendSaid = mendR.replies.map(x => x.content || JSON.stringify(x)).join(' ') + ' ' + sent.slice(-40).map(x => x.content).join(' ');
    ok('the mend folds duplicate pages back to the recorded one, leaves a copy someone wrote in, and reports both',
      deleted.includes(dup1.id) && deleted.includes(dup2.id) && !deleted.includes(dup3.id) && !deleted.includes(firstId) && pages().length === 2 && rowOf()?.thread_id === firstId
        && /2 duplicate NPC page\(s\) removed/.test(mendSaid) && /duplicate NPC page left in place: Probe Hollow \(someone wrote in the copy\)/.test(mendSaid),
      `dup1 ${deleted.includes(dup1.id)} dup2 ${deleted.includes(dup2.id)} dup3 kept ${!deleted.includes(dup3.id)} · ${pages().length} page(s) · row ${rowOf()?.thread_id} · ${mendSaid.replace(/\s+/g, ' ').slice(0, 200)}`);
    globalThis.setTimeout = realTimeoutN; console.error = realErrN;
  }

  // ── No button, modal or select id throws on a junk payload ──────────
  {
    const realErrJ = console.error; const loggedJ = [];
    console.error = (...a) => { loggedJ.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const bad = []; const ids = new Set();
    for (const m of src.matchAll(/setCustomId\(`?([a-zA-Z]+)[:`']/g)) ids.add(m[1]);
    for (const id of ids) {
      for (const shape of [{ isButton: true }, { isModal: true, fields: {} }, { isSelect: true, values: ['U2'] }]) {
        loggedJ.length = 0;
        const r = await fire({ ...shape, customId: `${id}:probe:1:2`, message: { id: nextId(), content: 'x', components: [], edit: async () => {} } }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] }));
        const said = r.replies.map(x => x.content || '').join(' ');
        const threw = loggedJ.find(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined/.test(l));
        if (threw || /hit an error|Something went wrong|^THREW/.test(said)) bad.push(`${id} (${Object.keys(shape)[0]}): ${(threw || said).replace(/\s+/g, ' ').slice(0, 110)}`);
      }
    }
    console.error = realErrJ;
    ok(`no button, modal or select id throws on a junk payload (${ids.size} ids × 3 lanes)`, bad.length === 0, bad.join('\n        '));
  }

  ok('no interaction was acknowledged twice anywhere in this run', doubleAcks.length === 0, doubleAcks.join('\n        '));

  report();
})().catch(e => {
  console.log(`${C.red}probe crashed${C.off}\n${e.stack}`);
  process.exit(1);
});

// The shim records the handle index.js opened, so probes can query the
// very same database the bot is using.
function findDb() { return lastDb; }
// Reaching into the loaded module: index.js keeps everything at module
// scope, so the probe drives it through the same interaction handler the
// gateway would — no exports needed.
function dbRun(sql) { try { lastDb.prepare(sql).run(); } catch (e) { /* probe-only */ } }
function setConfigProbe(key, val) {
  try {
    lastDb.prepare(`INSERT INTO guild_config (guild_id, ${key}) VALUES ('G1', ?)
                    ON CONFLICT(guild_id) DO UPDATE SET ${key}=excluded.${key}`).run(val);
  } catch (e) { /* probe-only */ }
}
function countBotMessages(thread) {
  return sent.filter(x => x.channel === thread.id).length;
}
// The mender is reached the way a GM would reach it: /gm check run.
async function callEnsureCharPage(g2, uid) {
  const r = await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'run' }, userId: uid });
  return r.replies.length > 0;
}
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
