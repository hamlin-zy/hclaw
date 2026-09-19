import {createHash} from 'crypto'

/**
 * 计算记忆内容摘要：内容变化时 digest 变化，用于跳过重复注入
 */
export function computeMemoryDigest(content: {
  skillMd: string | null
  preferencesMd: string | null
  projectMemoryMd: string | null
  projectName: string | null
}): string {
  const hash = createHash('sha256')
  hash.update(content.skillMd ?? '')
  hash.update('\u0000')
  hash.update(content.preferencesMd ?? '')
  hash.update('\u0000')
  hash.update(content.projectMemoryMd ?? '')
  hash.update('\u0000')
  hash.update(content.projectName ?? '')
  return hash.digest('hex')
}
