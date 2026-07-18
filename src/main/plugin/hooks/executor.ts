/**
 * HookExecutor - 统一 Hook 执行器
 *
 * 基于 Claude Code Hooks 规范实现：
 * - 支持 command 类型：通过 shell 命令执行，exit code 控制行为
 * - 支持 function 类型：直接调用 JavaScript 函数
 * - Exit code 语义：0=允许，2=阻止
 * - Matcher 支持：'*', 精确匹配, 正则匹配
 */

import {exec} from 'child_process'
import {promisify} from 'util'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {isMainThread, parentPort} from 'worker_threads'
import type {HookContext, HookEvent, HookHandler, HookResult} from './types'
import {matchesTool, matchesEvent, matchesFile} from './matcher'
import {PluginRegistry} from '../registry'
import {getHclawDir} from '../../config'
import {readHookConfig} from '../../config/hookConfig'
import {createLogger} from '../../agent/logger'
import {registerBuiltinHandlers as registerBuiltins} from './builtin'

const execAsync = promisify(exec)
const logger = createLogger('hooks')

/**
 * Exit code 语义（基于 Claude Code 规范）
 * - 0: 允许操作继续
 * - 1: 允许但有警告
 * - 2: 阻止操作
 */
const _EXIT_CODE_ALLOW = 0
const EXIT_CODE_WARN = 1
const EXIT_CODE_BLOCK = 2

/** 单次 Hook 执行固定超时（超过则 kill 子进程） */
const HOOK_TIMEOUT_MS = 60_000

interface HookQueueItem {
  event: HookEvent
  context: HookContext
  options?: { abortSignal?: AbortSignal }
  resolve: (result: HookResult) => void
  reject: (error: any) => void
}

interface ConversationSlot {
  running: boolean
  queue: HookQueueItem[]
  abortController?: AbortController
  timeoutId?: ReturnType<typeof setTimeout>
}

export class HookExecutor {
  private static instance: HookExecutor
  private registry: PluginRegistry
  // 内置 function hooks
  private builtinHandlers: Map<string, HookHandler> = new Map()
  // 兼容层事件处理器（旧系统用户脚本迁移用）
  private eventHandlers: Map<HookEvent, Array<{ handler: HookHandler; name: string }>> = new Map()
  // 执行结果监听器（用于转发到 UI，仅主线程有效）
  private resultListeners: Array<(event: HookEvent, hookName: string, result: HookResult) => void> = []
  private pendingHooks: Map<string, { event: HookEvent; name: string }> = new Map()
  // 每会话 Hook 执行槽位（排队 + 超时 + 可取消）
  private conversationSlots = new Map<string, ConversationSlot>()
  // Agent hook 防递归深度
  private hookDepth = 0
  private readonly MAX_HOOK_DEPTH = 3

  private constructor() {
    this.registry = PluginRegistry.getInstance()
    this.registerBuiltinHandlers()
  }

  static getInstance(): HookExecutor {
    if (!HookExecutor.instance) {
      HookExecutor.instance = new HookExecutor()
    }
    return HookExecutor.instance
  }

  /**
   * 注册内置 function 类型 hook
   */
  registerBuiltinHandler(id: string, handler: HookHandler): void {
    this.builtinHandlers.set(id, handler)
  }

