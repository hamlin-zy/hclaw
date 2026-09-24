// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest'
import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {createElement} from 'react'
import {act, render} from '@testing-library/react'
import {
  installSelectAllGuard,
  isInputTarget,
  isSelectAllHotkey,
} from '../../../src/renderer/lib/selectionGuard'
import {ProjectManagerApp} from '../../../src/renderer/project-manager/ProjectManagerApp'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'
import {useFileTreeStore} from '../../../src/renderer/project-manager/stores/fileTreeStore'

/** 派发一次 Ctrl+A keydown；返回 false 表示被 preventDefault（即被拦截） */
function dispatchCtrlA(target: EventTarget): boolean {
  return target.dispatchEvent(new KeyboardEvent('keydown', {key: 'a', ctrlKey: true, bubbles: true, cancelable: true}))
}

/** 派发任意组合键；返回 false 表示被拦截 */
function dispatchKey(target: EventTarget, init: KeyboardEventInit): boolean {
  return target.dispatchEvent(new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init}))
}

/** 造一棵 CodeMirror 形状的 DOM（.cm-editor > .cm-content[contenteditable]），返回最内层 contentDOM */
function createCmTree(): HTMLElement {
  const editor = document.createElement('div')
  editor.className = 'cm-editor'
  const content = document.createElement('div')
  content.className = 'cm-content'
  content.setAttribute('contenteditable', 'true')
  editor.appendChild(content)
  document.body.appendChild(editor)
  return content
}

let cleanup: (() => void) | null = null

afterEach(() => {
  cleanup?.()
  cleanup = null
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // 模块级单例兜底复位：渲染级用例的守卫由 React 主动挂载，测试端拿不到安装返回的 cleanup。
  // 若不复位，残留的 teardown 会让后续用例的 install 变成空操作（守卫已装 → 直接复用），
  // 新用例将「看似在岗实则依赖前一例」，或反过来假绿。install() 幂等：已安装时返回既有
  // cleanup，调用即卸载监听并把 teardown 置空；未安装时挂上再卸，等价无害。
  installSelectAllGuard()()
  // dialogWindow 渲染级用例的模块桩兜底清理：用例中途断言失败时也不会漏
  vi.doUnmock('../../../src/renderer/components/ConfigDialogWindow')
})

describe('isSelectAllHotkey — 组合键判定', () => {
  it('Ctrl+A / Cmd+A 命中；Shift 或 Alt 参与、单独 A 均不命中', () => {
    expect(isSelectAllHotkey(new KeyboardEvent('keydown', {key: 'a', ctrlKey: true}))).toBe(true)
    expect(isSelectAllHotkey(new KeyboardEvent('keydown', {key: 'A', metaKey: true}))).toBe(true)
    expect(isSelectAllHotkey(new KeyboardEvent('keydown', {key: 'a', ctrlKey: true, shiftKey: true}))).toBe(false)
    expect(isSelectAllHotkey(new KeyboardEvent('keydown', {key: 'a', ctrlKey: true, altKey: true}))).toBe(false)
    expect(isSelectAllHotkey(new KeyboardEvent('keydown', {key: 'a'}))).toBe(false)
  })
})

describe('isInputTarget — 豁免面仅「文本类 INPUT / TEXTAREA」', () => {
  it('文本类 INPUT / TEXTAREA 豁免；contenteditable、.cm-editor、.select-text、body 均不豁免', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    const selectText = document.createElement('div')
    selectText.className = 'select-text'
    expect(isInputTarget(input)).toBe(true)
    expect(isInputTarget(textarea)).toBe(true)
    expect(isInputTarget(editable)).toBe(false)
    expect(isInputTarget(createCmTree())).toBe(false)
    expect(isInputTarget(selectText)).toBe(false)
    expect(isInputTarget(document.body)).toBe(false)
    expect(isInputTarget(null)).toBe(false)
  })
})

describe('T1 普通区域 Ctrl+A 被拦下', () => {
  it('body 上派发 Ctrl+A 返回 false，且 defaultPrevented 为 true', () => {
    cleanup = installSelectAllGuard()
    expect(dispatchCtrlA(document.body)).toBe(false)
    const evt = new KeyboardEvent('keydown', {key: 'a', metaKey: true, bubbles: true, cancelable: true})
    document.body.dispatchEvent(evt)
    expect(evt.defaultPrevented).toBe(true)
  })
})

