/**
 * 权限检查引擎
 *
 * 三种模式：
 * - safe: 未知操作需确认，非破坏性工具自动放行
 * - auto: 所有已注册的非破坏性工具自动放行（剥离危险规则）
 * - plan: 仅允许只读工具
 *
 * 规则持久化：
 * - 规则保存在 ~/.hclaw/permission-rules.json
 * - 配置保存在 ~/.hclaw/permission-config.json
 * - 启动时自动加载
 *
 * 细粒度权限：
 * - bash 工具：安全命令（cd/ls/cat/echo 等）自动放行，其他命令需用户确认
 * - file_edit/file_write：文件不在工作目录下时需用户确认
 *
 * 架构：
 * - PermissionEngine: 负责权限检查逻辑（细粒度权限、规则匹配）
 * - PermissionRulesManager: 负责权限上下文管理（模式转换、危险规则剥离/恢复）
 * - 两层分离：Engine专注检查，Manager专注状态管理
 */

import * as path from 'path'
import type {PermissionResult, PermissionRule, PlannedCommandsCheckResult, RunMode, Tool} from './types'
import type {DangerousPermissionInfo} from '@shared/types'
import {permissionRulesManager} from '../permissions/permissionRule'

/** 安全命令白名单（bash 工具中这些命令自动放行） */
const SAFE_COMMAND_PATTERNS = [
    /^cd\s/,
    /^ls\b/,
    /^dir\b/i,
    /^cat\s/,
    /^type\s/i,
    /^echo\s/,
    /^pwd\b/,
    /^head\s/,
    /^tail\s/,
    /^wc\s/,
    /^find\s/,
    /^grep\s/,
    /^Get-ChildItem\b/i,
    /^Get-Content\b/i,
    /^Select-String\b/i,
    /^Test-Path\b/i,
    /^Get-Location\b/i,
    /^Set-Location\b/i,
    /^tree\b/,
    /^stat\s/,
    /^file\s/,
    /^which\s/,
    /^where\s/,
    /^whereis\b/,
    /^man\s/,
    /^help\b/,
    /^date\b/,
    /^whoami\b/,
    /^hostname\b/,
    /^uname\b/,
    /^df\s/,
    /^du\s/,
    /^free\b/,
    /^top\b/,
    /^ps\b/,
    /^env\b/,
    /^printenv\b/,
    /^sort\s/,
    /^uniq\s/,
    /^cut\s/,
    /^awk\s/,
    /^sed\s/,
    /^diff\s/,
    /^comm\s/,
    /^cmp\s/,
    /^md5sum\s/,
    /^sha(1|256|512)sum\s/,
    /^xxd\s/,
    /^hexdump\s/,
    /^strings\s/,
    /^less\s/,
    /^more\s/,
    /^nl\s/,
    /^tac\s/,
    /^rev\s/,
    /^tr\s/,
    /^fold\s/,
    /^paste\s/,
    /^join\s/,
    /^split\s/,
    /^basename\s/,
    /^dirname\s/,
    /^realpath\s/,
    /^readlink\s/,
    /^lsblk\b/,
    /^lscpu\b/,
    /^lsmem\b/,
    /^ip\s/,
    /^ifconfig\b/,
    /^ping\s/,
    /^nslookup\s/,
    /^dig\s/,
    // P1-1: curl/wget 只允许安全的只读操作，禁止自动放行下载脚本或上传数据
    // - 只允许 HEAD 请求（检查资源存在性）
    // - curl -s/-S/-I 用于查看状态码和元数据
    // - 禁止 -d/--data/--upload-file 等上传参数
    /^curl\s+(-[sSIkLvoEgGbnNERjyAWhpPdcTuXxZz]*\s*)*(?:https?:\/\/[^\s]+)?\s*$/i,
    /^wget\s+(-[^\s]*)*\s*(?:--spider|-q|--no-check-certificate)?\s*(?:https?:\/\/[^\s]+)?\s*$/i,
    // P1-2: git 只允许只读操作，移除危险的 git config/git push/git force-push
    /^git\s+(status|log|diff|show|branch|tag|remote|describe|shortlog|reflog)/,
    /^git\s+stash\s+(list|show|pop|apply|drop|clear)/,
    /^git\s+ls-(?:files|tree|remote)/,
    /^git\s+rev-parse/,
    /^git\s+rev-list/,
    /^git\s+switch\s+--detach\s+/,
    /^yarn\s+(run\s|test|list|info|why)/,
    /^pnpm\s+(run\s|test|list|info|why)/,
    /^npx\s+--(yes|y)\s+(eslint|prettier|tsc|typescript|jest|mocha|vitest|ts-node|tsx|node)/,
    /^node\s+--(version|v|-v)/,
    /^python(3)?\s+--version/i,
    /^java\s+--?version/i,
    /^go\s+version/i,
    /^rustc\s+--version/i,
    /^cargo\s+--version/i,
]

