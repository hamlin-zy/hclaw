/**
 * Skills 类型定义（扩展版）
 *
 * 支持 DeerFlow 风格的扩展目录结构：
 * - references/: 参考文档（按需加载）
 * - scripts/: 可执行脚本
 * - templates/: 输出模板
 * - agents/: Agent 定义（DeerFlow 特有）
 * - assets/: 静态资源
 *
 * 技能目录结构：
 * ~/.hclaw/skills/
 *   ├── public/          — 内置公共技能
 *   │   └── code-review/
 *   │       ├── SKILL.md
 *   │       ├── references/
 *   │       ├── scripts/
 *   │       └── templates/
 *   └── custom/          — 用户自定义技能
 *       └── my-skill/
 *           └── SKILL.md
 */

import type {SkillExtensions} from '@shared/skillTypes'

// ─── 扩展结构类型 ─────────────────────────────────────

/** 扩展目录类型 */
export type SkillExtensionType = 
  | 'references'   // 参考文档
  | 'scripts'      // 可执行脚本
  | 'templates'    // 输出模板
  | 'agents'       // Agent 定义（DeerFlow）
  | 'assets'       // 静态资源

/** 参考文档条目 */
export interface ReferenceFile {
  /** 文件名（不含扩展名） */
  name: string
  /** 相对于技能目录的路径 */
  path: string
  /** 完整路径 */
  fullPath: string
  /** 文件大小（字节） */
  size: number
  /** 描述（从文件首行提取） */
  description?: string
  /** 分类（从目录结构推断） */
  category?: string
  /** 最后修改时间 */
  mtime: number
}

/** 脚本条目 */
export interface ScriptFile {
  /** 文件名 */
  name: string
  /** 相对于技能目录的路径 */
  path: string
  /** 完整路径 */
  fullPath: string
  /** 脚本语言 */
  language: 'node' | 'python' | 'bash' | 'powershell'
  /** 描述（从注释提取） */
  description?: string
  /** 参数定义 */
  args?: ScriptArg[]
  /** 是否可执行 */
  executable: boolean
}

/** 脚本参数 */
export interface ScriptArg {
  name: string
  description: string
  required: boolean
  default?: string
  type?: 'string' | 'number' | 'boolean' | 'json'
}

/** 模板条目 */
export interface TemplateFile {
  name: string
  path: string
  fullPath: string
  description?: string
  format?: 'markdown' | 'json' | 'yaml' | 'html'
}

/** Agent 定义条目（DeerFlow 风格） */
export interface AgentDefFile {
  name: string
  path: string
  fullPath: string
  description?: string
  type: 'analyzer' | 'grader' | 'comparator' | 'custom'
}

// ─── 技能定义 ──────────────────────────────────────────
// 注意：SkillExtensions 现在从 @shared/skillTypes.ts 导入
// 本地的 ReferenceFile、ScriptFile、TemplateFile、AgentDefFile 保留用于向后兼容

// ─── 技能注册表接口 ──────────────────────────────────

export interface SkillRegistry {
  /** 注册技能 */
  register(skill: SkillDefinition): void
  /** 注销技能 */
  unregister(skillId: string): void
  /** 获取技能 */
  get(skillId: string): SkillDefinition | undefined
  /** 获取所有技能 */
  getAll(): SkillDefinition[]
  /** 获取已启用的技能 */
  getEnabled(): SkillDefinition[]
}

/** 技能执行模式 */
export type SkillExecutionMode = 'inline' | 'fork' | 'reference' | 'script'

