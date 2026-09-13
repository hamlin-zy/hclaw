/**
 * 发送前交接模板（spec 3.2，携带用户新输入）。
 * 与 mid-loop 模板（src/main/agent/loop/execute.ts MID_LOOP_HANDOFF_PROMPT）语义区分：
 * 前者含用户本次输入，后者含任务进度。
 */
export function buildHandoffMessage(userInput: string): string {
  return `总结当前对话历史，准备交接(session_handoff)到新会话执行：${userInput}

【要求】总结必须含「复用清单」段，只列新会话仍会用到的已委派子任务（无则写"无"；这些已完成，勿重复派发）：
- 只写指针，禁止把子任务正文抄进总结；
- 每条的落点只能是：① 磁盘上已存在的文件完整路径，或 ② 该次 agent 调用的 toolCallId（形如 call_00_xxxx，从你自己的工具调用里原样抄写）；
- 严禁为交接新建任何文件（包括汇总/笔记类 md）。

【重要】若希望新会话自动启动特定技能/代理（如 brainstorming、code-explorer 等），请在调用 session_handoff 时传入 capability 参数（值为技能/代理名，不带 / 前缀）。`
}
