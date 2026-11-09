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
    setChannelTypes(...t) { this._d.channelTypes = t.flat(); return this; }
    addComponents(...c) { this._d.components.push(...c.flat()); return this; }
    // The label style (discord.js 14.27): a label wraps one component; the
    // modal lists labels. Flattened into components so idsOf and the modal
    // field reader see the same shape as an action row's.
    addLabelComponents(...c) { for (const l of c.flat()) this._d.components.push({ _kind: 'label', _d: { label: l._d?.label, components: l._d?.components || [] } }); return this; }
    setTextInputComponent(c) { this._d.components = [c]; return this; }
    // A sent row read back as discord.js hands a fetched message's rows
    // over: each component with its customId, label, style and disabled
    // (2026-11-06 \u2014 /edit and the called-check scan read them so).
    get components() { return kind === 'row' ? this._d.components.map(c => { const d = c?._d || c || {}; return { customId: d.customId, label: d.label, style: d.style, disabled: !!d.disabled }; }) : undefined; }
    setUserSelectMenuComponent(c) { this._d.components = [c]; this._d.userSelect = true; return this; }
    setStringSelectMenuComponent(c) { this._d.components = [c]; return this; }
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
      create: async ({ name, message, appliedTags }) => {
        const t = new FakeChannel(nextId(), 11, name, guild);
        t.parentId = this.id; t._isThread = true; t.ownerId = 'BOT'; t.appliedTags = appliedTags || [];
        threads.push(t);
        channelsById.set(t.id, t);   // fetchable by id, as a real thread is
        // A forum post's first message is its starter, as Discord keeps it.
        if (message) t._starter = await t.send(message);
        t.fetchStarterMessage = async () => t._starter || null;
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
    this.createWebhook = async ({ name } = {}) => { const h = { id: nextId(), token: 'tok', owner: { id: 'BOT' }, name: name || 'DDice', delete: async () => {} }; this._hooks.push(h); hookHosts.set(h.id, this); return h; };
  }
  isThread() { return !!this._isThread; }
  isTextBased() { return true; }
  permissionsFor() { return { has: () => true }; }
  async setName(n) { this.name = n; }
  async setAppliedTags(t) { this.appliedTags = t; }
  // Discord gives every tag an id; a tag sent without one is new and gets one here.
  async setAvailableTags(t) { this.availableTags = t.map(x => ({ ...x, id: x.id || nextId() })); }
  async fetch() { return this; }
  async send(payload) {
    const content = typeof payload === 'string' ? payload : (payload?.content ?? '');
    const msg = {
      id: nextId(), content, channelId: this.id,
      components: (typeof payload === 'object' && payload?.components) || [],
      files: (typeof payload === 'object' && payload?.files) || [],
      replyTo: (typeof payload === 'object' && payload?.reply?.messageReference) || null,
      author: { id: 'BOT' }, editable: true,
      edit: async (p) => { msg.content = typeof p === 'string' ? p : (p?.content ?? msg.content); if (typeof p === 'object' && 'components' in p) msg.components = p.components; return msg; },
      delete: async () => { deleted.push(msg.id); },
      pin: async () => { msg.pinned = true; pinned.push(msg.id); },
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
const pinned = [];

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
const hookHosts = new Map();   // webhook id -> the channel that owns it (a fake send lands there)
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
  LabelBuilder: recorder('label'),
  UserSelectMenuBuilder: recorder('uselect'),
  StringSelectMenuBuilder: recorder('select'),
  ChannelSelectMenuBuilder: recorder('cselect'),
  AttachmentBuilder: class { constructor(a, b) { this.a = a; this.b = b; } },
  WebhookClient: class { constructor(o) { this.id = o?.id; }
    // A webhook send lands in the channel like any other message (the thread id picks the room), so /rp lines can be read back and edited.
    async send(p) { const ch = channelsById.get(p?.threadId) || hookHosts.get(this.id); const m = ch ? await ch.send({ content: typeof p === 'string' ? p : (p?.content ?? ''), components: p?.components || [] }) : { id: nextId() }; m.webhookId = this.id; m.author = { id: this.id, username: p?.username || 'hook' }; m.allowedMentions = p?.allowedMentions; return m; }
    async edit() {} async editMessage(id, p) { const m = sentById.get(id); if (m) m.content = p?.content ?? m.content; return m; }
    async deleteMessage(id) { if (sentById.has(id)) deleted.push(id); return true; } },
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
// A paper-thin canvas (2026-10-14): enough for the parchment paths to run
// end to end — text measures by length, every drawing call is a no-op, a
// buffer comes back — so the run's story scroll can be probed on the
// completion card. (verify.js keeps the canvas absent on purpose; that is
// the Railway-without-the-module path, and this is the other one.)
const fakeCanvas = (() => {
  const ctxOf = () => new Proxy({ measureText: (t) => ({ width: String(t).length * 20 }) }, {
    get: (o, k) => (k in o ? o[k] : (typeof k === 'string' && /^(create|get)/.test(k)) ? () => ({ addColorStop() {} }) : () => {}),
    set: () => true,
  });
  return {
    createCanvas: (w, h) => ({ width: w, height: h, getContext: () => ctxOf(), toBuffer: () => Buffer.from(`fake-image-${w}x${h}`) }),
    GlobalFonts: { registerFromPath: () => true, has: () => true },
  };
})();
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'discord.js') return fakeDiscord;
  if (request === '@napi-rs/canvas') return fakeCanvas;
  if (request === 'better-sqlite3') return makeSqliteShim();
  if (request === 'dotenv') return { config: () => ({}) };
  if (request === 'node-fetch') return async () => ({ ok: true, json: async () => ({}) });
  return realLoad.call(this, request, parent, isMain);
};

// index.js writes to a fixed path; give it somewhere it may write.
try { fs.mkdirSync('/app/data', { recursive: true }); } catch {}

