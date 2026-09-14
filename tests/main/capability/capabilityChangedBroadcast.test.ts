import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * CapabilityHub 变更广播静态契约。
 *
 * 重构后：Hub 写 seam 收敛为单次 replaceAll（powerManager.refresh 调用），
 * 变更信号载荷仅为 { seq }，经 capability:changed 广播给所有渲染窗口，
 * 消费端收信号后整表重取。
 * 三个旧的 Hub 写 handler（capability:register-batch / on-plugin-state-change /
 * clear）应彻底移除。
 */

const CAP_IPC_TS = path.resolve(process.cwd(), 'src/main/capability/ipc.ts')
const CAP_HUB_TS = path.resolve(process.cwd(), 'src/main/capability/CapabilityHub.ts')
const POWER_MANAGER_TS = path.resolve(process.cwd(), 'src/main/agent/powerManager.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')

describe('capability/ipc.ts — 变更广播桥接', () => {
    it('订阅 capabilityHub.onChanged 并 broadcastToAllWindows(capability:changed, { seq })', () => {
        const src = fs.readFileSync(CAP_IPC_TS, 'utf-8')
        expect(src).toContain("import { broadcastToAllWindows } from '../utils/windowBroadcast'")
        expect(src).toContain('capabilityHub.onChanged(')
        expect(src).toContain("broadcastToAllWindows('capability:changed', { seq })")
    })

    it('三个旧写 handler 已移除', () => {
        const src = fs.readFileSync(CAP_IPC_TS, 'utf-8')
        expect(src).not.toContain('capability:register-batch')
        expect(src).not.toContain('capability:on-plugin-state-change')
        expect(src).not.toContain('capability:clear')
        expect(src).not.toContain('registerBatch')
        expect(src).not.toContain('onPluginStateChange')
    })
})

describe('preload — onCapabilityChanged 桥接', () => {
    it('暴露 onCapabilityChanged 且桥接 capability:changed', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        expect(src).toContain('onCapabilityChanged')
        expect(src).toContain("ipcRenderer.on('capability:changed', handler)")
        expect(src).toContain("ipcRenderer.removeListener('capability:changed', handler)")
    })
})

describe('capabilityHub 写接口收敛', () => {
    it('Hub 不再暴露 clear/registerBatch/onPluginStateChange/onChange', () => {
        const src = fs.readFileSync(CAP_HUB_TS, 'utf-8')
        expect(src).not.toContain('registerBatch(')
        expect(src).not.toContain('onPluginStateChange(')
        expect(src).not.toContain('onChange(')
        // 只读方法保留
        expect(src).toContain('replaceAll(')
        expect(src).toContain('onChanged(')
    })

    it('全库无残留 capabilityHub.clear/registerBatch/onPluginStateChange 调用', () => {
        const src = fs.readFileSync(POWER_MANAGER_TS, 'utf-8')
        expect(src).toContain('capabilityHub.replaceAll(entries)')
        expect(src).not.toContain('capabilityHub.clear()')
        expect(src).not.toContain('capabilityHub.registerBatch(')
        expect(src).not.toContain('capabilityHub.onPluginStateChange(')
    })
})
