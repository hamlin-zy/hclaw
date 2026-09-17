/**
 * audit-muted-text.mjs
 *
 * 无 shebang：本文件的 SMALL_SIZES 被 tests/eslint-rules/auditMutedTextSync.test.ts 直接 import，
 * 而 vitest 的模块加载路径不剥离行首的 #!，留着会以 SyntaxError: Invalid or unexpected token 失败。
 * 本文件只经 package.json 的 audit:muted（node scripts/audit-muted-text.mjs）调用，不需要 shebang。
 * ---------------------------------------------------------------------------
 * READ-ONLY audit tool. It never modifies source files. It only scans every
 * .ts / .tsx file under `src/renderer` and writes two reports under `tmp/`.
 *
 * Goal: find every `text-[var(--text-muted)]` usage and classify it so a human
 * can review which occurrences are *information-bearing small text* (candidates
 * to migrate to `--text-secondary` for WCAG AA) versus icon/decoration/placeholder
 * (AA-exempt, must NOT be touched).
 *
 * ---------------------------------------------------------------------------
 * CLASSIFICATION RULES (verdict, three-valued)
 * ---------------------------------------------------------------------------
 * For each occurrence we try to recover the enclosing `className` string
 * literal (may span multiple lines: from `className={` / `className="` /
 * `className=`` forward to the matching close). If we cannot recover it, we
 * degrade to the physical line.
 *
 * Derived signals:
 *   size      : the font-size class found in the literal
 *               (text-xs | text-sm | text-base | text-lg | text-[<..>px] | null)
 *   iconSlot  : true when the literal looks like an icon slot, i.e. it contains
 *               BOTH a `w-<n>` and an `h-<n>` size pair, OR `shrink-0`, OR a JSX
 *               component name ending in `Icon` appears on the match line or the
 *               two preceding lines.
 *
 * Verdict (evaluated in order):
 *   DECOR   - iconSlot is true, OR no size class is present, OR the literal
 *             contains a decorative clue: `placeholder` / `disabled` /
 *             `aria-hidden`.
 *   INFO    - a small info size (text-xs | text-sm | text-base) is present AND
 *             iconSlot is false.  ==> candidate to migrate to --text-secondary.
 *   UNKNOWN - everything else (e.g. only text-lg / text-xl, unusual shapes).
 *
 * DECOR / UNKNOWN / INFO are ALL report-only. No file is ever changed.
 * The script always exits 0: it is a reporting tool, not a gate.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SRC_RENDERER = path.join(ROOT, 'src', 'renderer');
const OUT_DIR = path.join(ROOT, 'tmp');
const OUT_JSON = path.join(OUT_DIR, 'muted-text-audit.json');
const OUT_MD = path.join(OUT_DIR, 'muted-text-audit.md');

const TARGET = 'text-[var(--text-muted)]';
const SKIP_DIRS = new Set(['node_modules', '.vite', 'dist']);
const MAX_LITERAL_LOOKBACK = 6000; // chars; guard against runaway brace scans

/* ------------------------------------------------------------------ */
/* file walking                                                        */
/* ------------------------------------------------------------------ */

