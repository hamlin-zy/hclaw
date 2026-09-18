import {describe, it, expect, vi, beforeEach} from 'vitest'

/**
 * capability:* 通道契约测试（既有 seam：mock ipcMain 捕获 handler 注册表，直接调用通道）。
 *
 * 覆盖票 core-09 的传输侧两条：
 *   1. 列表类出口（query / get-by-type / search / plugin-groups）默认**不外发能力正文**，
 *      显式 `withContent: true` 才带；
 *   2. 正文裁剪落在 IPC 层 —— CapabilityHub 的只读投影接口未被改动（Hub 只负责投影，
 *      裁剪不改变 hub 内部状态：同一 filter 再查仍能拿到完整条目）。
 */

type Handler = (e: unknown, ...args: any[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
    ipcMain: {handle: (ch: string, fn: Handler) => { handlers.set(ch, fn) }},
    BrowserWindow: {getAllWindows: () => []},
}))

import {registerCapabilityIPC} from '../../../src/main/capability/ipc'
import {capabilityHub} from '../../../src/main/capability/CapabilityHub'
import type {CapabilityEntry} from '../../../src/main/capability/types'

const entry = (over: Partial<CapabilityEntry> & Pick<CapabilityEntry, 'id' | 'name' | 'type'>): CapabilityEntry => ({
    description: '',
    source: 'builtin',
    enabled: true,
    searchText: '',
    ...over,
})

const SKILL_BODY = 'x'.repeat(4096)

function seedHub(): void {
    capabilityHub.replaceAll([
        entry({id: 's1', name: 'tdd', type: 'skill', content: SKILL_BODY, description: '测试驱动开发'}),
        entry({id: 'a1', name: 'Implementer', type: 'agent', content: '系统提示正文', description: '实现代理'}),
        entry({id: 'cmd:deploy', name: 'deploy', type: 'command', source: 'user', content: '# deploy', enabled: false}),
        entry({id: 'cmd:p:hello', name: 'hello', type: 'command', source: 'plugin', pluginName: 'demo', pluginEnabled: true, content: '# hello'}),
    ])
}

beforeEach(() => {
    handlers.clear()
    registerCapabilityIPC()
    seedHub()
})

const call = (ch: string, ...args: any[]) => handlers.get(ch)!(null, ...args) as any

describe('capability:* 列表出口的正文裁剪', () => {
    it('query 默认剔除 content（键不存在，不留 undefined 占位）', () => {
        const rows = call('capability:query', {})
        expect(rows).toHaveLength(4)
        for (const row of rows) {
            expect('content' in row).toBe(false)
        }
        // 非正文的投影字段原样保留
        expect(rows.find((r: any) => r.id === 's1')).toMatchObject({name: 'tdd', type: 'skill', searchText: 'tdd 测试驱动开发'})
    })

    it('query 显式 withContent: true 时带正文', () => {
        const rows = call('capability:query', {}, {withContent: true})
        expect(rows.find((r: any) => r.id === 's1').content).toBe(SKILL_BODY)
    })

    it('get-by-type 默认剔除 content，开关打开后带回', () => {
        expect('content' in call('capability:get-by-type', 'skill')[0]).toBe(false)
        expect(call('capability:get-by-type', 'skill', {withContent: true})[0].content).toBe(SKILL_BODY)
    })

    it('search 默认剔除 content，开关打开后带回', () => {
        const rows = call('capability:search', 'tdd')
        expect(rows.length).toBeGreaterThan(0)
        expect(rows.every((r: any) => !('content' in r))).toBe(true)
        expect(call('capability:search', 'tdd', {withContent: true})[0].content).toBe(SKILL_BODY)
    })

    it('plugin-groups 的 entries 同样受裁剪，开关打开后带回', () => {
        const groups = call('capability:plugin-groups')
        expect(groups).toHaveLength(1)
        expect(groups[0].name).toBe('demo')
        expect('content' in groups[0].entries[0]).toBe(false)
        expect(call('capability:plugin-groups', undefined, {withContent: true})[0].entries[0].content).toBe('# hello')
    })

    it('get（单条详情出口）默认带正文，可显式裁剪', () => {
        expect(call('capability:get', 's1').content).toBe(SKILL_BODY)
        expect(call('capability:get', 's1', {withContent: false}).content).toBeUndefined()
        expect(call('capability:get', 'missing')).toBeNull()
    })

    it('裁剪只作用于传输：hub 内部投影未受影响（同 filter 再查仍完整）', () => {
        call('capability:query', {})
        const rows = call('capability:query', {}, {withContent: true})
        expect(rows.find((r: any) => r.id === 's1').content).toBe(SKILL_BODY)
    })

    it('filter 透传（enabled 过滤由 Hub 判定，IPC 不重新解释）', () => {
        const enabledRows = call('capability:query', {enabled: true})
        expect(enabledRows.map((r: any) => r.id).sort()).toEqual(['a1', 'cmd:p:hello', 's1'])
        const disabledRows = call('capability:query', {enabled: false})
        expect(disabledRows.map((r: any) => r.id)).toEqual(['cmd:deploy'])
    })
})
