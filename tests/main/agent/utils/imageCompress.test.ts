import {describe, it, expect} from 'vitest'
import * as crypto from 'crypto'
import sharp from 'sharp'
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_EDGE,
  ImageCompressError,
  compressImage,
  isLoadableImageExt,
  needsFormatConversion,
  mimeForExt,
} from '../../../../src/main/agent/utils/imageCompress'

/** 确定性噪声像素（固定 PRNG；测试输入，非输出确定性的一部分） */
function noise(w: number, h: number, channels: number): Buffer {
  const b = Buffer.alloc(w * h * channels)
  let s = 123456789
  for (let i = 0; i < b.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0
    b[i] = (s >>> 16) & 0xff
  }
  return b
}

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex')

async function opaqueJpeg(w: number, h: number): Promise<Buffer> {
  return sharp(noise(w, h, 3), {raw: {width: w, height: h, channels: 3}}).jpeg({quality: 95}).toBuffer()
}

/** 不压缩 PNG（compressionLevel 0）：体积 ≈ raw 字节数，便于构造超限样本 */
async function opaquePngBig(w: number, h: number): Promise<Buffer> {
  return sharp(noise(w, h, 3), {raw: {width: w, height: h, channels: 3}}).png({compressionLevel: 0}).toBuffer()
}

async function alphaPngBig(w: number, h: number): Promise<Buffer> {
  return sharp(noise(w, h, 4), {raw: {width: w, height: h, channels: 4}}).png({compressionLevel: 0}).toBuffer()
}

async function smallPng(): Promise<Buffer> {
  return sharp({create: {width: 40, height: 30, channels: 3, background: '#3366ff'}}).png().toBuffer()
}

/** 平滑渐变（低熵），长边 >1568 触发缩放，但各质量档均远小于体积上限 → 便于测体积单调性 */
async function smoothGradientPng(w: number, h: number): Promise<Buffer> {
  const b = Buffer.alloc(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3
      b[i] = (x * 255 / w) | 0
      b[i + 1] = (y * 255 / h) | 0
      b[i + 2] = ((x + y) * 255 / (w + h)) | 0
    }
  }
  return sharp(b, {raw: {width: w, height: h, channels: 3}}).png({compressionLevel: 0}).toBuffer()
}

/** 带 EXIF Orientation 的 JPEG（像素横放，方向标签要求旋转）。orientation 6 = 顺时针 90°。 */
async function orientedJpeg(w: number, h: number, orientation: number): Promise<Buffer> {
  return sharp(noise(w, h, 3), {raw: {width: w, height: h, channels: 3}})
    .jpeg({quality: 95})
    .withMetadata({orientation})
    .toBuffer()
}

// --- 最小 2 帧 GIF 生成器（sharp 本构建不能从 raw 合成动画输出，故手写 LZW）---
function lzwEncode(indices: number[], minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize
  const end = clear + 1
  const out: number[] = []
  let cur = 0, curBits = 0, codeSize = minCodeSize + 1
  const emit = (code: number) => {
    cur |= code << curBits
    curBits += codeSize
    while (curBits >= 8) { out.push(cur & 0xff); cur >>= 8; curBits -= 8 }
  }
  let dict = new Map<string, number>()
  for (let i = 0; i < clear; i++) dict.set(String(i), i)
  let next = end + 1
  emit(clear)
  let w = ''
  for (const k of indices) {
    const wk = w === '' ? String(k) : `${w},${k}`
    if (dict.has(wk)) { w = wk; continue }
    emit(dict.get(w)!)
    dict.set(wk, next++)
    if (next === (1 << codeSize) && codeSize < 12) codeSize++
    w = String(k)
  }
  if (w !== '') emit(dict.get(w)!)
  emit(end)
  if (curBits > 0) out.push(cur & 0xff)
  return Buffer.from(out)
}

