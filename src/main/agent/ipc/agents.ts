/**
 * Agent CRUD IPC handlers
 *
 * 处理 Agent 模版的扫描、创建、删除、更新、批量切换等操作
 */

import {ipcMain} from 'electron'
import {findAgentFile, scanAllAgents, updatePluginAgentOverride} from '../agentLoader'
import {getAndClearAgentLoadErrors} from '../agentLoadErrors'
import {agentRegistry} from '../agentRegistry'
import {powerManager} from '../powerManager'
import {updateJsonField, updateMarkdownFrontmatter} from '../utils/frontmatter'
import {logger} from '../logger'
import {getHclawDir} from '../../config'
import type {AgentTemplate} from '@shared/types'
import * as path from 'path'
import * as fs from 'fs/promises'

/**
 * 尝试从 agentRegistry 缓存返回（非强制模式且缓存非空时），否则返回 null
 */
function tryCachedAgents(forceScan?: boolean): {success: true; templates: AgentTemplate[]} | null {
    if (forceScan) return null
    const allTemplates = agentRegistry.getAll()
    // 过滤掉 cmd: 前缀的内部条目（命令注册的伪 Agent），UI 不需要展示
    const templates = allTemplates.filter(a => !a.id.startsWith('cmd:'))
    if (templates.length === 0) return null
    logger.debug('[AgentsScan]', {action: 'from-cache', agentsCount: templates.length})
    return {success: true, templates}
}

