import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import sharp from 'sharp'

// 设置仓储属主进程单例；用可变引用注入「已保存的设置」，避免真实 sqlite。
const h = vi.hoisted(() => ({dataDir: '', settings: null as unknown}))
vi.mock('../../../../../src/main/config', () => ({
  getHclawDataDir: () => h.dataDir,
}))
vi.mock('../../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
  systemSettingsRepo: {
    getJson: () => {
      if (h.settings instanceof Error) throw h.settings
      return h.settings
    },
  },
}))

import {loadImageTool, resolveImageCompressQuality} from '../../../../../src/main/agent/tools/builtin/loadImageTool'
import {compressImage, DEFAULT_IMAGE_COMPRESS_QUALITY} from '../../../../../src/main/agent/utils/imageCompress'

const ctx = (workingDir: string) => ({
  workingDir,
  abortSignal: new AbortController().signal,
  sendMessage: () => {},
}) as never

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')
const onDisk = (p: string) => p.replace(/\//g, path.sep)

function noise(w: number, h2: number, channels: number): Buffer {
  const b = Buffer.alloc(w * h2 * channels)
  let s = 123456789
  for (let i = 0; i < b.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    b[i] = (s >>> 16) & 0xff
  }
  return b
}

/** 平滑渐变（低熵）：长边 >1568 触发重编码，各质量档均远小于体积上限 */
async function gradientPng(w: number, h2: number): Promise<Buffer> {
  const b = Buffer.alloc(w * h2 * 3)
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      b[i] = (x * 255 / w) | 0
      b[i + 1] = (y * 255 / h2) | 0
      b[i + 2] = ((x + y) * 255 / (w + h2)) | 0
    }
  }
  return sharp(b, {raw: {width: w, height: h2, channels: 3}}).png({compressionLevel: 0}).toBuffer()
}

describe('load_image：质量设置读取', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-q-'))
    h.dataDir = dir
    h.settings = null
  })
  afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}) })

  it('读到设置值并返回', () => {
    h.settings = {model: {imageCompressQuality: 40}}
    expect(resolveImageCompressQuality()).toBe(40)
  })

  it('设置缺失（null / 无 model / 无字段）→ 回落默认 85', () => {
    h.settings = null
    expect(resolveImageCompressQuality()).toBe(DEFAULT_IMAGE_COMPRESS_QUALITY)
    h.settings = {}
    expect(resolveImageCompressQuality()).toBe(DEFAULT_IMAGE_COMPRESS_QUALITY)
    h.settings = {model: {}}
    expect(resolveImageCompressQuality()).toBe(DEFAULT_IMAGE_COMPRESS_QUALITY)
  })

  it('读取失败（抛错）→ 回落 85，不抛出', () => {
    h.settings = new Error('db down')
    expect(() => resolveImageCompressQuality()).not.toThrow()
    expect(resolveImageCompressQuality()).toBe(DEFAULT_IMAGE_COMPRESS_QUALITY)
  })
})

describe('load_image：质量设置生效', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-q2-'))
    h.dataDir = dir
    h.settings = null
  })
  afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}) })

  it('配置 q40 时落库快照 == compressImage(raw, {quality:40})，且不同于默认档', async () => {
    const raw = await gradientPng(2000, 100)
    await fs.writeFile(path.join(dir, 'g.png'), raw)
    const mime = 'image/png'

    h.settings = {model: {imageCompressQuality: 40}}
    const r = await loadImageTool.execute({imagePath: 'g.png'}, ctx(dir))
    expect(r.success).toBe(true)
    const snapPath = /^image_path: (.+)$/m.exec(String(r.output))?.[1] ?? ''
    const snapBytes = await fs.readFile(onDisk(snapPath))

    const expected = await compressImage(raw, mime, {quality: 40})
    expect(sha(snapBytes)).toBe(sha(expected.buffer))

    const defaultOut = await compressImage(raw, mime, {quality: DEFAULT_IMAGE_COMPRESS_QUALITY})
    expect(sha(snapBytes)).not.toBe(sha(defaultOut.buffer))
  })

  it('设置缺失时行为与默认 85 一致（不报错）', async () => {
    const raw = await gradientPng(2000, 100)
    await fs.writeFile(path.join(dir, 'g.png'), raw)

    h.settings = null
    const r = await loadImageTool.execute({imagePath: 'g.png'}, ctx(dir))
    expect(r.success).toBe(true)
    const snapPath = /^image_path: (.+)$/m.exec(String(r.output))?.[1] ?? ''
    const snapBytes = await fs.readFile(onDisk(snapPath))
    const baseline = await compressImage(raw, 'image/png', {quality: 85})
    expect(sha(snapBytes)).toBe(sha(baseline.buffer))
  })
})
