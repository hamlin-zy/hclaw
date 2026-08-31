/**
 * modelSchemeIPC — 保存校验：三个文本角色不可同时禁用
 *
 * primary / lightweight / reasoning 至少一个 enabled，否则拒绝保存。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'

const mocks = vi.hoisted(() => ({
    handlers: {} as Record<string, Function>,
    save: vi.fn(),
}))

vi.mock('electron', () => ({
    ipcMain: {
        handle: vi.fn((channel: string, fn: Function) => { mocks.handlers[channel] = fn }),
    },
    BrowserWindow: {getAllWindows: () => []},
}))
vi.mock('../../src/main/repositories/sqlite/modelSchemeRepository', () => ({
    modelSchemeRepo: {save: mocks.save, getById: vi.fn()},
}))
vi.mock('../../src/main/utils/windowBroadcast', () => ({
    broadcastToOtherWindows: vi.fn(),
}))
vi.mock('../../src/main/agent/logger', () => ({
    createLogger: () => ({info: vi.fn(), warn: vi.fn(), error: vi.fn()}),
}))

import {initModelSchemeIPC} from '../../src/main/modelSchemeIPC'

function makeScheme(textRolesEnabled: {primary: boolean; lightweight: boolean; reasoning: boolean}) {
    return {
        id: 'scheme-1', name: 't', enabled: true,
        roles: [
            {id: '1', role: 'primary', enabled: textRolesEnabled.primary, endpointId: 'p', modelId: 'm', modelType: 'text'},
            {id: '2', role: 'lightweight', enabled: textRolesEnabled.lightweight, endpointId: 'p', modelId: 'm', modelType: 'text'},
            {id: '3', role: 'reasoning', enabled: textRolesEnabled.reasoning, endpointId: 'p', modelId: 'm', modelType: 'text'},
            {id: '4', role: 'image_understanding', enabled: true, endpointId: 'p', modelId: 'm', modelType: 'image'},
        ],
    }
}

beforeEach(() => {
    vi.clearAllMocks()
    initModelSchemeIPC()
})

describe('model-scheme:save — 文本角色同时禁用校验', () => {
    it('三个文本角色全部禁用 → 拒绝保存，不落库', async () => {
        const result = await mocks.handlers['model-scheme:save']({} as any, makeScheme({
            primary: false, lightweight: false, reasoning: false,
        }))
        expect(result.success).toBe(false)
        expect(result.error).toContain('至少启用一个')
        expect(mocks.save).not.toHaveBeenCalled()
    })

    it('primary 启用（其余禁用）→ 允许保存', async () => {
        mocks.save.mockReturnValue(true)
        const result = await mocks.handlers['model-scheme:save']({} as any, makeScheme({
            primary: true, lightweight: false, reasoning: false,
        }))
        expect(result.success).toBe(true)
        expect(mocks.save).toHaveBeenCalledTimes(1)
    })

    it('lightweight 单独启用 → 允许保存（轻量可独立作为默认）', async () => {
        mocks.save.mockReturnValue(true)
        const result = await mocks.handlers['model-scheme:save']({} as any, makeScheme({
            primary: false, lightweight: true, reasoning: false,
        }))
        expect(result.success).toBe(true)
    })
})