/** 危险命令模式（即使用户说"始终允许"也不放行的硬拦截）
 *
 * 🔴 单一真相源：由 dangerousPatterns.ts 统一维护，此处只引用不移除。
 * 如需新增/修改危险模式，请编辑 dangerousPatterns.ts。
 */
import {DANGEROUS_COMMAND_PATTERNS} from '../permissions/dangerousPatterns'

/**
 * 高危命令模式（用于 LocalSandbox 二次检查）
 * 这是 permissionEngine 和 localSandbox 共享的危险命令检测点
 *
 * 设计原则：
 * - PermissionEngine 负责"是否允许"的决策
 * - LocalSandbox 负责"执行时是否安全"的二次检查
 * - 两者使用相同的高危模式定义，确保一致的行为
 */
const HIGH_RISK_PATTERNS = [
    // 根目录递归删除
    /rm\s+-rf\s+\/(?:\s|$)/,
    /rm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/[^a-zA-Z]/,
    // dd 到磁盘设备
    /dd\s+if=.*of=\/dev\//,
    // 磁盘格式化
    /mkfs\./,
    /format\s+[a-z]:/i,
    // 关机/重启命令
    /\bshutdown\b/i,
    /\breboot\b/i,
    /\bhalt\b/i,
    /\bpoweroff\b/i,
    // Fork Bomb
    /:\(\)\{\s*:\|:\s*&\s*\};:\s*$/i,
]

