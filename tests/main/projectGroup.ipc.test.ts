import {describe, expect, it} from 'vitest'
import fs from 'fs'
import path from 'path'

const IPC_TS = path.resolve(process.cwd(), 'src/main/ipc/projectGroupIPC.ts')
const PRELOAD_TS = path.resolve(process.cwd(), 'src/preload/index.ts')
const ENV_DTS = path.resolve(process.cwd(), 'src/renderer/env.d.ts')
const MAIN_TS = path.resolve(process.cwd(), 'src/main/index.ts')

/**
 * preload 的方法名 → IPC 通道名契约。`remove` 在通道侧叫 `project-group:delete`，
 * 是整份映射里唯一一个「名字对不上」的，也是最容易写错的一处，故显式钉死。
 */
const PROJECT_GROUP_METHODS: Array<[method: string, channel: string]> = [
    ['list', 'project-group:list'],
    ['create', 'project-group:create'],
    ['rename', 'project-group:rename'],
    ['dissolve', 'project-group:dissolve'],
    ['remove', 'project-group:delete'],
    ['assign', 'project-group:assign'],
    ['reorderGroups', 'project-group:reorder'],
    ['reorderProjects', 'project-group:reorder'],
]

/**
 * 从 preload 源码里抽出 `projectGroup: { ... }` 块（按花括号配平，容忍任意空白 / 折行）。
 * 找不到或花括号不配平时抛错——保证「整块被删」必然让测试因正确原因 RED。
 */
function extractProjectGroupBlock(src: string): string {
    const m = /projectGroup\s*:\s*\{/.exec(src)
    if (!m) throw new Error('preload 中未找到 projectGroup 块（块被删除？）')
    const open = src.indexOf('{', m.index)
    let depth = 0
    for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++
        else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1)
    }
    throw new Error('projectGroup 块花括号不配平')
}

/**
 * project-group 通道契约静态测试（仿 tests/main/conversationsDialog.load.test.ts 的做法：
 * 这些 handler 依赖 electron runtime，静态断言比 jsdom/node 真跑 IPC 更稳、更便宜）。
 */
describe('project-group IPC 通道契约', () => {
    it('七个通道全部注册，前缀为小写单词风格 project-group:', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        for (const ch of ['list', 'create', 'rename', 'dissolve', 'delete', 'assign', 'reorder']) {
            expect(src).toContain(`'project-group:${ch}'`)
        }
        // 反向守卫：不得出现 camelCase 前缀
        expect(src).not.toContain("'projectGroup:")
    })

    it('electron 惰性加载（保持主进程装配时机，仿 configIPC）', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        expect(src).toContain('export function initProjectGroupIPC')
        expect(src).not.toMatch(/^import .*from 'electron'/m)
        expect(src).toContain("require('electron')")
    })

    it('create 校验名称非空并生成 id', () => {
        const src = fs.readFileSync(IPC_TS, 'utf-8')
        expect(src).toContain("!name || !name.trim()")
        // 钉死 id 生成表达式本身，而不是它的前缀（'pg-' 在别处也可能出现，守不住什么）
        expect(src).toContain('`pg-${crypto.randomUUID()}`')
    })

    it('index.ts 注册 initProjectGroupIPC', () => {
        const src = fs.readFileSync(MAIN_TS, 'utf-8')
        expect(src).toContain('initProjectGroupIPC')
        expect(src).toContain('initProjectGroupIPC()')
    })

    it('preload 暴露 electronAPI.projectGroup.*（八个方法，各自映射到正确通道）', () => {
        const src = fs.readFileSync(PRELOAD_TS, 'utf-8')
        const block = extractProjectGroupBlock(src)

        // 八个方法都必须出现在块内，并记下它们在块中的位置
        const entries = PROJECT_GROUP_METHODS.map(([method, channel]) => {
            const idx = new RegExp(`(^|[^\\w])${method}\\s*:`).exec(block)?.index ?? -1
            return {method, channel, idx}
        }).sort((a, b) => a.idx - b.idx)

        for (const {method, idx} of entries) {
            expect(idx, `preload projectGroup 缺少方法 ${method}`).toBeGreaterThanOrEqual(0)
        }

        // 每个方法「一直到下一个方法」的片段里，只允许出现它自己该 invoke 的那一个通道字面量。
        // 这样既钉死了方法→通道映射，又对参数名、折行、空白完全免疫。
        entries.forEach((entry, i) => {
            const end = i + 1 < entries.length ? entries[i + 1].idx : block.length
            const channels = block.slice(entry.idx, end).match(/'project-group:[^']*'/g) ?? []
            expect(channels, `preload projectGroup.${entry.method} 的通道映射不对`).toEqual([`'${entry.channel}'`])
        })

        // 显式钉死 remove → 'project-group:delete'（delete 语义只体现在通道名上，类型系统拦不住）
        expect(block).toContain("'project-group:delete'")
    })

    it('env.d.ts 声明 projectGroup 命名空间', () => {
        const src = fs.readFileSync(ENV_DTS, 'utf-8')
        expect(src).toContain('projectGroup: {')
        expect(src).toContain("import('../shared/types/projectGroup').ProjectGroupWithMembers")
    })
})
