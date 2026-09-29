#!/usr/bin/env node
// Writes every file whose code is in the class-board plan, applying each task's edits in task
// order, so the result is the final state of every file. No agent has to transcribe code.
//
// A code block belongs to the file named on the instruction line above it. The instruction
// decides what happens:
//   "Create/Implement/Write/Replace `f` …", "`f`:", "This is the complete new file:" → write
//   "Append …" / "Then append …"                           → append (after a blank line)
//   "Replace the … import lines at the top …"               → replace everything above the first blank line
//   "replace the `fn` function (from its `/**` … end …)"    → replace from fn's doc comment to the end
//   "replace … :" + block + "with:" + block                 → exact find-and-replace
// An instruction without a path applies to the file of the previous block in the same task.
//
// Usage, from the repo root:
//   node docs/superpowers/plans/2026-09-29-class-board/materialize.mjs [--out <dir>] [--dry-run]
// --out defaults to the repo root. --dry-run prints the mapping and writes nothing.
// Exits with status 1 if any edit can't be applied exactly.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../../..');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const outIdx = args.indexOf('--out');
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : repoRoot);

// Task order: F1, the contracts (master plan §8), then the workstreams in wave order, so a
// file edited by several tasks ends in its last task's state.
const SOURCES = [
  { file: join(here, '01-foundation.md'), from: /^### Task F1\b/, to: /^### Task F3\b/ },
  { file: join(here, '..', '2026-09-29-class-board.md'), from: /^## 8\. Task F2/, to: /^## 9\. / },
  { file: join(here, '01-foundation.md'), from: /^### Task F3\b/, to: null },
  { file: join(here, '03-worker-leaves.md'), from: null, to: null },
  { file: join(here, '02-worker-core.md'), from: null, to: null },
  { file: join(here, '04-web-core-a.md'), from: null, to: null },
  { file: join(here, '07-web-cursors.md'), from: null, to: null },
  { file: join(here, '06-web-tiles.md'), from: null, to: null },
  { file: join(here, '05-web-core-b.md'), from: null, to: null },
  // E1–E3 only. V1, V2 and the owner's deploy steps edit files by hand or outside the repo.
  { file: join(here, '08-e2e-launch.md'), from: null, to: /^### Task V1\b/ },
];

const TEXT_LANGS = new Set(['text', 'txt']);
const CODE_LANGS = new Set(['ts', 'js', 'mjs', 'json', 'jsonc', 'css', 'html', 'yaml', 'yml', 'md', 'markdown', 'gitignore', 'gitattributes', 'editorconfig', 'ini', 'dotenv', 'env', '']);
const PATH_RE = /`((?:[\w.@-]+\/)*[\w.@-]+)`/g;
const ROOT_FILES = new Set(['package.json', 'tsconfig.base.json', 'README.md', '.gitignore', '.gitattributes', '.editorconfig', '.nvmrc']);
const OWNED_DIRS = ['shared/', 'worker/', 'web/', 'e2e/', 'scripts/', 'docs/', '.github/'];

const isRepoPath = (p) => ROOT_FILES.has(p) || (OWNED_DIRS.some((d) => p.startsWith(d)) && /\.[\w-]+$/.test(p));

function sliceSection(text, from, to) {
  const lines = text.split(/\r?\n/);
  let start = 0;
  let end = lines.length;
  if (from) {
    start = lines.findIndex((l) => from.test(l));
    if (start < 0) throw new Error(`section start ${from} not found`);
  }
  if (to) {
    const rel = lines.slice(start + 1).findIndex((l) => to.test(l));
    if (rel >= 0) end = start + 1 + rel;
  }
  return { lines: lines.slice(start, end), offset: start };
}

/** Fenced blocks; a fence closes only on a bare fence at least as long, so nested ``` stays content. */
function blocks(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^(`{3,})([\w-]*)\s*$/.exec(lines[i]);
    if (!open) continue;
    const len = open[1].length;
    let j = i + 1;
    while (j < lines.length && !(/^`+\s*$/.test(lines[j]) && lines[j].trim().length >= len)) j += 1;
    out.push({ start: i, end: j, lang: open[2].toLowerCase(), body: lines.slice(i + 1, j).join('\n') });
    i = j;
  }
  return out;
}

const nearestText = (lines, from, stop) => {
  for (let k = from; k > stop; k -= 1) if (lines[k].trim()) return { text: lines[k].trim(), at: k };
  return null;
};

/** Path named on the instruction line or up to 6 non-empty lines above it (not past the last block). */
function pathAbove(lines, start, stop) {
  for (let k = start - 1, seen = 0; k > stop && seen < 6; k -= 1) {
    const line = lines[k].trim();
    if (!line) continue;
    seen += 1;
    const paths = [...line.matchAll(PATH_RE)].map((m) => m[1]).filter(isRepoPath);
    if (paths.length) return paths[0];
    if (/^#{1,6} /.test(line)) break;
  }
  return null;
}

function classify(instruction, followedByWith) {
  if (instruction === 'with:') return { op: 'with' };
  if (followedByWith) return { op: 'old' };
  if (/\bappend\b/i.test(instruction)) return { op: 'append' };
  if (/replace the (?:[\w-]+ )?import (?:lines|block) at the top|replace the import lines at the top/i.test(instruction)) return { op: 'header' };
  const fn = /replace the `([\w$]+)` function \(from its `\/\*\*` doc comment to the end of the file\)/i.exec(instruction);
  if (fn) return { op: 'fromfn', fn: fn[1] };
  return { op: 'write' };
}

const norm = (s) => (s.endsWith('\n') ? s : `${s}\n`);
const files = new Map();
const skipped = [];
const errors = [];

for (const src of SOURCES) {
  const name = src.file.split(/[\\/]/).pop();
  const { lines, offset } = sliceSection(readFileSync(src.file, 'utf8'), src.from, src.to);
  const all = blocks(lines);
  let prevEnd = -1;
  let current = null; // file of the previous block in this source
  let pendingOld = null;
  for (const b of all) {
    const where = `${name}:${offset + b.start + 1}`;
    const stop = prevEnd;
    const instr = nearestText(lines, b.start - 1, stop);
    prevEnd = b.end;
    const isText = TEXT_LANGS.has(b.lang);
    if (!CODE_LANGS.has(b.lang) && !isText) {
      skipped.push(`${where} (${b.lang})`);
      continue;
    }
    if (isText && !(instr && /^`[^`]+`:$/.test(instr.text) && isRepoPath(instr.text.slice(1, -2)))) {
      skipped.push(`${where} (text)`);
      continue;
    }
    let nextInstr = '';
    for (let k = b.end + 1; k < lines.length && !nextInstr; k += 1) nextInstr = lines[k].trim();
    const { op, fn } = classify(instr?.text ?? '', nextInstr === 'with:');
    const path = op === 'with' ? pendingOld?.path : (pathAbove(lines, b.start, stop) ?? current);
    if (!path) {
      skipped.push(`${where} (${b.lang || 'no lang'}, no file: "${(instr?.text ?? '').slice(0, 60)}")`);
      continue;
    }
    const entry = files.get(path) ?? { content: null, history: [] };
    const body = norm(b.body);
    switch (op) {
      case 'write':
        entry.content = body;
        break;
      case 'append':
        if (entry.content === null) errors.push(`${where}: append to ${path}, which has no content yet`);
        entry.content = `${(entry.content ?? '').replace(/\n*$/, '\n')}\n${body}`;
        break;
      case 'header': {
        const c = entry.content ?? '';
        const cut = c.search(/\n\s*\n/);
        if (entry.content === null || cut < 0) errors.push(`${where}: no header to replace in ${path}`);
        else entry.content = body + c.slice(cut + 1);
        break;
      }
      case 'fromfn': {
        const c = entry.content ?? '';
        const at = c.search(new RegExp(`(?:export )?(?:async )?function ${fn}\\b`));
        const doc = at < 0 ? -1 : c.lastIndexOf('/**', at);
        if (at < 0) errors.push(`${where}: function ${fn} not found in ${path}`);
        else entry.content = c.slice(0, doc >= 0 && !c.slice(doc, at).includes('*/\n\n') ? doc : at) + body;
        break;
      }
      case 'old':
        pendingOld = { path, text: b.body };
        entry.history.push(`old@${where}`);
        files.set(path, entry);
        current = path;
        continue;
      case 'with': {
        const c = entry.content ?? '';
        if (!pendingOld || !c.includes(pendingOld.text)) errors.push(`${where}: text to replace not found in ${path}`);
        else entry.content = c.replace(pendingOld.text, b.body);
        pendingOld = null;
        break;
      }
      default:
        break;
    }
    entry.history.push(`${op}${fn ? `(${fn})` : ''}@${where}`);
    files.set(path, entry);
    current = path;
  }
}

for (const path of [...files.keys()].sort()) {
  const { content, history } = files.get(path);
  const n = content === null ? 0 : content.split('\n').length - 1;
  console.log(`${path.padEnd(48)} ${String(n).padStart(5)} lines  ${history.join(', ')}`);
  if (!dryRun && content !== null) {
    const target = join(outDir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}
console.log(`\n${files.size} files ${dryRun ? 'mapped (dry run)' : `written to ${outDir}`}; ${skipped.length} non-file blocks skipped.`);
if (process.argv.includes('--show-skipped')) for (const s of skipped) console.log(`  skipped ${s}`);
if (errors.length) {
  console.error(`\n${errors.length} edit(s) could not be applied:`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
