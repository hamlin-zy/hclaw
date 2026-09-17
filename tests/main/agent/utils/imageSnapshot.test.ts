import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'
// config.ts 顶层 import 触发 repositories/sqlite 循环初始化（测试环境 TDZ），按仓库既有惯例 mock。
vi.mock('../../../../src/main/config', () => ({
  getHclawDataDir: () => '/hclaw-snap-test-data',
}))
vi.mock('../../../../src/main/hclawPaths', async () => await import('../../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw
import {saveBufferSnapshot, normalizeSnapshotPath, MAX_IMAGE_BYTES} from '../../../../src/main/agent/utils/imageSnapshot'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

describe('imageSnapshot', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'snap-'))
  })
  afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}) })

  it('落盘为 <sha256>.png，bytes 与 mime 正确', async () => {
    const out = await saveBufferSnapshot(PNG, '.png', 'image/png', {dir: path.join(dir, 'out')})
    expect(path.basename(out.path)).toMatch(/^[0-9a-f]{64}\.png$/)
    expect(out.bytes).toBe(PNG.length)
    expect(out.mime).toBe('image/png')
    expect(await fs.readFile(out.path.replace(/\//g, path.sep))).toEqual(PNG)
  })

  it('幂等：同内容两次调用返回同一路径，不改写', async () => {
    const outDir = path.join(dir, 'out')
    const a = await saveBufferSnapshot(PNG, '.png', 'image/png', {dir: outDir})
    const st = await fs.stat(a.path.replace(/\//g, path.sep))
    const b = await saveBufferSnapshot(PNG, '.png', 'image/png', {dir: outDir})
    expect(b.path).toBe(a.path)
    const st2 = await fs.stat(b.path.replace(/\//g, path.sep))
    expect(st2.mtimeMs).toBe(st.mtimeMs)
  })

  it('不同内容 → 不同快照（不覆盖）', async () => {
    const outDir = path.join(dir, 'o')
    const a = await saveBufferSnapshot(PNG, '.png', 'image/png', {dir: outDir})
    const b = await saveBufferSnapshot(Buffer.concat([PNG, Buffer.from([9])]), '.png', 'image/png', {dir: outDir})
    expect(b.path).not.toBe(a.path)
  })

  it('normalizeSnapshotPath：反斜杠归一并保留盘符', () => {
    expect(normalizeSnapshotPath('E:\\a\\b.png')).toBe('E:/a/b.png')
  })

  it('MAX_IMAGE_BYTES 契约 = 3.5MB（Anthropic 单图 base64 上限约 5MB）', () => {
    expect(MAX_IMAGE_BYTES).toBe(3670016)
  })

  it('saveBufferSnapshot：按传入字节算哈希并落盘（load_image 压缩后的字节走这里）', async () => {
    const outDir = path.join(dir, 'buf')
    const buffer = Buffer.concat([PNG, Buffer.from([0xaa, 0xbb])])
    const out = await saveBufferSnapshot(buffer, '.webp', 'image/webp', {dir: outDir})
    expect(path.basename(out.path)).toMatch(/^[0-9a-f]{64}\.webp$/)
    expect(out.mime).toBe('image/webp')
    expect(out.bytes).toBe(buffer.length)
    expect(await fs.readFile(out.path.replace(/\//g, path.sep))).toEqual(buffer)
    // 扩展名容忍带/不带点
    const out2 = await saveBufferSnapshot(buffer, 'webp', 'image/webp', {dir: outDir})
    expect(out2.path).toBe(out.path)
  })
})
