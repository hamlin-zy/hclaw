/**
 * 工具执行器
 *
 * 流程：权限检查 → 超时包装 → 执行工具 → 结果大小检查 → 收集结果
 * 此处只负责核心执行逻辑。
 */

import {z} from 'zod'
import type {ToolContext, ToolResult} from './types'
import {toolRegistry} from './registry'
import {permissionEngine} from './permission'
import {localSandbox} from '../../sandbox/localSandbox'
import type {SandboxOperation} from '../../sandbox/types'
import {coerceToolParams} from './coercer'
import {errorResult} from '../common/toolResult'
import {resolveToolName} from './toolNameResolver'
import {createTimeoutResult, ToolTimeoutError, withToolTimeout} from './toolTimeout'
import {getToolDefaultTimeout, toolRepo} from '../../repositories/sqlite/toolRepository'

export interface ExecuteToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ExecuteToolResult {
  toolCallId: string
  toolName: string
  result: ToolResult
  /** 是否被权限系统拒绝 */
  denied?: boolean
  denyReason?: string
}

/**
 * 拥有独立内部超时/中止机制的工具，executor 层不套外层超时兜底：
 * - agent：由内部 maxTurns + llmTimeout 控制执行深度
 * - ask_user：必须永久等待用户响应
 * - bash：内部有 setTimeout + killProcessTree + AbortSignal，且已收集部分输出
 * - web_fetch：内部有 http.get({timeout}) + req.on('timeout') + AbortSignal
 * 外层超时与之竞争，会产生泛化的 ToolTimeoutError 覆盖内部的具体错误信息（如部分输出）
 */
export const SKIP_OUTER_TIMEOUT_TOOLS = new Set(['agent', 'ask_user', 'bash', 'web_fetch'])

/**
 * 内部管理超时的工具及其默认超时（与 builtin 工具内部常量保持一致），
 * 供 UI 倒计时展示；LLM 可通过 timeout 参数覆盖（<1000 视为秒自动换算）。
 */
const INTERNAL_TIMEOUTS: Record<string, number> = {
    bash: 30000,
    web_fetch: 15000,
}

/**
 * 解析工具的有效超时时间（毫秒）
 * - agent / ask_user：无外层超时且无明确展示意义的内部超时 → undefined（不显示倒计时）
 * - bash / web_fetch：解析其内部超时（含 LLM 参数覆盖），供 UI 倒计时显示
 * - 其余工具：优先 DB 配置，否则工具默认值
 * 供执行器与 UI 倒计时（tool_start 事件注入 timeoutMs）共用，保证两处一致。
 */
export function resolveToolTimeoutMs(toolName: string, args?: Record<string, unknown>): number | undefined {
    if (toolName === 'agent' || toolName === 'ask_user') return undefined

    const internalTimeout = INTERNAL_TIMEOUTS[toolName]
    if (internalTimeout !== undefined) {
        // LLM 可能误将秒当毫秒传入（如 timeout: 30 表示 30 秒），与 builtin 工具逻辑一致；
        // 参数可能为字符串（未过 Zod coerce），先转数字避免字符串比较/拼接
        const raw = typeof args?.timeout === 'string' ? Number(args.timeout) : (args?.timeout as number | undefined)
        if (raw === undefined || Number.isNaN(raw)) return internalTimeout
        return raw < 1000 ? raw * 1000 : raw
    }

    const dbTimeout = toolRepo.getTimeout(toolName)
    return dbTimeout ?? getToolDefaultTimeout(toolName)
}