export interface SkillDefinition {
  /** 技能 ID（目录名） */
  id: string
  /** 显示名称 */
  name: string
  /** 描述 */
  description: string
  /** 用户自定义描述（优先用于系统提示词注入，支持用户熟悉的语言） */
  userDescription?: string
  /** 何时使用（用于 LLM 发现） */
  whenToUse?: string
  /** 触发条件列表（when_to_use 的别名） */
  triggers?: string[]
  /** 版本 */
  version?: string
  /** 是否启用 */
  enabled: boolean
  /** 来源 */
  source?: 'builtin' | 'user' | 'plugin'
  /** 执行模式：inline=注入消息，fork=启动子 Agent，reference=按需加载引用，script=执行脚本 */
  context?: SkillExecutionMode
  /** 允许使用的工具白名单 */
  allowedTools?: string[]
  /** 模型覆盖（如 'opus', 'sonnet', 'haiku'） */
  model?: string
  /** 子 Agent 类型（fork 模式使用） */
  agentType?: string
  /** 技能正文（Markdown 内容） */
  content: string
  /** 文件路径 */
  filePath?: string
  /** 技能目录路径 */
  skillDir?: string
  /** 容器内路径（DeerFlow 兼容） */
  containerPath?: string
  /** 扩展结构 */
  extensions?: SkillExtensions
  /** 条件路径（路径匹配才激活） */
  paths?: string[]
  /** 技能分类 */
  category?: string
  /** 许可证 */
  license?: string
  /** 依赖 */
  dependency?: {
    nodejs?: string
    python?: string
    [key: string]: string | undefined
  }
  /** 加载时间 */
  loadedAt: number
  /** 插件来源（仅插件技能有） */
  pluginName?: string
  /** 插件实际启用状态（仅插件技能有）。独立于个体的 enabled 字段，用于过滤已禁用插件的技能 */
  pluginEnabled?: boolean
}

// ─── SKILL.md 前置元数据 ─────────────────────────────────

export interface SkillFrontmatter {
  name: string
  description?: string
  /** 用户自定义描述（优先用于系统提示词注入，支持中文等用户熟悉的语言） */
  user_description?: string
  when_to_use?: string
  /** 触发条件列表（when_to_use 的别名，支持字符串或字符串数组） */
  triggers?: string | string[]
  version?: string
  enabled?: boolean
  context?: SkillExecutionMode
  allowed_tools?: string[]
  model?: string
  agent_type?: string
  dependency?: {
    nodejs?: string
    python?: string
  }
}

// ─── 执行状态类型 ─────────────────────────────────────

/** 技能执行阶段 */
export type SkillPhase = 
  | 'idle'                    // 空闲
  | 'matched'                 // 已匹配
  | 'loading_main'           // 加载主文件
  | 'loading_references'      // 加载引用文档
  | 'executing_script'       // 执行脚本
  | 'executing_agent'        // 执行子 Agent
  | 'formatting_result'      // 格式化结果
  | 'done'                   // 完成
  | 'error'                  // 错误

/** 技能执行状态 */
export type SkillStatus = 'matched' | 'loading' | 'executing' | 'done' | 'error'

/** 引用解析结果 */
export interface ReferenceRef {
  path: string
  line?: number
  content?: string
  loaded: boolean
}

/** 脚本调用 */
export interface ScriptCall {
  script: string
  args: string
  raw?: string
}

/** 日志条目 */
export interface SkillLogEntry {
  timestamp: number
  type: 'info' | 'warn' | 'error' | 'output' | 'debug'
  message: string
  data?: unknown
}

/** 脚本执行结果 */
export interface ScriptResult {
  success: boolean
  output?: string
  error?: string
  exitCode?: number
  duration?: number
}

// ─── 事件类型 ─────────────────────────────────────

/** 技能流事件 */
export type SkillStreamEvent = 
  | { type: 'skill_matched'; skillId: string; skillName: string; reason: string }
  | { type: 'skill_start'; executionId: string }
  | { type: 'phase_change'; phase: SkillPhase; message?: string; progress?: { current: number; total: number } }
  | { type: 'reference_load_start'; refName: string }
  | { type: 'reference_loaded'; refName: string; size: number }
  | { type: 'reference_error'; refName: string; error: string }
  | { type: 'script_start'; scriptName: string; args: string }
  | { type: 'script_output'; chunk: string }
  | { type: 'script_done'; exitCode: number; duration: number }
  | { type: 'script_error'; error: string }
  | { type: 'log'; entry: SkillLogEntry }
  | { type: 'result'; content: string; resultType: 'inline' | 'script_output' | 'reference' }
  | { type: 'error'; phase: SkillPhase; message: string }
  | { type: 'skill_end'; success: boolean }
