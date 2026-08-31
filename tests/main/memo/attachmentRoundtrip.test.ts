/**
 * 附件 roundtrip（Phase 3 新链路）：buildUserMessage（唯一构建者）→ messageToBlocks
 * （唯一序列化层）函数级断言，不触碰渲染端 store / 真实 DB。
 *
 * 覆盖：
 * - 附件单形态（R6）：只写顶层 msg.attachments，metadata 不承载附件业务
 * - messageToBlocks 序列化：attachments 经 metadata.attachments 承载进 DB 块
 *   （messageBlockHelper 序列化契约），metadata.commandId 一并存活
 * - attachments 空时不写该字段；metadata.commandId 空时不写 metadata
 */
import {describe, it, expect} from 'vitest'

import {buildUserMessage} from '../../../src/main/agent/messageBuilder'
import {messageToBlocks} from '../../../src/main/repositories/sqlite/messageBlockHelper'

describe('attachmentRoundtrip：buildUserMessage → messageToBlocks（函数级）', () => {
    it('附件经 buildUserMessage 单形态构建，messageToBlocks 序列化存活', async () => {
        const commandId = 'agent:local-ECC@github:agents/code-explorer'
        const msg = await buildUserMessage({
            convId: 'conv-rt',
            text: '/code-explorer\n图中有什么？',
            attachments: [{path: 'C:\\fake\\memo\\image.png', name: 'image.png'}],
            metadata: {commandId},
        })

        // 单一形态：顶层 attachments（toMessageAttachments 形状），metadata 不承载
        expect(msg.attachments).toHaveLength(1)
        expect(msg.attachments![0]).toMatchObject({name: 'image.png', type: expect.any(String), path: 'C:\\fake\\memo\\image.png'})
        expect(msg.content).toBe('/code-explorer\n图中有什么？')
        expect(msg.metadata?.commandId).toBe(commandId)

        // 序列化层：messageToBlocks 将顶层 attachments 承载进 metadata.attachments（DB 形态）
        const split = messageToBlocks(msg, 'conv-rt')
        const serializedMeta = split.messages[0].metadata as Record<string, unknown>
        expect(serializedMeta.commandId).toBe(commandId)
        const dbAttachments = serializedMeta.attachments as Array<Record<string, unknown>>
        expect(dbAttachments).toHaveLength(1)
        expect(dbAttachments[0]).toMatchObject({name: 'image.png'})
    })

    it('无附件 / 无 commandId：不写空字段', async () => {
        const msg = await buildUserMessage({convId: 'conv-rt', text: 'plain'})
        expect(msg.attachments).toBeUndefined()
        expect(msg.metadata).toBeUndefined()

        const split = messageToBlocks(msg, 'conv-rt')
        expect((split.messages[0].metadata as Record<string, unknown> | undefined)?.attachments).toBeUndefined()
    })
})
