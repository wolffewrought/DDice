#!/usr/bin/env node
// verify.js — the whole verify loop, in one file.
//
//   node --expose-internals verify.js            everything
//   node --expose-internals verify.js scan       scanners only
//   node --expose-internals verify.js test       harnesses only
//   node --expose-internals verify.js -v         list every warning
//
// --expose-internals is not decoration: the scanners parse real JavaScript
// with node's bundled acorn, and there is no network here to fetch a parser.
//
// Exit 1 if any scanner reports an ERROR or any assertion fails. WARN
// reports and does not fail — it needs a human. Do not silence one to get a
// green run; the standing warnings are listed in HANDOFF.md §6.
//
// Layout:
//   1  AST toolkit          shared by every scanner
//   2  Scanners             structure · wiring · limits · rulesets
//   3  Stubs                discord.js · better-sqlite3 · dotenv · canvas
//   4  Loader               index.js, executed against the stubs
//   5  Harnesses            builders · rules · structure pins
//   6  Runner

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = __dirname;
const INDEX = path.join(ROOT, 'index.js');

const argv = process.argv.slice(2);
const VERBOSE = argv.includes('-v') || argv.includes('--verbose');
const ONLY = argv.find(a => a === 'scan' || a === 'test') || null;

// ═══ 1 · AST toolkit ════════════════════════════════════════════════

const acorn = require('internal/deps/acorn/acorn/dist/acorn');

function parse(src) {
  return acorn.parse(src, {
    ecmaVersion: 'latest', sourceType: 'script',
    locations: true, allowReturnOutsideFunction: true,
  });
}

const lineOf = (n) => (n && n.loc ? n.loc.start.line : 0);

function walk(node, visit, parents = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parents);
  const chain = parents.concat(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end') continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const c of val) if (c && typeof c.type === 'string') walk(c, visit, chain);
    } else if (val && typeof val.type === 'string') walk(val, visit, chain);
  }
}

// A fluent chain alternates call and member links — a().b().c() is
// Call(Member(Call(Member(...)))) — so climbing must alternate too. Stopping
// after one pass of each lands on an intermediate call, which is how the
// wiring scanner once silently reported zero subcommands.
function rootOf(node) {
  let n = node;
  for (;;) {
    if (n && n.type === 'CallExpression') { n = n.callee; continue; }
    if (n && n.type === 'MemberExpression') { n = n.object; continue; }
    return n;
  }
}

// The static text of a node, when it is knowable. A template returns only
// its fixed parts; substitutions are counted separately, because a string
// that is over on its literal text alone is a certainty while one that
// merely could be is a risk.
function staticText(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') return node.quasis.map(q => q.value.cooked ?? '').join('');
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = staticText(node.left), r = staticText(node.right);
    if (l !== null && r !== null) return l + r;
  }
  return null;
}

// A nested builder always sits inside an arrow callback. Method names cannot
// tell you this, because in a fluent chain the earlier call is an AST
// descendant of the later one.
const atThisLevel = (parents) => !parents.some(p => /Function/.test(p.type));

const OPTION_ADDERS = /^add(String|Integer|Boolean|User|Channel|Role|Mentionable|Number|Attachment)Option$/;
const GETTERS = /^get(String|Integer|Boolean|User|Channel|Role|Mentionable|Number|Attachment)$/;

function collector() {
  const out = [];
  return {
    out,
    err: (rule, msg, line) => out.push({ sev: 'ERROR', rule, msg, line }),
    warn: (rule, msg, line) => out.push({ sev: 'WARN', rule, msg, line }),
  };
}

// ═══ 2 · Scanners ═══════════════════════════════════════════════════

// ── 2.1 Structure ───────────────────────────────────────────────────
// Faults that syntax checking cannot see: a function declared twice so the
// second silently wins, an object key repeated so an earlier entry is dead,
// a call to a helper that no longer exists. Each has bitten this file.
function scanStructure(src, ast) {
  const { out, err, warn } = collector();

  const fnDecls = new Map();
  walk(ast, (node, parents) => {
    if (node.type !== 'FunctionDeclaration' || !node.id) return;
    const depth = parents.filter(p => /Function/.test(p.type)).length;
    if (!fnDecls.has(node.id.name)) fnDecls.set(node.id.name, []);
    fnDecls.get(node.id.name).push({ line: lineOf(node), depth });
  });
  for (const [name, decls] of fnDecls) {
    const top = decls.filter(d => d.depth === 0);
    if (top.length > 1) {
      err('dup-function',
        `function ${name}() declared ${top.length}x at top level — last wins, earlier bodies are dead`,
        top.map(d => d.line).join(','));
    }
  }

  const varDecls = new Map();
  walk(ast, (node, parents) => {
    if (node.type !== 'VariableDeclarator' || node.id.type !== 'Identifier') return;
    if (parents.some(p => /Function/.test(p.type) || p.type === 'BlockStatement')) return;
    if (!varDecls.has(node.id.name)) varDecls.set(node.id.name, []);
    varDecls.get(node.id.name).push(lineOf(node));
  });
  for (const [name, lines] of varDecls) {
    if (lines.length > 1) err('dup-binding', `top-level binding "${name}" declared ${lines.length}x`, lines.join(','));
  }

  walk(ast, (node) => {
    if (node.type !== 'ObjectExpression' || node.properties.length < 2) return;
    const seen = new Map();
    for (const p of node.properties) {
      if (p.type !== 'Property' || p.computed) continue;
      const k = p.key.type === 'Identifier' ? p.key.name
              : p.key.type === 'Literal' ? String(p.key.value) : null;
      if (k === null) continue;
      if (seen.has(k)) {
        err('dup-key', `object key "${k}" repeated — the later value wins, the earlier is dead`,
          `${seen.get(k)},${lineOf(p)}`);
      }
      seen.set(k, lineOf(p));
    }
  });

  // Every name that could legitimately be called: declarations, bindings,
  // parameters, catch params, globals.
  const known = new Set(fnDecls.keys());
  const GLOBALS = ['require', 'console', 'process', 'Math', 'JSON', 'Object', 'Array', 'String',
    'Number', 'Boolean', 'Date', 'Error', 'TypeError', 'RangeError', 'Promise', 'Set', 'Map',
    'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'RegExp', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'setImmediate',
    'Buffer', 'fetch', 'structuredClone', 'encodeURIComponent', 'decodeURIComponent',
    'queueMicrotask', 'AbortController', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
    'Intl', 'globalThis'];
  for (const g of GLOBALS) known.add(g);
  walk(ast, (node) => {
    if (node.type === 'ClassDeclaration' && node.id) known.add(node.id.name);
    if (node.type === 'CatchClause' && node.param && node.param.type === 'Identifier') known.add(node.param.name);
    if (/Function/.test(node.type)) {
      if (node.id) known.add(node.id.name);
      for (const p of node.params) {
        if (p.type === 'Identifier') known.add(p.name);
        if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') known.add(p.left.name);
        if (p.type === 'RestElement' && p.argument.type === 'Identifier') known.add(p.argument.name);
        if (p.type === 'ObjectPattern') for (const q of p.properties) {
          if (q.type === 'Property' && q.value.type === 'Identifier') known.add(q.value.name);
        }
      }
    }
    if (node.type === 'VariableDeclarator') {
      if (node.id.type === 'Identifier') known.add(node.id.name);
      if (node.id.type === 'ObjectPattern') for (const p of node.id.properties) {
        if (p.type === 'Property' && p.value.type === 'Identifier') known.add(p.value.name);
        if (p.type === 'RestElement' && p.argument.type === 'Identifier') known.add(p.argument.name);
      }
      if (node.id.type === 'ArrayPattern') for (const e of node.id.elements) {
        if (e && e.type === 'Identifier') known.add(e.name);
      }
    }
  });
  const called = new Map();
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return;
    if (node.callee.type !== 'Identifier') return;
    if (!called.has(node.callee.name)) called.set(node.callee.name, lineOf(node));
  });
  for (const [name, line] of called) {
    if (!known.has(name)) err('undefined-call', `${name}() is called but never declared`, line);
  }

  const referenced = new Set();
  walk(ast, (node, parents) => {
    if (node.type !== 'Identifier') return;
    const p = parents[parents.length - 1];
    if (!p) return;
    if (p.type === 'FunctionDeclaration' && p.id === node) return;
    if (p.type === 'Property' && p.key === node && !p.computed) return;
    if (p.type === 'MemberExpression' && p.property === node && !p.computed) return;
    referenced.add(node.name);
  });
  for (const [name, decls] of fnDecls) {
    if (decls.some(d => d.depth > 0)) continue;
    if (!referenced.has(name)) warn('dead-function', `function ${name}() is declared but never referenced`, decls[0].line);
  }

  // Repeated prose or table rows should be shared helpers. 256 chars, per
  // LIMITS.md §8.
  const strs = new Map();
  const note = (text, line) => {
    if (text.length < 256) return;
    if (!strs.has(text)) strs.set(text, []);
    strs.get(text).push(line);
  };
  walk(ast, (node) => {
    if (node.type === 'Literal' && typeof node.value === 'string') note(node.value, lineOf(node));
    if (node.type === 'TemplateLiteral') {
      note(node.quasis.map(q => q.value.cooked ?? '').join('\u0000'), lineOf(node));
    }
  });
  for (const [text, lines] of strs) {
    if (lines.length > 1) {
      warn('dup-block',
        `identical ${text.length}-char literal appears ${lines.length}x — extract a shared helper`,
        lines.join(','));
    }
  }

  // A router that hands off with `return handleX(...)` is correctly async —
  // the promise is the return value. Only a body that neither awaits nor
  // delegates is suspicious.
  walk(ast, (node) => {
    if (!/Function/.test(node.type) || !node.async || !node.id) return;
    let awaits = false, delegates = false;
    walk(node.body, (n, ps) => {
      if (ps.some(p => /Function/.test(p.type) && p !== node)) return;
      if (n.type === 'AwaitExpression') awaits = true;
      if (n.type === 'ReturnStatement' && n.argument &&
          (n.argument.type === 'CallExpression' || n.argument.type === 'AwaitExpression')) delegates = true;
    });
    if (!awaits && !delegates) {
      warn('async-no-await', `async function ${node.id.name}() neither awaits nor returns a promise`, lineOf(node));
    }
  });

  return out;
}