process.env.DISCORD_TOKEN = 'probe';
// The GM run archive's backfill paces itself for Discord; here it need not.
process.env.DDICE_ARCHIVE_PACE_MS = '0';
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
    id: over.id || nextId(),   // a real interaction has one; the DC form keys its draft by it
    guild: over.guild || guild, guildId: (over.guild || guild).id, channel: over.channel || chan, channelId: (over.channel || chan).id,
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
    fields: { getTextInputValue: (n) => (over.fields || {})[n] ?? '',
      // discord.js 14.27: a modal's user picker, read back as a Collection of users; a string select as its values
      getSelectedUsers: (n) => new FakeCollection(((over.users || {})[n] || []).map(id => [id, { id, username: `user${id}` }])),
      getStringSelectValues: (n) => (over.selects && n in over.selects) ? over.selects[n] : [] },
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
    const alters = [...src.matchAll(/^try \{ db\.exec\(['"]ALTER TABLE (\w+) ADD COLUMN (\w+)/gm)];
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
    // Since 2026-10-14 every press opens the roleplay form (a modal whose id
    // carries a token) and the submit does the deed; the walk presses, reads
    // the modal id back, submits it with words, and checks the words landed.
    const broken = [];
    const say = (label, r) => { if (VERBOSE) { const first = r.replies[0] || {}; console.log(`      ${label.padEnd(42)} → ${(first.content || (first.modal ? `modal ${first.modal}` : '') || JSON.stringify(first)).replace(/\s+/g, ' ').slice(0, 88)}`); } };
    const step = async (label, over, { expectModal = false } = {}) => {
      logged = [];
      const sentBefore = sent.length;
      const r = await fire({ ...over, userId: over.userId || 'U1', message: over.message || { id: 'M9', content: '', components: [] } });
      const bad = silentOrThrew(r);
      if (bad) broken.push(`${label}: ${bad}`);
      const modal = r.replies.find(x => x.modal)?.modal || null;
      if (expectModal && !/^frp:/.test(modal || '')) broken.push(`${label}: expected the roleplay form, got ${JSON.stringify(r.replies[0] || {}).slice(0, 80)}`);
      say(label, r);
      const said = r.replies.map(x => x.content || '').join('\n') + '\n' + sent.slice(sentBefore).map(x => x.content).join('\n');
      return { r, modal, said, posted: sent.slice(sentBefore) };
    };
    const submit = async (label, modal, fields, over = {}) => {
      if (!modal) { broken.push(`${label}: no form to submit`); return { r: { replies: [] }, said: '' }; }
      logged = [];
      const sentBefore = sent.length;
      const r = await fire({ isModal: true, fromMessage: true, customId: modal, fields, userId: over.userId || 'U1', message: over.message || { id: 'M9', content: '', components: [] } });
      const bad = silentOrThrew(r);
      if (bad) broken.push(`${label}: ${bad}`);
      const said = r.replies.map(x => x.content || '').join('\n') + '\n' + sent.slice(sentBefore).map(x => x.content).join('\n');
      say(label, r);
      return { r, said, posted: sent.slice(sentBefore) };
    };
    const reset = () => dbHandle.prepare(`UPDATE fights SET phase='attack', current_target=NULL, effect_state='{}', grapples='{}', turn_index=0, turn_order='["U1","U2"]', atk_roll=NULL, def_roll=NULL, atk_kind=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    // 1 · attack: one opponent → the form at once; the words ride the card; the defender gets buttons.
    reset();
    const a1 = await step('fatk:str (one opponent → form)', { isButton: true, customId: 'fatk:str' }, { expectModal: true });
    const a2 = await submit('attack form → the card', a1.modal, { action: 'lunges low', speech: 'Have at you' });
    ok('an attack press opens the form and the submit posts the card with the words and the defence buttons',
      /\*lunges low\*/.test(a2.said) && /\u201CHave at you\u201D/.test(a2.said) && /Attacks .* with STR/.test(a2.said)
        && a2.r.replies.some(x => (x.components || []).some(row => ((row._d || row).components || []).some(b => (b._d || b).customId === 'fdef:str'))),
      a2.said.replace(/\s+/g, ' ').slice(0, 200));
    // 2 · defence: the form, the card, the Resolve button.
    const d1 = await step('fdef:dex (defend → form)', { isButton: true, customId: 'fdef:dex', userId: 'U2' }, { expectModal: true });
    const d2 = await submit('defence form → the card', d1.modal, { action: 'ducks under it' }, { userId: 'U2' });
    ok('a defence press opens the form and the submit posts the card with the words and Resolve',
      /\*ducks under it\*/.test(d2.said) && /Defends with DEX/.test(d2.said)
        && d2.r.replies.some(x => (x.components || []).some(row => ((row._d || row).components || []).some(b => (b._d || b).customId === 'fresolve'))),
      d2.said.replace(/\s+/g, ' ').slice(0, 160));
    // 3 · resolve: a GM's press asks what happens; the words sit under the outcome, above the hand-over.
    const r1 = await step('fresolve as GM → what-happens form', { isButton: true, customId: 'fresolve' }, { expectModal: true });
    const r2 = await submit('resolve form → the outcome', r1.modal, { what: 'Steel rings off the wall.' });
    ok('a GM\'s Resolve opens What happens? and the words land under the outcome, above the next turn',
      /_Steel rings off the wall\._/.test(r2.said) && r2.said.indexOf('_Steel rings off the wall._') < r2.said.indexOf("'s turn to attack") && /turn to attack/.test(r2.said),
      r2.said.replace(/\s+/g, ' ').slice(0, 220));
    // 4 · feint: picker → form with the claim → the feint runs with the words.
    reset();
    dbHandle.prepare("UPDATE characters SET wis=5 WHERE guild_id='G1' AND user_id='U1'").run();   // deception needs WIS 4+
    await step('fact:feint (opens target picker)', { isButton: true, customId: 'fact:feint' });
    const f1 = await step('fightact:feint select → form', { isSelect: true, customId: 'fightact:feint:U1', values: ['U2'] }, { expectModal: true });
    const f2 = await submit('feint form → the feint', f1.modal, { claim: 'a lunge at the knee', action: 'drops a shoulder' });
    ok('a feint pick opens the form with the claim; the submit runs it with the words', /lunge at the knee/.test(f2.said) && /drops a shoulder/.test(f2.said), f2.said.replace(/\s+/g, ' ').slice(0, 160));
    // 5 · grapple: picker → form → the hold is attempted; the captive's Save opens its form.
    reset();
    // A grip needs STR 4+ on Knightfall (2026-11-09).
    const strU1 = dbHandle.prepare("SELECT str FROM characters WHERE guild_id='G1' AND user_id='U1'").get()?.str ?? 0;
    dbHandle.prepare("UPDATE characters SET str=5 WHERE guild_id='G1' AND user_id='U1'").run();
    await step('fact:grapple (opens target picker)', { isButton: true, customId: 'fact:grapple' });
    const g1 = await step('fightact:grapple select → form', { isSelect: true, customId: 'fightact:grapple:U1', values: ['U2'] }, { expectModal: true });
    const g2 = await submit('grapple form → the attempt', g1.modal, { speech: 'Got you' });
    ok('a grapple pick opens the form; the submit makes the attempt with the words', /\u201CGot you\u201D/.test(g2.said) && /grapple|Grapple|hold/i.test(g2.said), g2.said.replace(/\s+/g, ' ').slice(0, 160));
    const sv1 = await step('fsave (captive → form)', { isButton: true, customId: 'fsave', userId: 'U2' }, { expectModal: true });
    const sv2 = await submit('save form → the save', sv1.modal, { action: 'twists away' }, { userId: 'U2' });
    ok('the Save press opens the form and the submit rolls it with the words', /_\*twists away\*_/.test(sv2.said) || /\*twists away\*/.test(sv2.said), sv2.said.replace(/\s+/g, ' ').slice(0, 160));
    dbHandle.prepare("UPDATE characters SET str=? WHERE guild_id='G1' AND user_id='U1'").run(strU1);
    // 6 · holds without a hold: refused before any form.
    reset();
    for (const [label, id] of [['fact:maintain (not holding → refusal)', 'fact:maintain'], ['grpfree (not holding → refusal)', 'grpfree'], ['fact:escape (not held → refusal)', 'fact:escape']]) {
      const x = await step(label, { isButton: true, customId: id });
      if (x.modal) broken.push(`${label}: opened a form with no hold`);
    }
    // 7 · three fighters: the picker comes first, then the form. An NPC's turn offers the GM its own buttons.
    dbHandle.prepare("INSERT OR REPLACE INTO npcs (guild_id, name, str, con, dex, wis, lck, hp_current) VALUES ('G1', 'Probe Hollow', 3, 3, 3, 3, 3, 7)").run();
    dbHandle.prepare(`UPDATE fights SET phase='attack', current_target=NULL, effect_state='{}', grapples='{}', turn_index=0, turn_order='["U1","U2","npc:Probe Hollow"]', hp_state='{"U1":7,"U2":7,"npc:Probe Hollow":7}', atk_roll=NULL, def_roll=NULL, atk_kind=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    const p1 = await step('fatk:str (two opponents → picker)', { isButton: true, customId: 'fatk:str' });
    const pickId = p1.r.replies[0]?.components?.[0]?._d?.components?.[0]?._d?.customId || '';
    const p2 = await step('fighttarget select → form', { isSelect: true, customId: pickId || 'fighttarget:U1:str:normal:', values: ['npc:Probe Hollow'] }, { expectModal: true });
    const p3 = await submit('attack form (NPC target) → the card', p2.modal, { action: 'swings high' });
    ok('with two opponents the picker comes first, then the form; the NPC defender\'s prompt carries the GM\'s 🎭 buttons',
      /^fighttarget:U1:str:normal:/.test(pickId) && /\*swings high\*/.test(p3.said)
        && [...p3.posted.map(x => x.msg), ...p3.r.replies].some(m => (m.components || []).some(row => ((row._d || row).components || []).some(b => (b._d || b).customId === 'fndef:str'))),
      `pick ${pickId} · ${p3.said.replace(/\s+/g, ' ').slice(0, 120)}`);
    const nd1 = await step('fndef:con as GM → form', { isButton: true, customId: 'fndef:con' }, { expectModal: true });
    const nd2 = await submit('NPC defence form → the card', nd1.modal, { action: 'raises a claw' });
    ok('the GM defends for the NPC by button: form, then the card as the NPC', /Defended as \*\*Probe Hollow\*\*/.test(nd2.said), nd2.said.replace(/\s+/g, ' ').slice(0, 120));
    const np0 = await step('fndef by a player → refused', { isButton: true, customId: 'fndef:con', userId: 'U2' });
    dbHandle.prepare(`UPDATE fights SET phase='attack', current_target=NULL, turn_index=2, atk_roll=NULL, def_roll=NULL, atk_kind=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    const na1 = await step('fnatk:str on the NPC\'s turn (GM) → picker', { isButton: true, customId: 'fnatk:str' });
    const npick = na1.r.replies[0]?.components?.[0]?._d?.components?.[0]?._d?.customId || '';
    const na2 = await step('fighttarget select (GM for the NPC) → form', { isSelect: true, customId: npick || 'fighttarget:npc%3AProbe%20Hollow:str:normal:', values: ['U2'] }, { expectModal: true });
    const na3 = await submit('NPC attack form → the card', na2.modal, { speech: 'Rrraagh' });
    ok('on an NPC\'s turn the GM attacks by button: picker, form, then the card as the NPC and the player\'s defence buttons',
      /^fighttarget:npc%3AProbe%20Hollow:str:normal:/.test(npick) && /Attacked as \*\*Probe Hollow\*\*/.test(na3.said)
        && na3.posted.some(x => (x.msg.components || []).some(row => ((row._d || row).components || []).some(b => (b._d || b).customId === 'fdef:str'))),
      `pick ${npick} · ${na3.said.replace(/\s+/g, ' ').slice(0, 120)}`);
    dbHandle.prepare(`UPDATE fights SET turn_order='["U1","U2"]', hp_state='{"U1":7,"U2":7}', turn_index=0, phase='attack', current_target=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    // 8 · conditions with a clock, and everyone's HP on the turn line.
    reset();
    const c1 = await step('/gm override condition (poisoned, 2 turns)', { commandName: 'gm', options: { _group: 'override', _sub: 'condition', user: 'U2', text: 'poisoned', turns: 2 } });
    const c1said = c1.r.replies.map(x => x.content || '').join(' ');
    const c2 = await step('/gm override condition on someone not in the fight', { commandName: 'gm', options: { _group: 'override', _sub: 'condition', user: 'U7', text: 'dazed' } });
    // an exchange: U1 attacks U2, U2 defends, resolve → U2's turn comes round: poisoned ticks to 1 and shows on the line with the HP of both
    const x1 = await step('fatk:str (→ form)', { isButton: true, customId: 'fatk:str' }, { expectModal: true });
    await submit('attack form', x1.modal, {});
    const x2 = await step('fdef:con (→ form)', { isButton: true, customId: 'fdef:con', userId: 'U2' }, { expectModal: true });
    await submit('defence form', x2.modal, {}, { userId: 'U2' });
    // Every fake member is an admin, so the Resolve press opens the GM's form; a blank one resolves.
    const x3p = await step('fresolve → form (everyone is a GM here)', { isButton: true, customId: 'fresolve', userId: 'U2' }, { expectModal: true });
    const x3 = await submit('resolve form, blank → the outcome', x3p.modal, { what: '' }, { userId: 'U2' });
    const x3said = x3.said;
    ok('a condition is set with its clock, refused for someone not in the fight, and on the fighter\'s next turn line it has ticked and sits beside everyone\'s HP',
      /\*\*userU2\*\* is \*\*poisoned\*\* \u2014 2 turns/.test(c1said) && /is not in this fight/.test(c2.r.replies.map(x => x.content || '').join(' '))
        && /\u{1FA79} \*\*poisoned\*\* \u2014 1 turn left/u.test(x3said) && /\u2764\uFE0F userU1 \d+\/\d+ \u00b7 userU2 \d+\/\d+/.test(x3said),
      `${c1said.slice(0, 80)} · ${x3said.replace(/\s+/g, ' ').slice(0, 220)}`);
    const c3 = await step('/gm override condition clear', { commandName: 'gm', options: { _group: 'override', _sub: 'condition', user: 'U2', text: 'poisoned', clear: true } });
    ok('a condition can be cleared by hand', /\*\*poisoned\*\* lifts from \*\*userU2\*\*/.test(c3.r.replies.map(x => x.content || '').join(' ')), JSON.stringify(c3.r.replies).slice(0, 100));
    dbHandle.prepare(`UPDATE fights SET turn_order='["U1","U2"]', hp_state='{"U1":7,"U2":7}', turn_index=0, phase='attack', current_target=NULL, effect_state='{}' WHERE guild_id='G1' AND channel_id='C1'`).run();
    const walk = { length: 25 };
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
      ['instance preset save npcs', await acAny('instance', { _group: 'preset', _sub: 'save', _focused: 'npcs', _focusedValue: 'Gob' }), (c) => Array.isArray(c)],
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
      const r0 = await press(`${label} (picker)`, { commandName: 'instance', options: { _sub: 'start', ...options } });
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
    await press('preset save',   { commandName: 'instance', options: { _group: 'preset', _sub: 'save', name: 'Ridge bandits', merits: 3, npcs: 'Goblin x2' } });
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
    await press('session complete (pays 3)', { commandName: 'session', options: { _sub: 'complete', summary: 'They scattered.' }, channel: roomP });
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
      await press('session add U1 by name (from C1)', { commandName: 'session', options: { _sub: 'add', user: 'U1', name: 'Bandits on the ridge' } });
      const addRow = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=? AND user_id='U1'").get(enc.number);
      ok('/session add seats a player on an instance by name, the line landing in its room', addRow?.state === 'party' && !!roomW && sent.some(x => x.channel === roomW.id && /<@U1> is seated/.test(x.content)), `state ${addRow?.state}`);
      await press('session add U1 again → already', { commandName: 'session', options: { _sub: 'add', user: 'U1', name: 'Bandits on the ridge' } });
      await press('session kick U1 (in the room)', { commandName: 'session', options: { _sub: 'kick', user: 'U1' }, channel: roomW });
      const remRow = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=? AND user_id='U1'").get(enc.number);
      ok('/session kick in the room takes them out', !remRow, `state ${remRow?.state}`);
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
      await press('session complete',         { commandName: 'session', options: { _sub: 'complete', summary: 'They fled.' }, channel: roomW });
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
    // /gm scroll opens its writing window before any await (a deferred
    // interaction cannot show a modal), so its gate is on the submit — probed below.
    const OPEN_ON_PURPOSE = new Set(['/instance list', '/instance preset list', '/session show', '/session turn', '/campaign show', '/campaign list', '/npc sheet', '/gm scroll']);
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
    const scrollSub = await fire({ isModal: true, customId: 'scrollwrite', fields: { body: 'By order of the crown' }, userId: plain, member: plainMember }).catch(() => ({ replies: [] }));
    ok('the scroll\'s writing window gates on the submit: a plain player\'s submit is refused', /Only GMs can unfurl props/.test(scrollSub.replies.map(x => x.content || '').join(' ')), JSON.stringify(scrollSub.replies).slice(0, 120));
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
    // The players' forum also carries the weekly chronicle (2026-10-14); only What's new is counted here.
    const gmAll = inForum(cfgU.gm_updates_forum), plT = inForum(cfgU.updates_forum).filter(t => / \u00b7 What's new$/.test(t.name));
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
        && msgsOf(gmNow).some(m => m.content.includes(gmLost)) && msgsOf(gmNow).some(m => m.content.startsWith('**In detail**'))
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
    const strU2 = dbHandle.prepare("SELECT str FROM characters WHERE guild_id='G1' AND user_id='U2'").get()?.str ?? 0;
    const midTotal = 11 + strU2;   // a die of 11 plus the stat: meets DC 12 only with the real total, never with NaN
    const dMid = await plant('Probe door middling', { stat: 'str', dc: Math.min(12, midTotal), success_flavour: 'It gives.', fail_flavour: 'It holds.' });
    const rMid = dMid ? await strike(dMid, 0.5) : null;
    ok('a roll that meets the DC says "The roll succeeds" and asks the GM with the number and the swing \u2014 never NaN \u2014 with the two verdict buttons',
      !!rMid && rMid.asked && rMid.dead === 0 && /\u2705 \*\*The roll succeeds\.\*\*/.test(rMid.said) && !/telling blow|glances off|NaN/.test(rMid.said)
        && new RegExp(`for \\*\\*${midTotal}\\*\\* vs DC ${Math.min(12, midTotal)} \\(swing 1\\)\\. Your call:`).test(rMid.prompt?.content || '')
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
    // hp: with a DC the die decides every blow — a pass takes one off, no call; it falls at 0 (T, 2026-10-14).
    const dHp = await plant('Probe door hp', { stat: 'str', dc: 10, hp: 2 });
    const h1 = dHp ? await strike(dHp, 0.5) : null;
    const hpRow1 = dHp ? rowOf(dHp) : null;
    ok('an hp target with a DC: a pass takes one off with no call, and the card says how many are left',
      !!h1 && !h1.asked && hpRow1?.hp_left === 1 && hpRow1?.dead === 0 && /1 of 2 left/.test(h1.said) && /\*\*1 of 2\*\* left/.test(cardOf(dHp)?.content || ''),
      `asked ${h1?.asked} · left ${hpRow1?.hp_left} · ${h1?.said.replace(/\s+/g, ' ').slice(0, 120)} · card ${(cardOf(dHp)?.content || '').slice(0, 80)}`);
    const h2 = dHp ? await strike(dHp, 0.5) : null;
    const hpRow2 = dHp ? rowOf(dHp) : null;
    ok('the last hit beats it', !!h2 && !h2.asked && hpRow2?.dead === 1 && /falls/.test(h2.said) && /beaten after 2 hits/.test(cardOf(dHp)?.content || ''), `dead ${hpRow2?.dead} · ${h2?.said.replace(/\s+/g, ' ').slice(0, 100)}`);
    // hp: with no DC each pass you call takes one off.
    const dHpCall = await plant('Probe door hp call', { stat: 'str', hp: 2 });
    const hc1 = dHpCall ? await strike(dHpCall, 0.5) : null;
    const hcCall = hc1 ? await call(hc1, true, '') : null;
    const hcRow = dHpCall ? rowOf(dHpCall) : null;
    ok('an hp target with no DC: your pass takes one off and says what is left; the target stands', !!hc1 && hc1.asked && !!hcCall?.modal && hcRow?.hp_left === 1 && hcRow?.dead === 0 && hcCall.replies.some(r => /1 of 2\*\* left/.test(r.content || '')), `${JSON.stringify(hcCall?.replies).slice(0, 120)} · left ${hcRow?.hp_left}`);
    // The list offers a 🪦 button per standing target; pressing retires it.
    const lst = await fire({ commandName: 'target', options: { _sub: 'list' }, userId: 'U1' });
    const retireIds = (lst.replies[0]?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const retireMine = retireIds.find(id => id === `tgtretire:${dHpCall.message_id}`);
    const ret = retireMine ? await fire({ isButton: true, customId: retireMine, message: lst.replies[0], userId: 'U1' }) : null;
    const retRow = dHpCall ? rowOf(dHpCall) : null;
    ok('/target list carries a 🪦 button per standing target and pressing it retires the target', !!retireMine && retRow?.dead === 1 && /retired/.test(JSON.stringify(ret?.replies)) && /retired by the GM/.test(cardOf(dHpCall)?.content || ''), `${retireIds.length} button(s) · ${JSON.stringify(ret?.replies).slice(0, 80)}`);
    // write:true opens the box; its submit makes the target with the words.
    const wr = await fire({ commandName: 'target', options: { _sub: 'create', name: 'Probe door written', dc: 11, write: true }, userId: 'U1' });
    const wrModal = wr.replies.find(x => x.modal)?.modal;
    const wr2 = wrModal ? await fire({ isModal: true, customId: wrModal, fields: { scene: 'A door, iron-banded.', success: 'It gives.', fail: 'It holds.' }, userId: 'U1' }) : null;
    const wrRow = dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name='Probe door written'").get();
    ok('write:true opens a box for the scene and the two flavours; the submit plants the target with them', /^tgtwrite:/.test(wrModal || '') && !!wrRow && wrRow.reason === 'A door, iron-banded.' && wrRow.success_text === 'It gives.' && wrRow.fail_text === 'It holds.' && wrRow.dc === 11 && /A door, iron-banded\./.test(cardOf(wrRow)?.content || ''), `${wrModal} · ${JSON.stringify(wrRow || {}).slice(0, 120)}`);
    // A bare `d20` passed the creation check and failed every press (T, 2026-10-14: "That expression no longer reads").
    const dBare = await plant('Probe door d20', { dice: 'd20', dc: 10 });
    const rBare = dBare ? await strike(dBare, 0.5) : null;
    ok('dice:d20 with no count rolls as one die', !!rBare && /with \*\*d20\*\*/.test(rBare.said) && /= \*\*11\*\*/.test(rBare.said) && !/no longer reads/.test(rBare.said) && rBare.asked, rBare?.said.slice(0, 100));
    // The same NaN bit the planted stat button and the group check: an 11 + 3 against DC 10 must pass.
    const sentBeforeBtn = sent.length;
    await fire({ commandName: 'button', options: { _sub: 'roll', stat: 'str', dc: 10 }, userId: 'U1' });
    const planted = sent.slice(sentBeforeBtn).map(x => x.msg).find(m => idsOf(m).some(id => /^btnchk:/.test(id)));
    Math.random = () => 0.5;
    const pressed = planted ? await fire({ isButton: true, customId: idsOf(planted)[0], message: planted, userId: 'U2' }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] })) : null;
    Math.random = realRandom;
    const pressedSaid = pressed ? pressed.replies.map(x => x.content || '').join(' ') : '';
    ok('a planted stat button: a die of 11 plus the stat against DC 10 is "Passed", not a NaN fail', !!planted && /\*\*Passed\.\*\*/.test(pressedSaid) && !/NaN/.test(pressedSaid), pressedSaid.slice(0, 120) || 'no planted button');
    const sentBeforeGrp = sent.length;
    await fire({ commandName: 'button', options: { _sub: 'group', stat: 'str', dc: 10, reason: 'Probe ford' }, userId: 'U1' });
    const grpMsg = sent.slice(sentBeforeGrp).map(x => x.msg).find(m => idsOf(m).includes('grproll'));
    Math.random = () => 0.5;
    const grpPress = grpMsg ? await fire({ isButton: true, customId: 'grproll', message: grpMsg, userId: 'U2' }).catch(e => ({ replies: [{ content: 'THREW ' + e.message }] })) : null;
    Math.random = realRandom;
    const grpRow = grpMsg ? dbHandle.prepare("SELECT total, passed FROM group_check_rolls WHERE guild_id='G1' AND message_id=? AND user_id='U2'").get(grpMsg.id) : null;
    ok('a group check: a die of 11 plus the stat against DC 10 is stored as a pass with its total, not NaN', !!grpPress && grpRow?.total === midTotal && grpRow?.passed === 1, `row ${JSON.stringify(grpRow)} expected ${midTotal} · ${JSON.stringify(grpPress?.replies).slice(0, 80)}`);
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

  // ── Build A2 (2026-10-14): audiences, the GM toolbar, the ready check, the
  // story scroll, the weekly chronicle, the idle nudge, the stalled targets,
  // the registration line, the next-steps line ─────────────────────────
  if (dbHandle) {
    const realErrA = console.error; const loggedA = [];
    console.error = (...a) => { loggedA.push(a.map(String).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const withRole = (uid, role) => ({ id: uid, roles: { cache: new Map([[role, { id: role }]]) }, permissions: { has: () => true } });
    const seed = (uid) => dbHandle.prepare(`INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current) VALUES ('G1', ?, 3, 3, 3, 3, 3, 7)`).run(uid);
    // Mentions carry Discord's numeric ids, and the parsers hold them to that;
    // the fake guild answers any id, so these two are members like U1.
    const P2 = '100000000000000002', P4 = '100000000000000004', R9 = '900000000000000009';
    seed('U2'); seed(P2); seed(P4);
    // 1 · a planted button for two players or a role
    let before = sent.length;
    await fire({ commandName: 'button', options: { _sub: 'roll', stat: 'str', dc: 10, audience: `<@${P2}> <@&${R9}>` }, userId: 'U1' });
    const planted = sent.slice(before).find(x => /\*\*STR\*\*/.test(x.content))?.msg;
    const pid = planted ? idsOf(planted)[0] : '';
    const rowA = planted ? dbHandle.prepare("SELECT owners FROM button_audience WHERE guild_id='G1' AND message_id=?").get(planted.id) : null;
    const pU3 = planted ? saidOf(await fire({ isButton: true, customId: pid, message: planted, userId: 'U3' })) : '';
    const pU2 = planted ? saidOf(await fire({ isButton: true, customId: pid, message: planted, userId: P2 })) : '';
    const pRole = planted ? saidOf(await fire({ isButton: true, customId: pid, message: planted, userId: P4, member: withRole(P4, R9) })) : '';
    ok('a planted button can be addressed to several players or a role: the list sits under the message, the card names them all, a stranger is turned away, a listed player and a role-holder roll',
      !!planted && planted.content.startsWith(`<@${P2}> <@&${R9}> — `) && /:list$/.test(pid) && rowA?.owners === `u:${P2},r:${R9}`
        && /not addressed to you/.test(pU3) && !/not addressed/.test(pU2) && /\d/.test(pU2) && !/not addressed/.test(pRole) && /\d/.test(pRole),
      `${(planted?.content || '').slice(0, 60)} · id ${pid} · owners ${rowA?.owners} · U3 ${pU3.slice(0, 40)} · U2 ${pU2.replace(/\s+/g, ' ').slice(0, 40)} · role ${pRole.replace(/\s+/g, ' ').slice(0, 40)}`);
    await fire({ commandName: 'target', options: { _sub: 'create', name: 'Probe gate', stat: 'str', dc: 10, audience: `<@${P2}> <@&${R9}>` }, userId: 'U1' });
    const tRow = dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name='Probe gate' ORDER BY at DESC").get();
    const tCard = tRow ? sentById.get(tRow.card_id || tRow.message_id) : null;
    const tU3 = tCard ? await fire({ isButton: true, customId: 'tgtatk:str', message: tCard, userId: 'U3' }) : { replies: [] };
    const tRole = tCard ? await fire({ isButton: true, customId: 'tgtatk:str', message: tCard, userId: P4, member: withRole(P4, R9) }) : { replies: [] };
    ok('a target takes the same audience: kept as the owner list, named on the card, a stranger turned away, a role-holder offered the form',
      tRow?.owner === `u:${P2},r:${R9}` && (tCard?.content || '').startsWith(`<@${P2}> <@&${R9}> —`) && /not addressed to you/.test(saidOf(tU3)) && /^tgtrp:/.test(tRole.replies.find(x => x.modal)?.modal || ''),
      `owner ${tRow?.owner} · ${(tCard?.content || '').slice(0, 50)} · U3 ${saidOf(tU3).slice(0, 40)} · role ${JSON.stringify(tRole.replies[0] || {}).slice(0, 60)}`);
    // 2 · the GM toolbar (a live fight in C1 so Status has something to say)
    dbHandle.prepare(`UPDATE fights SET state='active', turn_order='["U1","U2"]', turn_index=0, phase='attack', current_target=NULL, hp_state='{"U1":7,"U2":7}' WHERE guild_id='G1' AND channel_id='C1'`).run();
    before = sent.length;
    const barR = await fire({ commandName: 'gm', options: { _sub: 'bar' }, userId: 'U1' });
    const bar = sent.slice(before).find(x => /GM toolbar/.test(x.content))?.msg;
    const barIds = bar ? idsOf(bar) : [];
    const bSt = bar ? await fire({ isButton: true, customId: 'gmbar:status', message: bar, userId: 'U1' }) : { replies: [] };
    const bTg = bar ? await fire({ isButton: true, customId: 'gmbar:target', message: bar, userId: 'U1' }) : { replies: [] };
    const bDc = bar ? await fire({ isButton: true, customId: 'gmbar:dc', message: bar, userId: 'U1' }) : { replies: [] };
    const bFt = bar ? await fire({ isButton: true, customId: 'gmbar:fight', message: bar, userId: 'U1' }) : { replies: [] };
    ok('/gm bar pins one message with five buttons; Status answers at once, three open their forms, Undo rewinds',
      !!bar && pinned.includes(bar.id) && /Toolbar pinned/.test(saidOf(barR)) && barIds.join(',') === 'gmbar:target,gmbar:dc,gmbar:fight,gmbar:status,gmbar:undo'
        && /Where things stand here/.test(saidOf(bSt)) && /A fight is on \u2014 \*\*userU1\*\* to act\./.test(saidOf(bSt)) && /userU1 7\/\d+/.test(saidOf(bSt)) && /Standing: \*\*Probe gate\*\*/.test(saidOf(bSt)) && bTg.replies[0]?.modal === 'gmbartgt' && /^dcform:/.test(bDc.replies[0]?.modal || '') && bFt.replies[0]?.modal === 'gmbarfight',
      `bar ${!!bar} pinned ${bar && pinned.includes(bar.id)} · ${barIds.join(',')} · status ${saidOf(bSt).replace(/\s+/g, ' ').slice(0, 60)} · ${bTg.replies[0]?.modal} ${bDc.replies[0]?.modal} ${bFt.replies[0]?.modal}`);
    const tgtSub = await fire({ isModal: true, customId: 'gmbartgt', fields: { name: 'Probe portcullis', check: '14 str dex', scene: 'Iron bars, rusted.', hp: '2', for: '' }, userId: 'U1' });
    const pcRow = dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name='Probe portcullis' ORDER BY at DESC").get();
    const pcCard = pcRow ? sentById.get(pcRow.message_id) : null;
    ok('the toolbar\'s Plant target box makes the target /target create would: DC, stats, scene and hits read off the box',
      pcRow?.dc === 14 && pcRow?.stat === 'str,dex' && pcRow?.reason === 'Iron bars, rusted.' && pcRow?.hp === 2 && /is standing/.test(saidOf(tgtSub)) && idsOf(pcCard).join(',') === 'tgtatk:str,tgtatk:dex',
      `${JSON.stringify(pcRow || {}).slice(0, 160)} · ${saidOf(tgtSub).slice(0, 60)} · ${idsOf(pcCard).join(',')}`);
    const chanF = new FakeChannel('C8', 0, 'toolbar-fight', guild); channelsById.set(chanF.id, chanF);
    const ftSub = await fire({ isModal: true, customId: 'gmbarfight', fields: { players: `<@${P2}> <@${P4}>`, npcs: '', practice: 'no' }, userId: 'U1', channel: chanF });
    const fRow = dbHandle.prepare("SELECT state, turn_order FROM fights WHERE guild_id='G1' AND channel_id='C8'").get();
    ok('the toolbar\'s Start fight box starts the fight the slash command would, the players read off the box',
      fRow?.state === 'active' && (fRow?.turn_order || '').includes(P2) && (fRow?.turn_order || '').includes(P4), `${JSON.stringify(fRow || {})} · ${saidOf(ftSub).replace(/\s+/g, ' ').slice(0, 80)}`);
    // 3 · the ready check
    dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id, started_at) VALUES ('G1', 910, 'Probe Tale', 'active', 'quest', ?, 'C1', 'U1', ?)`).run(Date.now(), Date.now());
    for (const u of ['U1', 'U2']) dbHandle.prepare("INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 910, ?, 'party')").run(u);
    const rdy = await fire({ commandName: 'quest', options: { _group: 'run', _sub: 'ready', number: 910 }, userId: 'U1' });
    const rdyCard = rdy.replies[0] || {};
    const rdyMsg = { id: nextId(), content: rdyCard.content || '', components: rdyCard.components || [], edit: async () => {} };
    const q3 = await fire({ isButton: true, customId: 'qready:910', message: rdyMsg, userId: 'U3' });
    const q2 = await fire({ isButton: true, customId: 'qready:910', message: rdyMsg, userId: 'U2' });
    const q1 = await fire({ isButton: true, customId: 'qready:910', message: rdyMsg, userId: 'U1' });
    ok('/quest run ready: a tick per seated player, a stranger turned away, each press re-draws the card, the last says all ready and names the GM',
      /ready check/.test(rdyCard.content || '') && ((rdyCard.content || '').match(/⬜ <@U/g) || []).length === 2 && idsOf(rdyCard).includes('qready:910')
        && /seated party/.test(saidOf(q3)) && /✅ <@U2>/.test(saidOf(q2)) && /1 of 2/.test(saidOf(q2)) && /All 2 ready/.test(saidOf(q1)) && /<@U1>/.test(saidOf(q1)),
      `${(rdyCard.content || '').replace(/\s+/g, ' ').slice(0, 80)} · U3 ${saidOf(q3).slice(0, 40)} · U2 ${saidOf(q2).replace(/\s+/g, ' ').slice(0, 70)} · U1 ${saidOf(q1).replace(/\s+/g, ' ').slice(-70)}`);
    // 4 · a strike's words reach the running quest's chronicle; the story scroll rides the completion card
    await fire({ commandName: 'target', options: { _sub: 'create', name: 'Probe idol', stat: 'str', dc: 5 }, userId: 'U1' });
    const idol = dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name='Probe idol' ORDER BY at DESC").get();
    const idolCard = idol ? sentById.get(idol.message_id) : null;
    const ip = idolCard ? await fire({ isButton: true, customId: 'tgtatk:str', message: idolCard, userId: 'U2' }) : { replies: [] };
    const ipModal = ip.replies.find(x => x.modal)?.modal;
    if (ipModal) await fire({ isModal: true, fromMessage: true, customId: ipModal, fields: { action: 'topples the idol', speech: 'Down you go' }, message: idolCard, userId: 'U2' });
    const rpRows = dbHandle.prepare("SELECT text FROM quest_events WHERE guild_id='G1' AND number=910 AND kind='rp'").all().map(r => r.text);
    ok('the words from a target strike go into the running quest\'s chronicle as story',
      rpRows.some(t => /topples the idol/.test(t) && /“Down you go”/.test(t)), rpRows.join(' | ').slice(0, 160) || 'no rp rows');
    const done = await fire({ commandName: 'quest', options: { _group: 'run', _sub: 'complete', number: 910, summary: 'They toppled the idol and went home.' }, userId: 'U1' });
    const storyAtt = done.replies.flatMap(x => x.files || []).find(f => /story\.pdf$/.test(f?.b?.name || ''));
    const storyBuf = storyAtt?.a;
    let woven = null; try { woven = JSON.parse(storyBuf.slice(storyBuf.indexOf('DDICESCROLLv1') + 13).toString('utf8')); } catch {}
    ok('the completion card carries the run\'s story as a woven scroll PDF: the party, the length, every beat with its words, the tale',
      !!storyAtt && /^%PDF-1\.4/.test(storyBuf.toString('latin1', 0, 8)) && /\/Count \d+/.test(storyBuf.toString('latin1')) && woven?.kind === 'scroll' && /Probe Tale/.test(woven?.title || '')
        && /The party: userU1, userU2/.test(woven?.body || '') && /topples the idol/.test(woven?.body || '') && /They toppled the idol/.test(woven?.body || '') && /rides below as a scroll/.test(saidOf(done)),
      `att ${storyAtt?.b?.name} · ${(woven?.body || '').replace(/\s+/g, ' ').slice(0, 160)} · ${saidOf(done).replace(/\s+/g, ' ').slice(0, 80)}`);
    // 5 · the registration line, the next-steps line, the stalled targets
    const stR = await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'status' }, userId: 'U1' });
    ok('/gm check status says whether the commands registered on this boot, and the Deploy mend said the same',
      /commands: \d+ registered on this boot/.test(saidOf(stR)) && sent.some(x => /commands: \d+ registered on this boot/.test(x.content)), saidOf(stR).replace(/\s+/g, ' ').slice(-120));
    const newSheet = await fire({ commandName: 'char', options: { _sub: 'create', str: 3, con: 3, dex: 3, wis: 3, lck: 3 }, userId: 'U5' });
    ok('a new sheet is told where to go next', /\u{1F9ED} \*\*Next:\*\*/u.test(saidOf(newSheet)) && /`\/help`/.test(saidOf(newSheet)), saidOf(newSheet).replace(/\s+/g, ' ').slice(-160));
    dbHandle.prepare("UPDATE temp_targets SET at=? WHERE guild_id='G1' AND name='Probe gate'").run(Date.now() - 2 * 86400000);
    const stalled = await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'stalled' }, userId: 'U1' });
    ok('a target standing over a day is in the stalled report', /Targets standing over a day/.test(saidOf(stalled)) && /Probe gate in <#C1> \(2d\)/.test(saidOf(stalled)), saidOf(stalled).replace(/\s+/g, ' ').slice(0, 160));
    // 6 · the weekly chronicle and the idle nudge, from the ticks
    dbHandle.prepare("INSERT OR IGNORE INTO subject_titles (guild_id, subject_id, title, source, granted_by, at) VALUES ('G1', 'U2', 'Idol-breaker', 'probe', 'U1', ?)").run(Date.now());
    dbHandle.prepare("INSERT INTO week_ledger (guild_id, at, kind, text) VALUES ('G1', ?, 'fight', 'userU1 wins!')").run(Date.now());
    dbHandle.prepare("UPDATE characters SET died_at=? WHERE guild_id='G1' AND user_id=?").run(Date.now(), P4);
    dbHandle.prepare("UPDATE guild_config SET week_tale_at=0, fight_nudge_min=NULL, turn_remind_min=NULL, turn_skip_min=NULL, turn_timeout=NULL WHERE guild_id='G1'").run();   // the server's own clock is wanted here, 5 and 15
    dbHandle.prepare("DELETE FROM turn_clocks WHERE guild_id='G1'").run();
    dbHandle.prepare(`UPDATE fights SET state='active', turn_order='["U1","U2"]', turn_index=0, phase='attack', current_target=NULL, nudged=0, last_at=? WHERE guild_id='G1' AND channel_id='C1'`).run(Date.now() - 11 * 60 * 1000);
    const updForum = dbHandle.prepare("SELECT updates_forum FROM guild_config WHERE guild_id='G1'").get()?.updates_forum;
    const talesBefore = threads.filter(t => t.parentId === updForum && / · Weekly chronicle$/.test(t.name)).length;   // the tick walk above posted the first
    const nudgesBefore = sent.filter(x => /minutes? quiet/.test(x.content)).length;
    for (const t of ticks) { try { await t.fn(); } catch (e) { loggedA.push(`tick: ${e.message}`); } }
    const tales = threads.filter(t => t.parentId === updForum && / · Weekly chronicle$/.test(t.name));
    const taleText = tales.length ? sent.filter(x => x.channel === tales[tales.length - 1].id).map(x => x.content).join('\n') : '';
    ok('the players\' weekly chronicle is a dated thread in updates: quests completed, titles granted, fights won, the fallen',
      tales.length === talesBefore + 1 && /Quests completed/.test(taleText) && /\*\*#910-Probe Tale\*\* — userU1, userU2 \(GM userU1\)/.test(taleText)
        && /Titles granted/.test(taleText) && /\*\*userU2\*\* — Idol-breaker/.test(taleText) && /Fights won/.test(taleText) && /userU1 wins!/.test(taleText)
        && /The fallen/.test(taleText) && taleText.includes(`**user${P4}**`),
      `${tales.length} thread(s) · ${taleText.replace(/\s+/g, ' ').slice(0, 300)}`);
    const nudges = sent.filter(x => /minutes? quiet/.test(x.content));
    const nudgedRow = dbHandle.prepare("SELECT nudged FROM fights WHERE guild_id='G1' AND channel_id='C1'").get();
    for (const t of ticks) { try { await t.fn(); } catch {} }
    const nudgesAgain = sent.filter(x => /minutes? quiet/.test(x.content)).length;
    const talesAgain = threads.filter(t => t.parentId === updForum && / · Weekly chronicle$/.test(t.name)).length;
    ok('a fight quiet past five minutes reminds whoever it waits on, once, with ✍️ Still writing; a second tick reminds nobody and posts no second chronicle',
      nudges.length === nudgesBefore + 1 && /⏳ 5 minutes quiet — \*\*userU1\*\* is up to attack\. Still writing\? Press ✍️ or keep typing\. At 15 minutes the turn is skipped\. <@U1>/.test(nudges[nudges.length - 1]?.content || '') && nudgedRow?.nudged === 1
        && JSON.stringify(nudges[nudges.length - 1]?.msg?.components || []).includes('fclock:hold')
        && nudgesAgain === nudges.length && talesAgain === talesBefore + 1,
      `${nudges.length - nudgesBefore} nudge(s): ${(nudges[nudges.length - 1]?.content || '').slice(0, 80)} · nudged ${nudgedRow?.nudged} · again ${nudgesAgain - nudges.length} · chronicles ${talesAgain}`);
    dbHandle.prepare("UPDATE characters SET died_at=NULL WHERE guild_id='G1' AND user_id=?").run(P4);
    const threwA = loggedA.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrA;
    ok('nothing in the A2 walk threw', threwA.length === 0, threwA.slice(0, 3).join('\n        '));
  }

  // ── Build B (2026-10-15): /gm undo, the channel's journal ─────────────
  if (dbHandle) {
    const realErrB = console.error; const loggedB = [];
    console.error = (...a) => { loggedB.push(a.map(String).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const realRandom = Math.random;
    const journal = (cid) => dbHandle.prepare("SELECT id, label, actor FROM undo_journal WHERE guild_id='G1' AND channel_id=? ORDER BY id DESC").all(cid);
    const fightRow = () => dbHandle.prepare("SELECT state, phase, turn_index, atk_roll, def_roll, hp_state FROM fights WHERE guild_id='G1' AND channel_id='C1'").get();
    const hpOf = (uid) => dbHandle.prepare("SELECT hp_current FROM characters WHERE guild_id='G1' AND user_id=?").get(uid)?.hp_current;
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    // 1 · an exchange, then the rewind: resolve first, then the two rolls
    dbHandle.prepare("UPDATE characters SET hp_current=7 WHERE guild_id='G1' AND user_id IN ('U1','U2')").run();
    dbHandle.prepare(`UPDATE fights SET state='active', turn_order='["U1","U2"]', turn_index=0, phase='attack', current_target=NULL, hp_state='{"U1":7,"U2":7}', effect_state='{}', grapples='{}', atk_roll=NULL, def_roll=NULL, atk_kind=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    dbHandle.prepare("DELETE FROM undo_journal WHERE guild_id='G1' AND channel_id='C1'").run();
    const msgF = { id: 'M9', content: '', components: [] };
    const a1 = await fire({ isButton: true, customId: 'fatk:str', message: msgF, userId: 'U1' });
    Math.random = () => 0.9999;
    await fire({ isModal: true, fromMessage: true, customId: modalOf(a1), fields: { action: 'swings for the head' }, message: msgF, userId: 'U1' });
    const d1 = await fire({ isButton: true, customId: 'fdef:con', message: msgF, userId: 'U2' });
    Math.random = () => 0;
    await fire({ isModal: true, fromMessage: true, customId: modalOf(d1), fields: {}, message: msgF, userId: 'U2' });
    Math.random = realRandom;
    const beforeResolve = fightRow();
    const r1 = await fire({ isButton: true, customId: 'fresolve', message: msgF, userId: 'U2' });
    await fire({ isModal: true, fromMessage: true, customId: modalOf(r1), fields: { what: '' }, message: msgF, userId: 'U2' });
    const afterResolve = fightRow(), hpHit = hpOf('U2');
    const j1 = journal('C1');
    ok('every fight step is journaled under a readable label, newest first, and the rewind itself never is',
      j1.length >= 3 && j1[0].label === 'fight form' && j1[0].actor === 'U2' && j1.some(r => r.label === 'fight form' && r.actor === 'U1') && !j1.some(r => /undo/.test(r.label))
        && beforeResolve?.phase === 'defend' && afterResolve?.phase === 'attack' && hpHit < 7,
      `${j1.map(r => r.label + '/' + r.actor).join(' | ')} · before ${JSON.stringify(beforeResolve)} · after ${JSON.stringify(afterResolve)} · U2 hp ${hpHit}`);
    let before = sent.length;
    const u1 = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    const postedU1 = sent.slice(before).map(x => x.msg);
    const rowU1 = fightRow();
    ok('/gm undo rewinds the resolve: the HP comes back, the fight row stands as it did before the press, the table is told what moved, the status and the defence prompt are posted again',
      new RegExp(`⏪ \\*\\*Rewound one step\\*\\* by <@U1>: \\*\\*fight form\\*\\* by <@U2>`).test(saidOf(u1)) && new RegExp(`❤️ userU2 ${hpHit}→7`).test(saidOf(u1))
        && hpOf('U2') === 7 && rowU1?.phase === 'defend' && rowU1?.def_roll === beforeResolve.def_roll && rowU1?.hp_state === beforeResolve.hp_state
        && postedU1.some(m => /\*\*Fight Status\*\*/.test(m.content)) && postedU1.some(m => /attacks \*\*userU2\*\* with STR/.test(m.content) && idsOf(m).includes('fdef:con')),
      `${saidOf(u1).replace(/\s+/g, ' ').slice(0, 160)} · row ${JSON.stringify(rowU1)} · posted ${postedU1.map(m => m.content.replace(/\s+/g, ' ').slice(0, 40)).join(' | ')}`);
    const u2 = await fire({ commandName: 'gm', options: { _sub: 'undo', steps: 2 }, userId: 'U1' });
    const rowU2 = fightRow();
    ok('steps:2 takes the defence and the attack back together: the fight waits for an attack again, no rolls on it, and a third rewind is not a redo',
      /Rewound 2 steps/.test(saidOf(u2)) && rowU2?.phase === 'attack' && rowU2?.atk_roll === null && rowU2?.def_roll === null && !journal('C1').some(r => /undo/.test(r.label)),
      `${saidOf(u2).replace(/\s+/g, ' ').slice(0, 120)} · row ${JSON.stringify(rowU2)}`);
    // 2 · a fight that has ended is not rewound (the toolbar's fight in C8)
    const chanF = channelsById.get('C8');
    const endAsk = await fire({ commandName: 'fight', options: { _sub: 'end' }, userId: 'U1', channel: chanF });
    const endConfirm = idsOf(endAsk.replies[0]).find(id => /^confirm:/.test(id));
    if (endConfirm) await fire({ isButton: true, customId: endConfirm, message: { id: nextId(), content: '', components: [] }, userId: 'U1', channel: chanF });
    const endedRow = dbHandle.prepare("SELECT state FROM fights WHERE guild_id='G1' AND channel_id='C8'").get();
    const uEnd = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1', channel: chanF });
    ok('a fight that has ended is not rewound — not the step that ended it',
      endedRow?.state !== 'active' && /The fight here has ended/.test(saidOf(uEnd)) && dbHandle.prepare("SELECT state FROM fights WHERE guild_id='G1' AND channel_id='C8'").get()?.state !== 'active',
      `state ${endedRow?.state} · ${saidOf(uEnd).replace(/\s+/g, ' ').slice(0, 120)}`);
    // 3 · a target strike: a natural 1 reposts the card; the rewind takes the repost down and gives the first card its buttons back
    await fire({ commandName: 'target', options: { _sub: 'create', name: 'Probe wall', stat: 'str', dc: 10 }, userId: 'U1' });
    const wall = dbHandle.prepare("SELECT * FROM temp_targets WHERE guild_id='G1' AND name='Probe wall' ORDER BY at DESC").get();
    const wallCard = wall ? sentById.get(wall.message_id) : null;
    const wp = wallCard ? await fire({ isButton: true, customId: 'tgtatk:str', message: wallCard, userId: 'U2' }) : { replies: [] };
    Math.random = () => 0;
    if (modalOf(wp)) await fire({ isModal: true, fromMessage: true, customId: modalOf(wp), fields: { action: 'shoulders it' }, message: wallCard, userId: 'U2' });
    Math.random = realRandom;
    const wallHit = dbHandle.prepare("SELECT hits, reposts, card_id, dead FROM temp_targets WHERE guild_id='G1' AND message_id=?").get(wall?.message_id);
    const uW = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    const wallBack = dbHandle.prepare("SELECT hits, reposts, card_id, dead FROM temp_targets WHERE guild_id='G1' AND message_id=?").get(wall?.message_id);
    ok('a target strike rewinds: the swing and the repost come off the row, the reposted card is taken down, the first card gets its buttons back',
      wallHit?.hits === 1 && wallHit?.reposts === 1 && wallHit?.card_id !== wall?.message_id
        && /\*\*target strike\*\* by <@U2>/.test(saidOf(uW)) && /\*\*Probe wall\*\* — 0 swings/.test(saidOf(uW))
        && wallBack?.hits === 0 && wallBack?.reposts === 0 && wallBack?.card_id === wall?.message_id && deleted.includes(wallHit?.card_id)
        && idsOf(sentById.get(wall?.message_id)).join(',') === 'tgtatk:str' && !/continues below/.test(sentById.get(wall?.message_id)?.content || ''),
      `hit ${JSON.stringify(wallHit)} · back ${JSON.stringify(wallBack)} · ${saidOf(uW).replace(/\s+/g, ' ').slice(0, 120)} · card ids ${idsOf(sentById.get(wall?.message_id)).join(',')}`);
    // 4 · a group roll and a once-only press rewind: the roll comes off the tally, the press is open again
    before = sent.length;
    await fire({ commandName: 'button', options: { _sub: 'group', stat: 'str', dc: 10 }, userId: 'U1' });
    const grp = sent.slice(before).find(x => /A check for everyone/.test(x.content))?.msg;
    if (grp) await fire({ isButton: true, customId: 'grproll', message: grp, userId: 'U2' });
    const rolled = grp ? dbHandle.prepare("SELECT COUNT(*) AS c FROM group_check_rolls WHERE guild_id='G1' AND message_id=?").get(grp.id).c : -1;
    const uG = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    const rolledBack = grp ? dbHandle.prepare("SELECT COUNT(*) AS c FROM group_check_rolls WHERE guild_id='G1' AND message_id=?").get(grp.id).c : -1;
    ok('a group roll rewinds: the roll comes off the tally, the card is re-drawn with its buttons, the roller may roll again',
      rolled === 1 && rolledBack === 0 && new RegExp(`🎲 userU2`).test(saidOf(uG)) && /Nobody has rolled yet/.test(grp?.content || '') && idsOf(grp).includes('grproll'),
      `rolled ${rolled}→${rolledBack} · ${saidOf(uG).replace(/\s+/g, ' ').slice(0, 120)} · ${(grp?.content || '').replace(/\s+/g, ' ').slice(-60)}`);
    before = sent.length;
    await fire({ commandName: 'button', options: { _sub: 'roll', stat: 'str', dc: 10, once: true }, userId: 'U1' });
    const once = sent.slice(before).find(x => /\*\*STR\*\*/.test(x.content))?.msg;
    const onceId = once ? idsOf(once)[0] : '';
    const p1 = once ? saidOf(await fire({ isButton: true, customId: onceId, message: once, userId: 'U2' })) : '';
    const p2 = once ? saidOf(await fire({ isButton: true, customId: onceId, message: once, userId: 'U2' })) : '';
    const uP = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    const p3 = once ? saidOf(await fire({ isButton: true, customId: onceId, message: once, userId: 'U2' })) : '';
    ok('a once-only press rewinds: the gate comes off and the player may press again',
      /\d/.test(p1) && /had your go/.test(p2) && new RegExp(`🔘 userU2 may press again`).test(saidOf(uP)) && /\d/.test(p3) && !/had your go/.test(p3),
      `first ${p1.replace(/\s+/g, ' ').slice(0, 30)} · second ${p2.slice(0, 30)} · ${saidOf(uP).replace(/\s+/g, ' ').slice(0, 80)} · third ${p3.replace(/\s+/g, ' ').slice(0, 30)}`);
    // 5 · a called check that cost HP rewinds the HP
    dbHandle.prepare("UPDATE characters SET hp_current=7 WHERE guild_id='G1' AND user_id='U2'").run();
    const dcAsk = await fire({ commandName: 'gm', options: { _sub: 'dc', stat: 'str', dc: 40, target: 'U2', fail_damage: 3 }, userId: 'U1' });
    const dcCard = dcAsk.replies.find(x => idsOf(x).some(id => /^dcroll:U2:/.test(id)));
    const dcId = dcCard ? idsOf(dcCard).find(id => /^dcroll:U2:/.test(id)) : '';
    Math.random = () => 0;   // a natural 1: a 20 would pass any DC and cost nothing
    if (dcCard) await fire({ isButton: true, customId: dcId, message: { id: nextId(), content: dcCard.content || '', components: dcCard.components.map(r => ({ components: ((r._d || r).components || []).map(b => ({ customId: (b._d || b).customId, label: (b._d || b).label, style: (b._d || b).style, disabled: false })) })) }, userId: 'U2' });
    Math.random = realRandom;
    const hpAfterDc = hpOf('U2');
    const uD = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    ok('a called check that cost HP rewinds: the sheet is back where it was and the table is told',
      !!dcId && hpAfterDc === 4 && hpOf('U2') === 7 && new RegExp(`❤️ userU2 4→7`).test(saidOf(uD)) && /\*\*check roll\*\* by <@U2>/.test(saidOf(uD)),
      `id ${dcId} · hp ${hpAfterDc}→${hpOf('U2')} · ${saidOf(uD).replace(/\s+/g, ' ').slice(0, 120)}`);
    // 6 · nothing to rewind, the toolbar's Undo, the journal's depth
    const chanN = new FakeChannel('C9', 0, 'quiet', guild); channelsById.set(chanN.id, chanN);
    const uN = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1', channel: chanN });
    const barMsg = sent.find(x => /GM toolbar/.test(x.content))?.msg;
    const uBar = barMsg ? await fire({ isButton: true, customId: 'gmbar:undo', message: barMsg, userId: 'U1', channel: chanN }) : { replies: [] };
    const realFetchB = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchB(uid); if (uid === 'U7') { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const uPlayer = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U7', member: { id: 'U7', roles: { cache: new Map() }, permissions: { has: () => false } } });
    guild.members.fetch = realFetchB;
    for (let i = 0; i < 12; i++) await fire({ commandName: 'target', options: { _sub: 'create', name: `Probe straw ${i}`, stat: 'str', dc: 10 }, userId: 'U1' });
    ok('an untouched channel answers "Nothing to rewind here", the toolbar\'s Undo is the same rewind, a plain player is refused, and the journal keeps ten steps',
      /Nothing to rewind here/.test(saidOf(uN)) && /Nothing to rewind here/.test(saidOf(uBar)) && /Rewinding is for GMs/.test(saidOf(uPlayer)) && journal('C1').length === 10,
      `${saidOf(uN).slice(0, 40)} · bar ${saidOf(uBar).slice(0, 40)} · player ${saidOf(uPlayer).slice(0, 40)} · depth ${journal('C1').length}`);
    const threwB = loggedB.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column|\[undo\]/.test(l));
    console.error = realErrB;
    ok('nothing in the undo walk threw', threwB.length === 0, threwB.slice(0, 3).join('\n        '));
  }

  // ── Build C (2026-10-15): typed fight commands, initiative ties, /rp and
  // the player's /edit, fightnudge, ready → Start, /fight log scroll, dice
  // of the week, the prune, /existence ────────────────────────────────
  if (dbHandle) {
    const realErrC = console.error; const loggedC = [];
    console.error = (...a) => { loggedC.push(a.map(String).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    const realRandom = Math.random;
    const P2 = '100000000000000002', P4 = '100000000000000004';
    // 1 · typed attack and defence: bare → buttons; one foe → the form; flavour → the swing; typed defence likewise
    dbHandle.prepare(`UPDATE fights SET state='active', turn_order='["U1","U2"]', turn_index=0, phase='attack', current_target=NULL, hp_state='{"U1":7,"U2":7}', effect_state='{}', grapples='{}', atk_roll=NULL, def_roll=NULL, atk_kind=NULL WHERE guild_id='G1' AND channel_id='C1'`).run();
    const bare = await fire({ commandName: 'fight', options: { _sub: 'atk' }, userId: 'U1' });
    const typedOne = await fire({ commandName: 'fight', options: { _sub: 'atk', stat: 'str' }, userId: 'U1' });
    let before = sent.length;
    const typedFlav = await fire({ commandName: 'fight', options: { _sub: 'atk', stat: 'str', flavour: 'a low cut' }, userId: 'U1' });
    const swung = fightRowC();
    const bareDef = await fire({ commandName: 'fight', options: { _sub: 'def' }, userId: 'U2' });
    const typedDef = await fire({ commandName: 'fight', options: { _sub: 'def', stat: 'con', roll: 'adv' }, userId: 'U2' });
    const defSub = typedDef.replies.find(x => x.modal) ? await fire({ isModal: true, fromMessage: true, customId: modalOf(typedDef), fields: { action: 'braces' }, message: { id: 'M9', content: '', components: [] }, userId: 'U2' }) : { replies: [] };
    function fightRowC() { return dbHandle.prepare("SELECT phase, atk_roll, def_roll, atk_stat, def_stat FROM fights WHERE guild_id='G1' AND channel_id='C1'").get(); }
    const defended = fightRowC();
    ok('typed /fight atk: bare offers the stat buttons, a stat with one foe opens the form, a stat with flavour swings; typed /fight def likewise, the roll type riding the form',
      idsOf(bare.replies[0]).includes('fatk:str') && /Pick a stat/.test(saidOf(bare)) && /^frp:/.test(modalOf(typedOne) || '')
        && !modalOf(typedFlav) && swung?.phase === 'defend' && swung?.atk_stat === 'str' && /a low cut/.test(saidOf(typedFlav) + sent.slice(before).map(x => x.content).join(' '))
        && idsOf(bareDef.replies[0]).includes('fdef:con') && /^frp:/.test(modalOf(typedDef) || '') && defended?.def_roll !== null && defended?.def_stat === 'con' && /advantage/.test(saidOf(defSub)) && /braces/.test(saidOf(defSub)),
      `bare ${idsOf(bare.replies[0]).join(',')} · one ${modalOf(typedOne)} · flav ${JSON.stringify(swung)} · def ${idsOf(bareDef.replies[0]).join(',')} ${modalOf(typedDef)} ${JSON.stringify(defended)} · ${saidOf(defSub).replace(/\s+/g, ' ').slice(0, 60)}`);
    // 2 · initiative ties: two fighters on one total reroll, only they, and the line says so
    const chanT = new FakeChannel('C10', 0, 'ties', guild); channelsById.set(chanT.id, chanT);
    const seq = [0.45, 0.45, 0.7, 0.1];   // d20: 10, 10 (a tie at 13 each with DEX 3), then 15 and 3
    let k = 0; Math.random = () => seq[k++ % seq.length];
    const startT = await fire({ commandName: 'fight', options: { _sub: 'start', players: `<@${P2}> <@${P4}>` }, userId: 'U1', channel: chanT });
    Math.random = realRandom;
    const orderT = JSON.parse(dbHandle.prepare("SELECT turn_order FROM fights WHERE guild_id='G1' AND channel_id='C10'").get()?.turn_order || '[]');
    ok('initiative ties reroll among the tied: the line names the tie, the rerolls and who goes first, and the order follows it',
      new RegExp(`🔁 \\*\\*Tie at 13\\*\\* — user${P2} and user${P4} reroll: user${P2} .*\\[15\\] \\+ 3 = 18 .*user${P4} .*\\[3\\] \\+ 3 = 6 → user${P2} first`).test(saidOf(startT)) && orderT[0] === P2 && orderT[1] === P4,
      `${saidOf(startT).replace(/\s+/g, ' ').slice(0, 260)} · order ${orderT.join(',')}`);
    // 3 · /rp: inline and by the box, posted in the player's name, chronicled; the player fixes and takes back their own through /edit
    dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id, started_at) VALUES ('G1', 911, 'Probe Rp', 'active', 'quest', ?, 'C1', 'U1', ?)`).run(Date.now(), Date.now());
    before = sent.length;
    const rp1 = await fire({ commandName: 'rp', options: { action: 'draws her blade', speech: 'Not one step closer.' }, userId: 'U2' });
    const rpMsg = sent.slice(before).map(x => x.msg).find(m => /draws her blade/.test(m.content));
    const rpBare = await fire({ commandName: 'rp', options: {}, userId: 'U2' });
    before = sent.length;
    const rp2 = modalOf(rpBare) === 'rpform' ? await fire({ isModal: true, customId: 'rpform', fields: { action: '', speech: 'Hold the line.' }, userId: 'U3' }) : { replies: [] };
    const rpMsg3 = sent.slice(before).map(x => x.msg).find(m => /Hold the line/.test(m.content));
    const rpRows = dbHandle.prepare("SELECT message_id, user_id FROM rp_lines WHERE guild_id='G1' AND channel_id='C1' ORDER BY at").all();
    const chron = dbHandle.prepare("SELECT text FROM quest_events WHERE guild_id='G1' AND number=911 AND kind='rp'").all().map(r => r.text);
    ok('/rp posts in the player\'s name through the channel\'s webhook with no mentions allowed, inline or from the box, and the words reach the running quest\'s chronicle',
      /Posted/.test(saidOf(rp1)) && !!rpMsg && rpMsg.webhookId && Array.isArray(rpMsg.allowedMentions?.parse) && rpMsg.allowedMentions.parse.length === 0 && /\*draws her blade\*\n\n"Not one step closer\."/.test(rpMsg.content) && modalOf(rpBare) === 'rpform' && !!rpMsg3 && /^"Hold the line\."$/.test(rpMsg3.content)
        && rpRows.some(r => r.message_id === rpMsg.id && r.user_id === 'U2') && rpRows.some(r => r.message_id === rpMsg3?.id && r.user_id === 'U3')
        && chron.some(t => /userU2: draws her blade/.test(t) && /Not one step closer/.test(t)),
      `${saidOf(rp1).slice(0, 40)} · msg ${JSON.stringify(rpMsg?.content)} hook ${rpMsg?.webhookId} · box ${modalOf(rpBare)} ${JSON.stringify(rpMsg3?.content)} · rows ${rpRows.length} · chron ${chron.join(' | ').slice(0, 120)}`);
    // U3 is a plain player for the edit: the fake guild answers admin for everyone, so U3 is made plain for these calls
    const realFetchC = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchC(uid); if (uid === 'U3') { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const plainC = { id: 'U3', roles: { cache: new Map() }, permissions: { has: () => false } };
    const list3 = await fire({ commandName: 'edit', options: {}, userId: 'U3', member: plainC });
    const listIds = (list3.replies[0]?.components || []).flatMap(r => ((r._d || r).components || []).flatMap(c => ((c._d || c).options || []).map(o => o.value)));
    const pick3 = await fire({ isSelect: true, customId: 'editpick', values: [rpMsg3?.id], message: { id: nextId(), content: '', components: [] }, userId: 'U3', member: plainC });
    const save3 = modalOf(pick3) ? await fire({ isModal: true, fromMessage: true, customId: modalOf(pick3), fields: { text: '"Hold the line, all of you."' }, message: { id: nextId(), content: '', components: [] }, userId: 'U3', member: plainC }) : { replies: [] };
    const notMine = await fire({ commandName: 'edit', options: { link: `https://discord.com/channels/G1/C1/${rpMsg?.id}` }, userId: 'U3', member: plainC });
    const del3 = await fire({ commandName: 'edit', options: { delete: true }, userId: 'U3', member: plainC });
    const delPick = await fire({ isSelect: true, customId: 'editdel', values: [rpMsg3?.id], message: { id: nextId(), content: '', components: [] }, userId: 'U3', member: plainC });
    guild.members.fetch = realFetchC;
    ok('a player\'s /edit lists only their own /rp lines, fixes one through the same box, refuses another\'s by link, and delete:true takes their own down',
      listIds.length === 1 && listIds[0] === rpMsg3?.id && /^botedit:/.test(modalOf(pick3) || '') && /Edited/.test(saidOf(save3)) && rpMsg3?.content === '"Hold the line, all of you."'
        && /not yours to touch/.test(saidOf(notMine)) && idsOf(del3.replies[0]).includes('editdel') && /Which line comes down/.test(saidOf(del3)) && /Taken down/.test(saidOf(delPick)) && deleted.includes(rpMsg3?.id)
        && !dbHandle.prepare("SELECT 1 FROM rp_lines WHERE guild_id='G1' AND message_id=?").get(rpMsg3?.id),
      `list ${listIds.join(',')} vs ${rpMsg3?.id} · pick ${modalOf(pick3)} · save ${saidOf(save3).slice(0, 30)} "${rpMsg3?.content}" · link ${saidOf(notMine).slice(0, 40)} · del ${saidOf(del3).slice(0, 40)} / ${saidOf(delPick).slice(0, 30)} gone ${deleted.includes(rpMsg3?.id)}`);
    // 4 · turnclock: 0 and 0 is no clock; a turn passes after its reminder; minutes as set; reset
    const n0 = await fire({ commandName: 'config', options: { _group: 'mechanics', _sub: 'turnclock', remind: 0, skip: 0 }, userId: 'U1' });
    dbHandle.prepare(`UPDATE fights SET state='active', turn_order='["U1","U2"]', turn_index=0, phase='attack', current_target=NULL, nudged=0, last_at=? WHERE guild_id='G1' AND channel_id='C1'`).run(Date.now() - 30 * 60 * 1000);
    const nudgesC0 = sent.filter(x => /minutes? quiet/.test(x.content)).length;
    for (const t of ticks) { try { await t.fn(); } catch {} }
    const nudgesC1 = sent.filter(x => /minutes? quiet/.test(x.content)).length;
    const stillC1 = dbHandle.prepare("SELECT turn_index, phase FROM fights WHERE guild_id='G1' AND channel_id='C1'").get();
    const nBad = await fire({ commandName: 'config', options: { _group: 'mechanics', _sub: 'turnclock', remind: 10, skip: 5 }, userId: 'U1' });
    const n5 = await fire({ commandName: 'config', options: { _group: 'mechanics', _sub: 'turnclock', remind: 5, skip: 20 }, userId: 'U1' });
    const nShow = await fire({ commandName: 'config', options: { _group: 'mechanics', _sub: 'turnclock' }, userId: 'U1' });
    dbHandle.prepare(`UPDATE fights SET nudged=0, last_at=? WHERE guild_id='G1' AND channel_id='C1'`).run(Date.now() - 6 * 60 * 1000);
    for (const t of ticks) { try { await t.fn(); } catch {} }
    const nudgeLast = sent.filter(x => /minutes? quiet/.test(x.content)).pop()?.content || '';
    const nReset = await fire({ commandName: 'config', options: { _group: 'mechanics', _sub: 'turnclock', reset: true }, userId: 'U1' });
    const cfgAfter = dbHandle.prepare("SELECT turn_remind_min, turn_skip_min, turn_timeout FROM guild_config WHERE guild_id='G1'").get();
    ok('/config mechanics turnclock: 0 and 0 is no clock at all, a turn must pass after its reminder, 5 and 20 remind at five, bare shows it, reset hands back the defaults',
      /no reminder · no turn passes on its own/.test(saidOf(n0)) && nudgesC1 === nudgesC0 && stillC1?.turn_index === 0 && stillC1?.phase === 'attack'
        && /has to be more than/.test(saidOf(nBad)) && /a reminder at \*\*5 min\*\* · the turn passes at \*\*20 min\*\*/.test(saidOf(n5)) && /a reminder at \*\*5 min\*\* · the turn passes at \*\*20 min\*\*/.test(saidOf(nShow))
        && /^⏳ 5 minutes quiet — \*\*userU1\*\* is up to attack\. Still writing\? Press ✍️ or keep typing\. At 20 minutes the turn is skipped\. <@U1>$/.test(nudgeLast)
        && /back to the defaults: a reminder at \*\*5 min\*\* · the turn passes at \*\*15 min\*\*/.test(saidOf(nReset)) && cfgAfter?.turn_remind_min == null && cfgAfter?.turn_skip_min == null && cfgAfter?.turn_timeout == null,
      `${saidOf(n0).slice(0, 60)} · ticks ${nudgesC0}→${nudgesC1} · ${JSON.stringify(stillC1)} · ${saidOf(nBad).slice(0, 40)} · ${saidOf(n5).slice(0, 70)} · ${saidOf(nShow).slice(0, 70)} · ${nudgeLast.slice(0, 120)} · ${saidOf(nReset).slice(0, 70)}`);
    // 5 · the ready check's last tick grows a Start button; the GM's press starts the run
    dbHandle.prepare(`INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id) VALUES ('G1', 912, 'Probe Ready', 'open', 'quest', ?, 'C1', 'U1')`).run(Date.now());
    for (const u of ['U1', 'U2']) dbHandle.prepare("INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 912, ?, 'party')").run(u);
    const rdyC = await fire({ commandName: 'quest', options: { _group: 'run', _sub: 'ready', number: 912 }, userId: 'U1' });
    const rdyMsgC = { id: nextId(), content: rdyC.replies[0]?.content || '', components: rdyC.replies[0]?.components || [], edit: async () => {} };
    await fire({ isButton: true, customId: 'qready:912', message: rdyMsgC, userId: 'U2' });
    const lastTick = await fire({ isButton: true, customId: 'qready:912', message: rdyMsgC, userId: 'U1' });
    const startBtn = idsOf(lastTick.replies[0]);
    const pressStart = await fire({ isButton: true, customId: 'qstart:912', message: rdyMsgC, userId: 'U1' });
    const q912 = dbHandle.prepare("SELECT status FROM quests WHERE guild_id='G1' AND number=912").get();
    ok('the last Ready tick turns the card\'s button into Start; the GM\'s press starts the run',
      // Under spin-off (on in this hall) starting a listing launches a run from it; either way the press is the start.
      startBtn.includes('qstart:912') && !startBtn.includes('qready:912') && (q912?.status === 'active' || /launched/.test(saidOf(pressStart))) && !/❌/.test(saidOf(pressStart)),
      `buttons ${startBtn.join(',')} · status ${q912?.status} · ${saidOf(pressStart).replace(/\s+/g, ' ').slice(0, 80)}`);
    // 6 · /fight log scroll:true hands the recap over as a parchment PDF — the C1 fight has an exchange on it; resolve and end it first
    const resC = await fire({ isButton: true, customId: 'fresolve', message: { id: 'M9', content: '', components: [] }, userId: 'U1' });
    if (modalOf(resC)) await fire({ isModal: true, fromMessage: true, customId: modalOf(resC), fields: { what: '' }, message: { id: 'M9', content: '', components: [] }, userId: 'U1' });
    const endC = await fire({ commandName: 'fight', options: { _sub: 'end' }, userId: 'U1' });
    const endBtn = idsOf(endC.replies[0]).find(id => /^confirm:/.test(id));
    if (endBtn) await fire({ isButton: true, customId: endBtn, message: { id: nextId(), content: '', components: [] }, userId: 'U1' });
    const chanF8 = chan;
    const logPlain = await fire({ commandName: 'fight', options: { _sub: 'log' }, userId: 'U1', channel: chanF8 });
    const logScroll = await fire({ commandName: 'fight', options: { _sub: 'log', scroll: true }, userId: 'U1', channel: chanF8 });
    const scrollAtt = logScroll.replies.flatMap(x => x.files || [])[0];
    ok('/fight log scroll:true posts the last fight\'s recap as a parchment PDF, woven like a scroll',
      /Last fight in this channel|Last practice bout/.test(saidOf(logPlain)) && !!scrollAtt && /^fight-.*\.pdf$/.test(scrollAtt?.b?.name || '') && /^%PDF-1\.4/.test(scrollAtt.a.toString('latin1', 0, 8)) && scrollAtt.a.indexOf('DDICESCROLLv1') > 0 && /on parchment/.test(saidOf(logScroll)),
      `plain ${saidOf(logPlain).slice(0, 40)} · att ${scrollAtt?.b?.name} · ${saidOf(logScroll).slice(0, 60)}`);
    // 7 · dice of the week in the chronicle, from the dated d20 ledger
    const diceRows = dbHandle.prepare("SELECT COUNT(*) AS c FROM week_dice WHERE guild_id='G1' AND user_id='U2' AND nat=1").get().c;
    dbHandle.prepare("UPDATE guild_config SET week_tale_at=0 WHERE guild_id='G1'").run();
    const updForumC = dbHandle.prepare("SELECT updates_forum FROM guild_config WHERE guild_id='G1'").get()?.updates_forum;
    for (const t of ticks) { try { await t.fn(); } catch {} }
    const talesC = threads.filter(t => t.parentId === updForumC && / · Weekly chronicle$/.test(t.name));
    const taleTextC = talesC.length ? sent.filter(x => x.channel === talesC[talesC.length - 1].id).map(x => x.content).join('\n') : '';
    ok('the chronicle carries the dice of the week: the natural 1s and who rolled them, the biggest total',
      diceRows >= 1 && /Dice of the week/.test(taleTextC) && /natural 1s: .*\*\*userU2\*\*/.test(taleTextC) && /biggest d20 total: \*\*\d+\*\* by \*\*user/.test(taleTextC),
      `nat1 rows ${diceRows} · ${taleTextC.replace(/\s+/g, ' ').slice(taleTextC.indexOf('Dice of the week'), taleTextC.indexOf('Dice of the week') + 200)}`);
    // 8 · the prune: ninety-day-old /rp ownership goes, fresh stays; a once-only press is a rule and stays however old
    dbHandle.prepare("INSERT OR REPLACE INTO rp_lines (guild_id, message_id, channel_id, user_id, at) VALUES ('G1', 'OLDRP', 'C1', 'U1', ?)").run(Date.now() - 100 * 86400000);
    dbHandle.prepare("INSERT OR REPLACE INTO rp_lines (guild_id, message_id, channel_id, user_id, at) VALUES ('G1', 'NEWRP', 'C1', 'U1', ?)").run(Date.now());
    dbHandle.prepare("INSERT OR REPLACE INTO button_presses (guild_id, message_id, user_id, at) VALUES ('G1', 'OLD1', 'U1', ?)").run(Date.now() - 100 * 86400000);
    const runR = await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'run' }, userId: 'U1' }).catch(() => ({ replies: [] }));
    const prunedOk = !dbHandle.prepare("SELECT 1 FROM rp_lines WHERE guild_id='G1' AND message_id='OLDRP'").get() && !!dbHandle.prepare("SELECT 1 FROM rp_lines WHERE guild_id='G1' AND message_id='NEWRP'").get()
      && !!dbHandle.prepare("SELECT 1 FROM button_presses WHERE guild_id='G1' AND message_id='OLD1'").get() && /Ledgers trimmed/.test(saidOf(runR));
    ok('the prune takes ninety-day-old /rp ownership and keeps the fresh; a once-only press stays however old; the setup run says what went', prunedOk,
      `old rp gone ${!dbHandle.prepare("SELECT 1 FROM rp_lines WHERE guild_id='G1' AND message_id='OLDRP'").get()} · new kept ${!!dbHandle.prepare("SELECT 1 FROM rp_lines WHERE guild_id='G1' AND message_id='NEWRP'").get()} · press kept ${!!dbHandle.prepare("SELECT 1 FROM button_presses WHERE guild_id='G1' AND message_id='OLD1'").get()} · ${saidOf(runR).replace(/\s+/g, ' ').slice(0, 80)}`);
    // 9 · /existence: the three leaves work there; /gm answers with the new address
    dbHandle.prepare("UPDATE characters SET hp_current=2, died_at=NULL WHERE guild_id='G1' AND user_id=?").run(P4);
    const healX = await fire({ commandName: 'existence', options: { _sub: 'heal', user: P4 }, userId: 'U1' });
    const hpX = dbHandle.prepare("SELECT hp_current FROM characters WHERE guild_id='G1' AND user_id=?").get(P4)?.hp_current;
    const killAsk = await fire({ commandName: 'existence', options: { _sub: 'kill', user: P4, anyway: true }, userId: 'U1' });
    const killX = modalOf(killAsk) ? await fire({ isModal: true, customId: modalOf(killAsk), fields: { cause: 'the probe', quote: '' }, userId: 'U1' }) : killAsk;
    const deadX = !!dbHandle.prepare("SELECT died_at FROM characters WHERE guild_id='G1' AND user_id=?").get(P4)?.died_at;
    const reviveX = await fire({ commandName: 'existence', options: { _sub: 'revive', user: P4 }, userId: 'U1' });
    const aliveX = !dbHandle.prepare("SELECT died_at FROM characters WHERE guild_id='G1' AND user_id=?").get(P4)?.died_at;
    // The /gm stubs that answered with the new address went with the same
    // update (2026-10-20): /gm heal is simply no leaf now.
    const oldX = await fire({ commandName: 'gm', options: { _sub: 'heal', user: P4 }, userId: 'U1' });
    ok('/existence heal, kill and revive do what /gm\'s did; /gm no longer carries the three',
      hpX > 2 && !/❌/.test(saidOf(healX)) && deadX && aliveX && !/has moved/.test(saidOf(oldX)),
      `heal ${hpX} ${saidOf(healX).slice(0, 40)} · dead ${deadX} ${saidOf(killX).slice(0, 30)} · alive ${aliveX} ${saidOf(reviveX).slice(0, 30)} · old ${saidOf(oldX).slice(0, 60)}`);
    const threwC = loggedC.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrC;
    ok('nothing in the C walk threw', threwC.length === 0, threwC.slice(0, 3).join('\n        '));
  }

  // ── Build D (2026-10-20): scripts kept, the parser's report, drafts and
  // publishing, the map, practice with a forced die, flags and forks,
  // cooldowns and once, party runs, the writer, the shelf, the board,
  // NPC mentions and the Interact and Talk buttons, undo cover ─────────
  if (dbHandle) {
    const realErrD = console.error; const loggedD = [];
    console.error = (...a) => { loggedD.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    const modalFieldsOf = (r) => r.replies.find(x => x.modal)?.modalFields || {};
    const realRandomD = Math.random, realTimeoutD = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { try { fn(); } catch {} return { unref() {} }; };
    const P2 = '100000000000000002';
    const seed = (uid) => dbHandle.prepare(`INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, rerolls_current, merits) VALUES ('G1', ?, 3, 3, 3, 3, 3, 7, 3, 0)`).run(uid);
    seed('U1'); seed('U2'); seed(P2);
    dbHandle.prepare("DELETE FROM story_runs WHERE guild_id='G1'").run();
    dbHandle.prepare("DELETE FROM stories WHERE guild_id='G1'").run();
    dbHandle.prepare("DELETE FROM story_scenes WHERE guild_id='G1'").run();
    const lastIn = (cid) => sent.filter(x => x.channel === cid).slice(-1)[0]?.msg;
    const sinceIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const merits = (uid) => dbHandle.prepare("SELECT merits FROM characters WHERE guild_id='G1' AND user_id=?").get(uid)?.merits ?? 0;
    const story = (name) => dbHandle.prepare("SELECT * FROM stories WHERE guild_id='G1' AND name=? COLLATE NOCASE").get(name);
    const scenesOf = (name) => dbHandle.prepare("SELECT * FROM story_scenes WHERE guild_id='G1' AND story=? COLLATE NOCASE ORDER BY ord").all(name);
    const logs = (name, kind) => dbHandle.prepare("SELECT * FROM story_run_log WHERE guild_id='G1' AND story=? COLLATE NOCASE AND kind=?").all(name, kind);
    // A roll with rerolls in hand waits on Reroll / Carry on; this presses on.
    const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
    const carryOn = async (r, uid = 'U1') => { const go = r.replies.flatMap(x => idsOf(x)).find(id => id.startsWith('storygo:')); return go ? fire({ isButton: true, customId: go, message: { id: nextId(), content: '', edit: async () => {} }, userId: uid }) : null; };

    // 1 · a broken script is kept as a draft, every problem named with its line
    const broken = ['[ACTIVITY] Ford', 'SCENE bank', 'SAY The river.', 'ROLL str DC', '  PASSS -> far', '  FAIL -> bnk', 'SCENE far', 'SAY Across.', 'END merits:1'].join('\n');
    const r1 = await fire({ isModal: true, customId: 'activitycreate', fields: { script: broken }, userId: 'U1' });
    const st1 = story('Ford');
    ok('a script with problems is kept as a draft, every problem on its line, a typo noted',
      /kept as a draft/.test(saidOf(r1)) && /line 4:/.test(saidOf(r1)) && /line 2:[^\n]*bnk[^\n]*Did you mean `bank`/.test(saidOf(r1)) && !!st1?.draft_problems && !st1?.source,
      saidOf(r1).slice(0, 300));
    const runDraft = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U1' });
    ok('a draft cannot be run', /still a draft/.test(saidOf(runDraft)), saidOf(runDraft).slice(0, 120));
    // 2 · fixed in the whole-script box: it goes live, rows and source agree, the typo note is gone
    const key1 = require('crypto').createHash('sha1').update('ford').digest('hex').slice(0, 10);
    const good = ['[ACTIVITY] Ford', '# the ford', 'SCENE bank', 'SAY The river runs fast.', 'ROLL str|wis DC12', '  PASS You wade across. -> far', '  FAIL The current wins. -> bank', '', 'SCENE far', 'SAY Across, dripping.', 'CHOICE', '  Rest -> done', '  Press on -> done', '', 'SCENE done', 'SAY Dry at last.', 'END merits:1'].join('\n');
    const r2 = await fire({ isModal: true, customId: `actvall:${key1}`, fields: { script: good }, userId: 'U1' });
    const st2 = story('Ford');
    ok('the whole-script box publishes a good script: rows, source kept verbatim, draft cleared',
      /saved — \*\*3\*\* scenes/.test(saidOf(r2)) && st2?.source === good && !st2.draft_source && scenesOf('Ford').length === 3 && !scenesOf('.draft.Ford').length,
      `${saidOf(r2).slice(0, 100)} · src ${st2?.source === good} · draft ${!!st2?.draft_source}`);
    // 3 · the map, and the script as files
    const show = await fire({ commandName: 'activity', options: { _sub: 'show', name: 'Ford', script: true }, userId: 'U1' });
    const showFiles = show.replies.flatMap(x => x.files || []);
    ok('/activity show draws the map with its branches and the odds for this table; script:true attaches the text and the parchment',
      /├─ pass → `far`/.test(saidOf(show)) && /└─ fail → `bank` ↺/.test(saidOf(show)) && /sheets? pass on an average roll/.test(saidOf(show)) && showFiles.length >= 2 && /```/.test(saidOf(show)),
      `${saidOf(show).slice(0, 200)} · files ${showFiles.length}`);
    // 4 · a run: the card, where-am-I, a forced-pass roll, a pick, the ending paid and logged
    let before = sent.length;
    const run1 = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U1' });
    const card1 = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storyroll:')));
    ok('the run begins with a card of roll buttons', /begins for <@U1>/.test(saidOf(run1)) && !!card1, saidOf(run1).slice(0, 80));
    before = sent.length;
    const again = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U1' });
    ok('/activity run while mid-run shows where you are instead of refusing', /mid-way through \*\*Ford\*\*/.test(saidOf(again)) && sinceIn('C1', before).some(m => idsOf(m).some(id => id.startsWith('storyroll:'))), saidOf(again).slice(0, 100));
    Math.random = () => 0.95;   // a high die: the pass branch
    before = sent.length;
    const roll1 = await fire({ isButton: true, customId: idsOf(card1).find(id => id.startsWith('storyroll:')), message: card1, userId: 'U1' });
    ok('a roll with rerolls in hand offers Reroll and Carry on', roll1.replies.some(x => idsOf(x).some(id => id.startsWith('storyrr:'))) && roll1.replies.some(x => idsOf(x).some(id => id.startsWith('storygo:'))), JSON.stringify(roll1.replies.map(idsOf)));
    await carryOn(roll1);
    const pickCard = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:')));
    ok('a pass lands on the next scene with its choice buttons', /vs DC 12/.test(saidOf(roll1)) && !!pickCard, saidOf(roll1).slice(0, 120));
    const m0 = merits('U1');
    before = sent.length;
    const pick1 = await fire({ isButton: true, customId: idsOf(pickCard)[0], message: pickCard, userId: 'U1' });
    const ending = sinceIn('C1', before).map(m => m.content).join(' ');
    ok('the ending pays its merits and the run is logged start → roll → pick → end',
      merits('U1') === m0 + 1 && /1 merit/.test(ending) && logs('Ford', 'start').length >= 1 && logs('Ford', 'roll').length >= 1 && logs('Ford', 'pick').length >= 1 && logs('Ford', 'end').length === 1,
      `merits ${m0}→${merits('U1')} · ${ending.slice(0, 80)} · logs ${['start', 'roll', 'pick', 'end'].map(k => logs('Ford', k).length).join('/')}`);
    // 5 · undo brings the merits and the run back
    const undo1 = await fire({ commandName: 'gm', options: { _sub: 'undo' }, userId: 'U1' });
    ok('/gm undo rewinds an activity ending: the merits go back and the run stands on its last scene',
      merits('U1') === m0 && !!dbHandle.prepare("SELECT 1 FROM story_runs WHERE guild_id='G1' AND channel_id='C1' AND user_id='U1'").get(), `${saidOf(undo1).slice(0, 100)} · merits ${merits('U1')}`);
    dbHandle.prepare("DELETE FROM story_runs WHERE guild_id='G1'").run();
    // 6 · scores, after a finish
    const scores = await fire({ commandName: 'activity', options: { _sub: 'scores', name: 'Ford' }, userId: 'U1' });
    ok('/activity scores reads the ledger', /finish/.test(saidOf(scores)) || /best/.test(saidOf(scores)), saidOf(scores).slice(0, 100));
    // 7 · flags, a fork, a title, once, a cooldown
    const flagged = ['[ACTIVITY] Lantern', 'ONCE per day', 'SCENE door', 'SAY Two ways in.', 'CHOICE', '  Take the torch -> lit', '  Go dark -> dark', '', 'SCENE lit', 'SAY Light.', 'SET torch', 'NEXT adv', 'CHOICE', '  On -> hall', '',
      'SCENE dark', 'SAY Dark.', 'CHOICE', '  On -> hall', '', 'SCENE hall', 'IF torch -> seen', 'IF not torch -> unseen', '', 'SCENE seen', 'SAY You see the mural.', 'ROLL wis DC10', '  PASS -> win', '  FAIL -> win', '', 'SCENE unseen', 'SAY Nothing.', 'END', '', 'SCENE win', 'SAY Lit.', 'END merits:2 title:Lamplighter once'].join('\n');
    const r7 = await fire({ isModal: true, customId: 'activitycreate', fields: { script: flagged }, userId: 'U1' });
    ok('flags, IF, NEXT, a title grant, once and a cooldown all parse and publish', /saved — \*\*7\*\* scenes/.test(saidOf(r7)) && story('Lantern')?.cooldown === 'day', saidOf(r7).slice(0, 200));
    before = sent.length;
    await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Lantern' }, userId: 'U1' });
    let cardL = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:')));
    before = sent.length;
    await fire({ isButton: true, customId: idsOf(cardL)[0], message: cardL, userId: 'U1' });   // the torch
    cardL = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:')));
    before = sent.length;
    await fire({ isButton: true, customId: idsOf(cardL)[0], message: cardL, userId: 'U1' });   // on → hall routes to seen
    const seenCard = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storyroll:')));
    ok('an IF routes on the flag set two scenes back, and the tilt from NEXT adv is announced on the roll', !!seenCard && /With advantage/.test(seenCard?.content || ''), (seenCard?.content || sinceIn('C1', before).map(m => m.content).join(' | ')).slice(0, 160));
    before = sent.length;
    const mL = merits('U1');
    await carryOn(await fire({ isButton: true, customId: idsOf(seenCard).find(id => id.startsWith('storyroll:')), message: seenCard, userId: 'U1' }));
    const endL = sinceIn('C1', before).map(m => m.content).join(' ');
    const titled = !!dbHandle.prepare("SELECT 1 FROM subject_titles WHERE guild_id='G1' AND subject_id='U1' AND title='Lamplighter'").get();
    ok('the ending grants the title and the merits', titled && merits('U1') === mL + 2 && /Lamplighter/.test(endL), `${endL.slice(0, 120)} · titled ${titled}`);
    const cool = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Lantern' }, userId: 'U1' });
    ok('ONCE per day refuses a second start with the time left', /once per day/.test(saidOf(cool)) && /can go again in/.test(saidOf(cool)), saidOf(cool).slice(0, 120));
    dbHandle.prepare("DELETE FROM story_run_log WHERE guild_id='G1' AND story='Lantern'").run();
    before = sent.length;
    await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Lantern' }, userId: 'U1' });
    cardL = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:')));
    before = sent.length;
    await fire({ isButton: true, customId: idsOf(cardL)[0], message: cardL, userId: 'U1' });
    cardL = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:')));
    before = sent.length;
    await fire({ isButton: true, customId: idsOf(cardL)[0], message: cardL, userId: 'U1' });
    const seen2 = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storyroll:')));
    before = sent.length;
    const mL2 = merits('U1');
    await carryOn(await fire({ isButton: true, customId: idsOf(seen2).find(id => id.startsWith('storyroll:')), message: seen2, userId: 'U1' }));
    const endL2 = sinceIn('C1', before).map(m => m.content).join(' ');
    ok('END once pays only the first time', merits('U1') === mL2 && /finished this before/.test(endL2), `${endL2.slice(0, 120)} · merits ${mL2}→${merits('U1')}`);
    // 8 · editing one scene in its box; an edit while someone is mid-run waits as a draft; publish after they stop
    before = sent.length;
    await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U2' });
    const editAsk = await fire({ commandName: 'activity', options: { _sub: 'edit', name: 'Ford', scene: 'far' }, userId: 'U1' });
    ok('the scene box opens prefilled with that block alone', modalOf(editAsk) === `actvedit:${key1}:far` && /^SCENE far\nSAY Across, dripping\./.test(modalFieldsOf(editAsk).script || '') && !/SCENE bank/.test(modalFieldsOf(editAsk).script || ''), JSON.stringify(modalFieldsOf(editAsk)).slice(0, 160));
    const edited = await fire({ isModal: true, customId: `actvedit:${key1}:far`, fields: { script: 'SCENE far\nSAY Across, soaked to the skin.\nCHOICE\n  Rest -> done\n  Press on -> done' }, userId: 'U1' });
    const st8 = story('Ford');
    ok('with a player mid-run the edit waits as a draft, the live script untouched, a Publish button offered',
      /held as a draft/.test(saidOf(edited)) && st8.source === good && /soaked to the skin/.test(st8.draft_source || '') && scenesOf('.draft.Ford').length === 3 && edited.replies.some(x => idsOf(x).includes(`actv:publish:${key1}`)),
      saidOf(edited).slice(0, 160));
    const pubRefused = await fire({ isButton: true, customId: `actv:publish:${key1}`, message: { id: 'MP', content: '' }, userId: 'U1' });
    ok('Publish refuses while a run is live', /mid-way through/.test(saidOf(pubRefused)), saidOf(pubRefused).slice(0, 120));
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: 'U2' });
    const pubOk = await fire({ isButton: true, customId: `actv:publish:${key1}`, message: { id: 'MP', content: '' }, userId: 'U1' });
    const st8b = story('Ford');
    ok('Publish puts the draft live once the run has stopped; the old script is kept for Revert',
      /published/.test(saidOf(pubOk)) && /soaked to the skin/.test(st8b.source) && st8b.prev_source === good && !st8b.draft_source && scenesOf('Ford').some(s => /soaked/.test(s.say)),
      saidOf(pubOk).slice(0, 120));
    const rev = await fire({ commandName: 'activity', options: { _sub: 'revert', name: 'Ford' }, userId: 'U1' });
    ok('Revert swaps the two', /back on its earlier version/.test(saidOf(rev)) && story('Ford').source === good, saidOf(rev).slice(0, 100));
    // 9 · /activity set edits the script, not the rows
    const set9 = await fire({ commandName: 'activity', options: { _sub: 'set', name: 'Ford', scene: 'bank', field: 'dc', value: '14' }, userId: 'U1' });
    ok('/activity set rewrites the scene in the script and republishes', /updated/.test(saidOf(set9)) && /ROLL str\|wis DC14/.test(story('Ford').source) && scenesOf('Ford')[0].dc === 14, `${saidOf(set9).slice(0, 80)} · ${story('Ford').source.split('\n').find(l => /ROLL/.test(l))}`);
    // 10 · practice: nothing paid, the die forced
    before = sent.length;
    const prac = await fire({ commandName: 'activity', options: { _sub: 'practice', name: 'Ford' }, userId: 'U1' });
    const pracCard = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storyforce:')));
    ok('practice offers force buttons on a roll', /Practice/.test(saidOf(prac)) && !!pracCard && idsOf(pracCard).some(id => /:nat20$/.test(id)), saidOf(prac).slice(0, 80));
    const rollsBefore = logs('Ford', 'roll').length;
    before = sent.length;
    const forced = await fire({ isButton: true, customId: idsOf(pracCard).find(id => /:nat20$/.test(id)), message: pracCard, userId: 'U1' });
    ok('a forced natural twenty is marked as practice, shows as a crit, and never reaches the ledger', /forced — practice/.test(saidOf(forced)) && /🟡 \*\*23\*\*/.test(saidOf(forced)) && logs('Ford', 'roll').length === rollsBefore, saidOf(forced).slice(0, 120));
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: 'U1' });
    // 11 · a party run: turns, the shared tally, everyone paid
    before = sent.length;
    const party = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford', party: `<@${P2}>` }, userId: 'U1' });
    const pCard = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storyroll:party:')));
    ok('a party run begins with everyone named and the first turn called', /begins for the party/.test(saidOf(party)) && !!pCard && /<@U1> — your turn/.test(pCard?.content || ''), saidOf(party).slice(0, 120));
    const wrongTurn = await fire({ isButton: true, customId: idsOf(pCard).find(id => id.startsWith('storyroll:')), message: pCard, userId: P2 });
    ok('out of turn is refused by name', /It is <@U1>'s turn/.test(saidOf(wrongTurn)), saidOf(wrongTurn).slice(0, 80));
    Math.random = () => 0.95;
    before = sent.length;
    await carryOn(await fire({ isButton: true, customId: idsOf(pCard).find(id => id.startsWith('storyroll:')), message: pCard, userId: 'U1' }));
    const pPick = sinceIn('C1', before).find(m => idsOf(m).some(id => id.startsWith('storypick:party:')));
    ok('after a press the turn passes', !!pPick && /<@100000000000000002> — your turn/.test(pPick?.content || ''), (pPick?.content || '').slice(-80));
    const mU1 = merits('U1'), mP2 = merits(P2);
    before = sent.length;
    await fire({ isButton: true, customId: idsOf(pPick)[0], message: pPick, userId: P2 });
    ok('a party ending pays every member', merits('U1') === mU1 + 1 && merits(P2) === mP2 + 1, `${mU1}→${merits('U1')} · ${mP2}→${merits(P2)}`);
    // 12 · copy, rename, export, grammar, list
    const cp = await fire({ commandName: 'activity', options: { _sub: 'copy', name: 'Ford', as: 'Ford Two' }, userId: 'U1' });
    ok('/activity copy makes a held draft under the new name', /Copied/.test(saidOf(cp)) && /held back as a draft/.test(saidOf(cp)) && !!story('Ford Two')?.draft_source && scenesOf('.draft.Ford Two').length === 3, saidOf(cp).slice(0, 120));
    const rn = await fire({ commandName: 'activity', options: { _sub: 'rename', name: 'Ford Two', to: 'Crossing' }, userId: 'U1' });
    ok('/activity rename carries the draft and its header', /is now \*\*Crossing\*\*/.test(saidOf(rn)) && !story('Ford Two') && /^\[ACTIVITY\] Crossing/.test(story('Crossing')?.draft_source || ''), saidOf(rn).slice(0, 80));
    const ex = await fire({ commandName: 'activity', options: { _sub: 'export', name: 'Ford' }, userId: 'U1' });
    ok('/activity export hands over the text and the parchment', ex.replies.flatMap(x => x.files || []).length >= 2, JSON.stringify(ex.replies).slice(0, 120));
    const gr = await fire({ commandName: 'activity', options: { _sub: 'grammar', topic: 'flags' }, userId: 'U1' });
    ok('/activity grammar reads a topic', /SET torch/.test(saidOf(gr)) && /RANDOM/.test(saidOf(gr)), saidOf(gr).slice(0, 80));
    const ls = await fire({ commandName: 'activity', options: { _sub: 'list' }, userId: 'U1' });
    ok('/activity list shows each one\'s state to a GM', /\*\*Ford\*\*[^\n]*live/.test(saidOf(ls)) && /\*\*Crossing\*\*[^\n]*draft/.test(saidOf(ls)), saidOf(ls).slice(0, 200));
    // 13 · the writer: scene by scene, the next scene offered, finish saves
    const w1 = await fire({ commandName: 'activity', options: { _sub: 'write', name: 'Gate' }, userId: 'U1' });
    ok('/activity write opens the scene box for `start`', modalOf(w1) === 'actvw' && modalFieldsOf(w1).scene === 'start', JSON.stringify(modalFieldsOf(w1)).slice(0, 100));
    const w2 = await fire({ isModal: true, customId: 'actvw', fields: { scene: 'start', say: 'A gate.', ask: 'choice', outcomes: 'Knock -> open\nLeave -> gone', extras: '' }, userId: 'U1' });
    ok('a written scene names the scenes it points at but lacks', /scene `start` written/.test(saidOf(w2)) && /Next: `open`, `gone`/.test(saidOf(w2)) && w2.replies.some(x => idsOf(x).includes('actvw:next:open')), saidOf(w2).slice(0, 160));
    const w3 = await fire({ isButton: true, customId: 'actvw:next:open', message: { id: 'MW', content: '' }, userId: 'U1' });
    ok('Write open opens the box for that scene', modalOf(w3) === 'actvw' && modalFieldsOf(w3).scene === 'open', JSON.stringify(modalFieldsOf(w3)).slice(0, 80));
    await fire({ isModal: true, customId: 'actvw', fields: { scene: 'open', say: 'It opens.', ask: 'end', outcomes: '', extras: 'END merits:1' }, userId: 'U1' });
    const w4 = await fire({ isModal: true, customId: 'actvw', fields: { scene: 'gone', say: 'You leave.', ask: 'end', outcomes: '', extras: '' }, userId: 'U1' });
    ok('with every arrow resolved the writer offers Finish', /Every arrow resolves/.test(saidOf(w4)), saidOf(w4).slice(0, 120));
    const w5 = await fire({ isButton: true, customId: 'actvw:done', message: { id: 'MW', content: '' }, userId: 'U1' });
    ok('Finish composes the script and publishes it', /\*\*Gate\*\* saved — \*\*3\*\* scenes/.test(saidOf(w5)) && /^\[ACTIVITY\] Gate/.test(story('Gate')?.source || '') && !dbHandle.prepare("SELECT 1 FROM activity_drafts WHERE guild_id='G1' AND user_id='U1'").get(), saidOf(w5).slice(0, 120));
    // 14 · the shelf: a forum, a thread per activity with card, blocks, file; the demos; a GM's post in the thread resubmits
    const shelf = new FakeChannel(nextId(), 15, 'activity-shelf', guild); channelsById.set(shelf.id, shelf);
    const cfgShelf = await fire({ commandName: 'config', options: { _group: 'channels', _sub: 'activityshelf', channel: shelf }, userId: 'U1' });
    const pageFord = dbHandle.prepare("SELECT * FROM activity_pages WHERE guild_id='G1' AND name='Ford'").get();
    const fordThread = pageFord ? channelsById.get(pageFord.thread_id) : null;
    const fordMsgs = fordThread ? sent.filter(x => x.channel === fordThread.id).map(x => x.msg) : [];
    const head = fordMsgs.find(m => idsOf(m).includes(`actv:edit:${key1}`));
    ok('the shelf writes a thread per activity: the card with its buttons, the script in code blocks, the parchment',
      /The shelf is/.test(saidOf(cfgShelf)) && !!head && fordMsgs.some(m => /^```\n\[ACTIVITY\] Ford/.test(m.content)) && fordMsgs.some(m => /as a file, and on parchment/.test(m.content)) && /live/.test(head?.content || '') && /pass on an average roll/.test(head?.content || ''),
      `${saidOf(cfgShelf).slice(0, 80)} · head ${!!head} · msgs ${fordMsgs.length}`);
    const demoPage = dbHandle.prepare("SELECT * FROM activity_pages WHERE guild_id='G1' AND name='demo:trial'").get();
    ok('the demos sit on the shelf read-only, the tutorial among them', !!demoPage && (sent.filter(x => x.channel === demoPage.thread_id).some(x => /Scribe's Trial/.test(x.content))), JSON.stringify(demoPage).slice(0, 80));
    const mkIn = (ch, text, uid = 'U1') => ({ id: nextId(), content: text, author: { id: uid, bot: false }, guild, channel: ch, channelId: ch.id, member: { id: uid, roles: { cache: new Map() }, permissions: { has: () => true } }, attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    replies.length = 0;
    for (const fn of listeners.messageCreate || []) await fn(mkIn(fordThread, '```\n' + good.replace('Dry at last.', 'Dry, and home.') + '\n```'));
    await settle();
    ok('a GM\'s script posted in the thread replaces the activity', /\*\*Ford\*\* updated/.test(replies.map(x => x.content || '').join(' ')) && /Dry, and home/.test(story('Ford').source), replies.map(x => x.content || '').join(' ').slice(0, 120));
    const pageFord2 = dbHandle.prepare("SELECT * FROM activity_pages WHERE guild_id='G1' AND name='Ford'").get();
    const headAfter = sentById.get(pageFord2?.head_id);
    ok('the card redraws after a save', pageFord2?.thread_id === pageFord.thread_id && /live/.test(headAfter?.content || '') && idsOf(headAfter).includes(`actv:practice:${key1}`) && /published <t:/.test(headAfter?.content || ''), `${JSON.stringify(pageFord2)} · ${(headAfter?.content || '').slice(0, 80)} · ${JSON.stringify(idsOf(headAfter))}`);
    const editBtn = await fire({ isButton: true, customId: `actv:edit:${key1}`, message: head, userId: 'U1' });
    ok('Edit scene on the card asks which scene', editBtn.replies.some(x => idsOf(x).includes(`actvscene:${key1}`)), JSON.stringify(editBtn.replies).slice(0, 120));
    const pickScene = await fire({ isSelect: true, customId: `actvscene:${key1}`, values: ['done'], message: { id: 'MS', content: '' }, userId: 'U1' });
    ok('a picked scene opens its box', modalOf(pickScene) === `actvedit:${key1}:done` && /^SCENE done/.test(modalFieldsOf(pickScene).script || ''), JSON.stringify(modalFieldsOf(pickScene)).slice(0, 80));
    const retire = await fire({ isButton: true, customId: `actv:retire:${key1}`, message: head, userId: 'U1' });
    ok('Retire takes it off the board and refuses runs', /retired/.test(saidOf(retire)) && story('Ford').retired === 1 && /has been retired/.test(saidOf(await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U2' }))), saidOf(retire).slice(0, 80));
    await fire({ isButton: true, customId: `actv:restore:${key1}`, message: head, userId: 'U1' });
    ok('Restore brings it back', story('Ford').retired === 0);
    // 15 · the board: a pinned message with Play buttons; a plain player is gated by the server's setting
    const boardCh = new FakeChannel(nextId(), 0, 'games', guild); channelsById.set(boardCh.id, boardCh);
    const cfgBoard = await fire({ commandName: 'config', options: { _group: 'channels', _sub: 'activityboard', channel: boardCh }, userId: 'U1' });
    const boardMsg = sent.filter(x => x.channel === boardCh.id).map(x => x.msg).find(m => idsOf(m).some(id => id.startsWith('actv:play:')));
    ok('the board is pinned with a Play button per live activity', /pinned/.test(saidOf(cfgBoard)) && !!boardMsg && boardMsg.pinned && idsOf(boardMsg).includes(`actv:play:${key1}`), saidOf(cfgBoard).slice(0, 80));
    const realFetchD = guild.members.fetch;
    const plainD = 'U7';
    guild.members.fetch = async (uid) => { const mb = await realFetchD(uid); if (uid === plainD) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    seed(plainD);
    dbHandle.prepare("UPDATE guild_config SET activity_players=0 WHERE guild_id='G1'").run();
    const playNo = await fire({ isButton: true, customId: `actv:play:${key1}`, message: boardMsg, userId: plainD, member: { id: plainD, roles: { cache: new Map() }, permissions: { has: () => false } } });
    dbHandle.prepare("UPDATE guild_config SET activity_players=1 WHERE guild_id='G1'").run();
    before = sent.length;
    const playYes = await fire({ isButton: true, customId: `actv:play:${key1}`, message: boardMsg, userId: plainD, member: { id: plainD, roles: { cache: new Map() }, permissions: { has: () => false } } });
    ok('Play on the board follows the server\'s setting: refused while GM-led, a run once opened', /A GM starts activities/.test(saidOf(playNo)) && /begins for <@U7>/.test(saidOf(playYes)) && sinceIn('C1', before).some(m => idsOf(m).some(id => id.startsWith('storyroll:U7'))), `${saidOf(playNo).slice(0, 60)} · ${saidOf(playYes).slice(0, 60)}`);
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: plainD });
    // 16 · NPC lines: @Name resolves to a mention, only people may be pinged, the Interact button, Talk
    guild.members.search = async ({ query }) => new Map(/^ald/i.test(query) ? [[P2, { id: P2, nickname: 'Aldric', displayName: 'Aldric', user: { id: P2, username: 'aldric', globalName: 'Aldric' } }]] : []);
    await fire({ commandName: 'npc', options: { _sub: 'create', name: 'Dockmaster', str: 2 }, userId: 'U1' });
    before = sent.length;
    const say1 = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'Over here, @Aldric — and @everyone else wait.' }, userId: 'U1' });
    const line1 = sinceIn('C1', before).find(m => m.webhookId);
    ok('an NPC line turns @Name into a mention and pings people only, never everyone',
      /Spoke as/.test(saidOf(say1)) && /<@100000000000000002>/.test(line1?.content || '') && (line1?.allowedMentions?.users || []).includes(P2) && (line1?.allowedMentions?.parse || []).length === 0 && /@everyone/.test(line1?.content || ''),
      `${(line1?.content || '').slice(0, 80)} · ${JSON.stringify(line1?.allowedMentions)}`);
    ok('every NPC line carries Reply and GM, and no Interaction until one is offered', idsOf(line1).some(id => id.startsWith('npcreply:')) && idsOf(line1).some(id => id.startsWith('npcx:')) && !idsOf(line1).some(id => id.startsWith('npctalk:')), JSON.stringify(idsOf(line1)));
    const xGm = await fire({ isButton: true, customId: idsOf(line1).find(id => id.startsWith('npcx:')), message: line1, userId: 'U1' });
    const xPl = await fire({ isButton: true, customId: idsOf(line1).find(id => id.startsWith('npcx:')), message: line1, userId: plainD, member: { id: plainD, roles: { cache: new Map() }, permissions: { has: () => false } } });
    const rPl = await fire({ isButton: true, customId: idsOf(line1).find(id => id.startsWith('npcreply:')), message: line1, userId: plainD, member: { id: plainD, roles: { cache: new Map() }, permissions: { has: () => false } } });
    const rGm = await fire({ isButton: true, customId: idsOf(line1).find(id => id.startsWith('npcreply:')), message: line1, userId: 'U1' });
    ok('GM opens the speak-as box for a GM and tells a player it is not theirs; Reply opens the roleplay box for anyone', modalOf(xGm) === 'npcsay:Dockmaster' && /GM's/.test(saidOf(xPl)) && modalOf(rPl) === `rpform:${line1.id}` && modalOf(rGm) === `rpform:${line1.id}`, `${modalOf(xGm)} · ${saidOf(xPl).slice(0, 40)} · ${modalOf(rPl)} · ${modalOf(rGm)}`);
    const boxFields = modalFieldsOf(xGm);
    ok('the speak-as box is four labelled fields: action, speech, the `to` picker, the `offer` dropdown with None pre-selected', 'action' in boxFields && 'speech' in boxFields && 'to' in boxFields && 'offer' in boxFields, JSON.stringify(Object.keys(boxFields)));
    before = sent.length;
    const picked = await fire({ isModal: true, customId: 'npcsay:Dockmaster', fields: { action: 'Waves', speech: 'The tide turns.' }, users: { to: [P2] }, selects: { offer: [] }, userId: 'U1' });
    const linePicked = sinceIn('C1', before).find(m => m.webhookId);
    ok('a line reads action · speech · who it is for, a blank line between, the picked player pinged', /Posted as/.test(saidOf(picked)) && linePicked?.content === '*Waves*\n\n"The tide turns."\n\n<@100000000000000002>' && (linePicked?.allowedMentions?.users || []).includes(P2) && !idsOf(linePicked).some(id => id.startsWith('npctalk:')), `${saidOf(picked).slice(0, 40)} · ${JSON.stringify(linePicked?.content)}`);
    before = sent.length;
    const say2 = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'Mind the ropes.', to: `<@${P2}>` }, userId: 'U1' });
    const line2 = sinceIn('C1', before).find(m => m.webhookId);
    ok('`to:` names them under the words', line2?.content === '"Mind the ropes."\n\n<@100000000000000002>', JSON.stringify(line2?.content));
    before = sent.length;
    const offered = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'Fancy the crossing?', offer: 'Ford' }, userId: 'U1' });
    const line3 = sinceIn('C1', before).find(m => m.webhookId);
    const talkId = idsOf(line3).find(id => id.startsWith('npctalk:'));
    before = sent.length;
    const talked = await fire({ isButton: true, customId: talkId, message: line3, userId: plainD, member: { id: plainD, roles: { cache: new Map() }, permissions: { has: () => false } } });
    ok('`offer:` puts an Interaction button under that line, and it starts the activity for whoever pressed', !/❌/.test(saidOf(offered)) && !!talkId && /begins for <@U7>/.test(saidOf(talked)), `${saidOf(offered).slice(0, 60)} · ${talkId} · ${saidOf(talked).slice(0, 60)}`);
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: plainD });
    const offerBad = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'x', offer: 'Nope' }, userId: 'U1' });
    ok('`offer:` of something that is not an activity is refused', /No live activity called \*\*Nope\*\*/.test(saidOf(offerBad)), saidOf(offerBad).slice(0, 80));
    const talkSet = await fire({ commandName: 'npc', options: { _sub: 'edit', name: 'Dockmaster', talk: 'Ford' }, userId: 'U1' });
    const boxDef = await fire({ isButton: true, customId: idsOf(line1).find(id => id.startsWith('npcx:')), message: line1, userId: 'U1' });
    before = sent.length;
    const plainSubmit = await fire({ isModal: true, customId: 'npcsay:Dockmaster', fields: { action: '', speech: 'Crossing?' }, selects: { offer: ['Ford'] }, userId: 'U1' });
    const line4 = sinceIn('C1', before).find(m => m.webhookId);
    before = sent.length;
    const noOffer = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'Not today.', offer: 'none' }, userId: 'U1' });
    const line5 = sinceIn('C1', before).find(m => m.webhookId);
    ok('`talk:` is only the default pick: the box offers it pre-selected, `offer:none` withholds it', !/❌/.test(saidOf(talkSet)) && modalOf(boxDef) === 'npcsay:Dockmaster' && idsOf(line4).some(id => id.startsWith('npctalk:')) && !idsOf(line5).some(id => id.startsWith('npctalk:')), `${JSON.stringify(idsOf(line4))} · ${JSON.stringify(idsOf(line5))}`);
    guild.members.fetch = realFetchD; delete guild.members.search;
    // 16b · a sheet's page is tagged with its Knightfall class as well as its order
    {
      const charForumT = [...channelsById.values()].find(c => c.name === 'character-pages');
      if (charForumT) {
        dbHandle.prepare("UPDATE guild_config SET char_forum=? WHERE guild_id='G1'").run(charForumT.id);
        dbHandle.prepare("UPDATE characters SET class='Vanguard', char_class=NULL, order_name='Black Knight' WHERE guild_id='G1' AND user_id='U2'").run();
        // U2 must be a plain player here: a GM's page goes to the GM forum, or nowhere.
        const realFetchT = guild.members.fetch;
        guild.members.fetch = async (uid) => { const mb = await realFetchT(uid); if (uid === 'U2') { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
        // An order edit re-mirrors the page (a stat edit would meet the budget rules first).
        await fire({ commandName: 'char', options: { _sub: 'set', field: 'order', value: 'Black Knight' }, userId: 'U2', member: { id: 'U2', roles: { cache: new Map() }, permissions: { has: () => false } } }).catch(() => {});
        await settle();
        guild.members.fetch = realFetchT;
        const pageRow = dbHandle.prepare("SELECT thread_id FROM char_pages WHERE guild_id='G1' AND user_id='U2'").get();
        const th = pageRow ? channelsById.get(pageRow.thread_id) : null;
        const names = (th?.appliedTags || []).map(id => (charForumT.availableTags || []).find(t => t.id === id)?.name || id);
        ok('a Knightfall sheet\'s page carries its class tag beside its order', !!th && names.includes('Vanguard') && names.includes('Black Knight'), `${JSON.stringify(names)} · ${th ? 'thread' : 'no thread'}`);
      }
    }
    // 17 · DC by intent, and QUIZ FROM the bank
    dbHandle.prepare("INSERT INTO quiz_questions (guild_id, category, tags, question, answers, difficulty, explain, author_id, created_at) VALUES ('G1','lore',NULL,'How many orders?','[{\"text\":\"8\",\"correct\":1},{\"text\":\"5\",\"correct\":0}]','normal',NULL,'U1',?)").run(Date.now());
    dbHandle.prepare("INSERT INTO quiz_questions (guild_id, category, tags, question, answers, difficulty, explain, author_id, created_at) VALUES ('G1','lore',NULL,'Who crowned the king?','[{\"text\":\"the archivist\",\"correct\":1}]','normal',NULL,'U1',?)").run(Date.now());
    const intent = ['[ACTIVITY] Archive', 'SCENE door', 'SAY A locked door.', 'ROLL wis DC easy', '  PASS -> bank', '  FAIL -> door', '', 'SCENE bank', 'SAY The archivist opens the book.', 'QUIZ FROM lore 2 -> done', '', 'SCENE done', 'SAY Done.', 'END'].join('\n');
    const r17 = await fire({ isModal: true, customId: 'activitycreate', fields: { script: intent }, userId: 'U1' });
    const archive = scenesOf('Archive');
    const doorSc = archive.find(s => s.scene === 'door');
    ok('ROLL wis DC easy is set from the table\'s sheets, and QUIZ FROM draws the bank into scenes',
      /saved — \*\*5\*\* scenes/.test(saidOf(r17)) && doorSc?.dc === 14 && /"dcword":"easy"/.test(doorSc?.logic || '') && archive.filter(s => /^q\d+$/.test(s.scene)).length === 2 && JSON.parse(archive.find(s => s.scene === 'bank')?.choices || '[]')[0]?.label === 'Begin' && archive.some(s => s.ask === 1 && s.qid),
      `${saidOf(r17).slice(0, 100)} · dc ${doorSc?.dc} · scenes ${archive.map(s => s.scene).join(',')}`);
    const show17 = await fire({ commandName: 'activity', options: { _sub: 'show', name: 'Archive' }, userId: 'U1' });
    ok('the map names the intent beside the DC', /DC 14 _\(easy\)_/.test(saidOf(show17)), saidOf(show17).slice(0, 160));
    // 18 · the audit's guards (2026-10-20): chatter in a thread is not a script; a script may open on a fork;
    //      Revert keeps a waiting draft; a routing scene's GAIN pays; demo rows stay off the board; a problem
    //      reply is private; the reserved draft name is refused; a held draft stays held through an edit
    replies.length = 0;
    const srcBefore = story('Ford').source, draftBefore = story('Ford').draft_source;
    for (const fn of listeners.messageCreate || []) await fn(mkIn(fordThread, 'looks good!'));
    await settle();
    ok('ordinary talk in a shelf thread is not read as a script', story('Ford').source === srcBefore && story('Ford').draft_source === draftBefore && !replies.some(x => /kept as a draft|updated/.test(x.content || '')), replies.map(x => x.content || '').join(' ').slice(0, 100));
    const forked = ['[ACTIVITY] Fork', 'TALLY renown', 'SCENE start', 'GAIN renown 1', 'RANDOM -> left|right', '', 'SCENE left', 'SAY Left.', 'GAIN renown 1', 'IF tally>=2 -> done', '', 'SCENE right', 'SAY Right.', 'GAIN renown 1', 'IF tally>=2 -> done', '', 'SCENE done', 'SAY Out.', 'END TALLY'].join('\n');
    const rF = await fire({ isModal: true, customId: 'activitycreate', fields: { script: forked }, userId: 'U1' });
    before = sent.length;
    const runF = await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Fork' }, userId: 'U1' });
    const endF = sinceIn('C1', before).map(m => m.content).join(' ');
    ok('a script that opens on a fork runs its logic from the first scene, and a routing scene\'s GAIN is paid', /saved/.test(saidOf(rF)) && /begins/.test(saidOf(runF)) && /\*\*\+2\*\*/.test(endF) && !dbHandle.prepare("SELECT 1 FROM story_runs WHERE guild_id='G1' AND channel_id='C1' AND user_id='U1'").get(), `${saidOf(rF).slice(0, 60)} · ${endF.slice(0, 120)}`);
    await fire({ commandName: 'activity', options: { _sub: 'run', name: 'Ford' }, userId: 'U2' });
    await fire({ isModal: true, customId: `actvedit:${key1}:far`, fields: { script: 'SCENE far\nSAY Across, held.\nCHOICE\n  Rest -> done' }, userId: 'U1' });
    const revNo = await fire({ commandName: 'activity', options: { _sub: 'revert', name: 'Ford' }, userId: 'U1' });
    ok('Revert refuses while a draft waits, so the draft is never thrown away', /has a draft waiting/.test(saidOf(revNo)) && /Across, held/.test(story('Ford').draft_source || ''), saidOf(revNo).slice(0, 100));
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: 'U2' });
    const setD = await fire({ commandName: 'activity', options: { _sub: 'set', name: 'Ford', scene: 'far', field: 'say', value: 'Across, held and dripping.' }, userId: 'U1' });
    ok('/activity set with a draft waiting edits the draft and keeps it held', /held as a draft/.test(saidOf(setD)) && /Across, held and dripping/.test(story('Ford').draft_source || '') && !/Across, held and dripping/.test(story('Ford').source || ''), saidOf(setD).slice(0, 120));
    await fire({ isButton: true, customId: `actv:discard:${key1}`, message: head, userId: 'U1' });
    ok('Discard draft clears it and leaves the live version', !story('Ford').draft_source && story('Ford').source === srcBefore);
    const boardNow = sentById.get(dbHandle.prepare("SELECT activity_board_msg FROM guild_config WHERE guild_id='G1'").get()?.activity_board_msg);
    ok('demo rows never reach the board', !!boardNow && !/Fishing \(demo\)|Scribe/.test(boardNow.content || ''), (boardNow?.content || '').slice(0, 120));
    const privProb = await fire({ isModal: true, customId: 'activitycreate', fields: { script: '[ACTIVITY] Secret\nSCENE a\nSAY x\nCHOICE\n  * B — 8 -> nowhere' }, userId: 'U1' });
    ok('a problem reply, which quotes the script, is private', privProb.replies.some(x => x.ephemeral && /kept as a draft/.test(x.content || '')), JSON.stringify(privProb.replies).slice(0, 120));
    const draftRun = await fire({ commandName: 'activity', options: { _sub: 'run', name: '.draft.Ford' }, userId: 'U1' });
    ok('the reserved draft name is refused by name', /working copy/.test(saidOf(draftRun)), saidOf(draftRun).slice(0, 80));
    const lower = ['[ACTIVITY] Lower', 'SCENE a', 'SAY As the sun sets, you arrive. Set sail at dawn. Roll with it.', 'CHOICE', '  Go -> b', 'SCENE b', 'SAY Done.', 'end'].join('\n');
    const rL = await fire({ isModal: true, customId: 'activitycreate', fields: { script: lower }, userId: 'U1' });
    ok('lower-case keywords count when exact; prose that starts with a keyword stays prose', /saved — \*\*2\*\* scenes/.test(saidOf(rL)) && scenesOf('Lower')[1]?.ending === 1 && /As the sun sets/.test(scenesOf('Lower')[0]?.say || ''), saidOf(rL).slice(0, 160));
    // 19 · the tutorial plays
    before = sent.length;
    const trial = await fire({ commandName: 'activity', options: { _sub: 'demo', which: 'trial' }, userId: 'U1' });
    ok('the tutorial demo starts', /Scribe's Trial/.test(saidOf(trial)) && sinceIn('C1', before).some(m => idsOf(m).some(id => id.startsWith('storypick:'))), saidOf(trial).slice(0, 80));
    await fire({ commandName: 'activity', options: { _sub: 'stop' }, userId: 'U1' });
    Math.random = realRandomD; globalThis.setTimeout = realTimeoutD;
    const threwD = loggedD.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrD;
    ok('nothing in the D walk threw', threwD.length === 0, threwD.slice(0, 3).join('\n        '));
  }

  // ── Build H (2026-11-06): /instance opens an encounter, a chapter or an
  // older quest, adopts a running quest and records its room; /session works
  // any run by name or in its thread, with the drafted ending; /rp rolls,
  // a stat roll answering a called check; Reply under every line and the
  // jump header; `to:` for people, groups and orders; /edit on lines that
  // carry only roleplay buttons ───────────────────────────────────────────
  if (dbHandle) {
    const realErrH = console.error; const loggedH = [];
    console.error = (...a) => { loggedH.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    const modalFieldsOf = (r) => r.replies.find(x => x.modal)?.modalFields || {};
    const sinceIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
    const evs = (n, kind) => dbHandle.prepare('SELECT text FROM quest_events WHERE guild_id=? AND number=? AND kind=? ORDER BY id').all('G1', n, kind).map(r => r.text);
    const qrow = (n) => dbHandle.prepare("SELECT * FROM quests WHERE guild_id='G1' AND number=?").get(n);
    const PLAIN = 'U8', P3 = '100000000000000003', P4 = '100000000000000004', P5 = '100000000000000005';
    const plainM = { id: PLAIN, roles: { cache: new Map() }, permissions: { has: () => false } };
    const realFetchH = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchH(uid); if (uid === PLAIN) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const seedH = (uid, order = null) => dbHandle.prepare(`INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, rerolls_current, merits, order_name) VALUES ('G1', ?, 4, 3, 3, 3, 3, 7, 3, 0, ?)`).run(uid, order);
    seedH('U2'); seedH(PLAIN); seedH(P3, 'White Knight'); seedH(P5, 'White Knight'); seedH(P4);
    dbHandle.prepare("INSERT OR REPLACE INTO subject_assocs (guild_id, subject_id, name, note, at) VALUES ('G1', ?, 'The Falconers', NULL, ?)").run(P4, Date.now());
    const chanH = new FakeChannel('CH8', 0, 'h-walk', guild); channelsById.set(chanH.id, chanH);
    // The instance forum again: a walk between here and the encounter walk set the config afresh.
    // (A walk on the way re-opened the database: the bot's handle is dbHandle, not the shim's last.)
    if (!channelsById.get('FORUM1')) channelsById.set('FORUM1', new FakeChannel('FORUM1', 15, 'quest-instances', guild));
    dbHandle.prepare("UPDATE guild_config SET quest_instance_forum='FORUM1' WHERE guild_id='G1'").run();
    const mkIn = (ch, text, uid = 'U2') => ({ id: nextId(), content: text, author: { id: uid, bot: false, username: `user${uid}` }, guild, channel: ch, channelId: ch.id, member: { id: uid, displayName: `Hero${uid}`, roles: { cache: new Map() }, permissions: { has: () => true } }, attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    const openInst = async (options, users = ['U2']) => {
      const r0 = await fire({ commandName: 'instance', options: { _sub: 'start', ...options }, userId: 'U1', channel: chanH });
      const menu = (r0.replies[0]?.components || [])[0]?._d?.components?.[0]?._d || {};
      const key = String(menu.customId || '').split(':')[1];
      if (!key) return { r0, room: null, row: null };
      await fire({ isSelect: true, customId: menu.customId, values: users, message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanH });
      await fire({ isButton: true, customId: `encgo:${key}`, message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanH });
      const row = dbHandle.prepare("SELECT * FROM quests WHERE guild_id='G1' AND kind='encounter' ORDER BY number DESC LIMIT 1").get();
      // The room is the run's own thread \u2014 a campaign card may open a thread of its own on the way.
      return { r0, room: row?.run_thread_id ? channelsById.get(row.run_thread_id) || null : null, row };
    };

    // 1 · /instance start: a chapter needs a campaign and numbers itself; a legacy run pays only what is set
    const chNo = await fire({ commandName: 'instance', options: { _sub: 'start', name: 'Lost Part', as: 'chapter' }, userId: 'U1', channel: chanH });
    const c1 = await openInst({ name: 'The Ford Holds', as: 'chapter', campaign: 'The Probe War' });
    const c2 = await openInst({ name: 'The Bridge Falls', as: 'chapter', campaign: 'The Probe War' });
    const card1 = c1.room ? sent.filter(x => x.channel === c1.room.id).map(x => x.content).join('\n') : '';
    ok('/instance as:chapter needs a campaign, then numbers its parts and wears the book in its room',
      /belongs to a campaign/.test(saidOf(chNo)) && c1.row?.instance_kind === 'chapter' && c1.row?.part === 1 && c2.row?.part === 2
        && /^📖 /.test(c1.room?.name || '') && /Part 1 of \*\*The Probe War\*\*/.test(card1) && /a chapter begins/.test(card1),
      `${saidOf(chNo).slice(0, 50)} · ${c1.row?.instance_kind} p${c1.row?.part}/${c2.row?.part} · ${c1.room?.name} · ${card1.replace(/\s+/g, ' ').slice(0, 160)}`);
    // Two drafts at once: each is numbered as it opens, not as it is drafted.
    const dA = await fire({ commandName: 'instance', options: { _sub: 'start', name: 'Race A', as: 'chapter', campaign: 'The Probe War' }, userId: 'U1', channel: chanH });
    const dB = await fire({ commandName: 'instance', options: { _sub: 'start', name: 'Race B', as: 'chapter', campaign: 'The Probe War' }, userId: 'U1', channel: chanH });
    const keyOf = (r) => String(((r.replies[0]?.components || [])[0]?._d?.components?.[0]?._d || {}).customId || '').split(':')[1];
    for (const r of [dA, dB]) {
      const k = keyOf(r);
      if (!k) continue;
      await fire({ isSelect: true, customId: `encpick:${k}:0`, values: ['U2'], message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanH });
      await fire({ isButton: true, customId: `encgo:${k}`, message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanH });
    }
    const parts = dbHandle.prepare("SELECT name, part FROM quests WHERE guild_id='G1' AND name IN ('Race A','Race B') ORDER BY number").all();
    const dAgain = await fire({ commandName: 'instance', options: { _sub: 'start', name: 'Race C', as: 'chapter', campaign: 'The Probe War', part: 1 }, userId: 'U1', channel: chanH });
    ok('two chapter drafts at once are numbered as they open; asking for a part already given says it is another session of it',
      parts.length === 2 && parts[0].part === 3 && parts[1].part === 4 && /Part 1 \(again/.test(saidOf(dAgain)),
      `${JSON.stringify(parts)} · ${saidOf(dAgain).slice(0, 100)}`);
    for (const r of parts) dbHandle.prepare("UPDATE quests SET status='completed' WHERE guild_id='G1' AND name=?").run(r.name);
    const lg = await openInst({ name: 'The Drowned Bell', as: 'legacy', started: '12/09' }, ['U2', PLAIN]);
    const cardL = lg.room ? sent.filter(x => x.channel === lg.room.id).map(x => x.content).join('\n') : '';
    ok('/instance as:legacy pays nothing unless the GM sets merits, keeps when it began, and says so',
      lg.row?.instance_kind === 'legacy' && lg.row?.merit_reward === 0 && lg.row?.legacy_since === '12/09' && /^🗝️ /.test(lg.room?.name || '')
        && /Picked up from before the bot · begun 12\/09/.test(cardL) && /no merits unless you set them/.test(saidOf(lg.r0)),
      `${lg.row?.instance_kind} merits ${lg.row?.merit_reward} since ${lg.row?.legacy_since} · ${lg.room?.name} · ${saidOf(lg.r0).slice(0, 120)}`);
    const listH = await fire({ commandName: 'instance', options: { _sub: 'list' }, userId: 'U1', channel: chanH });
    ok('/instance list shows every run going with its mark and its time so far', /📖 \*\*/.test(saidOf(listH)) && /🗝️ \*\*/.test(saidOf(listH)) && /Part 2 of/.test(saidOf(listH)) && /⏱️ \d+h \d\dm/.test(saidOf(listH)), saidOf(listH).slice(0, 200));

    // 2 · /session by name: the leaves that answered "No quest #null" now reach the run
    const nNote = await fire({ commandName: 'session', options: { _sub: 'note', name: 'The Drowned Bell', text: 'They found the bell.' }, userId: 'U1', channel: chanH });
    const nShow = await fire({ commandName: 'session', options: { _sub: 'show', name: 'The Drowned Bell' }, userId: PLAIN, member: plainM, channel: chanH });
    const nRally = await fire({ commandName: 'session', options: { _sub: 'rally', name: 'The Drowned Bell' }, userId: 'U1', channel: chanH });
    const nPause = await fire({ commandName: 'session', options: { _sub: 'pause', name: 'The Drowned Bell' }, userId: 'U1', channel: chanH });
    const pausedL = qrow(lg.row?.number)?.paused;
    const nResume = await fire({ commandName: 'session', options: { _sub: 'resume', name: 'The Drowned Bell' }, userId: 'U1', channel: chanH });
    const nPlain = await fire({ commandName: 'session', options: { _sub: 'note', name: 'The Drowned Bell', text: 'sneaky' }, userId: PLAIN, member: plainM, channel: chanH });
    const nTypo = await fire({ commandName: 'session', options: { _sub: 'note', name: 'The Drownd Bel', text: 'typo' }, userId: 'U1', channel: chanH });
    ok('a mistyped name in a shared channel is an error, not the newest run there', /No listing|not found|No quest/i.test(saidOf(nTypo)) && !evs(lg.row?.number, 'note').some(t => /typo/.test(t)), saidOf(nTypo).slice(0, 80));
    const inRoom = lg.room ? await fire({ commandName: 'session', options: { _sub: 'note', text: 'Said in the room.' }, userId: 'U1', channel: lg.room }) : { replies: [] };
    const allSaid = [nNote, nShow, nRally, nPause, nResume, inRoom].map(saidOf).join(' | ');
    ok('/session note, show, rally, pause and resume reach an instance by name; in its thread no name is needed; show is anyone\'s, the rest the GM\'s',
      !/No quest #null|no runs yet/.test(allSaid) && evs(lg.row?.number, 'note').some(t => /They found the bell/.test(t)) && evs(lg.row?.number, 'note').some(t => /Said in the room/.test(t))
        && /Drowned Bell/.test(saidOf(nShow)) && pausedL === 1 && qrow(lg.row?.number)?.paused === 0 && /Only GMs work a run/.test(saidOf(nPlain)) && !evs(lg.row?.number, 'note').some(t => /sneaky/.test(t)),
      `${allSaid.replace(/\s+/g, ' ').slice(0, 260)} · paused ${pausedL}→${qrow(lg.row?.number)?.paused} · plain ${saidOf(nPlain).slice(0, 40)}`);

    // 3 · a board quest started before runs existed is its own run: /session thread opens its room, add seats rather than stages
    dbHandle.prepare("INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id) VALUES ('G1', 950, 'Old Road', 'active', 'quest', ?, 'CH8', 'U1')").run(Date.now());
    dbHandle.prepare("INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 950, 'U2', 'party')").run();
    const th950 = await fire({ commandName: 'session', options: { _sub: 'thread', name: 'Old Road' }, userId: 'U1', channel: chanH });
    const room950 = qrow(950)?.run_thread_id ? channelsById.get(qrow(950).run_thread_id) : null;
    const add950 = await fire({ commandName: 'session', options: { _sub: 'add', name: 'Old Road', user: P4 }, userId: 'U1', channel: chanH });
    const seat950 = dbHandle.prepare("SELECT state FROM quest_members WHERE guild_id='G1' AND number=950 AND user_id=?").get(P4)?.state;
    ok('/session thread opens the room for a run that has none; on a running listing add seats, never stages',
      !!room950 && qrow(950)?.run_thread_id === room950.id && /Old Road/.test(saidOf(th950)) && seat950 === 'party' && !/staged/.test(saidOf(add950)),
      `${saidOf(th950).slice(0, 80)} · thread ${qrow(950)?.run_thread_id} · seat ${seat950} · ${saidOf(add950).slice(0, 80)}`);

    // 4 · /instance start quest: adopts a running board quest: a room, and recording
    dbHandle.prepare("INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id) VALUES ('G1', 951, 'Long Road', 'active', 'quest', ?, 'CH8', 'U1')").run(Date.now());
    dbHandle.prepare("INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 951, 'U2', 'party')").run();
    dbHandle.prepare("INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at) VALUES ('G1', 952, 'Not Begun', 'open', 'quest', ?)").run(Date.now());
    const adopt = await fire({ commandName: 'instance', options: { _sub: 'start', quest: 951, record: true }, userId: 'U1', channel: chanH });
    const room951 = qrow(951)?.run_thread_id ? channelsById.get(qrow(951).run_thread_id) : null;
    const adoptNo = await fire({ commandName: 'instance', options: { _sub: 'start', quest: 952 }, userId: 'U1', channel: chanH });
    ok('/instance start quest: gives a running board quest its room and turns recording on; one not running is refused',
      !!room951 && qrow(951)?.run_thread_id === room951.id && qrow(951)?.record_all === 1 && /now has its room/.test(saidOf(adopt)) && /Everything said in its thread is now recorded/.test(saidOf(adopt))
        && /is not running/.test(saidOf(adoptNo)),
      `${saidOf(adopt).slice(0, 120)} · rec ${qrow(951)?.record_all} · ${saidOf(adoptNo).slice(0, 60)}`);
    // record:true \u2014 what is typed in the room joins the log; a typed roll does not become a line
    replies.length = 0;
    if (room951) {
      for (const fn of listeners.messageCreate || []) await fn(mkIn(room951, 'We press on through the rain.'));
      for (const fn of listeners.messageCreate || []) await fn(mkIn(room951, 'r 1d20'));
    }
    await settle();
    if (room951) {
      for (const fn of listeners.messageCreate || []) await fn(mkIn(room951, 'str'));
      for (const fn of listeners.messageCreate || []) await fn(mkIn(room951, 'Look out, <@100000000000000002>!'));
    }
    const rec951 = evs(951, 'talk');
    ok('a recorded room keeps what is typed there as talk, in the speaker\'s name, mentions named not carried; typed rolls and stat shorthand stay out',
      rec951.some(t => /^HeroU2: We press on through the rain\.$/.test(t)) && !rec951.some(t => /r 1d20|: str$/.test(t))
        && rec951.some(t => /^HeroU2: Look out, @someone!$/.test(t)) && !evs(951, 'rp').some(t => /press on/.test(t)),
      JSON.stringify(rec951));
    dbHandle.prepare("INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id) VALUES ('G1', 953, 'Shared Road', 'active', 'quest', ?, 'CH8', 'U1')").run(Date.now());
    dbHandle.prepare("UPDATE guild_config SET quest_instance_forum=NULL WHERE guild_id='G1'").run();
    const recNo = await fire({ commandName: 'instance', options: { _sub: 'start', quest: 953, record: true }, userId: 'U1', channel: chanH });
    dbHandle.prepare("UPDATE guild_config SET quest_instance_forum='FORUM1' WHERE guild_id='G1'").run();
    for (const fn of listeners.messageCreate || []) await fn(mkIn(chanH, 'A bystander says hello.', 'U9'));
    ok('a run with no thread of its own is not recorded \u2014 a shared channel would record bystanders',
      qrow(953)?.record_all !== 1 && /recording needs the run\u2019s own thread/.test(saidOf(recNo)) && !evs(953, 'talk').length, `${saidOf(recNo).slice(0, 140)} · rec ${qrow(953)?.record_all}`);
    const recOff = await fire({ commandName: 'instance', options: { _sub: 'start', quest: 951, record: false }, userId: 'U1', channel: chanH });
    if (room951) for (const fn of listeners.messageCreate || []) await fn(mkIn(room951, 'Off the record now.'));
    await settle();
    ok('record:false turns it off again, and the room is told', qrow(951)?.record_all === 0 && !evs(951, 'talk').some(t => /Off the record/.test(t)) && sent.some(x => x.channel === room951?.id && /no longer recorded/.test(x.content)), saidOf(recOff).slice(0, 80));

    // 5 · `to:` takes people, an order and a group; the box's Groups list does the same
    guild.members.search = async ({ query }) => new Map(/^ald/i.test(query) ? [['100000000000000002', { id: '100000000000000002', nickname: 'Aldric', displayName: 'Aldric', user: { id: '100000000000000002', username: 'aldric', globalName: 'Aldric' } }]] : []);
    if (!dbHandle.prepare("SELECT 1 FROM npcs WHERE guild_id='G1' AND name='Dockmaster'").get()) await fire({ commandName: 'npc', options: { _sub: 'create', name: 'Dockmaster', str: 2 }, userId: 'U1' });
    let before = sent.length;
    const sayG = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'To arms!', to: '@Aldric, White Knights, The Falconers, Zed' }, userId: 'U1', channel: chanH });
    const lineG = sinceIn('CH8', before).find(m => m.webhookId);
    const pingedG = lineG?.allowedMentions?.users || [];
    ok('`to:` on /npc say names a person, a knight order and a group \u2014 every living player in them \u2014 and says what it could not place',
      [P3, P5, P4, '100000000000000002'].every(id => (lineG?.content || '').includes(`<@${id}>`) && pingedG.includes(id)) && (lineG?.allowedMentions?.parse || []).length === 0
        && /White Knights/.test(saidOf(sayG)) && /The Falconers/.test(saidOf(sayG)) && /Nobody here goes by \*\*Zed\*\*/.test(saidOf(sayG)),
      `${JSON.stringify(lineG?.content)} · ${JSON.stringify(pingedG)} · ${saidOf(sayG).slice(0, 120)}`);
    guild.members.search = async ({ query }) => new Map(/^ald/i.test(query) ? [['100000000000000002', { id: '100000000000000002', nickname: 'Aldric', displayName: 'Aldric', user: { id: '100000000000000002', username: 'aldric', globalName: 'Aldric' } }]]
      : /^gold/i.test(query) ? [['100000000000000006', { id: '100000000000000006', nickname: 'Gold', displayName: 'Gold', user: { id: '100000000000000006', username: 'gold', globalName: 'Gold' } }]] : []);
    before = sent.length;
    const sayAnd = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'You two.', to: 'Gold Knights & Aldric, <@&555>, @everyone' }, userId: 'U1', channel: chanH });
    const lineAnd = sinceIn('CH8', before).find(m => m.webhookId);
    ok('`to:` reads "and" and "&" between names, takes a person only by their whole name, says an order with nobody living, and owns up to dropped roles',
      (lineAnd?.content || '').includes('<@100000000000000002>') && !(lineAnd?.content || '').includes('<@100000000000000006>') && !(lineAnd?.content || '').includes('<@&555>')
        && /Nobody living stands in \*\*Gold Knights\*\*/.test(saidOf(sayAnd)) && /never pinged from a line/.test(saidOf(sayAnd)),
      `${JSON.stringify(lineAnd?.content)} · ${saidOf(sayAnd).slice(0, 200)}`);
    const sayAlone = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', to: '@Aldric' }, userId: 'U1', channel: chanH });
    ok('`to:` with nothing to say is refused, not dropped by the box', /Nothing to say/.test(saidOf(sayAlone)) && !modalOf(sayAlone), saidOf(sayAlone).slice(0, 80));
    const boxG = await fire({ isButton: true, customId: idsOf(lineG).find(id => id.startsWith('npcx:')), message: lineG, userId: 'U1', channel: chanH });
    before = sent.length;
    await fire({ isModal: true, customId: 'npcsay:Dockmaster', fields: { action: '', speech: 'Falconers, to me.' }, users: { to: [] }, selects: { offer: [], groups: ['g:The Falconers', 'o:White Knight'] }, userId: 'U1', channel: chanH });
    const lineB = sinceIn('CH8', before).find(m => m.webhookId);
    ok('the speak-as box carries a Groups list (orders and associations) beside a To picker of twenty-five; a picked group is pinged whole',
      'groups' in modalFieldsOf(boxG) && 'to' in modalFieldsOf(boxG) && [P4, P3, P5].every(id => (lineB?.content || '').includes(`<@${id}>`)),
      `${JSON.stringify(Object.keys(modalFieldsOf(boxG)))} · ${JSON.stringify(lineB?.content)}`);
    ok('every NPC line keeps its buttons now \u2014 the newest-only rule is gone', idsOf(lineG).some(id => id.startsWith('npcreply:')) && idsOf(lineB).some(id => id.startsWith('npcreply:')), `${JSON.stringify(idsOf(lineG))}`);

    // 6 · /rp rolls: a stat in the server's own terms, dice, saved for rr; a player's to: is refused
    before = sent.length;
    const rpR = await fire({ commandName: 'rp', options: { action: 'heaves at the gate', roll: 'str', dice: '2d6+1' }, userId: 'U2', channel: chanH });
    const lineR = sinceIn('CH8', before).find(m => m.webhookId);
    const lastR = dbHandle.prepare("SELECT notation, label FROM roll_history WHERE guild_id='G1' AND channel_id='CH8' AND user_id='U2'").get();
    replies.length = 0;
    for (const fn of listeners.messageCreate || []) await fn(mkIn(chanH, 'rr'));
    const rrSaid = replies.map(x => x.content || '').join(' ');
    ok('/rp roll:str dice:2d6+1 posts the words with both rolls beneath, saves the stat roll for rr, and carries Reply',
      /^\*heaves at the gate\*\n\n🎲 (?:🔴 |🟡 )?\*\*STR\*\* — 1d20\+4 → \[\d+\] \+4 = /.test(lineR?.content || '') && /\n🎲 2d6\+1 → \[\d+, \d+\] \+1 = /.test(lineR?.content || '')
        && lastR?.notation === '1d20+4' && /reroll/i.test(rrSaid + JSON.stringify(replies)) && idsOf(lineR).includes('rpreply') && /`rr` rerolls/.test(saidOf(rpR)),
      `${JSON.stringify(lineR?.content)} · last ${JSON.stringify(lastR)} · rr ${rrSaid.slice(0, 60)} · ${saidOf(rpR).slice(0, 80)}`);
    const rpTo = await fire({ commandName: 'rp', options: { speech: 'Hey', to: '@Aldric' }, userId: PLAIN, member: plainM, channel: chanH });
    const rpBad = await fire({ commandName: 'rp', options: { speech: 'x', roll: 'cha' }, userId: 'U2', channel: chanH });
    const rpDice = await fire({ commandName: 'rp', options: { speech: 'x', dice: 'lots' }, userId: 'U2', channel: chanH });
    const rpBoxP = await fire({ commandName: 'rp', options: {}, userId: PLAIN, member: plainM, channel: chanH });
    const rpBoxG = await fire({ commandName: 'rp', options: {}, userId: 'U1', channel: chanH });
    ok('a player\'s /rp pings nobody: to: is refused and their box has no To picker; a GM\'s box has one; a stat the server lacks and dice that do not read are refused',
      /`to:` is the GM/.test(saidOf(rpTo)) && !('to' in modalFieldsOf(rpBoxP)) && 'roll' in modalFieldsOf(rpBoxP) && 'dice' in modalFieldsOf(rpBoxP) && 'to' in modalFieldsOf(rpBoxG)
        && /not a stat here/.test(saidOf(rpBad)) && /Dice read like/.test(saidOf(rpDice)),
      `${saidOf(rpTo).slice(0, 50)} · ${JSON.stringify(Object.keys(modalFieldsOf(rpBoxP)))} · ${JSON.stringify(Object.keys(modalFieldsOf(rpBoxG)))} · ${saidOf(rpBad).slice(0, 40)} · ${saidOf(rpDice).slice(0, 40)}`);

    // 7 · a stat roll answers the check the GM called on that player here, on the card's terms, and darkens its button
    const cardH = await chanH.send({ content: '🎯 **Check** — STR vs DC 30', components: [] });
    cardH.components = [{ components: [{ customId: 'dcroll:U2:str:30:normal:0:0:0:0:0', label: 'userU2 — roll', style: 1, disabled: false }] }];
    before = sent.length;
    const rpDc = lg.room ? null : null;
    const ans = await fire({ commandName: 'rp', options: { speech: 'Stand aside.', roll: 'str' }, userId: 'U2', channel: chanH });
    const lineDc = sinceIn('CH8', before).find(m => m.webhookId);
    const darkened = (cardH.components?.[0]?._d?.components?.[0]?._d?.disabled === true);
    ok('a stat roll in /rp answers an open check on the card\'s terms: the DC line beneath the words, the button darkened, no rr save',
      /answered the check/.test(saidOf(ans)) && /\n\n🎯 STR vs \*\*DC 30\*\*\n🎲 /.test(lineDc?.content || '') && /❌ \*\*Fail\*\*|💀 \*\*Critical Fail\*\*|🌟/.test(lineDc?.content || '') && darkened,
      `${saidOf(ans).slice(0, 60)} · ${JSON.stringify(lineDc?.content)} · dark ${darkened}`);
    const cardD = await chanH.send({ content: '🎯 **Check** — DEX vs DC 30', components: [] });
    cardD.components = [{ components: [{ customId: 'dcroll:U2:dex:30:normal:0:0:0:0:0', label: 'userU2 — roll', style: 1, disabled: false }] }];
    before = sent.length;
    const ansD = await fire({ commandName: 'rp', options: { action: 'ducks', roll: 'dex' }, userId: 'U2', channel: chanH });
    const lineD = sinceIn('CH8', before).find(m => m.webhookId);
    const pressD = await fire({ isButton: true, customId: 'dcroll:U2:dex:30:normal:0:0:0:0:0', message: { id: nextId(), content: 'x', components: [{ components: [{ customId: 'dcroll:U2:dex:30:normal:0:0:0:0:0', label: 'roll', style: 1 }] }] }, userId: 'U2', channel: chanH });
    ok('a DEX check answers \u2014 from /rp and from its own button (dex is a stat, not dice notation)',
      /answered the check/.test(saidOf(ansD)) && /🎯 DEX vs \*\*DC 30\*\*/.test(lineD?.content || '') && cardD.components?.[0]?._d?.components?.[0]?._d?.disabled === true
        && !/no longer reads/.test(saidOf(pressD)) && /DEX vs \*\*DC 30\*\*/.test(saidOf(pressD)),
      `${saidOf(ansD).slice(0, 60)} · ${JSON.stringify(lineD?.content)} · press ${saidOf(pressD).slice(0, 80)}`);
    before = sent.length;
    await fire({ commandName: 'rp', options: { speech: 'Again.', roll: 'str' }, userId: 'U2', channel: chanH });
    const lineDc2 = sinceIn('CH8', before).find(m => m.webhookId);
    ok('a darkened check is answered once: the next stat roll is an ordinary roll', /🎲 (?:🔴 |🟡 )?\*\*STR\*\*/.test(lineDc2?.content || '') && !/DC 30/.test(lineDc2?.content || ''), JSON.stringify(lineDc2?.content));

    // 8 · Reply on an /rp line opens the box as a reply; the reply jumps back to it
    const rRp = await fire({ isButton: true, customId: 'rpreply', message: lineR, userId: PLAIN, member: plainM, channel: chanH });
    before = sent.length;
    const rSub = await fire({ isModal: true, customId: modalOf(rRp) || 'x', fields: { action: '', speech: 'I will hold the gate.' }, selects: { roll: [] }, userId: PLAIN, member: plainM, channel: chanH });
    const lineRe = sinceIn('CH8', before).find(m => m.webhookId);
    ok('Reply on an /rp line opens the box titled to its writer, and the reply carries a header that jumps back to the line',
      modalOf(rRp) === `rpform:${lineR?.id}` && (lineRe?.content || '').startsWith(`-# ↪ replying to [userU2](https://discord.com/channels/G1/CH8/${lineR?.id})\n"I will hold the gate."`) && idsOf(lineRe).includes('rpreply'),
      `${modalOf(rRp)} · ${JSON.stringify(lineRe?.content)}`);
    // An NPC line's Reply, answered from a thread with no webhook to be had: the bot's own post, name line and all
    const npcLineH = lineG;
    const rN = await fire({ isButton: true, customId: idsOf(npcLineH).find(id => id.startsWith('npcreply:')), message: npcLineH, userId: 'U2', channel: chanH });
    before = sent.length;
    await fire({ isModal: true, customId: modalOf(rN) || 'x', fields: { action: 'salutes', speech: '' }, selects: { roll: ['str'] }, userId: 'U2', channel: chanH });
    const lineRN = sinceIn('CH8', before).find(m => m.webhookId);
    ok('a reply to an NPC line jumps back to the NPC, with its roll beneath', (lineRN?.content || '').startsWith(`-# ↪ replying to [Dockmaster](https://discord.com/channels/G1/CH8/${npcLineH?.id})\n*salutes*\n\n🎲 `) && /\n\n🎲 (?:🔴 |🟡 )?\*\*STR\*\*/.test(lineRN?.content || ''), JSON.stringify(lineRN?.content));

    // 9 · /edit: a line carrying only roleplay buttons is listed; a player edits only their words
    const listE = await fire({ commandName: 'edit', options: {}, userId: PLAIN, member: plainM, channel: chanH });
    const listEIds = (listE.replies[0]?.components || []).flatMap(r => ((r._d || r).components || []).flatMap(c => ((c._d || c).options || []).map(o => o.value)));
    const pickE = await fire({ isSelect: true, customId: 'editpick', values: [lineRe?.id], message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    const shownE = modalFieldsOf(pickE).text;
    await fire({ isModal: true, fromMessage: true, customId: modalOf(pickE) || 'x', fields: { text: '"I will hold the gate, whatever comes."' }, message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    ok('/edit lists a line that carries only Reply; its writer sees only the words, and the save keeps the reply header and the buttons',
      listEIds.includes(lineRe?.id) && shownE === '"I will hold the gate."' && (lineRe?.content || '') === `-# ↪ replying to [userU2](https://discord.com/channels/G1/CH8/${lineR?.id})\n"I will hold the gate, whatever comes."` && idsOf(lineRe).includes('rpreply'),
      `${listEIds.length} listed · shown ${JSON.stringify(shownE)} · now ${JSON.stringify(lineRe?.content)}`);
    before = sent.length;
    await fire({ commandName: 'rp', options: { speech: 'Steady.', roll: 'str' }, userId: PLAIN, member: plainM, channel: chanH });
    const lineP = sinceIn('CH8', before).find(m => m.webhookId);
    const pickP = await fire({ isSelect: true, customId: 'editpick', values: [lineP?.id], message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    await fire({ isModal: true, fromMessage: true, customId: modalOf(pickP) || 'x', fields: { text: '"Steady now."' }, message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    ok('a player\'s edit cannot touch the roll beneath their words', modalFieldsOf(pickP).text === '"Steady."' && /^"Steady now\."\n\n🎲 (?:🔴 |🟡 )?\*\*STR\*\* — 1d20\+4/.test(lineP?.content || ''), `${JSON.stringify(modalFieldsOf(pickP).text)} · ${JSON.stringify(lineP?.content)}`);
    const keptP = lineP?.content;
    const fake = await fire({ isModal: true, fromMessage: true, customId: modalOf(pickP) || 'x', fields: { text: '"Steady."\n\n🎲 🟢 **STR** — 1d20+4 → [20] +4 = **24**' }, message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    const longE = await fire({ isModal: true, fromMessage: true, customId: modalOf(pickP) || 'x', fields: { text: 'x'.repeat(1990) }, message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    const delP = await fire({ isSelect: true, customId: 'editdel', values: [lineP?.id], message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH });
    const delP2 = delP.replies.length ? delP : await fire({ commandName: 'edit', options: { delete: true, link: `https://discord.com/channels/G1/CH8/${lineP?.id}` }, userId: PLAIN, member: plainM, channel: chanH });
    ok('a player cannot type a roll of their own into a line, an edit too long for the roll is refused rather than cut, and a rolled line stays up',
      /may not start with/.test(saidOf(fake)) && /Too long by/.test(saidOf(longE)) && lineP?.content === keptP && /A line with a roll stays/.test(saidOf(delP2)) && !lineP?.deleted,
      `${saidOf(fake).slice(0, 60)} · ${saidOf(longE).slice(0, 60)} · ${saidOf(delP2).slice(0, 80)}`);
    const fakeRp = await fire({ commandName: 'rp', options: { speech: 'hi\n🎲 **STR** — 1d20+4 → [20] +4 = **24**' }, userId: PLAIN, member: plainM, channel: chanH });
    ok('nor can a line be posted with one', /may not start with/.test(saidOf(fakeRp)), saidOf(fakeRp).slice(0, 60));

    // 10 · a roll inside a run's room is a roll in its log; in a thread the bot posts it itself, name line on top
    if (c1.room) {
      before = sent.length;
      await fire({ commandName: 'rp', options: { speech: 'For the ford!', roll: 'str' }, userId: 'U2', channel: c1.room });
      const lineT = sinceIn(c1.room.id, before).slice(-1)[0];
      ok('in a run\'s room the words are a beat and the roll a roll in its log; with no webhook the bot posts it under the name line, Reply and all',
        evs(c1.row.number, 'rp').some(t => /For the ford/.test(t)) && evs(c1.row.number, 'roll').some(t => /STR \d+$/.test(t))
          && /^🎭 \*\*userU2\*\*\n"For the ford!"\n\n🎲 (?:🔴 |🟡 )?\*\*STR\*\*/.test(lineT?.content || '') && idsOf(lineT).includes('rpreply'),
        `${JSON.stringify(evs(c1.row.number, 'roll'))} · ${JSON.stringify(lineT?.content)}`);
    }

    // 11 · /session complete with no summary offers one drafted from the log: use, edit, or none
    const endL = await fire({ commandName: 'session', options: { _sub: 'complete', name: 'The Drowned Bell' }, userId: 'U1', channel: chanH });
    const endIds = idsOf(endL.replies[0]);
    const keyL = (endIds.find(id => id.startsWith('sessend:edit:')) || '').split(':')[2];
    const editL = keyL ? await fire({ isButton: true, customId: `sessend:edit:${keyL}`, message: { id: nextId(), content: '', components: [] }, userId: 'U1', channel: chanH }) : { replies: [] };
    const doneL = keyL ? await fire({ isModal: true, customId: `sessendform:${keyL}`, fields: { summary: 'The bell rang once, and was still.' }, userId: 'U1', channel: chanH }) : { replies: [] };
    ok('/session complete with no summary drafts one from the log \u2014 the beats, not the seating \u2014 and Edit opens it prefilled; the save completes the run',
      /drafted from the log/.test(saidOf(endL)) && /They found the bell/.test(saidOf(endL)) && !/is seated/.test(saidOf(endL)) && ['sessend:use:', 'sessend:edit:', 'sessend:none:'].every(p => endIds.some(id => id.startsWith(p)))
        && modalOf(editL) === `sessendform:${keyL}` && /They found the bell/.test(modalFieldsOf(editL).summary || '') && qrow(lg.row?.number)?.status === 'completed' && /complete/.test(saidOf(doneL)),
      `${saidOf(endL).replace(/\s+/g, ' ').slice(0, 160)} · ${modalOf(editL)} · ${qrow(lg.row?.number)?.status}`);
    const endC2 = await fire({ commandName: 'session', options: { _sub: 'complete', name: 'The Bridge Falls' }, userId: 'U1', channel: chanH });
    const useKey = (idsOf(endC2.replies[0]).find(id => id.startsWith('sessend:use:')) || '');
    const plainUse = useKey ? await fire({ isButton: true, customId: useKey, message: { id: nextId(), content: '', components: [] }, userId: PLAIN, member: plainM, channel: chanH }) : { replies: [] };
    // Nothing logged on that one but its start: it simply ends.
    ok('a run with nothing to tell simply completes, no draft offered', !useKey ? qrow(c2.row?.number)?.status === 'completed' : /another GM/.test(saidOf(plainUse)), `${saidOf(endC2).slice(0, 80)} · ${useKey}`);
    const endC1 = await fire({ commandName: 'session', options: { _sub: 'complete', name: 'The Ford Holds' }, userId: 'U1', channel: chanH });
    const useC1 = idsOf(endC1.replies[0]).find(id => id.startsWith('sessend:use:'));
    const usedC1 = useC1 ? await fire({ isButton: true, customId: useC1, message: { id: nextId(), content: '', components: [] }, userId: 'U1', channel: chanH }) : { replies: [] };
    const again = useC1 ? await fire({ isButton: true, customId: useC1, message: { id: nextId(), content: '', components: [] }, userId: 'U1', channel: chanH }) : { replies: [] };
    ok('Use this completes the run with the draft as its tale; the draft is spent after',
      !!useC1 && qrow(c1.row?.number)?.status === 'completed' && /complete/.test(saidOf(usedC1)) && /draft has gone/.test(saidOf(again)),
      `${useC1} · ${qrow(c1.row?.number)?.status} · ${saidOf(again).slice(0, 60)}`);

    guild.members.fetch = realFetchH; delete guild.members.search;
    const threwH = loggedH.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrH;
    ok('nothing in the H walk threw', threwH.length === 0, threwH.slice(0, 3).join('\n        '));
  }

  // ── Build I (2026-11-07): played: and part:, advantage on several dice,
  // the talk corrected and raw, answering as an NPC, the GM run archive, and
  // a 5e server through every shared system ─────────────────────────────
  if (dbHandle) {
    const realErrI = console.error; const loggedI = [];
    console.error = (...a) => { loggedI.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const allOf = (r) => r.replies.map(x => JSON.stringify(x)).join(' ');
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    const sinceIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const settle = async () => { for (let i = 0; i < 80; i++) await new Promise(r => setImmediate(r)); };
    const qrow = (n) => dbHandle.prepare("SELECT * FROM quests WHERE guild_id='G1' AND number=?").get(n);
    const PLAIN = 'U8';
    const plainM = { id: PLAIN, roles: { cache: new Map() }, permissions: { has: () => false } };
    const realFetchI = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchI(uid); if (uid === PLAIN) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const chanI = new FakeChannel('CH9', 0, 'i-walk', guild); channelsById.set(chanI.id, chanI);
    const mkIn = (ch, text, uid = 'U2', g = guild) => ({ id: nextId(), content: text, author: { id: uid, bot: false, username: `user${uid}` }, guild: g, channel: ch, channelId: ch.id,
      member: { id: uid, displayName: `Hero${uid}`, roles: { cache: new Map() }, permissions: { has: () => true } }, attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    const typed = async (ch, text, uid, g = guild) => { replies.length = 0; for (const fn of listeners.messageCreate || []) await fn(mkIn(ch, text, uid, g)); await settle(); return replies.map(x => JSON.stringify(x)).join(' '); };
    const openInstI = async (options, users = ['U2']) => {
      const r0 = await fire({ commandName: 'instance', options: { _sub: 'start', ...options }, userId: 'U1', channel: chanI });
      const menu = (r0.replies[0]?.components || [])[0]?._d?.components?.[0]?._d || {};
      const key = String(menu.customId || '').split(':')[1];
      if (!key) return { r0, row: null };
      await fire({ isSelect: true, customId: menu.customId, values: users, message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanI });
      await fire({ isButton: true, customId: `encgo:${key}`, message: { id: nextId(), content: 'x', components: [] }, userId: 'U1', channel: chanI });
      return { r0, row: dbHandle.prepare("SELECT * FROM quests WHERE guild_id='G1' AND kind='encounter' ORDER BY number DESC LIMIT 1").get() };
    };

    // 1 · played: banks an older quest's time; part: makes an instance a chapter
    const lgP = await openInstI({ name: 'The Long Siege', as: 'legacy', played: '2h30m' });
    const lgBad = await fire({ commandName: 'instance', options: { _sub: 'start', name: 'Bad Clock', as: 'legacy', played: 'soon' }, userId: 'U1', channel: chanI });
    ok('/instance as:legacy played: banks the time already played into the run\'s clock and says so; a time that does not read is refused',
      lgP.row?.played_ms === 9000000 && Number(lgP.row?.elapsed_ms) >= 9000000 && /2h 30m played already/.test(saidOf(lgP.r0)) && /reads like/.test(saidOf(lgBad)),
      `${lgP.row?.played_ms} · ${lgP.row?.elapsed_ms} · ${saidOf(lgP.r0).slice(0, 120)} · ${saidOf(lgBad).slice(0, 80)}`);
    const sp1 = await openInstI({ name: 'Side Path' });
    const sp2 = await openInstI({ name: 'Side Path Two' });
    const addP = await fire({ commandName: 'campaign', options: { _sub: 'add', campaign: 'The Probe War', quest: sp1.row?.number, part: 7 }, userId: 'U1', channel: chanI });
    const asChapter = qrow(sp1.row?.number);
    const addP2 = await fire({ commandName: 'campaign', options: { _sub: 'add', campaign: 'The Probe War', quest: sp2.row?.number, part: 7 }, userId: 'U1', channel: chanI });
    const addBoard = await fire({ commandName: 'campaign', options: { _sub: 'add', campaign: 'The Probe War', quest: 950, part: 2 }, userId: 'U1', channel: chanI });
    const remP = await fire({ commandName: 'campaign', options: { _sub: 'remove', quest: sp1.row?.number }, userId: 'U1', channel: chanI });
    const afterRem = qrow(sp1.row?.number);
    ok('/campaign add part: makes an instance a numbered chapter, says when the part is already there, refuses a board quest; unlinked, a chapter is an encounter again',
      asChapter?.instance_kind === 'chapter' && asChapter?.part === 7 && !!asChapter?.campaign_id && /Part 7 of/.test(saidOf(addP))
        && /already there/.test(saidOf(addP2)) && /is for runs opened with/.test(saidOf(addBoard)) && qrow(950)?.instance_kind !== 'chapter'
        && afterRem?.instance_kind === 'encounter' && afterRem?.part == null && !afterRem?.campaign_id && /an encounter again/.test(saidOf(remP)),
      `${asChapter?.instance_kind}/${asChapter?.part} · ${saidOf(addP2).slice(0, 80)} · ${saidOf(addBoard).slice(0, 60)} · ${afterRem?.instance_kind}/${afterRem?.part} · ${saidOf(remP).slice(0, 60)}`);

    // 2 · advantage on several dice: the set twice, the better total kept; /rp dice spend a mark
    const ra = await typed(chanI, 'ra 2d6', 'U2');
    dbHandle.prepare("UPDATE characters SET next_mark='adv' WHERE guild_id='G1' AND user_id='U2'").run();
    let before = sent.length;
    await fire({ commandName: 'rp', options: { speech: 'Two dice.', dice: '2d6' }, userId: 'U2', channel: chanI });
    const lineDice = sinceIn('CH9', before).find(m => m.webhookId);
    const markLeft = dbHandle.prepare("SELECT next_mark FROM characters WHERE guild_id='G1' AND user_id='U2'").get()?.next_mark;
    ok('advantage on 2d6 rolls the set twice, the one not kept struck through; a mark is spent by /rp dice as by any roll',
      /2d6 \(advantage\) → \[\d+, \d+\] ~~\[\d+, \d+\]~~ = /.test(ra) && /2d6 \(advantage\) → \[\d+, \d+\] ~~\[\d+, \d+\]~~/.test(lineDice?.content || '') && !markLeft,
      `${ra.slice(0, 160)} · ${JSON.stringify(lineDice?.content)} · mark ${markLeft}`);

    // 3 · the talk, corrected and raw: an edit corrects, a deletion marks
    await fire({ commandName: 'instance', options: { _sub: 'start', quest: 951, record: true }, userId: 'U1', channel: chanI });
    const room951 = qrow(951)?.run_thread_id ? channelsById.get(qrow(951).run_thread_id) : null;
    const t1 = mkIn(room951 || chanI, 'We ride at dawn.'), t2 = mkIn(room951 || chanI, 'Nobody saw that.'), t3 = mkIn(room951 || chanI, 'Hold the line.');
    for (const m of [t1, t2, t3]) for (const fn of listeners.messageCreate || []) await fn(m);
    await settle();
    const raw = (t, d) => { for (const fn of listeners.raw || []) fn({ t, d: { guild_id: 'G1', channel_id: room951?.id, ...d } }); };
    raw('MESSAGE_UPDATE', { id: t1.id, content: 'We ride at first light.', author: { id: 'U2', username: 'userU2' }, member: { nick: 'HeroU2' } });
    raw('MESSAGE_DELETE', { id: t2.id });
    raw('MESSAGE_UPDATE', { id: t3.id, content: 'Hold the line.', author: { id: 'U2', username: 'userU2' }, member: { nick: 'HeroU2' } });
    raw('MESSAGE_UPDATE', { id: t3.id, content: 'a bot said this', author: { id: 'BOT', bot: true } });
    const tk = (m) => dbHandle.prepare("SELECT * FROM quest_events WHERE guild_id='G1' AND kind='talk' AND msg_id=?").get(String(m.id));
    ok('an edit to a recorded line corrects it and keeps its first wording; a deletion marks it; an unchanged edit, or a bot\'s, leaves it be',
      !!room951 && tk(t1)?.text === 'HeroU2: We ride at first light.' && tk(t1)?.first_text === 'HeroU2: We ride at dawn.' && tk(t2)?.gone === 1
        && tk(t3)?.first_text == null && tk(t3)?.text === 'HeroU2: Hold the line.',
      JSON.stringify([tk(t1), tk(t2), tk(t3)].map(r => r && { text: r.text, first: r.first_text, gone: r.gone })));

    // 4 · the GM run archive: set, filled with what came before, a thread per GM
    const arch = new FakeChannel('ARCH1', 15, 'gm-run-archive', guild); channelsById.set('ARCH1', arch);
    const setA = await fire({ commandName: 'config', options: { _group: 'channels', _sub: 'gmarchive', forum: arch }, userId: 'U1', channel: chanI });
    for (let i = 0; i < 8; i++) await settle();
    const cfgA = dbHandle.prepare("SELECT gm_run_archive, run_archive_backfilled FROM guild_config WHERE guild_id='G1'").get();
    const archThreads = threads.filter(t => t.parentId === 'ARCH1');
    const u1Thread = archThreads.find(t => /userU1/.test(t.name));
    const filedN = dbHandle.prepare("SELECT COUNT(*) AS c FROM quests WHERE guild_id='G1' AND archive_msg_id IS NOT NULL").get().c;
    const headerA = u1Thread?._starter?.content || '';
    ok('/config channels gmarchive sets the forum and files every finished run already in the bot under its GM; the header holds the totals and what is running now, with its time',
      cfgA?.gm_run_archive === 'ARCH1' && Number(cfgA?.run_archive_backfilled) > 0 && !!u1Thread && filedN >= 2 && /every run they have led/.test(headerA)
        && /Running now/.test(headerA) && /The Long Siege — 2h 3\dm/.test(headerA) && /\d+ runs? · \d+h \d\dm\*\* in all/.test(headerA),
      `${JSON.stringify(cfgA)} · ${archThreads.map(t => t.name).join(',')} · filed ${filedN} · ${headerA.replace(/\s+/g, ' ').slice(0, 260)} · ${saidOf(setA).slice(0, 80)}`);
    before = sent.length;
    const end951 = await fire({ commandName: 'session', options: { _sub: 'complete', name: 'Long Road', summary: 'They reached the city walls.' }, userId: 'U1', channel: chanI });
    for (let i = 0; i < 4; i++) await settle();
    // The run's home is its own thread, so the story and the corrected talk post there, review button and all.
    const pubPost = sent.slice(before).filter(x => x.channel === room951?.id).map(x => x.msg).find(m => (m.files || []).length);
    const pubFiles = [...end951.replies.flatMap(x => x.files || []), ...(pubPost?.files || [])];
    const pubNames = pubFiles.map(f => f?.b?.name || '');
    const post951 = sent.slice(before).filter(x => x.channel === u1Thread?.id).map(x => x.msg).find(m => /Long Road/.test(m.content || '') && (m.files || []).length);
    const postNames = (post951?.files || []).map(f => f?.b?.name || '');
    const fileText = (arr, re) => { const f = (arr || []).find(x => re.test(x?.b?.name || '')); return f?.a ? Buffer.from(f.a).toString('utf8') : ''; };
    const corT = fileText(pubFiles, /talk\.txt$/), rawT = fileText(post951?.files, /-raw\.txt$/);
    const storyBuf = pubFiles.find(f => /story\.pdf$/.test(f?.b?.name || ''))?.a;
    let story = null; try { story = JSON.parse(storyBuf.slice(storyBuf.indexOf('DDICESCROLLv1') + 13).toString('utf8')); } catch {}
    ok('a recorded run ends with its talk twice: the corrected transcript beside the story for everyone, the raw one only in the GM archive; the scroll keeps the story',
      pubNames.some(n => /talk\.txt$/.test(n)) && !pubNames.some(n => /-raw\.txt$/.test(n)) && ['story.pdf', 'record.pdf', 'talk.txt', 'raw.txt'].every(x => postNames.some(n => n.endsWith(x)))
        && /HeroU2: We ride at first light\./.test(corT) && !/Nobody saw that/.test(corT) && !/We ride at dawn/.test(corT)
        && /HeroU2: We ride at dawn\.\n\s+↳ edited to: We ride at first light\./.test(rawT) && /HeroU2: Nobody saw that\.\n\s+↳ deleted/.test(rawT) && /1 edited, 1 deleted/.test(rawT)
        && !/We ride/.test(story?.body || 'We ride') && /lines? of table talk were kept/.test(story?.body || ''),
      `pub ${pubNames.join(',')} · post ${postNames.join(',')} · cor ${corT.replace(/\s+/g, ' ').slice(0, 140)} · raw ${rawT.replace(/\s+/g, ' ').slice(0, 200)} · story ${(story?.body || '').replace(/\s+/g, ' ').slice(0, 120)}`);
    const headerB = u1Thread?._starter?.content || '';
    ok('the run\'s post carries its runtime and party, and the header no longer counts it as running',
      /⏱️ \*\*\d+h \d\dm\*\*/.test(post951?.content || '') && /👥 /.test(post951?.content || '') && !/Long Road — \d/.test(headerB) && qrow(951)?.archive_msg_id === post951?.id,
      `${(post951?.content || '').replace(/\s+/g, ' ').slice(0, 200)} · ${headerB.replace(/\s+/g, ' ').slice(0, 160)}`);
    const rv = await fire({ isModal: true, customId: 'fbq:951', fields: { scale: '9', body: 'A fine ride.' }, userId: 'U2', channel: chanI });
    for (let i = 0; i < 3; i++) await settle();
    const rvPost = sent.filter(x => x.channel === u1Thread?.id).map(x => x.msg).find(m => /\*\*Review\*\*/.test(m.content || ''));
    ok('a review of the run answers its post in the archive', !!rvPost && rvPost.replyTo === qrow(951)?.archive_msg_id && /9\/10/.test(rvPost.content) && /A fine ride/.test(rvPost.content),
      `${JSON.stringify(rvPost?.content)} · ${rvPost?.replyTo} vs ${qrow(951)?.archive_msg_id} · ${saidOf(rv).slice(0, 60)}`);

    // 5 · answering as an NPC: 🎭 GM beside 💬 Reply, and /npc say reply:
    if (!dbHandle.prepare("SELECT 1 FROM npcs WHERE guild_id='G1' AND name='Dockmaster'").get()) await fire({ commandName: 'npc', options: { _sub: 'create', name: 'Dockmaster', str: 2 }, userId: 'U1' });
    before = sent.length;
    await fire({ commandName: 'rp', options: { speech: 'Who goes there?' }, userId: 'U2', channel: chanI });
    const lineQ = sinceIn('CH9', before).find(m => m.webhookId);
    const plainGm = await fire({ isButton: true, customId: 'rpnpc', message: lineQ, userId: PLAIN, member: plainM, channel: chanI });
    const gmBox = await fire({ isButton: true, customId: 'rpnpc', message: lineQ, userId: 'U1', channel: chanI });
    const dockKey = require('crypto').createHash('sha1').update('dockmaster').digest('hex').slice(0, 10);
    before = sent.length;
    await fire({ isModal: true, customId: modalOf(gmBox) || 'x', fields: { action: 'squints', speech: 'The harbour watch.' }, selects: { who: [dockKey] }, userId: 'U1', channel: chanI });
    const lineA = sinceIn('CH9', before).find(m => m.webhookId);
    ok('under every /rp line, 🎭 GM beside 💬 Reply: a player is told it is the GM\'s; a GM picks who answers, and the answer jumps back to the line',
      idsOf(lineQ).includes('rpreply') && idsOf(lineQ).includes('rpnpc') && /the GM’s/.test(saidOf(plainGm)) && modalOf(gmBox) === `npcans:CH9:${lineQ?.id}`
        && (lineA?.content || '').startsWith(`-# ↪ replying to [userU2](https://discord.com/channels/G1/CH9/${lineQ?.id})`) && /The harbour watch/.test(lineA?.content || ''),
      `${JSON.stringify(idsOf(lineQ))} · ${saidOf(plainGm).slice(0, 60)} · ${modalOf(gmBox)} · ${JSON.stringify(lineA?.content)}`);
    before = sent.length;
    const sayR = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'Move along.', reply: `https://discord.com/channels/G1/CH9/${lineQ?.id}` }, userId: 'U1', channel: chanI });
    const lineS = sinceIn('CH9', before).find(m => m.webhookId);
    const sayBad = await fire({ commandName: 'npc', options: { _sub: 'say', name: 'Dockmaster', speech: 'x', reply: 'https://discord.com/channels/G9/1/2' }, userId: 'U1', channel: chanI });
    ok('/npc say reply: answers a linked line with the jump header; a link from another server is refused',
      (lineS?.content || '').startsWith(`-# ↪ replying to [userU2](https://discord.com/channels/G1/CH9/${lineQ?.id})`) && /Move along/.test(lineS?.content || '') && /❌/.test(saidOf(sayBad)),
      `${JSON.stringify(lineS?.content)} · ${allOf(sayR).slice(0, 200)} · ${saidOf(sayBad).slice(0, 80)}`);

    // 6 · a 5e server, through every shared system
    const g5 = {
      id: 'G5', name: 'Probe Keep',
      members: { me: { id: 'BOT', permissions: { has: () => true } },
        fetch: async (uid) => ({ id: uid, nickname: null, displayName: `user${uid}`, user: { id: uid, username: `user${uid}`, tag: `user${uid}#1` }, roles: { cache: new Map() }, permissions: { has: () => true } }),
        cache: new Map() },
      roles: { everyone: { id: 'EVERYONE5' }, cache: new Map() },
      channels: { create: async ({ name, type }) => { const c = new FakeChannel(nextId(), type ?? 0, name, g5); channelsById.set(c.id, c); return c; },
        fetch: async () => new FakeCollection(channelsById), cache: new FakeCollection() },
    };
    if (lastClient) { lastClient.guilds.cache.set('G5', g5); g5.client = lastClient; }
    const c5 = new FakeChannel('C5', 0, 'keep', g5); channelsById.set('C5', c5);
    const c5a = new FakeChannel('C5A', 0, 'approvals', g5); channelsById.set('C5A', c5a);
    const f5 = (over) => fire({ guild: g5, channel: c5, userId: 'U1', ...over });
    const regBefore = registered.length;
    const rs = await f5({ commandName: 'config', options: { _group: 'channels', _sub: 'ruleset', system: 'dnd5e' } });
    await settle();
    const body5 = registered.slice(regBefore).slice(-1)[0] || [];
    const rollStat5 = (body5.find(c => c.name === 'roll')?.options || []).find(o => o.name === 'stat');
    ok('a server set to 5e is handed a 5e picker: /roll stat: offers the six, no Luck, and the Knightfall commands are gone',
      /now plays by \*\*D&D 5e/.test(saidOf(rs)) && JSON.stringify((rollStat5?.choices || []).map(c => c.value)) === '["str","dex","con","int","wis","cha"]'
        && body5.some(c => c.name === 'dnd'),
      `${saidOf(rs).slice(0, 60)} · ${JSON.stringify((rollStat5?.choices || []).map(c => c.value))} · ${body5.map(c => c.name).join(',')}`);
    await f5({ commandName: 'dnd', options: { _sub: 'create', name: 'Mira', class: 'Fighter', level: 3, str: 16, dex: 12, con: 14, int: 8, wis: 10, cha: 13, saves: 'str, con', skills: 'athletics, stealth' }, userId: 'U51' });
    const mira = dbHandle.prepare("SELECT * FROM characters WHERE guild_id='G5' AND user_id='U51'").get();
    const tInt = await typed(c5, 'int', 'U51', g5), tCha = await typed(c5, 'r cha', 'U51', g5);
    const tChad = await typed(c5, 'Chad', 'U51', g5), tChadQ = await typed(c5, '?chad', 'U51', g5), tLck = await typed(c5, 'lck', 'U51', g5);
    const rInt = await f5({ commandName: 'roll', options: { stat: 'int' }, userId: 'U51' });
    const rLck = await f5({ commandName: 'roll', options: { stat: 'lck' }, userId: 'U51' });
    ok('5e typed rolls and /roll add the modifier — int is 1d20-1, cha 1d20+1; "Chad" alone is a name, ?chad a roll; Luck is no stat here',
      mira?.int === 8 && /1d20-1/.test(tInt) && /1d20\+1/.test(tCha) && !tChad && /1d20\+1 \(disadvantage\)/.test(tChadQ) && !tLck
        && /1d20-1/.test(allOf(rInt)) && /not a stat here/.test(saidOf(rLck)),
      `int ${tInt.slice(0, 80)} · cha ${tCha.slice(0, 60)} · chad ${tChad.slice(0, 40)} · ?chad ${tChadQ.slice(0, 80)} · lck ${tLck.slice(0, 40)} · /roll ${allOf(rInt).slice(0, 80)} · ${saidOf(rLck).slice(0, 60)}`);

    // /gm dc: a skill and a save, proficiency where the sheet has it; an NPC rolls its modifier
    const press5 = async (r) => { const id = idsOf(r.replies[0]).find(x => x.startsWith('dcroll:')); return id ? f5({ isButton: true, customId: id, message: { id: nextId(), content: 'x', components: [] }, userId: 'U51' }) : { replies: [] }; };
    const dcSk = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51', dc: 10, stat: 'stealth' } });
    const pSk = await press5(dcSk);
    const dcSv = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51', dc: 12, stat: 'con', save: true } });
    const pSv = await press5(dcSv);
    const dcSv2 = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51', dc: 12, stat: 'dex', save: true } });
    const pSv2 = await press5(dcSv2);
    const dcBad = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51', dc: 12, stat: 'stealth', save: true } });
    const dcSan = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51', dc: 12, stat: 'dex', success_sanction: 'lck+1' } });
    ok('5e /gm dc: Stealth adds DEX and proficiency (1d20+3), a CON save its proficiency (1d20+4), a DEX save none (1d20+1); a save is never a skill; a sanction is a 5e score',
      /Stealth \(DEX\) check — DC 10/.test(saidOf(dcSk)) && /Stealth \(DEX\) vs \*\*DC 10\*\*/.test(saidOf(pSk)) && /1d20\+3/.test(saidOf(pSk))
        && /CON saving throw — DC 12/.test(saidOf(dcSv)) && /1d20\+4/.test(saidOf(pSv)) && /CON save vs/.test(saidOf(pSv)) && /1d20\+1/.test(saidOf(pSv2))
        && /goes with an ability/.test(saidOf(dcBad)) && /reads like `cha\+1`/.test(saidOf(dcSan)),
      `${saidOf(dcSk).slice(0, 60)} · ${saidOf(pSk).replace(/\s+/g, ' ').slice(0, 120)} · ${saidOf(pSv).replace(/\s+/g, ' ').slice(0, 100)} · ${saidOf(pSv2).replace(/\s+/g, ' ').slice(0, 80)} · ${saidOf(dcBad).slice(0, 60)} · ${saidOf(dcSan).slice(0, 60)}`);
    const mkOgre = await f5({ commandName: 'npc', options: { _sub: 'create', name: 'Ogre', str: 19, int: 5, cha: 7 } });
    const ogre = dbHandle.prepare("SELECT * FROM npcs WHERE guild_id='G5' AND name='Ogre'").get();
    const badNpc = await f5({ commandName: 'npc', options: { _sub: 'create', name: 'Giant', str: 40 } });
    const dcNpc = await f5({ commandName: 'gm', options: { _sub: 'dc', npcs: 'Ogre', dc: 10, stat: 'int' } });
    ok('5e /npc create takes the six scores (the rest an ordinary 10, 1 to 30); its check on the card adds the modifier — INT 5 is 1d20-3',
      ogre?.int === 5 && ogre?.cha === 7 && ogre?.wis === 10 && ogre?.dex === 10 && /1 to 30/.test(saidOf(badNpc)) && /🎭 \*\*Ogre\*\* — 🎲\s+1d20-3/.test(saidOf(dcNpc)),
      `${JSON.stringify(ogre && { int: ogre.int, cha: ogre.cha, wis: ogre.wis, hp: ogre.hp_current })} · ${saidOf(mkOgre).slice(0, 60)} · ${saidOf(badNpc).slice(0, 60)} · ${saidOf(dcNpc).replace(/\s+/g, ' ').slice(0, 140)}`);
    const win5 = await f5({ commandName: 'gm', options: { _sub: 'dc', target: 'U51' } });
    const sub5 = await f5({ isModal: true, customId: modalOf(win5) || 'x', fields: { scene: '', check: 'dex save 13', success: '[cha+1]\nNimble.', fail: '', targets: '' } });
    const sub5b = await f5({ isModal: true, customId: modalOf(win5) || 'x', fields: { scene: '', check: 'sleight of hand 11', success: '', fail: '', targets: '<@U51>' } });
    ok('the writing window reads 5e: "dex save 13" is a DEX saving throw, "sleight of hand 11" a skill, and [cha+1] a sanction',
      /^dcform:/.test(modalOf(win5) || '') && /DEX saving throw — DC 13/.test(saidOf(sub5)) && /success: CHA \+1/.test(saidOf(sub5)) && /Sleight of Hand \(DEX\) check — DC 11/.test(saidOf(sub5b)),
      `${modalOf(win5)} · ${saidOf(sub5).replace(/\s+/g, ' ').slice(0, 120)} · ${saidOf(sub5b).replace(/\s+/g, ' ').slice(0, 100)}`);

    // targets, /char set, the guards
    before = sent.length;
    await f5({ commandName: 'target', options: { _sub: 'create', name: 'Straw Man', dc: 5 } });
    const straw = sinceIn('C5', before).find(m => /Straw Man/.test(m.content || '') && (m.components || []).length);
    // read now: a failed swing reposts the card and takes these buttons off it
    const strawIds = idsOf(straw), strawRows = (straw?.components || []).length;
    const tBad = await f5({ commandName: 'target', options: { _sub: 'create', name: 'Lucky', stat: 'lck' } });
    const setInt = await f5({ commandName: 'char', options: { _sub: 'set', field: 'int', value: '14', user: 'U51' } });
    const setLck = await f5({ commandName: 'char', options: { _sub: 'set', field: 'lck', value: '3', user: 'U51' } });
    const mkKf = await f5({ commandName: 'char', options: { _sub: 'create', str: 3 }, userId: 'U53' });
    const hero5 = await f5({ commandName: 'npc', options: { _sub: 'hero', name: 'Ogre', stat: 'str' } });
    const pressT = straw ? await f5({ isButton: true, customId: 'tgtatk:int', message: straw, userId: 'U51' }) : { replies: [] };
    before = sent.length;
    const swing = await f5({ isModal: true, fromMessage: true, customId: modalOf(pressT) || 'x', fields: { action: 'thinks hard', speech: '' }, message: straw, userId: 'U51' });
    const swingText = saidOf(swing) + ' ' + sinceIn('C5', before).map(m => m.content).join(' ');
    ok('5e targets offer the six over two rows and refuse Luck; INT swings with its modifier (14 → 1d20+2); /char set takes a 5e score and refuses Luck; /char create and Heroes point elsewhere',
      ['tgtatk:str', 'tgtatk:dex', 'tgtatk:con', 'tgtatk:int', 'tgtatk:wis', 'tgtatk:cha'].every(id => strawIds.includes(id)) && strawRows === 2
        && /Flat d20, STR, DEX, CON, INT, WIS, CHA/.test(saidOf(tBad)) && /INT set to \*\*14\*\* \(\+2\)/.test(saidOf(setInt)) && /no Luck/.test(saidOf(setLck))
        && /`\/dnd create`/.test(saidOf(mkKf)) && /belong to Knightfall/.test(saidOf(hero5)) && /1d20\+2/.test(swingText),
      `${JSON.stringify(strawIds)} · ${saidOf(tBad).slice(0, 80)} · ${saidOf(setInt).slice(0, 60)} · ${saidOf(setLck).slice(0, 50)} · ${saidOf(mkKf).slice(0, 50)} · ${saidOf(hero5).slice(0, 50)} · ${swingText.replace(/\s+/g, ' ').slice(0, 120)}`);

    // a 5e sheet travels as one: exported, refused by the other system, imported and approved
    const exp5 = await f5({ commandName: 'char', options: { _sub: 'export', format: 'text' }, userId: 'U51' });
    const block5 = saidOf(exp5);
    dbHandle.prepare("UPDATE guild_config SET approval_channel_id='C5A' WHERE guild_id='G5'").run();
    const kfBlock = '[TTRPG SHEET]\nNAME:Knight\nORDER:\nCLASS:\nSTR:4\nCON:3\nDEX:3\nWIS:3\nLCK:3\n';
    const impKf = await f5({ commandName: 'char', options: { _sub: 'import', summary: kfBlock }, userId: 'U52' });
    before = sent.length;
    const imp5 = await f5({ commandName: 'char', options: { _sub: 'import', summary: block5 }, userId: 'U52' });
    const card5 = sinceIn('C5A', before).find(m => idsOf(m).includes('impok:U52'));
    const ok5 = card5 ? await f5({ isButton: true, customId: 'impok:U52', message: card5, userId: 'U1', channel: c5a }) : { replies: [] };
    const u52 = dbHandle.prepare("SELECT * FROM characters WHERE guild_id='G5' AND user_id='U52'").get();
    ok('a 5e sheet exports as a 5e block, is refused by a Knightfall sheet\'s server and the other way round, and lands whole on its own system',
      /SYSTEM:dnd5e/.test(block5) && /INT:14/.test(block5) && /SKILLS:athletics,stealth/.test(block5) && /made for \*\*Knightfall\*\*/.test(saidOf(impKf))
        && !!card5 && /level 3 Fighter/.test(card5?.content || '') && u52?.int === 14 && u52?.level === 3 && u52?.char_class === 'Fighter' && u52?.hp_current === 28
        && /"skills":\["athletics","stealth"\]/.test(u52?.proficient || ''),
      `${block5.replace(/\s+/g, ' ').slice(0, 160)} · ${saidOf(impKf).slice(0, 80)} · ${(card5?.content || '').replace(/\s+/g, ' ').slice(0, 120)} · ${JSON.stringify(u52 && { int: u52.int, level: u52.level, hp: u52.hp_current, prof: u52.proficient })} · ${saidOf(ok5).slice(0, 60)}`);

    // the auto-pilot: the strike's bonus against Armour Class, in both auto modes
    await f5({ commandName: 'npc', options: { _group: 'manage', _sub: 'create5e', name: 'Imp', ac: 13, hp: 10, attack: 5, damage: '1d4+3' } });
    const realTO = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    before = sent.length;
    const full5 = await f5({ commandName: 'fight', options: { _sub: 'auto', mode: 'full', npcs: 'Ogre, Imp' } });
    for (let i = 0; i < 6; i++) await settle();
    const fullText = sinceIn('C5', before).map(m => m.content || '').join('\n');
    dbHandle.prepare("UPDATE npcs SET hp_current=8 WHERE guild_id='G5' AND name='Ogre'").run();
    dbHandle.prepare("UPDATE npcs SET hp_current=10 WHERE guild_id='G5' AND name='Imp'").run();
    before = sent.length;
    const npcOnly5 = await f5({ commandName: 'fight', options: { _sub: 'auto', mode: 'npconly', npcs: 'Ogre, Imp' } });
    for (let i = 0; i < 6; i++) await settle();
    globalThis.setTimeout = realTO;
    const npcText = sinceIn('C5', before).map(m => m.content || '').join('\n') + ' ' + saidOf(npcOnly5);
    ok('a 5e auto fight strikes against Armour Class — full and NPCs-only alike — never with an opposed defence roll',
      /against \*\*(Imp|Ogre)\*\*'s \*\*AC (13|10)\*\*/.test(fullText) && !/defends with/.test(fullText) && /against \*\*(Imp|Ogre)\*\*'s \*\*AC (13|10)\*\*/.test(npcText) && !/defends with/.test(npcText),
      `${fullText.replace(/\s+/g, ' ').slice(0, 200)} ‖ ${npcText.replace(/\s+/g, ' ').slice(0, 200)} · ${saidOf(full5).slice(0, 60)}`);

    // a 5e fight's strike row: what 5e attacks with
    await f5({ commandName: 'fight', options: { _sub: 'end' } });
    before = sent.length;
    const F51 = '100000000000000051', F52 = '100000000000000052';
    for (const id of [F51, F52]) dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, dex, con, int, wis, cha, level, hp_current) VALUES ('G5', ?, 14, 12, 12, 10, 10, 10, 2, 12)").run(id);
    const fs5 = await f5({ commandName: 'fight', options: { _sub: 'start', players: `<@${F51}> <@${F52}>`, manual: true } });
    const rowIds5 = [...fs5.replies.flatMap(x => idsOf(x)), ...sinceIn('C5', before).flatMap(m => idsOf(m))];
    const pick5 = await f5({ commandName: 'fight', options: { _sub: 'atk' }, userId: F51 });
    const pickIds5 = pick5.replies.flatMap(x => idsOf(x));
    await f5({ commandName: 'fight', options: { _sub: 'end' } });
    ok('a 5e fight offers the strike row 5e attacks with \u2014 STR, DEX, INT, WIS, CHA \u2014 and never Luck',
      [...rowIds5, ...pickIds5].includes('fatk:int') && [...rowIds5, ...pickIds5].includes('fatk:cha') && ![...rowIds5, ...pickIds5].includes('fatk:lck'),
      `${JSON.stringify(rowIds5)} · ${JSON.stringify(pickIds5)} · ${saidOf(fs5).slice(0, 80)}`);

    guild.members.fetch = realFetchI;
    const threwI = loggedI.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrI;
    ok('nothing in the I walk threw', threwI.length === 0, threwI.slice(0, 3).join('\n        '));
  }

  // ── Build J (2026-11-07): initiative, and the turn clock in an order
  // and in a fight ──────────────────────────────────────────────────────
  if (dbHandle) {
    const realErrK = console.error; const loggedK = [];
    console.error = (...a) => { loggedK.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const modalOf = (r) => r.replies.find(x => x.modal)?.modal || null;
    const keyOf = (n) => require('crypto').createHash('sha1').update(String(n).toLowerCase()).digest('hex').slice(0, 10);
    const clockTick = async () => { for (const t of ticks.filter(t => /turnClockTick/.test(String(t.fn)))) { try { await t.fn(); } catch (e) { loggedK.push(`tick: ${e.message}`); } } };
    const P1 = '100000000000000061', P2 = '100000000000000062', PL = '100000000000000063', P4 = '100000000000000064';
    const N1 = `user${P1}`, N2 = `user${P2}`;
    const plainK = { id: PL, roles: { cache: new Map() }, permissions: { has: () => false } };
    const realFetchK = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchK(uid); if (uid === PL) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    for (const [id, dex] of [[P1, 4], [P2, 1], [PL, 1], [P4, 2]]) dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current) VALUES ('G1', ?, 3, 3, ?, 2, 2, 30)").run(id, dex);
    for (const [n, dex, hp] of [['Wolf', 3, 30], ['Boar', 1, 40]]) dbHandle.prepare("INSERT OR REPLACE INTO npcs (guild_id, name, str, con, dex, wis, lck, hp_current) VALUES ('G1', ?, 2, 2, ?, 1, 1, ?)").run(n, dex, hp);
    const chJ = new FakeChannel('CJ1', 0, 'j-walk', guild); channelsById.set(chJ.id, chJ);
    const fJ = (over) => fire({ channel: chJ, ...over });
    const order = () => dbHandle.prepare("SELECT * FROM turn_orders WHERE guild_id='G1' AND channel_id='CJ1'").get();
    // the turn's key as its buttons carry it: the order's stamp, the turn's serial
    const K = () => { const o = order(); return `${o?.created_at || 0}-${o?.turn_seq || 0}`; };
    const has = (m, prefix) => idsOf(m).some(id => id === prefix || id.startsWith(`${prefix}:`));
    const lastIn = (cid) => sent.filter(x => x.channel === cid).map(x => x.msg).pop();
    const newIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const ev930 = () => dbHandle.prepare("SELECT text FROM quest_events WHERE guild_id='G1' AND number=930 AND kind='turn' ORDER BY id").all().map(r => r.text);
    const mkJ = (ch, text, uid) => ({ id: nextId(), content: text, author: { id: uid, bot: false, username: `user${uid}` }, guild, channel: ch, channelId: ch.id,
      member: { id: uid, roles: { cache: new Map() }, permissions: { has: () => false } }, attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    // a run in the room, PL on its party: the card calls them
    dbHandle.prepare("INSERT OR REPLACE INTO quests (guild_id, number, name, status, kind, created_at, run_channel_id, gm_id, started_at, elapsed_ms) VALUES ('G1', 930, 'Probe Turns', 'active', 'encounter', ?, 'CJ1', 'U1', ?, 0)").run(Date.now(), Date.now());
    dbHandle.prepare("INSERT OR REPLACE INTO quest_members (guild_id, number, user_id, state) VALUES ('G1', 930, ?, 'party')").run(PL);

    // 1 · the call
    const plainInit = await fJ({ commandName: 'session', options: { _sub: 'initiative' }, userId: PL, member: plainK });
    let n0 = sent.length;
    const call = await fJ({ commandName: 'session', options: { _sub: 'initiative', players: `<@${P1}>`, npcs: 'Wolf x2, Brigand', remind: 5, skip: 15 }, userId: 'U1' });
    const card = newIn('CJ1', n0).find(m => has(m, 'init:join'));
    const o1 = order();
    const ents1 = JSON.parse(o1?.entrants || '[]');
    const clk = dbHandle.prepare("SELECT * FROM turn_clocks WHERE guild_id='G1' AND channel_id='CJ1'").get();
    const again = await fJ({ commandName: 'session', options: { _sub: 'initiative' }, userId: 'U1' });
    ok('/session initiative: a player is refused; the GM\'s call posts the card — Join, Leave, Add NPCs, Close & roll, Cancel — pinging the run\'s party, players and NPCs in at once (Wolf x2 two temporary copies, Brigand a name), the channel\'s clock set; a second call is refused',
      /Only GMs call for initiative/.test(saidOf(plainInit)) && !!card && ['init:join', 'init:leave', 'init:npcs', 'init:close', 'init:cancel'].every(id => idsOf(card).includes(`${id}:${o1?.created_at}`))
        && card.content.includes(`<@${PL}>`) && o1?.state === 'signup' && o1.card_msg_id === card.id
        && ents1.map(e => e.id).join(',') === `${P1},npc:Wolf 1,npc:Wolf 2,name:Brigand`
        && !!dbHandle.prepare("SELECT 1 FROM npcs WHERE guild_id='G1' AND name='Wolf 2' AND is_temp=1").get()
        && /Brigand\*\* is no NPC here/.test(saidOf(call)) && clk?.remind_min === 5 && clk?.skip_min === 15 && /has an initiative taking sign-ups/.test(saidOf(again)),
      `${saidOf(plainInit).slice(0, 40)} · card ${idsOf(card).join(',')} · …${(card?.content || '').slice(-50)} · ${o1?.state} · ${ents1.map(e => e.id).join(',')} · ${saidOf(call).replace(/\s+/g, ' ').slice(0, 140)} · clk ${JSON.stringify(clk)} · ${saidOf(again).slice(0, 60)}`);

    // 2 · the sign-up
    const cardMsg = { id: card?.id, content: card?.content || '', components: card?.components || [] };
    const j1 = await fJ({ isButton: true, customId: 'init:join', message: cardMsg, userId: P2 });
    const j2 = await fJ({ isButton: true, customId: 'init:join', message: cardMsg, userId: P2 });
    const l1 = await fJ({ isButton: true, customId: 'init:leave', message: cardMsg, userId: P2 });
    const j3 = await fJ({ isButton: true, customId: 'init:join', message: cardMsg, userId: P2 });
    const closePlain = await fJ({ isButton: true, customId: 'init:close', message: cardMsg, userId: PL, member: plainK });
    const npcBtn = await fJ({ isButton: true, customId: 'init:npcs', message: cardMsg, userId: 'U1' });
    const npcSub = await fJ({ isModal: true, fromMessage: true, customId: 'initnpc', selects: { pick: [keyOf('Boar')] }, fields: { more: 'Wolf' }, message: cardMsg, userId: 'U1' });
    const ents2 = JSON.parse(order()?.entrants || '[]');
    ok('Join puts a player on the card, twice is told so, Leave takes them off; Close is the GM\'s; Add NPCs opens the box, and its pick and its words join the card',
      (j1.replies[0]?.content || '').includes(N2) && /in already/.test(saidOf(j2)) && !(l1.replies[0]?.content || '').includes(N2) && (j3.replies[0]?.content || '').includes(N2)
        && /is the GM’s/.test(saidOf(closePlain)) && modalOf(npcBtn) === 'initnpc'
        && ents2.length === 7 && ents2.some(e => e.id === 'npc:Boar') && ents2.some(e => e.id === 'npc:Wolf') && /In: /.test(JSON.stringify(npcSub.replies)),
      `${(j1.replies[0]?.content || '').slice(0, 60)} · ${saidOf(j2).slice(0, 30)} · ${saidOf(closePlain).slice(0, 40)} · modal ${modalOf(npcBtn)} · ${ents2.map(e => e.id).join(',')} · ${JSON.stringify(npcSub.replies).slice(0, 160)}`);

    // 3 · Close & roll
    n0 = sent.length;
    const closed = await fJ({ isButton: true, customId: 'init:close', message: cardMsg, userId: 'U1' });
    const o2 = order();
    const list2 = JSON.parse(o2?.order_json || '[]');
    const turn1 = newIn('CJ1', n0).find(m => idsOf(m).includes(`init:done:${K()}`));
    const p1e = list2.find(e => e.id === P1);
    ok('Close & roll: everyone rolls d20 + DEX, highest first, the card becomes the order, the first turn is called with Done, Skip, Pause and End keyed to it, and the run\'s timeline has the order',
      o2?.state === 'running' && list2.length === 7 && list2.every((e, i) => i === 0 || list2[i - 1].total >= e.total) && p1e?.dex === 4 && p1e.total === p1e.roll + 4
        && /d20 \+ DEX, highest first/.test(closed.replies[0]?.content || '') && !!turn1 && K().endsWith('-1') && [`init:skip:${K()}`, `init:pause:${o2.created_at}`, `init:end:${o2.created_at}`].every(id => idsOf(turn1).includes(id))
        && /Round 1\*\* · 1 of 7/.test(turn1.content) && ev930().some(t => /^Initiative — /.test(t)),
      `${o2?.state} · ${list2.map(e => `${e.name}:${e.total}`).join(',')} · ${(closed.replies[0]?.content || '').slice(0, 60)} · ${idsOf(turn1).join(',')} · ${(turn1?.content || '').slice(0, 80)} · ${ev930().join(' | ').slice(0, 100)}`);

    // 4 · a known order of three, to walk the turns
    const known = [{ id: P1, name: N1, kind: 'player', roll: 15, dex: 4, total: 19 }, { id: 'npc:Wolf 1', name: 'Wolf 1', kind: 'npc', roll: 10, dex: 3, total: 13 }, { id: P2, name: N2, kind: 'player', roll: 9, dex: 1, total: 10 }];
    dbHandle.prepare("UPDATE turn_orders SET order_json=?, turn_index=0, round=1, turn_started_at=?, last_sign_at=NULL, reminded_at=NULL WHERE guild_id='G1' AND channel_id='CJ1'").run(JSON.stringify(known), Date.now());
    const tc = () => ({ id: lastIn('CJ1')?.id, content: lastIn('CJ1')?.content || '', components: [] });
    const k0 = K();
    const notYours = await fJ({ isButton: true, customId: `init:done:${k0}`, message: tc(), userId: PL, member: plainK });
    await fJ({ isButton: true, customId: `init:done:${k0}`, message: tc(), userId: P1 });
    const o3 = order(); const card2 = lastIn('CJ1');
    const stale = await fJ({ isButton: true, customId: `init:done:${k0}`, message: tc(), userId: P1 });
    const npcPlain = await fJ({ isButton: true, customId: `init:done:${K()}`, message: tc(), userId: PL, member: plainK });
    const otherOrder = await fJ({ isButton: true, customId: `init:skip:12345-${o3.turn_seq}`, message: tc(), userId: 'U1' });
    await fJ({ isButton: true, customId: `init:skip:${K()}`, message: tc(), userId: 'U1' });
    const o4 = order(); const card3 = lastIn('CJ1');
    ok('Done is the turn\'s own or a GM\'s: a stranger is refused, the player\'s press moves it on, "is done" atop the next card; a press on a passed turn does nothing; an NPC\'s turn is the GM\'s; the GM\'s Skip moves it on and goes on the timeline',
      /It is \*\*user100000000000000061\*\*’s turn/.test(saidOf(notYours)) && o3.turn_index === 1 && card2?.content.includes(`✅ **${N1}** is done.`) && /🎭 \*\*Wolf 1\*\* — the GM’s turn/.test(card2?.content || '')
        && /That turn has passed/.test(saidOf(stale)) && /is the GM’s — only a GM can end that turn/.test(saidOf(npcPlain)) && /That initiative is over/.test(saidOf(otherOrder))
        && o4.turn_index === 2 && /⏭️ \*\*Wolf 1\*\*’s turn is skipped by the GM\./.test(card3?.content || '') && card3?.content.includes(`<@${P2}>`) && ev930().some(t => /Wolf 1's turn skipped by the GM/.test(t)),
      `${saidOf(notYours).slice(0, 60)} · idx ${o3.turn_index} · ${(card2?.content || '').replace(/\s+/g, ' ').slice(0, 90)} · ${saidOf(stale).slice(0, 40)} · ${saidOf(npcPlain).slice(0, 50)} · idx ${o4.turn_index} · ${(card3?.content || '').replace(/\s+/g, ' ').slice(0, 90)}`);

    // 5 · the clock in an order
    dbHandle.prepare("UPDATE turn_orders SET turn_started_at=? WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 6 * 60000);
    n0 = sent.length; await clockTick();
    const kRem = K();
    const rem = newIn('CJ1', n0).find(m => idsOf(m).includes(`init:hold:${kRem}`));
    n0 = sent.length; await clockTick();
    const remAgain = newIn('CJ1', n0).length;
    const hold = await fJ({ isButton: true, customId: `init:hold:${kRem}`, message: { id: rem?.id, content: rem?.content || '', components: [] }, userId: P2 });
    const oH = order();
    dbHandle.prepare("UPDATE turn_orders SET last_sign_at=?, reminded_at=? WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 10 * 60000, Date.now());
    for (const fn of listeners.raw || []) fn({ t: 'TYPING_START', d: { guild_id: 'G1', channel_id: 'CJ1', user_id: P2 } });
    const oT = order();
    dbHandle.prepare("UPDATE turn_orders SET last_sign_at=?, reminded_at=? WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 10 * 60000, Date.now());
    for (const fn of listeners.messageCreate || []) await fn(mkJ(chJ, 'She steps forward, blade low.', P2));
    const oM = order();
    dbHandle.prepare("UPDATE turn_orders SET last_sign_at=?, reminded_at=? WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 10 * 60000, Date.now());
    for (const fn of listeners.raw || []) fn({ t: 'TYPING_START', d: { guild_id: 'G1', channel_id: 'CJ1', user_id: PL } });
    const oX = order();
    ok('five quiet minutes bring one reminder, Still writing and Done on it, pinging the player; ✍️, typing and a message each start the count again — someone else typing does not',
      !!rem && rem.content.startsWith('⏳ 5 minutes on this turn') && rem.content.includes(`<@${P2}>`) && idsOf(rem).includes(`init:done:${kRem}`) && remAgain === 0
        && /is still writing — the clock starts again/.test(hold.replies[0]?.content || '') && oH.reminded_at == null && Date.now() - oH.last_sign_at < 5000
        && oT.reminded_at == null && Date.now() - oT.last_sign_at < 5000 && oM.reminded_at == null && Date.now() - oM.last_sign_at < 5000
        && oX.reminded_at != null && Date.now() - oX.last_sign_at > 5 * 60000,
      `rem ${(rem?.content || '').slice(0, 80)} · again ${remAgain} · ${(hold.replies[0]?.content || '').slice(0, 50)} · H ${oH.reminded_at} T ${oT.reminded_at} M ${oM.reminded_at} X ${oX.reminded_at}`);

    // a fight here has the floor: the order's clock waits
    dbHandle.prepare("INSERT OR REPLACE INTO fights (guild_id, channel_id, state, turn_order, last_at) VALUES ('G1', 'CJ1', 'active', '[]', ?)").run(Date.now());
    dbHandle.prepare("UPDATE turn_orders SET turn_started_at=?, last_sign_at=NULL, reminded_at=NULL WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 16 * 60000);
    await clockTick();
    const oF = order();
    dbHandle.prepare("UPDATE fights SET state='idle' WHERE guild_id='G1' AND channel_id='CJ1'").run();
    dbHandle.prepare("UPDATE turn_orders SET turn_started_at=?, last_sign_at=NULL, reminded_at=NULL WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 16 * 60000);
    n0 = sent.length; await clockTick();
    const oP = order();
    const passCard = newIn('CJ1', n0).find(m => /turn passes/.test(m.content));
    ok('while a fight runs in the room the order\'s clock waits; fifteen quiet minutes then pass the turn, the order comes round to round 2, and the timeline keeps the passing and the round',
      oF.turn_index === 2 && Date.now() - oF.last_sign_at < 5000
        && oP.turn_index === 0 && oP.round === 2 && passCard?.content.includes(`⏳ **${N2}**’s turn passes — 15 minutes quiet.`) && /Round 2\*\* begins · 1 of 3/.test(passCard?.content || '')
        && ev930().some(t => /turn passed — 15 minutes quiet/.test(t)) && ev930().includes('Round 2'),
      `held idx ${oF.turn_index} · idx ${oP.turn_index} r${oP.round} · ${(passCard?.content || '').replace(/\s+/g, ' ').slice(0, 120)} · ${ev930().join(' | ').slice(-120)}`);

    // 6 · pause and resume
    const pz = await fJ({ isButton: true, customId: 'init:pause', message: { id: lastIn('CJ1')?.id, content: 'the card', components: [] }, userId: 'U1' });
    const oPz = order();
    dbHandle.prepare("UPDATE turn_orders SET turn_started_at=? WHERE guild_id='G1' AND channel_id='CJ1'").run(Date.now() - 60 * 60000);
    n0 = sent.length; await clockTick();
    const quietPaused = newIn('CJ1', n0).length;
    const rs = await fJ({ isButton: true, customId: 'init:resume', message: { id: nextId(), content: 'paused', components: [] }, userId: 'U1' });
    const oRs = order();
    ok('Pause holds the order — the card carries Resume and End, the clock does nothing however long — and Resume calls the turn again on a fresh clock',
      oPz.state === 'paused' && JSON.stringify(pz.replies[0]?.components || []).includes('init:resume') && quietPaused === 0
        && oRs.state === 'running' && Date.now() - oRs.turn_started_at < 5000 && /▶️ The order goes on\./.test(lastIn('CJ1')?.content || ''),
      `${oPz.state} · ${JSON.stringify(pz.replies[0]?.components || []).slice(0, 80)} · quiet ${quietPaused} · ${oRs.state} · ${(lastIn('CJ1')?.content || '').slice(0, 60)}`);

    // 7 · /session turn
    const add = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'add', who: `<@${P4}>` }, userId: 'U1' });
    const listA = JSON.parse(order().order_json);
    const rm = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'remove', who: 'Wolf 1' }, userId: 'U1' });
    const oR = order(); const listR = JSON.parse(oR.order_json);
    const show = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'show' }, userId: PL, member: plainK });
    const nextPlain = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'next' }, userId: PL, member: plainK });
    const skipPlain = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'skip' }, userId: PL, member: plainK });
    const ac = await fJ({ isAutocomplete: true, commandName: 'session', options: { _sub: 'turn', _focused: 'who', _focusedValue: '' }, userId: 'U1' });
    const acList = ac.replies.find(x => x.autocomplete)?.autocomplete || [];
    ok('/session turn: add rolls a newcomer into place by total, remove takes one out with the turn kept where it was, show is anyone\'s, next and skip are refused to a stranger, and who: offers those in the order first',
      listA.length === 4 && listA.some(e => e.id === P4 && e.total === e.roll + 2) && /joins — 🎲 \[\d+\] \+ ⚡ 2 DEX = \*\*\d+\*\*, place \d of 4\./.test(saidOf(add))
        && listR.length === 3 && !listR.some(e => e.id === 'npc:Wolf 1') && listR[oR.turn_index]?.id === P1 && /Wolf 1\*\* leaves the order/.test(saidOf(rm))
        && /d20 \+ DEX, highest first/.test(saidOf(show)) && /only they or a GM can end it/.test(saidOf(nextPlain)) && /Only GMs move the order/.test(saidOf(skipPlain))
        && /^<@\d+>$/.test(acList[0]?.value || '') && acList.some(x => /· in the order/.test(x.name)) && acList.some(x => /🎭 Boar/.test(x.name)),
      `${listA.map(e => e.name).join(',')} · ${saidOf(add).slice(0, 90)} · ${listR.map(e => e.name).join(',')}@${oR.turn_index} · ${saidOf(rm).slice(0, 50)} · ${saidOf(show).slice(0, 50)} · ${saidOf(nextPlain).slice(0, 40)} · ${saidOf(skipPlain).slice(0, 40)} · ${JSON.stringify(acList.slice(0, 3))}`);

    // 8 · the clock in a fight: auto at the weakest, the defence rolled, an NPC's swing, a skip, the last foe first
    const chF = new FakeChannel('CJ2', 0, 'j-fight', guild); channelsById.set(chF.id, chF);
    const fF = (over) => fire({ channel: chF, ...over });
    const fightRow = () => dbHandle.prepare("SELECT * FROM fights WHERE guild_id='G1' AND channel_id='CJ2'").get();
    const quietFight = (mins) => dbHandle.prepare("UPDATE fights SET last_at=?, nudged=0, clock_idle=0 WHERE guild_id='G1' AND channel_id='CJ2'").run(Date.now() - mins * 60000);
    const autoClk = await fF({ commandName: 'session', options: { _sub: 'clock', timeout: 'auto' }, userId: 'U1' });
    const showClk = await fF({ commandName: 'session', options: { _sub: 'clock' }, userId: 'U1' });
    const badClk = await fF({ commandName: 'session', options: { _sub: 'clock', remind: 10, skip: 5 }, userId: 'U1' });
    const plainClk = await fF({ commandName: 'session', options: { _sub: 'clock', remind: 3 }, userId: PL, member: plainK });
    await fF({ commandName: 'fight', options: { _sub: 'start', players: `<@${P1}>`, npcs: 'Wolf, Boar', manual: true }, userId: 'U1' });
    const fs0 = fightRow();
    quietFight(16); n0 = sent.length; await clockTick();
    const fs1 = fightRow();
    const swing = newIn('CJ2', n0).find(m => /the bot attacks for/.test(m.content));
    quietFight(16); n0 = sent.length; await clockTick();
    const fs2 = fightRow();
    const parry = newIn('CJ2', n0).find(m => /the bot defends for \*\*Wolf 🎭\*\*/.test(m.content));
    ok('a fight on timeout:auto: the quiet player\'s attack is rolled at the weakest foe standing (Wolf, 30 HP to the Boar\'s 40), the GM asked to defend; the quiet defence is then rolled for the NPC and the exchange resolves, the turn moving on',
      /in a fight the bot attacks for them/.test(saidOf(autoClk)) && /set for this channel/.test(saidOf(showClk)) && /has to be more than/.test(saidOf(badClk)) && /Only GMs set the turn clock/.test(saidOf(plainClk))
        && fs0?.state === 'active' && JSON.parse(fs0.turn_order).join(',') === `${P1},npc:Wolf,npc:Boar`
        && swing?.content.includes(`the bot attacks for **${N1}**, at **Wolf 🎭**`) && /A GM defends for \*\*Wolf\*\*/.test(swing?.content || '') && idsOf(swing).some(id => /^fndef:/.test(id))
        && fs1.phase === 'defend' && fs1.current_target === 'npc:Wolf' && JSON.parse(fs1.last_targets || '{}')[P1] === 'npc:Wolf'
        && !!parry && fs2.phase === 'attack' && fs2.turn_index === 1,
      `${saidOf(autoClk).slice(0, 60)} · ${saidOf(showClk).slice(0, 60)} · ${fs0?.turn_order} · ${(swing?.content || '').replace(/\s+/g, ' ').slice(0, 160)} · ${fs1?.phase}/${fs1?.current_target} lt ${fs1?.last_targets} · parry ${!!parry} · ${fs2?.phase}@${fs2?.turn_index}`);
    quietFight(16); n0 = sent.length; await clockTick();
    const fs3 = fightRow();
    const npcSwing = newIn('CJ2', n0).find(m => /the bot attacks for \*\*Wolf 🎭\*\*/.test(m.content));
    quietFight(16); n0 = sent.length; await clockTick();
    const fs4 = fightRow();
    const myParry = newIn('CJ2', n0).find(m => m.content.includes(`the bot defends for **${N1}**`));
    ok('the quiet NPC\'s attack goes to the player, who is pinged with the defence buttons; their own quiet defence is rolled for them and the turn moves on to the Boar',
      npcSwing?.content.includes(`at **${N1}**`) && npcSwing?.content.includes(`<@${P1}>`) && idsOf(npcSwing).includes('fdef:dex') && fs3.current_target === P1
        && !!myParry && fs4.phase === 'attack' && fs4.turn_index === 2,
      `${(npcSwing?.content || '').replace(/\s+/g, ' ').slice(0, 140)} · ${fs3?.current_target} · parry ${!!myParry} · ${fs4?.phase}@${fs4?.turn_index}`);
    await fF({ commandName: 'session', options: { _sub: 'clock', timeout: 'skip' }, userId: 'U1' });
    quietFight(16); n0 = sent.length; await clockTick();
    const fs5 = fightRow();
    const skipMsg = newIn('CJ2', n0).find(m => /turn is skipped/.test(m.content));
    // the reminder, and what holds a fight's turn
    quietFight(6); n0 = sent.length; await clockTick();
    const fRem = newIn('CJ2', n0).find(m => idsOf(m).includes('fclock:hold'));
    const holdPlain = await fF({ isButton: true, customId: 'fclock:hold', message: { id: fRem?.id, content: fRem?.content || '', components: [] }, userId: PL, member: plainK });
    const holdMine = await fF({ isButton: true, customId: 'fclock:hold', message: { id: fRem?.id, content: fRem?.content || '', components: [] }, userId: P1 });
    const fs6 = fightRow();
    dbHandle.prepare("UPDATE fights SET last_at=?, nudged=1 WHERE guild_id='G1' AND channel_id='CJ2'").run(Date.now() - 10 * 60000);
    for (const fn of listeners.raw || []) fn({ t: 'TYPING_START', d: { guild_id: 'G1', channel_id: 'CJ2', user_id: P1 } });
    const fs7 = fightRow();
    ok('on timeout:skip the quiet Boar\'s turn is skipped and it is the player\'s again; five quiet minutes remind them with ✍️ Still writing, which only they (or a GM) can press, and typing holds the turn too',
      /⏭️ 15 minutes quiet — \*\*Boar 🎭\*\*'s turn is skipped; they stay in the fight\./.test(skipMsg?.content || '') && fs5.turn_index === 0 && fs5.phase === 'attack'
        && fRem?.content.startsWith(`⏳ 5 minutes quiet — **${N1}** is up to attack. Still writing? Press ✍️ or keep typing. At 15 minutes the turn is skipped.`) && fRem.content.includes(`<@${P1}>`)
        && /only they or a GM can hold the turn/.test(saidOf(holdPlain)) && /is still writing — the clock starts again/.test(holdMine.replies[0]?.content || '') && Date.now() - fs6.last_at < 5000 && fs6.nudged === 0
        && Date.now() - fs7.last_at < 5000 && fs7.nudged === 0,
      `${(skipMsg?.content || '').slice(0, 90)} · ${fs5?.turn_index} · ${(fRem?.content || '').slice(0, 120)} · ${saidOf(holdPlain).slice(0, 60)} · ${(holdMine.replies[0]?.content || '').slice(0, 50)} · ${fs6?.nudged}/${fs7?.nudged}`);
    // the last foe struck comes first, even with a weaker one standing
    await fF({ commandName: 'session', options: { _sub: 'clock', timeout: 'auto' }, userId: 'U1' });
    const hpNow = JSON.parse(fightRow().hp_state); hpNow['npc:Boar'] = 3;
    dbHandle.prepare("UPDATE fights SET hp_state=? WHERE guild_id='G1' AND channel_id='CJ2'").run(JSON.stringify(hpNow));
    quietFight(16); n0 = sent.length; await clockTick();
    const again2 = newIn('CJ2', n0).find(m => /the bot attacks for/.test(m.content));
    // a fight ending elsewhere leaves the order's temporary NPCs be
    const endF = await fF({ commandName: 'fight', options: { _sub: 'end' }, userId: 'U1' });
    const endBtnF = (endF.replies[0]?.components || []).flatMap(r => ((r._d || r).components || []).map(b => (b._d || b).customId)).find(id => /^confirm:/.test(id || ''));
    if (endBtnF) await fF({ isButton: true, customId: endBtnF, message: { id: nextId(), content: '', components: [] }, userId: 'U1' });
    ok('the quiet player\'s next attack goes to the foe they last struck (Wolf) though the Boar stands weaker; a fight ending elsewhere leaves the initiative\'s temporary NPCs be',
      again2?.content.includes(`the bot attacks for **${N1}**, at **Wolf 🎭**`) && fightRow()?.state === 'idle'
        && !!dbHandle.prepare("SELECT 1 FROM npcs WHERE guild_id='G1' AND name='Wolf 2'").get(),
      `${(again2?.content || '').replace(/\s+/g, ' ').slice(0, 120)} · ${fightRow()?.state} · wolf2 ${!!dbHandle.prepare("SELECT 1 FROM npcs WHERE guild_id='G1' AND name='Wolf 2'").get()}`);

    // 8b · with the foes down, the clock never sets a fighter on a friend;
    // a whole round of its own moves with nobody acting and it stops
    const chD = new FakeChannel('CJ4', 0, 'j-dormant', guild); channelsById.set(chD.id, chD);
    await fire({ channel: chD, commandName: 'session', options: { _sub: 'clock', timeout: 'auto' }, userId: 'U1' });
    const fD = () => dbHandle.prepare("SELECT * FROM fights WHERE guild_id='G1' AND channel_id='CJ4'").get();
    const quietD = (mins) => dbHandle.prepare("UPDATE fights SET last_at=?, nudged=0 WHERE guild_id='G1' AND channel_id='CJ4'").run(Date.now() - mins * 60000);
    dbHandle.prepare(`INSERT OR REPLACE INTO fights (guild_id, channel_id, state, turn_order, turn_index, phase, hp_state, rr_state, floor_hp, last_at, nudged, clock_idle, last_targets)
      VALUES ('G1', 'CJ4', 'active', ?, 0, 'attack', ?, '{}', 0, ?, 0, 0, '{}')`).run(JSON.stringify([P1, P2, 'npc:Boar']), JSON.stringify({ [P1]: 20, [P2]: 5, 'npc:Boar': 0 }), Date.now() - 16 * 60000);
    n0 = sent.length; await clockTick();
    const noTeam = newIn('CJ4', n0).map(m => m.content).join(' | ');
    const fD1 = fD();
    quietD(16); n0 = sent.length; await clockTick();
    const stopMsg = newIn('CJ4', n0).map(m => m.content).join(' | ');
    const fD2 = fD();
    quietD(40); n0 = sent.length; await clockTick();
    const afterStop = newIn('CJ4', n0).length;
    const fD3 = fD();
    for (const fn of listeners.raw || []) fn({ t: 'TYPING_START', d: { guild_id: 'G1', channel_id: 'CJ4', user_id: P1 } });
    const fD4 = fD();
    // and a fight quiet six hours past its mark is left alone
    dbHandle.prepare("UPDATE fights SET last_at=?, nudged=0, clock_idle=0 WHERE guild_id='G1' AND channel_id='CJ4'").run(Date.now() - 7 * 3600000);
    n0 = sent.length; await clockTick();
    const oldQuiet = newIn('CJ4', n0).length;
    dbHandle.prepare("UPDATE fights SET state='idle' WHERE guild_id='G1' AND channel_id='CJ4'").run();
    ok('with the foes down the clock skips a quiet player rather than set them on a friend; a whole round of its own moves and it stops, saying so, until someone stirs; a fight quiet six hours past its mark is left alone',
      /turn is skipped/.test(noTeam) && !/the bot attacks/.test(noTeam) && fD1.turn_index === 1 && fD1.clock_idle === 1
        && /the turn clock stops here/.test(stopMsg) && fD2.clock_idle === 2 && fD2.turn_index === 0
        && afterStop === 0 && fD3.turn_index === 0 && fD4.clock_idle === 0 && oldQuiet === 0,
      `${noTeam.replace(/\s+/g, ' ').slice(0, 120)} · idle ${fD1.clock_idle}@${fD1.turn_index} · ${stopMsg.replace(/\s+/g, ' ').slice(-90)} · idle ${fD2.clock_idle}@${fD2.turn_index} · after ${afterStop} · ${fD3.turn_index} · ${fD4.clock_idle} · old ${oldQuiet}`);

    // 9 · back, end, the record, the clock handed back
    const oPre = order();
    const bk = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'back' }, userId: 'U1' });
    const oB = order();
    const wantB = Number(oPre.turn_index) > 0 ? { round: oPre.round, idx: oPre.turn_index - 1 } : { round: oPre.round - 1, idx: JSON.parse(oPre.order_json).length - 1 };
    const tl = await fJ({ commandName: 'quest', options: { _group: 'run', _sub: 'timeline', number: 930 }, userId: 'U1' });
    const end = await fJ({ commandName: 'session', options: { _sub: 'turn', action: 'end' }, userId: 'U1' });
    const oE = order();
    const lateDone = await fJ({ isButton: true, customId: `init:done:${K()}`, message: { id: nextId(), content: '', components: [] }, userId: P1 });
    const resetClk = await fF({ commandName: 'session', options: { _sub: 'clock', reset: true }, userId: 'U1' });
    ok('back steps a turn back across the round; the run\'s timeline shows the rounds with 🔄; end closes the order, says its rounds and puts the end on the timeline, and a press after does nothing; reset hands the channel back to the server\'s clock',
      oB.round === wantB.round && oB.turn_index === wantB.idx && /Back a turn/.test(saidOf(bk))
        && /🔄 Round 2/.test(saidOf(tl))
        && oE.state === 'ended' && saidOf(end).includes(`Initiative over after ${wantB.round} round${wantB.round === 1 ? '' : 's'}.`) && ev930().includes(`Initiative ended after ${wantB.round} round${wantB.round === 1 ? '' : 's'}`)
        && /That initiative is over/.test(saidOf(lateDone)) && /keeps the server’s turn clock again/.test(saidOf(resetClk))
        && !dbHandle.prepare("SELECT 1 FROM turn_clocks WHERE guild_id='G1' AND channel_id='CJ2'").get(),
      `r${oB.round}@${oB.turn_index} · ${saidOf(bk).slice(0, 30)} · tl ${/🔄/.test(saidOf(tl))} · ${oE.state} · ${saidOf(end).slice(0, 50)} · ${ev930().slice(-2).join(' | ')} · ${saidOf(lateDone).slice(0, 40)} · ${saidOf(resetClk).slice(0, 60)}`);

    // 10 · edges: Cancel; the turn's own entrant removed; the last one's
    // removed (the round comes round); back from the very first turn
    const chE = new FakeChannel('CJ3', 0, 'j-edges', guild); channelsById.set(chE.id, chE);
    const fE = (over) => fire({ channel: chE, ...over });
    const orderE = () => dbHandle.prepare("SELECT * FROM turn_orders WHERE guild_id='G1' AND channel_id='CJ3'").get();
    n0 = sent.length;
    await fE({ commandName: 'session', options: { _sub: 'initiative', npcs: 'Brigand' }, userId: 'U1' });
    const cardE = newIn('CJ3', n0).find(m => idsOf(m).includes('init:cancel'));
    const cancel = await fE({ isButton: true, customId: 'init:cancel', message: { id: cardE?.id, content: cardE?.content || '', components: [] }, userId: 'U1' });
    const oC = orderE();
    const three = [{ id: P1, name: N1, kind: 'player', roll: 15, dex: 4, total: 19 }, { id: P2, name: N2, kind: 'player', roll: 9, dex: 1, total: 10 }, { id: 'name:Brigand', name: 'Brigand', kind: 'name', roll: 5, dex: 0, total: 5 }];
    dbHandle.prepare("UPDATE turn_orders SET state='running', order_json=?, turn_index=1, round=1, turn_started_at=?, turn_msg_id=NULL WHERE guild_id='G1' AND channel_id='CJ3'").run(JSON.stringify(three), Date.now());
    n0 = sent.length;
    const rmCur = await fE({ commandName: 'session', options: { _sub: 'turn', action: 'remove', who: `<@${P2}>` }, userId: 'U1' });
    const oRc = orderE(); const cardRc = newIn('CJ3', n0).pop();
    n0 = sent.length;
    const rmLast = await fE({ commandName: 'session', options: { _sub: 'turn', action: 'remove', who: 'brigand' }, userId: 'U1' });
    const oRl = orderE(); const cardRl = newIn('CJ3', n0).pop();
    const backFirst = await fE({ commandName: 'session', options: { _sub: 'turn', action: 'back' }, userId: 'U1' });
    dbHandle.prepare("UPDATE turn_orders SET round=1, turn_index=0 WHERE guild_id='G1' AND channel_id='CJ3'").run();
    const backNone = await fE({ commandName: 'session', options: { _sub: 'turn', action: 'back' }, userId: 'U1' });
    const rmAll = await fE({ commandName: 'session', options: { _sub: 'turn', action: 'remove', who: `<@${P1}>` }, userId: 'U1' });
    const oAll = orderE();
    ok('edges: Cancel calls it off; removing the one whose turn it is hands the turn on at once; removing the last in line brings the round round; back from the first turn of all does nothing; removing the last one left ends it',
      /called off/.test(cancel.replies[0]?.content || '') && oC.state === 'ended'
        && oRc.turn_index === 1 && JSON.parse(oRc.order_json).length === 2 && /➖ \*\*user100000000000000062\*\* leaves the order — the turn moves on\./.test(saidOf(rmCur)) && /🎯 🎭 \*\*Brigand\*\*/.test(cardRc?.content || '') && oRc.turn_seq > 0
        && oRl.turn_index === 0 && oRl.round === 2 && /Round 2\*\* begins/.test(cardRl?.content || '') && cardRl?.content.includes(`<@${P1}>`)
        && /Back a turn/.test(saidOf(backFirst)) && /no turn before the first/.test(saidOf(backNone))
        && oAll.state === 'ended' && /nobody left, initiative is over/.test(saidOf(rmAll)),
      `${(cancel.replies[0]?.content || '').slice(0, 40)} ${oC.state} · ${oRc.turn_index} ${(cardRc?.content || '').replace(/\s+/g, ' ').slice(0, 100)} · ${oRl.turn_index}/${oRl.round} ${(cardRl?.content || '').replace(/\s+/g, ' ').slice(0, 80)} · ${saidOf(backFirst).slice(0, 30)} · ${saidOf(backNone).slice(0, 40)} · ${oAll.state} ${saidOf(rmAll).slice(0, 60)}`);

    dbHandle.prepare("UPDATE quests SET status='completed' WHERE guild_id='G1' AND number=930").run();
    guild.members.fetch = realFetchK;
    const threwK = loggedK.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrK;
    ok('nothing in the J walk threw', threwK.length === 0, threwK.slice(0, 3).join('\n        '));
  }

  // ── Build K (2026-11-08): a player's own advantage waits on a GM; an
  // auto fight shows both dice and a Hero reaches for their signature ────
  if (dbHandle) {
    const realErrKK = console.error; const loggedKK = [];
    console.error = (...a) => { loggedKK.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => r.replies.map(x => x.content || '').join(' ');
    const allOf = (r) => r.replies.map(x => JSON.stringify(x)).join(' ');
    const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
    const tickAll = async () => { for (const t of ticks.filter(t => /turnClockTick/.test(String(t.fn)))) { try { await t.fn(); } catch (e) { loggedKK.push(`tick: ${e.message}`); } } };
    const newIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const textOf = (msgs) => msgs.map(m => `${m.content} ${JSON.stringify(m.components || [])}`).join('\n');
    const KA = '100000000000000071', KB = '100000000000000072';
    const plainOf = (id) => ({ id, displayName: `user${id}`, roles: { cache: new Map() }, permissions: { has: () => false } });
    const realFetchKK = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchKK(uid); if (uid === KA || uid === KB) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    for (const id of [KA, KB]) dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, rerolls_current) VALUES ('G1', ?, 4, 3, 3, 2, 2, 30, 2)").run(id);
    const chK = new FakeChannel('CK1', 0, 'k-walk', guild); channelsById.set(chK.id, chK);
    const fK = (over) => fire({ channel: chK, ...over });
    const asK = (uid) => (uid === KA || uid === KB ? { member: plainOf(uid) } : {});
    const press = (id, uid, ch = chK, msg = null) => fire({ channel: ch, isButton: true, customId: id, message: msg || { id: nextId(), content: 'x', components: [] }, userId: uid, ...asK(uid) });
    const holdOf = (uid, cid = 'CK1', gid = 'G1') => dbHandle.prepare('SELECT * FROM mode_holds WHERE guild_id=? AND channel_id=? AND user_id=? ORDER BY id DESC LIMIT 1').get(gid, cid, uid);
    const nHolds = () => dbHandle.prepare('SELECT COUNT(*) n FROM mode_holds').get().n;

    // 1 · /roll: held; one at a time; only a GM answers; allowed, the player's own Roll rolls it with advantage
    let n0 = sent.length;
    const askR = await fK({ commandName: 'roll', options: { stat: 'str', mode: 'adv' }, userId: KA, ...asK(KA) });
    const hR = holdOf(KA);
    const cardR = newIn('CK1', n0).find(m => idsOf(m).includes(`advok:${hR?.id}`));
    const again = await fK({ commandName: 'roll', options: { stat: 'dex', mode: 'dis' }, userId: KA, ...asK(KA) });
    const selfOk = await press(`advok:${hR?.id}`, KA, chK, cardR);
    n0 = sent.length;
    const gmOk = await press(`advok:${hR?.id}`, 'U1', chK, cardR);
    const goR = newIn('CK1', n0).find(m => idsOf(m).includes(`advgo:${hR?.id}`));
    const goRText = goR?.content || '';   // as posted: the press edits it
    const hR2 = holdOf(KA);
    const notMine = await press(`advgo:${hR?.id}`, KB, chK, goR);
    n0 = sent.length;
    const goPress = await press(`advgo:${hR?.id}`, KA, chK, goR);
    await settle();
    const hR3 = holdOf(KA);
    const twice = await press(`advgo:${hR?.id}`, KA, chK, goR);
    ok('/roll mode:adv from a player waits: a quiet word to them, a card with Allow and Deny; one at a time; only a GM answers; allowed, the player is pinged with 🎲 Roll, theirs alone, and it rolls with advantage, once',
      /needs a GM's yes/.test(saidOf(askR)) && !!askR.replies[0]?.ephemeral && hR?.state === 'pending' && hR?.via === 'slash'
        && /asks to roll with \*\*advantage\*\*/.test(cardR?.content || '') && (cardR?.content || '').includes('/roll stat:str mode:adv') && idsOf(cardR).includes(`advno:${hR?.id}`)
        && /already have a roll waiting/.test(saidOf(again)) && /Only a GM can answer/.test(saidOf(selfOk))
        && /Advantage allowed\*\* for/.test(saidOf(gmOk)) && hR2?.state === 'allowed' && goRText.includes(`<@${KA}>`) && /press 🎲 Roll within 10 minutes/.test(goRText)
        && /That roll is <@/.test(saidOf(notMine))
        && /\(advantage\)/.test(allOf(goPress) + textOf(newIn('CK1', n0))) && hR3?.state === 'used' && /Rolled with \*\*advantage\*\*/.test(goR?.content || '')
        && /already rolled|is rolled/.test(saidOf(twice)),
      `${saidOf(askR).slice(0, 60)} · ${hR?.state} · ${(cardR?.content || '').replace(/\s+/g, ' ').slice(0, 120)} · ${saidOf(again).slice(0, 40)} · ${saidOf(selfOk).slice(0, 40)} · ${saidOf(gmOk).slice(0, 60)} · ${hR2?.state} · ${(goR?.content || '').slice(0, 60)} · ${saidOf(notMine).slice(0, 40)} · ${allOf(goPress).slice(0, 160)} · ${hR3?.state} · ${saidOf(twice).slice(0, 40)}`);

    // 2 · a fight: a held attack names its stat; the clock waits; denied, it rolls plain at once with no form
    const chK2 = new FakeChannel('CK2', 0, 'k-fight', guild); channelsById.set(chK2.id, chK2);
    const fK2 = (over) => fire({ channel: chK2, ...over });
    const fightK = () => dbHandle.prepare("SELECT * FROM fights WHERE guild_id='G1' AND channel_id='CK2'").get();
    await fK2({ commandName: 'fight', options: { _sub: 'start', players: `<@${KA}> <@${KB}>`, manual: true }, userId: 'U1' });
    dbHandle.prepare("UPDATE fights SET turn_order=?, turn_index=0, phase='attack', current_target=NULL, atk_roll=NULL, def_roll=NULL WHERE guild_id='G1' AND channel_id='CK2'").run(JSON.stringify([KA, KB]));
    const noStat = await fK2({ commandName: 'fight', options: { _sub: 'atk', roll: 'adv' }, userId: KA, ...asK(KA) });
    const hNone = holdOf(KA, 'CK2');
    n0 = sent.length;
    const askA = await fK2({ commandName: 'fight', options: { _sub: 'atk', stat: 'str', target: KB, roll: 'adv' }, userId: KA, ...asK(KA) });
    const hA = holdOf(KA, 'CK2');
    const cardA = newIn('CK2', n0).find(m => idsOf(m).includes(`advno:${hA?.id}`));
    const fA0 = fightK();
    dbHandle.prepare("UPDATE fights SET last_at=?, nudged=0, clock_idle=0 WHERE guild_id='G1' AND channel_id='CK2'").run(Date.now() - 16 * 60000);
    n0 = sent.length; await tickAll();
    const fA1 = fightK();
    const clockSaid = textOf(newIn('CK2', n0));
    n0 = sent.length;
    const gmNo = await press(`advno:${hA?.id}`, 'U1', chK2, cardA);
    await settle();
    const fA2 = fightK();
    const plainOut = textOf(newIn('CK2', n0));
    const hA2 = holdOf(KA, 'CK2');
    ok('a fight: a held attack must name its stat; held, the fight stands and the turn clock waits on it; denied, it rolls plain at once — the player told, no form — and the defence is called',
      /Name the stat/.test(saidOf(noStat)) && !hNone
        && /needs a GM's yes/.test(saidOf(askA)) && hA?.state === 'pending' && !!cardA && (cardA?.content || '').includes(`/fight atk stat:str target:<@${KB}> roll:adv`) && fA0.phase === 'attack'
        && fA1.turn_index === 0 && fA1.phase === 'attack' && Number(fA1.last_at) > Date.now() - 60000 && !/quiet/.test(clockSaid)
        && /Advantage denied\*\* for/.test(saidOf(gmNo)) && hA2?.state === 'denied'
        && plainOut.includes(`<@${KA}> ❌ A GM said no to **advantage**`) && fA2.phase === 'defend' && fA2.current_target === KB
        && !/\(advantage\)/.test(plainOut) && !gmNo.replies.some(x => x.modal),
      `${saidOf(noStat).slice(0, 50)} · ${hNone?.id} · ${saidOf(askA).slice(0, 40)} · ${hA?.state} · ${(cardA?.content || '').replace(/\s+/g, ' ').slice(0, 120)} · ${fA0?.phase} · ${fA1?.turn_index}/${fA1?.phase} ${Date.now() - Number(fA1?.last_at)}ms · ${clockSaid.slice(0, 80)} · ${saidOf(gmNo).slice(0, 60)} · ${hA2?.state} · ${plainOut.replace(/\s+/g, ' ').slice(0, 240)} · ${fA2?.phase}/${fA2?.current_target}`);

    // 3 · allowed: the Roll opens the defence form, a dismissed one opens again, and its submit rolls with advantage and spends the hold
    n0 = sent.length;
    const askD = await fK2({ commandName: 'fight', options: { _sub: 'def', stat: 'dex', roll: 'adv' }, userId: KB, ...asK(KB) });
    const hD = holdOf(KB, 'CK2');
    const cardD = newIn('CK2', n0).find(m => idsOf(m).includes(`advok:${hD?.id}`));
    n0 = sent.length;
    await press(`advok:${hD?.id}`, 'U1', chK2, cardD);
    const goD = newIn('CK2', n0).find(m => idsOf(m).includes(`advgo:${hD?.id}`));
    const goD1 = await press(`advgo:${hD?.id}`, KB, chK2, goD);
    const hD1 = holdOf(KB, 'CK2');
    const form1 = goD1.replies.find(x => x.modal)?.modal;
    const goD2 = await press(`advgo:${hD?.id}`, KB, chK2, goD);
    const form2 = goD2.replies.find(x => x.modal)?.modal;
    const subD = await fK2({ isModal: true, customId: form2 || 'frp:none', fields: { action: 'braces', speech: '' }, userId: KB, ...asK(KB) });
    await settle();
    const hD2 = holdOf(KB, 'CK2');
    const fD = fightK();
    ok('allowed in a fight: the Roll opens the defence form (dismissed, it opens again); the submit rolls the defence with advantage, spends the hold and takes the button away',
      !!askD.replies[0]?.ephemeral && hD?.state === 'pending' && !!goD && hD1?.state === 'allowed' && /^frp:/.test(form1 || '') && /^frp:/.test(form2 || '')
        && /\(advantage\)/.test(allOf(subD)) && hD2?.state === 'used' && fD.def_roll != null && /Rolled with \*\*advantage\*\*/.test(goD?.content || '') && (goD?.components || []).length === 0,
      `${hD?.state} · ${!!goD} · ${hD1?.state} · ${form1} · ${form2} · ${allOf(subD).slice(0, 200)} · ${hD2?.state} · ${fD?.def_roll} · ${(goD?.content || '').slice(0, 60)}`);
    await fK2({ commandName: 'fight', options: { _sub: 'end' }, userId: 'U1' });

    // 4 · typed: the card answers the message; denied, the plain roll answers it too
    const mkK = (ch, text, uid) => ({ id: nextId(), content: text, author: { id: uid, bot: false, username: `user${uid}` }, guild, channel: ch, channelId: ch.id,
      member: plainOf(uid), attachments: { size: 0, first: () => null }, client,
      reply: async (p) => { replies.push(norm(p)); return { id: nextId() }; } });
    const msgT = mkK(chK, 'stra heave', KB);
    n0 = sent.length; replies.length = 0;
    for (const fn of listeners.messageCreate || []) await fn(msgT);
    await settle();
    const hT = holdOf(KB);
    const cardT = newIn('CK1', n0).find(m => idsOf(m).includes(`advno:${hT?.id}`));
    n0 = sent.length;
    const gmNoT = await press(`advno:${hT?.id}`, 'U1', chK, cardT);
    await settle();
    const plainT = newIn('CK1', n0);
    const hT2 = holdOf(KB);
    ok('typed stra waits too: the card answers the message; denied, the plain roll answers the same message',
      hT?.via === 'typed' && cardT?.replyTo === msgT.id && /stra heave/.test(cardT?.content || '')
        && /Advantage denied/.test(saidOf(gmNoT)) && hT2?.state === 'denied' && plainT.some(m => m.replyTo === msgT.id) && !/\(advantage\)/.test(textOf(plainT)),
      `${hT?.via} · ${cardT?.replyTo === msgT.id} · ${(cardT?.content || '').replace(/\s+/g, ' ').slice(0, 100)} · ${hT2?.state} · ${plainT.map(m => `${m.replyTo === msgT.id}:${m.content.slice(0, 40)}`).join(' | ')}`);

    // 5 · nobody answers: five minutes on, the card closes and the player is told
    n0 = sent.length;
    await fK({ commandName: 'roll', options: { dice: '1d20', mode: 'dis' }, userId: KA, ...asK(KA) });
    const hL = holdOf(KA);
    dbHandle.prepare('UPDATE mode_holds SET created_at=? WHERE id=?').run(Date.now() - 6 * 60000, hL?.id);
    await tickAll();
    const hL2 = holdOf(KA);
    const told = textOf(newIn('CK1', n0));
    ok('unanswered for five minutes: the card closes and the player is told they cannot roll with advantage or disadvantage without a GM\'s approval',
      hL?.state === 'pending' && hL?.mode === 'dis' && hL2?.state === 'lapsed'
        && told.includes(`<@${KA}> ⌛ No GM answered in 5 minutes. You can't roll with advantage or disadvantage without a GM's approval`)
        && /No GM answered\*\* — no disadvantage/.test(told),
      `${hL?.state}/${hL?.mode} · ${hL2?.state} · ${told.replace(/\s+/g, ' ').slice(0, 260)}`);

    // 6 · allowed and never pressed: ten minutes on, the button goes
    await fK({ commandName: 'roll', options: { dice: '1d20', mode: 'adv' }, userId: KB, ...asK(KB) });
    const hE = holdOf(KB);
    n0 = sent.length;
    await press(`advok:${hE?.id}`, 'U1');
    const goE = newIn('CK1', n0).find(m => idsOf(m).includes(`advgo:${hE?.id}`));
    dbHandle.prepare('UPDATE mode_holds SET decided_at=? WHERE id=?').run(Date.now() - 11 * 60000, hE?.id);
    await tickAll();
    const hE2 = holdOf(KB);
    const lateGo = await press(`advgo:${hE?.id}`, KB, chK, goE);
    ok('allowed and never pressed: ten minutes on, the Roll button goes, and a late press is told so',
      hE?.state === 'pending' && !!goE && hE2?.state === 'expired' && /went unused/.test(goE?.content || '') && /run out/.test(saidOf(lateGo)),
      `${hE?.state} · ${!!goE} · ${hE2?.state} · ${(goE?.content || '').slice(0, 60)} · ${saidOf(lateGo).slice(0, 60)}`);

    // 7 · a GM is never held; the switch lets players pick freely
    const nH0 = nHolds();
    const gmRoll = await fK({ commandName: 'roll', options: { dice: '1d20', mode: 'adv' }, userId: 'U1' });
    const offCfg = await fK({ commandName: 'config', options: { _group: 'mechanics', _sub: 'advapproval', enabled: false }, userId: 'U1' });
    const showCfg = await fK({ commandName: 'config', options: { _group: 'mechanics', _sub: 'advapproval' }, userId: 'U1' });
    const freeRoll = await fK({ commandName: 'roll', options: { dice: '1d20', mode: 'adv' }, userId: KA, ...asK(KA) });
    const onCfg = await fK({ commandName: 'config', options: { _group: 'mechanics', _sub: 'advapproval', enabled: true }, userId: 'U1' });
    const plainCfg = await fK({ commandName: 'config', options: { _group: 'mechanics', _sub: 'advapproval', enabled: false }, userId: KA, ...asK(KA) });
    ok('a GM\'s own advantage never waits; /config mechanics advapproval enabled:false lets players pick freely, shows itself, and switches back on; a player cannot switch it',
      /\(advantage\)/.test(allOf(gmRoll)) && /freely/.test(saidOf(offCfg)) && /freely/.test(saidOf(showCfg)) && /\(advantage\)/.test(allOf(freeRoll))
        && /waits on a GM/.test(saidOf(onCfg)) && nHolds() === nH0 && !/freely/.test(saidOf(plainCfg)) && dbHandle.prepare("SELECT adv_approval FROM guild_config WHERE guild_id='G1'").get()?.adv_approval === 1,
      `${allOf(gmRoll).slice(0, 80)} · ${saidOf(offCfg).slice(0, 60)} · ${saidOf(showCfg).slice(0, 60)} · ${allOf(freeRoll).slice(0, 80)} · ${saidOf(onCfg).slice(0, 60)} · ${nHolds()}/${nH0} · ${saidOf(plainCfg).slice(0, 60)}`);

    // 8 · 5e: inspiration puts 🔼 on the next roll itself; a skill check asked with advantage waits
    const g5 = lastClient?.guilds?.cache?.get('G5'), c5 = channelsById.get('C5');
    if (g5 && c5) {
      const F51 = '100000000000000051';
      const realFetch5 = g5.members.fetch;
      g5.members.fetch = async (uid) => { const mb = await realFetch5(uid); if (uid === F51) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
      const f5 = (over) => fire({ guild: g5, channel: c5, ...over });
      const grant = await f5({ commandName: 'dnd', options: { _sub: 'inspiration', grant: true, user: F51 }, userId: 'U1' });
      const spend = await f5({ commandName: 'dnd', options: { _sub: 'inspiration', use: true }, userId: F51, member: plainOf(F51) });
      const mk = dbHandle.prepare("SELECT next_mark, inspiration FROM characters WHERE guild_id='G5' AND user_id=?").get(F51);
      const save = await f5({ commandName: 'roll', options: { save: 'dex' }, userId: F51, member: plainOf(F51) });
      const mk2 = dbHandle.prepare("SELECT next_mark FROM characters WHERE guild_id='G5' AND user_id=?").get(F51);
      const askS = await f5({ commandName: 'roll', options: { skill: 'stealth', mode: 'adv' }, userId: F51, member: plainOf(F51) });
      const hS = holdOf(F51, 'C5', 'G5');
      g5.members.fetch = realFetch5;
      ok('5e: spending inspiration puts 🔼 on the next roll itself, so the save rolls with advantage unasked; a skill check asked with advantage waits on a GM',
        /granted/.test(saidOf(grant)) && /🔼 advantage on their next roll/.test(saidOf(spend)) && mk?.next_mark === 'adv' && Number(mk?.inspiration) === 0
          && /\(advantage\)/.test(allOf(save)) && mk2?.next_mark == null
          && hS?.state === 'pending' && /needs a GM's yes/.test(saidOf(askS)) && (hS ? JSON.parse(hS.payload).str?.skill === 'stealth' : false),
        `${saidOf(grant).slice(0, 40)} · ${saidOf(spend).slice(0, 60)} · ${mk?.next_mark}/${mk?.inspiration} · ${allOf(save).slice(0, 100)} · ${mk2?.next_mark} · ${hS?.state} · ${saidOf(askS).slice(0, 40)}`);
    } else ok('5e: the I walk left a 5e server to use', false, 'no G5');

    // 9 · an auto fight between Heroes: WIS swings for the WIS Hero, and every signature roll shows both dice
    const KH1 = '100000000000000073', KH2 = '100000000000000074';
    dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, is_hero, signature_stat) VALUES ('G1', ?, 5, 5, 4, 5, 1, 6, 1, 'wis')").run(KH1);
    dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, is_hero, signature_stat) VALUES ('G1', ?, 5, 5, 4, 4, 2, 6, 1, 'str')").run(KH2);
    const chK3 = new FakeChannel('CK3', 0, 'k-auto', guild); channelsById.set(chK3.id, chK3);
    const realTOK = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    n0 = sent.length;
    await fire({ channel: chK3, commandName: 'fight', options: { _sub: 'auto', mode: 'full', players: `<@${KH1}> <@${KH2}>` }, userId: 'U1' });
    for (let i = 0; i < 8; i++) await settle();
    globalThis.setTimeout = realTOK;
    const autoText = textOf(newIn('CK3', n0));
    const sigLines = autoText.split('\n').filter(l => /signature advantage/.test(l));
    ok('an auto fight between Heroes: the WIS Hero swings and parries with WIS, the STR Hero with STR, and every signature roll shows the kept die and the dropped one',
      new RegExp(`user${KH1} attacks [^\\n]* with WIS`).test(autoText) && new RegExp(`user${KH2} attacks [^\\n]* with STR`).test(autoText)
        && sigLines.length >= 2 && sigLines.every(l => /\(signature advantage\) → \[\d+, ~~\d+~~\]/.test(l)),
      `${sigLines.length} · ${sigLines.slice(0, 2).join(' | ').slice(0, 200)} · ${autoText.replace(/\s+/g, ' ').slice(0, 300)}`);

    guild.members.fetch = realFetchKK;
    const threwKK = loggedKK.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrKK;
    ok('nothing in the K walk threw', threwKK.length === 0, threwKK.slice(0, 3).join('\n        '));
  }

  // ── Build L (2026-11-09): the naturals on grapple, hold, feint, deflect and
  // disarm; a kept hold's answer; the price of a trick; a stray NPC sheet ──
  if (dbHandle) {
    const realErrL = console.error; const loggedL = [];
    console.error = (...a) => { loggedL.push(a.map(x => (x && x.stack) ? x.stack.split('\n').slice(0, 2).join(' | ') : String(x)).join(' ')); };
    const idsOf = (m) => (m?.components || []).flatMap(row => ((row._d || row).components || []).map(b => (b._d || b).customId || ''));
    const saidOf = (r) => (r?.replies || []).map(x => x.content || '').join('\n');
    const allOf = (r) => (r?.replies || []).map(x => JSON.stringify(x)).join(' ');
    const modalOf = (r) => (r?.replies || []).find(x => x.modal)?.modal || null;
    const flat1 = (t) => String(t || '').replace(/\s+/g, ' ');
    const settle = async () => { for (let i = 0; i < 60; i++) await new Promise(r => setImmediate(r)); };
    const tickAll = async () => { for (const t of ticks.filter(t => /turnClockTick/.test(String(t.fn)))) { try { await t.fn(); } catch (e) { loggedL.push(`tick: ${e.message}`); } } };
    const newIn = (cid, n) => sent.slice(n).filter(x => x.channel === cid).map(x => x.msg);
    const textOf = (msgs) => msgs.map(m => `${m.content} ${JSON.stringify(m.components || [])}`).join('\n');
    // Dice in order — (n - 0.5) / 20 sits mid-slot for a d20 — then a middling 11.
    const realRandL = Math.random;
    const withDice = async (nats, fn) => {
      const q = nats.map(n => (n - 0.5) / 20);
      Math.random = () => (q.length ? q.shift() : 0.525);
      try { const r = await fn(); await settle(); return r; } finally { Math.random = realRandL; }
    };
    const LA = '100000000000000081', LB = '100000000000000082', LW = '100000000000000083';
    const plainOf = (id) => ({ id, displayName: `user${id}`, roles: { cache: new Map() }, permissions: { has: () => false } });
    const realFetchL = guild.members.fetch;
    guild.members.fetch = async (uid) => { const mb = await realFetchL(uid); if ([LA, LB, LW].includes(uid)) { mb.permissions = { has: () => false }; mb.roles = { cache: new Map() }; } return mb; };
    const asL = (uid) => ([LA, LB, LW].includes(uid) ? { member: plainOf(uid) } : {});
    const putChar = (id, str, dex, wis, w1 = null, w2 = null) => dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current, weapon1, weapon2) VALUES ('G1', ?, ?, 5, ?, ?, 1, 30, ?, ?)").run(id, str, dex, wis, w1, w2);
    putChar(LA, 5, 4, 5, 'Longsword', 'Kite shield');
    putChar(LB, 4, 4, 8);
    putChar(LW, 2, 2, 2);
    const putNpc = (name, str, dex, wis, hp = 30) => dbHandle.prepare("INSERT OR REPLACE INTO npcs (guild_id, name, str, con, dex, wis, lck, hp_current) VALUES ('G1', ?, ?, 3, ?, ?, 1, ?)").run(name, str, dex, wis, hp);
    putNpc('Lhound', 10, 2, 1); putNpc('Lcrow', 1, 1, 1); putNpc('Lbrute', 3, 2, 1);
    const chL = new FakeChannel('CL1', 0, 'l-walk', guild); channelsById.set(chL.id, chL);
    const fL1 = (over) => fire({ channel: chL, ...over });
    const fightL = (cid = 'CL1') => dbHandle.prepare("SELECT * FROM fights WHERE guild_id='G1' AND channel_id=?").get(cid);
    const setL = (o, cid = 'CL1') => { const ks = Object.keys(o); dbHandle.prepare(`UPDATE fights SET ${ks.map(k => `${k}=?`).join(', ')} WHERE guild_id='G1' AND channel_id=?`).run(...ks.map(k => (o[k] !== null && typeof o[k] === 'object') ? JSON.stringify(o[k]) : o[k]), cid); };
    const hpOf = (id, cid = 'CL1') => JSON.parse(fightL(cid)?.hp_state || '{}')[id];
    const fxOf = (id, cid = 'CL1') => JSON.parse(fightL(cid)?.effect_state || '{}')[id] || {};
    const heldBy = (id, cid = 'CL1') => JSON.parse(fightL(cid)?.grapples || '{}')[id] || null;
    const FRESH = { phase: 'attack', current_target: null, atk_kind: null, atk_roll: null, atk_nat: null, def_roll: null, def_nat: null, effect_state: {}, grapples: {} };
    const act = (uid, o, ch = chL) => fire({ channel: ch, commandName: 'fight', options: { _sub: 'act', ...o }, userId: uid, ...asL(uid) });
    const press = (id, uid, ch = chL) => fire({ channel: ch, isButton: true, customId: id, message: { id: nextId(), content: 'x', components: [] }, userId: uid, ...asL(uid) });
    const submit = (modal, uid, ch = chL, fields = { action: '', speech: '' }) => fire({ channel: ch, isModal: true, customId: modal || 'frp:none', fields, userId: uid, ...asL(uid) });
    const quietL = (mins) => dbHandle.prepare("UPDATE fights SET last_at=?, nudged=0, clock_idle=0 WHERE guild_id='G1' AND channel_id='CL1'").run(Date.now() - mins * 60000);
    await fL1({ commandName: 'fight', options: { _sub: 'start', players: `<@${LA}> <@${LB}> <@${LW}>`, manual: true }, userId: 'U1' });

    // 1 · a grip needs STR 4+: refused before anything is spent
    setL({ ...FRESH, turn_order: [LW, LA, LB], turn_index: 0, effect_state: { [LW]: { fooled: true } } });
    const weak = await act(LW, { action: 'grapple', target: LA, flavour: 'grab' });
    ok('a grapple needs STR 4+ on Knightfall: refused, the fight unmoved, nothing spent',
      /Grappling needs \*\*STR 4\+\*\*/.test(saidOf(weak)) && fightL().phase === 'attack' && fxOf(LW).fooled === true,
      `${flat1(saidOf(weak)).slice(0, 80)} · ${fightL().phase} · ${JSON.stringify(fxOf(LW))}`);

    // 2 · the grab's naturals
    const grabSave = async (gNat, sNat) => {
      setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0 });
      await withDice([gNat], () => act(LA, { action: 'grapple', target: LB, flavour: 'grab' }));
      return withDice([sNat], () => act(LB, { action: 'save' }));
    };
    const hpB0 = hpOf(LB);
    const g1 = await grabSave(1, 2);
    const held1 = heldBy(LB), hpB1 = hpOf(LB), ti1 = fightL().turn_index;
    const g20 = await grabSave(20, 20);
    const held20 = heldBy(LB), hpB20 = hpOf(LB);
    const gS = await grabSave(12, 20);
    const heldS = heldBy(LB);
    ok('a grab of 1 fails outright; twenty meets twenty and the grab wins, for 2 wounds; a save of 20 twists free of an ordinary grab',
      /fumbles the grab — a natural 1, it fails outright/.test(saidOf(g1)) && !held1 && hpB1 === hpB0 && ti1 === 1
        && /Twenty meets twenty!\*\* The grab wins/.test(saidOf(g20)) && /seizes \*\*user\d+\*\* for \*\*2\*\* wounds/.test(saidOf(g20)) && held20 === LA && hpB20 === hpB0 - 2
        && /A natural 20 — \*\*user\d+\*\* twists free/.test(saidOf(gS)) && !heldS,
      `${flat1(saidOf(g1)).slice(0, 160)} · ${held1} ${hpB1}/${hpB0} @${ti1} · ${flat1(saidOf(g20)).slice(0, 200)} · ${held20} ${hpB20} · ${flat1(saidOf(gS)).slice(0, 140)} · ${heldS}`);

    // 3 · a kept hold: the grappler rolls; the captive answers by button; a
    // failed break pays the round's wound at once, a second costs 1 more, and
    // the turn's end then costs nothing
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const hp3 = hpOf(LB);
    const mP = await press('fact:maintain', LA);
    const mS = await withDice([10], () => submit(modalOf(mP), LA));
    const f3a = fightL();
    const mCard = mS.replies.find(x => /Break free/.test(x.content || ''));
    const bP = await press('fbreak', LB);
    const bWrong = await press('fbreak', LW);
    const bS = await withDice([3], () => submit(modalOf(bP), LB));
    const hp3a = hpOf(LB), fx3a = fxOf(LB), f3b = fightL();
    const esc = await withDice([12, 4], () => act(LB, { action: 'escape' }));
    const hp3b = hpOf(LB), fx3b = fxOf(LB), f3c = fightL();
    ok('a kept hold: the grappler rolls STR and the captive is pinged with Break free and Stay; a failed break pays the round’s wound at once, a second that round 1 more, and the turn’s end nothing',
      !!modalOf(mP) && f3a.phase === 'defend' && f3a.atk_kind === 'hold' && f3a.current_target === LB && f3a.atk_roll === 15
        && idsOf(mCard).includes('fbreak') && idsOf(mCard).includes('fstay') && (mCard?.content || '').includes(`<@${LB}>`)
        && !!modalOf(bP) && /the answer is theirs/.test(saidOf(bWrong))
        && /this round's wound now — \*\*1\*\*/.test(saidOf(bS)) && hp3a === hp3 - 1 && fx3a.holdPaid === true && f3b.turn_index === 1 && f3b.phase === 'attack'
        && /Another failed struggle this round — \*\*1\*\* more wound/.test(saidOf(esc)) && /this round's wound is already paid/.test(saidOf(esc))
        && hp3b === hp3 - 2 && !fx3b.holdPaid && f3c.turn_index === 0 && heldBy(LB) === LA,
      `${!!modalOf(mP)} · ${f3a.phase}/${f3a.atk_kind}/${f3a.current_target === LB}/${f3a.atk_roll} · ${idsOf(mCard).join(',')} · ${flat1(saidOf(bWrong)).slice(0, 60)} · ${flat1(saidOf(bS)).slice(0, 240)} · ${hp3a}/${hp3} ${JSON.stringify(fx3a)} @${f3b.turn_index} · ${flat1(saidOf(esc)).slice(0, 300)} · ${hp3b} ${JSON.stringify(fx3b)} @${f3c.turn_index}`);

    // 4 · a round with no attempt costs its wound at the turn's end, a GM's
    // skip included; breaking out first costs nothing
    setL({ turn_index: 1, phase: 'attack', current_target: null, atk_kind: null });
    const hp4 = hpOf(LB);
    const sk = await fL1({ commandName: 'gm', options: { _group: 'override', _sub: 'skip' }, userId: 'U1' });
    const hp4a = hpOf(LB), f4 = fightL();
    setL({ turn_index: 1 });
    const out4 = await withDice([3, 15], () => act(LB, { action: 'escape' }));
    const hp4b = hpOf(LB);
    ok('a held fighter’s turn that passes with no attempt still costs its wound — a GM’s skip included, its lines posted; breaking out first costs nothing',
      /skipped by the GM/.test(saidOf(sk)) && /still held by \*\*user\d+\*\* — \*\*1\*\* wound/.test(saidOf(sk)) && hp4a === hp4 - 1 && f4.turn_index === 0
        && /breaks free of/.test(saidOf(out4)) && !heldBy(LB) && hp4b === hp4a && !/wound/.test(saidOf(out4)),
      `${flat1(saidOf(sk)).slice(0, 220)} · ${hp4a}/${hp4} @${f4.turn_index} · ${flat1(saidOf(out4)).slice(0, 200)} · ${heldBy(LB)} ${hp4b}`);

    // 5 · a hold of 20: staying keeps the flat for their next roll, and the
    // escape that follows rolls it
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const m5P = await press('fact:maintain', LA);
    const m5S = await withDice([20], () => submit(modalOf(m5P), LA));
    const sP = await press('fstay', LB);
    const sS = await submit(modalOf(sP), LB);
    const fx5 = fxOf(LB), f5 = fightL();
    const e5 = await withDice([5, 9], () => act(LB, { action: 'escape' }));
    const fx5b = fxOf(LB);
    ok('a hold of 20: the captive who stays keeps a flat next roll, and the escape on their turn is a flat d20; the hold keeps and the turn passes on Stay',
      /A natural 20 — if \*\*user\d+\*\* struggles, it is on a flat d20/.test(saidOf(m5S)) && !!modalOf(sP)
        && /stays in the hold — it keeps, and this round's wound lands at the end of their turn/.test(saidOf(sS)) && /natural 20 stays with them/.test(saidOf(sS))
        && fx5.fooled === true && f5.turn_index === 1 && f5.phase === 'attack' && heldBy(LB) === LA
        && /escape, flat d20\): \*\*9\*\*/.test(saidOf(e5)) && !fx5b.fooled,
      `${flat1(saidOf(m5S)).slice(0, 160)} · ${flat1(saidOf(sS)).slice(0, 200)} · ${JSON.stringify(fx5)} @${f5.turn_index}/${f5.phase} · ${flat1(saidOf(e5)).slice(0, 220)} · ${JSON.stringify(fx5b)}`);

    // 6 · an escape's naturals
    const escWith = async (dice) => { setL({ ...FRESH, turn_order: [LA, LB], turn_index: 1, grapples: { [LB]: LA } }); return withDice(dice, () => act(LB, { action: 'escape' })); };
    const eH20 = await escWith([20, 18]);
    const heldH20 = heldBy(LB);
    const eB20 = await escWith([10, 20]);
    const fxA20 = fxOf(LA), heldB20 = heldBy(LB);
    const hp6 = hpOf(LB);
    const eB1 = await escWith([10, 1]);
    const hp6a = hpOf(LB);
    const eTie = await escWith([5, 6]);   // 10 against 10
    const heldTie = heldBy(LB), hp6b = hpOf(LB);
    const eH1 = await escWith([1, 2]);
    const fxA1 = fxOf(LA), heldH1 = heldBy(LB), f6 = fightL();
    ok('an escape: a hold of 20 makes it a flat d20; a break of 20 frees them whatever the totals and leaves the grappler’s next attack flat; a break of 1 costs 2 wounds; a tie keeps the hold; a hold of 1 slips at once',
      /The hold's natural 20 — \*\*user\d+\*\* struggles on a flat d20/.test(saidOf(eH20)) && /escape, flat d20\)/.test(saidOf(eH20)) && heldH20 === LA
        && /A natural 20 — \*\*user\d+\*\* bursts free of \*\*user\d+\*\*, whose next attack is a flat d20/.test(saidOf(eB20)) && fxA20.flatAtk === true && !heldB20
        && /The struggle costs \*\*user\d+\*\* \*\*2\*\* wounds/.test(saidOf(eB1)) && hp6a === hp6 - 2
        && /\(ties go to the grappler\)/.test(saidOf(eTie)) && heldTie === LA
        && /the grip slips: \*\*user\d+\*\* is free at once, no wound, and \*\*user\d+\*\*'s next roll is a flat d20 at disadvantage/.test(saidOf(eH1))
        && !/escape[,)]/.test(saidOf(eH1)) && fxA1.fooled === true && fxA1.fooledDis === true && !fxA1.flatAtk && !heldH1 && hpOf(LB) === hp6b && f6.turn_index === 0,
      `${flat1(saidOf(eH20)).slice(0, 160)} · ${heldH20 === LA} · ${flat1(saidOf(eB20)).slice(0, 160)} · ${JSON.stringify(fxA20)} ${heldB20} · ${flat1(saidOf(eB1)).slice(0, 160)} ${hp6a}/${hp6} · ${flat1(saidOf(eTie)).slice(0, 160)} ${heldTie} · ${flat1(saidOf(eH1)).slice(0, 240)} ${JSON.stringify(fxA1)} ${heldH1} ${hpOf(LB)}/${hp6b} @${f6.turn_index}`);

    // 7 · the turn clock: a captive gone quiet is reminded, then stays
    await fL1({ commandName: 'session', options: { _sub: 'clock', timeout: 'skip' }, userId: 'U1' });
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const m7P = await press('fact:maintain', LA);
    await withDice([10], () => submit(modalOf(m7P), LA));
    const hp7 = hpOf(LB);
    quietL(6); let n0 = sent.length; await tickAll();
    const rem7 = textOf(newIn('CL1', n0));
    quietL(16); n0 = sent.length; await tickAll();
    const stay7 = textOf(newIn('CL1', n0)), f7 = fightL();
    ok('the turn clock: a captive gone quiet on a kept hold is reminded what it waits for, then stays in it — the hold keeps, no wound yet, the turn moves on',
      /has a kept hold to answer — break free or stay/.test(rem7) && /they stay in the hold/.test(rem7)
        && /minutes quiet — \*\*user\d+\*\* stays in the hold/.test(stay7) && /stays in the hold — it keeps/.test(stay7)
        && f7.turn_index === 1 && f7.phase === 'attack' && hpOf(LB) === hp7 && heldBy(LB) === LA,
      `${flat1(rem7).slice(0, 220)} · ${flat1(stay7).slice(0, 260)} · @${f7.turn_index}/${f7.phase} · ${hpOf(LB)}/${hp7}`);

    // 8 · an NPC captive on auto struggles by itself, and the chain goes on
    const chL2 = new FakeChannel('CL2', 0, 'l-auto', guild); channelsById.set(chL2.id, chL2);
    await fire({ channel: chL2, commandName: 'fight', options: { _sub: 'start', players: `<@${LA}>`, npcs: 'Lbrute', manual: true }, userId: 'U1' });
    setL({ ...FRESH, turn_order: [LA, 'npc:Lbrute'], turn_index: 0, grapples: { 'npc:Lbrute': LA }, auto_npc: 1 }, 'CL2');
    const realTOL = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...a) => setImmediate(() => fn(...a));
    n0 = sent.length;
    const m8P = await press('fact:maintain', LA, chL2);
    const m8S = await withDice([5, 20], async () => { const r = await submit(modalOf(m8P), LA, chL2); for (let i = 0; i < 8; i++) await settle(); return r; });
    globalThis.setTimeout = realTOL;
    const auto8 = textOf(newIn('CL2', n0)), f8 = fightL('CL2');
    ok('an NPC captive on auto struggles by itself — a 20 bursts free and leaves the grappler’s next attack flat — and the chain goes on to its own swing',
      /struggles against it/.test(saidOf(m8S)) && /Break free\*\* — Lbrute/.test(auto8) && /bursts free of \*\*user\d+\*\*, whose next attack is a flat d20/.test(auto8)
        && !heldBy('npc:Lbrute', 'CL2') && fxOf(LA, 'CL2').flatAtk === true && f8.phase === 'defend' && f8.current_target === LA,
      `${flat1(saidOf(m8S)).slice(0, 160)} · ${flat1(auto8).slice(0, 400)} · ${heldBy('npc:Lbrute', 'CL2')} ${JSON.stringify(fxOf(LA, 'CL2'))} · ${f8.phase}/${f8.current_target === LA}`);

    // 9 · the feint's naturals, and the price
    const feintWith = async (fNat, iNat) => {
      dbHandle.prepare("UPDATE characters SET deception_spent=0 WHERE guild_id='G1' AND user_id=?").run(LA);
      setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0 });
      await withDice([fNat], () => act(LA, { action: 'feint', target: LB, feint: 'a lunge high' }));
      return withDice([iNat], () => act(LB, { action: 'insight' }));
    };
    const hp9 = hpOf(LB);
    const f20 = await feintWith(20, 19);
    const hp9a = hpOf(LB), fxB9 = fxOf(LB), fxA9 = fxOf(LA);
    const f1 = await feintWith(1, 10);
    const fxA9b = fxOf(LA), fxB9b = fxOf(LB), hp9b = hpOf(LB);
    setL({ phase: 'attack', current_target: null, atk_kind: null, turn_index: 0 });
    const bite = await withDice([15, 4], () => fL1({ commandName: 'fight', options: { _sub: 'atk', stat: 'str', target: LB, flavour: 'swing' }, userId: LA, ...asL(LA) }));
    const f9 = fightL(), fxA9c = fxOf(LA);
    const i20 = await feintWith(15, 20);
    const hp9c = hpOf(LB);
    const i1 = await feintWith(2, 1);
    const hp9d = hpOf(LB), fxB9d = fxOf(LB);
    ok('a feint of 20 fools them whatever the insight and lands for 2; a feint of 1 is a total failure; the feinter pays a flat next roll either way — at disadvantage after a 1, and it bites; an insight of 20 sees through, of 1 is fooled',
      /fooled whatever they read/.test(saidOf(f20)) && hp9a === hp9 - 2 && fxB9.fooled === true && fxA9.fooled === true && !fxA9.flatDef
        && /The price: \*\*user\d+\*\*'s next roll is a flat d20\._/.test(saidOf(f20))
        && /botches the feint — a natural 1, a total failure/.test(saidOf(f1)) && fxA9b.fooled === true && fxA9b.fooledDis === true && !fxB9b.fooled && hp9b === hp9a
        && /flat d20, at disadvantage\._/.test(saidOf(f1))
        && f9.atk_roll === 4 && /🎭 flat d20 \(disadvantage\)/.test(saidOf(bite)) && !fxA9c.fooled && !fxA9c.fooledDis
        && /A natural 20 — \*\*user\d+\*\* sees straight through it/.test(saidOf(i20)) && hp9c === hp9b
        && /A natural 1 on the insight — \*\*user\d+\*\* is completely fooled/.test(saidOf(i1)) && hp9d === hp9c - 2 && fxB9d.fooled === true,
      `${flat1(saidOf(f20)).slice(0, 200)} · ${hp9a}/${hp9} ${JSON.stringify(fxB9)} ${JSON.stringify(fxA9)} · ${flat1(saidOf(f1)).slice(0, 160)} · ${JSON.stringify(fxA9b)} ${JSON.stringify(fxB9b)} ${hp9b} · ${f9.atk_roll} ${flat1(saidOf(bite)).slice(0, 160)} ${JSON.stringify(fxA9c)} · ${flat1(saidOf(i20)).slice(0, 140)} ${hp9c} · ${flat1(saidOf(i1)).slice(0, 160)} ${hp9d} ${JSON.stringify(fxB9d)}`);

    // 10 · a defensive feint
    const chL3 = new FakeChannel('CL3', 0, 'l-pve', guild); channelsById.set(chL3.id, chL3);
    const f3 = (over) => fire({ channel: chL3, ...over });
    await f3({ commandName: 'fight', options: { _sub: 'start', players: `<@${LA}>`, npcs: 'Lhound, Lcrow', manual: true }, userId: 'U1' });
    const npcSwing = (nat) => { setL({ ...FRESH, turn_order: ['npc:Lhound', LA, 'npc:Lcrow'], turn_index: 0 }, 'CL3'); return withDice([nat], () => f3({ commandName: 'fight', options: { _sub: 'atk', npc: 'Lhound', stat: 'str', target: LA, flavour: 'claws' }, userId: 'U1' })); };
    const dfeint = async (aNat, dNat) => {
      dbHandle.prepare("UPDATE characters SET deception_spent=0 WHERE guild_id='G1' AND user_id=?").run(LA);
      await npcSwing(aNat);
      await withDice([dNat], () => f3({ commandName: 'fight', options: { _sub: 'act', action: 'feint', feint: 'a stumble' }, userId: LA, ...asL(LA) }));
      return f3({ commandName: 'fight', options: { _sub: 'resolve' }, userId: 'U1' });
    };
    const d10 = await dfeint(5, 15);
    const fxH10 = fxOf('npc:Lhound', 'CL3'), fxA10 = fxOf(LA, 'CL3');
    const d1 = await dfeint(18, 1);
    const fxH10b = fxOf('npc:Lhound', 'CL3'), fxA10b = fxOf(LA, 'CL3');
    ok('a defensive feint read right: the attacker is taken in, their next roll flat, and the feinter pays a flat next roll of their own; a natural 1 fails outright, the price at disadvantage',
      /is taken in — their next roll is a flat d20/.test(saidOf(d10)) && fxH10.fooled === true && fxA10.fooled === true && !fxA10.flatDef && !fxH10.flatAtk
        && /The price: \*\*user\d+\*\*'s next roll is a flat d20\._/.test(saidOf(d10))
        && /the read fails outright/.test(saidOf(d1)) && !fxH10b.fooled && fxA10b.fooled === true && fxA10b.fooledDis === true,
      `${flat1(saidOf(d10)).slice(0, 260)} · ${JSON.stringify(fxH10)} ${JSON.stringify(fxA10)} · ${flat1(saidOf(d1)).slice(0, 200)} · ${JSON.stringify(fxH10b)} ${JSON.stringify(fxA10b)}`);

    // 10b · a defensive feint of 1 is a total failure: the blow lands though
    // the totals say it misses — an attack of 1 still fumbles
    const crowSwing = (nat) => { setL({ ...FRESH, turn_order: ['npc:Lcrow', LA, 'npc:Lhound'], turn_index: 0 }, 'CL3'); return withDice([nat], () => f3({ commandName: 'fight', options: { _sub: 'atk', npc: 'Lcrow', stat: 'str', target: LA, flavour: 'pecks' }, userId: 'U1' })); };
    const dfeintC = async (aNat, dNat) => {
      dbHandle.prepare("UPDATE characters SET deception_spent=0 WHERE guild_id='G1' AND user_id=?").run(LA);
      await crowSwing(aNat);
      await withDice([dNat], () => f3({ commandName: 'fight', options: { _sub: 'act', action: 'feint', feint: 'a stumble' }, userId: LA, ...asL(LA) }));
      return f3({ commandName: 'fight', options: { _sub: 'resolve' }, userId: 'U1' });
    };
    const hpA10 = hpOf(LA, 'CL3');
    const dB = await dfeintC(3, 1);   // 4 against 6: the totals say it misses
    const hpA10b = hpOf(LA, 'CL3'), fxA10c = fxOf(LA, 'CL3');
    const dF = await dfeintC(1, 1);
    const hpA10c = hpOf(LA, 'CL3');
    ok('a defensive feint of 1 is a total failure: the blow lands whatever the totals, the defending 1 adding its own; an attack of 1 still fumbles',
      /the read fails outright and the blow lands, whatever the totals/.test(saidOf(dB)) && /hits \*\*user\d+\*\* for \*\*2\*\* damage/.test(saidOf(dB))
        && hpA10b === hpA10 - 2 && fxA10c.fooled === true && fxA10c.fooledDis === true
        && /fumbles the attack/.test(saidOf(dF)) && /the read fails outright;/.test(saidOf(dF)) && !/the blow lands/.test(saidOf(dF)) && hpA10c === hpA10b,
      `${flat1(saidOf(dB)).slice(0, 320)} · ${hpA10b}/${hpA10} ${JSON.stringify(fxA10c)} · ${flat1(saidOf(dF)).slice(0, 240)} · ${hpA10c}`);

    // 11 · deflect and disarm: their naturals
    const deflectWith = async (aNat, dNat) => { await npcSwing(aNat); return withDice([dNat], () => f3({ commandName: 'fight', options: { _sub: 'act', action: 'deflect', redirect_npc: 'Lcrow' }, userId: LA, ...asL(LA) })); };
    const hpC0 = hpOf('npc:Lcrow', 'CL3');
    const dfl20 = await deflectWith(15, 20);
    const hpC1 = hpOf('npc:Lcrow', 'CL3');
    const hpA0 = hpOf(LA, 'CL3');
    const dfl1 = await deflectWith(3, 1);
    const hpA1 = hpOf(LA, 'CL3'), fxA11 = fxOf(LA, 'CL3');
    const disarmWith = async (aNat, dNat) => { await npcSwing(aNat); return withDice([dNat], () => f3({ commandName: 'fight', options: { _sub: 'act', action: 'disarm' }, userId: LA, ...asL(LA) })); };
    const hpH0 = hpOf('npc:Lhound', 'CL3');
    const dis20 = await disarmWith(15, 20);
    const hpH1 = hpOf('npc:Lhound', 'CL3'), fxH11 = fxOf('npc:Lhound', 'CL3'), fxA11b = fxOf(LA, 'CL3');
    setL({ phase: 'attack', current_target: null, atk_kind: null, turn_index: 0 }, 'CL3');
    let nSw = sent.length;
    await withDice([12], () => f3({ commandName: 'fight', options: { _sub: 'atk', npc: 'Lhound', stat: 'str', target: LA, flavour: 'snaps' }, userId: 'U1' }));
    const swingFlat = textOf(newIn('CL3', nSw));
    const f11 = fightL('CL3');
    const hpA2 = hpOf(LA, 'CL3');
    const dis1 = await disarmWith(2, 1);
    const hpA3 = hpOf(LA, 'CL3'), fxA11c = fxOf(LA, 'CL3');
    ok('deflect: a 20 turns the blow whatever the totals and the named enemy takes 2; a 1 fails for 2, the next defence flat as well as the next attack. Disarm: a 20 wounds the attacker 1 and leaves their next swing flat, no fetching turn; a 1 fails for 1, the next attack flat as well as the next defence',
      /the shield turns it whatever the totals/.test(saidOf(dfl20)) && /into \*\*Lcrow 🎭\*\* for \*\*2\*\* damage/.test(saidOf(dfl20)) && hpC1 === hpC0 - 2
        && /the deflection fails outright/.test(saidOf(dfl1)) && /takes \*\*2\*\* damage/.test(saidOf(dfl1)) && hpA1 === hpA0 - 2 && fxA11.flatDef === true && fxA11.flatAtk === true
        && /next attack and next defence are flat d20s/.test(saidOf(dfl1))
        && /blade is torn from \*\*Lhound 🎭\*\*'s grip and turned on them/.test(saidOf(dis20)) && hpH1 === hpH0 - 1 && fxH11.flatAtk === true && !fxH11.disarmed && fxA11b.flatDef === true
        && f11.atk_roll === 12 && /off-balance/.test(swingFlat)
        && /the disarm fails outright/.test(saidOf(dis1)) && hpA3 === hpA2 - 1 && fxA11c.flatAtk === true && fxA11c.flatDef === true,
      `${flat1(saidOf(dfl20)).slice(0, 200)} ${hpC1}/${hpC0} · ${flat1(saidOf(dfl1)).slice(0, 200)} ${hpA1}/${hpA0} ${JSON.stringify(fxA11)} · ${flat1(saidOf(dis20)).slice(0, 200)} ${hpH1}/${hpH0} ${JSON.stringify(fxH11)} ${JSON.stringify(fxA11b)} · ${f11.atk_roll} ${flat1(swingFlat).slice(0, 160)} · ${flat1(saidOf(dis1)).slice(0, 200)} ${hpA3}/${hpA2} ${JSON.stringify(fxA11c)}`);

    // 12 · /deception: the naturals; the price on the deceiver's sheet; /roll
    // honours a flat mark now, and the rider rolls at disadvantage
    const chL4 = new FakeChannel('CL4', 0, 'l-talk', guild); channelsById.set(chL4.id, chL4);
    const fT = (over) => fire({ channel: chL4, ...over });
    const markOf = (id) => dbHandle.prepare("SELECT next_mark FROM characters WHERE guild_id='G1' AND user_id=?").get(id)?.next_mark ?? null;
    dbHandle.prepare("UPDATE characters SET deception_spent=0, next_mark=NULL WHERE guild_id='G1' AND user_id IN (?, ?)").run(LA, LB);
    const dc20 = await withDice([20, 20], () => fT({ commandName: 'deception', options: { target: LB, claim: 'the bridge is safe' }, userId: LA, ...asL(LA) }));
    const mA = markOf(LA), mB = markOf(LB);
    const rB = await withDice([7], () => fT({ commandName: 'roll', options: { stat: 'str' }, userId: LB, ...asL(LB) }));
    const mB2 = markOf(LB);
    const rA1 = await fT({ commandName: 'roll', options: { stat: 'str' }, userId: LA, ...asL(LA) });
    const again = await withDice([10, 10], () => fT({ commandName: 'deception', options: { target: LB, claim: 'again' }, userId: LA, ...asL(LA) }));
    const spentStill = await fT({ commandName: 'deception', options: { target: LB, claim: 'and again' }, userId: LA, ...asL(LA) });
    await fT({ commandName: 'roll', options: { stat: 'str' }, userId: LA, ...asL(LA) });
    const dc1 = await withDice([1, 10], () => fT({ commandName: 'deception', options: { target: LB, claim: 'I am the king' }, userId: LA, ...asL(LA) }));
    const mA3 = markOf(LA), mB3 = markOf(LB);
    const rA = await withDice([15, 4], () => fT({ commandName: 'roll', options: { stat: 'str' }, userId: LA, ...asL(LA) }));
    const mA4 = markOf(LA);
    ok('/deception: twenty meets twenty and the lie wins; both sides’ next rolls are flat — the target’s for being taken in, the deceiver’s the price — and /roll strips the stat for it; the flat roll re-arms the trick, a second lie with no roll between is refused; a lie of 1 falls apart, the price a flat d20 at disadvantage',
      /Twenty meets twenty!\*\* The lie wins/.test(saidOf(dc20)) && mB === 'flat' && mA === 'flat' && /The price: \*\*user\d+\*\*'s very next roll is a flat d20\._/.test(saidOf(dc20))
        && /flat d20/.test(allOf(rB)) && /\[7\]/.test(allOf(rB)) && !/\+ ?4/.test(allOf(rB).replace(/\[[^\]]*\]/g, '')) && mB2 === null
        && /flat d20/.test(allOf(rA1)) && !/trick is spent/.test(saidOf(again)) && /sees straight through it/.test(saidOf(again)) && /trick is spent/.test(saidOf(spentStill))
        && /the lie falls apart, a total failure/.test(saidOf(dc1)) && mA3 === 'flatdis' && mB3 === null && /flat d20, at disadvantage\._/.test(saidOf(dc1))
        && /flat d20/.test(allOf(rA)) && /\[4, ~~15~~\]|\[15, 4\]|~~15~~/.test(allOf(rA)) && mA4 === null,
      `${flat1(saidOf(dc20)).slice(0, 220)} · ${mA}/${mB} · ${allOf(rB).slice(0, 200)} · ${mB2} · ${allOf(rA1).slice(0, 120)} · ${flat1(saidOf(again)).slice(0, 120)} · ${flat1(saidOf(spentStill)).slice(0, 60)} · ${flat1(saidOf(dc1)).slice(0, 200)} · ${mA3}/${mB3} · ${allOf(rA).slice(0, 240)} · ${mA4}`);

    // 13 · an NPC's feint writes no sheet; a stray written before goes, page
    // and all, when the server is mended
    dbHandle.prepare("UPDATE npcs SET wis=5 WHERE guild_id='G1' AND name='Lhound'").run();
    setL({ ...FRESH, turn_order: ['npc:Lhound', LA, 'npc:Lcrow'], turn_index: 0 }, 'CL3');
    const nf = await withDice([10], () => f3({ commandName: 'fight', options: { _sub: 'act', action: 'feint', npc: 'Lhound', target: LA, feint: 'a feigned retreat' }, userId: 'U1' }));
    const strayNow = dbHandle.prepare("SELECT COUNT(*) n FROM characters WHERE guild_id='G1' AND user_id LIKE 'npc:%'").get().n;
    const npcFeinted = fightL('CL3').atk_kind === 'feint';
    dbHandle.prepare("INSERT OR REPLACE INTO characters (guild_id, user_id, str, con, dex, wis, lck, hp_current) VALUES ('G1', 'npc:Ghost', 1, 1, 1, 1, 1, 3)").run();
    dbHandle.prepare("INSERT OR REPLACE INTO char_pages (guild_id, user_id, thread_id, url, title, at) VALUES ('G1', 'npc:Ghost', '999000111', NULL, 'Unknown', ?)").run(Date.now());
    await fire({ commandName: 'gm', options: { _group: 'check', _sub: 'run' }, userId: 'U1' }).catch(() => ({ replies: [] }));
    await settle();
    const strayAfter = dbHandle.prepare("SELECT COUNT(*) n FROM characters WHERE guild_id='G1' AND user_id LIKE 'npc:%'").get().n;
    const pageAfter = dbHandle.prepare("SELECT COUNT(*) n FROM char_pages WHERE guild_id='G1' AND user_id LIKE 'npc:%'").get().n;
    ok('an NPC’s feint writes no player sheet (the trick’s spend read npc_ for npc:); a stray from before is cleared with its page when the server is mended',
      npcFeinted && strayNow === 0 && strayAfter === 0 && pageAfter === 0,
      `${flat1(saidOf(nf)).slice(0, 100)} · feint ${npcFeinted} · strays ${strayNow} → ${strayAfter} · pages ${pageAfter}`);

    // 14 · a turn the clock skips still ends: the held fighter's wound lands
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 1, grapples: { [LB]: LA } });
    const hp14 = hpOf(LB);
    quietL(16); n0 = sent.length; await tickAll();
    const skip14 = textOf(newIn('CL1', n0));
    ok('a held fighter’s turn the clock skips still ends with its wound',
      /turn is skipped/.test(skip14) && /still held by \*\*user\d+\*\* — \*\*1\*\* wound/.test(skip14) && hpOf(LB) === hp14 - 1 && fightL().turn_index === 0,
      `${flat1(skip14).slice(0, 260)} · ${hpOf(LB)}/${hp14} @${fightL().turn_index}`);

    // 15 · a kept hold of 1 slips as it is rolled: free, no wound, nothing
    // to answer, the holder flat at disadvantage, the turn gone on
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const hp15 = hpOf(LB);
    const m15P = await press('fact:maintain', LA);
    const m15S = await withDice([1], () => submit(modalOf(m15P), LA));
    const f15 = fightL(), fxA15 = fxOf(LA);
    const card15 = (m15S.replies || []).find(x => /grip slips/.test(x.content || ''));
    ok('a kept hold of 1 slips at once: the captive is free with no wound and nothing to answer; the holder’s next roll is flat at disadvantage; the turn moves on',
      /the grip slips: \*\*user\d+\*\* is free at once, no wound, and \*\*user\d+\*\*'s next roll is a flat d20 at disadvantage/.test(saidOf(m15S))
        && !heldBy(LB) && hpOf(LB) === hp15 && fxA15.fooled === true && fxA15.fooledDis === true
        && f15.phase === 'attack' && f15.turn_index === 1 && !f15.atk_kind && !idsOf(card15).includes('fbreak'),
      `${flat1(saidOf(m15S)).slice(0, 300)} · ${heldBy(LB)} ${hpOf(LB)}/${hp15} ${JSON.stringify(fxA15)} · ${f15.phase}/${f15.turn_index}/${f15.atk_kind} · ${idsOf(card15).join(',')}`);

    // 16 · a reroll names its roll: a hold rerolled into a 1 slips at once;
    // a grab waits on the save; an attack waits on the defence
    dbHandle.prepare("UPDATE characters SET rerolls_current=5 WHERE guild_id='G1' AND user_id=?").run(LA);
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const m16P = await press('fact:maintain', LA);
    await withDice([10], () => submit(modalOf(m16P), LA));
    const rrH = await withDice([1], () => fL1({ commandName: 'fight', options: { _sub: 'rr' }, userId: LA, ...asL(LA) }));
    const f16 = fightL(), fxA16 = fxOf(LA);
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0 });
    await withDice([8], () => act(LA, { action: 'grapple', target: LB, flavour: 'grab' }));
    const rrG = await withDice([9], () => fL1({ commandName: 'fight', options: { _sub: 'rr' }, userId: LA, ...asL(LA) }));
    const f16g = fightL();
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0 });
    await withDice([8], () => fL1({ commandName: 'fight', options: { _sub: 'atk', stat: 'str', target: LB, flavour: 'swing' }, userId: LA, ...asL(LA) }));
    const rrA = await withDice([9], () => fL1({ commandName: 'fight', options: { _sub: 'rr' }, userId: LA, ...asL(LA) }));
    ok('a reroll names its roll: a hold rerolled into a 1 slips at once; a grab waits on the STR save and an attack on the defence — neither on /fight resolve',
      /rerolls \*\(reroll\)\* — the hold with STR!/.test(saidOf(rrH)) && /the grip slips/.test(saidOf(rrH)) && !heldBy(LB)
        && fxA16.fooled === true && fxA16.fooledDis === true && f16.turn_index === 1 && f16.phase === 'attack'
        && /rerolls \*\(reroll\)\* — the grapple with STR!/.test(saidOf(rrG)) && /answers with the STR save/.test(saidOf(rrG)) && !/fight resolve/.test(saidOf(rrG))
        && f16g.atk_kind === 'grapple' && f16g.atk_nat === 9
        && /rerolls \*\(reroll\)\* — attack with STR!/.test(saidOf(rrA)) && /Waiting on \*\*user\d+\*\*'s defence/.test(saidOf(rrA)) && !/fight resolve/.test(saidOf(rrA)),
      `${flat1(saidOf(rrH)).slice(0, 300)} · ${heldBy(LB)} ${JSON.stringify(fxA16)} @${f16.turn_index}/${f16.phase} · ${flat1(saidOf(rrG)).slice(0, 200)} · ${f16g.atk_kind}/${f16g.atk_nat} · ${flat1(saidOf(rrA)).slice(0, 200)}`);

    // 17 · in a fight the trick is a feint: /deception is refused to anyone
    // fighting in the channel, before anything is spent; a feint pressed
    // against a kept hold is refused before the trick is spent
    dbHandle.prepare("UPDATE characters SET deception_spent=0, next_mark=NULL WHERE guild_id='G1' AND user_id IN (?, ?)").run(LA, LB);
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0 });
    const dIn = await fL1({ commandName: 'deception', options: { target: LB, claim: 'look behind you' }, userId: LA, ...asL(LA) });
    const dInT = await fL1({ commandName: 'deception', options: { target: LA, claim: 'he started it' }, userId: LW, ...asL(LW) });
    const spentAfter = dbHandle.prepare("SELECT deception_spent d, next_mark m FROM characters WHERE guild_id='G1' AND user_id=?").get(LA);
    setL({ ...FRESH, turn_order: [LA, LB], turn_index: 0, grapples: { [LB]: LA } });
    const m17P = await press('fact:maintain', LA);
    await withDice([10], () => submit(modalOf(m17P), LA));
    const fv = await act(LB, { action: 'feint', feint: 'a sly look' });
    const lbAfter = dbHandle.prepare("SELECT deception_spent d FROM characters WHERE guild_id='G1' AND user_id=?").get(LB);
    const fxB17 = fxOf(LB), f17 = fightL();
    ok('/deception is refused to anyone fighting in the channel, pointing to Feint, with nothing spent; a feint against a kept hold is refused before the trick is spent',
      /In a fight, a trick is a feint/.test(saidOf(dIn)) && /In a fight, a trick is a feint/.test(saidOf(dInT)) && !spentAfter.d && !spentAfter.m
        && /That is a kept hold/.test(saidOf(fv)) && !lbAfter.d && !fxB17.feintDef && !fxB17.feintUsed && f17.atk_kind === 'hold' && f17.phase === 'defend',
      `${flat1(saidOf(dIn)).slice(0, 120)} · ${flat1(saidOf(dInT)).slice(0, 80)} · ${JSON.stringify(spentAfter)} · ${flat1(saidOf(fv)).slice(0, 120)} · ${JSON.stringify(lbAfter)} ${JSON.stringify(fxB17)} · ${f17.atk_kind}/${f17.phase}`);

    // 18 · no pending grapple, feint or hold outlives its exchange: a kick, a
    // fight's end
    setL({ ...FRESH, turn_order: [LA, LB, LW], turn_index: 0, phase: 'defend', current_target: LW, atk_kind: 'feint', atk_roll: 9, atk_nat: 9, atk_stat: 'wis', atk_rerolled: 1 });
    await fL1({ commandName: 'fight', options: { _sub: 'kick', target: LW }, userId: 'U1' });
    const f18 = fightL();
    setL({ phase: 'defend', current_target: LA, atk_kind: 'grapple', atk_roll: 12, atk_nat: 12, def_rerolled: 1 }, 'CL2');
    const end18 = await fire({ channel: chL2, commandName: 'fight', options: { _sub: 'end' }, userId: 'U1' });
    const end18Btn = idsOf(end18.replies[0]).find(id => /^confirm:/.test(id));
    if (end18Btn) await fire({ channel: chL2, isButton: true, customId: end18Btn, message: { id: nextId(), content: '', components: [] }, userId: 'U1' });
    const f18e = fightL('CL2');
    ok('a kick and a fight’s end clear the pending exchange: no grapple, feint or hold, no reroll spent, left for the next',
      f18.atk_kind === null && f18.phase === 'attack' && !f18.atk_rerolled && f18.current_target === null
        && f18e.state === 'idle' && f18e.atk_kind === null && f18e.phase === 'attack' && !f18e.def_rerolled && f18e.atk_roll === null,
      `${f18.atk_kind}/${f18.phase}/${f18.atk_rerolled}/${f18.current_target} · ${f18e.state}/${f18e.atk_kind}/${f18e.phase}/${f18e.def_rerolled}/${f18e.atk_roll}`);

    // 19 · an attacking 20 lands whatever the totals, for its crit; Disarm and
    // a defensive feint are refused against it before anything is spent
    {
      const hs = JSON.parse(fightL('CL3').hp_state || '{}'); hs[LA] = 10; setL({ hp_state: hs }, 'CL3');
      dbHandle.prepare("UPDATE characters SET next_mark=NULL, deception_spent=0 WHERE guild_id='G1' AND user_id=?").run(LA);
    }
    const hp19 = hpOf(LA, 'CL3');
    await crowSwing(20);   // 21
    const d19 = await withDice([19], () => f3({ commandName: 'fight', options: { _sub: 'def', stat: 'str', flavour: 'a wall of steel' }, userId: LA, ...asL(LA) }));   // 24
    const r19 = await f3({ commandName: 'fight', options: { _sub: 'resolve' }, userId: 'U1' });
    const said19 = `${saidOf(d19)}\n${saidOf(r19)}`, hp19b = hpOf(LA, 'CL3');
    await crowSwing(20);
    const dz = await f3({ commandName: 'fight', options: { _sub: 'act', action: 'disarm' }, userId: LA, ...asL(LA) });
    const fz = await f3({ commandName: 'fight', options: { _sub: 'act', action: 'feint', feint: 'a dodge' }, userId: LA, ...asL(LA) });
    const spent19 = dbHandle.prepare("SELECT deception_spent d FROM characters WHERE guild_id='G1' AND user_id=?").get(LA);
    const fx19 = fxOf(LA, 'CL3'), f19 = fightL('CL3');
    ok('an attacking 20 lands whatever the totals, for 2, and the card says so; Disarm and a defensive feint are refused against it, nothing spent',
      /A natural 20\*\* — the blow lands whatever the totals/.test(said19) && /hits \*\*user\d+\*\* for \*\*2\*\* damage/.test(said19) && hp19b === hp19 - 2
        && /cannot be disarmed/.test(saidOf(dz)) && /cannot be read/.test(saidOf(fz)) && !spent19.d && !fx19.disarmUsed && !fx19.feintDef && !fx19.feintUsed
        && f19.phase === 'defend' && f19.atk_nat === 20 && f19.def_roll === null,
      `${flat1(said19).slice(0, 320)} · ${hp19b}/${hp19} · ${flat1(saidOf(dz)).slice(0, 100)} · ${flat1(saidOf(fz)).slice(0, 100)} · ${JSON.stringify(spent19)} ${JSON.stringify(fx19)} · ${f19.phase}/${f19.atk_nat}/${f19.def_roll}`);

    for (const c of ['CL1', 'CL2', 'CL3']) await fire({ channel: channelsById.get(c), commandName: 'fight', options: { _sub: 'end' }, userId: 'U1' }).catch(() => {});
    guild.members.fetch = realFetchL;
    const threwL = loggedL.filter(l => /ReferenceError|TypeError|is not a function|Cannot read|is not defined|SqliteError|no such column/.test(l));
    console.error = realErrL;
    ok('nothing in the L walk threw', threwL.length === 0, threwL.slice(0, 3).join('\n        '));
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
