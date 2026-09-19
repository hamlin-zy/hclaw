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
    writeFileSync(join(hclawDir, 'mem', 'SKILL.md'), '# 习惯\n喜欢简洁回复')
    writeFileSync(join(hclawDir, 'mem', 'ref', '_user', 'preferences.md'), '偏好 markdown')
  }

  it('returns unchanged when memoryEnabled is false', () => {
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: false})
    expect(result.state).toBe(state)
    expect(result.memoryState.lastMemoryDigest).toBeNull()
  })

  it('returns unchanged for schedule channel', () => {
    writeMemoryFixture()
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true, channel: 'schedule'})
    expect(result.state).toBe(state)
  })

  it('returns unchanged when loadMemory yields null (no mem dir)', () => {
    const missing = join(hclawDir, 'nonexistent')
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir: missing, workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
  })

  it('publishes memory message and updates digest', () => {
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    writeMemoryFixture()
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, 'sess-1', {hclawDir, workspacePath: '/ws', memoryEnabled: true})

    expect(result.state).not.toBe(state)
    expect(result.state.messages.length).toBe(1)
    const msg = result.state.messages[0]
    expect(msg.role).toBe('user')
    expect(msg.metadata?.sourceKind).toBe(MEMORY_SOURCE_KIND)
    expect(msg.content).toContain('<system-reminder>')
    expect(msg.content).toContain('# 用户习惯记忆')

    const expected = computeMemoryDigest({
      skillMd: '# 习惯\n喜欢简洁回复',
      preferencesMd: '偏好 markdown',
      projectMemoryMd: null,
      projectName: null,
    })
    expect(result.memoryState.lastMemoryDigest).toBe(expected)
  })

  it('skips republish when digest unchanged', () => {
    mkdirSync(join(hclawDir, 'mem', 'ref', '_user'), {recursive: true})
    writeMemoryFixture()
    const state = createLoopState([])
    const first = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    const second = runMemoryPreStep(first.state, first.memoryState, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    expect(second.state).toBe(first.state)
    expect(second.memoryState.lastMemoryDigest).toBe(first.memoryState.lastMemoryDigest)
  })

  it('returns unchanged and does not throw when loadMemory throws (F5 error path)', () => {
    writeMemoryFixture()
    const state = createLoopState([])
    loadMemoryMock.throwOnLoad = true
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir, workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
    expect(result.memoryState.lastMemoryDigest).toBeNull()
  })

  it('returns unchanged and does not throw on load error (invalid path)', () => {
    const state = createLoopState([])
    const result = runMemoryPreStep(state, {lastMemoryDigest: null}, null, undefined, {hclawDir: '\0invalid', workspacePath: '/ws', memoryEnabled: true})
    expect(result.state).toBe(state)
  })
})