/** 转义正则表达式特殊字符 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export class PermissionEngine {
  private rules: PermissionRule[] = []
    private mode: RunMode = 'safe'
  private _workingDir: string = ''
  private _dangerousRulesWarned: boolean = false  // 标记是否已警告过危险规则
  private _initialized: boolean = false  // P2-2: 初始化状态标志
  private initPromise: Promise<void> | null = null

  constructor() {
      // 延迟初始化：不在此处访问数据库，避免在模块加载时（DB 迁移前）查询不存在的表
      // ensureInit() 会在第一次实际使用时（setMode/getMode/check 等）触发初始化
  }

  /**
   * 从 PermissionRulesManager 异步初始化
   */
  private async initFromContextManager(): Promise<void> {
      const context = await permissionRulesManager.getContext()
    this.rules = context.rules
    this.mode = context.mode
    this._initialized = true
  }

  /**
   * 确保初始化完成（懒加载）
   * 仅在首次实际使用时才访问数据库，避免模块加载时（DB 迁移前）报错
   */
  private async ensureInit(): Promise<void> {
      // 已初始化，直接返回
    if (this._initialized) return

      // 初始化进行中，等待完成
    if (this.initPromise) {
      await this.initPromise
        return
    }

      // 首次触发：执行初始化
      this.initPromise = this.initFromContextManager()
      await this.initPromise
  }

    /** 设置当前工作目录（用于文件路径权限检查） */
    setWorkingDir(dir: string): void {
        this._workingDir = path.resolve(dir)
    }

    /** 获取当前工作目录 */
    getWorkingDir(): string {
        return this._workingDir
    }

    async setMode(mode: RunMode): Promise<void> {
    await this.ensureInit()
      // 委托给 PermissionRulesManager
      const newContext = await permissionRulesManager.applyUpdate({type: 'setMode', mode})
    this.mode = newContext.mode
    this.rules = newContext.rules
  }

    async getMode(): Promise<RunMode> {
    await this.ensureInit()
    return this.mode
  }

    /** 获取当前所有规则（确保去重） */
  async getRules(): Promise<PermissionRule[]> {
    await this.ensureInit()
        // 确保返回的数据没有重复（防御性编程）
        const deduped = this.deduplicateRules(this.rules)
        if (deduped.length !== this.rules.length) {
                        this.rules = deduped
        }
    return [...this.rules]
  }

  /** 从磁盘重新加载规则（保持与主进程同步） */
  async reloadRules(): Promise<void> {
      await permissionRulesManager.reload()
      const context = await permissionRulesManager.getContext()
    this.rules = context.rules
    this.mode = context.mode
  }

    /** 清理重复规则并保存到文件（委托给 PermissionRulesManager） */
    async cleanAndSave(): Promise<void> {
        // PermissionRulesManager 已经在保存时自动去重
        // 这里只需重新加载即可
        await this.reloadRules()
    }

    /**
     * 去重规则列表
     * 对于相同的 tool，保留最后出现的规则（最新用户意图）
     */
    private deduplicateRules(rules: PermissionRule[]): PermissionRule[] {
        const seen = new Map<string, PermissionRule>()
        for (const rule of rules) {
            seen.set(rule.tool, rule)
        }
        return Array.from(seen.values())
    }

    /** 编译规则的 glob pattern（如有 * 号），用于快速匹配 */
    private compileGlobPattern(rule: PermissionRule): void {
        if (rule.tool.includes('*')) {
            const escaped = escapeRegex(rule.tool).replace(/\\\*/g, '.*')
            ;(rule as any)._compiledRegex = new RegExp('^' + escaped + '$')
        }
    }

  async addRule(rule: PermissionRule): Promise<void> {
    await this.ensureInit()
      const newContext = await permissionRulesManager.applyUpdate({type: 'addRule', rule})
    this.rules = newContext.rules
    this.compileGlobPattern(rule)
  }

  async setRules(rules: PermissionRule[]): Promise<void> {
    await this.ensureInit()
      const newContext = await permissionRulesManager.applyUpdate({type: 'setRules', rules})
    this.rules = newContext.rules
    for (const rule of this.rules) {
      this.compileGlobPattern(rule)
    }
  }

  /** 删除指定工具的规则 */
  async removeRulesForTool(toolName: string): Promise<void> {
    await this.ensureInit()
      // 委托给 PermissionRulesManager
      const newContext = await permissionRulesManager.applyUpdate({type: 'removeRule', tool: toolName})
    this.rules = newContext.rules
  }

    /** 获取危险权限信息（委托给 PermissionRulesManager） */
  async getDangerousPermissions(): Promise<DangerousPermissionInfo[]> {
    await this.ensureInit()
        return permissionRulesManager.getDangerousPermissions()
  }

  /**
   * 检查命令是否为高危命令
   *
   * 这是 permissionEngine 和 localSandbox 共享的检测点
   * 用于 localSandbox 的二次检查，确保一致的行为
   *
   * @param command 命令字符串
   * @returns 是否为高危命令
   */
  isHighRisk(command: string): boolean {
    if (!command || typeof command !== 'string') {
      return false
    }

    const normalized = command.trim()

    // 检查高危模式
    for (const pattern of HIGH_RISK_PATTERNS) {
      if (pattern.test(normalized)) {
        return true
      }
    }

    return false
  }

  /** 检查工具调用权限 */
  check(tool: Tool, args: any): PermissionResult {
      // Auto 模式下首次调用时警告危险规则
      if (this.mode === 'auto' && !this._dangerousRulesWarned) {
        const _dangerous = this.getDangerousPermissions()
        this._dangerousRulesWarned = true
      }

      // 1. 首先检查显式规则（用户添加的规则优先级最高）
    for (const rule of this.rules) {
        // 处理 bash:命令* 格式的规则
        if (rule.tool.startsWith('bash:')) {
            if (tool.name !== 'bash') continue

            // 提取命令模式
            const cmdPattern = rule.tool.slice(5) // 去掉 'bash:' 前缀
            const command = typeof args?.command === 'string' ? args.command.trim() : ''

            if (!command) continue

            // P1-3: 提取实际命令，跳过常见前缀（sudo/powershell/cmd 等）
            const cmdPrefix = this.extractCommandBase(command)
            // 同时保留完整命令用于更精确的匹配
            const fullCommand = command

            // 检查命令是否匹配规则（优先匹配完整命令，再匹配命令前缀）
            const matchesFullCommand = this.matchCommandGlob(fullCommand, cmdPattern)
            const matchesPrefix = this.matchCommandGlob(cmdPrefix, cmdPattern)

            if (matchesFullCommand || matchesPrefix) {
                switch (rule.action) {
                    case 'allow':
                        return {allowed: true}
                    case 'deny':
                        return {allowed: false, reason: `Command "${cmdPrefix}" denied by rule`}
                    case 'ask':
                        return {allowed: false, reason: `Command "${cmdPrefix}" requires user confirmation`}
                }
            }
            continue
        }

        // 处理普通工具规则
        if (this.matchRule(rule, tool.name)) {
            switch (rule.action) {
                case 'allow':
                    return {allowed: true}
                case 'deny':
                    return {allowed: false, reason: `Tool "${tool.name}" denied by rule`}
                case 'ask':
                    return {allowed: false, reason: `Tool "${tool.name}" requires user confirmation`}
            }
        }
    }

      // 2. auto 模式：所有工具自动放行
    if (this.mode === 'auto') {
      return { allowed: true }
    }

      // 3. 细粒度权限检查（基于具体命令/路径）
      const fineGrainedResult = this.checkFineGrained(tool.name, args)
      if (fineGrainedResult) {
          return fineGrainedResult
      }

      // 5. safe 模式：非破坏性工具放行，破坏性工具需确认
    if (this.mode === 'safe' && !tool.isDestructive) {
      return { allowed: true }
    }

    return {
      allowed: false,
      reason: `Tool "${tool.name}" ${tool.isDestructive ? 'is destructive' : 'requires confirmation in this mode'}, requires user confirmation`,
    }
  }

    /**
     * 细粒度权限检查
     * - bash: 安全命令自动放行，危险命令硬拦截，其他命令需确认
     * - file_edit/file_write: 文件不在工作目录下需确认
     */
    private checkFineGrained(toolName: string, args: any): PermissionResult | null {
        // ── bash 工具：检查具体命令 ──
        if (toolName === 'bash' && typeof args?.command === 'string') {
            const command = args.command.trim()

            // 危险命令硬拦截（不可绕过）
            // 模式定义见 dangerousPatterns.ts（单一真相源）
            for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
                if (pattern.test(command)) {
                    return {
                        allowed: false,
                        reason: `安全拦截：此命令包含极度危险操作，系统已硬性禁止。`,
                    }
                }
            }

            // 安全命令自动放行
            for (const pattern of SAFE_COMMAND_PATTERNS) {
                if (pattern.test(command)) {
                    return {allowed: true}
                }
            }

            // 其他命令需要用户确认
            return {
                allowed: false,
                reason: `command_confirm`,
                detail: {
                    type: 'bash_command',
                    command: command,
                },
            }
        }

        // ── file_edit / file_write：检查文件路径 ──
        if ((toolName === 'file_edit' || toolName === 'file_write') && this._workingDir) {
            const filePath = args?.filePath
            if (typeof filePath === 'string' && filePath) {
                const resolvedPath = path.resolve(this._workingDir, filePath)
                const isWithinWorkingDir = this.isPathWithin(resolvedPath, this._workingDir)

                if (!isWithinWorkingDir) {
                    return {
                        allowed: false,
                        reason: `path_outside_working_dir`,
                        detail: {
                            type: 'file_outside_working_dir',
                            filePath: resolvedPath,
                            workingDir: this._workingDir,
                        },
                    }
                }
            }
        }

        return null
    }

    /** 检查 childPath 是否在 parentPath 目录下 */
    private isPathWithin(childPath: string, parentPath: string): boolean {
        const normalizedChild = path.normalize(childPath)
        const normalizedParent = path.normalize(parentPath)
        const relative = path.relative(normalizedParent, normalizedChild)
        return !relative.startsWith('..') && !path.isAbsolute(relative) && relative !== ''
    }

  private matchRule(rule: PermissionRule, toolName: string): boolean {
    if (rule.tool === '*') return true
    if (rule.tool === toolName) return true
    // 支持 glob: file_* 匹配 file_read, file_write 等
    if (rule.tool.includes('*')) {
      // 预编译的正则存储在 rule 对象上（由 addRule/setRules 设置）
      if ((rule as any)._compiledRegex) {
        return (rule as any)._compiledRegex.test(toolName)
      }
    }
    return false
  }

    /**
     * 检查 plannedCommands（计划执行的命令列表）
     *
     * 策略：
     * 1. 如果命令匹配危险命令模式，硬拦截
     * 2. 逐一检查每个命令：
     *    - 如果权限规则中已配置该命令且 action=allow，自动放行
     *    - 否则，需要用户确认
     * 3. 只要有一个命令需要确认，整个检查就需要用户确认
     *
     * @param plannedCommands LLM 返回的命令列表（如 ['git add', 'dir', 'ls -al']）
     * @returns 检查结果
     */
    checkPlannedCommands(plannedCommands: string[]): PlannedCommandsCheckResult {
        // Auto 模式：所有非危险命令自动放行
        if (this.mode === 'auto') {
            // 但仍需检查危险命令
            const deniedCommands: string[] = []
            for (const cmd of plannedCommands) {
                for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
                    if (pattern.test(cmd)) {
                        deniedCommands.push(cmd)
                        break
                    }
                }
            }
            return {
                needsConfirmation: deniedCommands.length > 0,
                commandsToConfirm: [],
                allowedCommands: plannedCommands.filter(c => !deniedCommands.includes(c)),
                confirmationMessage: deniedCommands.length > 0
                    ? `❌ 以下命令被安全拦截：\n${deniedCommands.map(c => `  - ${c}`).join('\n')}`
                    : undefined,
            }
        }

        const commandsToConfirm: string[] = []
        const allowedCommands: string[] = []
        const deniedCommands: string[] = []

        for (const cmd of plannedCommands) {
            // 提取命令前缀（如 'git add' -> 'git'，'git status' -> 'git'）
            const cmdPrefix = cmd.trim().split(/\s+/)[0] || ''

            // 危险命令硬拦截（模式定义见 dangerousPatterns.ts）
            let isDangerous = false
            for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
                if (pattern.test(cmd)) {
                    isDangerous = true
                    break
                }
            }
            if (isDangerous) {
                deniedCommands.push(cmd)
                continue
            }

            // 检查权限规则
            let matched = false
            for (const rule of this.rules) {
                // 匹配工具名（如 bash:git*）
                const toolPattern = rule.tool
                if (toolPattern.startsWith('bash:')) {
                    const cmdPattern = toolPattern.slice(5) // 去掉 'bash:' 前缀
                    const globMatch = this.matchCommandGlob(cmdPrefix, cmdPattern)
                    if (globMatch) {
                        matched = true
                        if (rule.action === 'allow') {
                            allowedCommands.push(cmd)
                        } else if (rule.action === 'deny') {
                            deniedCommands.push(cmd)
                        } else {
                            commandsToConfirm.push(cmd)
                        }
                        break
                    }
                }
            }

            if (!matched) {
                // 规则未匹配，需要确认
                commandsToConfirm.push(cmd)
            }
        }

        // 构建确认消息
        let confirmationMessage: string | undefined
        if (commandsToConfirm.length > 0) {
            const cmdList = commandsToConfirm.map(c => `  - ${c}`).join('\n')
            const allowedList = allowedCommands.length > 0
                ? `\n\n已自动放行：\n` + allowedCommands.map(c => `  - ${c}`).join('\n')
                : ''
            confirmationMessage = `⚠️ 需要确认以下命令：\n\n${cmdList}${allowedList}\n\n是否允许执行?`
        }

        return {
            needsConfirmation: commandsToConfirm.length > 0 || deniedCommands.length > 0,
            commandsToConfirm,
            allowedCommands,
            confirmationMessage,
        }
    }

    /**
     * 匹配命令前缀与 glob 模式
     * 例如：'git' 匹配 'git*'、'git add*'、'git'
     */
    /**
     * 提取命令基础名称
     *
     * 跳过常见命令前缀，还原实际命令：
     * - 'sudo git status' -> 'git'
     * - 'powershell -Command dir' -> 'dir'
     * - 'cmd /c del file' -> 'del'
     * - 'node script.js' -> 'node'
     */
    private extractCommandBase(command: string): string {
        const parts = command.split(/\s+/)
        if (parts.length === 0) return ''

        // Windows 风格前缀
        if (parts[0].toLowerCase() === 'cmd' && parts.length > 2 && parts[1] === '/c') {
            return parts[2]?.split(/\s+/)[0] || parts[2] || ''
        }
        if (parts[0].toLowerCase() === 'powershell' && parts.length > 1) {
            // powershell -Command "..." 或 powershell -C "..."
            const cmdIdx = parts.findIndex(p => p === '-Command' || p === '-C')
            if (cmdIdx >= 0 && parts[cmdIdx + 1]) {
                return parts[cmdIdx + 1].split(/\s+/)[0] || ''
            }
        }

        // Unix 风格前缀
        const SKIP_PREFIXES = ['sudo', 'doas', 'su', '-']
        if (SKIP_PREFIXES.includes(parts[0])) {
            // 跳过前缀，找到实际命令
            for (let i = 1; i < parts.length; i++) {
                if (!parts[i].startsWith('-')) {
                    return parts[i].split(/\s+/)[0] || ''
                }
            }
        }

        return parts[0] || ''
    }

    private matchCommandGlob(cmdPrefix: string, pattern: string): boolean {
        if (pattern === '*') return true
        if (pattern === cmdPrefix) return true

        if (pattern.includes('*')) {
            const escaped = escapeRegex(pattern).replace(/\\\*/g, '.*')
            const regex = new RegExp('^' + escaped + '$')
            return regex.test(cmdPrefix)
        }

        // 前缀匹配：'git add' 匹配 'git*'
        return cmdPrefix.startsWith(pattern.replace(/\*+$/, ''))
    }
}

/** 全局单例 */
export const permissionEngine = new PermissionEngine()