export async function executeTool(
  toolCall: ExecuteToolCall,
  context: ToolContext,
): Promise<ExecuteToolResult> {
  // 工具未注册：先尝试名称纠偏（别名/大小写），命中则路由到实际工具（仅纠偏名称，不做参数转换）
  let tool = toolRegistry.get(toolCall.name)
  if (!tool) {
    const resolved = resolveToolName(toolCall.name, toolRegistry.getNames())
    if (resolved) {
      toolCall.name = resolved
      tool = toolRegistry.get(resolved)
    }
  }

  // 工具未注册（纠偏后仍未命中）：返回原错误 + 可用工具名列表
  if (!tool) {
    const available = toolRegistry.getNames()
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: errorResult(
        `Unknown tool: ${toolCall.name}。可用工具: ${available.join(', ')}。` +
        `请从可用工具列表中选择并重试。`
      ),
    }
  }

  // Agent 白名单运行时校验：LLM 幻觉调用了未注入工具定义的已注册工具时直接拒绝，
  // 与 filterToolsForAgent 的过滤结果保持一致（allowedToolNames 缺省 = 不限制，主 Agent 路径）。
  if (context.allowedToolNames && !context.allowedToolNames.has(toolCall.name)) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      denied: true,
      denyReason: `工具 ${toolCall.name} 不在当前 Agent 的可用工具列表中`,
      result: errorResult(
        `工具 "${toolCall.name}" 不在当前 Agent 的可用工具列表中，调用已被拒绝。` +
        `请仅使用本轮 tools 列表中提供的工具。`
      ),
    }
  }

  // Agent 黑名单运行时校验：即使白名单被 args.tools=['*'] 覆盖，
  // disallowedTools 中列出的工具仍应被拦截（纵深防御）。
  if (context.disallowedToolNames && context.disallowedToolNames.has(toolCall.name)) {
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      denied: true,
      denyReason: `工具 ${toolCall.name} 被当前 Agent 的黑名单禁止`,
      result: errorResult(
        `工具 "${toolCall.name}" 被当前 Agent 的 disallowedTools 列表禁止，调用已被拒绝。`
      ),
    }
  }

      // 权限引擎为懒初始化（check 是同步方法），执行前确保 mode/rules 已加载
      await permissionEngine.ensureReady()
      const permResult = permissionEngine.check(tool, toolCall.arguments, context.permissionMode)
    
    let userApproved = false
    if (!permResult.allowed && !tool.autoApprove) {
      if (context.requestConfirmation) {
          
          // 根据细粒度权限结果生成更具体的确认消息
          const reasonText = toolCall.arguments.reason ? `\n原因: ${toolCall.arguments.reason}` : ''
          const detail = (permResult as any).detail
          let confirmMessage: string

          if (detail?.type === 'bash_command') {
              confirmMessage = `⚠️ 命令确认\n\n命令: ${detail.command}${reasonText}\n\n此命令不在安全白名单中，是否允许执行?`
          } else if (detail?.type === 'file_outside_working_dir') {
              confirmMessage = `⚠️ 文件路径确认\n\n目标文件: ${detail.filePath}\n工作目录: ${detail.workingDir}\n\n此文件不在工作目录下，是否允许编辑?${reasonText}`
          } else {
              confirmMessage = `⚠️ 权限确认\n\n工具: ${tool.name}${reasonText}\n\n该操作在当前模式下需要手动确认。是否允许执行?`
          }

          const confirmed = await context.requestConfirmation(confirmMessage)
          if (confirmed === 'deny') {
              return {
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  denied: true,
                  denyReason: permResult.reason || 'User denied confirmation',
                  result: errorResult(permResult.reason || 'Permission denied by user'),
              }
          }
          if (confirmed === 'always') {
              // 对于 bash 命令，添加命令前缀规则以允许同类命令
              if (detail?.type === 'bash_command' && detail.command) {
                  const cmdParts = detail.command.split(/\s+/)
                  // 用前两个词作为规则（如 "python train.py" 而非仅 "python"），
                  // 避免 "始终允许 python train.py" 变成允许所有 python 命令
                  const cmdBase = cmdParts.slice(0, Math.min(2, cmdParts.length)).join(' ')
                  await permissionEngine.addRule({tool: `bash:${cmdBase}*`, action: 'allow'})
              } else {
                  await permissionEngine.addRule({tool: tool.name, action: 'allow'})
              }
              // 立即通知前端刷新规则列表，无需等待 agent loop 的下一次迭代
              context.onEvent?.({type: 'permission-rules-updated'})
          }
          userApproved = true
                } else {
          return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              denied: true,
              denyReason: permResult.reason,
              result: errorResult(permResult.reason || 'Permission denied (no confirmation context)'),
          }
      }
  }

    // 系统级沙盒检查
    let sandboxOp: SandboxOperation | null = null
    const args = toolCall.arguments

    if (tool.name === 'bash' && typeof args.command === 'string') {
        sandboxOp = {type: 'command_execute', command: args.command, args: []}
    } else if (tool.name === 'file_read' && typeof args.filePath === 'string') {
        sandboxOp = {type: 'file_read', path: args.filePath}
    } else if ((tool.name === 'file_write' || tool.name === 'file_edit') && typeof args.filePath === 'string') {
        sandboxOp = {type: 'file_write', path: args.filePath, size: 0}
    } else if (tool.name === 'bash') {
        return {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            denied: true,
            denyReason: '缺少必需参数: command',
            result: errorResult(`工具调用错误：缺少必需参数 "command"。收到的参数: ${JSON.stringify(args)}`),
        }
    }

    if (sandboxOp) {
        const sandboxResult = localSandbox.check(sandboxOp)
        
        if (!sandboxResult.allowed) {
                        return {
                toolCallId: toolCall.id,
                toolName: toolCall.name,
                denied: true,
                denyReason: `Security Block: ${sandboxResult.reason}`,
                result: errorResult(`SECURITY BLOCK: ${sandboxResult.reason}. This operation is deemed extremely dangerous and cannot be executed in any mode.`, 'PERMANENT'),
            }
        }

        // 如果权限引擎已经请求过确认并获得了批准，或工具是 autoApprove，则跳过沙盒确认
        // 子代理 loop 以作用域 auto 运行且没有 requestConfirmation 通道（permissionModeOverride
        // 不会污染主会话）："auto + 无法发起确认" 等价于 "无需确认，直接放行"，与
        // permissionEngine.check() 在 auto 下短路放行的语义对齐。主会话有 requestConfirmation
        // 且 permissionMode 为 undefined，不会命中此条件，原有弹窗确认流程逐字不变。
        const autoWithoutConfirmation = context.permissionMode === 'auto' && !context.requestConfirmation
        const needsSandboxConfirm = sandboxResult.needsConfirmation && !userApproved && !tool.autoApprove && !autoWithoutConfirmation

        if (needsSandboxConfirm && !context.requestConfirmation) {
            if (sandboxResult.riskLevel === 'high') {
                return {
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    denied: true,
                    denyReason: `Security Risk: ${sandboxResult.reason || 'Requires confirmation but not supported'}`,
                    result: errorResult(`SECURITY RISK: This operation requires user confirmation which is not available in the current context.`, 'PERMANENT'),
                }
            }
        } else if (needsSandboxConfirm && context.requestConfirmation) {
            let confirmMessage = sandboxResult.confirmationMessage || `确认执行 ${tool.name}?`
            if (tool.name === 'bash' && typeof args.command === 'string') {
                const reasonText = args.reason ? `\n原因: ${args.reason}` : ''
                confirmMessage = `⚠️ 高危命令\n\n命令: ${args.command}${reasonText}\n\n是否允许执行?`
            }
            const confirmed = await context.requestConfirmation(confirmMessage)
            if (confirmed === 'deny') {
                return {
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    denied: true,
                    denyReason: 'User cancelled security warning',
                    result: errorResult('Security warning rejected by user', 'PERMANENT'),
                }
            }
            if (confirmed === 'always') {
                await permissionEngine.addRule({tool: tool.name, action: 'allow'})
                // 立即通知前端刷新规则列表
                context.onEvent?.({type: 'permission-rules-updated'})
            }
        }
    }

    // 移除旧的破坏性操作检查，因为它已经被前面的逻辑覆盖，且 sandboxOp 逻辑更完备

    // ── 类型转换（修复 LLM 输出类型漂移） ──
    // 在 Zod 验证前，根据工具的 JSON Schema 自动修正参数类型
    // 例如：将字符串 "true" 转为 boolean true，将 "42" 转为 number 42
    const toolDef = toolRegistry.getToolDefinition(toolCall.name)
    if (toolDef) {
        const coercionResult = coerceToolParams(toolCall.arguments, toolDef)
        toolCall.arguments = coercionResult.params
    }

  // 输入验证
  const parseResult = tool.inputSchema.safeParse(toolCall.arguments)
  if (!parseResult.success) {
    // 格式化 Zod 错误为友好的错误信息
    const errorDetails = parseResult.error.issues
      .map((e: z.ZodIssue) => `"${e.path.join('.')}" ${e.message}`)
      .join('; ')
    // 修复 P1-6: 使用安全的参数预览函数，避免敏感信息泄露
    const receivedArgs = safeArgsPreview(toolCall.arguments)
    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: errorResult(`参数验证失败: ${errorDetails}\n收到的参数: ${receivedArgs}`),
    }
  }

    // ── 执行工具（带超时保护） ──
  try {
      // 拥有独立内部超时/中止机制的工具（见模块顶部 SKIP_OUTER_TIMEOUT_TOOLS 注释）
      if (SKIP_OUTER_TIMEOUT_TOOLS.has(tool.name)) {
          const result = await tool.execute(parseResult.data, { ...context, toolCallId: toolCall.id })
          const checkedResult = checkResultSize(toolCall.name, result)
          return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: checkedResult,
          }
      }

      // 获取工具超时时间（优先使用数据库配置，否则使用默认值）
      const timeoutMs = resolveToolTimeoutMs(tool.name, parseResult.data) ?? 60000

      // 使用超时包装器执行工具
      const result = await withToolTimeout(
          tool.execute(parseResult.data, { ...context, toolCallId: toolCall.id }),
          tool.name,
          timeoutMs
      )

      // ── 结果大小检查（兜底机制） ──
      const checkedResult = checkResultSize(toolCall.name, result)

    return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
        result: checkedResult,
    }
  } catch (err: any) {
      // 处理超时错误
      if (err instanceof ToolTimeoutError) {
          return {
              toolCallId: toolCall.id,
              toolName: toolCall.name,
              result: createTimeoutResult(tool.name, err.timeoutMs),
          }
      }

      return {
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result: errorResult(err instanceof Error ? err.message : String(err)),
    }
  }
}