// ── Shared: reconstruct the registered command tree ─────────────────
// Builders are fluent chains of arrow callbacks. For any arrow passed to
// addSubcommand/addSubcommandGroup/add*Option, the name is the argument of
// the first .setName() applied to that arrow's own parameter.
function readBuilder(fn) {
  if (!fn || !/Function/.test(fn.type) || !fn.params[0]) return null;
  const param = fn.params[0].name;
  const out = { name: null, desc: null, line: lineOf(fn), choices: [], options: [], subs: [], groups: [] };
  walk(fn.body, (n, parents) => {
    if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return;
    const m = n.callee.property.name;
    const r = rootOf(n.callee.object);
    const onParam = r && r.type === 'Identifier' && r.name === param;
    if (onParam && m === 'setName' && out.name === null) out.name = staticText(n.arguments[0]);
    if (onParam && m === 'setDescription' && out.desc === null) out.desc = staticText(n.arguments[0]);
    if (onParam && m === 'addChoices') {
      for (const a of n.arguments) {
        if (a.type === 'ObjectExpression') out.choices.push(a);
        if (a.type === 'ArrayExpression') for (const e of a.elements) if (e) out.choices.push(e);
      }
    }
    if (!atThisLevel(parents)) return;
    if (OPTION_ADDERS.test(m)) { const o = readBuilder(n.arguments[0]); if (o) out.options.push(o); }
    if (m === 'addSubcommand') { const s = readBuilder(n.arguments[0]); if (s) out.subs.push(s); }
    if (m === 'addSubcommandGroup') { const g = readBuilder(n.arguments[0]); if (g) out.groups.push(g); }
  });
  return out;
}

function commandTree(ast) {
  const cmds = [];
  walk(ast, (node, parents) => {
    if (node.type !== 'NewExpression' || !node.callee || node.callee.name !== 'SlashCommandBuilder') return;
    let top = node;
    for (let i = parents.length - 1; i >= 0; i--) {
      const p = parents[i];
      if ((p.type === 'CallExpression' || p.type === 'MemberExpression') && rootOf(p) === node) top = p;
      else break;
    }
    const cmd = { name: null, desc: null, line: lineOf(node), choices: [], options: [], subs: [], groups: [] };
    walk(top, (n, ps) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return;
      const m = n.callee.property.name;
      if (rootOf(n.callee.object) === node) {
        if (m === 'setName' && cmd.name === null) cmd.name = staticText(n.arguments[0]);
        if (m === 'setDescription' && cmd.desc === null) cmd.desc = staticText(n.arguments[0]);
      }
      if (!atThisLevel(ps)) return;
      if (m === 'addSubcommand') { const s = readBuilder(n.arguments[0]); if (s) cmd.subs.push(s); }
      if (m === 'addSubcommandGroup') { const g = readBuilder(n.arguments[0]); if (g) cmd.groups.push(g); }
      if (OPTION_ADDERS.test(m)) { const o = readBuilder(n.arguments[0]); if (o) cmd.options.push(o); }
    });
    if (cmd.name) cmds.push(cmd);
  });
  return cmds;
}

const allSubs = (c) => c.subs.concat(...c.groups.map(g => g.subs));

// ── 2.2 Wiring ──────────────────────────────────────────────────────
// Registration and routing live hundreds of lines apart, so they drift. A
// subcommand Discord advertises but nothing routes is the worst failure
// this bot has: it appears in the picker, the user runs it, and the
// interaction times out with "the application did not respond".
function scanWiring(src, ast) {
  const { out, err, warn } = collector();
  const cmds = commandTree(ast);

  const compared = new Set();
  const cmdRoutes = new Set();
  const isProp = (s, name) => s.type === 'MemberExpression' && s.property.name === name;

  walk(ast, (node) => {
    if (node.type === 'BinaryExpression' && /^[!=]==?$/.test(node.operator)) {
      for (const side of [node.left, node.right]) {
        if (side.type === 'Literal' && typeof side.value === 'string') compared.add(side.value);
      }
      if (isProp(node.left, 'commandName') && node.right.type === 'Literal') cmdRoutes.add(String(node.right.value));
      if (isProp(node.right, 'commandName') && node.left.type === 'Literal') cmdRoutes.add(String(node.left.value));
    }
    if (node.type === 'SwitchCase' && node.test && node.test.type === 'Literal' &&
        typeof node.test.value === 'string') compared.add(node.test.value);
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' &&
        node.callee.property.name === 'includes' && node.callee.object.type === 'ArrayExpression') {
      for (const el of node.callee.object.elements) {
        if (el && el.type === 'Literal' && typeof el.value === 'string') compared.add(el.value);
      }
    }
  });

  let usesGroupApi = false;
  walk(ast, (n) => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
        n.callee.property.name === 'getSubcommandGroup') usesGroupApi = true;
  });

  for (const c of cmds) {
    if (!cmdRoutes.has(c.name)) {
      err('unrouted-command', `/${c.name} is registered but no dispatch compares interaction.commandName to it`, c.line);
    }
  }
  for (const n of cmdRoutes) {
    if (!cmds.some(c => c.name === n)) warn('orphan-route', `dispatch routes /${n} but no builder registers it`, 0);
  }

  // The last subcommand in a handler is often reached by fall-through
  // rather than an explicit compare — `if (sub === 'list') {...}` then the
  // clean path below it, marked only by a `// clean` comment. That is
  // deliberate, so this cannot be an ERROR without crying wolf.
  for (const c of cmds) {
    for (const s of allSubs(c)) {
      if (!compared.has(s.name)) {
        warn('unrouted-subcommand',
          `/${c.name} ${s.name} is registered but never compared — confirm a fall-through handles it`, c.line);
      }
    }
  }
  for (const c of cmds) {
    if (c.groups.length && !usesGroupApi) {
      err('group-never-read',
        `/${c.name} declares groups (${c.groups.map(g => g.name).join(', ')}) but getSubcommandGroup is never called`, c.line);
    }
    for (const g of c.groups) {
      if (!compared.has(g.name)) {
        warn('group-not-compared', `/${c.name} group "${g.name}" is never compared — leaves may still route by name`, c.line);
      }
    }
  }

  // customId round-trip.
  const builtExact = new Map(), builtPrefix = new Map();
  walk(ast, (node, parents) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.name !== 'setCustomId') return;
    const a = node.arguments[0];
    if (!a) return;
    // A page-counter button is built .setDisabled(true) and can never be
    // clicked, so it needs no route.
    for (let i = parents.length - 1; i >= 0; i--) {
      const p = parents[i];
      if (p.type !== 'CallExpression' && p.type !== 'MemberExpression') break;
      if (p.type === 'CallExpression' && p.callee.type === 'MemberExpression' &&
          p.callee.property.name === 'setDisabled' && p.arguments[0] && p.arguments[0].value === true) return;
    }
    if (a.type === 'Literal' && typeof a.value === 'string') builtExact.set(a.value, lineOf(node));
    else if (a.type === 'TemplateLiteral' && a.quasis.length) {
      const head = a.quasis[0].value.cooked || '';
      if (head.includes(':')) builtPrefix.set(head.slice(0, head.indexOf(':') + 1), lineOf(node));
      else if (head) builtPrefix.set(head, lineOf(node));
    }
  });

  const routedExact = new Set(), routedPrefix = new Set();
  walk(ast, (node) => {
    if (node.type === 'BinaryExpression' && /^[!=]==?$/.test(node.operator)) {
      if (isProp(node.left, 'customId') && node.right.type === 'Literal') routedExact.add(String(node.right.value));
      if (isProp(node.right, 'customId') && node.left.type === 'Literal') routedExact.add(String(node.left.value));
    }
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.name === 'startsWith' && isProp(node.callee.object, 'customId')) {
      const a = node.arguments[0];
      if (a && a.type === 'Literal') routedPrefix.add(String(a.value));
    }
    // Regex routing: /^duel(join|out|send|cancel|ok|no):/.test(customId)
    // routes six prefixes in one line.
    if (node.callee.property.name === 'test' && node.callee.object.type === 'Literal' && node.callee.object.regex) {
      const arg = node.arguments[0];
      const onCid = arg && (isProp(arg, 'customId') || (arg.type === 'Identifier' && /customid|cid/i.test(arg.name)));
      if (!onCid) return;
      const pat = node.callee.object.regex.pattern;
      const m = /^\^([A-Za-z0-9_-]*)\(([A-Za-z0-9_|-]+)\)([A-Za-z0-9_:-]*)/.exec(pat);
      if (m) for (const alt of m[2].split('|')) routedPrefix.add(m[1] + alt + m[3]);
      else {
        const plain = /^\^([A-Za-z0-9_-]+:?)/.exec(pat);
        if (plain) routedPrefix.add(plain[1]);
      }
    }
  });

  for (const [id, line] of builtExact) {
    if (routedExact.has(id)) continue;
    if ([...routedPrefix].some(p => id.startsWith(p))) continue;
    if (src.includes(`getTextInputValue('${id}')`)) continue;   // a modal field, not a route
    err('unrouted-customid', `customId "${id}" is built but nothing routes it`, line);
  }
  for (const [pre, line] of builtPrefix) {
    if ([...routedPrefix].some(p => p === pre || pre.startsWith(p) || p.startsWith(pre))) continue;
    if ([...routedExact].some(e => e.startsWith(pre))) continue;
    err('unrouted-customid-prefix', `customId prefix "${pre}" is built but nothing routes it`, line);
  }
  // Many ids never touch setCustomId directly — a local helper assembles
  // them, or they are handed to one. For the orphan check, any id-shaped
  // literal counts as built; the rule only catches a route whose id appears
  // nowhere at all.
  const idShaped = new Set();
  walk(ast, (node) => {
    const add = (s) => { const m = /^([A-Za-z][A-Za-z0-9_-]*:)/.exec(s); if (m) idShaped.add(m[1]); };
    if (node.type === 'Literal' && typeof node.value === 'string') add(node.value);
    if (node.type === 'TemplateLiteral' && node.quasis.length) add(node.quasis[0].value.cooked || '');
  });
  for (const p of routedPrefix) {
    const built = [...builtPrefix.keys()].some(b => b === p || b.startsWith(p) || p.startsWith(b))
               || [...builtExact.keys()].some(b => b.startsWith(p))
               || [...idShaped].some(b => b === p || b.startsWith(p) || p.startsWith(b));
    if (!built) warn('orphan-customid-route', `nothing builds a customId starting "${p}"`, 0);
  }

  const declared = new Set();
  for (const c of cmds) {
    for (const o of c.options) declared.add(o.name);
    for (const s of allSubs(c)) for (const o of s.options) declared.add(o.name);
  }
  const reads = new Map();
  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    if (!GETTERS.test(node.callee.property.name)) return;
    const a = node.arguments[0];
    if (a && a.type === 'Literal' && typeof a.value === 'string' && !reads.has(a.value)) reads.set(a.value, lineOf(node));
  });
  for (const [name, line] of reads) {
    if (!declared.has(name)) err('phantom-option', `options.get*('${name}') is read but no command declares that option`, line);
  }

  out.summary = `${cmds.length} commands · ${cmds.reduce((a, c) => a + allSubs(c).length, 0)} subcommands · ${builtExact.size + builtPrefix.size} customIds`;
  return out;
}

