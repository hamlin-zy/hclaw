/**
 * 复现性诊断测试：openai SDK 默认 maxRetries 在 429 + retry-after 下的阻塞行为
 *
 * 这是「缺陷复现」测试（Phase 4 第 1 步：先建立失败测试）。
 * 用本地 HTTP server 模拟 opencode 网关的 429 + retry-after: 26905 响应，
 * 验证 SDK 默认配置（无 maxRetries）会长时间阻塞（本测试只验证首轮等待即不快速失败）。
 *
 * 注意：本测试不直接断言「会卡 7 小时」（不实际等待），
 * 而是断言：429 场景下 adapter.chat() 在无 abort 时不会在短时间(3s)内
 * 产出 error chunk —— 即证实「错误没有及时到达 UI」这一缺陷。
 */
import {describe, expect, it} from 'vitest'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import OpenAI from 'openai'
import {OpenAIAdapter} from '../../../../src/main/agent/model/openaiAdapter'
import type {ChatMessage} from '../../../../src/main/agent/model/types'

function makeUser(text: string): ChatMessage {
    return {role: 'user', content: text}
}

/** 启动一个返回 429 + retry-after + GoUsageLimitError 的本地服务器 */
function start429Server(): Promise<{server: http.Server; url: string}> {
    return new Promise((resolve) => {
        const server = http.createServer((_req, res) => {
            res.writeHead(429, {
                'Content-Type': 'application/json;charset=UTF-8',
                'Retry-After': '26905',
            })
            res.end(JSON.stringify({
                type: 'error',
                error: {
                    type: 'GoUsageLimitError',
                    message: 'Weekly usage limit reached. Resets in 7hr 29min.',
                },
            }))
        })
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address() as AddressInfo
            resolve({server, url: `http://127.0.0.1:${port}`})
        })
    })
}

describe('OpenAIAdapter 429 缺陷复现（SDK 默认重试阻塞）', () => {
    it('真实 SDK 默认配置：429 错误在短时间内不会到达调用方（缺陷存在性）', async () => {
        const {server, url} = await start429Server()
        try {
            // 模拟 OpenAIAdapter 真实构造：new OpenAI({apiKey, baseURL})，不传 maxRetries
            const client = new OpenAI({apiKey: 'test-key', baseURL: url})
            const adapter = new OpenAIAdapter(
                {apiKey: 'test-key', model: 'deepseek-v4-flash', provider: 'openai', baseUrl: url} as any,
                client as any,
            )

            const chunks: any[] = []
            // 只等 3 秒：若 SDK 正确快速失败，error chunk 应已到达；
            // 若缺陷存在（SDK 在 retry-after 内等待），3 秒内无任何输出
            const timeout = new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('TIMEOUT_3S')), 3000)
            })

            const consume = (async () => {
                for await (const chunk of adapter.chat({
                    messages: [makeUser('ping')],
                    maxTokens: 8,
                })) {
                    chunks.push(chunk)
                }
            })()

            let outcome: 'error' | 'timeout' | 'done' = 'timeout'
            try {
                await Promise.race([consume, timeout])
                outcome = chunks.some(c => c.type === 'error') ? 'error' : 'done'
            } catch {
                outcome = 'timeout'
            }

            console.log('[缺陷复现] 3 秒内 outcome =', outcome, 'chunks =', chunks.length)
            // 缺陷存在性断言：429 错误未在 3 秒内到达 → 说明被 SDK 重试阻塞
            expect(outcome).not.toBe('error')
        } finally {
            server.close()
        }
    })
})