// ── 结果大小检查 ─────────────────────────────────────────────
const SIZE_WARNING_THRESHOLD = 5000 // 字符数阈值
const SIZE_TRUNCATE_THRESHOLD = 15000 // 字符数截断阈值

/**
 * 各工具的差异化截断阈值（字符数）
 *
 * bash 工具一旦解除豁免，即回落到通用 15KB 截断阈值（SIZE_TRUNCATE_THRESHOLD）。
 * 注意：bash 工具内部仍有 2MB 硬上限（bashTool.ts MAX_OUTPUT_SIZE + TRUNCATION_NOTE），
 * 该上限只防内存失控；真正对 LLM 生效的可见上限是这里的 15KB。
 * 这意味着 bash 的大输出会在 executor 层被砍到 15KB —— 这是刻意的取舍：
 * 让模型看到被明确标记的截断结果，而不是被塞入 2MB 撑爆上下文。
 *
 * agent 工具同理：output 是子 Agent 的完整工作报告（主 Agent 汇总的依据），
 * 截断会直接导致工作报告总结不完整，因此豁免通用 15KB 截断。
 *
 * skill 工具同理：output 是 buildGuidance 原文（能力目录尾部注入的内容源），
 * 任何截断或"[警告] 结果较大"尾巴都会破坏三端一致性（运行时 toolResult /
 * DB tool_result / 历史重建），故豁免（阈值 Infinity 同时跳过截断与警告）。
 *
 * list_agents 同理：output 是完整 agent 名册（JSON 数组，多插件场景可达数十 KB），
 * 截断会让 LLM 只看到名册前半段，误判不存在的 agent（如 code-simplifier），
 * 且单行 JSON 被硬切会产生非法片段，故豁免（阈值 Infinity）。
 *
 * MCP 工具（m_/mp_ 前缀）：MCP 结果路径（mcp/formatResult.ts 拼接 text parts）无内部截断，
 * executor 层 128KB 阈值即 MCP 结果的唯一截断点（产品规格）。
 * 因此结果在 128KB 以内时原样返回（不截断、不附加"[警告] 结果较大"），
 * 超过 128KB 由下方截断兜底并附截断标记。
 * 否则 LLM 看到"[结果已截断] 共 X 行"，误以为 MCP 结果集不完整。
 * 其余工具维持通用阈值。
 */