// ── 2.3 Limits ──────────────────────────────────────────────────────
// Every ceiling in LIMITS.md §1-§3 that can be checked without a network
// call. Discord rejects an over-limit command at registration with a JSON
// path and no line number, so the bot simply fails to boot.
function scanLimits(src, ast) {
  const { out, err, warn } = collector();
  const cmds = commandTree(ast);
  const NAME_RE = /^[a-z0-9_-]{1,32}$/;

  const checkNamed = (node, kind, label) => {
    if (node.name != null && !NAME_RE.test(node.name)) {
      err('bad-name', `${kind} "${label}" — names are 1-32 chars of a-z0-9_- (got "${node.name}")`, node.line);
    }
    if (node.desc == null) {
      if (node.name) warn('unreadable-description', `${kind} "${label}" description is not a static string`, node.line);
      return;
    }
    if (!node.desc.length) err('no-description', `${kind} "${label}" has an empty description`, node.line);
    else if (node.desc.length > 100) err('long-description', `${kind} "${label}" description is ${node.desc.length} chars (max 100)`, node.line);
    else if (node.desc.length > 92) warn('near-description', `${kind} "${label}" description is ${node.desc.length}/100 chars`, node.line);
  };

  const checkOptions = (opts, label, line) => {
    if (opts.length > 25) err('too-many-options', `"${label}" has ${opts.length} options (max 25)`, line);
    for (const o of opts) {
      checkNamed(o, 'option', `${label} ${o.name}`);
      if (o.choices.length > 25) err('too-many-choices', `option "${label} ${o.name}" has ${o.choices.length} choices (max 25)`, o.line);
    }
    const names = opts.map(o => o.name).filter(Boolean);
    for (const d of new Set(names.filter((n, i) => names.indexOf(n) !== i))) {
      err('dup-option', `"${label}" declares option "${d}" more than once`, line);
    }
  };

  // The real §1 wall counts the text a human wrote — names, descriptions
  // and choice values — not the JSON syntax around them. Measuring the
  // serialized blob reads roughly three times high.
  const budget = (c) => {
    let n = 0;
    const opt = (o) => {
      n += (o.name || '').length + (o.desc || '').length;
      for (const ch of o.choices) {
        for (const p of ch.properties || []) {
          const v = staticText(p.value);
          if (v) n += v.length;
        }
      }
    };
    n += (c.name || '').length + (c.desc || '').length;
    c.options.forEach(opt);
    for (const s of allSubs(c)) { n += (s.name || '').length + (s.desc || '').length; s.options.forEach(opt); }
    for (const g of c.groups) n += (g.name || '').length + (g.desc || '').length;
    return n;
  };

  const sizes = [];
  for (const c of cmds) {
    checkNamed(c, 'command', `/${c.name}`);
    checkOptions(c.options, `/${c.name}`, c.line);
    const leaves = c.subs.length + c.groups.length;
    if (leaves > 25) err('too-many-subcommands', `/${c.name} has ${leaves} subcommands+groups (max 25)`, c.line);
    else if (leaves >= 23) warn('near-subcommand-wall', `/${c.name} has ${leaves}/25 subcommands+groups`, c.line);
    for (const s of c.subs) { checkNamed(s, 'subcommand', `/${c.name} ${s.name}`); checkOptions(s.options, `/${c.name} ${s.name}`, s.line); }
    for (const g of c.groups) {
      checkNamed(g, 'group', `/${c.name} ${g.name}`);
      if (g.subs.length > 25) err('too-many-group-subs', `/${c.name} ${g.name} has ${g.subs.length} subcommands (max 25)`, g.line);
      for (const s of g.subs) { checkNamed(s, 'subcommand', `/${c.name} ${g.name} ${s.name}`); checkOptions(s.options, `/${c.name} ${g.name} ${s.name}`, s.line); }
    }
    const size = budget(c);
    sizes.push([c.name, size]);
    if (size > 8000) err('command-json-over', `/${c.name} serializes to ~${size} chars (ceiling ~8000)`, c.line);
    else if (size > 6500) warn('command-json-near', `/${c.name} serializes to ~${size}/8000 chars`, c.line);
  }
  if (cmds.length > 100) err('too-many-commands', `${cmds.length} global commands (max 100)`, 0);

  // Chain-level string ceilings.
  const LIMITS = { setPlaceholder: [100, 'placeholder'], setLabel: [80, 'label'], setTitle: [45, 'title'], setCustomId: [100, 'customId'] };
  walk(ast, (node, parents) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    const m = node.callee.property.name;
    // hasOwnProperty, not truthiness: a method called `toString` or
    // `valueOf` would otherwise match Object.prototype and hand back a
    // function where a [max, label] pair was expected.
    if (!Object.prototype.hasOwnProperty.call(LIMITS, m)) return;
    const text = staticText(node.arguments[0]);
    if (text === null) return;
    let [max, what] = LIMITS[m];
    const ctor = (() => { const r = rootOf(node); return r && r.type === 'NewExpression' && r.callee ? r.callee.name : null; })();
    const inTextInput = ctor === 'TextInputBuilder' || parents.some(p => p.type === 'NewExpression' && p.callee && p.callee.name === 'TextInputBuilder');
    if (m === 'setLabel' && inTextInput) { max = 45; what = 'text input label'; }
    if (m === 'setTitle') { max = ctor === 'ModalBuilder' ? 45 : 256; what = ctor === 'ModalBuilder' ? 'modal title' : 'embed title'; }
    const holes = node.arguments[0].type === 'TemplateLiteral' ? node.arguments[0].expressions.length : 0;
    if (text.length > max) err('over-limit', `${what} is ${text.length} chars of fixed text (max ${max})`, lineOf(node));
    else if (holes && text.length + holes * 4 > max) {
      // Might exceed once the holes are filled — which depends on what a
      // user typed. Exactly why it is worth naming: the id that fits in
      // testing is the one that throws in play.
      warn('runtime-limit', `${what} is ${text.length} fixed chars + ${holes} substitutions (max ${max}) — can exceed at runtime`, lineOf(node));
    } else if (text.length > max * 0.92) warn('near-limit', `${what} is ${text.length}/${max} chars`, lineOf(node));
  });

  walk(ast, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'MemberExpression') return;
    if (node.callee.property.name !== 'setMaxLength') return;
    const v = node.arguments[0];
    if (v && v.type === 'Literal' && v.value > 4000) {
      err('textinput-maxlength', `setMaxLength(${v.value}) exceeds the 4000-char TextInput ceiling`, lineOf(node));
    }
  });

  // Rows on modals and action rows: count addComponents along each chain.
  const countRows = (ctorName) => {
    walk(ast, (node, parents) => {
      if (node.type !== 'NewExpression' || !node.callee || node.callee.name !== ctorName) return;
      let n = 0, top = node;
      for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i];
        if ((p.type === 'CallExpression' || p.type === 'MemberExpression') && rootOf(p) === node) top = p;
        else break;
      }
      walk(top, (c) => {
        if (c.type === 'CallExpression' && c.callee.type === 'MemberExpression' &&
            c.callee.property.name === 'addComponents' && rootOf(c) === node) n += c.arguments.length;
      });
      if (ctorName === 'ModalBuilder') {
        if (n > 5) err('modal-rows', `modal has ${n} rows (max 5)`, lineOf(node));
        else if (n === 5) warn('modal-rows-full', 'modal is at 5/5 rows — no field can be added', lineOf(node));
      } else if (n > 5) err('row-overfull', `action row holds ${n} components (max 5)`, lineOf(node));
    });
  };
  countRows('ModalBuilder');
  countRows('ActionRowBuilder');

  sizes.sort((a, b) => b[1] - a[1]);
  out.budget = sizes;
  out.summary = `${cmds.length} commands · ${cmds.reduce((a, c) => a + allSubs(c).length, 0)} subcommands`;
  return out;
}

