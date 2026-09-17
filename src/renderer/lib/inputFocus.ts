/**
 * 文本输入类控件的**统一焦点样式**——唯一来源（single source of truth）。
 *
 * ## 为什么收敛到常量
 * 此前这段样式是**逐处复制的字符串**，实际漂移出了 6 种方言
 * （`focus:ring-*` / `focus-visible:ring-*` / 只有 `focus:border-*` / 完全没有焦点样式 …），
 * 所谓「统一」只覆盖到 2 个站点。收敛后，改一处即改全仓。
 *
 * ## 为什么是 TS 常量，而不是 globals.css 里的一个类
 * 1. `dark-all:` 是 tailwind.config.js 注册的变体（同时命中 `.dark` 与 `.yuanshandai`）。
 *    若写成 CSS 类，就得在 globals.css 里手抄一遍主题清单；新增第 5 套深色主题时
 *    会静默漏掉，而 tailwind.config.js 侧的清单**有护栏在守**（见 tmp/verify-fifth-theme.mjs
 *    所验证的那条断言）——手抄一份等于自建一条无人守的旁路。
 * 2. 仓库的令牌护栏（`tests/renderer/tokenCompliance.*`）只扫 `.ts/.tsx`，**不扫 globals.css**。
 *    样式留在 TS 里才继续受 alpha 阶梯等护栏约束。
 *
 * ## ⚠️ 禁止在本串里加 `focus:outline-none`
 * Tailwind v3 的 `outline-none` 展开是 `outline: 2px solid transparent`（**style 是 solid**，
 * 只是颜色透明），选择器权重 (0,2,0) 压过 globals.css 的
 * `input:focus-visible { outline: none }` (0,1,1)。再叠加会把 `outline-color`
 * 卷入过渡的 `transition-all`，聚焦瞬间 `outline-style` 当帧翻成 `solid`、而颜色仍是不透明的
 * `currentColor` → 渲染出一圈实心描边并在 150ms 内淡出，就是用户看到的「先闪一下」。
 * 取证与对照实验见 `tests/renderer/focusOutlineFlash.test.ts` 头部。
 *
 * ## ⚠️ 过渡只列 background-color / border-color / box-shadow，不要用 `transition-all`
 * `transition-all`（`transition-property: all`）会把 `outline-*` 一并卷入，
 * 是上面那条闪烁的第二个必要条件。`transition-colors` 与裸 `transition` 的属性表
 * **不含** `outline-color`，但也不含 `box-shadow`（焦点环就靠它淡入）。
 * 故这里显式列出三者：够用，且不会再意外过渡无关属性。
 *
 * 用法：把 `INPUT_FOCUS` 拼进该控件的 className（`${INPUT_FOCUS} ${其它布局类}`）。
 * 控件**不得**再自带 `focus:ring-*` / `focus-visible:ring-*` / `focus:outline-*`
 * ——由 `tests/renderer/inputFocusSeam.test.ts` 强制（错误态降级 `focus:border-red-*`
 * 与 `focus:border-[var(--error)]` 是唯一豁免）。
 */
export const INPUT_FOCUS =
  'focus:border-[var(--border-emphasis)] ' +
  'focus-visible:ring-2 ' +
  'focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_30%,transparent)] ' +
  'dark-all:focus-visible:ring-[color-mix(in_srgb,var(--brand-primary)_20%,transparent)] ' +
  'transition-[background-color,border-color,box-shadow]'