function makeAnimatedGif(w: number, h: number, frames: number[][]): Buffer {
  const frameBlocks = frames.map(indices => {
    const parts: Buffer[] = []
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00])) // GCE, delay 100ms
    const id = Buffer.alloc(10)
    id[0] = 0x2c
    id.writeUInt16LE(w, 5); id.writeUInt16LE(h, 7)
    parts.push(id)
    parts.push(Buffer.from([0x02])) // LZW min code size
    const data = lzwEncode(indices, 2)
    for (let i = 0; i < data.length; i += 255) {
      const sub = data.subarray(i, i + 255)
      parts.push(Buffer.from([sub.length, ...sub]))
    }
    parts.push(Buffer.from([0x00]))
    return Buffer.concat(parts)
  })
  const head = Buffer.alloc(13)
  head.write('GIF89a', 0, 'ascii')
  head.writeUInt16LE(w, 6); head.writeUInt16LE(h, 8)
  head[10] = 0x80 // global color table, 2 entries
  const gct = Buffer.from([255, 0, 0, 0, 0, 255])
  const loop = Buffer.from([0x21, 0xff, 0x0b, 0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30, 0x03, 0x01, 0x00, 0x00, 0x00])
  return Buffer.concat([head, gct, loop, ...frameBlocks, Buffer.from([0x3b])])
}

describe('imageCompress 常量与格式判定', () => {
  it('上限契约：3.5MB / 长边 1568', () => {
    expect(MAX_IMAGE_BYTES).toBe(3670016)
    expect(MAX_IMAGE_EDGE).toBe(1568)
  })

  it('扩展名白名单：png/jpg/jpeg/webp/gif + tiff 转码；bmp 与其余拒绝', () => {
    for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tiff', '.tif', '.PNG']) {
      expect(isLoadableImageExt(e), e).toBe(true)
    }
    for (const e of ['.bmp', '.svg', '.txt', '.heic', '.avif', '']) {
      expect(isLoadableImageExt(e), e).toBe(false)
    }
    // BMP 运行时无解码器 → 必须从可加载/可转码集合移除，避免承诺与行为矛盾
    expect(needsFormatConversion('.bmp')).toBe(false)
    expect(needsFormatConversion('.tif')).toBe(true)
    expect(needsFormatConversion('.png')).toBe(false)
  })

  it('mimeForExt 不静默回退（不支持的扩展名 → null，而非 image/jpeg）', () => {
    expect(mimeForExt('.tiff')).toBe('image/tiff')
    expect(mimeForExt('.BMP')).toBeNull()
    expect(mimeForExt('.ppm')).toBeNull()
  })
})

describe('imageCompress 触发条件', () => {
  it('未触发（体积/长边/格式都合格）→ 原字节返回，mime/ext 规范', async () => {
    const png = await smallPng()
    const out = await compressImage(png, 'image/png')
    expect(out.buffer.equals(png)).toBe(true)
    expect(out.mime).toBe('image/png')
    expect(out.ext).toBe('.png')

    const jpg = await opaqueJpeg(64, 48)
    const outJpg = await compressImage(jpg, 'image/jpeg')
    expect(outJpg.buffer.equals(jpg)).toBe(true)
    expect(outJpg.mime).toBe('image/jpeg')
    expect(outJpg.ext).toBe('.jpg')

    const gif = await sharp({create: {width: 32, height: 32, channels: 3, background: '#0f0'}}).gif().toBuffer()
    const outGif = await compressImage(gif, 'image/gif')
    expect(outGif.buffer.equals(gif)).toBe(true)
    expect(outGif.mime).toBe('image/gif')
  })

  it('mime 别名归一（image/jpg → canonical image/jpeg）', async () => {
    const jpg = await opaqueJpeg(64, 48)
    const out = await compressImage(jpg, 'image/jpg')
    expect(out.mime).toBe('image/jpeg')
    expect(out.ext).toBe('.jpg')
  })

  it('不支持的 mime → UNSUPPORTED（不猜测、不静默）', async () => {
    const png = await smallPng()
    const err: unknown = await compressImage(png, 'image/avif').catch(e => e)
    expect(err).toBeInstanceOf(ImageCompressError)
    expect((err as ImageCompressError).code).toBe('IMAGE_COMPRESS_UNSUPPORTED')
  })
})