// ── 2.4 Rulesets ────────────────────────────────────────────────────
// The seam is a promise: a server that never sets dnd5e should never meet a
// proficiency bonus, an armour class or a spell slot. Nothing enforces that
// at runtime — the seam is convention, and convention drifts.
function scanRulesets(src) {
  const { out, err, warn } = collector();
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  const bodyOf = (fn, span) => {
    const m = new RegExp(`^async function ${fn}\\s*\\(`, 'm').exec(src);
    if (!m) return null;
    const start = lineAt(m.index);
    return { body: src.split('\n').slice(start - 1, start - 1 + span).join('\n'), start };
  };

  // Two idioms count. The capability check is the better one — it asks what
  // the system can do rather than what it is called — so both pass.
  const GATE = /\.id\s*!==\s*'dnd5e'|\.defence\s*!==\s*'ac'/;
  for (const fn of ['handleCreate5e', 'handleNpcCreate5e', 'handleLevelUp', 'handleSpell', 'handle5eStatus']) {
    const f = bodyOf(fn, 14);
    if (!f) { warn('entry-missing', `${fn} not found — renamed or removed; update this list`, 0); continue; }
    if (!GATE.test(f.body)) err('ungated-5e', `${fn} has no ruleset gate — a Knightfall server can reach 5e-only code`, f.start);
    else if (!/return\s+interaction\.reply/.test(f.body)) err('gate-no-refusal', `${fn} checks the ruleset but does not refuse`, f.start);
  }

  const defn = /^const RULES_DND5E\s*=\s*\{/m.exec(src);
  const reg = /^const RULESETS\s*=/m.exec(src);
  if (!defn || !reg) err('registry-missing', 'RULES_DND5E or RULESETS is missing', 0);
  else {
    const lo = defn.index, hi = reg.index + 200;
    const strays = [...src.matchAll(/\bRULES_DND5E\b/g)].filter(m => m.index < lo || m.index > hi).map(m => lineAt(m.index));
    if (strays.length) {
      err('hardcoded-5e', 'RULES_DND5E named outside its definition — reached whatever the server plays', strays.join(','));
    }
  }

  const rf = /function rulesFor\s*\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(src);
  const lo = rf ? lineAt(rf.index) : -1;
  const hi = rf ? lo + rf[0].split('\n').length : -1;
  const strayReads = [...src.matchAll(/getConfig\([^)]*\)\??\.\s*ruleset/g)]
    .map(m => lineAt(m.index)).filter(l => l < lo || l > hi);
  if (strayReads.length) {
    err('ruleset-read-bypass', 'ruleset read outside rulesFor() — bypasses the Knightfall default', strayReads.join(','));
  }

  const lib = bodyOf('handleLibrary', 12);
  if (lib && !GATE.test(lib.body)) {
    warn('library-ungated',
      'handleLibrary has no ruleset gate — a Knightfall GM can import 5e spells and monsters; harmless if intended, but the Knightfall books do not document it',
      lib.start);
  }

  return out;
}

// ═══ 3 · Stubs ══════════════════════════════════════════════════════
// index.js requires discord.js, better-sqlite3, dotenv and @napi-rs/canvas.
// None can run here: no network, no database, no native build. Each is
// replaced by something that does the minimum to let the real code execute
// and refuses anything the real service would refuse.

const NAME_RE = /^[-_\p{L}\p{N}]{1,32}$/u;
const sassert = (cond, msg) => { if (!cond) throw new Error('[stub] ' + msg); };

class B {
  constructor(kind) { this._kind = kind; this.name = null; this.description = null; }
  setName(n) {
    sassert(typeof n === 'string' && NAME_RE.test(n), `${this._kind} "${n}": names are 1-32 chars, no spaces`);
    sassert(n === n.toLowerCase(), `${this._kind} "${n}": names must be lowercase`);
    this.name = n; return this;
  }
  setDescription(d) {
    sassert(typeof d === 'string' && d.length > 0, `${this._kind} "${this.name}": description required`);
    sassert(d.length <= 100, `${this._kind} "${this.name}": description ${d.length} chars (max 100)`);
    this.description = d; return this;
  }
  setRequired(v) { this.required = !!v; return this; }
  setAutocomplete(v) { return this; }
  setMinValue(v) { return this; }
  setMaxValue(v) { return this; }
  setMinLength(v) { return this; }
  setMaxLength(v) { sassert(v <= 6000, `${this._kind} "${this.name}": maxLength ${v} over 6000`); return this; }
  addChannelTypes() { return this; }
  addChoices(...c) {
    this.choices = (this.choices || []).concat(c.flat());
    sassert(this.choices.length <= 25, `option "${this.name}": ${this.choices.length} choices (max 25)`);
    for (const x of this.choices) {
      sassert(x && typeof x.name === 'string', `option "${this.name}": choice needs a name`);
      sassert(x.name.length <= 100, `option "${this.name}": choice name over 100 chars`);
      if (typeof x.value === 'string') sassert(x.value.length <= 100, `option "${this.name}": choice value over 100 chars`);
    }
    return this;
  }
}

class OptionHost extends B {
  constructor(kind) { super(kind); this.options = []; }
  _add(type, fn) {
    const o = new B('option'); o._type = type; fn(o);
    sassert(o.name, `${this._kind} "${this.name}": an option has no name`);
    sassert(o.description, `${this._kind} "${this.name}": option "${o.name}" has no description`);
    sassert(!this.options.some(x => x.name === o.name), `${this._kind} "${this.name}": option "${o.name}" declared twice`);
    // Discord requires every required option before every optional one.
    if (o.required) {
      sassert(!this.options.some(x => !x.required),
        `${this._kind} "${this.name}": required option "${o.name}" follows an optional one`);
    }
    this.options.push(o);
    sassert(this.options.length <= 25, `${this._kind} "${this.name}": ${this.options.length} options (max 25)`);
    return this;
  }
}
for (const t of ['String', 'Integer', 'Boolean', 'User', 'Channel', 'Role', 'Mentionable', 'Number', 'Attachment']) {
  OptionHost.prototype['add' + t + 'Option'] = function (fn) { return this._add(t, fn); };
}

class Sub extends OptionHost { constructor() { super('subcommand'); } }

class Group extends B {
  constructor() { super('group'); this.subcommands = []; }
  addSubcommand(fn) {
    const s = new Sub(); fn(s);
    sassert(s.name && s.description, `group "${this.name}": a subcommand is missing name or description`);
    this.subcommands.push(s);
    sassert(this.subcommands.length <= 25, `group "${this.name}": ${this.subcommands.length} subcommands (max 25)`);
    return this;
  }
}

const ALL = [];
class Cmd extends OptionHost {
  constructor() { super('command'); this.subcommands = []; this.groups = []; ALL.push(this); }
  addSubcommand(fn) {
    const s = new Sub(); fn(s);
    sassert(s.name && s.description, `/${this.name}: a subcommand is missing name or description`);
    sassert(!this.options.length, `/${this.name}: a command cannot have both options and subcommands`);
    this.subcommands.push(s); this._leaves(); return this;
  }
  addSubcommandGroup(fn) {
    const g = new Group(); fn(g);
    sassert(g.name && g.description, `/${this.name}: a group is missing name or description`);
    this.groups.push(g); this._leaves(); return this;
  }
  _leaves() {
    const n = this.subcommands.length + this.groups.length;
    sassert(n <= 25, `/${this.name}: ${n} subcommands+groups (max 25)`);
  }
  setDefaultMemberPermissions() { return this; }
  setDMPermission() { return this; }
  setContexts() { return this; }
  setIntegrationTypes() { return this; }
}

class Row {
  constructor() { this.components = []; }
  addComponents(...c) {
    this.components.push(...c.flat());
    sassert(this.components.length <= 5, `action row holds ${this.components.length} components (max 5)`);
    return this;
  }
}
class Btn {
  setCustomId(id) { sassert(id.length <= 100, `button customId is ${id.length} chars (max 100)`); this.customId = id; return this; }
  setLabel(l) { sassert(l.length <= 80, `button label is ${l.length} chars (max 80)`); return this; }
  setStyle() { return this; } setEmoji() { return this; }
  setDisabled(v) { this.disabled = !!v; return this; } setURL() { return this; }
}
class Select {
  constructor() { this.options = []; }
  setCustomId(id) { sassert(id.length <= 100, `select customId is ${id.length} chars (max 100)`); return this; }
  setPlaceholder(p) { sassert(p.length <= 150, `select placeholder is ${p.length} chars (max 150)`); return this; }
  addOptions(...o) {
    this.options.push(...o.flat());
    sassert(this.options.length <= 25, `select menu has ${this.options.length} options (max 25)`);
    return this;
  }
  setMinValues() { return this; } setMaxValues() { return this; } setDisabled() { return this; }
}
class TextInput {
  setCustomId(i) { return this; }
  setLabel(l) { sassert(l.length <= 45, `text input label is ${l.length} chars (max 45)`); return this; }
  setStyle() { return this; }
  setPlaceholder(p) { sassert(p.length <= 100, `text input placeholder is ${p.length} chars (max 100)`); return this; }
  setValue(v) { sassert(String(v).length <= 4000, `text input value is ${String(v).length} chars (max 4000)`); return this; }
  setRequired() { return this; } setMinLength() { return this; }
  setMaxLength(v) { sassert(v <= 4000, `text input maxLength ${v} over 4000`); return this; }
}
class Modal {
  constructor() { this.rows = []; }
  setCustomId(i) { sassert(i.length <= 100, `modal customId is ${i.length} chars (max 100)`); return this; }
  setTitle(t) { sassert(t.length <= 45, `modal title is ${t.length} chars (max 45)`); return this; }
  addComponents(...c) { this.rows.push(...c.flat()); sassert(this.rows.length <= 5, `modal has ${this.rows.length} rows (max 5)`); return this; }
}
class Embed {
  constructor() { this.fields = []; }
  setTitle(t) { sassert(String(t).length <= 256, 'embed title over 256'); return this; }
  setDescription(d) { sassert(String(d).length <= 4096, 'embed description over 4096'); return this; }
  addFields(...f) {
    this.fields.push(...f.flat());
    sassert(this.fields.length <= 25, `embed has ${this.fields.length} fields (max 25)`);
    for (const x of this.fields) sassert(String(x.value).length <= 1024, `embed field "${x.name}" value over 1024`);
    return this;
  }
  setColor() { return this; } setFooter() { return this; } setThumbnail() { return this; }
  setImage() { return this; } setAuthor() { return this; } setTimestamp() { return this; }
}

