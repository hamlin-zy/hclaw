import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import {mkdtempSync, mkdirSync, writeFileSync} from 'fs'
import {tmpdir} from 'os'
import {join} from 'path'
import {restoreMemoryState, runMemoryPreStep} from '../../../src/main/agent/loop/memoryPublish'
import {computeMemoryDigest} from '../../../src/main/agent/memory/memoryStore'
import {MEMORY_SOURCE_KIND} from '../../../src/shared/types/memory'
import {createLoopState} from '../../../src/main/agent/state'

// F5：错误路径测试 —— loadMemory 抛异常时 runMemoryPreStep 不抛、返回原 state。
// 通过可开关的 mock 包装真实实现（其余测试仍走真实 loadMemory）。
const loadMemoryMock = vi.hoisted(() => ({throwOnLoad: false}))
vi.mock('../../../src/main/agent/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/agent/memory')>()
  return {
    ...actual,
    loadMemory: (...args: Parameters<typeof actual.loadMemory>) => {
      if (loadMemoryMock.throwOnLoad) throw new Error('mocked load failure')
      return actual.loadMemory(...args)
    },
  }
})

describe('restoreMemoryState', () => {
  it('should return empty state when no memory messages', () => {
    const state = restoreMemoryState([])
    expect(state.lastMemoryDigest).toBeNull()
  })
  it('should find last memory digest from messages', () => {
    const messages = [
      {metadata: {}},
      {metadata: {memoryDigest: 'abc123', sourceKind: 'memory'}},
      {metadata: {}},
      {metadata: {memoryDigest: 'def456', sourceKind: 'memory'}},
    ] as unknown as Parameters<typeof restoreMemoryState>[0]
    const state = restoreMemoryState(messages)
    expect(state.lastMemoryDigest).toBe('def456')
  })
  it('should return null when no memory messages found', () => {
    const messages = [{metadata: {sourceKind: 'catalog'}}, {metadata: {}}] as unknown as Parameters<typeof restoreMemoryState>[0]
    const state = restoreMemoryState(messages)
    expect(state.lastMemoryDigest).toBeNull()
  })
  it('restoreMemoryState 分别恢复记忆与索引 digest', () => {
    const messages = [
      {metadata: {sourceKind: 'memory', memoryDigest: 'm1'}},
      {metadata: {sourceKind: 'memory', archiveIndexDigest: 'i1'}},
      {metadata: {sourceKind: 'memory', memoryDigest: 'm2'}},
    ] as unknown as Parameters<typeof restoreMemoryState>[0]
    const s = restoreMemoryState(messages)
    expect(s.lastMemoryDigest).toBe('m2')
    expect(s.lastArchiveIndexDigest).toBe('i1')
  })
  it('只有索引消息时 lastMemoryDigest 仍为 null', () => {
    const s = restoreMemoryState([{metadata: {sourceKind: 'memory', archiveIndexDigest: 'i1'}}] as unknown as Parameters<typeof restoreMemoryState>[0])
    expect(s.lastMemoryDigest).toBeNull()
    expect(s.lastArchiveIndexDigest).toBe('i1')
  })
  it('两者都无时为 null/null', () => {
    const s = restoreMemoryState([{metadata: {sourceKind: 'catalog'}}] as unknown as Parameters<typeof restoreMemoryState>[0])
    expect(s).toEqual({lastMemoryDigest: null, lastArchiveIndexDigest: null})
  })
  // ★ 脏行继续向前扫描（R13 ②）：倒序扫描遇「无 digest / digest 值非法 / 非法 JSON 的
  //   metadata」一律跳过而非终止 —— 终止会让被脏行遮挡的更早 digest 永久丢失，
  //   表现为重启后重复注入（门控恒判未发布）。
  it('★ 脏行不终止扫描：跨过脏行仍能取到更早的有效 digest', () => {
    const messages = [
      {metadata: {sourceKind: 'memory', memoryDigest: 'm1', archiveIndexDigest: 'i1'}},
      {metadata: 'not-json{'},                                    // 非法 JSON（parse 失败回落原始文本）
      {metadata: {sourceKind: 'memory'}},                          // 无 digest
      {metadata: {sourceKind: 'memory', archiveIndexDigest: 'i2'}},
      {metadata: {sourceKind: 'memory', memoryDigest: 123}},       // digest 值非法（非 string）
      {metadata: undefined},
      {metadata: {sourceKind: 'memory', memoryDigest: 'm2'}},
    ] as unknown as Parameters<typeof restoreMemoryState>[0]
    const s = restoreMemoryState(messages)
    expect(s.lastMemoryDigest).toBe('m2')
    // 判别力：若实现遇脏行提前 break，索引 3 的 i2 永远扫不到 → 此处为 null（红）
    expect(s.lastArchiveIndexDigest).toBe('i2')
  })

  it('单条同时带两 key 时两字段都恢复', () => {
    const s = restoreMemoryState([{metadata: {sourceKind: 'memory', memoryDigest: 'm1', archiveIndexDigest: 'i1'}}] as unknown as Parameters<typeof restoreMemoryState>[0])
    expect(s.lastMemoryDigest).toBe('m1')
    expect(s.lastArchiveIndexDigest).toBe('i1')
  })
})

