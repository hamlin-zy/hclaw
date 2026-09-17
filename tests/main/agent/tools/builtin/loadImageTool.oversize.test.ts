import {describe, it, expect, beforeEach, afterEach, vi} from 'vitest'
import * as os from 'os'
import * as fs from 'fs/promises'
import * as path from 'path'

const h = vi.hoisted(() => ({dataDir: ''}))
vi.mock('../../../../../src/main/config', () => ({
  getHclawDataDir: () => h.dataDir,
}))
vi.mock('../../../../../src/main/hclawPaths', async () => await import('../../../../../src/main/config'))  // 路径能力已下沉到叶子 hclawPaths：让叶子跟随本文件对 config 的桩，避免绕过 mock 落到真实 ~/.hclaw
vi.mock('../../../../../src/main/repositories/sqlite/systemSettingsRepository', () => ({
  systemSettingsRepo: {getJson: () => null},
}))
// 只替换 compressImage：模拟"3 轮迭代后仍超限"。
// 该路径为**防御性兜底**：真实压缩策略会持续降质/降尺寸，端到端几乎不可达
// （真实 3 轮输出仍 >3.5MB 需极端输入），故仅由本 mock 覆盖其对外文案，
// 不得据此放宽上限档位（会削弱兜底语义）。
vi.mock('../../../../../src/main/agent/utils/imageCompress', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/main/agent/utils/imageCompress')>()
  return {
    ...actual,
    compressImage: vi.fn(async () => {
      throw new actual.ImageCompressError(
        'IMAGE_COMPRESS_TOO_LARGE',
        `图片压缩后仍超过 ${actual.MAX_IMAGE_BYTES / (1024 * 1024)}MB（压缩后 9000000 bytes），请手动压缩或裁剪`,
      )
    }),
  }
})
import {loadImageTool} from '../../../../../src/main/agent/tools/builtin/loadImageTool'

const ctx = (workingDir: string) => ({
  workingDir,
  abortSignal: new AbortController().signal,
  sendMessage: () => {},
}) as never

describe('load_image：压缩后仍超限（B 项兜底）', () => {
  let dir: string
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-over-'))
    h.dataDir = dir
    await fs.writeFile(path.join(dir, 'big.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
  })
  afterEach(async () => { await fs.rm(dir, {recursive: true, force: true}) })

  it('→ success:false + 明确文案（绝不静默放行）', async () => {
    const r = await loadImageTool.execute({imagePath: 'big.png'}, ctx(dir))
    expect(r.success).toBe(false)
    expect(r.output).toBe('')
    expect(r.error).toContain('图片压缩后仍超过 3.5MB')
    expect(r.error).toContain('请手动压缩或裁剪')
  })
})
