/**
 * Ctrl/Cmd+A 文本选区抑制守卫（纯渲染层）。
 *
 * 背景：Chromium 的 Ctrl+A 是**文档级 SelectAll**，不经过主进程菜单，改 `src/main/menu.ts`
 * 无效；且 `user-select` 是继承属性，白名单容器整棵子树可选，故 Ctrl+A 会选中大片文本。
 * 唯一有效落点是渲染层 capture 阶段拦截。
 *
 * 两条动作缺一不可：
 * - `preventDefault()` 取消浏览器默认的文档级全选；
 * - `stopPropagation()` 在 document capture 阶段截断传播 —— 否则事件仍会抵达 contentDOM 上的
 *   CodeMirror keymap（其 `Mod-a` 注册在 bubble 阶段），编辑器内依旧出现 CM 自身选区。
 *
 * 豁免面仅「文本类 `<input>`」（type 白名单）与 `<textarea>`（原生全选输入框内容不变）；
 * contenteditable 与 `.cm-editor` 一律拦截，`.select-text` 容器不构成豁免。
 *
 * 单例约束：守卫按 document 全局挂载，**同一 document 只允许一个调用方**。重复调用会复用同一份
 * 安装（幂等），但任一次 cleanup 即整体卸载 —— 多调用方场景必须改为引用计数，否则先卸载者会
 * 连带拆掉其他人的守卫。
 *
 * 平台说明：`metaKey`（macOS 的 Cmd）在非 macOS 上通常被 OS / 浏览器截获而到不了页面，
 * 此处仍不按平台收窄判定 —— 保持单一路径，避免平台分支带来的行为分歧。
 *
 * 安装位置说明：监听必须注册在 capture 阶段（见 `installSelectAllGuard`），
 * 该性质由 `T6` 用例守卫，勿改为 bubble。
 */

/** 是否命中「全选」组合键：Ctrl/Cmd + A，且不含 Shift / Alt（避让其他快捷键） */
export function isSelectAllHotkey(e: KeyboardEvent): boolean {
  const mod = e.ctrlKey || e.metaKey
  return mod && !e.altKey && !e.shiftKey && (e.key === 'a' || e.key === 'A')
}

/**
 * 文本类 input 的 type 白名单（按 IDL 属性比较：未设 type 时浏览器归一化为 `'text'`，自然命中）。
 * 其余 type（checkbox / radio / range / color / file / 按钮类 / hidden / date 类）聚焦时，
 * 实测 Ctrl+A 产生的选区与 body 上完全一致（均为文档级），故不构成豁免。
 */
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text', 'search', 'tel', 'url', 'email', 'password', 'number',
])

/** 是否处于豁免面内：TEXTAREA，或 type 为文本类的 INPUT（contenteditable 与 .cm-editor 不豁免） */
export function isInputTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (el?.tagName === 'TEXTAREA') return true
  if (el?.tagName !== 'INPUT') return false
  return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type)
}

/**
 * 已挂载的卸载函数。非空即视为「已安装」——重复调用不重复挂载，
 * 同时保证 React StrictMode 的 mount → unmount → mount 序列里能重新挂上
 * （cleanup 置空后再次 install 即为全新安装）。
 */
let teardown: (() => void) | null = null

/**
 * 安装守卫（幂等）。返回卸载函数；cleanup 后再调用可重新挂载。
 */
export function installSelectAllGuard(): () => void {
  if (teardown) return teardown

  const onKeydown = (e: KeyboardEvent): void => {
    if (!isSelectAllHotkey(e)) return
    if (isInputTarget(e.target)) return
    e.preventDefault()
    e.stopPropagation()
  }

  // capture 阶段：主窗口与 PM 编辑器（CodeMirror）的 Mod-a 都注册在 contentDOM 的 bubble 阶段，
  // capture 保证我们先手。
  document.addEventListener('keydown', onKeydown, true)

  const cleanup = (): void => {
    document.removeEventListener('keydown', onKeydown, true)
    if (teardown === cleanup) teardown = null
  }
  teardown = cleanup
  return cleanup
}
