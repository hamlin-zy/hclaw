import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {runArchiveIndexPreStep} from '../../../src/main/agent/loop/archiveIndexPublish'
import {ARCHIVE_INDEX_DEFAULTS, clearArchiveIndexCache} from '../../../src/main/agent/memory/archiveIndex'
import {MEMORY_SOURCE_KIND, ARCHIVE_INDEX_DIGEST_KEY} from '../../../src/shared/types/memory'
import type {MemoryState} from '../../../src/shared/types/memory'
import {createLoopState} from '../../../src/main/agent/state'
import type {IConversationRepository} from '../../../src/main/repositories/interfaces'

/**
 * 注入文本「时间戳 / 相对时间」负向护栏（口径与
 * tests/main/agent/loop/promptTextHygiene.test.ts 逐字一致，不放大也不收窄）：
 * 任何逐轮不同的内容都会让请求前缀漂移 → 供应商 KV cache 失效。
 */
const DATE_RE = /\d{4}-\d{2}-\d{2}/
const EPOCH_MS_RE = /\b1[0-9]{12}\b/
const RELATIVE_TIME_RE = /刚刚|今天|昨天|上周/

/** 一天的毫秒数 */
const DAY = 86_400_000
/** mtime 基准（固定值，避免依赖真实时间） */
const BASE_MTIME = Date.UTC(2026, 7, 1)

let hclawDir = ''

/** 跨项目归档目录 mem/ref/_user/archive */
function crossArchiveDir(dir: string): string {
    return join(dir, 'mem', 'ref', '_user', 'archive')
}

/** 写一个归档卷并固定 mtime */
function writeVolume(dir: string, fileName: string, summary: string, mtimeMs: number): void {
    mkdirSync(dir, {recursive: true})
    const filePath = join(dir, fileName)
    writeFileSync(filePath, `# 归档卷：${fileName}\n\n> 摘要：${summary}\n\n正文\n`, 'utf8')
    utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs))
}

/** 默认 options（memoryEnabled 开启、无 workspace、无 limits） */
function opts(overrides: Record<string, unknown> = {}) {
    return {
        hclawDir,
        workspacePath: null as string | null,
        memoryEnabled: true,
        ...overrides,
    }
}

const EMPTY_IDX: MemoryState = {lastMemoryDigest: null, lastArchiveIndexDigest: null}

/** 取最后一条注入消息 */
function lastMessage(state: {messages: ReadonlyArray<{content?: unknown; metadata?: unknown; id?: string; role?: string}>}) {
    return state.messages[state.messages.length - 1]
}

beforeEach(() => {
    hclawDir = mkdtempSync(join(tmpdir(), 'hclaw-idx-'))
    clearArchiveIndexCache()
})

afterEach(() => {
    clearArchiveIndexCache()
    rmSync(hclawDir, {recursive: true, force: true})
})

