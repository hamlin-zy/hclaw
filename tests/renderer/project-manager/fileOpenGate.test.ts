import {describe, it, expect} from 'vitest'
import {toOpenFileTabInput, BIG_FILE_LIMIT} from '../../../src/renderer/project-manager/utils/fileOpenGate'
import type {FileContentResult} from '../../../src/shared/types/project-manager'

function makeResult(overrides: Partial<FileContentResult> = {}): FileContentResult {
  return {
    path: 'test.ts',
    size: 100,
    content: 'hello',
    isBinary: false,
    isImage: false,
    decodeError: false,
    mimeType: '',
    truncated: false,
    mtime: 0,
    hash: 'abc123',
    ...overrides,
  }
}

describe('toOpenFileTabInput', () => {
  it('正常文本文件', () => {
    const r = toOpenFileTabInput('a.ts', 'a.ts', makeResult())
    expect(r.title).toBe('a.ts')
    expect(r.content).toBe('hello')
    expect(r.hash).toBe('abc123')
  })

  it('二进制文件（非图片）→ 占位：title 二进制文件、content 空、hash 空', () => {
    const r = toOpenFileTabInput('bin.exe', 'bin.exe', makeResult({
      isBinary: true,
      content: null,
      hash: 'abc123',
    }))
    expect(r.title).toBe('二进制文件')
    expect(r.content).toBe('')
    expect(r.hash).toBe('')
  })

  it('解码失败文件 → 占位：title 无法解码、content 空、hash 空', () => {
    const r = toOpenFileTabInput('bad.txt', 'bad.txt', makeResult({
      isBinary: false,
      decodeError: true,
      content: null,
      hash: 'abc123',
    }))
    expect(r.title).toBe('无法解码')
    expect(r.content).toBe('')
    expect(r.hash).toBe('')
  })

  it('图片（≤5MB）→ 走 dataURL，不走占位', () => {
    const r = toOpenFileTabInput('img.png', 'img.png', makeResult({
      isBinary: true,
      isImage: true,
      content: null,
      base64: 'iVBOR',
      mimeType: 'image/png',
      hash: 'img123',
    }))
    expect(r.title).toBe('img.png')
    expect(r.content).toBe('data:image/png;base64,iVBOR')
    expect(r.hash).toBe('img123')
  })

  it('>5MB 文件 → 占位：title 含过大、content 空、hash 空', () => {
    const r = toOpenFileTabInput('huge.txt', 'huge.txt', makeResult({
      size: BIG_FILE_LIMIT + 1,
      content: null,
      isBinary: true,
      hash: 'big123',
    }))
    expect(r.title).toContain('过大')
    expect(r.content).toBe('')
    expect(r.hash).toBe('')
  })
})
