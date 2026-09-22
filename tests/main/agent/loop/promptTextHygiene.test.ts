/**
 * 注入文本「时间戳 / 相对时间」负向护栏（组 C · P1-9）
 *
 * 为什么是护栏型用例：请求前缀字节稳定的前提是「同一输入 → 同一字节」。
 * 任何注入正文里出现**每次构建都不同**的内容（毫秒时间戳、相对时间词「刚刚/今天/昨天/上周」），
 * 都会让前缀逐轮漂移 → 供应商 KV cache 失效（且症状是"命中率莫名归零"，极难定位）。
 * 现状实测为「不含」→ 本文件锁定该不变量，防未来误加。
 *
 * ⚠️ 与 brief 的一处**实测差异**（以实测为准，见报告）：
 *   `renderEnvContent` 的 env 注入文本**故意包含** `yyyy-MM-dd` 日期
 *   （`Today's date is <digest>`，digest 门控：跨天才追加一次，不逐轮漂移）。
 *   因此本文件对 env 文本的断言是「含且仅含 1 个 YYYY-MM-DD，且不含毫秒戳 / 中文相对时间词」，
 *   而不是「不含日期」——后者会与设计（缓存稳定化 #日期 的落地方式）冲突。
 *
 * 判别力：文件末尾的「判别力对照」用例把同一组正则作用在人为带日期/时间戳/相对词的输入上，
 * 断言其必然命中 —— 保证以上「不含」断言不是恒真的空断言。
 */
import {describe, expect, it, vi} from 'vitest'

vi.mock('@/main/config', () => ({getHclawDir: () => '/tmp/hclaw-test'}))
vi.mock('@/main/hclawPaths', async () => await import('@/main/config'))

// 记忆正文加载桩：注入文本由本文件供给，隔离磁盘
vi.mock('@/main/agent/memory', () => ({
    loadMemory: vi.fn(() => ({
        preferencesMd: '# 用户偏好\n- 结论先行',
        projectMemoryMd: null,
        projectName: null,
    })),
    computeMemoryDigest: vi.fn(() => 'digest-1'),
}))

import type {CatalogEntry} from '@shared/types/message'
import {buildCommandTaskContent, buildUserHistoryContent} from '@/main/agent/utils/userContentBuilder'
import {renderCatalogContent, renderMcpCatalogContent} from '@/main/agent/skills/catalogInjector'
import {renderEnvContent} from '@/main/agent/loop/envPublish'
import {runMemoryPreStep} from '@/main/agent/loop/memoryPublish'
import {createLoopState} from '@/main/agent/state'

const DATE_RE = /\d{4}-\d{2}-\d{2}/
const EPOCH_MS_RE = /\b1[0-9]{12}\b/
const RELATIVE_TIME_RE = /刚刚|今天|昨天|上周/

const entries: CatalogEntry[] = [
    {name: 'alpha', type: 'skill', description: 'Do A', trigger: 'when A'},
]

describe('注入文本负向护栏：无逐轮漂移源', () => {
    it('buildUserHistoryContent：无附件原样返回；有非图片附件只追加 [附件] 块', async () => {
        const plain = await buildUserHistoryContent('继续修复前缀缓存', [])
        expect(plain).toBe('继续修复前缀缓存')

        const withDoc = await buildUserHistoryContent('看这个', [{path: 'E:/ws/a.md', name: 'a.md'}])
        expect(typeof withDoc).toBe('string')
        expect(String(withDoc)).toContain('[附件]')
        expect(String(withDoc)).toContain('E:/ws/a.md')
        expect(String(withDoc)).not.toMatch(DATE_RE)
        expect(String(withDoc)).not.toMatch(EPOCH_MS_RE)
        expect(String(withDoc)).not.toMatch(RELATIVE_TIME_RE)
    })

    it('CT 注入正文（command-task）：仅包裹模板，无日期/时间戳/相对词', () => {
        const ct = buildCommandTaskContent('## 技能指导\n步骤 1')
        expect(ct).toBe('<command-task>\n## 技能指导\n步骤 1\n</command-task>')
        expect(ct).not.toMatch(DATE_RE)
        expect(ct).not.toMatch(EPOCH_MS_RE)
        expect(ct).not.toMatch(RELATIVE_TIME_RE)
    })

    it('catalog 注入正文（skills / mcp，全部 kind）：无日期/时间戳/相对词', () => {
        const contents = [
            renderCatalogContent(entries, 'names', 'first'),
            renderCatalogContent(entries, 'names', 'replacement'),
            renderCatalogContent([], 'names', 'empty'),
            renderCatalogContent(entries, 'full', 'first'),
            renderMcpCatalogContent([{name: 'mcp_x', type: 'mcp', description: 'd'}], 'first'),
            renderMcpCatalogContent([], 'empty'),
        ]
        for (const c of contents) {
            expect(c).not.toMatch(DATE_RE)
            expect(c).not.toMatch(EPOCH_MS_RE)
            expect(c).not.toMatch(RELATIVE_TIME_RE)
        }
    })

    it('env 注入正文：含且仅含 1 个日期 digest（门控值），不含毫秒戳 / 相对时间词', () => {
        const content = renderEnvContent('2026-09-22')
        expect(content).toContain("Today's date is 2026-09-22")
        expect(content.match(/\d{4}-\d{2}-\d{2}/g)).toHaveLength(1)   // 仅 digest 本身
        expect(content).not.toMatch(EPOCH_MS_RE)
        expect(content).not.toMatch(RELATIVE_TIME_RE)
        // 同一 digest 两次渲染逐字节一致（env 注入本身不漂移）
        expect(renderEnvContent('2026-09-22')).toBe(content)
    })

    it('memory 注入正文：无日期/时间戳/相对词', () => {
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const r = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {
            hclawDir: '/tmp/hclaw-test',
            workspacePath: 'E:/ws',
            memoryEnabled: true,
        })
        const added = r.state.messages[r.state.messages.length - 1]
        const text = String(added.content)
        expect(text).toContain('# 用户习惯记忆')
        expect(text).not.toMatch(DATE_RE)
        expect(text).not.toMatch(EPOCH_MS_RE)
        expect(text).not.toMatch(RELATIVE_TIME_RE)
        // 同 digest 二次调用 → 零追加（且原消息字节不变）
        const again = runMemoryPreStep(r.state, r.memoryState, null, undefined, {
            hclawDir: '/tmp/hclaw-test',
            workspacePath: 'E:/ws',
            memoryEnabled: true,
        })
        expect(again.state.messages).toHaveLength(r.state.messages.length)
        expect(String(again.state.messages[again.state.messages.length - 1].content)).toBe(text)
    })
})

describe('判别力对照：同一组正则可被带日期/时间戳的输入命中', () => {
    it('人为构造的漂移输入三者必然命中（证明上述「不含」断言非恒真）', async () => {
        const dirty = '## 交接总结（2026-09-22）\n刚刚完成 A，昨天完成 B，ts=1758537600000'
        expect(DATE_RE.test(dirty)).toBe(true)
        expect(EPOCH_MS_RE.test(dirty)).toBe(true)
        expect(RELATIVE_TIME_RE.test(dirty)).toBe(true)

        // 同一护栏作用于真实构建函数：把脏文本作为"用户正文"传入时，正文本身（而非构建器）
        // 才是漂移源 —— 构建器不做任何修饰（透传语义由此可证）。
        const passthrough = await buildUserHistoryContent(dirty, [])
        expect(passthrough).toBe(dirty)
        expect(DATE_RE.test(String(passthrough))).toBe(true)
    })
})
