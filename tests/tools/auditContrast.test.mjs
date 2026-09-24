/**
 * Task 19：对比度质量门扩展的单元测试。
 *
 * 直接调用 scripts/audit-contrast.mjs 导出的纯函数：
 *   - collectPairs(css)   —— 解析样式表，产出全部待测配对（含 rgb 与合成层描述）
 *   - evaluatePairs(pairs) —— 计算每组配对的对比度并给出 pass 判定
 *
 * CLI 行为（main / 退出码）不在本测试覆盖范围，由 `npm run audit:contrast` 门禁验证。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectPairs, evaluatePairs, THRESHOLD } from '../../scripts/audit-contrast.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles', 'globals.css'), 'utf8');

/** 本次改造新增的三组定点配对（spec §10.5 质量门勘误） */
const NEW_PAIRS = [
  { token: '--text-muted', surfaceToken: '--surface-chrome', note: '抽屉内联成员路径' },
  { token: '--text-secondary', surfaceToken: '--surface-chrome', note: '抽屉组头「n 个项目」' },
  {
    token: '--text-primary',
    surfaceToken: '--act-bg over --surface-chrome',
    note: '会话行激活底块',
  },
];

const THEMES = [':root', '.dark', '.yuanshandai', '.shiyangjin'];

test('collectPairs：新增的三组配对在四个主题下都出现', () => {
  const pairs = collectPairs(CSS);
  for (const theme of THEMES) {
    for (const want of NEW_PAIRS) {
      const hit = pairs.find(
        (p) => p.token === want.token && p.surfaceToken === want.surfaceToken && p.theme === theme,
      );
      assert.ok(hit, `缺少配对 ${want.token} × ${want.surfaceToken} @ ${theme}（${want.note}）`);
      assert.equal(hit.note, want.note);
      assert.ok(hit.inkRgb, `配对缺少 ink rgb：${want.token} @ ${theme}`);
      assert.ok(hit.bgRgb, `配对缺少 bg rgb：${want.surfaceToken} @ ${theme}`);
    }
  }
});

test('collectPairs：既有 ink × surface 配对不被本次改动破坏', () => {
  const pairs = collectPairs(CSS);
  for (const token of ['--text-brand', '--vcs-modified']) {
    for (const surfaceToken of ['--surface', '--surface-muted', '--surface-elevated']) {
      for (const theme of THEMES) {
        const hit = pairs.find(
          (p) => p.token === token && p.surfaceToken === surfaceToken && p.theme === theme,
        );
        assert.ok(hit, `既有配对缺席：${token} × ${surfaceToken} @ ${theme}`);
      }
    }
  }
});

test('evaluatePairs：bgComposite 走 alpha 合成，而非直接用半透明层底色', () => {
  // rgba(255,255,255,.10) 合成到 #1a1a1a 上 = rgb(48.9, 48.9, 48.9)
  const withComposite = evaluatePairs([
    { token: '--x', theme: '.dark', surfaceToken: 'composite', note: 'c',
      inkRgb: { r: 212, g: 212, b: 212 }, bgRgb: { r: 26, g: 26, b: 26 },
      composite: { r: 255, g: 255, b: 255, a: 0.1 } },
  ])[0];
  // 未合成（错误实现）会得到更低的对比度：合成层变亮导致比率下降
  const withoutComposite = evaluatePairs([
    { token: '--x', theme: '.dark', surfaceToken: 'no-composite', note: 'nc',
      inkRgb: { r: 212, g: 212, b: 212 }, bgRgb: { r: 26, g: 26, b: 26 } },
  ])[0];
  assert.ok(withComposite.ratio < withoutComposite.ratio,
    `合成后比率(${withComposite.ratio.toFixed(3)})应低于未合成(${withoutComposite.ratio.toFixed(3)})`);
  // 合成结果的手算锚点：亮底 #313131 上的 #d4d4d4
  assert.ok(Math.abs(withComposite.ratio - 8.78) < 0.05,
    `合成层对比度应约为 8.78，实测 ${withComposite.ratio.toFixed(3)}`);
});

test('evaluatePairs：不达标配对 pass=false（退出码逻辑的数据基础）', () => {
  const [fail] = evaluatePairs([
    { token: '--x', theme: ':root', surfaceToken: 'dark-bg', note: 'n',
      inkRgb: { r: 20, g: 20, b: 20 }, bgRgb: { r: 30, g: 30, b: 30 } },
  ]);
  assert.equal(fail.pass, false);
  assert.ok(fail.ratio < THRESHOLD);
});

test('evaluatePairs：真实样式表的全部配对均达门限（含新增 12 组）', () => {
  const pairs = collectPairs(CSS);
  const evaluated = evaluatePairs(pairs);
  const failing = evaluated.filter((p) => !p.pass);
  const failingDesc = failing
    .map((p) => `${p.token} @ ${p.theme} / ${p.surfaceToken} = ${p.ratio.toFixed(2)}`)
    .join('; ');
  assert.deepEqual(failing, [], `不达标配对：${failingDesc}`);
  // 判别力：新增配对确实被评估到
  const newEvaluated = evaluated.filter(
    (p) => p.surfaceToken === '--surface-chrome' || p.surfaceToken === '--act-bg over --surface-chrome',
  );
  assert.equal(newEvaluated.length, 12, '应为四主题 × 三组新配对 = 12 条');
});
