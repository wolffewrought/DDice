#!/usr/bin/env node
// check.js — one command, and what changed since last time.
//
//   node check.js              run verify + probe, compare to the baseline
//   node check.js --save       accept the current state as the new baseline
//   node check.js --verify     verify only (faster)
//
// verify.js and probe.js each report an absolute state: so many assertions,
// so many warnings, all green. Neither can tell you what MOVED. That is the
// gap this closes — a pin quietly deleted, a command that vanished, a
// warning class that appeared, a probe that stopped running. Absolute
// health looks identical in all those cases; the delta does not.
//
// The baseline lives in .check-baseline.json beside the source. Commit it
// and the whole history of the bot's shape travels with the repo.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASELINE = path.join(__dirname, '.check-baseline.json');
const SAVE = process.argv.includes('--save');
const VERIFY_ONLY = process.argv.includes('--verify');
const C = process.stdout.isTTY
  ? { grn: '\x1b[32m', red: '\x1b[31m', yel: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', off: '\x1b[0m' }
  : { grn: '', red: '', yel: '', dim: '', bold: '', off: '' };

function run(args) {
  try {
    return { out: execFileSync('node', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
  } catch (e) {
    return { out: `${e.stdout || ''}${e.stderr || ''}`, code: e.status ?? 1 };
  }
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

// ── gather ──────────────────────────────────────────────────────────────
const now = { at: new Date().toISOString() };

const v = run(['--expose-internals', path.join(__dirname, 'verify.js')]);
const vOut = strip(v.out);
now.verify = {
  green: /all green/.test(vOut),
  assertions: num(vOut, /(\d+) assertions/),
  warnings: num(vOut, /(\d+) warnings?/),
  commands: num(vOut, /(\d+) commands/),
  subcommands: num(vOut, /(\d+) subcommands/),
  customIds: num(vOut, /(\d+) customIds/),
  builders: num(vOut, /builders\s+(\d+) pass/),
  rules: num(vOut, /rules\s+(\d+) pass/),
  pins: num(vOut, /pins\s+(\d+) pass/),
  failures: [...vOut.matchAll(/FAIL\s+(.+)/g)].map(m => m[1].trim()),
};

if (!VERIFY_ONLY) {
  const p = run(['--experimental-sqlite', path.join(__dirname, 'probe.js')]);
  const pOut = strip(p.out);
  now.probe = {
    green: /all green/.test(pOut),
    probes: num(pOut, /(\d+) probes/),
    failures: [...pOut.matchAll(/FAIL\s+(.+)/g)].map(m => m[1].trim()),
  };
}

// Source shape — cheap facts that make a silent deletion visible.
const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
now.shape = {
  bytes: src.length,
  lines: src.split('\n').length,
  tables: [...new Set([...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]))].sort(),
  commands: [...new Set([...src.matchAll(/\.setName\('([a-z]+)'\)\.setDescription/g)].map(m => m[1]))].sort(),
  migrations: [...new Set([...src.matchAll(/meta \(k, v\) VALUES \('([a-z_0-9]+)'/g)].map(m => m[1]))].sort(),
};
const vsrc = fs.readFileSync(path.join(__dirname, 'verify.js'), 'utf8');
now.shape.pinLabels = [...vsrc.matchAll(/\bok\('([^']{4,80})'/g)].map(m => m[1]);

function num(s, re) { const m = s.match(re); return m ? parseInt(m[1], 10) : null; }

// ── compare ─────────────────────────────────────────────────────────────
const had = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;

console.log('');
line('verify', now.verify.green, `${now.verify.assertions} assertions · ${now.verify.warnings} warnings`);
if (now.probe) line('probe ', now.probe.green, `${now.probe.probes} probes`);
for (const f of [...(now.verify.failures || []), ...((now.probe && now.probe.failures) || [])]) {
  console.log(`   ${C.red}FAIL${C.off} ${f}`);
}

if (!had) {
  console.log(`\n${C.dim}no baseline yet — run with --save to set one${C.off}\n`);
} else {
  const changes = [];
  const cmp = (label, a, b) => { if (a !== b) changes.push(`${label} ${a} ${C.dim}→${C.off} ${b}`); };
  cmp('assertions', had.verify?.assertions, now.verify.assertions);
  cmp('warnings', had.verify?.warnings, now.verify.warnings);
  cmp('commands', had.verify?.commands, now.verify.commands);
  cmp('subcommands', had.verify?.subcommands, now.verify.subcommands);
  cmp('customIds', had.verify?.customIds, now.verify.customIds);
  if (now.probe && had.probe) cmp('probes', had.probe.probes, now.probe.probes);

  // The whole point: things that DISAPPEARED.
  const gone = (a = [], b = []) => a.filter(x => !b.includes(x));
  const added = (a = [], b = []) => b.filter(x => !a.includes(x));
  const sets = [
    ['table', had.shape?.tables, now.shape.tables],
    ['command', had.shape?.commands, now.shape.commands],
    ['migration', had.shape?.migrations, now.shape.migrations],
    ['pin', had.shape?.pinLabels, now.shape.pinLabels],
  ];
  const losses = [];
  for (const [what, before, after] of sets) {
    for (const x of gone(before, after)) losses.push(`${what} removed: ${x}`);
    for (const x of added(before, after)) changes.push(`${what} added: ${C.grn}${x}${C.off}`);
  }

  const dBytes = now.shape.bytes - (had.shape?.bytes ?? 0);
  if (dBytes) changes.push(`index.js ${dBytes > 0 ? '+' : ''}${dBytes} bytes`);

  console.log('');
  if (!changes.length && !losses.length) {
    console.log(`${C.dim}nothing changed since ${had.at.slice(0, 16).replace('T', ' ')}${C.off}`);
  } else {
    console.log(`${C.bold}since ${had.at.slice(0, 16).replace('T', ' ')}${C.off}`);
    for (const c of changes) console.log(`  · ${c}`);
    for (const l of losses) console.log(`  ${C.yel}!${C.off} ${l}`);
  }
  console.log('');
}

if (SAVE) {
  fs.writeFileSync(BASELINE, JSON.stringify(now, null, 2));
  console.log(`${C.grn}baseline saved${C.off} — ${path.basename(BASELINE)}\n`);
}

function line(name, green, tail) {
  console.log(` ${green ? `${C.grn}✓${C.off}` : `${C.red}✗${C.off}`} ${name}  ${C.dim}${tail}${C.off}`);
}

const bad = !now.verify.green || (now.probe && !now.probe.green);
process.exitCode = bad ? 1 : 0;
