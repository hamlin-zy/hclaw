/**
 * encodingGuard 单元测试
 *
 * 覆盖：
 * - parseFileWriteTargets：从 PowerShell 命令提取写文件目标路径
 * - detectFileEncoding：BOM/ASCII/jschardet 编码检测（真实 fs 临时文件）
 * - alignFileEncoding：BOM 剥离与编码转换对齐（真实 fs 临时文件）
 *
 * 说明：
 * - GBK 检测依赖 jschardet 置信度，短文本（如 4 个汉字）置信度不足会被判为
 *   UTF-8，故 GBK 用例使用较长中文文本以保证稳定命中。
 * - 测试文件不做任何 mock，全部走真实 fs 操作（与 fileEditTool.test.ts 风格一致）。
 */
import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import * as iconv from 'iconv-lite'
import {
  alignFileEncoding,
  detectFileEncoding,
  parseFileWriteTargets,
} from '@/main/agent/tools/builtin/encodingGuard'

// ─── parseFileWriteTargets（纯函数）────────────────────────

describe('encodingGuard — parseFileWriteTargets', () => {
  it('Set-Content 提取 -Path 引号路径', () => {
    const result = parseFileWriteTargets(`Set-Content -Path 'C:\\x\\a.txt' 'hello'`)
    expect(result).toEqual(['C:\\x\\a.txt'])
  })

  it('Out-File 提取 -FilePath 路径（裸路径与引号路径）', () => {
    expect(parseFileWriteTargets('Out-File -FilePath out.txt')).toEqual(['out.txt'])
    expect(parseFileWriteTargets('Out-File -FilePath "out.txt"')).toEqual(['out.txt'])
  })

  it('> 重定向提取输出路径', () => {
    expect(parseFileWriteTargets('echo hi > out.txt')).toEqual(['out.txt'])
  })

  it('>> 追加重定向提取路径', () => {
    expect(parseFileWriteTargets('echo hi >> log.txt')).toEqual(['log.txt'])
  })

  it('[System.IO.File]::WriteAllText 提取路径', () => {
    const result = parseFileWriteTargets(
      `[System.IO.File]::WriteAllText('C:\\x\\y.txt', 'content')`,
    )
    expect(result).toEqual(['C:\\x\\y.txt'])
  })

  it('安全用法（-Encoding utf8/UTF-8）跳过编码干预，返回空数组', () => {
    expect(parseFileWriteTargets('Set-Content -Path a.txt -Encoding utf8 "x"')).toEqual([])
    expect(parseFileWriteTargets('Set-Content -Path a.txt -Encoding UTF-8 "x"')).toEqual([])
  })

  it('排除比较运算符（-gt / -ge 不是重定向）', () => {
    expect(parseFileWriteTargets('if ($a -gt $b) {}')).toEqual([])
    expect(parseFileWriteTargets('$x -ge 5')).toEqual([])
  })

  it('无写文件命令返回空数组', () => {
    expect(parseFileWriteTargets('echo hello world')).toEqual([])
  })

  it('同一路径出现多次只返回一次（去重）', () => {
    const result = parseFileWriteTargets('echo hi > out.txt; echo hi > out.txt')
    expect(result).toEqual(['out.txt'])
  })
})

// ─── detectFileEncoding（真实文件）────────────────────────

describe('encodingGuard — detectFileEncoding', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-detect-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('UTF-8 BOM 文件检测为 UTF-8', async () => {
    const filePath = path.join(tmpDir, 'utf8-bom.txt')
    const content = Buffer.from('中文内容 hello', 'utf8')
    await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), content]))

    expect(await detectFileEncoding(filePath)).toBe('UTF-8')
  })

  it('UTF-16LE BOM 文件检测为 UTF-16LE', async () => {
    const filePath = path.join(tmpDir, 'utf16-le.txt')
    const content = iconv.encode('hello 中文', 'utf16le')
    await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xFF, 0xFE]), content]))

    expect(await detectFileEncoding(filePath)).toBe('UTF-16LE')
  })

  it('纯 ASCII 文件检测为 UTF-8', async () => {
    const filePath = path.join(tmpDir, 'ascii.txt')
    await fs.writeFile(filePath, 'plain ascii 123', 'utf8')

    expect(await detectFileEncoding(filePath)).toBe('UTF-8')
  })

  it('GBK 编码中文文件检测为 GBK', async () => {
    const filePath = path.join(tmpDir, 'gbk.txt')
    const gbkText = '这是一段足够长的中文文本用于 GBK 编码检测识别中华人民共和国'
    await fs.writeFile(filePath, iconv.encode(gbkText, 'gbk'))

    // jschardet 检测为 GB2312，经 ENCODING_MAP 映射为 iconv 名称 'gbk'（小写）
    expect(await detectFileEncoding(filePath)).toBe('gbk')
  })

  it('空文件检测为 utf8', async () => {
    const filePath = path.join(tmpDir, 'empty.txt')
    await fs.writeFile(filePath, Buffer.alloc(0))

    expect(await detectFileEncoding(filePath)).toBe('utf8')
  })

  it('不存在的文件抛出异常', async () => {
    const missing = path.join(tmpDir, 'not-exists.txt')
    await expect(detectFileEncoding(missing)).rejects.toThrow()
  })
})

