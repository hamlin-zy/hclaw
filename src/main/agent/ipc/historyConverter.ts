/**
 * 历史消息转换 — agent-start 会话边界重建（纯函数，无 electron 依赖）
 *
 * 背景：loop 内存态是「一次 LLM 调用 = 一个 assistant 消息（各自带 reasoning +
 * text + toolCalls）」，而 DB 落库是「一个用户 turn = 一个 assistant 消息 +
 * 有序 contentBlocks（think/text/tool_use 交错）」。跨 turn 重建时若只取扁平
 * thinkBlock（被覆盖成最后一段）+ 合并全部 toolCalls，重建出的 prompt 前缀会
 * 与上一轮 loop 末不一致，导致 DeepSeek KV cache 从第 1 个 assistant 处断裂。
 *
 * 重建策略（方案 2 根治）：
 * 1. 优先按 contentBlocks 的 turnIndex 分组（loop 内一次 LLM 调用 = 一个 turn，
 *    落库时由 agent_start 事件序号写入）。无论有无 think，都能无损还原
 *    「无 reasoning 的独立调用轮」（此前被 think 边界推断吞并的 DeepSeek 轮次）。
 * 2. 旧数据无 turnIndex → 回退按 think 边界切段（仅能还原带 think 的轮次）。
 *
 * reasoning 内容原样回传，不做 split/filter/join 改写。
 */

import {formatToolResult, interruptedToolResult} from '@shared/utils/toolResult'

export interface HistoryChatMessage {
  role: 'assistant' | 'tool' | 'system'
  content: string
  thinking?: string
  thinkingSignature?: string
  reasoningContent?: string
  toolCalls?: ToolCallOut[]
  toolCallId?: string
  toolResult?: string
  isError?: boolean
  /** 工具名称（与 loop 内存态 createToolResultMessage 一致） */
  functionName?: string
}

/** assistant 消息上的 toolCalls 还原形态 */
interface ToolCallOut {
  id: string
  name: string
  arguments: Record<string, unknown>
  status?: string
}

/** 历史 toolCall 兼容形态（保留旧数据可能存在的 input/args/string result） */
export interface HistoryToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  status?: string
  input?: unknown
  args?: unknown
  /** 新数据：{output, error, toolResult}（toolResult 为 loop 内已格式化字符串）；
   *  旧数据：可能是原始 {output, error} 或纯字符串 */
  result?: {
    output?: unknown
    error?: string
    toolResult?: string
  } | string | null
  isError?: boolean
}

interface AssistantSegment {
  reasoning?: string
  signature?: string
  contentParts: string[]
  toolCalls: HistoryToolCall[]
}

/**
 * 按 turnIndex 分组 contentBlocks（方案 2 主路径）。
 *
 * 返回 Map<turnIndex, blocks[]>；组内保持原始（时间序）顺序。
 * 若没有任何块带 turnIndex（旧数据），返回空 Map（调用方回退 think 边界）。
 */
/**
 * 是否为 end 块（消息收尾哨兵，无轮次归属）。
 * end 块是主进程 writeBlockDelta finalize 追加的收尾标记，唯一用途是承载
 * endedAt；它不参与轮次分组，也不产出任何 assistant/tool 消息。
 * 历史上 end 块的 sequence 可能被 finalize 的 resolveSeq 挤到某轮 text 与
 * tool_call 之间（增量/全量两条路径 sequence 分配不一致），故分组与重建
 * 两条路径都必须显式跳过它，避免其位置干扰轮次内顺序。
 */
function isEndBlock(b: {type?: string}): boolean {
  return b.type === 'end'
}

export function groupByTurnIndex(
  blocks: Array<{type: string; turnIndex?: number}>,
): Map<number, Array<{type: string; turnIndex?: number}>> {
  const groups = new Map<number, Array<{type: string; turnIndex?: number}>>()
  let hasAny = false
  for (const b of blocks) {
    if (b.turnIndex !== undefined) {
      hasAny = true
      const list = groups.get(b.turnIndex) ?? []
      list.push(b)
      groups.set(b.turnIndex, list)
    }
  }
  return hasAny ? groups : new Map()
}

/** toolCall 列表 → 还原到 assistant 消息上的 toolCalls 字段 */
function toToolCalls(list: HistoryToolCall[]): ToolCallOut[] {
  return list.map(tc => ({
    id: tc.id,
    name: tc.name,
    arguments: (tc.arguments || tc.input || tc.args || {}) as Record<string, unknown>,
    status: tc.status,
  }))
}

