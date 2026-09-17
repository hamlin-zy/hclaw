// locateRequestStore —— 工单 06（编辑器侧定位高亮）的请求通道。
//
// 只断言外部可观察的契约：请求内容、seq 单调前进（同路径重复请求也要前进）、reset。
import {describe, it, expect, beforeEach} from 'vitest'
import {
    requestLocate,
    useLocateRequestStore,
} from '../../../src/renderer/project-manager/stores/locateRequestStore'

beforeEach(() => { useLocateRequestStore.getState().reset() })

describe('locateRequestStore', () => {
    it('初始无请求', () => {
        expect(useLocateRequestStore.getState()).toMatchObject({path: null, line: 1, seq: 0})
    })

    it('requestLocate 记录路径与行号', () => {
        requestLocate('src/a.ts', 42)
        expect(useLocateRequestStore.getState()).toMatchObject({path: 'src/a.ts', line: 42, seq: 1})
    })

    it('重复定位同一行：seq 仍然前进（下游据此区分「再次定位」）', () => {
        requestLocate('src/a.ts', 42)
        requestLocate('src/a.ts', 42)
        requestLocate('src/a.ts', 42)
        expect(useLocateRequestStore.getState().seq).toBe(3)
        expect(useLocateRequestStore.getState()).toMatchObject({path: 'src/a.ts', line: 42})
    })

    it('行号至少为 1（夹紧非法输入）', () => {
        requestLocate('src/a.ts', 0)
        expect(useLocateRequestStore.getState().line).toBe(1)
        requestLocate('src/a.ts', 3.7)
        expect(useLocateRequestStore.getState().line).toBe(3)
    })

    it('reset 清空并归零', () => {
        requestLocate('src/a.ts', 5)
        useLocateRequestStore.getState().reset()
        expect(useLocateRequestStore.getState()).toMatchObject({path: null, line: 1, seq: 0})
    })
})