// executor 层对 MCP 结果的 128KB 截断阈值（产品规格）：
// MCP 结果路径无内部上限，此阈值即 MCP 结果的唯一截断点。
const MCP_SIZE_TRUNCATE_THRESHOLD = 128 * 1024

const TOOL_SIZE_TRUNCATE_THRESHOLDS: Record<string, number> = {
    agent: Infinity,
    skill: Infinity,
    list_agents: Infinity,
}

export function checkResultSize(toolName: string, result: ToolResult): ToolResult {
    // 只检查字符串类型的输出
    if (typeof result.output !== 'string' || !result.output) {
        return result
    }

    const output = result.output
    const length = output.length
    // ★ call_mcp_tool（catalog 通道的 MCP 通用调用器）与原生 MCP 工具（m_/mp_）同源同待遇：
    //   128KB 截断阈值 + 不附加「结果较大」警告尾巴（见 TOOL_SIZE_TRUNCATE_THRESHOLDS 注释）。
    const isMcpTool = toolName.startsWith('m_') || toolName.startsWith('mp_') || toolName === 'call_mcp_tool'
    const truncateThreshold = TOOL_SIZE_TRUNCATE_THRESHOLDS[toolName] ??
        (isMcpTool ? MCP_SIZE_TRUNCATE_THRESHOLD : SIZE_TRUNCATE_THRESHOLD)

    // 计算行数（用于 grep/glob 等搜索工具）
    const lineCount = (output.match(/\n/g) || []).length + 1

    // 检查是否需要警告或截断
    if (length > truncateThreshold) {
                return {
            ...result,
            output: output.slice(0, truncateThreshold) +
                `\n\n[结果已截断] 共 ${lineCount} 行，超过 ${truncateThreshold} 字符限制。` +
                `\n请使用更精准的搜索条件（如增加 filePattern、使用正则限制范围）重新搜索。`,
        }
    }

    // 阈值 Infinity 表示完全豁免（agent/skill）：连警告尾巴也不加，
    // 否则会改写 output 原文，破坏缓存一致性（见 TOOL_SIZE_TRUNCATE_THRESHOLDS 注释）
    if (length > SIZE_WARNING_THRESHOLD && !isMcpTool && Number.isFinite(truncateThreshold)) {
        // 添加警告但不截断
        return {
            ...result,
            output: output +
                `\n\n[警告] 结果较大 (${lineCount} 行)。如需更精准的结果，请缩小搜索范围。`,
        }
    }

    return result
}

// ── 安全的参数预览函数 ───────────────────────────────────────
/**
 * 修复 P1-6: 创建安全的参数预览，避免敏感信息泄露
 */
function safeArgsPreview(args: Record<string, unknown>): string {
    const keys = Object.keys(args)
    
    // 敏感字段列表（应隐藏或脱敏）
    const sensitiveKeys = ['password', 'secret', 'token', 'key', 'api_key', 'apikey', 'credential']
    
    // 如果参数过多，只显示键名
    if (keys.length > 10) {
        return `{${keys.slice(0, 10).join(', ')}, ... (共 ${keys.length} 个参数)}`
    }
    
    // 如果单个参数值过长，截断
    const safeArgs: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
        const isSensitive = sensitiveKeys.some(sk => key.toLowerCase().includes(sk))
        if (isSensitive) {
            safeArgs[key] = '[已隐藏]'
        } else if (typeof value === 'string' && value.length > 100) {
            safeArgs[key] = value.slice(0, 100) + '...'
        } else {
            safeArgs[key] = value
        }
    }
    
    return JSON.stringify(safeArgs, null, 2)
}
