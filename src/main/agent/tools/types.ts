/**
 * 工具系统核心类型定义
 *
 * 借鉴 Claude Code (cc_src) 的 Tool 接口设计：
 * - Zod Schema 输入验证
 * - 权限声明 + 破坏性标记
 * - 进度回调
 * - 结果附带副作用描述
 */

import {z} from 'zod'
// RunMode 代理导出（真实定义在 @shared/types）
export type {RunMode} from '@shared/types'

// 前向声明：避免循环依赖，sendMessage 的具体类型在 stream.ts 中定义
// ToolContext 中使用泛型函数签名
export type SendMessageFn = (msg: { type: string; [key: string]: unknown }) => void

// ─── 工具接口 ──────────────────────────────────────────

export interface Tool<Input = any, Output = any> {
  /** 工具唯一名称 */
  name: string
  /** 工具描述（会展示给 LLM） */
  description: string
  /** Zod Schema 输入验证 */
  inputSchema: z.ZodType<Input>
  /** 需要的权限声明，如 ['fs:read', 'fs:write', 'bash:execute'] */
  requiredPermissions?: string[]
  /** 是否为破坏性操作（删除、覆盖等），需要用户二次确认 */
  isDestructive?: boolean
    /** 自动批准 — 调用此工具时无需用户二次确认（MCP 工具 autoApprove 标记） */
    autoApprove?: boolean

  /** 执行工具 */
  execute(args: Input, context: ToolContext): Promise<ToolResult<Output>>
}

// ─── 工具执行上下文 ────────────────────────────────────

export interface ToolContext {
  /** 当前工具调用的 ID（用于并行模式下子 Agent 事件路由到正确卡片） */
  toolCallId?: string
  /** 当前工作目录 */
  workingDir: string
  /** 中止信号 */
  abortSignal: AbortSignal
  /** 向 UI 推送进度消息 */
  sendMessage: SendMessageFn
  /** 请求用户确认（用于破坏性操作） */
  requestConfirmation?: (message: string) => Promise<'allow' | 'always' | 'deny'>
    /** 向用户提问并等待回答 */
    askUserQuestion?: (question: string, options?: string[], multiSelect?: boolean) => Promise<string>
    /** 通过渠道发送消息（Worker → Main IPC，带回确认结果）
     * 当 fileType 参数存在时，text 参数实际为 filePath，走媒体发送通道 */
    channelSend?: (channelId: string, toUser: string, text: string, contextToken?: string, fileType?: string) => Promise<{ success: boolean; error?: string }>
    /** 推送事件到渲染进程 */
    onEvent?: (event: any) => void
}

// ─── 工具执行结果 ──────────────────────────────────────

export interface ToolResult<T = any> {
  success: boolean
  output: T
  error?: string
  /** 文件变更副作用（显示在右侧 FileChangesPanel） */
  artifacts?: Artifact[]
  /** 补丁数据（用于 file_edit 等工具） */
  diff?: string
    /** 需要注入到对话的消息（用于 SkillTool inline 模式） */
    injectMessage?: {
        role: 'user' | 'assistant' | 'system'
        content: string
    }
    /** 任务列表更新（用于 TaskCreateTool/TaskUpdateTool 等任务管理工具） */
    tasks?: import('@shared/types').Task[]
}

export interface Artifact {
  filePath: string
  action: 'created' | 'modified' | 'deleted'
  content?: string
}

// ─── 权限系统 ──────────────────────────────────────────

export interface PermissionRule {
    /** 匹配的工具名称（支持 glob），如 'bash'、'bash:git*'、'file_*' */
  tool: string
  action: 'allow' | 'deny' | 'ask'
  /** 可选的路径 glob 匹配 */
  pattern?: string
    /** 可选的命令前缀匹配（用于 bash 命令精确控制） */
    commandPrefix?: string
    /** 创建时间戳（用于排序，最新的在前） */
    createdAt?: number
}

export interface PermissionResult {
  allowed: boolean
  reason?: string
    /** 细粒度权限详情（用于渲染更具体的确认对话框） */
    detail?: {
        type: 'bash_command' | 'planned_commands' | 'file_outside_working_dir'
        command?: string
        commands?: string[]
        filePath?: string
        workingDir?: string
    }
}

/** plannedCommands 检查结果 */
export interface PlannedCommandsCheckResult {
    /** 是否需要用户确认 */
    needsConfirmation: boolean
    /** 所有需要确认的命令 */
    commandsToConfirm: string[]
    /** 不需要确认的命令（已放行） */
    allowedCommands: string[]
    /** 确认消息 */
    confirmationMessage?: string
}

// ─── 工具定义（给 LLM 看的 JSON Schema） ───────────────

export interface ToolDefinitionForLLM {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
}

