// @vitest-environment jsdom
/**
 * 渲染脚手架：window.electronAPI mock 工厂 + 渲染包装。
 *
 * 目标：为组件级测试提供最小可用的 electronAPI 替身（含 capability 变更广播），
 * 并暴露广播句柄，便于断言「capability:changed → 页面自动刷新」这类订阅接线。
 * 供 CommandsDialog 试点及后续三个页面的验收用例复用。
 */
import {render, type RenderResult} from '@testing-library/react'
import {vi} from 'vitest'
import type {ReactElement} from 'react'

type AnyRecord = Record<string, any>

export interface ElectronApiMock {
    /** 注入到 window.electronAPI 的替身对象 */
    api: AnyRecord
    /** 模拟主进程广播 capability:changed */
    emitCapabilityChanged: (seq?: number) => void
    /** 当前 capability:changed 订阅者数量 */
    capabilityListenerCount: () => number
}

/** 深合并（用于把 overrides 合入默认替身，保留未覆盖的方法） */
function mergeDeep(base: AnyRecord, overrides: AnyRecord): AnyRecord {
    const out: AnyRecord = {...base}
    for (const [k, v] of Object.entries(overrides)) {
        if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object') {
            out[k] = mergeDeep(out[k], v)
        } else {
            out[k] = v
        }
    }
    return out
}

/**
 * 构造 electronAPI 替身。
 *
 * @param overrides 覆盖默认替身（深层合并）
 * @param sharedHandlers 复用外部订阅集合（vi.mock 工厂与测试间共享广播通道时传入）
 */
export function createElectronApiMock(
    overrides: AnyRecord = {},
    sharedHandlers?: Set<(data: {seq: number}) => void>,
): ElectronApiMock {
    const handlers = sharedHandlers ?? new Set<(data: {seq: number}) => void>()
    const emitCapabilityChanged = (seq = 1) => handlers.forEach((h) => h({seq}))

    const base: AnyRecord = {
        dialogType: 'commands',
        capability: {
            getByType: vi.fn(async () => []),
            onCapabilityChanged: vi.fn((cb: (data: {seq: number}) => void) => {
                handlers.add(cb)
                return () => handlers.delete(cb)
            }),
        },
        pluginCommand: {
            getOverrides: vi.fn(async () => []),
            upsertOverride: vi.fn(async () => ({success: true})),
            deleteOverride: vi.fn(async () => ({success: true})),
        },
        command: {
            getUserCommands: vi.fn(async () => ({success: true, data: []})),
            create: vi.fn(async () => ({success: true})),
            update: vi.fn(async () => ({success: true})),
            delete: vi.fn(async () => ({success: true})),
            toggle: vi.fn(async () => ({success: true})),
            resetPresets: vi.fn(async () => ({success: true})),
        },
        showItemInFolder: vi.fn(),
    }

    return {
        api: mergeDeep(base, overrides),
        emitCapabilityChanged,
        capabilityListenerCount: () => handlers.size,
    }
}

export interface RenderWithStoresOptions {
    /** 提供时写入 window.electronAPI */
    api?: AnyRecord
    /** 渲染前注入真实 zustand store 初始态：{store, state}（store 需含 setState） */
    stores?: Array<{setState: (partial: any) => void; state: any}>
}

export function renderWithStores(
    ui: ReactElement,
    options: RenderWithStoresOptions = {},
): RenderResult & {api?: AnyRecord} {
    if (options.api) vi.stubGlobal('electronAPI', options.api)
    for (const s of options.stores ?? []) s.setState(s.state)
    return Object.assign(render(ui), {api: options.api})
}