  /**
   * 注册事件处理器（用于兼容层和动态注册）
   * 这些处理器会在插件 hooks 和数据库 hooks 之后执行
   */
  registerEventHandler(event: HookEvent, handler: HookHandler, name?: string): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, [])
    }
    this.eventHandlers.get(event)!.push({ handler, name: name || 'anonymous' })
  }

  /**
   * 注册内置 handlers
   */
  private registerBuiltinHandlers(): void {
    registerBuiltins(this)
  }

  /**
   * 执行指定事件的所有 Hook
   * 支持会话级排队、60s 固定超时、外部中止信号
   */
  async execute(event: HookEvent, context: HookContext, options?: { abortSignal?: AbortSignal }): Promise<HookResult> {
    const convId = context.sessionId || `__event_${event}__`
    const slot = this.getOrCreateSlot(convId)

    // 该会话已有 Hook 在跑 → 入队等待
    if (slot.running) {
      return new Promise<HookResult>((resolve, reject) => {
        slot.queue.push({ event, context, options, resolve, reject })
      })
    }

    return this.runSlot(convId, event, context, options)
  }

  /**
   * 执行一个槽位（带超时 + 可取消）
   */
  private async runSlot(
    convId: string,
    event: HookEvent,
    context: HookContext,
    options?: { abortSignal?: AbortSignal }
  ): Promise<HookResult> {
    const slot = this.conversationSlots.get(convId)!
    slot.running = true

    const abortController = new AbortController()
    slot.abortController = abortController

    // 60s 硬超时
    slot.timeoutId = setTimeout(() => {
      abortController.abort(new Error('Hook execution timed out after 60s'))
    }, HOOK_TIMEOUT_MS)

    // 转发外部中止信号
    if (options?.abortSignal) {
      if (options.abortSignal.aborted) {
        abortController.abort(options.abortSignal.reason)
      } else {
        options.abortSignal.addEventListener('abort', () => abortController.abort((options.abortSignal as AbortSignal).reason), { once: true })
      }
    }

    try {
      return await this.runAllHooks(event, context, abortController.signal)
    } finally {
      clearTimeout(slot.timeoutId)
      this.finishSlot(convId)
    }
  }

  /**
   * 执行事件匹配的所有 Hook（循环遍历逻辑，与原 execute 一致）
   */
  private async runAllHooks(event: HookEvent, context: HookContext, signal: AbortSignal): Promise<HookResult> {
    const hooks = this.getHooksForEvent(event, context)

    if (hooks.length === 0) {
      return { decision: 'allow', allowed: true }
    }

    let combinedResult: HookResult = { decision: 'allow', allowed: true }

    for (const hook of hooks) {
      if (signal.aborted) {
        return { decision: 'allow', allowed: true, error: 'Hook execution cancelled' }
      }

      this.markHookPending(event, hook)
      const result = await this.executeHook(hook, event, context, signal)
      this.notifyResult(event, hook, result)

      // 如果 Hook 阻止操作 — 统一走 decision 语义，allowed 作为兼容
      const decision = result.decision ?? (result.allowed === false ? 'block' : 'allow')
      if (decision === 'block') {
        logger.info(`[Hook] Blocked by hook: ${hook.name || 'unnamed'}`, { event, error: result.error })
        return { ...result, decision: 'block', allowed: false }
      }

      // 合并修改
      if (result.modified) {
        combinedResult.modified = {
          ...combinedResult.modified,
          ...result.modified,
        }
      }

      // 收集警告但不中断
      if ((result as any).warning) {
        (combinedResult as any).warning = (result as any).warning
      }

      // 收集错误但不中断
      if (result.error) {
        combinedResult.error = result.error
      }

      // 收集 output（仅取第一个非空 output）
      if (result.output && !combinedResult.output) {
        combinedResult.output = result.output
      }
    }

    return combinedResult
  }

  /**
   * 清理指定会话的 Hook 槽位（用于外部中止通知）
   */
  cleanupConversation(convId: string): void {
    const slot = this.conversationSlots.get(convId)
    if (!slot) return
    clearTimeout(slot.timeoutId)
    slot.abortController?.abort()
    for (const item of slot.queue) {
      item.reject(new Error('Hook execution cancelled by conversation cleanup'))
    }
    slot.queue.length = 0
    this.conversationSlots.delete(convId)
  }

  /**
   * 注册执行结果监听器（用于 UI 反馈）
   */
  onResult(listener: (event: HookEvent, hookName: string, result: HookResult) => void): void {
    this.resultListeners.push(listener)
  }

  /**
   * 标记 hook 即将执行（用于记录开始时间）
   */
  private markHookPending(event: HookEvent, hook: any): void {
    if (!hook.name) return
    const key = `${event}:${hook.name}`
    this.pendingHooks.set(key, { event, name: hook.name })
  }

  /**
   * 通知所有监听器 hook 执行结果
   *
   * 支持两种运行环境：
   * - 主线程：直接通知注册的 resultListeners（由 setMainWindow 注册）
   * - Worker 线程：通过 parentPort.postMessage 回传给主进程，由 manager.impl.ts
   *   的 createMessageHandler 收到后转发给渲染进程
   */
  private notifyResult(event: HookEvent, hook: any, result: HookResult): void {
    if (!hook.name) return
    this.pendingHooks.delete(`${event}:${hook.name}`)

    if (!isMainThread) {
      // Worker 线程：通过 IPC 回传主进程
      try {
        parentPort?.postMessage({
          type: 'hook_result',
          hookEvent: event,
          hookName: hook.name,
          success: (result.allowed ?? result.decision !== 'block') && !result.error,
          error: result.error || undefined,
        })
      } catch {
        // parentPort 不可用（如测试环境），静默丢弃
      }
      return
    }

    // 主线程：直接通知注册的监听器
    for (const listener of this.resultListeners) {
      listener(event, hook.name, result)
    }
  }

  private getOrCreateSlot(convId: string): ConversationSlot {
    let slot = this.conversationSlots.get(convId)
    if (!slot) {
      slot = { running: false, queue: [] }
      this.conversationSlots.set(convId, slot)
    }
    return slot
  }

  private finishSlot(convId: string): void {
    const slot = this.conversationSlots.get(convId)
    if (!slot) return
    slot.running = false
    slot.abortController = undefined

    // 队列中还有等待的任务 → 继续执行下一个
    if (slot.queue.length > 0) {
      const next = slot.queue.shift()!
      this.runSlot(convId, next.event, next.context, next.options)
        .then(next.resolve)
        .catch(next.reject)
    } else {
      this.conversationSlots.delete(convId)
    }
  }

  /**
   * 执行单个 Hook
   */
  private async executeHook(
    hook: any,  // 使用 any 避免类型冲突
    event: HookEvent,
    context: HookContext,
    signal?: AbortSignal
  ): Promise<HookResult> {
    switch (hook.type) {
      case 'command':
        return this.executeCommand(hook, context, signal)
      case 'function':
        return this.executeFunction(hook, context)
      case 'prompt':
        return this.executePrompt(hook, context)
      case 'http':
        return this.executeHttp(hook, context)
      case 'agent':
        return this.executeAgent(hook, context)
      default:
        return { decision: 'allow', allowed: true }
    }
  }

  /**
   * 执行命令 Hook
   * 
   * Claude Code 规范：
   * - 通过 stdin 传递 JSON 上下文
   * - Exit code: 0=允许, 2=阻止
   * - stdout 可返回修改后的上下文
   */
  private async executeCommand(hook: any, context: HookContext, signal?: AbortSignal): Promise<HookResult> {
    if (!hook.command) {
      return { decision: 'allow', allowed: true, error: 'Command hook missing command' }
    }

    // 构建 Hook 子进程环境变量（Claude Code 兼容）
    // 基础变量对所有 hook 设置（用户 + 插件）
    const hookEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CLAUDE_SESSION_ID: context.sessionId ?? '',
      CLAUDE_PROJECT_DIR: context.cwd || getHclawDir(),
      CLAUDE_CONFIG_DIR: getHclawDir(),
    }

    // 插件特有变量：CLAUDE_PLUGIN_ROOT / HCLAW_PLUGIN_ROOT
    const pluginName = hook.pluginName as string | undefined
    if (pluginName) {
      let pluginRoot = PluginRegistry.getInstance().getPluginPath(pluginName)
      // Fallback：扫描插件目录通过 manifest.name 匹配（PluginRegistry 可能在启动时未就绪）
      if (!pluginRoot) {
        try {
          const pluginsDir = path.join(getHclawDir(), 'plugins')
          const entries = fs.readdirSync(pluginsDir, { withFileTypes: true })
          for (const entry of entries) {
            if (!entry.isDirectory()) continue
            const dirPath = path.join(pluginsDir, entry.name)
            for (const mf of ['plugin.json', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json']) {
              const mfPath = path.join(dirPath, mf)
              if (fs.existsSync(mfPath)) {
                try {
                  const mfData = JSON.parse(fs.readFileSync(mfPath, 'utf-8'))
                  if (mfData.name === pluginName) {
                    pluginRoot = dirPath
                    break
                  }
                } catch { /* skip unparseable manifests */ }
              }
            }
            if (pluginRoot) break
          }
        } catch { /* plugins dir may not exist */ }
      }
      if (pluginRoot) {
        context.pluginRoot = pluginRoot
        hookEnv.CLAUDE_PLUGIN_ROOT = pluginRoot
        hookEnv.HCLAW_PLUGIN_ROOT = pluginRoot
        logger.debug(`[Hook] plugin root for "${pluginName}": ${pluginRoot}`)
      } else {
        logger.warn(`[Hook] plugin "${pluginName}" not found, hook may fail`)
      }
    }

    try {
      // 替换变量
      let command = this.substituteVariables(hook.command, context)
      
      // 对于需要 stdin 传递上下文的命令，将 JSON 注入到 stdin
      // 检测命令是否需要 JSON 输入（包含占位符或 heredoc）
      const needsJsonInput = command.includes('${HOOK_JSON_INPUT}') || command.includes('<<HOOK_JSON')
      
      let stdinData: string | undefined
      let jsonTmpFilePath: string | undefined
      if (needsJsonInput) {
        stdinData = JSON.stringify({
          event,
          sessionId: context.sessionId,
          toolName: context.toolName,
          args: context.args,
          result: context.result,
          error: context.error,
          prompt: context.prompt,
          pluginRoot: context.pluginRoot,
          cwd: context.cwd,
          filePath: context.filePath,
        })
        // ⚠️ 直接替换 ${HOOK_JSON_INPUT} 为 JSON 字符串会破坏 shell 引号
        // （尤其是 JSON 含大量双引号，嵌入 shell "..." 内导致引号边界错乱）
        // 改为：将 JSON 写入临时文件，用 shell 特定语法读取文件内容替换占位符
        if (command.includes('${HOOK_JSON_INPUT}')) {
          const tmpJsonDir = path.join(os.tmpdir(), 'hclaw-hooks')
          fs.mkdirSync(tmpJsonDir, { recursive: true })
          jsonTmpFilePath = path.join(tmpJsonDir, `hook-input-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`)
          fs.writeFileSync(jsonTmpFilePath, stdinData, 'utf-8')
          // 标记清理
          ;(hook as any).__tmpJsonFile = jsonTmpFilePath

          const inputShell = hook.shell || ''
          if (inputShell === 'powershell') {
            // PowerShell: (Get-Content "path" -Raw) 返回文件内容作为字符串参数
            command = command.replace(/\$\{HOOK_JSON_INPUT\}/g, `(Get-Content "${jsonTmpFilePath}" -Raw)`)
          } else {
            // cmd.exe / bash: 直接传文件路径（子命令需自行读取）
            command = command.replace(/\$\{HOOK_JSON_INPUT\}/g, `"${jsonTmpFilePath}"`)
          }
        }
      }

        // 处理 ${HCLAW_LAST_LOOP_FILE} 变量：将 lastMessages 写入临时文件
        const tmpFile = this.resolveLastLoopFile(context)
        if (tmpFile) {
            command = command.replace(/\$\{HCLAW_LAST_LOOP_FILE\}/g, tmpFile)
            ;(hook as any).__tmpFile = tmpFile
        }

      const timeout = hook.timeout ?? 30000
      const shell = this.resolveShell(hook.shell)

      let stdout = ''
      let stderr = ''
      let exitCode = 0

      if (stdinData) {
        // 使用 spawn 支持 stdin
        stdout = await this.execWithStdin(command, stdinData, timeout, shell, signal, hookEnv)
      } else {
        const result = await execAsync(command, {
          timeout, shell, signal, env: hookEnv,
        })
        stdout = result.stdout
        stderr = result.stderr
        exitCode = (result as any).code ?? 0
      }

        logger.debug(`${hook.name || 'unnamed'} exit=${exitCode}`)

      // Exit code 语义处理
      if (exitCode === EXIT_CODE_BLOCK) {
        return { 
          decision: 'block',
          allowed: false, 
          error: stderr || 'Blocked by hook' 
        }
      }

      if (exitCode === EXIT_CODE_WARN) {
        return { 
          decision: 'allow',
          allowed: true, 
          warning: stdout || stderr,
          error: stderr 
        }
      }

      // captureOutput 模式：将 stdout 作为 output 返回（不尝试解析 JSON）
      if (hook.captureOutput) {
          return { decision: 'allow', allowed: true, output: stdout || undefined }
      }

      // 尝试解析 stdout 中的 JSON 输出
      if (stdout && stdout.trim()) {
        try {
          const jsonOutput = JSON.parse(stdout.trim())
          
          // 解析 Claude Code 规范的 hookSpecificOutput
          if (jsonOutput.hookSpecificOutput) {
            return this.parseHookSpecificOutput(jsonOutput.hookSpecificOutput)
          }
          
          // 解析顶级 decision 结构
          if (jsonOutput.decision) {
            const result: HookResult = { decision: jsonOutput.decision, allowed: jsonOutput.decision !== 'block' }
            if (jsonOutput.reason) result.reason = jsonOutput.reason
            if (jsonOutput.additionalContext) result.additionalContext = jsonOutput.additionalContext
            if (jsonOutput.sessionTitle) result.sessionTitle = jsonOutput.sessionTitle
            return result
          }
          
          // 兼容旧版 modified 格式
          return { decision: 'allow', allowed: true, modified: jsonOutput }
        } catch {
          // 不是 JSON，正常返回
        }
      }

      if (exitCode !== 0) {
        const stderrSummary = (stderr?.trim() ? `\nstderr:\n${stderr.trim().slice(0, 1000)}` : '')
        const stdoutSummary = (stdout?.trim() && !stderr?.trim() ? `\nstdout:\n${stdout.trim().slice(0, 1000)}` : '')
        const detail = stderrSummary || stdoutSummary || `exit=${exitCode}`
        logger.error(`[Hook] ${hook.name || 'unnamed'} exit=${exitCode}:${detail.slice(0, 1500)}`)
      } else {
        logger.info(`[Hook] ${hook.name || 'unnamed'} succeeded`)
      }

      // 非零退出码时，组合 stdout + stderr 作为错误信息
      if (exitCode !== 0) {
        const parts: string[] = [`exit code: ${exitCode}`]
        if (stderr?.trim()) parts.push(`stderr:\n${stderr.trim().slice(0, 2000)}`)
        if (stdout?.trim() && !stderr?.trim()) parts.push(`stdout:\n${stdout.trim().slice(0, 2000)}`)
        return { decision: 'allow', allowed: true, error: parts.join('\n') }
      }

      return { decision: 'allow', allowed: true }
    } catch (error: any) {
      const exitCode = error.code ?? 1
      const errorMessage = error.message || String(error)
      const errorStderr = (error as any).stderr?.trim?.() || ''
      const errorStdout = (error as any).stdout?.trim?.() || ''

      const parts: string[] = [`exit code: ${exitCode}`]
      if (errorStderr) parts.push(`stderr:\n${errorStderr.slice(0, 2000)}`)
      if (errorStdout && !errorStderr) parts.push(`stdout:\n${errorStdout.slice(0, 2000)}`)
      const richError = parts.join('\n')

      logger.error(`[Hook] ${hook.name || 'unnamed'} threw:`, { exitCode, stderr: errorStderr.slice(0, 1000), stdout: errorStdout.slice(0, 500), message: errorMessage.slice(0, 200) })

      if (exitCode === EXIT_CODE_BLOCK) {
        return { decision: 'block', allowed: false, error: richError }
      }

      return { decision: 'allow', allowed: true, error: richError }
    } finally {
      this.removeTempFile((hook as any).__tmpFile)
      this.removeTempFile((hook as any).__tmpJsonFile)
    }
  }

  /**
   * 使用 stdin 执行命令（支持 AbortSignal 中止）
   */
  private execWithStdin(command: string, stdin: string, timeout: number, shell: string, signal?: AbortSignal, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = exec(command, { timeout, shell, signal, ...(env ? { env } : {}) }, (error, stdout, _stderr) => {
        if (error && (error as any).code !== EXIT_CODE_BLOCK) {
          // 检查是否是阻止错误
          if ((error as any).code === EXIT_CODE_BLOCK) {
            resolve('')
          } else {
            reject(error)
          }
        } else {
          resolve(stdout)
        }
      })
      child.stdin?.write(stdin)
      child.stdin?.end()
    })
  }

  /**
   * 执行 Function Hook
   * 直接调用 JavaScript 函数
   */
  private async executeFunction(hook: any, context: HookContext): Promise<HookResult> {
    // 优先使用 hook.config 中的 handler
    if (hook.handler) {
      try {
        const timeout = hook.timeout ?? 30000
        const result = await Promise.race([
          Promise.resolve(hook.handler(context)),
          new Promise<never>((_, reject) => 
            setTimeout(() => reject(new Error(`Hook timeout (${timeout}ms)`)), timeout)
          )
        ])
        return result
      } catch (error: any) {
        return { decision: 'allow', allowed: true, error: error.message }
      }
    }

    // 尝试从内置 handlers 获取
    const builtinId = (hook as any).builtinId
    if (builtinId && this.builtinHandlers.has(builtinId)) {
      try {
        return await this.builtinHandlers.get(builtinId)!(context)
      } catch (error: any) {
        return { decision: 'allow', allowed: true, error: error.message }
      }
    }

    return { decision: 'allow', allowed: true }
  }

  /**
   * 执行 Prompt Hook
   */
  private async executePrompt(hook: any, context: HookContext): Promise<HookResult> {
    if (!hook.prompt) {
      return { decision: 'allow', allowed: true }
    }

    return {
      decision: 'allow',
      allowed: true,
      modified: {
        prompt: hook.prompt,
        context: { ...context },
      },
    }
  }

  /**
   * 执行 HTTP Hook
   */
  private async executeHttp(hook: any, context: HookContext): Promise<HookResult> {
    if (!hook.url) {
      return { decision: 'allow', allowed: true, error: 'HTTP hook missing url' }
    }

    try {
      const url = this.substituteVariables(hook.url, context)
      const body = hook.body ? this.substituteVariables(hook.body, context) : undefined

      const response = await fetch(url, {
        method: hook.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...hook.headers,
        },
        body: body ? JSON.stringify({ ...context, body }) : JSON.stringify(context),
      })

      if (!response.ok) {
        return { decision: 'allow', allowed: true, error: `HTTP ${response.status}: ${response.statusText}` }
      }

      return { decision: 'allow', allowed: true }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      return { decision: 'allow', allowed: true, error: errorMessage }
    }
  }

  /**
   * 执行 Agent Hook
   *
   * 通过子 Agent 执行钩子逻辑，使用 hook.agentPrompt 作为任务描述，
   * hook.agentType 指定 Agent 类型（如 'general'、'code-reviewer'）。
   * 子 Agent 的输出会尝试解析为 HookResult（支持 decision、additionalContext 等标准字段）。
   */
  private async executeAgent(hook: any, context: HookContext): Promise<HookResult> {
    if (!hook.agentPrompt) {
      return { decision: 'allow', allowed: true }
    }

    this.hookDepth++
    try {
      if (this.hookDepth > this.MAX_HOOK_DEPTH) {
        logger.warn(`[Hook] Agent hook recursion limit (depth=${this.hookDepth})`)
        return { decision: 'allow', allowed: true, warning: 'Agent hook recursion limit reached' }
      }

      const { subAgentScheduler } = await import('../../agent/subagent')
      const { RuntimeConfigManager } = await import('../../agent/runtimeConfigManager')

      const workingDir = RuntimeConfigManager.getWorkingDir() || context.cwd || process.cwd()
      const settings = RuntimeConfigManager.getSettings() || undefined
      const primaryInfo = RuntimeConfigManager.getRoleProvider('primary')

      const modelConfig = primaryInfo.isValid && primaryInfo.provider
        ? {
            provider: primaryInfo.provider.type,
            model: primaryInfo.modelId || '',
            apiKey: primaryInfo.provider.apiKey || '',
            baseUrl: primaryInfo.provider.baseUrl,
          }
        : {
            provider: 'anthropic' as const,
            model: 'claude-sonnet-4-20250514',
            apiKey: '',
          }

      const task = {
        id: `hook-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: hook.agentPrompt,
        context: JSON.stringify({
          event: context.event,
          sessionId: context.sessionId,
          toolName: context.toolName,
          args: context.args,
          result: context.result,
          error: context.error,
          prompt: context.prompt,
          cwd: context.cwd,
          filePath: context.filePath,
        }),
        agentType: hook.agentType || 'General',
        timeout: (hook.timeout ?? 120) * 1000,
      }

      const generator = subAgentScheduler.executeTask({
        task,
        modelConfig,
        workingDir,
        settings,
      })

      let output = ''
      for await (const event of generator) {
        if (event.type === 'subagent_progress' && event.event.type === 'text') {
          output += event.event.content || ''
        }
        if (event.type === 'subagent_done') {
          if (event.result.output) {
            output = event.result.output
          }
          break
        }
      }

      // 尝试解析 JSON 格式的输出
      if (output.trim()) {
        try {
          const parsed = JSON.parse(output.trim())
          return this.parseHookSpecificOutput(parsed)
        } catch {
          // 不是 JSON，作为 additionalContext 返回
        }
        return { decision: 'allow', allowed: true, additionalContext: output.trim() }
      }

      return { decision: 'allow', allowed: true }
    } catch (error: any) {
      logger.error('[Hook] Agent hook failed', { error: error.message })
      return { decision: 'allow', allowed: true, error: error.message }
    } finally {
      this.hookDepth--
    }
  }

  /**
   * 获取事件对应的所有 Hook
   *
   * JSON config (hooks.json) 是运行时唯一的事实来源：
   * - plugin 和 user 所有类型的 hook 统一从 JSON 读取
   * - enabled 和 config 均以 JSON 中保存的值为准
   * - PluginRegistry 仅在首次安装时写入 JSON，运行时不读
   */
  private getHooksForEvent(event: HookEvent, context: HookContext): any[] {
    const eventHooks: any[] = []

    // 从 JSON 配置获取所有 hooks（包括 plugin 和 user）
    try {
        const dbHooks = readHookConfig()
      for (const hook of dbHooks) {
        // 检查事件匹配
        const events = Array.isArray(hook.events) ? hook.events : [hook.events]
        if (!events.includes(event)) continue

        // 检查 enabled
        if (!hook.enabled) continue

        // 检查 matcher
        const matcher = hook.config.matcher as string | undefined
        if (matcher && !this.matchesMatcher(matcher, event, context)) {
          continue
        }

        eventHooks.push({
          ...hook.config,
          name: hook.name,
          pluginName: hook.pluginName,
        })
      }
    } catch (err) {
      logger.error('Failed to fetch hooks from config', { error: String(err) })
    }

    // 添加兼容层事件处理器（旧系统脚本迁移）
    const compatHandlers = this.eventHandlers.get(event)
    if (compatHandlers) {
      for (const ch of compatHandlers) {
        eventHooks.push({
          type: 'function' as const,
          handler: ch.handler,
          name: ch.name,
          source: 'compat',
        })
      }
    }

    return eventHooks
  }

    /**
     * 检查是否匹配 matcher - 委托到 matcher.ts
     *
     * 支持的 matcher 格式：
     * - '*' - 匹配所有
     * - 'Bash' - 精确匹配工具名
     * - 'Edit|Write|MultiEdit' - 正则或操作符匹配
     * - '^file_' - 正则匹配
     */
    matchesMatcher(matcher: string, event: HookEvent, context: HookContext): boolean {
        if (matchesEvent(matcher, event)) return true
        if (context.toolName && matchesTool(matcher, context.toolName)) return true
        if (context.filePath && matchesFile(matcher, context.filePath)) return true
        return false
    }

    /**
     * 将 HookContext 中的 lastMessages 写入临时文件，返回文件路径
     */
    private resolveLastLoopFile(context: HookContext): string | null {
        const lastMessages = (context as any).lastMessages as Array<{ role: string; content: string }> | undefined
        if (!lastMessages?.length) return null

        const tmpDir = path.join(os.tmpdir(), 'hclaw-hooks')
        fs.mkdirSync(tmpDir, {recursive: true})
        const tmpFile = path.join(tmpDir, `last-loop-${context.sessionId || Date.now()}.md`)
        const content = lastMessages
            .map(m => `## ${m.role === 'user' ? '用户' : '助手'}\n\n${m.content}`)
            .join('\n\n---\n\n')
        fs.writeFileSync(tmpFile, `# 本次对话内容\n\n${content}`, 'utf-8')
        return tmpFile
    }

    /**
     * 安全删除临时文件
     */
    private removeTempFile(filePath: string | undefined): void {
        if (!filePath) return
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
        } catch { /* ignore */
        }
    }

  /**
   * 解析 Claude Code 规范的 hookSpecificOutput 结构
   * 
   * 支持的字段：
   * - hookEventName: 事件名称
   * - decision: 'block' | 'allow' | 'continue'
   * - reason: 决策原因
   * - additionalContext: 额外上下文（注入到 Claude）
   * - permissionDecision: 权限决策（PreToolUse）
   * - permissionDecisionReason: 权限决策原因
   * - updatedInput: 更新的输入参数
   * - updatedToolOutput: 更新的工具输出（PostToolUse）
   * - sessionTitle: 会话标题
   * - retry: 是否重试（PermissionDenied）
   * - terminalSequence: 终端通知序列
   */
  private parseHookSpecificOutput(output: any): HookResult {
    const result: HookResult = { decision: 'allow', allowed: true }
    
    // 决策处理
    if (output.decision === 'block') {
      result.allowed = false
      result.decision = 'block'
    } else if (output.decision) {
      result.decision = output.decision
    }
    
    // 阻止原因
    if (output.reason) {
      result.reason = output.reason
      if (!result.allowed) {
        result.error = output.reason
      }
    }
    
    // 额外上下文
    if (output.additionalContext) {
      result.additionalContext = output.additionalContext
    }
    
    // 权限决策（用于 PreToolUse）
    if (output.permissionDecision) {
      result.permissionDecision = output.permissionDecision
      if (output.permissionDecision === 'deny' || output.permissionDecision === 'block') {
        result.allowed = false
        result.decision = 'block'
      }
      if (output.permissionDecisionReason) {
        result.permissionDecisionReason = output.permissionDecisionReason
        if (!result.allowed) {
          result.error = output.permissionDecisionReason
        }
      }
    }
    
    // 更新的输入参数
    if (output.updatedInput) {
      result.updatedInput = output.updatedInput
    }
    
    // 更新的工具输出（PostToolUse）
    if (output.updatedToolOutput) {
      result.updatedToolOutput = output.updatedToolOutput
    }
    
    // 会话标题
    if (output.sessionTitle) {
      result.sessionTitle = output.sessionTitle
    }
    
    // 重试标志（PermissionDenied）
    if (typeof output.retry === 'boolean') {
      result.retry = output.retry
    }
    
    // 终端通知序列
    if (output.terminalSequence) {
      // 终端序列直接通过 output 字段传递
      result.output = output.terminalSequence
    }
    
    return result
  }

  /**
   * 变量替换
   * 支持的变量：
   * - ${HCLAW_SESSION_ID} - 会话 ID
   * - ${HCLAW_PLUGIN_ROOT} - 插件根目录
   * - ${HCLAW_TOOL_NAME} - 工具名称
   * - ${HCLAW_TOOL_ARGS} - 工具参数 (JSON)
   * - ${HCLAW_FILE_PATH} - 文件路径
   * - ${HCLAW_CWD} - 当前工作目录
   * - ${HCLAW_TASK_ID} - 任务 ID
   * - ${HCLAW_TASK_NAME} - 任务名称
   * - ${HCLAW_LAST_LOOP_FILE} - 本次 loop 内容（临时文件路径，用后自动清理）
   * - ${HOOK_JSON_INPUT} - JSON 格式的完整上下文（用于 stdin）
   */
  substituteVariables(input: string, context: HookContext): string {
    let result = input

    // HCLAW 变量
    result = result.replace(/\$\{HCLAW_SESSION_ID\}/g, context.sessionId ?? '')
    result = result.replace(/\$\{HCLAW_PLUGIN_ROOT\}/g, context.pluginRoot ?? '')
    result = result.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, context.pluginRoot ?? '')

    // 工具相关
    result = result.replace(/\$\{HCLAW_TOOL_NAME\}/g, context.toolName ?? '')
    result = result.replace(/\$\{HCLAW_TOOL_ARGS\}/g, JSON.stringify(context.args ?? {}))

    // 文件相关
    result = result.replace(/\$\{HCLAW_FILE_PATH\}/g, context.filePath ?? '')
    result = result.replace(/\$\{HCLAW_CWD\}/g, context.cwd ?? '')

    // 任务相关
    result = result.replace(/\$\{HCLAW_TASK_ID\}/g, context.taskId ?? '')
    result = result.replace(/\$\{HCLAW_TASK_NAME\}/g, context.taskName ?? '')

    return result
  }

  /**
   * 跨平台 Shell 解析
   *
   * Windows: 优先 hook 指定的 powershell，其次 COMSPEC（cmd.exe）
   * macOS:   用 $SHELL 环境变量（用户默认 shell，可能是 zsh/bash），
   *          回退 /bin/bash（macOS 始终可用，zsh/bash 语法基本兼容）
   * Linux:   固定 /bin/bash
   */
  private resolveShell(hookShell?: string): string {
    if (hookShell === 'powershell') return 'powershell.exe'
    if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe'
    if (process.platform === 'darwin') return process.env.SHELL || '/bin/bash'
    return '/bin/bash'
  }

  /**
   * 获取所有注册的 Hook（供 UI 使用）
   */
  getAllHooks(): any[] {
    const allHooks = this.registry.getHooks()
    const result: any[] = []

    for (const [, hooks] of allHooks) {
      result.push(...hooks)
    }

    return result
  }
}

export const hookExecutor = HookExecutor.getInstance()