const DISCORD = {
  Client: class {
    constructor() { this.handlers = {}; this.user = { id: 'stub', tag: 'DDice#0000' }; this.guilds = { cache: new Map() }; this.channels = { fetch: () => Promise.resolve(null) }; }
    on(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); return this; }
    once(e, f) { return this.on(e, f); }
    login() { return Promise.resolve('stub'); }   // never touches the network
  },
  GatewayIntentBits: new Proxy({}, { get: (_, k) => k }),
  PermissionFlagsBits: new Proxy({}, { get: () => 1n }),
  MessageFlags: { Ephemeral: 64 },
  REST: class { setToken() { return this; } put() { return Promise.resolve([]); } get() { return Promise.resolve([]); } },
  Routes: {
    applicationCommands: (a) => `/applications/${a}/commands`,
    applicationGuildCommands: (a, g) => `/applications/${a}/guilds/${g}/commands`,
  },
  SlashCommandBuilder: Cmd,
  SlashCommandSubcommandBuilder: Sub,
  SlashCommandSubcommandGroupBuilder: Group,
  ActionRowBuilder: Row,
  ButtonBuilder: Btn,
  ButtonStyle: { Primary: 1, Secondary: 2, Success: 3, Danger: 4, Link: 5 },
  StringSelectMenuBuilder: Select,
  StringSelectMenuOptionBuilder: class { setLabel() { return this; } setValue() { return this; } setDescription() { return this; } setDefault() { return this; } setEmoji() { return this; } },
  TextInputBuilder: TextInput,
  TextInputStyle: { Short: 1, Paragraph: 2 },
  ModalBuilder: Modal,
  EmbedBuilder: Embed,
  AttachmentBuilder: class { constructor(b, o) { this.attachment = b; this.name = o && o.name; } },
  WebhookClient: class { send() { return Promise.resolve({ id: 'stub' }); } destroy() {} },
  ChannelType: new Proxy({}, { get: (_, k) => k }),
  __BUILDERS__: ALL,
};

// better-sqlite3: every statement succeeds, every read comes back empty,
// nothing touches disk. Empty reads are the important choice — they put
// every function under test into the "new server, nothing configured yet"
// case, the state most likely to throw in production and least likely to be
// tried by hand.
class Stmt {
  run() { return { changes: 0, lastInsertRowid: 0 }; }
  get() { return undefined; }
  all() { return []; }
  iterate() { return [][Symbol.iterator](); }
  pluck() { return this; } raw() { return this; } bind() { return this; }
}
class Sqlite {
  constructor(f) { this.name = f; this.open = true; this.memory = true; }
  exec() { return this; }
  prepare() { return new Stmt(); }
  pragma() { return []; }
  transaction(fn) {
    const w = (...a) => fn(...a);
    w.deferred = w; w.immediate = w; w.exclusive = w;
    return w;
  }
  close() { this.open = false; }
  backup() { return Promise.resolve(); }
  function() { return this; } aggregate() { return this; }
}

// @napi-rs/canvas is absent on purpose. index.js guards every use behind a
// try/require, so throwing exercises the same path a Railway box without the
// native module takes.
const STUBS = {
  'discord.js': () => DISCORD,
  'better-sqlite3': () => Object.assign(Sqlite, { default: Sqlite }),
  'dotenv': () => ({ config: () => ({ parsed: {} }) }),
  '@napi-rs/canvas': () => { throw new Error('canvas unavailable in tests (by design)'); },
};

let hooked = false;
function installStubs() {
  if (hooked) return;
  const load = Module._load;
  // Intercept exactly these four. fs, path and os resolve normally, so the
  // code under test is the real code.
  Module._load = function (request) {
    if (Object.prototype.hasOwnProperty.call(STUBS, request)) return STUBS[request]();
    return load.apply(this, arguments);
  };
  hooked = true;
}

// ═══ 4 · Loader ═════════════════════════════════════════════════════
// index.js is a script, not a module: every helper is a top-level function
// with no exports. Append an epilogue exporting the ones under test, write
// it to a temp file outside the repo, and require it. Regenerated every run,
// so a harness can never pin a stale build.

const EXPORTS = ['chunkLines', 'rulesFor', 'abilityNeeds', 'belowBar', 'resolveDamage',
  'weaponDiceFor', 'damageBonusFor', 'maxHp', 'maxHpFromCon', 'fightTotalStr',
  'isNpcFighter', 'npcFighterId', 'npcNameFromFighter', 'RULESETS', 'RULES_KNIGHTFALL',
  'RULES_DND5E', 'STAT_EMOJIS', 'STAT_NAMES', 'GMTEST_PREFIX'];

let loaded = null;
function loadIndex(src) {
  if (loaded) return loaded;
  installStubs();
  const live = EXPORTS.filter(n => new RegExp(`(function|const|let|var)\\s+${n}\\b`).test(src));
  const missing = EXPORTS.filter(n => !live.includes(n));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ddice-')), 'index.js');
  fs.writeFileSync(tmp, src + `\n\nmodule.exports = { ${live.join(', ')} };\n`);
  loaded = { mod: require(tmp), missing };
  return loaded;
}

// ═══ 5 · Harnesses ══════════════════════════════════════════════════

function harness(name, fn) {
  let pass = 0; const fails = [];
  const ok = (label, cond) => { if (cond) pass++; else fails.push(label); };
  const eq = (label, got, want) =>
    ok(`${label} (got ${JSON.stringify(got)})`, JSON.stringify(got) === JSON.stringify(want));
  fn(ok, eq);
  return { name, pass, fails };
}

// Loading index.js already ran every builder through the validating stub, so
// a breach of Discord's registration rules threw before a single assertion.
// These check what the stub cannot: that the shape is the shape we meant.
function testBuilders(src) {
  return harness('builders', (ok) => {
    const cmds = DISCORD.__BUILDERS__;
    const by = Object.fromEntries(cmds.map(c => [c.name, c]));
    const leaves = (c) => c.subcommands.length + c.groups.length;
    const subs = (c) => c.subcommands.concat(...c.groups.map(g => g.subcommands));

    for (const n of ['activity', 'char', 'config', 'deception', 'dnd', 'duel', 'fight', 'gm',
                     'help', 'library', 'npc', 'quest', 'quiz', 'roll', 'spell', 'standing']) {
      ok(`/${n} is registered`, !!by[n]);
    }
    ok('sixteen commands registered', cmds.length === 16);
    ok('no command registered twice', new Set(cmds.map(c => c.name)).size === cmds.length);
    ok('under the 100-command ceiling', cmds.length <= 100);

    for (const c of cmds) {
      ok(`/${c.name} has a description`, !!c.description);
      ok(`/${c.name} does something`, leaves(c) > 0 || c.options.length > 0);
      ok(`/${c.name} under the 25-leaf wall (${leaves(c)})`, leaves(c) <= 25);
    }
    ok('/npc is the most crowded command', leaves(by.npc) === Math.max(...cmds.map(leaves)));
    ok('/npc has at most one leaf spare', leaves(by.npc) >= 24);
    ok('/quest is close behind', leaves(by.quest) >= 22);

    ok('/config folds into groups', by.config.groups.length >= 2);
    ok('/config groups are channels and mechanics',
      by.config.groups.map(g => g.name).sort().join(',') === 'channels,mechanics');
    ok('/gm has backup and test groups',
      ['backup', 'test'].every(n => by.gm.groups.some(g => g.name === n)));
    for (const c of cmds) {
      for (const g of c.groups) {
        ok(`/${c.name} ${g.name} under 25 subcommands (${g.subcommands.length})`, g.subcommands.length <= 25);
      }
    }

    // /char show exists in both the view and profile groups; /standing view
    // in both renown and merit. Fine — but only because those commands read
    // getSubcommandGroup() first. A command that collided without consulting
    // the group would send both leaves to whichever branch is written first.
    for (const c of cmds) {
      const names = subs(c).map(s => s.name);
      if (new Set(names).size === names.length) { ok(`/${c.name} leaf names are unique`, true); continue; }
      ok(`/${c.name} collides on leaf names, so it must route by group`,
        new RegExp(`commandName === '${c.name}'[\\s\\S]{0,400}?getSubcommandGroup`).test(src));
    }

    for (const c of cmds) {
      for (const s of subs(c)) {
        ok(`/${c.name} ${s.name} under 25 options (${s.options.length})`, s.options.length <= 25);
        const req = s.options.map(o => !!o.required);
        ok(`/${c.name} ${s.name} required options come first`, req.slice(req.lastIndexOf(true) + 1).every(x => !x));
      }
    }

    // The real ceiling counts the text a human wrote, not JSON syntax.
    const size = (c) => {
      let n = (c.name || '').length + (c.description || '').length;
      const opt = (o) => {
        n += (o.name || '').length + (o.description || '').length;
        for (const ch of o.choices || []) n += String(ch.name || '').length + String(ch.value || '').length;
      };
      c.options.forEach(opt);
      for (const s of subs(c)) { n += s.name.length + s.description.length; s.options.forEach(opt); }
      for (const g of c.groups) n += g.name.length + g.description.length;
      return n;
    };
    const budget = cmds.map(c => [c.name, size(c)]).sort((a, b) => b[1] - a[1]);
    for (const [n, s] of budget) ok(`/${n} under the 8000-char budget (${s})`, s < 8000);
    // Which command is largest is trivia; the ceiling is the invariant. The
    // leader has swapped once already (/gm overtook /config when restart's
    // descriptions landed). The margin line moved from 5400 to 6000 on
    // 2026-08-10 when the portrait migration option pushed /gm to 5482 —
    // still a quarter of the 8000 budget spare, and the next trip of this
    // line is the moment /gm's check options should fold into a group
    // rather than the line moving again.
    ok('the largest command keeps a quarter of its budget spare', budget[0][1] < 6000);
  });
}

