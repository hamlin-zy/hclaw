/**
 * 编码守卫模块 — 检测并修复 bash 写文件导致的编码漂移
 *
 * 核心原则：以目标文件原始编码为准，不假定任何编码为"标准"。
 * 当检测到写文件操作导致文件编码与原始编码不一致时，自动对齐。
 */

import * as fs from 'fs/promises'
import * as fsSync from 'fs'
import * as jschardet from 'jschardet'
import iconv from 'iconv-lite'

// ─── 常量 ─────────────────────────────────────────────

/** 写文件命令正则模式（保守策略首批覆盖） */
const WRITE_CMD_PATTERNS = [
  // Set-Content: 匹配路径参数
  { regex: /Set-Content\s+(?:.*\s)?(?:-Path\s+)?['"]([^'"]+)['"]|Set-Content\s+(\S+)/gi },
  // Out-File: 匹配路径参数
  { regex: /Out-File\s+(?:.*\s)?(?:-FilePath\s+)?['"]([^'"]+)['"]|Out-File\s+(\S+)/gi },
  // > 重定向: 排除比较运算符 (>=, <=, !=, -gt, -ge, >$null)
  { regex: /(?<![<>=!-])\s>(?!>)\s*['"]?([^'"\s|;]+)/g },
  // >> 追加重定向
  { regex: /(?<![<>=!-])>>\s*['"]?([^'"\s|;]+)/g },
  // [System.IO.File]::WriteAllText/WriteAllLines/AppendAllText('path', ...)
  { regex: /\[System\.IO\.File\]::(?:WriteAllText|WriteAllLines|AppendAllText)\(['"]([^'"]+)['"]/gi },
]

/** 安全用法模式 — 匹配到这些时跳过编码干预 */
const SAFE_USAGE_PATTERNS = [
  /-Encoding\s+utf8/i,
  /-Encoding\s+UTF-8/i,
]

/** BOM 标记映射：BOM 字节 → 编码名称 */
const BOM_SIGNATURES: Array<[Buffer, string]> = [
  [Buffer.from([0xEF, 0xBB, 0xBF]), 'UTF-8'],
  [Buffer.from([0xFF, 0xFE]), 'UTF-16LE'],
  [Buffer.from([0xFE, 0xFF]), 'UTF-16BE'],
  [Buffer.from([0x00, 0x00, 0xFE, 0xFF]), 'UTF-32BE'],
  [Buffer.from([0xFF, 0xFE, 0x00, 0x00]), 'UTF-32LE'],
]

/** jschardet 到 iconv-lite 的编码名称映射 */
const ENCODING_MAP: Record<string, string> = {
  'UTF-8': 'utf8',
  'UTF-16LE': 'utf16le',
  'UTF-16BE': 'utf16be',
  'GB2312': 'gbk',
  'GBK': 'gbk',
  'Big5': 'big5',
  'Shift_JIS': 'shiftjis',
  'EUC-KR': 'euc-kr',
  'windows-1252': 'cp1252',
  'ISO-8859-1': 'iso-8859-1',
}

/** jschardet 最小置信度阈值 */
const CONFIDENCE_THRESHOLD = 0.8

/** 编码检测最大读取字节数（64KB） */
const MAX_DETECT_BYTES = 64 * 1024

// ─── 编码检测 ─────────────────────────────────────────────

/**
 * 检测文件的实际编码
 *
 * 策略优先级：
 * 1. BOM 检测（前 4 字节）
 * 2. jschardet 检测（读取前 64KB）
 * 3. 纯 ASCII 文件回退到 'utf8'
 */
export async function detectFileEncoding(filePath: string): Promise<string> {
  let fd: number | null = null
  try {
    const stat = await fs.stat(filePath)
    if (stat.size === 0) return 'utf8'

    const readSize = Math.min(stat.size, MAX_DETECT_BYTES)
    const buf = Buffer.alloc(readSize)

    fd = fsSync.openSync(filePath, 'r')
    fsSync.readSync(fd, buf, 0, readSize, 0)

    const bufSlice = readSize < MAX_DETECT_BYTES ? buf.subarray(0, readSize) : buf

    // 1. BOM 检测
    for (const [signature, encoding] of BOM_SIGNATURES) {
      if (bufSlice.subarray(0, signature.length).equals(signature)) {
        return encoding
      }
    }

    // 2. 纯 ASCII 跳过（无需继续检测）
    if (isPureAscii(bufSlice)) {
      return 'UTF-8'
    }

    // 3. jschardet 检测
    const result = jschardet.detect(bufSlice)
    if (result && result.confidence >= CONFIDENCE_THRESHOLD) {
      const mapped = ENCODING_MAP[result.encoding]
      if (mapped) return mapped
    }

    return 'UTF-8'
  } finally {
    if (fd !== null) fsSync.closeSync(fd)
  }
}

/**
 * 检查 Buffer 是否全是 ASCII 字符
 */
function isPureAscii(buf: Buffer): boolean {
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7F) return false
  }
  return true
}

// ─── 命令解析 ─────────────────────────────────────────────

/**
 * 从 PowerShell 命令中提取写文件目标路径
 *
 * 保守策略：仅识别 Set-Content, Out-File, >, >> 四种模式
 */
export function parseFileWriteTargets(command: string): string[] {
  const paths: string[] = []

  // 安全检查：匹配到安全用法模式则返回空
  for (const safePattern of SAFE_USAGE_PATTERNS) {
    if (safePattern.test(command)) {
      return []
    }
  }

  for (const { regex } of WRITE_CMD_PATTERNS) {
    const matches = command.matchAll(regex)
    for (const match of matches) {
      for (let i = 1; i < match.length; i++) {
        if (match[i]) {
          const p = match[i].trim()
          if (p.length > 0 && !paths.includes(p)) {
            paths.push(p)
          }
          break
        }
      }
    }
  }

  return paths
}

// ─── 编码对齐 ─────────────────────────────────────────────

/**
 * 检查文件是否为二进制文件（魔数检测 + NUL 字节比例）
 */
function isBinaryFile(buf: Buffer): boolean {
  if (buf.length < 4) return false

  const firstBytes = buf.subarray(0, 4)
  const binarySignatures = [
    Buffer.from([0x89, 0x50, 0x4E, 0x47]), // PNG
    Buffer.from([0xFF, 0xD8, 0xFF]),        // JPEG
    Buffer.from([0x47, 0x49, 0x46]),        // GIF
    Buffer.from([0x42, 0x4D]),              // BMP
    Buffer.from([0x50, 0x4B]),              // ZIP/DOCX/XLSX
    Buffer.from([0x7F, 0x45, 0x4C, 0x46]), // ELF
    Buffer.from([0x4D, 0x5A]),              // EXE/DLL
    Buffer.from([0x25, 0x50, 0x44, 0x46]), // PDF
  ]

  for (const sig of binarySignatures) {
    if (firstBytes.subarray(0, sig.length).equals(sig)) {
      return true
    }
  }

  // 检查前 512 字节中 NUL 字节比例 > 30% 则视为二进制
  const checkLen = Math.min(buf.length, 512)
  let nullCount = 0
  for (let i = 0; i < checkLen; i++) {
    if (buf[i] === 0) nullCount++
  }
  return nullCount / checkLen > 0.3
}

/**
 * 检查 Buffer 开头是否有 UTF-8 BOM
 */
function hasUtf8Bom(buf: Buffer): boolean {
  return buf.length >= 3
    && buf[0] === 0xEF
    && buf[1] === 0xBB
    && buf[2] === 0xBF;
}

/**
 * 剥离 UTF-8 BOM（前 3 字节）
 */
function stripUtf8Bom(buf: Buffer): Buffer {
  return buf.subarray(3);
}

/**
 * 对齐文件编码：如果当前编码与原始编码不一致，自动修复
 *
 * 额外处理：写操作引入 UTF-8 BOM 时自动剥离
 * [System.IO.File]::WriteAllText 配合 [Text.Encoding]::UTF8 的已知陷阱
 *
 * @returns 是否执行了对齐操作
 */
export async function alignFileEncoding(
  filePath: string,
  originalEncoding: string,
): Promise<boolean> {
  try {
    const buf = await fs.readFile(filePath)
    if (buf.length < 4) return false
    if (isBinaryFile(buf)) return false

    // BOM 剥离：原始编码非 UTF-8（即无 BOM），但当前文件头部出现 BOM
    const originalWasUtf8 = /^UTF-8$/i.test(originalEncoding)
    if (!originalWasUtf8 && hasUtf8Bom(buf)) {
      await fs.writeFile(filePath, stripUtf8Bom(buf))
      return true
    }

    const currentEncoding = await detectFileEncoding(filePath)
    if (normalizeEncodingName(currentEncoding) === normalizeEncodingName(originalEncoding)) {
      return false
    }

    const text = iconv.decode(buf, currentEncoding)
    const corrected = iconv.encode(text, originalEncoding)
    await fs.writeFile(filePath, corrected)
    return true
  } catch {
    return false
  }
}

/**
 * 规范化编码名称用于比较
 */
function normalizeEncodingName(encoding: string): string {
  return encoding.toUpperCase().replace(/[^A-Z0-9]/g, '')
}
