/**
 * stripAttachmentImagePaths 单测
 *
 * 两种标记语义分离后的请求期剥离：
 * - 只剥【附件图片路径】（ATTACHMENT_IMAGE_PATH_PREFIX）
 * - 绝不触碰【图片文件路径】（LOAD_IMAGE_SNAPSHOT_PATH_PREFIX，load_image 快照标记）
 */
import {describe, it, expect} from 'vitest'
import {stripAttachmentImagePaths} from '../../../../src/main/agent/loop/helpers'
import type {ChatMessage} from '../../../../src/main/agent/model/types'

const IMG = {type: 'image_url' as const, image_url: {url: 'data:image/png;base64,AAA'}}

describe('stripAttachmentImagePaths', () => {
    it('移除附件标记行，保留用户文本与 image_url', () => {
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [
                {type: 'text', text: '看图\n【附件图片路径】/a.png'},
                IMG,
            ],
        }]
        const out = stripAttachmentImagePaths(msgs)
        expect(out).not.toBe(msgs)
        const parts = out[0].content as Array<{type: string; text?: string}>
        expect(parts[0]).toEqual({type: 'text', text: '看图'})
        expect(parts[1]).toEqual(IMG)
    })

    it('无标记 → 返回同一数组引用', () => {
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [{type: 'text', text: '看图'}, IMG],
        }]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
    })

    it('load_image 快照标记【图片文件路径】不受影响', () => {
        const snap = {type: 'text' as const, text: '【图片文件路径】/snap.png'}
        const msgs: ChatMessage[] = [{role: 'user', content: [snap, IMG]}]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
    })

    it('字符串 content 原样返回（含数组引用与逐消息引用）', () => {
        const msgs: ChatMessage[] = [{role: 'user', content: '【附件图片路径】/a.png'}]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
        expect(msgs[0].content).toBe('【附件图片路径】/a.png')
    })

    it('同一 part 多行混排：只丢标记行，其余行保留', () => {
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [
                {type: 'text', text: '你好\n【附件图片路径】/a.png\n【附件图片路径】/b.png\n末尾'},
                IMG,
            ],
        }]
        const parts = stripAttachmentImagePaths(msgs)[0].content as Array<{type: string; text?: string}>
        expect(parts[0]).toEqual({type: 'text', text: '你好\n末尾'})
        expect(parts[1]).toEqual(IMG)
    })

    it('剥离后变空的 text part 被丢弃（该消息还有其他 part）', () => {
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [
                {type: 'text', text: '【附件图片路径】/a.png'},
                IMG,
            ],
        }]
        const parts = stripAttachmentImagePaths(msgs)[0].content as Array<{type: string}>
        expect(parts).toEqual([IMG])
    })

    it('兜底：全部 text part 被剥空 → 保留原消息不替换', () => {
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [
                {type: 'text', text: '【附件图片路径】/a.png'},
                {type: 'text', text: '\n【附件图片路径】/b.png'},
            ],
        }]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
    })

    it('不修改输入（原数组与原 part 文本不变）', () => {
        const original = {type: 'text' as const, text: '看图\n【附件图片路径】/a.png'}
        const msgs: ChatMessage[] = [{role: 'user', content: [original, IMG]}]
        stripAttachmentImagePaths(msgs)
        expect(original.text).toBe('看图\n【附件图片路径】/a.png')
        expect((msgs[0].content as unknown[]).length).toBe(2)
    })

    it('行内非行首的标记不被剥离（startsWith 的故意边界，勿改成 includes）', () => {
        // 标记只在行首才是「整行标注」。用 includes 会把同一行里的用户文本一起吞掉
        // （如用户说「前缀【附件图片路径】/a.png」），那是用户内容不是我们的标注。
        const msgs: ChatMessage[] = [{
            role: 'user',
            content: [{type: 'text', text: '前缀【附件图片路径】/a.png'}],
        }]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
    })

    it('混合数组：命中剥离的消息被替换，含快照标记的消息保持原对象引用', () => {
        // 锁住 changed / msgChanged 两级 flag 的记账：整体 changed=true（返回新数组），
        // 但未命中的消息不能被无谓地重建（msgChanged=false → 原引用透传）。
        const hit = {role: 'user' as const, content: [{type: 'text' as const, text: '看图\n【附件图片路径】/a.png'}, IMG]}
        const snapOnly: ChatMessage = {role: 'user', content: [{type: 'text', text: '【图片文件路径】/snap.png'}, IMG]}
        const input = [hit as ChatMessage, snapOnly]
        const out = stripAttachmentImagePaths(input)
        expect(out).not.toBe(input)                      // 整体 changed=true → 新数组
        expect(out[1]).toBe(snapOnly)                    // 未命中 → 同一对象引用
        expect((out[0].content as Array<{text?: string}>)[0]).toEqual({type: 'text', text: '看图'})
    })

    it('role 非 user 的消息不被剥离（避免误删用户数据 / 工具输出中的同名字面量）', () => {
        // 例如 file_read 读到一份含该字面量的文档，其 tool 结果恰好出现在行首——
        // 那是被读取的内容，不是我们的标注，删掉等于篡改工具结果。
        const toolMsg: ChatMessage = {role: 'tool', content: [{type: 'text', text: '【附件图片路径】/a.png'}]}
        const assistantMsg: ChatMessage = {role: 'assistant', content: [{type: 'text', text: '【附件图片路径】/a.png'}]}
        const msgs = [toolMsg, assistantMsg]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
    })

    it('兜底：剥离后只剩一个空 text part → 保留原消息（空 text 块部分 adapter 会拒绝）', () => {
        const sole: ChatMessage = {role: 'user', content: [{type: 'text', text: '【附件图片路径】/a.png'}]}
        const msgs = [sole]
        expect(stripAttachmentImagePaths(msgs)).toBe(msgs)
        expect((msgs[0].content as unknown[]).length).toBe(1)
    })
})
