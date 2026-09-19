import {describe, it, expect} from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * 能力获取收敛的静态源码契约（票 core-09）。
 *
 * 复用既有模式（tests/main/capability/capabilityChangedBroadcast.test.ts）：直接读源文件断言
 * 模式存在/不存在。这里守的是「不再有旁路」这条跨文件约束——行为断言（往返次数、就绪信号）
 * 在 tests/renderer/components/common/CapabilityPicker.test.tsx，本文件只钉住「没回头路」。
 */

const PICKER_TSX = path.resolve(process.cwd(), 'src/renderer/components/common/CapabilityPicker.tsx')
const IPC_TS = path.resolve(process.cwd(), 'src/main/capability/ipc.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')

const read = (p: string) => fs.readFileSync(p, 'utf-8')

describe('CapabilityPicker —— 取数收敛到 CapabilityHub', () => {
    it('取自 Hub 投影（capability.query），一次往返', () => {
        const src = read(PICKER_TSX)
        expect(src).toContain('window.electronAPI?.capability?.query?.(')
        // 单次取数：源文件里只出现一处 capability.query 调用
        expect(src.match(/capability\?\.query\?\.\(/g)).toHaveLength(1)
    })

    it('不再直连三个渲染层 store（三条旁路已删除）', () => {
        const src = read(PICKER_TSX)
        expect(src).not.toContain('useUserCommandStore')
        expect(src).not.toContain('useAgentTemplateStore')
        expect(src).not.toContain('useSkillStore')
        expect(src).not.toContain('loadCommands')
        expect(src).not.toContain('syncFromDisk')
        expect(src).not.toContain('loadSkills')
    })

    it('不再自取插件命令（插件归属改由 Hub 投影携带）', () => {
        const src = read(PICKER_TSX)
        expect(src).not.toContain('plugin?.getCommands')
        expect(src).not.toContain('plugin.getCommands')
    })

    it('不再依赖固定时长等待就绪（无 setTimeout 赌 store 完成）', () => {
        const src = read(PICKER_TSX)
        expect(src).not.toContain('setTimeout')
        expect(src).not.toContain('setInterval')
    })

    it('订阅既有变更信号（useCapabilityRefresh → capability:changed）', () => {
        const src = read(PICKER_TSX)
        expect(src).toContain('useCapabilityRefresh(')
    })

    it('启用态/插件归属由 Hub 判定：查询条件传 enabled，本地不另设口径', () => {
        const src = read(PICKER_TSX)
        expect(src).toContain('query?.({enabled: true})')
        // 不自行读取 enabled 之外的其他启用来源
        expect(src).not.toContain('pluginEnabled ===')
    })

    it('props 面保持 {selected, onSelect}，autoFocus 为可选第三参（宿主弹窗可关其自动聚焦）', () => {
        const src = read(PICKER_TSX)
        expect(src).toContain('export default function CapabilityPicker({selected, onSelect, autoFocus = true}: {')
    })
})

describe('capability IPC —— 列表出口默认裁剪正文', () => {
    it('四个列表类出口都经 applyContentPolicy', () => {
        const src = read(IPC_TS)
        for (const ch of ['capability:query', 'capability:get-by-type', 'capability:search', 'capability:plugin-groups']) {
            expect(src).toContain(`'${ch}'`)
        }
        expect(src.match(/applyContentPolicy\(/g)!.length).toBeGreaterThanOrEqual(5)
        expect(src).toContain('withContent')
    })

    it('Hub 接口面未被改动（裁剪在 IPC 层）', () => {
        const hub = read(path.resolve(process.cwd(), 'src/main/capability/CapabilityHub.ts'))
        expect(hub).not.toContain('withContent')
        expect(hub).not.toContain('content: undefined')
    })

    it('preload 桥接透传 withContent 开关', () => {
        const src = read(PRELOAD_TS)
        expect(src).toContain("ipcRenderer.invoke('capability:query', filter, options)")
        expect(src).toContain('withContent?: boolean')
    })
})
