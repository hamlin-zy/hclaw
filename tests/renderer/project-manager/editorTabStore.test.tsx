// @vitest-environment jsdom
import {describe, it, expect, beforeEach} from 'vitest'
import {useEditorTabStore} from '../../../src/renderer/project-manager/stores/editorTabStore'

const file = (path: string, title = path) => ({path, title, content: 'x', hash: 'h-' + path})

beforeEach(() => useEditorTabStore.getState().closeAll())

describe('editorTabStore', () => {
  it('openFileTab 新建并激活', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    const s = useEditorTabStore.getState()
    expect(s.tabs).toHaveLength(1)
    expect(s.activeTabId).toBe(s.tabs[0]!.id)
  })
  it('重复打开聚焦已有 tab', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    useEditorTabStore.getState().openFileTab(file('b.ts'))
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    expect(useEditorTabStore.getState().tabs).toHaveLength(2)
    expect(useEditorTabStore.getState().activeTabId).toBe(useEditorTabStore.getState().tabs[0]!.id)
  })
  it('同一路径可有 file tab 与 diff tab 并存', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    useEditorTabStore.getState().openDiffTab({filePath: 'a.ts', title: 'Diff: a.ts', diffType: 'working-tree', diffData: {} as never})
    expect(useEditorTabStore.getState().tabs).toHaveLength(2)
  })
  it('closeOther 保留 pinned 与自身', () => {
    const st = useEditorTabStore.getState()
    st.openFileTab(file('a.ts')); st.openFileTab(file('b.ts')); st.openFileTab(file('c.ts'))
    const idB = useEditorTabStore.getState().tabs[1]!.id
    useEditorTabStore.getState().pin(idB)
    useEditorTabStore.getState().closeOther(idB)
    const tabs = useEditorTabStore.getState().tabs
    expect(tabs).toHaveLength(2)
    expect(tabs[0]!.pinned).toBe(true)
  })
  it('closeLeft / closeRight 只删一侧', () => {
    const st = useEditorTabStore.getState()
    st.openFileTab(file('a.ts')); st.openFileTab(file('b.ts')); st.openFileTab(file('c.ts'))
    const idB = useEditorTabStore.getState().tabs[1]!.id
    useEditorTabStore.getState().closeLeft(idB)
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['b.ts', 'c.ts'])
    useEditorTabStore.getState().closeRight(idB)
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['b.ts'])
  })
  it('reloadTabContent 更新内容', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    const id = useEditorTabStore.getState().tabs[0]!.id
    useEditorTabStore.getState().reloadTabContent(id, 'new', 'h2')
    expect(useEditorTabStore.getState().tabs[0]!.content).toBe('new')
    expect(useEditorTabStore.getState().tabs[0]!.fileHash).toBe('h2')
  })
  it('reloadTabContent 非激活 tab + content >2MB → 只更新 hash 不回填 content', () => {
    const big = (path: string) => ({path, title: path, content: 'x'.repeat(3 * 1024 * 1024), hash: 'h-' + path})
    useEditorTabStore.getState().openFileTab(big('a.ts'))
    useEditorTabStore.getState().openFileTab(big('b.ts'))  // a.ts 成为非激活
    const idA = useEditorTabStore.getState().tabs[0]!.id
    // a.ts 已被淘汰（content undefined）
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'a.ts')!.content).toBeUndefined()
    // 用 >2MB content 重载非激活 tab
    useEditorTabStore.getState().reloadTabContent(idA, 'x'.repeat(3 * 1024 * 1024), 'h2-big')
    const tabA = useEditorTabStore.getState().tabs.find(t => t.filePath === 'a.ts')!
    expect(tabA.fileHash).toBe('h2-big')     // hash 更新
    expect(tabA.content).toBeUndefined()      // content 未回填（保持淘汰闭环）
  })
  it('reloadTabContent 激活 tab + content >2MB → 正常回填（不被淘汰）', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    const id = useEditorTabStore.getState().tabs[0]!.id
    useEditorTabStore.getState().reloadTabContent(id, 'x'.repeat(3 * 1024 * 1024), 'h2')
    expect(useEditorTabStore.getState().tabs[0]!.content).toBe('x'.repeat(3 * 1024 * 1024))
    expect(useEditorTabStore.getState().tabs[0]!.fileHash).toBe('h2')
  })
  it('激活新 tab 时淘汰其他非 pinned 大 content（>2MB）', () => {
    const big = (path: string) => ({path, title: path, content: 'x'.repeat(3 * 1024 * 1024), hash: 'h-' + path})
    useEditorTabStore.getState().openFileTab(big('big1.ts'))
    useEditorTabStore.getState().openFileTab(big('big2.ts'))
    // 打开第二个时第一个成为非激活，被淘汰
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'big1.ts')!.content).toBeUndefined()
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'big1.ts')!.fileHash).toBe('h-big1.ts')
  })
  it('激活 diff tab 时淘汰非激活非 pinned 大 content（>2MB）', () => {
    const big = (path: string) => ({path, title: path, content: 'x'.repeat(3 * 1024 * 1024), hash: 'h-' + path})
    useEditorTabStore.getState().openFileTab(big('big.ts'))
    // 去重路径
    useEditorTabStore.getState().openDiffTab({filePath: 'big.ts', title: 'Diff: big.ts', diffType: 'working-tree', diffData: {} as never})
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'big.ts' && t.type === 'file')!.content).toBeUndefined()
    useEditorTabStore.getState().closeAll()
    // 新建路径
    useEditorTabStore.getState().openFileTab(big('big.ts'))
    useEditorTabStore.getState().openDiffTab({filePath: 'other.ts', title: 'Diff: other.ts', diffType: 'working-tree', diffData: {} as never})
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'big.ts' && t.type === 'file')!.content).toBeUndefined()
  })
  it('(a) 非激活大 diff tab 切走后 diffData 被释放', () => {
    const big = (path: string, ref = 'w') => ({
      filePath: path, title: `Diff: ${path}`, diffType: 'working-tree' as const, ref,
      diffData: {
        filePath: path, oldContent: 'a'.repeat(3 * 1024 * 1024), newContent: 'b'.repeat(3 * 1024 * 1024),
        diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'w', additions: 1, deletions: 1,
      },
    })
    useEditorTabStore.getState().openDiffTab(big('big.ts'))
    expect(useEditorTabStore.getState().tabs[0]!.diffData).toBeDefined()   // 激活中不淘汰
    useEditorTabStore.getState().openFileTab(file('other.ts'))            // diff tab 变为非激活
    const diffTab = useEditorTabStore.getState().tabs.find(t => t.type === 'diff')!
    expect(diffTab.diffData).toBeUndefined()                              // diffData 已释放
    expect(diffTab.filePath).toBe('big.ts')                               // 但 tab 与其 filePath/ref 保留
    expect(diffTab.ref).toBe('w')
  })

  it('(a2) 小 diff tab 不被淘汰 / 激活中的大 diff tab 不被淘汰', () => {
    useEditorTabStore.getState().openDiffTab({
      filePath: 'small.ts', title: 'Diff: small.ts', diffType: 'working-tree', ref: 'w',
      diffData: {filePath: 'small.ts', oldContent: 'x', newContent: 'y', diffType: 'working-tree', oldRef: 'HEAD', newRef: 'w', additions: 1, deletions: 1},
    })
    useEditorTabStore.getState().openFileTab(file('other.ts'))
    expect(useEditorTabStore.getState().tabs.find(t => t.type === 'diff')!.diffData).toBeDefined()  // <2MB 保留

    useEditorTabStore.getState().closeAll()
    useEditorTabStore.getState().openDiffTab({
      filePath: 'big.ts', title: 'Diff: big.ts', diffType: 'working-tree', ref: 'w',
      diffData: {filePath: 'big.ts', oldContent: 'a'.repeat(3 * 1024 * 1024), newContent: 'b'.repeat(3 * 1024 * 1024), diffType: 'working-tree', oldRef: 'HEAD', newRef: 'w', additions: 1, deletions: 1},
    })
    // 未切换激活 tab，激活中的大 diff tab 自身不被淘汰
    expect(useEditorTabStore.getState().tabs[0]!.diffData).toBeDefined()
  })

  it('(b) 再次激活被淘汰的 diff tab 时内容能被正确重新加载', () => {
    const big = (path: string, ref = 'w') => ({
      filePath: path, title: `Diff: ${path}`, diffType: 'working-tree' as const, ref,
      diffData: {
        filePath: path, oldContent: 'a'.repeat(3 * 1024 * 1024), newContent: 'b'.repeat(3 * 1024 * 1024),
        diffType: 'working-tree' as const, oldRef: 'HEAD', newRef: 'w', additions: 1, deletions: 1,
      },
    })
    const st = () => useEditorTabStore.getState()
    st().openDiffTab(big('big.ts'))
    const id = st().tabs[0]!.id
    st().openFileTab(file('other.ts'))                 // 淘汰 diffData
    expect(st().tabs.find(t => t.id === id)!.diffData).toBeUndefined()
    // 既有按需加载路径：Git 面板重新拉取 diff 后走 openDiffTab 回填（去重不新建 tab）
    st().openDiffTab(big('big.ts'))
    const restored = st().tabs.find(t => t.id === id)!
    expect(restored.diffData).toBeDefined()
    expect(restored.diffData!.oldContent).toHaveLength(3 * 1024 * 1024)
    expect(st().tabs).toHaveLength(2)                  // 未新建重复 tab
    expect(st().activeTabId).toBe(id)                  // 正确激活
  })

  it('pinned tab 不被淘汰', () => {
    const big = (path: string) => ({path, title: path, content: 'x'.repeat(3 * 1024 * 1024), hash: 'h-' + path})
    useEditorTabStore.getState().openFileTab(big('big1.ts'))
    const id = useEditorTabStore.getState().tabs[0]!.id
    useEditorTabStore.getState().pin(id)
    useEditorTabStore.getState().openFileTab(big('big2.ts'))
    expect(useEditorTabStore.getState().tabs.find(t => t.filePath === 'big1.ts')!.content).toBeDefined()
  })
})

