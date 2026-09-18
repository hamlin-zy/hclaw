import * as fs from 'fs/promises'
import * as path from 'path'
import crypto from 'crypto'
import {getHclawDataDir} from '../../hclawPaths'

export {MAX_IMAGE_BYTES} from './imageCompress'

export interface ImageSnapshot {
  /** 归一化（'/' 分隔）后的快照绝对路径 */
  path: string
  mime: string
  bytes: number
}

/**
 * 路径分隔符归一并转 '/'（确定性 + 跨平台一致）。
 */
export function normalizeSnapshotPath(p: string): string {
  return p.split(path.sep).join('/')
}

function defaultDir(): string {
  return path.join(getHclawDataDir(), 'attachments', 'snapshots')
}

/**
 * 把**已就绪的字节**落成不可变快照（load_image 走压缩后的字节，见 imageCompress.ts）。
 * 快照文件名 = `<sha256(bytes)>.<ext小写>`；内容相同 → 同名（幂等、去重）；已存在则不覆盖（不可变）。
 * @param buffer 待落盘字节（哈希即由此计算）
 * @param ext 规范扩展名（含点，小写，如 '.png'）
 * @param mime 与 buffer 内容严格一致的 mime
 * @param opts.dir 快照目录覆盖（测试注入临时目录；缺省 = data/attachments/snapshots）
 */
export async function saveBufferSnapshot(
  buffer: Buffer,
  ext: string,
  mime: string,
  opts?: {dir?: string},
): Promise<ImageSnapshot> {
  const dir = opts?.dir ?? defaultDir()
  const normalizedExt = (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()
  const hash = crypto.createHash('sha256').update(buffer).digest('hex')
  await fs.mkdir(dir, {recursive: true})
  const dest = path.join(dir, `${hash}${normalizedExt}`)
  // 不可变：已存在（同内容）不覆盖
  try {
    await fs.access(dest)
  } catch {
    await fs.writeFile(dest, buffer)
  }
  return {path: normalizeSnapshotPath(dest), mime, bytes: buffer.length}
}
