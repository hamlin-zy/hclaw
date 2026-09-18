import {describe, it, expect} from 'vitest'
import {
  injectLoadedImages,
  parseSnapshotPath,
  buildLoadImageTextBlock,
  LOAD_IMAGE_SNAPSHOT_PATH_PREFIX,
} from '../../../../src/main/agent/utils/loadImageInjection'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const TOOL_RESULT = 'image_path: /snap/abc.png\nmime: image/png\nbytes: 8\nname: a.png'

const assistant = {role: 'assistant', content: '', toolCalls: [{id: 'tc1', name: 'load_image', arguments: {}}]}
const tool = {role: 'tool', toolCallId: 'tc1', functionName: 'load_image', content: '', toolResult: TOOL_RESULT}
const reader = async () => PNG

describe('injectLoadedImages', () => {
  it('解析 image_path 首行', () => {
    expect(parseSnapshotPath(TOOL_RESULT)).toBe('/snap/abc.png')
    expect(parseSnapshotPath('boom')).toBeNull()
    expect(parseSnapshotPath(undefined)).toBeNull()
  })

  it('在 tool 段之后插入一条合成 user 消息（锚 toolCallId，content 两段）', async () => {
    const out = await injectLoadedImages([assistant, tool] as never[], reader)
    expect(out).toHaveLength(3)
    const inj = out[2] as any
    expect(inj.role).toBe('user')
    expect(inj.id).toBe('load-image:tc1')
    // 文本块 = 既有约定 `【图片文件路径】<快照绝对路径>`（降级剥图后仍是有效回退依据，不留谎言文案）
    expect(inj.content[0]).toEqual({type: 'text', text: `${LOAD_IMAGE_SNAPSHOT_PATH_PREFIX}/snap/abc.png`})
    expect(inj.content[0].text).toBe(buildLoadImageTextBlock('/snap/abc.png'))
    expect(inj.content[0].text).not.toContain('已加载')
    expect(inj.content[1].type).toBe('image_url')
    expect(inj.content[1].image_url.url.startsWith('data:image/png;base64,')).toBe(true)
  })

  it('R2：两次运行输出逐字节一致，且 id 不含时间/随机', async () => {
    const a = await injectLoadedImages([assistant, tool] as never[], reader)
    const b = await injectLoadedImages([assistant, tool] as never[], reader)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect((a[2] as any).id).toBe('load-image:tc1')
  })

  it('不修改入参；无变更返回原引用', async () => {
    const input: any[] = [{role: 'user', content: 'hi'}]
    expect(await injectLoadedImages(input, reader)).toBe(input)
  })

  it('工具失败 / 无 image_path / 读文件失败 → 跳过注入，不抛', async () => {
    const errTool = {...tool, isError: true}
    expect((await injectLoadedImages([assistant, errTool] as never[], reader)).length).toBe(2)
    const bad = {...tool, toolResult: 'boom'}
    expect((await injectLoadedImages([assistant, bad] as never[], reader)).length).toBe(2)
    const throwing = async () => { throw new Error('no file') }
    expect((await injectLoadedImages([assistant, tool] as never[], throwing)).length).toBe(2)
  })

  it('多个 tool 调用：合成消息统一排在 tool 段之后（Anthropic 配对安全）', async () => {
    const t2 = {role: 'tool', toolCallId: 'tc2', functionName: 'load_image', content: '', toolResult: 'image_path: /snap/d.png\nmime: image/png'}
    const other = {role: 'tool', toolCallId: 'tc3', functionName: 'bash', content: '', toolResult: 'ok'}
    const out: any[] = await injectLoadedImages([assistant, tool, other, t2] as never[], reader)
    const lastToolIdx = Math.max(...out.map((m, i) => m.role === 'tool' ? i : -1))
    const firstInjIdx = out.findIndex(m => m.role === 'user' && String(m.id).startsWith('load-image:'))
    expect(firstInjIdx).toBeGreaterThan(lastToolIdx)
  })
})