describe('T2 输入框 Ctrl+A 放行（未误伤）', () => {
  it('input / textarea 上派发 Ctrl+A 返回 true（同用例内含「守卫在岗」正向对照）', () => {
    cleanup = installSelectAllGuard()
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    document.body.append(input, textarea)
    // 正向对照：同一守卫在普通区域必须拦下。先证「守卫在岗」，下面的 true 才排除了
    // 「守卫压根没装上」这类假绿（守卫整体卸载后，本用例若无此对照仍会通过）。
    expect(dispatchCtrlA(document.body)).toBe(false)
    expect(dispatchCtrlA(input)).toBe(true)
    expect(dispatchCtrlA(textarea)).toBe(true)
  })
})

describe('T3 编辑器内 Ctrl+A 同样拦下', () => {
  it('contenteditable 与 .cm-editor 后代上派发 Ctrl+A 返回 false', () => {
    cleanup = installSelectAllGuard()
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.appendChild(editable)
    expect(dispatchCtrlA(editable)).toBe(false)
    expect(dispatchCtrlA(createCmTree())).toBe(false)
  })
})

describe('T4 组合键边界不拦', () => {
  it('Ctrl+Shift+A / Ctrl+Alt+A / 仅 A 返回 true（同用例内含「守卫在岗」正向对照）', () => {
    cleanup = installSelectAllGuard()
    // 正向对照：本用例三条断言的目标都是 document.body，若守卫未挂上则它们天然为 true。
    // 先证同区域的 Ctrl+A 被拦（守卫在岗），三条「不拦」才排除了假绿。
    expect(dispatchCtrlA(document.body)).toBe(false)
    expect(dispatchKey(document.body, {key: 'a', ctrlKey: true, shiftKey: true})).toBe(true)
    expect(dispatchKey(document.body, {key: 'a', ctrlKey: true, altKey: true})).toBe(true)
    expect(dispatchKey(document.body, {key: 'a'})).toBe(true)
  })
})

describe('T5 .select-text 容器不构成豁免', () => {
  it('.select-text 内的目标返回 false', () => {
    cleanup = installSelectAllGuard()
    const container = document.createElement('div')
    container.className = 'select-text'
    const inner = document.createElement('span')
    inner.textContent = '可选文本'
    container.appendChild(inner)
    document.body.appendChild(container)
    expect(dispatchCtrlA(inner)).toBe(false)
  })
})

// 本用例同时守卫「安装必须是 capture 阶段」这一性质：若把监听从 capture 改成 bubble，
// contentDOM 上的 keymap 监听先于守卫收到事件，计数将不再是 0，用例即变红。
describe('T6 stopPropagation 生效（编辑器 keymap 收不到事件）', () => {
  it('contentDOM 上的 bubble 监听器计数为 0；卸载后同一监听器恢复计数', () => {
    const content = createCmTree()
    let count = 0
    // CodeMirror keymap 的注册位置：contentDOM，bubble 阶段
    content.addEventListener('keydown', () => { count++ })

    cleanup = installSelectAllGuard()
    dispatchCtrlA(content)
    expect(count).toBe(0)

    // 判别力对照：卸载后事件可正常抵达该监听器（证明计数器本身有效，0 不是假阴性）
    cleanup()
    cleanup = null
    dispatchCtrlA(content)
    expect(count).toBe(1)
  })
})

describe('T7 卸载函数移除监听', () => {
  it('卸载后同一目标返回 true', () => {
    const off = installSelectAllGuard()
    expect(dispatchCtrlA(document.body)).toBe(false)
    off()
    expect(dispatchCtrlA(document.body)).toBe(true)
  })
})

// 本用例固化的是「任一次 cleanup 即整体卸载」语义（与模块级单例约束配套：同一 document 只允许
// 一个调用方，故不需要引用计数）。若后续引入多调用方，这里应连同实现一起改为引用计数语义。
describe('T8 install 幂等', () => {
  it('重复 install 只挂一次监听；一次 cleanup 即完全卸载', () => {
    const spy = vi.spyOn(document, 'addEventListener')
    const off1 = installSelectAllGuard()
    const off2 = installSelectAllGuard()
    expect(spy.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1)
    spy.mockRestore()

    expect(dispatchCtrlA(document.body)).toBe(false)
    off1()
    expect(dispatchCtrlA(document.body)).toBe(true)
    off2()
    expect(dispatchCtrlA(document.body)).toBe(true)
  })

  it('兼容 mount → unmount → mount（cleanup 后可重新挂上）', () => {
    const off1 = installSelectAllGuard()
    off1()
    expect(dispatchCtrlA(document.body)).toBe(true)
    cleanup = installSelectAllGuard()
    expect(dispatchCtrlA(document.body)).toBe(false)
  })
})

