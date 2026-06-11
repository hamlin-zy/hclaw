/**
 * Hook 加载器（兼容层）
 *
 * 从文件系统加载用户自定义 Hook 脚本，通过兼容层注册到新系统（HookExecutor）。
 *
 * @deprecated 旧系统 Hook 脚本加载机制。用户应通过新系统的 Hook 管理界面配置。
 *
 * 文件格式示例 (beforeToolCall.audit.js):
 * ```js
 * module.exports = async function(ctx) {
 *   return { action: 'continue' }
 * }
 * ```
 *
 * 事件名映射：
 *   beforeThink    → ThinkStart
 *   afterThink     → ThinkEnd
 *   beforeToolCall → PreToolUse
 *   afterToolCall  → PostToolUse
 *   beforeResponse → Stop
 *   afterResponse  → Stop
 *   onError        → PostToolUseFailure
 *   onInterrupt    → Stop
 */

import * as fs from 'fs'
import * as path from 'path'
import {pathToFileURL} from 'url'
import {getHclawDir} from '../../config'
import {logMigrationNotice, registerLegacyScript} from '../../plugin/hooks/compat'
import {createLogger} from '../logger'

const logger = createLogger('hooks-loader')

const VALID_EVENTS = new Set([
  'beforeThink', 'afterThink',
  'beforeToolCall', 'afterToolCall',
  'beforeResponse', 'afterResponse',
  'onError', 'onInterrupt',
])

export async function loadHooksFromDirectory(hooksDir?: string): Promise<number> {
  const dir = hooksDir || getDefaultHooksDir()

  if (!fs.existsSync(dir)) {
    return 0
  }

  let loaded = 0

  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.js'))) {
    const hookDef = parseHookFilename(file)
    if (!hookDef) continue

    try {
      const handler = await loadScriptHandler(dir, file)
      if (registerLegacyScript(hookDef.event, handler, hookDef.name)) {
        loaded++
      }
    } catch (err: any) {
      logger.warn('[Loader] Failed to load hook script', { file, error: err.message })
    }
  }

  if (loaded > 0) {
    logMigrationNotice(loaded)
  }

  return loaded
}

/** 解析文件名 → { event, name } */
function parseHookFilename(filename: string): { event: string; name: string } | null {
  // 去掉 .js 后缀
  const base = filename.replace(/\.js$/, '')
  const parts = base.split('.')

  if (parts.length < 2) return null

  const event = parts[0]
  if (!VALID_EVENTS.has(event)) return null

  const name = parts.slice(1).join('_')
  return { event, name }
}

async function loadScriptHandler(dir: string, file: string): Promise<(ctx: any) => Promise<any>> {
  const fileUrl = pathToFileURL(path.join(dir, file)).href
  const mod = await import(fileUrl)
  const handler = mod.default || mod

  if (typeof handler !== 'function') {
    throw new Error(`Script does not export a function: ${file}`)
  }

  return handler
}

/** 获取默认 hooks 目录 */
function getDefaultHooksDir(): string {
    return path.join(getHclawDir(), 'hooks')
}
