/**
 * system.memory 段：文本修正 + {{hclawDir}} 替换。
 *
 * 依据：
 * - src/shared/prompts.ts 的 system.memory 默认值改为描述真实机制
 *   （记忆由系统以 `<system-reminder>` 追加为 user 消息，而非"去找记忆工具"），
 *   并引用 `{{hclawDir}}/mem/ref/` 占位符。
 * - src/main/agent/systemPrompt.ts 的 buildMemorySection 复用与 system.directories
 *   相同的替换写法（`.replace(/\{\{hclawDir\}\}/g, getHclawDir())`）。
 *
 * mock 头照抄 tests/main/agent/systemPrompt.mcpOcr.test.ts。
 */
import {describe, expect, it, vi} from 'vitest'
import {posix} from 'path'

const envState = vi.hoisted(() => ({
    hclawDir: '/tmp/hclaw-test',
    mcpMetas: [] as Array<{proxyName: string; rawToolName: string}>,
}))

vi.mock('../../../src/main/config', () => ({
    getHclawDir: () => envState.hclawDir,
}))
vi.mock('../../../src/main/hclawPaths', async () => await import('../../../src/main/config'))
// importOriginal 保留真实模块副作用（工具注册 → DI 容器 ToolRegistry），仅替换元数据读取
vi.mock('../../../src/main/agent/mcp/discovery', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>()
    return {...actual, getAllMcpToolMeta: () => envState.mcpMetas}
})

import {buildSystemPrompt} from '../../../src/main/agent/systemPrompt'

const CTX = {workingDir: '/x', tools: [], permissionMode: 'safe', agentType: 'General' as const}

describe('system.memory 文本修正', () => {
    it('旧的「去找记忆工具」表述已消失', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p).not.toContain('工具名含')
        expect(p).not.toContain('若未找到 → 忽略本规则')
    })

    it('描述真实机制与位置，路径已替换且无占位符残留', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain('system-reminder')
        // 注意：mock 的 hclawDir 是 posix 风格字面量，模板中为 `{{hclawDir}}/mem/ref/`，
        // 故用 posix.join 拼期望值（Windows 下 path.join 会用反斜杠，与文本不符）
        expect(p).toContain(posix.join('/tmp/hclaw-test', 'mem', 'ref'))
        expect(p).not.toContain('{{hclawDir}}')
    })

    it('无记忆文件时该段仍完整渲染（不崩、不产生空段）', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain('## 记忆与知识')
        expect(p).toContain('_user/preferences.md')
    })
})
