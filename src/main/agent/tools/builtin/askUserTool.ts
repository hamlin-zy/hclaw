/**
 * AskUser 工具 — 向用户提问并等待回答
 *
 * 当 Agent 需要澄清用户意图或获取额外信息时使用。
 *
 * 执行流程：
 * 1. Agent 调用 ask_user，发送问题（和可选的选项列表）
 * 2. 工具阻塞等待，直到用户选择选项或输入内容
 * 3. 将用户回答作为上下文告知 LLM
 */
import {z} from 'zod'
import type {Tool, ToolContext, ToolResult} from '../types'

const inputSchema = z.object({
  question: z.string().describe('向用户提出的问题'),
    /** 可选的选项列表。如果提供，用户可以选择一个选项而不是输入文字 */
    options: z.array(z.string()).optional().describe('可选的选项列表'),
    /** 是否允许多选，默认单选 */
    multiSelect: z.boolean().optional().default(false).describe('是否允许多选'),
})

type AskUserInput = z.infer<typeof inputSchema>

export const askUserTool: Tool<AskUserInput, string> = {
  name: 'ask_user',
    description: '向用户提问并等待回答。用于澄清意图或获取额外信息。工具会阻塞直到用户选择选项或输入内容。',
  inputSchema,
  requiredPermissions: [],
  isDestructive: false,

  async execute(args: AskUserInput, context: ToolContext): Promise<ToolResult<string>> {
      // 检查是否有 askUserQuestion 方法（由 worker.ts 注入）
      if (!context.askUserQuestion) {
          return {
              success: false,
              output: '',
              error: 'askUserQuestion not available',
          }
      }

      // ── 选项校验：检查 options 是否包含空白字符串 ──
      if (args.options && args.options.length > 0) {
          const emptyOptions = args.options.filter(opt => !opt || opt.trim().length === 0)
          if (emptyOptions.length === args.options.length) {
              return {
                  success: false,
                  output: '',
                  error: '所有选项都是空字符串，用户无法看到选项内容。请检查你传入的 options 参数，确保每个选项都是包含有意义文字的非空字符串。',
              }
          }
          if (emptyOptions.length > 0) {
              console.warn('[askUserTool] 部分选项为空字符串，可能会影响用户体验:', JSON.stringify(args.options))
          }
      }

      try {
          // 调用 askUserQuestion，会阻塞直到用户回答
          const answer = await context.askUserQuestion(args.question, args.options, args.multiSelect)

          // 构建包含原始问题和用户回答的完整上下文
          const optionsText = args.options && args.options.length > 0
              ? `\n选项: ${args.options.join('、')}`
              : ''

      return {
          success: true,
          output: `问题: ${args.question}${optionsText}\n用户回答: ${answer}`,
      }
      } catch (err) {
          return {
              success: false,
              output: '',
              error: err instanceof Error ? err.message : 'Unknown error',
          }
      }
  },
}
