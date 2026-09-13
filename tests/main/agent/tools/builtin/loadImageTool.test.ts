import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as crypto from 'crypto'
import sharp from 'sharp'
// config.ts 顶层 import 触发 repositories/sqlite 循环初始化（测试环境 TDZ），按仓库既有惯例 mock。
// 数据目录用 vi.hoisted 的可变引用，避免真实快照写进用户目录。
const h = vi.hoisted(() => ({dataDir: ''}))
vi.mock('../../../../../src/main/config', () => ({
  getHclawDataDir: () => h.dataDir,
}))
// 设置仓储属主进程单例（读 sqlite）；本文件不校验质量配置，返回 null 即走默认 85。
vi.mock('../../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
  systemSettingsRepo: {getJson: () => null},
}))
import {loadImageTool, formatLoadImageOutput, LOAD_IMAGE_TOOL_NAME} from '../../../../../src/main/agent/tools/builtin/loadImageTool'
import {toolToDefinition} from '../../../../../src/main/agent/tools/types'
import {MAX_IMAGE_BYTES} from '../../../../../src/main/agent/utils/imageCompress'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
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

async function smallPng(): Promise<Buffer> {
  return sharp({create: {width: 40, height: 30, channels: 3, background: '#3366ff'}}).png().toBuffer()
}

