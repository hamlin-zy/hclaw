import {describe, it, expect} from 'vitest'

// R1：Ctrl+K 数据源正交——目录改造不得影响 palette IPC handler 的数据来源。
// handler 内部直接读 CommandDispatcher/registries；此处锁死相关模块的 import 边界
// （结构性断言）。
describe('R1 palette source orthogonality', () => {
    it('commands.ts 模块不 import catalogInjector/catalogPublish', async () => {
        const src = await import('fs/promises')
        const text = await src.readFile('src/main/plugin/commands.ts', 'utf8')
        expect(text).not.toMatch(/catalogInjector|catalogPublish/)
    })

    it('catalogInjector 不再 import CommandDispatcher', async () => {
        const src = await import('fs/promises')
        const text = await src.readFile('src/main/agent/skills/catalogInjector.ts', 'utf8')
        expect(text).not.toMatch(/CommandDispatcher|agentRegistry/)
    })
})
