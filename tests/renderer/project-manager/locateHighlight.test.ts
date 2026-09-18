// 定位高亮的决策逻辑（lib/locateHighlight.ts）——纯函数单测。
//
// 只断言外部可观察的决策结果：要不要重新滚动、该不该清高亮、请求属不属于当前文件。
// 计时与 CodeMirror 派发是副作用，留在 EditorArea / CodeEditor（见 editorAreaLocate.test.tsx）。
import {describe, it, expect} from 'vitest'
import {
    LOCATE_HIGHLIGHT_MS,
    clampLine,
    isLocateTargetForActiveFile,
    planLocate,
    shouldClearLocateOnSelectionChange,
} from '../../../src/renderer/project-manager/lib/locateHighlight'

describe('planLocate：滚动决策', () => {
    it('首次定位（无上一次落点）需要滚动', () => {
        expect(planLocate(null, {path: 'src/a.ts', line: 42})).toEqual({scroll: true})
    })

    it('重复定位到同一文件的同一行：只重置计时，不重新滚动', () => {
        expect(planLocate({path: 'src/a.ts', line: 42}, {path: 'src/a.ts', line: 42})).toEqual({scroll: false})
    })

    it('行号变化需要滚动', () => {
        expect(planLocate({path: 'src/a.ts', line: 42}, {path: 'src/a.ts', line: 43})).toEqual({scroll: true})
    })

    it('路径变化即使行号相同也要滚动（编辑器视图已按新文件重建）', () => {
        expect(planLocate({path: 'src/a.ts', line: 42}, {path: 'src/b.ts', line: 42})).toEqual({scroll: true})
    })
})

describe('shouldClearLocateOnSelectionChange：用户操作优先', () => {
    it('用户手动选区变化 → 清除定位高亮', () => {
        expect(shouldClearLocateOnSelectionChange('user')).toBe(true)
    })

    it('定位自身造成的光标移动 → 不清除（否则刚点亮就被自己清掉）', () => {
        expect(shouldClearLocateOnSelectionChange('locate')).toBe(false)
    })
})

describe('isLocateTargetForActiveFile：请求归属', () => {
    it('路径命中当前激活文件 → 属于', () => {
        expect(isLocateTargetForActiveFile('src/a.ts', 'src/a.ts')).toBe(true)
    })

    it('路径不同 → 不属于（切 tab 后迟到的请求必须丢弃）', () => {
        expect(isLocateTargetForActiveFile('src/a.ts', 'src/b.ts')).toBe(false)
    })

    it('没有激活文件（空态）→ 不属于', () => {
        expect(isLocateTargetForActiveFile('src/a.ts', null)).toBe(false)
        expect(isLocateTargetForActiveFile('src/a.ts', undefined)).toBe(false)
    })
})

describe('clampLine：越界夹紧', () => {
    it('行号落在文档范围内时原样返回', () => {
        expect(clampLine(3, 10)).toBe(3)
    })

    it('超过末行 → 夹到末行；小于 1 → 夹到第 1 行', () => {
        expect(clampLine(99, 10)).toBe(10)
        expect(clampLine(0, 10)).toBe(1)
        expect(clampLine(-5, 10)).toBe(1)
    })

    it('小数向下取整，非有限值落到第 1 行', () => {
        expect(clampLine(3.7, 10)).toBe(3)
        expect(clampLine(Number.NaN, 10)).toBe(1)
    })

    it('空文档（0 行）也不返回非法行号', () => {
        expect(clampLine(5, 0)).toBe(1)
    })
})

describe('定位计时常量', () => {
    it('高亮 1500ms 后硬清除（spec §定位）', () => {
        expect(LOCATE_HIGHLIGHT_MS).toBe(1500)
    })
})