export function registerHandlers(): void {
    // 扫描所有 Agent 模版（从磁盘重新扫描，更新本地 + 插件 agents）
    ipcMain.handle('agents:scan', async (_event, forceScan?: boolean) => {
        try {
            // 非强制扫描且缓存可用时直接返回，避免重复扫描卡顿
            const cached = tryCachedAgents(forceScan)
            if (cached) return cached
            // 保存 cmd: 注册条目（命令注册的伪 Agent），rescan 不会加载它们
            const cmdEntries = agentRegistry.getAll().filter(a => a.id.startsWith('cmd:'))
            // 从磁盘重新扫描所有 agents（包括本地和插件）
            const templates = await scanAllAgents()
            const loadErrors = getAndClearAgentLoadErrors()
            // 同步更新 registry，确保其他组件也能获取最新数据
            agentRegistry.clear()
            for (const template of templates) {
                agentRegistry.register(template)
            }
            // 恢复 cmd: 条目（不会出现在返回给 UI 的列表中）
            for (const cmdEntry of cmdEntries) {
                agentRegistry.register(cmdEntry)
            }
            return {success: true, templates, loadErrors}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 创建 Agent（创建 .md 文件到配置目录的 agents/）
    ipcMain.handle('agents:create', async (_event, params: {
        name: string
        description: string
        whenToUse?: string
        systemPrompt: string
        enabled?: boolean
    }) => {
        try {
            const agentsDir = path.join(getHclawDir(), 'agents')

            // 确保 agents 目录存在
            await fs.mkdir(agentsDir, {recursive: true})

            // 重名检查：扫描现有 agent 文件，比对 frontmatter 的 name 字段
            const existingFiles = await fs.readdir(agentsDir)
            for (const file of existingFiles) {
                if (!['.md', '.yaml', '.yml'].includes(path.extname(file).toLowerCase())) continue
                try {
                    const content = await fs.readFile(path.join(agentsDir, file), 'utf-8')
                    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
                    if (fmMatch) {
                        // 简单解析 name 字段
                        const nameMatch = fmMatch[1].match(/^name:\s*(.+)$/m)
                        if (nameMatch && nameMatch[1].trim() === params.name.trim()) {
                            return {success: false, error: `Agent with name "${params.name}" already exists`}
                        }
                    }
                } catch {
                    // 忽略读取错误，继续检查其他文件
                }
            }

            // 生成文件名（基于 name，转小写、替换空格）
            const fileName = params.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') + '.md'
            const filePath = path.join(agentsDir, fileName)

            // 构建 frontmatter 文件内容
            const frontmatterContent = [
                '---',
                `name: ${params.name}`,
                `description: ${params.description || ''}`,
                params.whenToUse ? `when_to_use: ${params.whenToUse}` : null,
                `enabled: ${params.enabled !== false}`,
                '---',
                '',
                params.systemPrompt || '',
            ].filter(line => line !== null).join('\n')

            await fs.writeFile(filePath, frontmatterContent, 'utf-8')

            // 刷新 registry
            await powerManager.refresh()

            const templates = await scanAllAgents()
            return {success: true, templates, filePath}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 删除 Agent（删除配置目录 agents/ 下的 .md 文件）
    ipcMain.handle('agents:delete', async (_event, templateId: string) => {
        try {
            if (!templateId.startsWith('local-')) {
                return {success: false, error: 'Only disk-sourced agents can be deleted'}
            }

            const agentsDir = path.join(getHclawDir(), 'agents')
            const relativePath = templateId.replace('local-', '')

            // 查找文件（尝试多种扩展名）
            const foundFile = await findAgentFile(relativePath, agentsDir)
            if (!foundFile) {
                return {success: false, error: `Agent file not found for: ${templateId}`}
            }

            await fs.rm(foundFile, {force: true})

            // 刷新 registry
            await powerManager.refresh()

            const templates = await scanAllAgents()
            return {success: true, templates}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 更新 Agent（支持 name/description/when_to_use/enabled/systemPrompt）
    ipcMain.handle('agents:update', async (_event, templateId: string, updates: {
        name?: string
        description?: string
        whenToUse?: string
        enabled?: boolean
        systemPrompt?: string
    }) => {
        try {
            // ─── enabled 统一写入 agent_overrides 表（所有 Agent）──
            // 本地 Agent 的 name/description 等非启用字段仍写入文件
            // 插件 Agent 仅支持 enabled 切换（不修改插件文件）
            if (updates.enabled !== undefined) {
                await updatePluginAgentOverride(templateId, updates.enabled)
            }

            // ─── 非 enabled 字段：仅本地 Agent 写文件 ──────────
            const fileUpdates = {...updates}
            delete fileUpdates.enabled

            if (Object.keys(fileUpdates).length > 0) {
                // 查找文件（去除 local- 前缀，与实际文件路径匹配）
                // 注意：delete 和 update-description handler 同样需要去除前缀
                const agentsDir = path.join(getHclawDir(), 'agents')
                const relativePath = templateId.replace(/^local-/, '')
                const foundFile = await findAgentFile(relativePath, agentsDir)
                if (!foundFile) {
                    return {success: false, error: `Agent file not found for: ${templateId}`}
                }

                const content = await fs.readFile(foundFile, 'utf-8')
                const ext = path.extname(foundFile).toLowerCase()

                if (ext === '.md' || ext === '.yaml' || ext === '.yml') {
                    const fields: Array<{key: string; value: string | boolean | number | undefined}> = []
                    if (updates.name !== undefined) fields.push({key: 'name', value: updates.name})
                    if (updates.description !== undefined) fields.push({key: 'description', value: updates.description})
                    if (updates.whenToUse !== undefined) fields.push({key: 'when_to_use', value: updates.whenToUse})

                    let updatedContent = updateMarkdownFrontmatter(content, fields)

                    if (updates.systemPrompt !== undefined) {
                        const fmMatch = updatedContent.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
                        if (fmMatch) {
                            const bodyStart = fmMatch[0].length
                            updatedContent = updatedContent.slice(0, bodyStart) + updates.systemPrompt
                        }
                    }

                    await fs.writeFile(foundFile, updatedContent, 'utf-8')
                } else {
                    return {success: false, error: `Unsupported file format: ${ext}`}
                }
            }

            // 刷新 registry
            await powerManager.refresh()

            const templates = await scanAllAgents()
            return {success: true, templates}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 批量切换 Agent 启用状态（一次刷新，避免 N 次独立 toggle）
    ipcMain.handle('agents:toggle-batch', async (_event, params: {templateIds: string[]; enabled: boolean}) => {
        try {
            for (const id of params.templateIds) {
                await updatePluginAgentOverride(id, params.enabled)
            }

            await powerManager.refresh()
            const templates = await scanAllAgents()
            return {success: true, templates}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 更新 Agent 模版的触发条件（when_to_use）
    ipcMain.handle('agent-template-update-description', async (_event, templateId: string, whenToUse: string) => {
        try {
            if (!templateId.startsWith('local-')) {
                return {success: false, error: 'Only disk-sourced agents can update when_to_use via file'}
            }

            const agentsDir = path.join(getHclawDir(), 'agents')
            const relativePath = templateId.replace('local-', '')

            // 查找文件（尝试多种扩展名）
            const foundFile = await findAgentFile(relativePath, agentsDir)
            if (!foundFile) {
                return {success: false, error: `Agent file not found for: ${templateId}`}
            }

            const content = await fs.readFile(foundFile, 'utf-8')
            const ext = path.extname(foundFile).toLowerCase()
            let updatedContent: string

            if (ext === '.md' || ext === '.yaml' || ext === '.yml') {
                updatedContent = updateMarkdownFrontmatter(content, [
                    {key: 'when_to_use', value: whenToUse || undefined}
                ])
            } else if (ext === '.json') {
                updatedContent = updateJsonField(content, 'whenToUse', whenToUse || undefined)
            } else {
                // 未知格式，回退到 frontmatter 更新
                updatedContent = updateMarkdownFrontmatter(content, [
                    {key: 'when_to_use', value: whenToUse || undefined}
                ])
            }

            await fs.writeFile(foundFile, updatedContent, 'utf-8')

            const templates = await scanAllAgents()
            return {success: true, templates}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })
}