/** 从 Tool 实例提取 LLM 可用的工具定义 */
export function toolToDefinition(tool: Tool): ToolDefinitionForLLM {
  const schema = tool.inputSchema
  // Zod schema → JSON Schema
  const jsonSchema = zodToJsonSchema(schema)
  // 处理联合类型 (z.union)：从 anyOf 的所有成员中提取 properties 合并
  // 否则 LLM 看到的 properties 为空，不知道传什么参数
  let properties = jsonSchema.properties
  let required = jsonSchema.required
  if (!properties && jsonSchema.anyOf) {
    properties = {}
    for (const member of jsonSchema.anyOf) {
      if (member.properties) {
        Object.assign(properties, member.properties)
      }
    }
    // 联合类型的所有字段设为可选，让 LLM 灵活选择
    required = undefined
  }
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: properties || {},
      required,
    },
  }
}

/**
 * 检查 Zod 类型是否为可选（包括嵌套的可选包装）
 *
 * 兼容 Zod v3/v4 两种类型标识方式：
 * - 旧版：_def.typeName === 'ZodOptional'
 * - 新版：_def.type === 'optional'
 */
function isZodOptional(zodType: z.ZodType<any>): boolean {
  const def: any = (zodType as any)._def
  if (!def) return false

    // 新版 Zod: _def.type === 'optional' / 'default' / 'nullable'
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable') {
        return true
    }

    // 旧版 Zod: _def.typeName
    if (def.typeName === 'ZodOptional' || def.typeName === 'ZodDefault' || def.typeName === 'ZodNullable') {
    return true
  }

  return false
}

/**
 * 简易 Zod → JSON Schema 转换
 * （生产环境可替换为 zod-to-json-schema 库，此处保持零依赖）
 *
 * 兼容 Zod v3/v4 两种类型标识方式：
 * - 旧版：_def.typeName（如 'ZodString', 'ZodNumber'）
 * - 新版：_def.type（如 'string', 'number', 'boolean'）
 */
function zodToJsonSchema(zodType: z.ZodType<any>): Record<string, any> {
  const def: any = (zodType as any)._def

  if (!def) return { type: 'object', properties: {} }

    // 统一获取类型标识（优先新版 _def.type，回退旧版 _def.typeName）
    const typeKey = def.type || def.typeName || ''

    switch (typeKey) {
        case 'object':
    case 'ZodObject': {
        const shape = def.shape // shape 是属性，不是方法
      const properties: Record<string, any> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value as z.ZodType<any>)
        if (!isZodOptional(value as z.ZodType<any>)) {
          required.push(key)
        }
      }
      return { type: 'object', properties, required: required.length ? required : undefined }
    }

        case 'string':
    case 'ZodString':
      return { type: 'string', description: def.description }

        case 'number':
    case 'ZodNumber':
      return { type: 'number', description: def.description }

        case 'integer':
            return {type: 'integer', description: def.description}

        case 'boolean':
    case 'ZodBoolean':
      return { type: 'boolean', description: def.description }

        case 'array':
    case 'ZodArray':
        // 新版: def.element, 旧版: def.type
        const itemType = def.element || def.type
        return {type: 'array', items: zodToJsonSchema(itemType)}

        case 'optional':
    case 'ZodOptional':
        // 新版: def.innerType, 旧版: def.innerType
      return { ...zodToJsonSchema(def.innerType), description: def.description }

        case 'default':
    case 'ZodDefault':
      return zodToJsonSchema(def.innerType)

        case 'nullable':
    case 'ZodNullable':
      return { ...zodToJsonSchema(def.innerType), nullable: true }

        case 'enum':
    case 'ZodEnum':
      return { type: 'string', enum: def.values, description: def.description }

        case 'nativeEnum':
        case 'ZodNativeEnum':
            return {enum: Object.values(def.values), description: def.description}

        case 'record':
    case 'ZodRecord':
        // 新版: def.valueType, 旧版: def.valueType
      return { type: 'object', additionalProperties: zodToJsonSchema(def.valueType) }

        case 'tuple':
        case 'ZodTuple':
            return {
                type: 'array',
                items: def.items?.map((item: z.ZodType<any>) => zodToJsonSchema(item)),
                description: def.description,
            }

        case 'union':
        case 'ZodUnion':
        case 'ZodDiscriminatedUnion': {
            // 对联合类型，尝试合并所有选项的 schema
            const options = def.options || def.items || []
            if (options.length === 1) {
                return zodToJsonSchema(options[0])
            }
            // 多选项：返回 anyOf（JSON Schema 标准）
            return {
                anyOf: options.map((opt: z.ZodType<any>) => zodToJsonSchema(opt)),
                description: def.description,
            }
        }

        case 'intersection':
        case 'ZodIntersection':
            return {
                allOf: [
                    zodToJsonSchema(def.left),
                    zodToJsonSchema(def.right),
                ],
                description: def.description,
            }

        case 'literal':
        case 'ZodLiteral': {
            const val = def.value
            if (typeof val === 'string') return {type: 'string', const: val}
            if (typeof val === 'number') return {type: 'number', const: val}
            if (typeof val === 'boolean') return {type: 'boolean', const: val}
            return {const: val}
        }

        case 'unknown':
        case 'ZodUnknown':
            return {}

        case 'any':
        case 'ZodAny':
            return {}

        case 'never':
        case 'ZodNever':
            return {not: {}}

        case 'date':
        case 'ZodDate':
            return {type: 'string', format: 'date-time', description: def.description}

    default:
              return { type: 'string' }
  }
}