describe('closeTabsForPaths', () => {
  it('关闭 filePath 命中给定文件的标签', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    useEditorTabStore.getState().openFileTab(file('b.ts'))
    useEditorTabStore.getState().closeTabsForPaths('a.ts')
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['b.ts'])
  })

  it('目录删除时按 `<dir>/` 前缀关闭其下所有标签', () => {
    useEditorTabStore.getState().openFileTab(file('src/a.ts'))
    useEditorTabStore.getState().openFileTab(file('src/lib/b.ts'))
    useEditorTabStore.getState().openFileTab(file('other/c.ts'))
    useEditorTabStore.getState().closeTabsForPaths('src')
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['other/c.ts'])
  })

  it('数组入参一次关闭多个文件（不误伤前缀相似项）', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    useEditorTabStore.getState().openFileTab(file('a.tsx'))
    useEditorTabStore.getState().openFileTab(file('b.ts'))
    useEditorTabStore.getState().closeTabsForPaths(['a.ts', 'b.ts'])
    expect(useEditorTabStore.getState().tabs.map(t => t.filePath)).toEqual(['a.tsx'])
  })

  it('diff tab（同样带 filePath）也被关闭', () => {
    useEditorTabStore.getState().openDiffTab({filePath: 'a.ts', title: '差异：a.ts', diffType: 'working-tree', diffData: {} as never})
    useEditorTabStore.getState().closeTabsForPaths('a.ts')
    expect(useEditorTabStore.getState().tabs).toHaveLength(0)
  })

  it('激活 tab 被关闭时 activeTabId 回退到剩余标签', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    useEditorTabStore.getState().openFileTab(file('b.ts'))
    const idB = useEditorTabStore.getState().tabs.find(t => t.filePath === 'b.ts')!.id
    useEditorTabStore.getState().setActive(idB)
    useEditorTabStore.getState().closeTabsForPaths('b.ts')
    const s = useEditorTabStore.getState()
    expect(s.tabs.map(t => t.filePath)).toEqual(['a.ts'])
    expect(s.activeTabId).toBe(s.tabs[0]!.id)
  })

  it('无命中时不动 state（activeTabId 保持）', () => {
    useEditorTabStore.getState().openFileTab(file('a.ts'))
    const before = useEditorTabStore.getState()
    useEditorTabStore.getState().closeTabsForPaths('nope.ts')
    const after = useEditorTabStore.getState()
    expect(after.tabs).toBe(before.tabs)
    expect(after.activeTabId).toBe(before.activeTabId)
  })
})
