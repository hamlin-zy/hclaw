/**
 * 修复方案设计 — skill 工具 system 注入消息重建恢复
 *
 * 问题：运行时 skill 工具返回 {output: guidance, injectMessage: {role:'system', content: guidance}}
 *  - output → tool_result（DB 已完整保留，9465 字符）
 *  - injectMessage → 内存 state 的 system 消息 → convertMessages 收集为 systemText → system 块2
 *  - injectMessage 未持久化（execution.ts:240 显式跳过 system 消息）
 *  → 重建后 system 块从 [主提示词, commandTemplate, systemText] 变 [主提示词, commandTemplate]
 *  → 前缀断裂 → input_tokens 全量重发
 *
 * 方案：重建时检测 skill 工具调用，从 tool_result 恢复 guidance 作为 system 注入消息。
 * 由于 guidance === tool_result.output === systemText 内容（逐字节一致），
 * 恢复后 system 块与运行时逐 token 对齐。
 */
const DBG = true

// ── 修改点 1：execution.ts 重建路径（~line 232-240）──
const executionPatch = `
// 现状：
} else if (msg.role === 'assistant') {
    for (const converted of convertAssistantHistoryMessage(msg)) {
        convertedMessages.push(converted)
    }
}
// system 消息跳过（由 systemPrompt 处理）

// 修复后：
} else if (msg.role === 'assistant') {
    for (const converted of convertAssistantHistoryMessage(msg)) {
        convertedMessages.push(converted)
    }
    // ★ 原样还原：检测 skill 工具调用，恢复其 system 注入消息（guidance）
    // 运行时 skill 工具 execute 返回 injectMessage:{role:'system', content: buildGuidance(skill)}
    // 该消息经 convertMessages 收集为 systemText 放入 system 块（无 cache_control）
    // 重建时必须恢复，否则 system 块序列与运行时不一致 → KV 缓存断裂
    const skillToolCalls = (msg.toolCalls || []).filter(tc => tc.name === SKILL_TOOL_NAME)
    for (const tc of skillToolCalls) {
        const guidance = extractSkillGuidance(tc)  // 从 tc.result.output 提取
        if (guidance) {
            convertedMessages.push({ role: 'system', content: guidance })
        }
    }
}
`

// ── 修改点 2：guidance 提取（从 tool_result 恢复，与 buildGuidance 逐字节一致）──
// tool_result 块 data = {id, result: {output: guidance, ...}}
// historyConverter 的 HistoryToolCall.result.output 即为 guidance

console.log(executionPatch)
console.log('\n=== 验证要点 ===')
console.log('1. tool_result.output === buildGuidance(skill) === injectMessage.content（逐字节）')
console.log('2. 恢复位置：assistant(tool_use) 消息之后、tool_result 之前（与运行时顺序一致）')
console.log('3. system 消息经 convertMessagesIncremental 收集到 converted.systemText → system 块2')
console.log('4. 不影响 commandTemplate（块1，由 detectCommandContext 从 user 消息重新生成）')