function isTsFile(name) {
  return /\.(ts|tsx)$/.test(name);
}

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile() && isTsFile(ent.name)) {
      out.push(full);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* className literal recovery                                          */
/* ------------------------------------------------------------------ */

// Find the closing position of an opening delimiter starting at `openPos`.
function findClose(text, openPos, d) {
  if (d === '"' || d === "'" || d === '`') {
    let i = openPos + 1;
    while (i < text.length) {
      const c = text[i];
      if (c === '\\') { i += 2; continue; }
      if (c === d) return i;
      i++;
    }
    return -1;
  }
  // d === '{' : brace-balanced scan that skips string bodies
  let depth = 0;
  let i = openPos;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      const close = findClose(text, i, c);
      if (close < 0) return -1;
      i = close + 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

// Collect all className literal spans in `text`.
function collectClassNameSpans(text) {
  const spans = [];
  const re = /(?<![\w$])className\s*=\s*(["{`])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const d = m[1];
    const openPos = m.index + m[0].length - 1;
    const closePos = findClose(text, openPos, d);
    if (closePos > openPos) {
      spans.push({ openPos, closePos, raw: text.slice(openPos, closePos + 1) });
    }
  }
  return spans;
}

function lineOf(text, pos) {
  let line = 1;
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

/* ------------------------------------------------------------------ */
/* signal extraction                                                   */
/* ------------------------------------------------------------------ */

function extractSize(literal) {
  if (/\btext-xs\b/.test(literal)) return 'text-xs';
  if (/\btext-sm\b/.test(literal)) return 'text-sm';
  if (/\btext-base\b/.test(literal)) return 'text-base';
  if (/\btext-lg\b/.test(literal)) return 'text-lg';
  if (/\btext-xl\b/.test(literal)) return 'text-xl';
  if (/\btext-2xl\b/.test(literal)) return 'text-2xl';
  if (/\btext-3xl\b/.test(literal)) return 'text-3xl';
  const px = literal.match(/\btext-\[[^\]]*px\]/);
  if (px) return px[0];
  return null;
}

// 小字号档：仅具名字号。注意与 eslint-rules/muted-text-informative.ts 的 SMALL_SIZE
// 存在**有意**差异——规则侧额外匹配 text-[<=13px]，脚本侧不认（此类记 UNKNOWN）。
// 该差异由 tests/eslint-rules/auditMutedTextSync.test.ts 钉住，勿单侧改动。
export const SMALL_SIZES = new Set(['text-xs', 'text-sm', 'text-base']);

function hasIconSizePair(literal) {
  const w = /\bw-(\d+(?:\.\d+)?|\[[^\]]+\])/.test(literal);
  const h = /\bh-(\d+(?:\.\d+)?|\[[^\]]+\])/.test(literal);
  return w && h;
}

function detectIconSlot(literal, lines, matchLineIdx) {
  if (hasIconSizePair(literal)) return true;
  if (/\bshrink-0\b/.test(literal)) return true;
  const from = Math.max(0, matchLineIdx - 2);
  for (let i = from; i <= matchLineIdx; i++) {
    if (/\b[A-Za-z][A-Za-z0-9]*Icon\b/.test(lines[i] || '')) return true;
  }
  return false;
}

function classify(literal, lines, matchLineIdx) {
  const size = extractSize(literal);
  const iconSlot = detectIconSlot(literal, lines, matchLineIdx);
  const decorToken = /placeholder|disabled|aria-hidden/.test(literal);

  if (iconSlot || !size || decorToken) return { verdict: 'DECOR', size, iconSlot };
  if (SMALL_SIZES.has(size)) return { verdict: 'INFO', size, iconSlot };
  return { verdict: 'UNKNOWN', size, iconSlot };
}

/* ------------------------------------------------------------------ */
/* scan                                                                */
/* ------------------------------------------------------------------ */

function rel(p) {
  return path.relative(ROOT, p).split(path.sep).join('/');
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(TARGET)) return [];
  const lines = text.split(/\r?\n/);
  const spans = collectClassNameSpans(text);
  const results = [];

  let idx = text.indexOf(TARGET);
  while (idx !== -1) {
    const lineIdx = lineOf(text, idx) - 1;

    // find the innermost className span that contains this position
    let literal = null;
    for (let i = spans.length - 1; i >= 0; i--) {
      const s = spans[i];
      if (s.openPos <= idx && idx <= s.closePos) {
        if (idx - s.openPos <= MAX_LITERAL_LOOKBACK) literal = s.raw;
        break;
      }
    }
    if (literal === null) literal = lines[lineIdx] || ''; // degrade to line

    const { verdict, size, iconSlot } = classify(literal, lines, lineIdx);
    results.push({
      file: rel(file),
      line: lineIdx + 1,
      size: size,
      iconSlot: iconSlot,
      verdict: verdict,
      snippet: (lines[lineIdx] || '').trim().slice(0, 140),
    });

    idx = text.indexOf(TARGET, idx + TARGET.length);
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* report generation                                                   */
/* ------------------------------------------------------------------ */

function toTotals(items) {
  const totals = { total: items.length, INFO: 0, DECOR: 0, UNKNOWN: 0 };
  for (const it of items) totals[it.verdict] = (totals[it.verdict] || 0) + 1;
  return totals;
}

const VERDICT_ORDER = { INFO: 0, UNKNOWN: 1, DECOR: 2 };

function buildMarkdown(items, totals) {
  const now = new Date().toISOString();
  const byFile = new Map();
  for (const it of items) {
    if (!byFile.has(it.file)) byFile.set(it.file, []);
    byFile.get(it.file).push(it);
  }

  const infoByFile = [];
  for (const [file, arr] of byFile) {
    const n = arr.filter((x) => x.verdict === 'INFO').length;
    if (n > 0) infoByFile.push({ file, n });
  }
  infoByFile.sort((a, b) => b.n - a.n || a.file.localeCompare(b.file));

  const out = [];
  out.push('# Muted Text Audit');
  out.push('');
  out.push(`Generated: ${now}`);
  out.push('');
  out.push('Source pattern: `text-[var(--text-muted)]` in `src/renderer/**/*.{ts,tsx}`');
  out.push('');
  out.push('> READ-ONLY REPORT. `INFO` = candidate to migrate to `--text-secondary`.');
  out.push('> `DECOR` / `UNKNOWN` are report-only and must not be changed by this pass.');
  out.push('');
  out.push('## Summary');
  out.push('');
  out.push('| Metric | Count |');
  out.push('| --- | --- |');
  out.push(`| Total occurrences | ${totals.total} |`);
  out.push(`| INFO (migrate candidates) | ${totals.INFO} |`);
  out.push(`| DECOR (exempt) | ${totals.DECOR} |`);
  out.push(`| UNKNOWN | ${totals.UNKNOWN} |`);
  out.push('');
  out.push('## INFO candidates by file (Top 20, descending)');
  out.push('');
  out.push('| File | INFO count |');
  out.push('| --- | --- |');
  for (const row of infoByFile.slice(0, 20)) {
    out.push(`| ${row.file} | ${row.n} |`);
  }
  if (infoByFile.length === 0) out.push('| _(none)_ | 0 |');
  out.push('');
  out.push('## Details by file');
  out.push('');

  const files = [...byFile.keys()].sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const arr = byFile.get(file).slice().sort((a, b) => {
      const d = (VERDICT_ORDER[a.verdict] ?? 9) - (VERDICT_ORDER[b.verdict] ?? 9);
      return d !== 0 ? d : a.line - b.line;
    });
    out.push(`### ${file}`);
    out.push('');
    out.push('| Line | Verdict | Size | IconSlot | Snippet |');
    out.push('| --- | --- | --- | --- | --- |');
    for (const it of arr) {
      const snip = it.snippet.replace(/\|/g, '\\|');
      out.push(`| ${it.line} | ${it.verdict} | ${it.size || '-'} | ${it.iconSlot} | \`${snip}\` |`);
    }
    out.push('');
  }

  return out.join('\n');
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function main() {
  const files = walk(SRC_RENDERER, []);
  const items = files.flatMap((f) => scanFile(f));

  const totals = toTotals(items);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, JSON.stringify({ totals, items }, null, 2), 'utf8');
  fs.writeFileSync(OUT_MD, buildMarkdown(items, totals), 'utf8');

  console.log('muted-text audit complete');
  console.log(`  total   : ${totals.total}`);
  console.log(`  INFO    : ${totals.INFO}`);
  console.log(`  DECOR   : ${totals.DECOR}`);
  console.log(`  UNKNOWN : ${totals.UNKNOWN}`);
  console.log(`  json    : ${rel(OUT_JSON)}`);
  console.log(`  md      : ${rel(OUT_MD)}`);
}

// 入口守卫：仅当作为 CLI 直接执行时运行；被 import（如测试）时不触发副作用。
const isEntryPoint =
  !!process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isEntryPoint) {
  try {
    main();
  } catch (err) {
    // Reporting tool: never fail the pipeline.
    console.error('audit-muted-text: unexpected error (non-fatal):', err && err.message);
  }

  // always exit 0
  process.exitCode = 0;
}