describe('imageCompress 策略与迭代', () => {
  it('超限且不透明 → JPEG，且体积 ≤3.5MB、长边 ≤1568', async () => {
    const big = await opaquePngBig(1600, 1600)
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES) // 前提：确实超限
    const out = await compressImage(big, 'image/png')
    expect(out.mime).toBe('image/jpeg')
    expect(out.ext).toBe('.jpg')
    expect(out.buffer.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    const meta = await sharp(out.buffer).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(MAX_IMAGE_EDGE)
  })

  it('含 alpha → WebP（保透明），且每轮迭代后仍 ≤3.5MB', async () => {
    const big = await alphaPngBig(1600, 1600)
    expect(big.length).toBeGreaterThan(MAX_IMAGE_BYTES)
    const out = await compressImage(big, 'image/png')
    expect(out.mime).toBe('image/webp')
    expect(out.ext).toBe('.webp')
    expect(out.buffer.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
    // 第一轮（q85/1568）在噪声 RGBA 上本就超限 → 必然走到后续轮次
    expect((await sharp(out.buffer).metadata()).hasAlpha).toBe(true)
  })

  it('仅长边超限（体积合格）也会触发缩放', async () => {
    const wide = await sharp({create: {width: 4000, height: 200, channels: 3, background: '#123456'}})
      .jpeg({quality: 60})
      .toBuffer()
    expect(wide.length).toBeLessThan(MAX_IMAGE_BYTES)
    const out = await compressImage(wide, 'image/jpeg')
    const meta = await sharp(out.buffer).metadata()
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBe(MAX_IMAGE_EDGE)
    expect(out.mime).toBe('image/jpeg')
  })

  it('bmp/tiff 需要转码：TIFF → PNG（无损容器转换，mime 与字节一致）', async () => {
    const tiff = await sharp(noise(200, 150, 3), {raw: {width: 200, height: 150, channels: 3}}).tiff().toBuffer()
    const out = await compressImage(tiff, 'image/tiff')
    expect(out.mime).toBe('image/png')
    expect(out.ext).toBe('.png')
    expect(out.buffer.slice(0, 4).toString('hex')).toBe('89504e47') // PNG magic
    expect((await sharp(out.buffer).metadata()).format).toBe('png')
  })
})

describe('imageCompress 确定性（R2：同输入 → 逐字节相同）', () => {
  it('转码路径：JPEG 两次输出 sha256 相同', async () => {
    const big = await opaquePngBig(1600, 1600)
    const a = await compressImage(big, 'image/png')
    const b = await compressImage(big, 'image/png')
    expect(sha(a.buffer)).toBe(sha(b.buffer))
  })

  it('alpha 路径：WebP 两次输出 sha256 相同', async () => {
    const big = await alphaPngBig(1600, 1600)
    const a = await compressImage(big, 'image/png')
    const b = await compressImage(big, 'image/png')
    expect(sha(a.buffer)).toBe(sha(b.buffer))
  })

  it('容器转换路径：TIFF→PNG 两次输出 sha256 相同', async () => {
    const tiff = await sharp(noise(300, 200, 3), {raw: {width: 300, height: 200, channels: 3}}).tiff().toBuffer()
    const a = await compressImage(tiff, 'image/tiff')
    const b = await compressImage(tiff, 'image/tiff')
    expect(sha(a.buffer)).toBe(sha(b.buffer))
  })

  it('元数据不入输出：像素相同、EXIF 不同的两份源 → 输出逐字节相同', async () => {
    const raw = noise(2000, 100, 3)
    const plain = await sharp(raw, {raw: {width: 2000, height: 100, channels: 3}}).jpeg({quality: 95}).toBuffer()
    const withExif = await sharp(raw, {raw: {width: 2000, height: 100, channels: 3}})
      .jpeg({quality: 95})
      .withMetadata({exif: {IFD0: {Software: 'hclaw-test'}}})
      .toBuffer()
    expect((await sharp(plain).metadata()).exif).toBeUndefined()
    expect((await sharp(withExif).metadata()).exif).toBeDefined() // 前提：源确实带 EXIF
    const a = await compressImage(plain, 'image/jpeg')
    const b = await compressImage(withExif, 'image/jpeg')
    expect(sha(a.buffer)).toBe(sha(b.buffer))
    expect((await sharp(a.buffer).metadata()).exif).toBeUndefined()
    expect((await sharp(a.buffer).metadata()).icc).toBeUndefined()
  })
})

describe('imageCompress EXIF 方向（重编码修正 + 确定性）', () => {
  it('orientation=6 的 JPEG 重编码后长宽互换（方向被修正），且不残留 EXIF', async () => {
    const src = await orientedJpeg(2000, 100, 6)
    expect((await sharp(src).metadata()).orientation).toBe(6) // 前提：源确带方向标签
    const out = await compressImage(src, 'image/jpeg')
    const meta = await sharp(out.buffer).metadata()
    // 旋转后视觉为 100×2000 → 缩放到长边 1568（高 > 宽）
    expect(meta.height).toBe(MAX_IMAGE_EDGE)
    expect(meta.width).toBeLessThan(meta.height)
    expect(meta.orientation).toBeUndefined()
  })

  it('同一带 orientation 输入多次压缩 → sha256 相同（rotate 确定性，R2 不破）', async () => {
    const src = await orientedJpeg(2000, 100, 6)
    const a = await compressImage(src, 'image/jpeg')
    const b = await compressImage(src, 'image/jpeg')
    expect(sha(a.buffer)).toBe(sha(b.buffer))
  })

  it('orientation=1（正常）不旋转；与 orientation=6 输出不同（证明 rotate 生效）', async () => {
    const normal = await orientedJpeg(2000, 100, 1)
    const rotated = await orientedJpeg(2000, 100, 6)
    const a = await compressImage(normal, 'image/jpeg')
    const b = await compressImage(rotated, 'image/jpeg')
    expect(sha(a.buffer)).not.toBe(sha(b.buffer))
    const ma = await sharp(a.buffer).metadata()
    const mb = await sharp(b.buffer).metadata()
    expect(ma.width!).toBeGreaterThan(ma.height!)
    expect(mb.height!).toBeGreaterThan(mb.width!)
  })
})

describe('imageCompress 失败必须明确（不静默、不猜测）', () => {
  it('bmp：运行时无解码器，已移出支持集合 → UNSUPPORTED（诚实拒绝，不谎报可转码）', async () => {
    // 手写最小 24bit BMP
    const w = 4
    const h = 4
    const stride = w * 3 + ((4 - ((w * 3) % 4)) % 4)
    const size = 54 + stride * h
    const bmp = Buffer.alloc(size)
    bmp.write('BM', 0)
    bmp.writeUInt32LE(size, 2)
    bmp.writeUInt32LE(54, 10)
    bmp.writeUInt32LE(40, 14)
    bmp.writeInt32LE(w, 18)
    bmp.writeInt32LE(h, 22)
    bmp.writeUInt16LE(1, 26)
    bmp.writeUInt16LE(24, 28)
    const err: unknown = await compressImage(bmp, 'image/bmp').catch(e => e)
    expect(err).toBeInstanceOf(ImageCompressError)
    expect((err as ImageCompressError).code).toBe('IMAGE_COMPRESS_UNSUPPORTED')
    expect((err as ImageCompressError).message).toContain('不支持的图片格式')
  })

  it('动画 GIF（多帧）→ ANIMATED 明确拒绝，不静默丢帧', async () => {
    const animated = makeAnimatedGif(4, 4, [Array(16).fill(0), Array(16).fill(1)])
    expect((await sharp(animated, {animated: true}).metadata()).pages).toBe(2) // 前提：确为多帧
    const err: unknown = await compressImage(animated, 'image/gif').catch(e => e)
    expect(err).toBeInstanceOf(ImageCompressError)
    expect((err as ImageCompressError).code).toBe('IMAGE_COMPRESS_ANIMATED')
    expect((err as ImageCompressError).message).toContain('暂不支持动画 GIF')
    expect((err as ImageCompressError).message).toContain('请提供静帧或拆分后重试')
  })

  it('静帧 GIF 仍原字节透传（动画拒绝不误伤静帧）', async () => {
    const gif = await sharp({create: {width: 32, height: 32, channels: 3, background: '#0f0'}}).gif().toBuffer()
    expect((await sharp(gif).metadata()).pages ?? 1).toBe(1)
    const out = await compressImage(gif, 'image/gif')
    expect(out.buffer.equals(gif)).toBe(true)
    expect(out.mime).toBe('image/gif')
  })

  it('损坏字节 + 需要转码 → DECODE 明确错误', async () => {
    const err: unknown = await compressImage(Buffer.from([1, 2, 3, 4]), 'image/tiff').catch(e => e)
    expect(err).toBeInstanceOf(ImageCompressError)
    expect((err as ImageCompressError).code).toBe('IMAGE_COMPRESS_DECODE')
  })

  it('损坏字节但体积/尺寸/格式均无需处理 → 原样放行（保持既有契约）', async () => {
    const junk = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
    const out = await compressImage(junk, 'image/png')
    expect(out.buffer.equals(junk)).toBe(true)
  })

  it('超限且无法解码 → DECODE 错误（不得静默放行导致请求期 400）', async () => {
    const junk = Buffer.alloc(MAX_IMAGE_BYTES + 1, 7)
    const err: unknown = await compressImage(junk, 'image/png').catch(e => e)
    expect(err).toBeInstanceOf(ImageCompressError)
    expect((err as ImageCompressError).code).toBe('IMAGE_COMPRESS_DECODE')
  })
})

describe('imageCompress 质量可配置（imageCompressQuality）', () => {
  it('同图更高 quality → 输出体积不减（60 ≤ 85 ≤ 95），且均触发重编码', async () => {
    const src = await smoothGradientPng(2000, 100)
    const q60 = await compressImage(src, 'image/png', {quality: 60})
    const q85 = await compressImage(src, 'image/png', {quality: 85})
    const q95 = await compressImage(src, 'image/png', {quality: 95})
    expect(q60.mime).toBe('image/jpeg')
    expect(q85.mime).toBe('image/jpeg')
    expect(q95.mime).toBe('image/jpeg')
    expect(q60.buffer.length).toBeLessThanOrEqual(q85.buffer.length)
    expect(q85.buffer.length).toBeLessThanOrEqual(q95.buffer.length)
    // 至少一处严格更大，证明质量确实进入编码而非被忽略
    expect(q95.buffer.length).toBeGreaterThan(q60.buffer.length)
  })

  it('不传 quality 与传 85 逐字节相同（回归锁定既有基线）', async () => {
    const src = await smoothGradientPng(2000, 100)
    const baseline = await compressImage(src, 'image/png')
    const explicit = await compressImage(src, 'image/png', {quality: 85})
    expect(sha(baseline.buffer)).toBe(sha(explicit.buffer))
  })

  it('quality 越界 clamp：0→1、101→100；NaN/undefined → 85', async () => {
    const src = await smoothGradientPng(2000, 100)
    const q1 = await compressImage(src, 'image/png', {quality: 1})
    const q0 = await compressImage(src, 'image/png', {quality: 0})
    expect(sha(q0.buffer)).toBe(sha(q1.buffer))

    const q100 = await compressImage(src, 'image/png', {quality: 100})
    const q101 = await compressImage(src, 'image/png', {quality: 101})
    expect(sha(q101.buffer)).toBe(sha(q100.buffer))

    const q85 = await compressImage(src, 'image/png', {quality: 85})
    const qNan = await compressImage(src, 'image/png', {quality: NaN})
    const qUndef = await compressImage(src, 'image/png', {quality: undefined})
    expect(sha(qNan.buffer)).toBe(sha(q85.buffer))
    expect(sha(qUndef.buffer)).toBe(sha(q85.buffer))
  })

  it('同一 (input, quality) 两次输出 sha256 相同（R2 确定性）', async () => {
    const src = await smoothGradientPng(2000, 100)
    for (const q of [40, 60, 85, 95]) {
      const a = await compressImage(src, 'image/png', {quality: q})
      const b = await compressImage(src, 'image/png', {quality: q})
      expect(sha(a.buffer), `q=${q}`).toBe(sha(b.buffer))
    }
  })

  it('小图未触发重编码 → quality 不影响（原字节透传）', async () => {
    const png = await smallPng()
    const out = await compressImage(png, 'image/png', {quality: 10})
    expect(out.buffer.equals(png)).toBe(true)
  })
})