describe('T9 非文本 input 不豁免（实测：聚焦 checkbox / range 时 Ctrl+A 仍为文档级全选）', () => {
  it('checkbox / radio / range / color / file / 按钮类 / hidden / date 类聚焦时返回 false', () => {
    cleanup = installSelectAllGuard()
    const nonTextTypes = [
      'checkbox', 'radio', 'range', 'color', 'file',
      'button', 'submit', 'reset', 'image', 'hidden', 'date', 'datetime-local', 'month', 'week', 'time',
    ]
    for (const type of nonTextTypes) {
      const el = document.createElement('input')
      el.type = type
      document.body.appendChild(el)
      el.focus()
      expect(dispatchCtrlA(el), `input[type=${type}] 应被拦截`).toBe(false)
    }
  })

  it('文本类 input（text / search / tel / url / email / password / number 及未设 type）返回 true', () => {
    cleanup = installSelectAllGuard()
    // 正向对照：本用例断言全为「放行（true）」，若守卫压根没装上也会全绿。
    // 先证同一次安装下普通区域被拦下（守卫在岗），下面的 true 才说明是豁免面生效而非守卫缺席。
    expect(dispatchCtrlA(document.body)).toBe(false)
    const textTypes = ['text', 'search', 'tel', 'url', 'email', 'password', 'number']
    for (const type of textTypes) {
      const el = document.createElement('input')
      el.type = type
      document.body.appendChild(el)
      el.focus()
      expect(dispatchCtrlA(el), `input[type=${type}] 应放行`).toBe(true)
    }
    // 未设 type：浏览器（含 jsdom）把 IDL 属性归一化为 'text'，自然命中白名单
    const bare = document.createElement('input')
    document.body.appendChild(bare)
    expect(bare.type).toBe('text')
    bare.focus()
    expect(dispatchCtrlA(bare)).toBe(true)
  })
})

describe('T10 .cm-editor 外层容器作 target 同样拦截', () => {
  it('.cm-editor 容器本身（非 contentDOM）上派发 Ctrl+A 返回 false', () => {
    cleanup = installSelectAllGuard()
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    document.body.appendChild(editor)
    expect(dispatchCtrlA(editor)).toBe(false)
  })
})

describe('T11 Cmd+Shift+A 放行（含 metaKey 路径的组合键边界）', () => {
  it('metaKey + shiftKey 返回 true（同用例内含「守卫在岗」正向对照）', () => {
    cleanup = installSelectAllGuard()
    // 正向对照：目标同为 document.body，无此对照则「守卫未挂上」时也会绿。
    // 用 ctrlKey 版本作对照，顺带说明「在岗」与「放行」是同一次安装下的两种结果。
    expect(dispatchCtrlA(document.body)).toBe(false)
    expect(dispatchKey(document.body, {key: 'a', metaKey: true, shiftKey: true})).toBe(true)
  })
})

describe('T12 isInputTarget 收到非元素 target 不抛错且不豁免', () => {
  it('document / window / null 返回 false', () => {
    expect(isInputTarget(document)).toBe(false)
    expect(isInputTarget(window)).toBe(false)
    expect(isInputTarget(null)).toBe(false)
  })
})

// ---------- 挂载点断言：分「源码级（文本）」与「渲染级（运行时）」两层 ----------
//
// 背景：源码正则只证「文件里写了挂载语句」，不证 hook 在运行时生效 —— 把同一行搬进一个
// 永不渲染的死组件里，文本断言照样全绿（假绿）。故 PM 窗口与配置窗口另补渲染级用例：
// 真实渲染入口后，断言 document 上的 Ctrl+A 确实被拦下（守卫在岗）。

/** 读取仓库根下的源文件（jsdom 环境下 import.meta.url 不是 file scheme，改用 vitest 根定位） */
function readSource(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), 'utf8')
}

