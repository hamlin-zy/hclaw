/**
 * userContentBuilder 共享函数测试
 *
 * buildUserHistoryContent：从 execution.ts 历史 user 消息重建分支抽取的
 * 「文本 + metadata.attachments → LLM content」构建逻辑。
 * session_handoff 首轮与 agent-start 历史重建共用此函数，
 * 保证两条链路输出逐字节一致（KV cache 前缀稳定）。
 *
 * toMessageAttachments：从 messageHandler.ts 抽取，生成渲染端
 * AttachmentPreview 兼容的 {id,name,type,size,path,isImage} 结构。
 */
import {describe, it, expect, beforeAll, afterAll} from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {
    buildUserHistoryContent,
    toMessageAttachments,
    buildCommandTaskContent,
} from '../../../../src/main/agent/utils/userContentBuilder'

// 1x1 红色 PNG
const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
)

describe('buildUserHistoryContent', () => {
    let tmpDir: string
    let imgPath: string

    beforeAll(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucb-'))
        imgPath = path.join(tmpDir, 'shot.png')
        fs.writeFileSync(imgPath, PNG_BYTES)
    })
    afterAll(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    it('无附件时返回原始文本（string，逐字不变）', async () => {
        const result = await buildUserHistoryContent('你好', [])
        expect(result).toBe('你好')
    })

    it('非图片附件：文本 + \n\n + [附件] 描述（history 分支既有格式）', async () => {
        const atts = [{path: '/a/b.txt', name: 'b.txt'}]
        const result = await buildUserHistoryContent('你好', atts)
        expect(result).toBe('你好\n\n[附件]\n文件: b.txt\n路径: /a/b.txt')
    })

    it('图片附件：返回 content 数组，文本含【图片文件路径】标记 + base64 image_url 块', async () => {
        const atts = [{path: imgPath, name: 'img.png'}]
        const result = await buildUserHistoryContent('看图', atts) as Array<{type: string; text?: string; image_url?: {url: string}}>

        expect(Array.isArray(result)).toBe(true)
        expect(result[0].type).toBe('text')
        expect(result[0].text).toContain('看图')
        expect(result[0].text).toContain(`【图片文件路径】${imgPath}`)
        expect(result[1].image_url?.url.startsWith('data:image/png;base64,')).toBe(true)
    })

    it('网络图片直接使用 URL，不读文件', async () => {
        const atts = [{path: 'https://example.com/a.png', name: 'a.png'}]
        const parts = await buildUserHistoryContent('t', atts) as Array<{type: string; image_url?: {url: string}}>
        expect(parts[1].image_url?.url).toBe('https://example.com/a.png')
    })

    it('图片读取失败时回退为文本描述，不抛错', async () => {
        const atts = [{path: '/not/exist.png', name: 'x.png'}]
        const parts = await buildUserHistoryContent('t', atts) as Array<{type: string; text?: string}>
        expect(parts[0].text).toContain(`[图片: /not/exist.png]`)
        expect(parts).toHaveLength(1)
    })
})

describe('toMessageAttachments', () => {
    it('生成 Attachment 结构：id/name/type/size/path/isImage', () => {
        const result = toMessageAttachments([
            {path: '/a/x.png', name: 'x.png', mimeType: 'image/png'},
            {path: '/a/y.pdf', name: 'y.pdf'},
        ])
        expect(result).toHaveLength(2)
        expect(result[0]).toMatchObject({name: 'x.png', type: 'image/png', size: 0, path: '/a/x.png', isImage: true})
        expect(result[0].id).toBeTruthy()
        expect(result[1]).toMatchObject({name: 'y.pdf', path: '/a/y.pdf', isImage: false})
        })
    })


describe('buildCommandTaskContent', () => {
    it('格式与 loop/execute.ts 首轮注入逐字节一致：<command-task> 包裹', () => {
        const template = '# 技能模式: systematic-debugging\n\n你正在使用技能'
        expect(buildCommandTaskContent(template)).toBe(
            `<command-task>\n${template}\n</command-task>`,
        )
    })

    it('空模板也生成完整包裹结构（由调用方决定是否注入）', () => {
        expect(buildCommandTaskContent('')).toBe('<command-task>\n\n</command-task>')
    })
})
