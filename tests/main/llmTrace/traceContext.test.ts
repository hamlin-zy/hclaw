import {describe, it, expect} from 'vitest'

/**
 * traceContext 归因修复的防回归测试
 *
 * 背景：主会话 agentLoop 调用不传 agentType，execute.ts 用
 * `params.agentType ? 'subAgent' : 'main'` 判定 context，
 * 字符串恒为真值 → 所有调用被误标为 subAgent。
 *
 * 修复方案：入口显式声明来源（traceContext），沿
 * loop.ts → controller.run(RunParams) → executeLlmCallWithRetry(params)
 * 透传；缺省回退 'main'。
 */
const readSrc = (rel: string): string =>
    require('node:fs').readFileSync(require('node:path').resolve(process.cwd(), rel), 'utf-8')

describe('LLM 归因 traceContext（入口显式声明，防回归真值判断）', () => {
    it('execute.ts 不再用 agentType 真值判断 context', () => {
        const src = readSrc('src/main/agent/loop/execute.ts')
        expect(src).not.toMatch(/context:\s*params\.agentType\s*\?/)
        expect(src).toMatch(/context:\s*params\.traceContext\s*\?\?\s*'main'/)
    })

    it('RunParams / AgentLoopParams 声明可选 traceContext 字段并透传', () => {
        const types = readSrc('src/main/agent/loop/types.ts')
        expect(types).toContain('traceContext?: LlmTraceContextKind')
        const loop = readSrc('src/main/agent/loop.ts')
        expect(loop).toContain('traceContext?: LlmTraceContextKind')
        // 解构入参（无默认值）+ 透传给 controller.run
        const lines = loop.split('\n').map(l => l.trim())
        expect(lines).toContain('traceContext,')
        expect(lines.filter(l => l === 'traceContext,').length).toBe(2)
        expect(loop).not.toMatch(/traceContext\s*=\s*['"]/) // 不得设默认值
    })

    it('三个入口显式设置各自的 traceContext', () => {
        const worker = readSrc('src/main/agent/worker.ts')
        const scheduler = readSrc('src/main/agent/subagent/scheduler.ts')
        const cronWorker = readSrc('src/main/scheduler/schedulerAgentWorker.ts')
        expect(worker).toMatch(/traceContext:\s*'main'/)
        expect(scheduler).toMatch(/traceContext:\s*'subAgent'/)
        expect(cronWorker).toMatch(/traceContext:\s*'background'/)
    })
})
