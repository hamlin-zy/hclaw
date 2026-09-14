#!/usr/bin/env node
/**
 * audit-contrast.mjs
 * ---------------------------------------------------------------------------
 * READ-ONLY contrast gate. It never modifies source files.
 *
 * Goal: the PM window uses `--text-brand` / `--vcs-*` as **text colors** on small
 * type (commit hash, branch name, status letter, ...). Those tokens must reach
 * WCAG AA (4.5:1) against every background they can legally land on.
 *
 * What it checks
 *   - themes  : `:root` (light) / `.dark` / `.yuanshandai` / `.shiyangjin`
 *               (the three theme blocks override `:root`, so values are merged
 *                in that order)
 *   - ink     : --text-brand, --text-secondary, --text-danger, --vcs-modified,
 *               --vcs-added, --vcs-deleted, --vcs-renamed, --vcs-untracked
 *               (literal hex per theme)
 *   - background : --surface, --surface-muted, --surface-elevated (浮层底：右键菜单 /
 *                  tooltip / 弹窗 / 作者下拉都渲染在它上面), and the composited
 *                  selection layer (--brand-muted over --surface, a translucent tint)
 *   - assert  : every ink × surface pair ≥ 4.5:1
 *
 * Exit codes
 *   0  all pairs pass  -> prints one summary line
 *   1  one or more pairs fail, or the stylesheet/tokens could not be parsed
 *      -> prints a `token / theme / ratio / threshold` table
 *
 * Zero dependencies. Sibling of `scripts/audit-muted-text.mjs` (that one is a
 * reporting tool and always exits 0; this one is a gate, hence exit 1).
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'src', 'renderer', 'styles', 'globals.css');

const THRESHOLD = 4.5;

/** 主题块选择器，顺序即覆盖顺序（后三者覆盖 :root） */
const THEMES = [':root', '.dark', '.yuanshandai', '.shiyangjin'];

/** 文字级令牌（必须以字面 hex 声明在四个主题块内） */
const INK_TOKENS = [
  '--text-brand',
  '--text-secondary',
  '--text-danger',
  '--vcs-modified',
  '--vcs-added',
  '--vcs-deleted',
  '--vcs-renamed',
  '--vcs-untracked',
  // 文件类型色：图标 + 文件名共用，同为 12px 小字，按同样的门禁
  '--ft-code',
  '--ft-test',
  '--ft-style',
  '--ft-markup',
  '--ft-data',
  '--ft-image',
];

/** 令牌要对比的纯色背景 */
const SURFACE_TOKENS = ['--surface', '--surface-muted', '--surface-elevated'];

/** 半透明背景层（选中态）：本身不是实色，必须先与 --surface 合成再比对 */
const LAYER_BG = {alphaToken: '--brand-muted', label: '--brand-muted over --surface'};

/* ------------------------------------------------------------------ */
/* CSS parsing                                                         */
/* ------------------------------------------------------------------ */

/** 剥掉注释，避免注释里的 `--x: #hex` 被误当成声明 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 取出 `selector { ... }` 的规则体（花括号配平）。找不到返回 null。 */
function ruleBody(css, selector) {
  const at = css.indexOf(selector + ' {');
  if (at === -1) return null;
  const start = css.indexOf('{', at);
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') {
      depth--;
      if (depth === 0) return css.slice(start + 1, i);
    }
  }
  return null;
}

/**
 * 读一条自定义属性声明；不存在返回 null。
 * 取**最后**一条声明：body 是「:root 打底 + 主题块」拼接而成，主题自己的值在后面，
 * 用第一条会让四个主题全部退化成 :root 的值（守卫形同虚设）。
 */
function decl(body, name) {
  const re = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+);`, 'g');
  let value = null;
  let m;
  while ((m = re.exec(body)) !== null) value = m[1].trim();
  return value;
}

/* ------------------------------------------------------------------ */
/* WCAG relative luminance / contrast ratio                            */
/* ------------------------------------------------------------------ */

/** `#rgb` / `#rrggbb` -> {r,g,b}（0..255）。非法返回 null。 */
function parseHex(hex) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/** `rgba(r, g, b, a)` / `rgb(r, g, b)` -> {r,g,b,a}。非法返回 null。 */
function parseRgba(value) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(
    value,
  );
  if (!m) return null;
  return {
    r: Number(m[1]),
    g: Number(m[2]),
    b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

/** 把半透明前景合成到不透明背景上，返回实色（用于选中态等叠加背景）。 */
function composite(fg, bg) {
  const mix = (f, b) => fg.a * f + (1 - fg.a) * b;
  return {r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b)};
}

