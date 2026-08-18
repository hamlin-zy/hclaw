/**
 * 工具结果格式化 — tool_result 内容的唯一格式权威
 *
 * 一致性契约：loop 内存态（createToolResultMessage）、落库存储
 * （normalizeToolResult / recordToolResultBlock）与历史重建
 * （historyConverter）共用本函数，保证三端 tool_result 字符串
 * 逐字节一致，使跨 turn 重建后的 API 请求前缀与上一轮 loop 末
 * 逐 token 相同，最大化前缀缓存命中。
 */

/** 中断/丢结果时合成的错误文案 — 与 normalizeToolCallMessages 注入的格式一致 */
export function interruptedToolResult(toolName: string): string {
  return `[INTERRUPTED] 工具调用被中断，未获取到执行结果（tool: ${toolName}）`
}

/**
 * 格式化工具结果内容（成功/失败统一格式）。
 *
 * - 失败（success=false）：[ERROR] <error>，若同时有输出则换行追加输出
 * - 成功：字符串输出原样返回；对象/数组输出 JSON.stringify(…, null, 2)
 * - output 为 null/undefined 视为无输出（不产生 "null" 字面量）
 */
export function formatToolResult(
  result: { success: boolean; output: unknown; error?: string },
): string {
  const isError = !result.success
  if (isError) {
    // 失败时：确保 LLM 能同时看到错误原因和输出内容
    const errorPart = result.error ? `[ERROR] ${result.error}` : ''
    // 失败时非空字符串/对象输出才追加（空字符串、null、undefined 视为无输出）
    const outputPart = result.output === '' || result.output == null
      ? ''
      : typeof result.output === 'string'
        ? result.output
        : JSON.stringify(result.output, null, 2)

    // 组合错误和输出：先显示错误，再显示输出
    return errorPart + (errorPart && outputPart ? '\n' : '') + outputPart
  }

  // 成功情况：只显示输出
  if (typeof result.output === 'string') {
    return result.output
  }
  if (result.output !== null && result.output !== undefined) {
    return JSON.stringify(result.output, null, 2)
  }
  return ''
}