/**
 * 单个 toolCall → tool 消息（含中断/丢结果的合成错误兜底）。
 *
 * 缓存一致性：优先回传 DB 中已由 loop 格式化好的 toolResult（新数据）；
 * 旧数据回退到 formatToolResult 算法，与 loop 内存态 createToolResultMessage
 * 逐字节一致，确保重建后的 API 请求前缀与上一轮 loop 末逐 token 相同。
 */
function toolResultMessage(tc: HistoryToolCall): HistoryChatMessage {
  const raw = tc.result
  const isError = tc.isError || tc.status === 'error'

  let toolResult: string
  if (raw === undefined || raw === null) {
    // 与 loop 内 normalizeToolCallMessages 合成的文案完全一致
    toolResult = interruptedToolResult(tc.name)
  } else if (typeof raw === 'string') {
    // 极旧数据：纯字符串 result
    toolResult = raw
  } else {
    // 优先用已格式化字符串（新数据），否则用与 loop 相同的格式化算法重建
    const {output, error, toolResult: stored} = raw
    toolResult = stored ?? formatToolResult({
      success: !isError,
      output: output ?? '',
      error,
    })
  }

  return {
    role: 'tool',
    content: '',
    toolCallId: tc.id,
    toolResult,
    isError: raw == null || isError,
    ...(tc.name ? {functionName: tc.name} : {}),
  }
}