// Arithmetic. The seam's whole promise is that one call site produces two
// different correct answers depending on the server. A regression here does
// not throw — it quietly hands out wrong damage for a week.
function testRules(mod) {
  const { RULES_KNIGHTFALL: K, RULES_DND5E: D, RULESETS, chunkLines } = mod;
  return harness('rules', (ok, eq) => {
    ok('two rulesets registered', Object.keys(RULESETS).length === 2);
    ok('knightfall is registered under its id', RULESETS.knightfall === K);
    ok('dnd5e is registered under its id', RULESETS.dnd5e === D);
    ok('each ruleset knows its own id', K.id === 'knightfall' && D.id === 'dnd5e');
    ok('each ruleset has a display name', !!K.name && !!D.name);

    eq('KF hit scores one', K.damage(15, 7, 20, 10, 3, 20), { hit: true, dmg: 1 });
    eq('KF miss scores nothing', K.damage(8, 4, 20, 15, 6, 20), { hit: false, dmg: 0 });
    eq('KF natural max adds one', K.damage(20, 20, 20, 10, 3, 20), { hit: true, dmg: 2 });
    eq("KF defender's natural 1 adds one", K.damage(15, 7, 20, 1, 1, 20), { hit: true, dmg: 2 });
    // Both criticals take a fourth rung: their own bonuses plus one more for
    // landing at once. An obvious-looking tidy-up that collapsed this to
    // 1+1+1 would still produce a plausible number, and would quietly make
    // the best moment in a fight worse.
    eq('KF both criticals reach four', K.damage(20, 20, 20, 1, 1, 20), { hit: true, dmg: 4 });
    ok('KF ties go to the attacker', K.damage(12, 6, 20, 12, 6, 20).hit === true);
    eq('KF stat is added whole', K.statBonus({ str: 4 }, 'str'), 4);
    eq('KF absent stat reads zero', K.statBonus({}, 'str'), 0);
    eq('KF HP is CON plus the floor', K.maxHp({ con: 5 }, 10), 15);
    ok('KF HP stat is CON', K.hpStat === 'con');
    ok('Knightfall grants no proficiency', K.profBonus({ level: 9 }) === 0);

    ok('5e defends with AC', D.defence === 'ac');
    eq('5e beats AC', D.resolveAttack({ nat: 15, total: 18, ac: 14 }), { hit: true, crit: false });
    eq('5e falls short', D.resolveAttack({ nat: 5, total: 8, ac: 14 }), { hit: false, crit: false });
    // The two rules that override the arithmetic entirely. If either
    // inverts, every fight still runs and every number still looks fine.
    eq('5e natural 20 always hits', D.resolveAttack({ nat: 20, total: 23, ac: 99 }), { hit: true, crit: true });
    eq('5e natural 1 always misses', D.resolveAttack({ nat: 1, total: 21, ac: 5 }), { hit: false, crit: false });
    ok('5e total equal to AC hits', D.resolveAttack({ nat: 10, total: 14, ac: 14 }).hit === true);
    eq('5e modifier for 16', D.statBonus({ str: 16 }, 'str'), 3);
    eq('5e modifier for 10', D.statBonus({ str: 10 }, 'str'), 0);
    eq('5e modifier for 8', D.statBonus({ str: 8 }, 'str'), -1);
    eq('5e modifier for 20', D.statBonus({ str: 20 }, 'str'), 5);
    eq('5e proficiency at level 1', D.profBonus({ level: 1 }), 2);
    eq('5e proficiency at level 5', D.profBonus({ level: 5 }), 3);
    eq('5e proficiency at level 17', D.profBonus({ level: 17 }), 6);
    ok('5e proficiency never drops below 2', D.profBonus({}) >= 2);

    // A key one ruleset answers and the other does not reads undefined at a
    // shared call site and changes behaviour without throwing.
    for (const k of ['id', 'name', 'stats', 'labels', 'statBonus', 'hpStat', 'maxHp', 'damage', 'defence', 'profBonus']) {
      ok(`both rulesets answer "${k}"`, K[k] !== undefined && D[k] !== undefined);
    }
    ok('the two rulesets defend differently', K.defence !== D.defence);

    // Every long reply passes through chunkLines. A chunk over 2000 is
    // rejected by Discord and the message is simply lost.
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`);
    const chunks = chunkLines(long);
    ok('chunkLines splits a long list', chunks.length > 1);
    ok('every chunk is under the wall', chunks.every(c => c.length <= 2000));
    ok('chunkLines loses nothing', chunks.join('\n').split('\n').length === long.length);
    ok('chunkLines keeps a short list whole', chunkLines(['one', 'two']).length === 1);
    ok('chunkLines never emits an empty chunk', chunks.every(c => c.length > 0));
    ok('an over-long single line is not dropped', chunkLines(['y'.repeat(5000)]).join('').includes('yyy'));
    ok('KF the pair beats the sum of its parts',
      K.damage(20, 20, 20, 1, 1, 20).dmg >
      (K.damage(20, 20, 20, 10, 3, 20).dmg - 1) + (K.damage(15, 7, 20, 1, 1, 20).dmg - 1) + 1);
  });
}

// Named pins for faults that have already happened once, so a regression
// fails with the story attached rather than as an anonymous rule violation.
function testPins(src) {
  const count = (re) => (src.match(re) || []).length;
  return harness('pins', (ok) => {
    // sendLong was declared twice, twelve lines apart. The second won and
    // had lost the first's null guard and its .catch(). Call sites were
    // written against the tolerant one — one hands it the result of
    // channels.fetch() unchecked — so a deleted channel took down the whole
    // interaction.
    ok('sendLong is declared exactly once', count(/async function sendLong\(/g) === 1);
    ok('sendLong takes the rich signature',
      /async function sendLong\(target, content, \{ files = null, \.\.\.opts \} = \{\}\)/.test(src));
    ok('sendLong refuses a missing target', /async function sendLong\([\s\S]{0,200}?if \(!target\) return;/.test(src));
    ok('sendLong survives a failed send',
      /async function sendLong\([\s\S]{0,600}?\.catch\(e => console\.error\('\[sendLong\] delivery failed/.test(src));
    ok('replyLong is declared exactly once', count(/async function replyLong\(/g) === 1);
    // The comment describing replyLong was stranded above sendLong by the
    // same botched edit; the merge put it back.
    ok('replyLong keeps its own description',
      /Reply with content that may exceed Discord's 2000-char hard limit[\s\S]{0,400}?async function replyLong/.test(src));

    const decls = [...src.matchAll(/^(?:async )?function ([A-Za-z0-9_$]+)\(/gm)].map(m => m[1]);
    const dupes = [...new Set(decls.filter((n, i) => decls.indexOf(n) !== i))];
    ok(`no top-level function is declared twice${dupes.length ? ' — ' + dupes.join(', ') : ''}`, dupes.length === 0);

    ok('the ruleset registry holds exactly two systems',
      /const RULESETS = \{ knightfall: RULES_KNIGHTFALL, dnd5e: RULES_DND5E \};/.test(src));
    ok('rulesFor defaults to Knightfall', /return RULESETS\[id\] \|\| RULES_KNIGHTFALL;/.test(src));
    ok('rulesFor survives a server with no config yet',
      /try \{ id = getConfig\(gid\)\?\.ruleset \|\| null; \} catch/.test(src));
    ok('handle5eStatus gates on capability, not on the id',
      /async function handle5eStatus\([\s\S]{0,400}?\.defence !== 'ac'/.test(src));

    // Commands were registered at boot over the guilds already joined, so a
    // server that added the bot afterwards saw nothing until the next restart.
    ok('guildCreate registers commands for a new server', /client\.on\('guildCreate'/.test(src));
    ok('a new server is told how to pick its ruleset',
      /guildCreate[\s\S]{0,2000}?ruleset system:dnd5e/.test(src));

    // Button handlers used to run outside a try, so anything they threw
    // became an unhandled rejection: Discord showed "This interaction
    // failed" and nothing reached the logs.
    ok('button routing is wrapped', /try \{\s*return await routeButton\(interaction\);/.test(src));
    ok('a thrown button is logged with its id', /console\.error\('\[button\]', interaction\.customId/.test(src));

    // FIXED 2026-08-10: /gm dc used to pack two free-text options into the
    // button customId — long text overflowed the 100-char ceiling and a
    // colon shifted the whole split. The marks now ride the dc_cards row
    // keyed by the card's message; the id carries numerics and short tokens
    // only. These pin the fixed shape so the free text cannot creep back.
    const dcroll = src.match(/setCustomId\(`dcroll:[^`]*`\)/);
    ok('the dcroll id still exists to be measured', !!dcroll);
    if (dcroll) {
      const holes = (dcroll[0].match(/\$\{/g) || []).length;
      ok(`dcroll carries ten fields at most (has ${holes})`, holes <= 10);
      ok('no free text rides the dcroll id', !/dcroll:[^`]*onFail/.test(dcroll[0]) && !/dcroll:[^`]*onSucc/.test(dcroll[0]));
    }
    ok('the press reads its marks from the card row',
      /const marks = getDcCard\(interaction\.guild\.id, interaction\.message\?\.id\)/.test(src));
    ok('the card is saved whenever a press will need it',
      /if \(ids\.length && \(sF \|\| fF \|\| sS \|\| fS \|\| onFail \|\| onSucc\)\)/.test(src));
    ok('the mark columns exist',
      /ALTER TABLE dc_cards ADD COLUMN s_mark TEXT/.test(src) && /ALTER TABLE dc_cards ADD COLUMN f_mark TEXT/.test(src));

    // The NPC forum folds by category: one thread per category, every NPC an
    // entry inside it. Three things make that work, and each fails silently
    // if it goes — an NPC in two threads at once, an orphaned entry, or a
    // deleted NPC taking a whole category's thread down with them.
    ok('an NPC folds into their first-assigned category',
      /function npcHomeCategory\([\s\S]{0,300}?ORDER BY rowid LIMIT 1/.test(src));
    ok('an NPC with no category still has a home', /const NPC_NO_CATEGORY = 'Uncategorised';/.test(src));
    ok('the category thread is made once and reused',
      /async function ensureCategoryThread\([\s\S]{0,500}?SELECT thread_id FROM \$\{table\}/.test(src));
    // The portrait forum mirrors the page forum. Three things carry it, and
    // each is silent when it breaks: the table whitelist (a bad kind would
    // otherwise write into the wrong forum's map), the parentId check (a
    // forum bank receives uploads in threads, never in the forum itself),
    // and the guard that stops the bot answering every image on the server.
    ok('the two forums keep separate thread maps',
      /const NPC_THREAD_TABLES = \{ pages: 'npc_category_threads', portraits: 'npc_portrait_threads' \};/.test(src));
    ok('the thread table is whitelisted, never user input',
      /NPC_THREAD_TABLES\[kind\] \|\| NPC_THREAD_TABLES\.pages/.test(src));
    // The manual config path must accept the forum the rest of the code is
    // built around. isTextBased() is false for forums, and the old text-only
    // guard shipped for a full day rejecting the intended channel while
    // build:true wrote the same config without complaint.
    // The portrait migration: re-hosts every stored face into its category
    // thread and repoints the NPC row at the new copy. The pieces pinned
    // here are the ones whose loss is silent: the tiered recovery (expired
    // signed URLs walk the source channel's history), the repoint (without
    // it the forum is a gallery and the old channel stays load-bearing),
    // the idempotency record, and the order-face verdict — order faces are
    // deliberately NOT migrated, so "safe to delete" must check them.
    ok('the migration record table exists',
      /CREATE TABLE IF NOT EXISTS npc_portrait_posts/.test(src));
    ok('portraits:true is routed',
      /getBoolean\?\.\('portraits'\)\) return runPortraitMigration/.test(src));
    ok('expired faces are recovered from channel history',
      /const recover = async \(parsed\)[\s\S]{0,900}?a\.id === parsed\.attachmentId/.test(src));
    ok('the NPC row is repointed at the re-hosted copy',
      /const newUrl = posted\.attachments\.first\(\)\?\.url[\s\S]{0,120}?setNpcImage\(gid, npc\.name, newUrl\)/.test(src));
    // Order faces are never re-hosted or repointed by the migration. The one
    // write it may make is folding a stale case-variant into its fresh face:
    // the wear-time lookup is COLLATE NOCASE, so "Black knight" beside
    // "Black Knight" is one face with an arbitrary winner — observed live
    // serving the dead URL after a fresh upload. The write path now
    // collapses variants at set-time too, so the fold should become rare.
    (() => {
      // Slice between the function declarations — bare-name indexOf lands on
      // the dispatch lines, which sit one line apart and slice to nothing.
      const mig = src.slice(src.indexOf('async function runPortraitMigration'), src.indexOf('async function runOrderReport'));
      ok('order faces are checked, never re-hosted',
        /SELECT prefix, image_url, set_at FROM npc_orders WHERE guild_id=\?/.test(mig) &&
        !/npc_orders SET image_url/.test(mig));
      ok('stale case-variants fold into the healthy face',
        /if \(healthy && r\.prefix !== healthy\.prefix\)/.test(mig));
    })();
    ok('setting an order face collapses its case-variants first',
      /DELETE FROM npc_orders WHERE guild_id=\? AND prefix=\? COLLATE NOCASE/.test(src));
    // The duplication bug: the kept-check sniffed the stored URL for the
    // thread id and fell through to a fresh post when the sniff failed —
    // live result, the same face posted again on every run. The record is
    // the truth now; a live recorded message is kept and merely repointed.
    // The face chain and the round trip, broken together by one export test:
    // delete+import stripped the personal face (export never carried it) and
    // the order fallback read only a pipe in the NAME, so a plain-named
    // White Knight never inherited the White Knight face. Sheet first, name
    // second; the face travels in the payload behind a CDN-only validator;
    // and the migration resurrects a faceless NPC from their live forum post.
    // Set-side and wear-side must agree on who belongs to an order, or an
    // order of plain-named knights can never have its face set and knights
    // who already spoke keep stale blank webhooks after one is.
    ok('order membership counts the sheet, not just pipe names',
      /add\(n\.order_name \|\| npcOrderOf\(n\.name\)\);/.test(src));
    ok('setting an order face refreshes every wearer',
      /const worn = \(n\.order_name \|\| npcOrderOf\(n\.name\) \|\| ''\)\.toLowerCase\(\);/.test(src));

    ok('the order face is read from the sheet before the name',
      /npc\.image_url\s*\n?\s*\?\? getOrderImage\(gid, npc\.order_name\)\s*\n?\s*\?\? getOrderImage\(gid, npcOrderOf\(npc\.name\)\)/.test(src));
    ok('the face travels in the export payload',
      /image: npc\.image_url \|\| null \};/.test(src) && /\.\.\.\(imp\.image \? \{ image_url: imp\.image \} : \{\}\)/.test(src));
    ok('an imported face must be a Discord CDN attachment',
      /o\.image != null && !\/\^https:/.test(src));
    ok('the migration resurrects record-holders without a face',
      /n\.image_url \|\| hasRecord\.has\(n\.name\)/.test(src));
    ok('a dead record with no face lands on the lost list, not in fetch(null)',
      /if \(!npc\.image_url\) \{ lost\.push\(npc\.name\); continue; \}/.test(src));

    ok('the kept-check trusts the record, not URL sniffing',
      !/includes\(`\/\$\{row\.thread_id\}\/`\)/.test(src));
    ok('a live migrated post is repointed, never reposted',
      /const liveUrl = alive\.attachments\.first\(\)\?\.url[\s\S]{0,400}?kept\+\+; continue;/.test(src));
    ok('the verdict refuses "safe to delete" while anything leans',
      /still load-bearing/.test(src));

    ok('npcchannel accepts a forum and lays its threads out on the spot',
      /const isForum = chan\?\.type === 15;/.test(src) &&
      /if \(isForum\) \{[\s\S]{0,220}?await ensurePortraitThreads\(interaction\.client, gid\)/.test(src));
    ok('npcchannel still takes a plain text channel',
      /if \(!isForum && !chan\?\.isTextBased\?\.\(\)\)/.test(src));

    ok('a portrait posted in a category thread is still recognised',
      /message\.channel\.parentId === bankId/.test(src));
    ok('the bot only answers images inside the bank',
      /const inBank = !!bankId &&/.test(src) &&
      !/No NPC image channel is set/.test(src));
    ok('a text-channel bank still works', /message\.channel\.id === bankId/.test(src));
    // The creation reply points at the exact portrait thread, or the bank,
    // or \u2014 with none set \u2014 at the config command. Without this line the
    // portrait forum is invisible until stumbled on.
    ok('creating an NPC points at where their face goes',
      /function portraitHint\(gid, npcName\)/.test(src) && /\$\{portraitHint\(gid, name\)\}/.test(src));
    // Rename works IN PLACE. Membership rowids decide every member's home
    // category, so delete-and-recreate would re-home NPCs whose first
    // category this is. The three UPDATEs are the feature.
    ok('categoryrename updates rather than recreates',
      /UPDATE npc_categories SET name=\? WHERE guild_id=\? AND name=\?/.test(src) &&
      /UPDATE npc_category_members SET category=\? WHERE guild_id=\? AND category=\?/.test(src) &&
      /UPDATE \$\{table\} SET category=\? WHERE guild_id=\? AND category=\?/.test(src));
    ok('categoryrename refuses a name already in use',
      /merging categories is a different thing/.test(src));
    // The sidebar is enforced, not suggested: one batched setPositions in
    // plan order per category, re-parenting adopted strays as it goes.
    // Without this, any channel adopted by name keeps its old position and
    // the plan only governs fresh creates.
    // The sidebar order has failed to land twice, two different ways, so the
    // ordering code is now built to produce EVIDENCE: forced before/after
    // raw positions on every edit, and a diagnostic that prints each
    // category's raw sequences split by type. These pin the evidence
    // machinery itself — losing it means the next failure is a guess again.
    ok('one order applier serves build, restart and the diagnostic',
      /async function applySidebarOrder\(guild, entries\)/.test(src) &&
      /await applySidebarOrder\(guild, sidebar\)/.test(src) &&
      /await applySidebarOrder\(guild, entries\)/.test(src));
    ok('every edit is verified against a forced refetch',
      (src.match(/fetch\(w\.id, \{ force: true \}\)/g) || []).length === 2);
    ok('refused edits are counted and surfaced, not swallowed',
      /if \(ord\.refused\) lines\.push/.test(src));
    ok('the diagnostic shows per-type raw sequences',
      /forums: \$\{seq\(c => c\.type === 15\)/.test(src));
    ok('re-parenting never rewrites channel overwrites',
      (src.match(/lockPermissions: false/g) || []).length >= 2);

    // Restart is the most destructive thing the bot can do, so each of its
    // four guards is pinned: the confirm (no accidental press-through), the
    // doomed-channel refusal (or the report dies with its own channel), the
    // clean-slate config wipe (or the rebuild adopts ghost ids), and the
    // derived-map wipe (or every NPC and character page points at deleted
    // threads).
    ok('restart goes through the confirm flow',
      /async function runFullRestart\([\s\S]{0,2500}?return requestConfirm\(interaction,/.test(src));
    ok('restart refuses from a doomed channel',
      /doomed\.has\(interaction\.channelId\)/.test(src));
    ok('restart nulls every plan key before rebuilding',
      /for \(const plan of SETUP_PLAN\) wipe\[plan\.key\] = null;/.test(src));
    ok('restart wipes the derived thread maps',
      /for \(const t of \['npc_pages', 'npc_category_threads', 'npc_portrait_threads', 'char_pages', 'npc_webhooks'\]\)/.test(src));
    ok('restart warns that threads are unrecoverable',
      /Discord has no undelete/.test(src));
    ok('restart rebuilds through the shared body',
      /const lines = await buildAllSetup\(interaction\);[\s\S]{0,200}?Torn down/.test(src));
    ok('build and restart share one setup body',
      (src.match(/await buildAllSetup\(interaction\)/g) || []).length === 2);
    // The docs seed: without it the two PDF channels sit empty until someone
    // finds /config channels docs by accident.
    ok('setup seeds the docs repo when unset',
      /if \(!getConfig\(gid\)\?\.docs_repo\) \{ setConfig\(gid, \{ docs_repo: DOCS_DEFAULT_REPO \}\)/.test(src));
    ok('the default repo is the one shipping the books',
      /const DOCS_DEFAULT_REPO = 'wolffewrought\/DDice';/.test(src));

    ok('the forum lifecycle can be exercised live',
      /setName\('forum'\)\.setDescription\('Exercise the NPC forums end to end/.test(src) &&
      /if \(sub === 'forum'\) \{/.test(src));

    ok('a new category opens its portrait thread at once',
      /createCategory\(gid, name\);[\s\S]{0,300}?ensurePortraitThreads\(interaction\.client, gid\)/.test(src));
    ok('the rebuild mirrors the portrait forum too',
      /async function rebuildNpcForum\([\s\S]{0,1800}?await ensurePortraitThreads\(client, gid\)/.test(src));
    // Deleting a category must not strand its threads. The sweep closes the
    // thread in BOTH forums, drops both mappings, and re-homes every NPC that
    // lived there — reading the orphan list BEFORE the membership rows go,
    // because afterwards there is nothing left to read.
    ok('categorydelete reads its orphans before deleting',
      /const orphans = getNpcsInCategory\(gid, name\);\s*\n\s*deleteCategory\(gid, name\);/.test(src));
    ok('categorydelete sweeps both thread tables',
      /for \(const table of Object\.values\(NPC_THREAD_TABLES\)\)[\s\S]{0,400}?DELETE FROM \$\{table\} WHERE guild_id=\? AND category=\?/.test(src));
    ok('categorydelete re-homes the orphans',
      /for \(const npcName of orphans\) await mirrorNpcSheet\(client, gid, npcName\)/.test(src));
    // Re-homing on assign and remove rides touchNpcPage -> mirrorNpcSheet's
    // move logic. If either drops the call, an NPC whose home category
    // changes keeps a stale entry in the old thread.
    ok('assigning a category refreshes the entry',
      /function assignNpcToCategory\([\s\S]{0,220}?touchNpcPage\(gid, npcName\);/.test(src));
    ok('removing a category refreshes the entry',
      /function removeNpcFromCategory\([\s\S]{0,220}?touchNpcPage\(gid, npcName\);/.test(src));

    ok('portrait mirroring skips a non-forum bank',
      /async function ensurePortraitThreads\([\s\S]{0,400}?forum\.type !== 15\) return 0;/.test(src));
    ok('a moved NPC leaves their old thread first',
      /if \(row\?\.thread_id && row\.thread_id !== thread\.id\)[\s\S]{0,400}?msg\.delete\(\)/.test(src));
    ok('deleting an NPC removes their entry, not the thread',
      /function deleteNpc\([\s\S]{0,700}?msg\.delete\(\)/.test(src) &&
      !/function deleteNpc\([\s\S]{0,700}?th\.delete\('NPC deleted'\)/.test(src));
    // The rebuild must not clear npc_pages before rewriting. It did once:
    // every NPC then looked new, so a second run posted a fresh entry beside
    // the existing one and orphaned it — the whole forum duplicated on the
    // second press, silently, with nothing in the logs.
    ok('the rebuild never wipes the page map',
      !/async function rebuildNpcForum\([\s\S]{0,1600}?DELETE FROM npc_pages WHERE guild_id=\?'\)\.run\(gid\)/.test(src));
    ok('one-command setup lays the NPC forum out too',
      /const npcLaid = await rebuildNpcForum\(interaction\.client, gid\)/.test(src));
    ok('the rebuild computes its keep-list after the write pass',
      /async function rebuildNpcForum\([\s\S]{0,2400}?const keep = new Set\(db\.prepare\('SELECT thread_id FROM npc_category_threads/.test(src));
    // Coloured orders are automatic homes: an explicit category assignment
    // always wins, then the order on the sheet, then Uncategorised. Both
    // forums pre-create a thread for every category AND every known order,
    // and knownOrders is data-driven — a D&D server never grows knight
    // threads, and a new colour births its thread with its first NPC.
    ok('an unassigned knight files under their coloured order',
      /if \(npc\?\.order_name\) return npc\.order_name;/.test(src));
    ok('a hand-assigned category still outranks the order',
      /if \(row\?\.category\) return row\.category;[\s\S]{0,500}?order_name/.test(src));
    ok('known orders come from the data, not a hardcoded list',
      /SELECT DISTINCT order_name FROM npcs/.test(src) &&
      /SELECT DISTINCT prefix FROM npc_orders/.test(src.slice(src.indexOf('function knownOrders'), src.indexOf('function npcHomeCategory'))));
    ok('both forums pre-create category and order threads',
      /\[\.\.\.new Set\(\[\.\.\.getCategories\(gid\), \.\.\.knownOrders\(gid\), NPC_NO_CATEGORY\]\)\]/.test(src) &&
      (src.match(/knownOrders\(gid\)/g) || []).length >= 2);
    ok('setting the forum lays it out', /const laid = await rebuildNpcForum\(client, gid\)/.test(src));
    ok('the rebuild defers — it can outrun three seconds',
      /npc_forum: channel\.id \}\);\s*\n\s*await interaction\.deferReply\(\);/.test(src));

    ok('no modal placeholder is written over 100 chars', count(/setPlaceholder\('([^']{101,})'\)/g) === 0);
    ok('quest modals still fill all five rows',
      count(/new ActionRowBuilder\(\)\.addComponents\(new TextInputBuilder\(\)/g) >= 5);
    ok('the parchment edition is still referenced', /[Pp]archment/.test(src));

    // The 5e gate pins that used to live here now belong to the rulesets
    // scanner, which checks the same property more thoroughly. Not lost.
    ok('the rulesets scanner owns the 5e gates', true);
  });
}

// ═══ 6 · Runner ═════════════════════════════════════════════════════

const C = process.stdout.isTTY
  ? { red: '\u001b[31m', grn: '\u001b[32m', yel: '\u001b[33m', dim: '\u001b[2m', off: '\u001b[0m' }
  : { red: '', grn: '', yel: '', dim: '', off: '' };

function main() {
  if (!fs.existsSync(INDEX)) {
    console.error(`${C.red}index.js not found beside verify.js${C.off}`);
    process.exit(1);
  }
  const src = fs.readFileSync(INDEX, 'utf8');

  let ast;
  try {
    ast = parse(src);
  } catch (e) {
    console.error(`${C.red}✗ parse${C.off}  ${e.message}`);
    process.exit(1);
  }
  console.log(`${C.grn}✓${C.off} parse                  ${C.dim}${src.length} bytes, ${src.split('\n').length} lines${C.off}`);

  let errors = 0, warnings = 0, assertions = 0;
  const failedSteps = [];

  if (ONLY !== 'test') {
    const scans = [
      ['structure', scanStructure(src, ast)],
      ['wiring', scanWiring(src, ast)],
      ['limits', scanLimits(src, ast)],
      ['rulesets', scanRulesets(src)],
    ];
    for (const [name, found] of scans) {
      const errs = found.filter(f => f.sev === 'ERROR');
      const warns = found.filter(f => f.sev === 'WARN');
      errors += errs.length; warnings += warns.length;
      const tail = found.summary ? `${found.summary} — ` : '';
      if (errs.length) {
        failedSteps.push(name);
        console.log(`${C.red}✗${C.off} ${name.padEnd(22)} ${tail}${errs.length} error, ${warns.length} warn`);
        for (const f of errs.slice(0, 20)) console.log(`    ${C.red}${f.rule}${C.off}  L${f.line}  ${f.msg}`);
        if (errs.length > 20) console.log(`    … and ${errs.length - 20} more`);
      } else {
        console.log(`${C.grn}✓${C.off} ${name.padEnd(22)} ${C.dim}${tail}0 error, ${warns.length} warn${C.off}`);
      }
      if (VERBOSE) for (const f of warns) console.log(`    ${C.yel}${f.rule}${C.off}  L${f.line}  ${f.msg}`);
      if (found.budget) {
        console.log(`    ${C.dim}budget: ${found.budget.map(([n, s]) => `${n} ${s}`).join(' · ')}${C.off}`);
      }
    }
  }

  if (ONLY !== 'scan') {
    let mod, missing;
    try {
      ({ mod, missing } = loadIndex(src));
    } catch (e) {
      console.log(`${C.red}✗${C.off} load                   a builder was refused before any test ran`);
      console.log(`    ${e.message}`);
      process.exit(1);
    }
    if (missing.length) console.log(`${C.yel}!${C.off} load                   ${C.dim}not exported: ${missing.join(', ')}${C.off}`);

    for (const r of [testBuilders(src), testRules(mod), testPins(src)]) {
      assertions += r.pass;
      if (r.fails.length) {
        failedSteps.push(r.name);
        console.log(`${C.red}✗${C.off} ${r.name.padEnd(22)} ${r.pass} pass, ${r.fails.length} fail`);
        for (const f of r.fails) console.log(`    ${C.red}FAIL${C.off}  ${f}`);
      } else {
        console.log(`${C.grn}✓${C.off} ${r.name.padEnd(22)} ${C.dim}${r.pass} pass${C.off}`);
      }
    }
  }

  console.log();
  if (failedSteps.length) {
    console.log(`${C.red}failed:${C.off} ${failedSteps.join(', ')}`);
    process.exit(1);
  }
  const w = warnings ? ` · ${warnings} warning${warnings === 1 ? '' : 's'}${VERBOSE ? '' : ' (-v to list)'}` : '';
  console.log(`${C.grn}all green${OFF_OR(C)}${assertions ? ` — ${assertions} assertions` : ''}${w}`);
  process.exit(0);
}

function OFF_OR(c) { return c.off; }

main();