const MOUNT_RE = /useEffect\(\s*\(\)\s*=>\s*installSelectAllGuard\(\)/

describe('挂载点断言 · 源码级（文本）', () => {
  it('App.tsx 存在挂载语句（文本级：只证「写了」，不证 hook 生效）', () => {
    // 【局限声明】本断言是源码正则，无法排除「把这一行搬进永不渲染的死组件」这类变异。
    // 主窗口未做渲染级验证的原因：App 的依赖面过大（30+ store / 服务 / 子组件），
    // jsdom 渲染需要一整套无限补充的桩，收益不抵脆弱性。
    // 运行时等价证据由下方两条渲染级用例（PM 窗口 / 配置窗口）承担 —— 三处挂载共用同一工具、
    // 同一写法、同一 document 级单例语义。
    expect(readSource('src/renderer/App.tsx')).toMatch(MOUNT_RE)
  })

  it('ProjectManagerApp.tsx / dialogWindow.tsx 存在挂载语句（与下方渲染级用例互补）', () => {
    expect(readSource('src/renderer/project-manager/ProjectManagerApp.tsx')).toMatch(MOUNT_RE)
    // 配置类窗口（含记忆管理 CodeMirror 编辑器）：设计稿 §3.2 落点表 + D2
    expect(readSource('src/renderer/dialogWindow.tsx')).toMatch(MOUNT_RE)
  })
})

/** PM 窗口最小 API 桩（对齐 tests/renderer/project-manager/ProjectManagerApp.test.tsx 的既有做法） */
function stubPmApi(): void {
  vi.stubGlobal('electronAPI', {
    projectManager: {
      workspacePath: '/ws',
      listDirectory: vi.fn(async () => []),
      gitStatus: vi.fn(async () => ({statusMap: {}, additions: 0, deletions: 0, updatedAt: 1})),
      gitLog: vi.fn(async () => []),
      gitBranches: vi.fn(async () => []),
      onStatusChanged: vi.fn(() => () => {}),
      onRefsChanged: vi.fn(() => () => {}),
      onFileChanged: vi.fn(() => () => {}),
    },
  })
}

/** 取出本次渲染期间注册到 document 捕获阶段的 keydown 监听（仅用于断言；单例复位见 afterEach 兜底） */
function captureKeydownHandlers(spy: {mock: {calls: unknown[][]}}): EventListener[] {
  return spy.mock.calls
    .filter(([type, , capture]) => type === 'keydown' && capture === true)
    .map(([, handler]) => handler as EventListener)
}

describe('挂载点断言 · 渲染级（运行时：守卫确实在岗）', () => {
  it('渲染 ProjectManagerApp 后 document 上的 Ctrl+A 被拦', () => {
    stubPmApi()
    localStorage.clear()
    useEditorTabStore.getState().closeAll()
    useFileTreeStore.setState({expanded: new Set(), childrenCache: {}, cacheOrder: [], selectedPath: null})

    // 渲染前：无人守卫，Ctrl+A 放行
    expect(dispatchCtrlA(document.body)).toBe(true)

    const spy = vi.spyOn(document, 'addEventListener')
    const view = render(createElement(ProjectManagerApp))
    const handlers = captureKeydownHandlers(spy)
    spy.mockRestore()

    expect(handlers.length).toBeGreaterThan(0)          // 挂载点真的注册了捕获监听
    expect(dispatchCtrlA(document.body)).toBe(false)    // 且行为上确实拦下

    // 卸载走安装时返回的 cleanup：view.unmount() 触发 effect destroy（React 调用的正是该 cleanup）。
    // 不在此手动 removeEventListener —— 那样只摘掉监听、模块内 teardown 仍非空，会污染后续用例。
    view.unmount()
  })

  it('渲染 dialogWindow 入口后 document 上的 Ctrl+A 被拦', async () => {
    // 该入口在模块顶层执行 ReactDOM.createRoot(...).render(...)，导入即真实渲染（含其 useEffect 挂载）。
    document.body.innerHTML = '<div id="root"></div>'
    // 桩掉该入口唯一的重依赖（配置弹窗组件），避免把本文件拖进 electronAPI 的深水区
    vi.doMock('../../../src/renderer/components/ConfigDialogWindow', () => ({default: () => null}))

    expect(dispatchCtrlA(document.body)).toBe(true)

    const spy = vi.spyOn(document, 'addEventListener')
    // 模块副作用（createRoot().render）在 act 内执行并等 React 提交：既避免 act 警告，也确保 effect 已跑
    await act(async () => {
      await import('../../../src/renderer/dialogWindow')
      await new Promise(r => setTimeout(r, 0))
    })
    const handlers = captureKeydownHandlers(spy)
    spy.mockRestore()

    expect(handlers.length).toBeGreaterThan(0)
    expect(dispatchCtrlA(document.body)).toBe(false)

    // 该入口在模块顶层 createRoot().render(...)，测试端没有卸载途径拿到其 cleanup，
    // 单例复位与 doMock 清理统一交给 afterEach 兜底。
  })
})