describe('load_image 工具', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-'))
    h.dataDir = dir
  })
  afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}) })

  it('工具名契约', () => {
    expect(loadImageTool.name).toBe('load_image')
    expect(LOAD_IMAGE_TOOL_NAME).toBe('load_image')
  })

  it('接口文案不引用附件标记（避免对已可见图片重复 load → 二次注入）', () => {
    // 附件路径已在同一消息中同时给出 image_url 块与【图片文件路径】标记
    // （startAgentCore.buildUserMessageContent / userContentBuilder.buildUserHistoryContent）；
    // load_image 描述若再指向该标记，会诱导视觉模型对已可见图片重复加载。
    const def = toolToDefinition(loadImageTool)
    expect(def.description).not.toContain('【图片文件路径】')
    expect(def.description).toContain('不要重复调用')
    const imagePath = def.inputSchema.properties.imagePath as {description?: string}
    expect(imagePath.description ?? '').not.toContain('【图片文件路径】')
  })

  it('相对路径按 workingDir 解析，输出 image_path 在首行且不含 base64/data:', async () => {
    await fs.writeFile(path.join(dir, 'pic.png'), await smallPng())
    const r = await loadImageTool.execute({imagePath: 'pic.png'}, ctx(dir))
    expect(r.success).toBe(true)
    const lines = String(r.output).split('\n')
    expect(lines[0]).toMatch(/^image_path: \S+$/)
    expect(String(r.output)).toContain('mime: image/png')
    expect(String(r.output)).not.toContain('base64')
    expect(String(r.output)).not.toContain('data:')
    expect(String(r.output)).not.toContain('\\') // 分隔符归一
  })

  it('文件不存在 → success=false，不抛异常', async () => {
    const r = await loadImageTool.execute({imagePath: 'nope.png'}, ctx(dir))
    expect(r.success).toBe(false)
    expect(r.error).toContain('不存在')
  })

  it('网络 URL → 失败（仅本地图片）', async () => {
    const r = await loadImageTool.execute({imagePath: 'https://x/y.png'}, ctx(dir))
    expect(r.success).toBe(false)
    expect(r.error).toContain('网络 URL')
  })

  it('P1：非白名单格式（.txt/.svg）→ 明确拒绝并给出可读提示', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'x')
    const r1 = await loadImageTool.execute({imagePath: 'a.txt'}, ctx(dir))
    expect(r1.success).toBe(false)
    expect(r1.error).toContain('不是受支持的图片格式')
    expect(r1.error).toContain('png/jpg/jpeg/webp/gif')

    await fs.writeFile(path.join(dir, 'a.svg'), '<svg/>')
    const r2 = await loadImageTool.execute({imagePath: 'a.svg'}, ctx(dir))
    expect(r2.success).toBe(false)
    expect(r2.error).toContain('不是受支持的图片格式')
  })

  it('P1：.tiff 经 sharp 转 PNG —— 快照扩展名/mime 与真实字节一致（不再谎报 mime）', async () => {
    const tiff = await sharp(noise(120, 90, 3), {raw: {width: 120, height: 90, channels: 3}}).tiff().toBuffer()
    await fs.writeFile(path.join(dir, 'scan.tiff'), tiff)
    const r = await loadImageTool.execute({imagePath: 'scan.tiff'}, ctx(dir))
    expect(r.success).toBe(true)
    const snapPath = /^image_path: (.+)$/m.exec(String(r.output))?.[1] ?? ''
    expect(snapPath.endsWith('.png')).toBe(true)
    expect(String(r.output)).toContain('mime: image/png')
    expect((await fs.readFile(onDisk(snapPath))).slice(0, 4).toString('hex')).toBe('89504e47')
  })

  it('P1：.bmp → 诚实拒绝（当前运行时不支持 BMP，引导转换），不谎报可转码', async () => {
    const w = 4
    const hgt = 4
    const stride = w * 3 + ((4 - ((w * 3) % 4)) % 4)
    const size = 54 + stride * hgt
    const bmp = Buffer.alloc(size)
    bmp.write('BM', 0)
    bmp.writeUInt32LE(size, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(w, 18)
    bmp.writeInt32LE(hgt, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    await fs.writeFile(path.join(dir, 'pic.bmp'), bmp)
    const r = await loadImageTool.execute({imagePath: 'pic.bmp'}, ctx(dir))
    expect(r.success).toBe(false)
    expect(r.error).toContain('当前运行时不支持 BMP')
    expect(r.error).toContain('转换为 PNG/JPEG/WebP')
  })

  it('D：超限图片落**压缩后**字节的快照（hash ≠ 原图 hash，且 ≤3.5MB）', async () => {
    const big = await sharp(noise(1600, 1600, 3), {raw: {width: 1600, height: 1600, channels: 3}})
      .png({compressionLevel: 0})
      .toBuffer()
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES)
    await fs.writeFile(path.join(dir, 'big.png'), big)

    const r = await loadImageTool.execute({imagePath: 'big.png'}, ctx(dir))
    expect(r.success).toBe(true)
    const snapPath = /^image_path: (.+)$/m.exec(String(r.output))?.[1] ?? ''
    const snapBytes = await fs.readFile(onDisk(snapPath))
    expect(snapPath.endsWith('.jpg')).toBe(true)          // 不透明 → JPEG
    expect(String(r.output)).toContain('mime: image/jpeg')
    expect(snapBytes.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    expect(sha(snapBytes)).not.toBe(sha(big))             // 快照 = 压缩后字节，不是原图字节
    expect(String(r.output)).toContain(`bytes: ${snapBytes.length}`)
  })

  it('小图不打标记：快照字节与原图逐字节相同（未触发压缩 → 行为不变）', async () => {
    const png = await smallPng()
    await fs.writeFile(path.join(dir, 's.png'), png)
    const r = await loadImageTool.execute({imagePath: 's.png'}, ctx(dir))
    expect(r.success).toBe(true)
    const snapPath = /^image_path: (.+)$/m.exec(String(r.output))?.[1] ?? ''
    expect(sha(await fs.readFile(onDisk(snapPath)))).toBe(sha(png))
  })

  it('formatLoadImageOutput 形状确定（首行 image_path，无 CR）', () => {
    const out = formatLoadImageOutput({path: 'E:/d/<h>.png', mime: 'image/png', bytes: 12}, 'a.png')
    expect(out.split('\n')[0]).toMatch(/^image_path: E:\/d\/<h>\.png$/)
    expect(out).not.toContain('\r')
  })
})
