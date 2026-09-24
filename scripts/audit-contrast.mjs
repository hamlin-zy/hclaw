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
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const CSS_FILE = path.join(ROOT, 'src', 'renderer', 'styles', 'globals.css');

export const THRESHOLD = 4.5;

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

/**
 * 定点配对（spec §10.5 质量门勘误）：不进 INK_TOKENS/SURFACE_TOKENS 全量循环，
 * 只对清单里的组合做门禁——其中 --text-muted 按其用途契约本来就是弱化文本
 * （globals.css「--text-muted 的用途契约」），不参与全量 4.5:1 门禁。
 */
const EXTRA_PAIR_TOKENS = ['--text-primary', '--text-secondary', '--text-muted'];
const EXTRA_PAIRS = [
  {ink: '--text-muted', bg: '--surface-chrome', note: '抽屉内联成员路径'},
  {ink: '--text-secondary', bg: '--surface-chrome', note: '抽屉组头「n 个项目」'},
  {
    ink: '--text-primary',
    bg: '--surface-chrome',
    alphaToken: '--act-bg',
    label: '--act-bg over --surface-chrome',
    note: '会话行激活底块',
  },
];

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
/* pure core (exported for tests)                                      */
/* ------------------------------------------------------------------ */

/**
 * 解析样式表，产出全部待测配对：
 *   - 既有：INK_TOKENS ×（SURFACE_TOKENS + 选中态合成层）
 *   - 新增：EXTRA_PAIRS（含 --act-bg 半透明层按主题合成）
 * 每条：{token, theme, surfaceToken, note?, inkRgb, bgRgb, composite?}
 * 解析失败时抛 Error（调用方据此走失败出口）。
 */
export function collectPairs(css) {
  css = stripComments(css);
  const rootBody = ruleBody(css, ':root');
  if (rootBody === null) throw new Error('解析失败，找不到 `:root {` 块');

  const pairs = [];

  for (const theme of THEMES) {
    let body = rootBody;
    if (theme !== ':root') {
      const themeBody = ruleBody(css, theme);
      if (themeBody === null) throw new Error(`解析失败，找不到主题块 \`${theme} {\``);
      body = `${rootBody}\n${themeBody}`; // 后者覆盖前者
    }

    const surfaces = {};
    for (const token of SURFACE_TOKENS) {
      const raw = decl(body, token);
      const hex = raw ? parseHex(raw) : null;
      if (!hex) {
        throw new Error(`主题 ${theme} 的 ${token} 不是可解析的 hex（读到 ${raw ?? '（无声明）'}）`);
      }
      surfaces[token] = hex;
    }

    const extras = {};
    for (const token of EXTRA_PAIR_TOKENS) {
      const raw = decl(body, token);
      const hex = raw ? parseHex(raw) : null;
      if (!hex) {
        throw new Error(`主题 ${theme} 的 ${token} 不是可解析的 hex（读到 ${raw ?? '（无声明）'}）`);
      }
      extras[token] = hex;
    }
    const chromeRaw = decl(body, '--surface-chrome');
    const chrome = chromeRaw ? parseHex(chromeRaw) : null;
    if (!chrome) {
      throw new Error(`主题 ${theme} 的 --surface-chrome 不是可解析的 hex（读到 ${chromeRaw ?? '（无声明）'}）`);
    }

    // 选中态底：--brand-muted 是半透明层，必须合成到 --surface 之后再比对比度
    const layerRaw = decl(body, LAYER_BG.alphaToken);
    const layer = layerRaw ? parseRgba(layerRaw) : null;
    if (!layer) {
      throw new Error(
        `主题 ${theme} 的 ${LAYER_BG.alphaToken} 不是可解析的 rgba()（读到 ${layerRaw ?? '（无声明）'}）`,
      );
    }

    // --act-bg 半透明激活底块：alpha 与底层色随主题不同（浅色黑 .06 / 深色白 .10），
    // 必须逐主题解析并合成，禁止取单一假设值
    const actRaw = decl(body, '--act-bg');
    const act = actRaw ? parseRgba(actRaw) : null;
    if (!act) {
      throw new Error(
        `主题 ${theme} 的 --act-bg 不是可解析的 rgba()（读到 ${actRaw ?? '（无声明）'}）`,
      );
    }

    for (const spec of EXTRA_PAIRS) {
      const pair = {
        token: spec.ink,
        theme,
        surfaceToken: spec.alphaToken ? spec.label : spec.bg,
        note: spec.note,
        inkRgb: extras[spec.ink],
        bgRgb: spec.alphaToken ? chrome : surfaces[spec.bg] ?? chrome,
      };
      if (spec.alphaToken) pair.composite = act;
      pairs.push(pair);
    }

    const backgrounds = [
      ...SURFACE_TOKENS.map((token) => ({label: token, rgb: surfaces[token]})),
      {label: LAYER_BG.label, rgb: composite(layer, surfaces['--surface'])},
    ];

    for (const token of INK_TOKENS) {
      const raw = decl(body, token);
      const ink = raw ? parseHex(raw) : null;
      if (!ink) {
        throw new Error(
          `主题 ${theme} 的 ${token} 不是可解析的 hex（读到 ${raw ?? '（无声明）'}）——文字级令牌必须是逐主题字面值`,
        );
      }
      for (const bg of backgrounds) {
        pairs.push({token, theme, surfaceToken: bg.label, inkRgb: ink, bgRgb: bg.rgb});
      }
    }
  }

  return pairs;
}

/**
 * 计算每条配对的对比度并给出 pass 判定（纯函数，供测试与 CLI 共用）。
 * composite（rgba 层）先合成到 bgRgb 之上再算比率。
 */
export function evaluatePairs(pairs) {
  return pairs.map((p) => {
    const bg = p.composite ? composite(p.composite, p.bgRgb) : p.bgRgb;
    const ratio = contrastRatio(p.inkRgb, bg);
    return {...p, ratio, pass: ratio >= THRESHOLD};
  });
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
  // 注释剥除在 collectPairs 内完成（该函数需同时服务 CLI 与测试两条入口），此处不重复处理
  const css = fs.readFileSync(CSS_FILE, 'utf8');

  let pairs;
  try {
    pairs = evaluatePairs(collectPairs(css));
  } catch (err) {
    fail(`audit-contrast: ${err && err.message}`);
    return;
  }
  const failures = pairs.filter((p) => !p.pass);

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
  const bgCount = new Set(pairs.map((p) => p.surfaceToken)).size;
  const inkCount = new Set(pairs.map((p) => p.token)).size;
  console.log(
    `audit-contrast: OK — ${inkCount} gate tokens + 定点配对 × ${THEMES.length} themes × ${bgCount} backgrounds ` +
      `= ${pairs.length} combos ≥ ${THRESHOLD.toFixed(1)}:1 ` +
      `(min ${min.ratio.toFixed(2)} = ${min.token} @ ${min.theme}/${min.surfaceToken})`,
  );
}

// 仅作为 CLI 直接运行时才执行 main；被测试 import 时保持无副作用
const isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  try {
    main();
  } catch (err) {
    fail(`audit-contrast: unexpected error: ${err && err.message}`);
  }
}
