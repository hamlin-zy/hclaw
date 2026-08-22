/**
 * 发送前交接模板（spec 3.2，携带用户新输入）。
 * 与 mid-loop 模板（src/main/agent/loop/execute.ts MID_LOOP_HANDOFF_PROMPT）语义区分：
 * 前者含用户本次输入，后者含任务进度。
 */
export function buildHandoffMessage(userInput: string): string {
  return `总结当前对话历史，准备交接(session_handoff)到新会话执行：${userInput}

【重要】若希望新会话自动启动特定技能/代理（如 brainstorming、code-explorer 等），请在调用 session_handoff 时传入 capability 参数（值为技能/代理名，不带 / 前缀）。`
}
