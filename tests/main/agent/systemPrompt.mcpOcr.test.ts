/**
 * P1-10：MCP-OCR 元数据对 system 正文的影响。
 *
 * 依据（先读代码再定断言方向，非臆断）：
 * - src/main/agent/systemPrompt.ts:105-118：`buildImageHandlingSection` 以
 *   `getAllMcpToolMeta()` 为唯一输入，按 proxyName / rawToolName 关键词
 *   （ocr / image / vision / screenshot，见 :121-125）判定，替换 system.image
 *   模板中的 `{{mcpOcrStatus}}`；文案取自 src/shared/prompts.ts:113。
 * - 缓存复用路径 src/main/agent/loop/setup.ts:481：`cacheSignature === cachedSignature`
 *   即原样返回 DB 内旧字节，**不再调用** buildSystemPrompt（也就不再读 MCP 元数据）。
 * - 而 buildSystemSignature（loop/controller.ts:252-263）键集为
 *   {workingDir, agentType, customInstructions, languageSection?} —— MCP 元数据不参与。
 *
 * ⇒ 真实行为（本文件固化的契约）：
 *   ① 无缓存重建时：MCP-OCR 工具增删 → {{mcpOcrStatus}} 段随之变化；
 *   ② 命中缓存时：MCP 元数据变化不改写既有字节（签名不变 → 复用 → 前缀稳定）。
 */
import {describe, expect, it, vi, afterEach} from 'vitest'

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
import {buildSystemPrompt as buildSystemPromptWithCache} from '../../../src/main/agent/loop/setup'
import {buildSystemSignature} from '../../../src/main/agent/loop/controller'

const OCR_READY = '优先调用对应 MCP 工具提取内容'
const OCR_ABSENT = '当前无可用 MCP 图片工具'

const CTX = {workingDir: '/x', tools: [], permissionMode: 'safe', agentType: 'General' as const}

const BUILD_PARAMS = {
    commandContext: null,
    agentDefinition: undefined,
    workingDir: '/x',
    availableToolDefinitions: [],
    currentPermissionMode: 'auto' as const,
    customInstructions: undefined,
    agentType: 'General',
    agentTemplates: undefined,
}

function buildFresh(): Promise<string> {
    return buildSystemPromptWithCache({...BUILD_PARAMS, cachedSystemPrompt: null, cacheSignature: null})
}

afterEach(() => {
    envState.mcpMetas = []
    envState.hclawDir = '/tmp/hclaw-test'
})

describe('MCP-OCR 元数据 → {{mcpOcrStatus}}（P1-10）', () => {
    it('无 MCP-OCR 工具 → 文案为「当前无可用 MCP 图片工具」', async () => {
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain(OCR_ABSENT)
        expect(p).not.toContain(OCR_READY)
    })

    it('新增 OCR 工具（rawToolName 命中关键字）→ 文案切换为「优先调用…」（按关键词判定，见 systemPrompt.ts:121-125）', async () => {
        envState.mcpMetas = [{proxyName: 'm_srv_ocr', rawToolName: 'ocr_image'}]
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain(OCR_READY)
        expect(p).not.toContain(OCR_ABSENT)
    })

    it('proxyName 命中 image / vision / screenshot 亦判定为可用（四关键词全覆盖）', async () => {
        for (const [proxyName, rawToolName] of [
            ['m_srv_image_reader', 'read_file_x'],
            ['m_srv_vision', 'v1'],
            ['m_srv_shot', 'screenshot'],
            ['m_srv_x', 'OCR'],
        ] as Array<[string, string]>) {
            envState.mcpMetas = [{proxyName, rawToolName}]
            const p = await buildSystemPrompt(CTX)
            expect(p, `${proxyName}/${rawToolName} 应判定为 OCR 可用`).toContain(OCR_READY)
        }
    })

    it('非 OCR 工具不影响该段（查询类 MCP 工具）', async () => {
        envState.mcpMetas = [{proxyName: 'm_srv_query', rawToolName: 'query_db'}]
        const p = await buildSystemPrompt(CTX)
        expect(p).toContain(OCR_ABSENT)
    })

    it('删除 OCR 工具 → 段回落到「当前无可用 MCP 图片工具」（增删对称）', async () => {
        envState.mcpMetas = [{proxyName: 'm_srv_ocr', rawToolName: 'ocr_image'}]
        expect(await buildSystemPrompt(CTX)).toContain(OCR_READY)
        envState.mcpMetas = []
        expect(await buildSystemPrompt(CTX)).toContain(OCR_ABSENT)
    })

    it('★ 现状契约：签名一致时 MCP-OCR 元数据变化不改写既有字节（复用 DB 旧字节）', async () => {
        const cachedBytes = await buildFresh()          // 缓存里是「无 OCR 工具」的旧字节
        expect(cachedBytes).toContain(OCR_ABSENT)
        const sig = buildSystemSignature('/x', 'General', undefined, undefined)

        envState.mcpMetas = [{proxyName: 'm_srv_ocr', rawToolName: 'ocr_image'}]  // 之后才装上 OCR 工具
        const reused = await buildSystemPromptWithCache({
            ...BUILD_PARAMS,
            cachedSystemPrompt: cachedBytes,
            cacheSignature: sig,
            cachedSignature: sig,
        })
        expect(reused).toBe(cachedBytes)
        expect(reused).toContain(OCR_ABSENT)   // 未被新元数据改写 → 前缀字节冻结
        expect(reused).not.toContain(OCR_READY)
    })

    it('判别力自检：签名若参与 MCP 状态则以新字节重建（当前签名不含它，故上面用例成立）', async () => {
        const sigA = buildSystemSignature('/x', 'General', undefined, undefined)
        envState.mcpMetas = [{proxyName: 'm_srv_ocr', rawToolName: 'ocr_image'}]
        const sigB = buildSystemSignature('/x', 'General', undefined, undefined)
        expect(sigB).toBe(sigA)   // 签名与 MCP 元数据无关（否则缓存会被无谓打断）
    })
})
