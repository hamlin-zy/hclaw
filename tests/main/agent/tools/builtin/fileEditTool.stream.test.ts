/**
 * fileEditTool 大文件流式路径（>10MB）唯一性校验测试
 *
 * 背景：小文件路径（内存处理）在 matchCount > 1 && !replaceAll 时会拒绝；
 * 流式路径此前只替换首个匹配、静默成功。现两条路径语义等价：
 *   - matchCount === 0            → 报错，原文件不变
 *   - matchCount > 1 && !replaceAll → 报错，原文件不变
 *   - 命中歧义时丢弃 temp 文件，绝不 rename 覆盖原文件
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {fileEditTool} from '@/main/agent/tools/builtin/fileEditTool'
import type {ToolContext} from '@/main/agent/tools/types'

const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024

describe('fileEditTool — 大文件流式路径唯一性校验', () => {
  let tmpRoot: string

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'file-edit-stream-'))
  })

  afterEach(async () => {
    await fs.rm(tmpRoot, {recursive: true, force: true})
  })

  function makeContext(): ToolContext {
    return {
      workingDir: tmpRoot,
      abortSignal: new AbortController().signal,
      sendMessage: vi.fn(),
    } as unknown as ToolContext
  }

  /** 生成 >10MB 文件（触发流式路径）；tokenLines 中的行号为含 TOKEN 的行 */
  async function writeLargeFile(
    filePath: string,
    tokenLines: number[],
    totalLines = 120000,
  ): Promise<void> {
    const padding = 'x'.repeat(100)
    const tokenSet = new Set(tokenLines)
    const parts: string[] = []
    for (let i = 1; i <= totalLines; i++) {
      parts.push(tokenSet.has(i) ? `MARKER ${padding}` : `plain line ${i} ${padding}`)
    }
    await fs.writeFile(filePath, parts.join('\n') + '\n')
  }

  async function noTempLeftover(): Promise<string[]> {
    return (await fs.readdir(tmpRoot)).filter(n => n.includes('.tmp.'))
  }

  it('前置断言：生成的文件确实超过大文件阈值（走流式路径）', async () => {
    const filePath = path.join(tmpRoot, 'threshold.txt')
    await writeLargeFile(filePath, [1])
    expect((await fs.stat(filePath)).size).toBeGreaterThan(LARGE_FILE_THRESHOLD)
  })

  it('多命中且未设置 replaceAll → 拒绝，原文件逐字节不变，无 temp 残留', async () => {
    const filePath = path.join(tmpRoot, 'multi.txt')
    await writeLargeFile(filePath, [1000, 90000])
    const before = await fs.readFile(filePath, 'utf-8')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'MARKER', newString: 'REPLACED'},
      makeContext(),
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Found 2 matches/)
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before)
    expect(await noTempLeftover()).toEqual([])
  })

  it('多命中 + replaceAll:true → 全部替换', async () => {
    const filePath = path.join(tmpRoot, 'replace-all.txt')
    await writeLargeFile(filePath, [1000, 90000])

    const result = await fileEditTool.execute(
      {filePath, oldString: 'MARKER', newString: 'REPLACED', replaceAll: true},
      makeContext(),
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/Replaced 2 match/)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).not.toContain('MARKER')
    expect(content.split('REPLACED').length - 1).toBe(2)
    expect(await noTempLeftover()).toEqual([])
  })

  it('未命中 → 报错，原文件不变，无 temp 残留', async () => {
    const filePath = path.join(tmpRoot, 'miss.txt')
    await writeLargeFile(filePath, [])
    const before = await fs.readFile(filePath, 'utf-8')

    const result = await fileEditTool.execute(
      {filePath, oldString: 'MARKER', newString: 'REPLACED'},
      makeContext(),
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No matching text found/)
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before)
    expect(await noTempLeftover()).toEqual([])
  })

  it('单命中 → 正常替换（stream 模式）', async () => {
    const filePath = path.join(tmpRoot, 'single.txt')
    await writeLargeFile(filePath, [60000])

    const result = await fileEditTool.execute(
      {filePath, oldString: 'MARKER', newString: 'REPLACED'},
      makeContext(),
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatch(/\(stream mode\)/)
    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).not.toContain('MARKER')
    expect(content.split('REPLACED').length - 1).toBe(1)
    expect(await noTempLeftover()).toEqual([])
  })
})
