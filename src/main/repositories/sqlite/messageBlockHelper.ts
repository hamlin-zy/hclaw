import type {Message, MessageBlock, ThinkBlock, ToolCall} from '@shared/types'

// ── 共享工具：文本与工具调用按 textOffset 交错 ──────────────────────────

type InterleavedSegment<T> =
  | { type: 'text'; offset: number; text: string }
  | { type: 'tool'; item: T }

/**
 * 将已按 textOffset 升序排列的工具项与文本按偏移位置交错。
 * 返回文本段与工具项交替的序列，调用方各自转换为对应的 Block 类型。
 */
function interleaveTextAndTools<T>(
  sortedItems: T[],
  fullText: string,
  getOffset: (item: T) => number | undefined,
): InterleavedSegment<T>[] {
  const result: InterleavedSegment<T>[] = []
  let cursor = 0
  for (const item of sortedItems) {
    const offset = getOffset(item) ?? cursor
    if (offset > cursor) {
      const slice = fullText.slice(cursor, offset)
      if (slice) result.push({ type: 'text', offset: cursor, text: slice })
    }
    result.push({ type: 'tool', item })
    cursor = offset
  }
  if (cursor < fullText.length) {
    result.push({ type: 'text', offset: cursor, text: fullText.slice(cursor) })
  }
  return result
}

/**
 * 将 Message 拆分为 Message + MessageBlock[] 结构
 * - user/system 消息: messages 表1条，blocks 为空
 * - assistant 消息: messages 表1条(container)，blocks 存储各部分
 */
export function messageToBlocks(msg: Message, convId: string): { messages: Message[]; blocks: MessageBlock[] } {
  const blocks: MessageBlock[] = []
  let sequence = 0

  if (msg.role === 'assistant') {
    const baseTimestamp = msg.timestamp

    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      // ── 新路径：按 contentBlocks 顺序生成 blocks ─────────────────────────
      for (const cb of msg.contentBlocks) {
        switch (cb.type) {
          case 'think':
            if (cb.thinkBlock) {
              blocks.push({
                id: `${msg.id}-think-${cb.id}`,
                messageId: msg.id,
                blockType: 'think',
                content: cb.thinkBlock.content,
                data: JSON.stringify(cb.thinkBlock),
                sequence: sequence++,
                timestamp: cb.thinkBlock.timestamp || baseTimestamp,
              })
            }
            break
          case 'text':
            if (cb.text) {
              blocks.push({
                id: `${msg.id}-text-${cb.id}`,
                messageId: msg.id,
                blockType: 'text',
                content: cb.text,
                data: null,
                sequence: sequence++,
                timestamp: baseTimestamp,
              })
            }
            break
          case 'tool_use':
            if (cb.toolCall) {
              blocks.push(toolCallToBlock(cb.toolCall, msg.id, sequence++, baseTimestamp))
              if (cb.toolCall.result !== undefined) {
                blocks.push({
                  id: `${msg.id}-tr-${cb.toolCall.id}`,
                  messageId: msg.id,
                  blockType: 'tool_result',
                  content: null,
                  data: JSON.stringify({ id: cb.toolCall.id, result: cb.toolCall.result }),
                  sequence: sequence++,
                  timestamp: baseTimestamp,
                })
              }
            }
            break
            case 'media':
                if (cb.media) {
                    blocks.push({
                        id: `${msg.id}-media-${cb.id}`,
                        messageId: msg.id,
                        blockType: 'media',
                        content: cb.media.caption || null,
                        data: JSON.stringify(cb.media),
                        sequence: sequence++,
                        timestamp: baseTimestamp,
                    })
                }
                break
        }
      }
    } else {
      // ── 旧路径：扁平字段后向兼容（textOffset 交错存储） ──────────────────
      // 1. think block
      if (msg.thinkBlock) {
        blocks.push({
          id: `${msg.id}-think`,
          messageId: msg.id,
          blockType: 'think',
          content: msg.thinkBlock.content,
          data: JSON.stringify(msg.thinkBlock),
          sequence: sequence++,
          timestamp: msg.thinkBlock.timestamp || baseTimestamp,
        })
      }

      // 2. 按 textOffset 排序 toolCalls，文本与工具调用交错存储
      const sortedCalls = [...(msg.toolCalls || [])].sort(
        (a, b) => (a.textOffset ?? 0) - (b.textOffset ?? 0)
      )
      for (const seg of interleaveTextAndTools(sortedCalls, msg.content || '', tc => tc.textOffset)) {
        if (seg.type === 'text') {
          blocks.push({
            id: `${msg.id}-text-${seg.offset}`,
            messageId: msg.id,
            blockType: 'text',
            content: seg.text,
            data: null,
            sequence: sequence++,
            timestamp: baseTimestamp,
          })
        } else {
          const tc = seg.item
          blocks.push(toolCallToBlock(tc, msg.id, sequence++, baseTimestamp))
          if (tc.result !== undefined) {
            blocks.push({
              id: `${msg.id}-tr-${tc.id}`,
              messageId: msg.id,
              blockType: 'tool_result',
              content: null,
              data: JSON.stringify({ id: tc.id, result: tc.result }),
              sequence: sequence++,
              timestamp: baseTimestamp,
            })
          }
        }
      }
    }

    // 4. end block (始终放在最后)
    if (msg.endedAt) {
      blocks.push({
        id: `${msg.id}-end`,
        messageId: msg.id,
        blockType: 'end',
        content: null,
        data: JSON.stringify({ endedAt: msg.endedAt }),
        sequence: sequence++,
        timestamp: msg.endedAt,
        endedAt: msg.endedAt,
      })
    }
  }

  // 构建 messages 表记录（assistant 只存元信息，user/system 存全部）
  const messageRecord: Message = {
    id: msg.id,
    role: msg.role,
    content: msg.role === 'assistant' ? '' : msg.content,
    timestamp: msg.timestamp,
    endedAt: msg.endedAt,
    metadata: {
      content: msg.content,
      agentName: msg.agentName,
      agentType: msg.agentType,
      model: msg.model,
      skillExecution: msg.skillExecution,
      attachments: msg.attachments,
      plannedCommands: msg.plannedCommands,
      thinkBlock: msg.thinkBlock,
      toolCalls: msg.toolCalls,
      contentBlocks: msg.contentBlocks,
    },
  }

  return { messages: [messageRecord], blocks }
}

