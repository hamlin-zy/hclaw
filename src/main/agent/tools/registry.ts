/**
 * 工具注册中心
 *
 * 管理所有可用工具的注册、查询、导出定义。
 */

import {logger} from '../logger'
import type {Tool, ToolDefinitionForLLM} from './types'
import {toolToDefinition} from './types'
import {toolRepo, getToolTimeout, type ToolRecord} from '../../repositories/sqlite/toolRepository'

// 延迟导入避免循环依赖
let toolRepoModule: typeof import('../../repositories/sqlite/toolRepository') | null = null
async function getToolRepo() {
    if (!toolRepoModule) {
        toolRepoModule = await import('../../repositories/sqlite/toolRepository')
    }
    return toolRepoModule
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map()

  /** 注册工具 */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
          }
    this.tools.set(tool.name, tool)
  }

  /** 批量注册 */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool)
    }
  }

  /** 获取工具 */
  get(name: string): Tool | undefined {
    return this.tools.get(name)
  }

  /** 获取所有已注册工具 */
  getAll(): Tool[] {
    return Array.from(this.tools.values())
  }

  /** 获取所有工具名 */
  getNames(): string[] {
    return Array.from(this.tools.keys())
  }

  /** 导出给 LLM 的工具定义列表（只包含已启用的工具）
   *
   * 启用状态逻辑：
   * - 数据库中有记录的工具：使用数据库中的 enabled 状态
   * - 数据库中不存在的工具（如 MCP 动态注册的工具）：默认启用
   */
  async getToolDefinitions(): Promise<ToolDefinitionForLLM[]> {
    try {
        const repo = await getToolRepo()
        // 获取所有工具的启用状态记录（id -> enabled，数据库中不存在的为 undefined）
        const toolEnabledMap = repo.toolRepo.getAllToolEnabledMap()
        return this.getAll()
            .filter(tool => {
                const dbEnabled = toolEnabledMap.get(tool.name)
                // 数据库中有记录：使用数据库的 enabled 状态
                if (dbEnabled !== undefined) {
                    return dbEnabled
                }
                // 数据库中不存在：默认启用（MCP 工具等动态注册的工具）
                return true
            })
            .map(toolToDefinition)
    } catch (err) {
        logger.error('[ToolRegistry] getToolDefinitions failed', {error: err})
        // 如果数据库查询失败，返回所有工具
        return this.getAll().map(toolToDefinition)
    }
  }

    /** 获取单个工具的定义（给 LLM 用的 JSON Schema） */
    getToolDefinition(name: string): ToolDefinitionForLLM | undefined {
        const tool = this.tools.get(name)
        if (!tool) return undefined
        return toolToDefinition(tool)
    }

    /** 获取所有已注册且已启用的工具 */
    async getEnabledTools(): Promise<Tool[]> {
        try {
            const repo = await getToolRepo()
            const enabledIds = repo.toolRepo.getEnabledToolIds()
            return this.getAll().filter(tool => enabledIds.has(tool.name))
        } catch (err) {
            logger.error('[ToolRegistry] getEnabledTools failed', {error: err})
            return this.getAll()
        }
    }

  /** 注销工具 */
  unregister(name: string): boolean {
    return this.tools.delete(name)
  }

  /** 检查工具是否已注册 */
  has(name: string): boolean {
    return this.tools.has(name)
  }
}

/** 全局单例 */
export const toolRegistry = new ToolRegistry()

// 注册到 DI 容器
import {container, DI_TOKENS} from '../common/container'
container.register(DI_TOKENS.ToolRegistry, toolRegistry)

// 导出获取方法（用于需要显式获取的场景）
export function getToolRegistry(): ToolRegistry {
    return container.get<ToolRegistry>(DI_TOKENS.ToolRegistry)
}
