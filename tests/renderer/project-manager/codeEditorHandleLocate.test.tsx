// @vitest-environment jsdom
// 真实 CodeMirror（不 mock）：验证 CodeEditor 命令式句柄的对外契约——
// ref 能拿到句柄、onEditorReady 是「视图已就绪」的信号、就绪后 locate/clearLocate 可安全调用。
// 滚动与光标位置属 CodeMirror 内部行为，不在此断言（spec「Testing Decisions」）。
import {describe, it, expect} from 'vitest'
import {render, waitFor} from '@testing-library/react'
import {CodeEditor, type CodeEditorHandle} from '../../../src/renderer/project-manager/components/CodeEditor'

// jsdom 没实现 Range.getClientRects，而 CodeMirror 的文字测量（rAF 内）会调用它；
// 缺了它会在测量阶段抛未捕获异常（其余文件因此选择整体 mock CodeMirror）。
// 这里补最小桩：本文件真正要验证的是「句柄契约」，不是排版。
if (typeof Range.prototype.getClientRects !== 'function') {
  Range.prototype.getClientRects = function () { return [] as unknown as DOMRectList }
}

describe('CodeEditor 命令式句柄（工单 06）', () => {
  it('ref 挂载即拿到句柄，但视图未就绪时 locate 返回 false（调用方据此保持挂起）', () => {
    const ref: {current: CodeEditorHandle | null} = {current: null}
    render(<CodeEditor content={'aa\nbbb\ncccc'} path="a.ts" ref={ref} />)
    expect(ref.current).not.toBeNull()
    expect(ref.current!.locate(2)).toBe(false)
  })

  it('视图就绪（onEditorReady）后 locate 落地、clearLocate 可安全调用', async () => {
    const ref: {current: CodeEditorHandle | null} = {current: null}
    let ready = false
    const {container} = render(
      <CodeEditor content={'aa\nbbb\ncccc'} path="a.ts" ref={ref} onEditorReady={() => { ready = true }} />,
    )
    await waitFor(() => expect(ready).toBe(true))

    expect(ref.current!.locate(2)).toBe(true)
    // 重复定位同一行：scroll: false 只重新点亮，不滚动
    expect(ref.current!.locate(2, {scroll: false})).toBe(true)
    // 高亮落到 DOM 上（行级装饰）
    await waitFor(() => expect(container.querySelector('.cm-line-located')).not.toBeNull())
    expect(() => ref.current!.clearLocate()).not.toThrow()
  })

  it('越界行号被夹紧到有效行（不抛错）', async () => {
    const ref: {current: CodeEditorHandle | null} = {current: null}
    let ready = false
    render(<CodeEditor content={'aa\nbbb'} path="a.ts" ref={ref} onEditorReady={() => { ready = true }} />)
    await waitFor(() => expect(ready).toBe(true))
    expect(ref.current!.locate(99)).toBe(true)
    expect(ref.current!.locate(-3)).toBe(true)
  })
})