// ─── alignFileEncoding（真实文件）────────────────────────

describe('encodingGuard — alignFileEncoding', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-align-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, {recursive: true, force: true})
  })

  it('原始 UTF-8 无 BOM，当前被写入 BOM → 剥离 BOM 并返回 true', async () => {
    const filePath = path.join(tmpDir, 'bom-strip.txt')
    await fs.writeFile(filePath, 'abc', 'utf8')
    // 模拟写操作引入 UTF-8 BOM
    await fs.writeFile(filePath, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('abc', 'utf8')]))

    const changed = await alignFileEncoding(filePath, 'UTF-8')
    expect(changed).toBe(true)

    const after = await fs.readFile(filePath)
    expect(after[0]).not.toBe(0xEF)
    expect(after.toString('utf8')).toBe('abc')
  })

  it('编码一致 → 返回 false 且文件不变', async () => {
    const filePath = path.join(tmpDir, 'same.txt')
    await fs.writeFile(filePath, 'hello world', 'utf8')
    const before = await fs.readFile(filePath)

    const changed = await alignFileEncoding(filePath, 'UTF-8')
    expect(changed).toBe(false)
    expect(await fs.readFile(filePath)).toEqual(before)
  })

  it('已知限制：原始带 BOM 的 UTF-8 文件被写入带 BOM 内容后，BOM 会被剥离（内容无损）', async () => {
    // ⚠️ 已知限制（技术债）：detectFileEncoding 无法区分"UTF-8 带 BOM"与"UTF-8 无 BOM"
    //（BOM 检测与 ASCII 回退都返回 'UTF-8'），导致 alignFileEncoding 对原始带 BOM 的
    // UTF-8 文件也会触发 BOM 剥离。影响：BOM 状态变化，内容本身无损。
    // 待修复方向：bashTool 记录原始 BOM 状态并传给 alignFileEncoding。
    const filePath = path.join(tmpDir, 'bom-original.txt')
    const bom = Buffer.from([0xEF, 0xBB, 0xBF])
    // 原始文件：带 BOM 的 UTF-8
    await fs.writeFile(filePath, Buffer.concat([bom, Buffer.from('原始内容', 'utf8')]))

    // 模拟 bash 写操作后仍是带 BOM 的 UTF-8（WriteAllText + UTF8 编码）
    await fs.writeFile(filePath, Buffer.concat([bom, Buffer.from('修改后内容', 'utf8')]))

    const changed = await alignFileEncoding(filePath, 'UTF-8')
    // 当前行为：BOM 被剥离（已知限制）
    expect(changed).toBe(true)
    const after = await fs.readFile(filePath)
    const stillHasBom = after[0] === 0xEF && after[1] === 0xBB && after[2] === 0xBF
    expect(stillHasBom).toBe(false)
    // 内容无损
    expect(after.toString('utf8').replace(/^\uFEFF/, '')).toBe('修改后内容')
  })

  it('GBK 原始编码，当前被写成 UTF-8 → 转回 GBK', async () => {
    const filePath = path.join(tmpDir, 'gbk-restore.txt')
    const originalGbk = iconv.encode('中文内容保持', 'gbk')
    // 原始文件为 GBK
    await fs.writeFile(filePath, originalGbk)
    // 模拟写操作将其覆盖为 UTF-8
    await fs.writeFile(filePath, iconv.encode('中文内容保持', 'utf8'))

    const changed = await alignFileEncoding(filePath, 'GBK')
    expect(changed).toBe(true)

    const after = await fs.readFile(filePath)
    expect(after.equals(originalGbk)).toBe(true)
  })

  it('二进制文件（PNG 魔数）→ 返回 false 不处理', async () => {
    const filePath = path.join(tmpDir, 'image.png')
    const pngBuf = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47]), Buffer.from('fakepngdata')])
    await fs.writeFile(filePath, pngBuf)

    const changed = await alignFileEncoding(filePath, 'GBK')
    expect(changed).toBe(false)
    expect(await fs.readFile(filePath)).toEqual(pngBuf)
  })
})