/** 按 contentBlocks 的 think 边界切段（旧数据 fallback：仅还原带 think 的轮次） */
function convertFromContentBlocks(msg: any): HistoryChatMessage[] {
  const segments: AssistantSegment[] = []
  let cur: AssistantSegment = {contentParts: [], toolCalls: []}

  const flush = (seg: AssistantSegment) => {
    if (seg.reasoning !== undefined || seg.contentParts.length > 0 || seg.toolCalls.length > 0) {
      segments.push(seg)
    }
  }

  for (const cb of msg.contentBlocks ?? []) {
    if (isEndBlock(cb)) {
      // end 块：消息收尾哨兵，不参与轮次切段
      continue
    }
    if (cb.type === 'think') {
      flush(cur)
      cur = {contentParts: [], toolCalls: []}
      if (cb.thinkBlock?.content) {
        cur.reasoning = cb.thinkBlock.content
        cur.signature = cb.thinkBlock.signature
      }
    } else if (cb.type === 'text') {
      if (cb.text) cur.contentParts.push(cb.text)
    } else if (cb.type === 'tool_use') {
      if (cb.toolCall) cur.toolCalls.push(cb.toolCall as HistoryToolCall)
    }
    // media 块：LLM 无需回看自己生成的媒体，跳过
  }
  flush(cur)

  const result: HistoryChatMessage[] = []
  for (const seg of segments) {
    if (!seg.reasoning && seg.contentParts.length === 0 && seg.toolCalls.length === 0) continue
    const toolCalls = toToolCalls(seg.toolCalls)
    result.push({
      role: 'assistant',
      content: seg.contentParts.join(''),
      ...(seg.signature
        ? {thinking: seg.reasoning, thinkingSignature: seg.signature}
        : {reasoningContent: seg.reasoning}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    })
    for (const tc of seg.toolCalls) {
      result.push(toolResultMessage(tc))
    }
  }
  return result
}

/**
 * 按 turnIndex 分组重建（方案 2 主路径）。
 *
 * 每个 turn 组生成一条 assistant（该组全部 text 拼接为 content、全部 tool_use
 * 作为 toolCalls），随后紧跟该组 tool_use 的 tool 消息。组间按 turnIndex 升序，
 * 与 loop 内存态「一次调用 = 一条 assistant + tool 消息」逐 token 一致。
 *
 * 混合兼容：无 turnIndex 的块（旧数据回填前的过渡态）并入其前一个有 turnIndex
 * 的组——语义上它们属于最近的调用轮。
 */
function convertFromTurnIndex(msg: any): HistoryChatMessage[] {
  const rawGroups = groupByTurnIndex(msg.contentBlocks ?? [])
  if (rawGroups.size === 0) return convertFromContentBlocks(msg)

  // 合并无 turnIndex 块到前一组（组内保持原始顺序）。
  // end 块例外：它是消息收尾哨兵，不得并入任何轮次组——
  // 历史数据中 end 可能被 sequence 挤在 text 与 tool_call 之间，并入会
  // 干扰该轮组内顺序（重建序列与 loop 内存态逐 token 错位 → KV cache 断裂）。
  const groups = new Map<number, any[]>()
  let lastTurn: number | null = null
  for (const cb of msg.contentBlocks ?? []) {
    if (isEndBlock(cb)) continue
    if (cb.turnIndex !== undefined) {
      lastTurn = cb.turnIndex
      if (!groups.has(cb.turnIndex)) groups.set(cb.turnIndex, [])
      groups.get(cb.turnIndex)!.push(cb)
    } else if (lastTurn !== null) {
      groups.get(lastTurn)!.push(cb)
    }
    // 首个块就无 turnIndex（且此前无 turn）：丢弃（理论不可达，旧数据无 turnIndex 时 rawGroups 为空已走 fallback）
  }

  const turnKeys = [...groups.keys()].sort((a, b) => a - b)
  const result: HistoryChatMessage[] = []
  for (const turn of turnKeys) {
    const blocks = groups.get(turn)!
    const seg: AssistantSegment = {contentParts: [], toolCalls: []}
    // 组构建时已跳过 end 块，此处无需再判
    for (const cb of blocks) {
      if (cb.type === 'think') {
        if (cb.thinkBlock?.content) {
          seg.reasoning = cb.thinkBlock.content
          seg.signature = cb.thinkBlock.signature
        }
      } else if (cb.type === 'text') {
        if (cb.text) seg.contentParts.push(cb.text)
      } else if (cb.type === 'tool_use') {
        if (cb.toolCall) seg.toolCalls.push(cb.toolCall as HistoryToolCall)
      }
    }
    // 空 turn 组（理论不可达：组内至少一个块）跳过
    if (seg.reasoning === undefined && seg.contentParts.length === 0 && seg.toolCalls.length === 0) continue

    const toolCalls = toToolCalls(seg.toolCalls)
    result.push({
      role: 'assistant',
      content: seg.contentParts.join(''),
      ...(seg.signature
        ? {thinking: seg.reasoning, thinkingSignature: seg.signature}
        : {reasoningContent: seg.reasoning}),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    })
    for (const tc of seg.toolCalls) {
      result.push(toolResultMessage(tc))
    }
  }
  return result
}

/** 扁平字段 fallback（旧消息 / 无 think 的纯文本轮），语义与旧内联逻辑一致 */
function convertFlat(msg: any): HistoryChatMessage[] {
  let thinking: string | undefined
  let signature: string | undefined
  let reasoning: string | undefined
  let content: string

  if (msg.thinking !== undefined) {
    thinking = msg.thinking
    signature = msg.thinkingSignature
    reasoning = msg.reasoningContent || msg.thinking
    content = msg.content
  } else if (msg.thinkBlock?.content) {
    const thinkParts = msg.thinkBlock.signature
      ? [msg.thinkBlock.content]
      : msg.thinkBlock.content.split('\n').filter(Boolean)
    thinking = thinkParts.join('\n') || undefined
    reasoning = thinkParts.join('\n') || undefined
    content = typeof msg.content === 'string' ? msg.content : ''
  } else {
    thinking = msg.thinkBlock?.content
    signature = msg.thinkBlock?.signature
    reasoning = msg.thinkBlock?.content
    content = msg.content
  }

  const toolList: HistoryToolCall[] = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
  const toolCalls = toToolCalls(toolList)
  const result: HistoryChatMessage[] = toolList.map(toolResultMessage)
  result.unshift({
    role: 'assistant',
    content,
    thinking,
    thinkingSignature: signature,
    reasoningContent: reasoning,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  })
  return result
}

/**
 * 原样还原 skill 工具的 system 注入消息（KV cache 前缀一致性修复）。
 *
 * 背景：运行时 skill 工具 execute（skillTool.ts）返回
 *   injectMessage: { role: 'system', content: buildGuidance(skill) }
 * 该消息在 loop 内存态作为独立 system 消息追加到所有 tool 消息之后（execute.ts
 * deferredMessages），经 convertMessages 收集为 converted.systemText 放入 system
 * 块（无 cache_control）。但落库时 system 消息不持久化（execution.ts 重建路径
 * 显式跳过 system 消息），重建若不恢复，system 块序列从
 * [主提示词, commandTemplate, systemText] 变为 [主提示词, commandTemplate]，
 * 与上一轮 loop 末逐 token 不一致 → DeepSeek KV 缓存从该处整段断裂 →
 * 首跳 input_tokens 全量重发（几万 token）。
 *
 * 恢复策略（逐 token 还原约束）：运行时每轮 LLM 调用（turn）结束后才追加该轮
 * skill 的 system 消息（execute.ts:683-686），因此 system 必须插在**该 turn 的
 * 最后一个 tool 消息之后**、下一个 turn 的 assistant 之前，而不是统一追加到
 * 数组末尾——后者在含多个 turnIndex 的消息（convertFromTurnIndex 拆出多段）中
 * 会错位，同样破坏缓存前缀。
 *
 * @param msg DB 加载的历史 assistant 消息（toolCalls 已由 messageBlockHelper 挂载 result）
 * @param converted 该消息的 turnIndex 分组重建结果（assistant + tool 消息），原地内嵌 system
 */
export function restoreSkillSystemMessages(
  msg: {toolCalls?: HistoryToolCall[]},
  converted: HistoryChatMessage[],
): void {
  // skill toolCall.id → guidance（仅成功时有值，见 extractGuidance）
  const skillGuidance = new Map<string, string>()
  for (const tc of msg.toolCalls ?? []) {
    if (tc.name === 'skill') {
      const guidance = extractGuidance(tc)
      if (guidance) skillGuidance.set(tc.id, guidance)
    }
  }
  if (skillGuidance.size === 0) return

  // 逐 turn 扫描：每个 assistant 与其后的连续 tool 消息构成一个 turn。
  // 该 turn 的 skill system 统一插在最后一个 tool 之后（与运行时一致）。
  let i = 0
  while (i < converted.length) {
    if (converted[i].role !== 'assistant') {
      i++
      continue
    }
    // 找当前 turn 的最后一个 tool 消息
    let lastToolIdx = i
    let j = i + 1
    while (j < converted.length && converted[j].role === 'tool') {
      lastToolIdx = j
      j++
    }
    // 按 assistant.toolCalls 顺序收集该 turn 的 skill system
    const systems = (converted[i].toolCalls ?? [])
      .filter(tc => skillGuidance.has(tc.id))
      .map(tc => ({role: 'system' as const, content: skillGuidance.get(tc.id)!}))
    if (systems.length > 0) {
      converted.splice(lastToolIdx + 1, 0, ...systems)
    }
    // 跳过已处理的 turn（含插入的 system，故 +systems.length）
    i = j + systems.length
  }
}

/**
 * 从 skill 工具调用结果提取 guidance（buildGuidance 原文）。
 *
 * 逐 token 还原约束（KV 缓存一致性）：运行时仅成功 skill 有 injectMessage，
 * 且 injectMessage.content === output（buildGuidance 字符串）；失败分支
 * （未找到/禁用）无 injectMessage。因此「output 是字符串」即注入判据——
 * 失败时 output 是对象（skillTool 118 行 {success:false,...}），绝不会误注入。
 *
 * 兼容：
 * - 极旧纯字符串 result 视为 guidance 原样返回（与 toolResultMessage 语义一致）
 * - tc.isError / status==='error' 顶层标记（新数据）与 error 字段（其他工具失败形态）
 *   均显式拦截，双保险
 */
function extractGuidance(tc: HistoryToolCall): string {
  const raw = tc.result
  if (raw === undefined || raw === null) return ''
  if (typeof raw === 'string') return raw
  if (tc.isError || tc.status === 'error' || raw.error) return ''
  // 成功时 output 恒为 buildGuidance 字符串；非字符串（对象/缺失）一律不注入，
  // 避免把失败输出或 toolResult 尾巴当作 guidance 注入破坏缓存前缀。
  return typeof raw.output === 'string' ? raw.output : ''
}

/**
 * 一条历史 assistant 消息 → 一个或多个 ChatMessage（turnIndex 分组 / think 边界 / 扁平 fallback）
 *
 * 优先级：
 * 1. contentBlocks 带 turnIndex → 按 turnIndex 分组（方案 2，无损还原无 think 轮）
 * 2. contentBlocks 存在结构化块但无 turnIndex（旧数据）→ 按 think 边界切段
 * 3. contentBlocks 缺失或完全为空 → 扁平字段 fallback（旧消息）
 */
export function convertAssistantHistoryMessage(msg: any): HistoryChatMessage[] {
  if (msg.contentBlocks?.some((cb: any) => cb.type !== 'media')) {
    if (msg.contentBlocks.some((cb: any) => cb.turnIndex !== undefined)) {
      return convertFromTurnIndex(msg)
    }
    return convertFromContentBlocks(msg)
  }
  return convertFlat(msg)
}