function channelLuminance(value255) {
  const c = value255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance({ r, g, b }) {
  return (
    0.2126 * channelLuminance(r) +
    0.7152 * channelLuminance(g) +
    0.0722 * channelLuminance(b)
  );
}

function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

function main() {
  if (!fs.existsSync(CSS_FILE)) {
    fail(`audit-contrast: 找不到样式表 ${path.relative(ROOT, CSS_FILE)}`);
    return;
  }
  const css = stripComments(fs.readFileSync(CSS_FILE, 'utf8'));

  // 解析：:root 打底，三个主题块逐层覆盖
  const rootBody = ruleBody(css, ':root');
  if (rootBody === null) {
    fail('audit-contrast: 解析失败，找不到 `:root {` 块');
    return;
  }

  const failures = [];
  const pairs = [];

  for (const theme of THEMES) {
    let body = rootBody;
    if (theme !== ':root') {
      const themeBody = ruleBody(css, theme);
      if (themeBody === null) {
        fail(`audit-contrast: 解析失败，找不到主题块 \`${theme} {\``);
        return;
      }
      body = `${rootBody}\n${themeBody}`; // 后者覆盖前者
    }

    const surfaces = {};
    for (const token of SURFACE_TOKENS) {
      const raw = decl(body, token);
      const hex = raw ? parseHex(raw) : null;
      if (!hex) {
        fail(`audit-contrast: 主题 ${theme} 的 ${token} 不是可解析的 hex（读到 ${raw ?? '（无声明）'}）`);
        return;
      }
      surfaces[token] = hex;
    }

    // 选中态底：--brand-muted 是半透明层，必须合成到 --surface 之后再比对比度
    const layerRaw = decl(body, LAYER_BG.alphaToken);
    const layer = layerRaw ? parseRgba(layerRaw) : null;
    if (!layer) {
      fail(
        `audit-contrast: 主题 ${theme} 的 ${LAYER_BG.alphaToken} 不是可解析的 rgba()（读到 ${layerRaw ?? '（无声明）'}）`,
      );
      return;
    }
    const backgrounds = [
      ...SURFACE_TOKENS.map((token) => ({label: token, rgb: surfaces[token]})),
      {label: LAYER_BG.label, rgb: composite(layer, surfaces['--surface'])},
    ];

    for (const token of INK_TOKENS) {
      const raw = decl(body, token);
      const ink = raw ? parseHex(raw) : null;
      if (!ink) {
        fail(`audit-contrast: 主题 ${theme} 的 ${token} 不是可解析的 hex（读到 ${raw ?? '（无声明）'}）——文字级令牌必须是逐主题字面值`);
        return;
      }
      for (const bg of backgrounds) {
        const ratio = contrastRatio(ink, bg.rgb);
        pairs.push({ token, theme, surfaceToken: bg.label, ratio });
        if (ratio < THRESHOLD) {
          failures.push({ token, theme, surfaceToken: bg.label, ratio });
        }
      }
    }
  }

  if (failures.length > 0) {
    console.error('audit-contrast: FAIL');
    console.error('');
    console.error('| 令牌 | 主题 | 背景 | 实测值 | 阈值 |');
    console.error('| --- | --- | --- | --- | --- |');
    for (const f of failures) {
      console.error(
        `| ${f.token} | ${f.theme} | ${f.surfaceToken} | ${f.ratio.toFixed(2)} | ${THRESHOLD.toFixed(1)} |`,
      );
    }
    console.error('');
    console.error(`共 ${failures.length}/${pairs.length} 组不达标`);
    process.exitCode = 1;
    return;
  }

  const min = pairs.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  console.log(
    `audit-contrast: OK — ${INK_TOKENS.length} tokens × ${THEMES.length} themes × ${SURFACE_TOKENS.length + 1} backgrounds ` +
      `= ${pairs.length} combos ≥ ${THRESHOLD.toFixed(1)}:1 ` +
      `(min ${min.ratio.toFixed(2)} = ${min.token} @ ${min.theme}/${min.surfaceToken})`,
  );
}

try {
  main();
} catch (err) {
  fail(`audit-contrast: unexpected error: ${err && err.message}`);
}