describe('runMemoryPreStep', () => {
  let hclawDir: string

  beforeEach(() => {
    hclawDir = mkdtempSync(join(tmpdir(), 'memprestep-'))
    mkdirSync(join(hclawDir, 'mem'))
    loadMemoryMock.throwOnLoad = false
  })

  afterEach(() => {
    loadMemoryMock.throwOnLoad = false
  })

  function writeMemoryFixture(): void {
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    writeFileSync(join(hclawDir, 'mem', 'ref', '_user', 'preferences.md'), '偏好 markdown')
  }

  it('returns unchanged when memoryEnabled is false', () => {
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: false})
    expect(result.state).toBe(state)
    expect(result.memoryState.lastMemoryDigest).toBeNull()
  })

  it('returns unchanged for schedule channel', () => {
    writeMemoryFixture()
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true, channel: 'schedule'})
    expect(result.state).toBe(state)
  })

  it('returns unchanged when loadMemory yields null (no mem dir)', () => {
    const missing = join(hclawDir, 'nonexistent')
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir: missing, workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
  })

  it('publishes memory message and updates digest', () => {
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    writeMemoryFixture()
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, 'sess-1', {hclawDir, workspacePath: '/ws', memoryEnabled: true})

    expect(result.state).not.toBe(state)
    expect(result.state.messages.length).toBe(1)
    const msg = result.state.messages[0]
    expect(msg.role).toBe('user')
    expect(msg.metadata?.sourceKind).toBe(MEMORY_SOURCE_KIND)
    expect(msg.content).toContain('<system-reminder>')
    expect(msg.content).toContain('# 用户习惯记忆')

    const expected = computeMemoryDigest({
      preferencesMd: '偏好 markdown',
      projectMemoryMd: null,
      projectName: null,
    })
    expect(result.memoryState.lastMemoryDigest).toBe(expected)
  })

  it('注入文本直接拼文件正文，不重复加 `## 用户偏好` / `## 项目记忆（x）` 前缀标题', () => {
    // 真实文件首行即 H1（与 ref/_user/preferences.md、ref/{dir}/memory.md 出厂骨架一致）
    const WS = '/ws-h1'
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    mkdirSync(join(hclawDir, 'mem', 'ref', 'proj'), {recursive: true})
    writeFileSync(join(hclawDir, 'mem', 'ref', '_user', 'preferences.md'),
      '# 用户偏好（跨项目通用习惯）\n\n## 身份与环境\n- 资深 Java 后端工程师\n')
    writeFileSync(join(hclawDir, 'mem', 'ref', 'proj', 'memory.md'),
      '# 项目记忆：hclaw\n\n## 项目背景\n- Electron + React\n')
    writeFileSync(join(hclawDir, 'mem', 'ref', 'index.json'),
      JSON.stringify({[WS]: {dir: 'proj', projectName: 'hclaw'}}))

    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, 'sess-h1',
      {hclawDir, workspacePath: WS, memoryEnabled: true})
    const content = String(result.state.messages[0].content)

    // 外层包裹必须保留（渲染端靠它隐藏该消息）
    expect(content).toContain('<system-reminder>')
    expect(content).toContain('</system-reminder>')
    // 文件自身 H1 原样进入注入文本
    expect(content).toContain('# 用户偏好')
    expect(content).toContain('# 项目记忆')
    // 注入层不得再叠一层同级标题（否则每次注入两个同级标题）
    expect(content).not.toContain('## 用户偏好')
    expect(content).not.toContain('## 项目记忆')
  })

  it('skips republish when digest unchanged', () => {
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    writeMemoryFixture()
    const state = createLoopState([])
    const first = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    const second = runMemoryPreStep(first.state, first.memoryState, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    expect(second.state).toBe(first.state)
    expect(second.memoryState.lastMemoryDigest).toBe(first.memoryState.lastMemoryDigest)
  })

  it('returns unchanged and does not throw when loadMemory throws (F5 error path)', () => {
    writeMemoryFixture()
    const state = createLoopState([])
    loadMemoryMock.throwOnLoad = true
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
    expect(result.memoryState.lastMemoryDigest).toBeNull()
  })

  it('returns unchanged and does not throw on load error (invalid path)', () => {
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null, lastArchiveIndexDigest: null}, null, undefined, {hclawDir: '\0invalid', workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
  })
})