describe('runArchiveIndexPreStep', () => {
    it('digest 未变不追加，变化则追加一条', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])

        const first = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts())
        const len = first.state.messages.length
        expect(len).toBe(2)   // 原用户消息 + 一条索引消息

        const second = runArchiveIndexPreStep(first.state, first.memoryState, null, 'sess', opts())
        expect(second.state.messages.length).toBe(len)
        expect(second.state).toBe(first.state)   // 未变 → 原样返回（引用相等）

        // 新增一卷（mtime 变化 → 目录缓存键变化 → digest 变化）
        writeVolume(crossArchiveDir(hclawDir), '2026-09-beta.md', '测试卷 B', BASE_MTIME + DAY)
        const third = runArchiveIndexPreStep(second.state, second.memoryState, null, 'sess', opts())
        expect(third.state.messages.length).toBe(len + 1)
        expect(third.memoryState.lastArchiveIndexDigest).not.toBe(first.memoryState.lastArchiveIndexDigest)
    })

    it('memoryEnabled=false 原样返回（引用相等）', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const idxState: MemoryState = {lastMemoryDigest: 'm1', lastArchiveIndexDigest: null}
        const r = runArchiveIndexPreStep(state, idxState, null, 'sess', opts({memoryEnabled: false}))
        expect(r.state).toBe(state)
        expect(r.memoryState).toBe(idxState)
    })

    it('channel=schedule 原样返回（引用相等）', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const idxState: MemoryState = {lastMemoryDigest: null, lastArchiveIndexDigest: null}
        const r = runArchiveIndexPreStep(state, idxState, null, 'sess', opts({channel: 'schedule'}))
        expect(r.state).toBe(state)
        expect(r.memoryState).toBe(idxState)
    })

    it('无归档卷时原样返回（引用相等）', () => {
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const idxState: MemoryState = {lastMemoryDigest: null, lastArchiveIndexDigest: null}
        const r = runArchiveIndexPreStep(state, idxState, null, 'sess', opts())
        expect(r.state).toBe(state)
        expect(r.memoryState).toBe(idxState)
    })

    it('content 固定五段，且指引行在 <system-reminder> 包裹之内', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const r = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts())
        const content = String(lastMessage(r.state).content)
        const lines = content.split('\n')

        // ① 起始标签行
        expect(lines[0]).toBe('<system-reminder>')
        // ② 标题行 + 空行 + body
        expect(lines[1]).toBe('# 长期记忆索引（按需读取）')
        expect(lines[2]).toBe('')
        // ⑤ 结束标签行（尾行必须在包裹内，否则渲染成用户气泡）
        expect(lines[lines.length - 1]).toBe('</system-reminder>')
        expect(content.trim().startsWith('<system-reminder>')).toBe(true)
        expect(content.trim().endsWith('</system-reminder>')).toBe(true)

        // ④ 指引行：在包裹内（结束标签之前），且 ③ 与 body 之间恰有一个空行
        const guideLine = '任务涉及上述主题时，用 file_read 读取对应卷全文后再动手；清单只是地图，不要凭卷名臆断内容。'
        const guideIdx = lines.indexOf(guideLine)
        expect(guideIdx).toBeGreaterThan(-1)
        expect(guideIdx).toBeLessThan(lines.length - 1)
        expect(lines[guideIdx - 1]).toBe('')
        expect(lines[guideIdx - 2].startsWith('- ')).toBe(true)   // body 末行紧邻空行，不出现双空行
        expect(content).toContain('用 file_read 读取对应卷全文后再动手')
    })

    it('metadata 带 sourceKind=memory 与 archiveIndexDigest', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const r = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts())
        const msg = lastMessage(r.state)
        expect(msg.role).toBe('user')
        expect(msg.metadata).toMatchObject({
            sourceKind: MEMORY_SOURCE_KIND,
            [ARCHIVE_INDEX_DIGEST_KEY]: expect.any(String),
        })
        expect(r.memoryState.lastArchiveIndexDigest).toBe(
            (msg.metadata as Record<string, unknown>)[ARCHIVE_INDEX_DIGEST_KEY],
        )
        // 记忆 digest 不受索引注入影响
        expect(r.memoryState.lastMemoryDigest).toBeNull()
    })

    it('非法 hclawDir 不抛、状态与状态对象均原样返回', () => {
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const idxState: MemoryState = {lastMemoryDigest: null, lastArchiveIndexDigest: null}
        const r = runArchiveIndexPreStep(state, idxState, null, undefined, opts({hclawDir: '\0invalid'}))
        expect(r.state).toBe(state)
        expect(r.memoryState).toBe(idxState)
    })

    it('注入内容过 promptTextHygiene 断言口径（无日期 / 毫秒戳 / 相对时间词）', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        writeVolume(crossArchiveDir(hclawDir), '2026-09-beta.md', '测试卷 B', BASE_MTIME + DAY)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const r = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts())
        const content = String(lastMessage(r.state).content)

        expect(content).not.toMatch(DATE_RE)
        expect(content).not.toMatch(EPOCH_MS_RE)
        expect(content).not.toMatch(RELATIVE_TIME_RE)

        // 判别力对照：同一组正则可被带漂移源的输入命中（证明上述「不含」断言非恒真）
        const dirty = '归档卷（2026-09-29）刚刚更新 ts=1758537600000'
        expect(DATE_RE.test(dirty)).toBe(true)
        expect(EPOCH_MS_RE.test(dirty)).toBe(true)
        expect(RELATIVE_TIME_RE.test(dirty)).toBe(true)
    })

    it('同 digest 二次调用：注入消息字节不变（缓存稳定）', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const first = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts())
        const before = String(lastMessage(first.state).content)
        const again = runArchiveIndexPreStep(first.state, first.memoryState, null, 'sess', opts())
        expect(String(lastMessage(again.state).content)).toBe(before)
    })

    it('有 session 时落库（补齐 timestamp），无 session 时仅内存态', () => {
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const writeMessagesDelta = vi.fn()
        const repo = {writeMessagesDelta} as unknown as IConversationRepository

        const r = runArchiveIndexPreStep(state, EMPTY_IDX, repo, 'sess-1', opts())
        expect(writeMessagesDelta).toHaveBeenCalledTimes(1)
        const [sid, persisted] = writeMessagesDelta.mock.calls[0] as unknown as [string, Record<string, unknown>]
        expect(sid).toBe('sess-1')
        expect(persisted.id).toBe(lastMessage(r.state).id)
        expect(typeof persisted.timestamp).toBe('number')

        const memOnly = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const r2 = runArchiveIndexPreStep(memOnly, EMPTY_IDX, null, undefined, opts())
        expect(r2.state.messages.length).toBe(2)
    })

    it('limits 缺省时回落 ARCHIVE_INDEX_DEFAULTS 的预算（透传给构建器）', () => {
        // 单卷 + 极紧预算：仍应产出索引（sanitize 后不低于 1 字节），不被默认预算否决
        writeVolume(crossArchiveDir(hclawDir), '2026-08-alpha.md', '测试卷 A', BASE_MTIME)
        const state = createLoopState([{id: 'u1', role: 'user', content: '继续'}])
        const tight = runArchiveIndexPreStep(state, EMPTY_IDX, null, 'sess', opts({limits: {maxBytes: 120}}))
        const content = String(lastMessage(tight.state).content)
        expect(content).toContain('# 长期记忆索引（按需读取）')
        expect(ARCHIVE_INDEX_DEFAULTS.maxBytes).toBe(3072)
    })
})