function toolCallToBlock(tc: ToolCall, messageId: string, seq: number, baseTimestamp: number): MessageBlock {
  return {
    id: `${messageId}-tc-${tc.id}`,
    messageId,
    blockType: 'tool_call',
    content: null,
    data: JSON.stringify({
      id: tc.id,
      name: tc.name,
      arguments: tc.arguments,
      status: tc.status,
      textOffset: tc.textOffset,
      progress: tc.progress,
      reason: tc.reason,
      terminal: tc.terminal,
      detailStatus: tc.detailStatus,
      progressPercent: tc.progressPercent,
      eta: tc.eta,
      tokenUsage: tc.tokenUsage,
    }),
    sequence: seq,
    timestamp: tc.textOffset !== undefined ? baseTimestamp + tc.textOffset : baseTimestamp,
  }
}

/**
 * 将 MessageBlock[] 聚合回完整的 Message 对象
 */
export function blocksToMessage(messageRecord: Message, blocks: MessageBlock[]): Message {
  if (messageRecord.role !== 'assistant') {
    return messageRecord
  }

  // 按 sequence 排序（保持时间序）
  const sortedBlocks = [...blocks].sort((a, b) => a.sequence - b.sequence)

  let content = ''
  let thinkBlock: ThinkBlock | undefined
  const toolCalls: ToolCall[] = []
  let endedAt: number | undefined
  const contentBlocks: import('../../../shared/types').ContentBlock[] = []

  for (const block of sortedBlocks) {
    switch (block.blockType) {
      case 'think':
        if (block.data) {
          const tb: ThinkBlock = JSON.parse(block.data)
          thinkBlock = tb // 扁平字段后向兼容
          contentBlocks.push({
            id: block.id,
            type: 'think',
            thinkBlock: tb,
          })
        }
        break
      case 'text':
          if (block.content !== null && block.content !== undefined) {
          // 扁平字段后向兼容：拼接所有 text block 为完整文本
          content = content ? content + block.content : block.content
          // 只有非空文本才加入 contentBlocks，
          // 避免空 text block 导致 UI 渲染出只有头像时间戳的空白气泡
          if (block.content) {
            contentBlocks.push({
              id: block.id,
              type: 'text',
              text: block.content,
            })
          }
        }
        break
      case 'tool_call':
        if (block.data) {
          const tc: ToolCall = JSON.parse(block.data)
          toolCalls.push(tc)
          contentBlocks.push({
            id: block.id,
            type: 'tool_use',
            toolCall: tc,
          })
        }
        break
      case 'tool_result':
        if (block.data && toolCalls.length > 0) {
          const { id, result } = JSON.parse(block.data)
          // 更新 contentBlocks 中对应的 tool_use block
          const cbMatch = contentBlocks.find(cb => cb.type === 'tool_use' && cb.toolCall?.id === id)
          if (cbMatch?.toolCall) {
            cbMatch.toolCall.result = result
          }
          // 扁平字段后向兼容
          const lastTc = toolCalls[toolCalls.length - 1]
          if (lastTc.id === id) {
            lastTc.result = result
          }
        }
          break
        case 'media':
            if (block.data) {
                const mediaBlock: import('../../../shared/types').MediaBlock = JSON.parse(block.data)
                contentBlocks.push({
                    id: block.id,
                    type: 'media',
                    media: mediaBlock,
                })
            }
        break
      case 'end':
        if (block.data) {
          const { endedAt: ea } = JSON.parse(block.data)
          endedAt = ea
        }
        break
    }
  }

  // ── 防御性修复：textOffset 交错重排序 ──────────────────────────────
  // 旧版代码（无 contentBlocks 的存储路径）将所有文本存为一个 block、
  // 所有工具调用放在末尾，导致 contentBlocks 失去时序交错。
  // 若检测到 tool_use 块集中在文本之后且携带有效 textOffset，则按 textOffset 重建交错。
  const firstToolIdx = contentBlocks.findIndex(cb => cb.type === 'tool_use')
  const lastTextIdx = (() => {
    for (let i = contentBlocks.length - 1; i >= 0; i--)
      if (contentBlocks[i].type === 'text') return i
    return -1
  })()

  if (firstToolIdx >= 0 && lastTextIdx >= 0 && firstToolIdx > lastTextIdx) {
    const hasTextOffset = contentBlocks.some(
      cb => cb.type === 'tool_use' && (cb.toolCall?.textOffset ?? 0) > 0
    )
    if (hasTextOffset) {
      // 收集非 text/tool_use 块（think, media 等）
      const prefix: typeof contentBlocks = []
      const tools: typeof contentBlocks = []
      for (const cb of contentBlocks) {
        if (cb.type === 'think' || cb.type === 'media') prefix.push(cb)
        else if (cb.type === 'tool_use') tools.push(cb)
      }

      const sortedTools = [...tools].sort(
        (a, b) => (a.toolCall?.textOffset ?? 0) - (b.toolCall?.textOffset ?? 0)
      )
      const fullText = content || messageRecord.content || ''
      const rebuilt: typeof contentBlocks = [...prefix]
      for (const seg of interleaveTextAndTools(sortedTools, fullText, t => t.toolCall?.textOffset)) {
        if (seg.type === 'text') {
          rebuilt.push({ id: `rt-${seg.offset}`, type: 'text', text: seg.text })
        } else {
          rebuilt.push(seg.item)
        }
      }

      contentBlocks.length = 0
      contentBlocks.push(...rebuilt)
      // 同步更新扁平字段 content 为完整文本
      if (!content || content.length < fullText.length) {
        content = fullText
      }
    }
  }

  const result: Message = {
    ...messageRecord,
    content: content || messageRecord.content || '',
    thinkBlock,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    endedAt,
  }

  // 只有当 contentBlocks 有意义时（不止一个简单的 [text]）才设置
  // 旧消息的扁平字段仍保持后向兼容
  const hasMultipleTypes = contentBlocks.some(cb => cb.type !== 'text')
  if (contentBlocks.length > 1 || hasMultipleTypes) {
    result.contentBlocks = contentBlocks
  }

  return result
}
