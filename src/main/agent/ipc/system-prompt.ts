/**
 * 系统提示词构建 IPC handlers
 *
 * 提供系统提示词构建功能（用于测试和预览）
 */

import {ipcMain} from 'electron'
import {powerManager} from '../powerManager'
import {permissionEngine} from '../tools/permission'
import {promptResolver} from '../prompts/resolver'

/** 获取工作目录（从配置或默认 home） */
async function getWorkingDir(): Promise<string> {
    const os = await import('os')
    try {
        const {configPath} = await import('../../config')
        const fsPromises = await import('fs/promises')
        const configFile = configPath('config')
        const configData = await fsPromises.readFile(configFile, 'utf-8').catch(() => null)
        if (configData) {
            const config = JSON.parse(configData)
            if (config.defaultWorkspace) return config.defaultWorkspace
        }
    } catch { /* fallback to homedir */ }
    return os.homedir()
}

/** 获取提示词构建所需的公共上下文（工具、权限、能力、工作目录） */
async function getPromptBuildCtx() {
    await powerManager.initialize()
    const [{toolRegistry}, {buildSystemPrompt}] = await Promise.all([
        import('../tools/registry'),
        import('../systemPrompt'),
    ])
    const [tools, permissionMode, power, workingDir] = await Promise.all([
        toolRegistry.getToolDefinitions(),
        permissionEngine.getMode(),
        powerManager.getAllEanbelPower(),
        getWorkingDir(),
    ])
    return {tools, permissionMode, agentTemplates: power.agents, workingDir, buildSystemPrompt}
}

export function registerHandlers(): void {
    // 系统提示词构建（用于测试）
    ipcMain.handle('system-prompt-build', async () => {
        try {
            // 加载激活的提示词方案（从 SQLite），无方案时使用代码默认值
            try {
                const {promptSchemeRepo} = await import('../../repositories/sqlite/promptSchemeRepository')
                const activeId = promptSchemeRepo.getActiveId()
                if (activeId) {
                    const scheme = promptSchemeRepo.getById(activeId)
                    if (scheme) promptResolver.loadScheme(scheme)
                }
            } catch { /* 无方案时使用代码默认值 */ }

            const ctx = await getPromptBuildCtx()
            const systemPrompt = await ctx.buildSystemPrompt({
                workingDir: ctx.workingDir,
                tools: ctx.tools,
                permissionMode: ctx.permissionMode,
                agentTemplates: ctx.agentTemplates,
            })
            return {success: true, systemPrompt}
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : ''
            return {success: false, error: `错误: ${errorMsg || '未知'}\n\n堆栈:\n${stack || '无'}`}
        }
    })

    // 系统提示词构建（根据传入的节点，用于预览）
    ipcMain.handle('system-prompt-build-with-scheme', async (_event, nodes: Record<string, string>) => {
        try {
            // 创建临时 PromptResolver 用于预览，不影响全局
            const {PromptResolver} = await import('../prompts/resolver')
            const previewResolver = new PromptResolver()
            if (nodes) {
                previewResolver.loadScheme({
                    id: 'preview',
                    name: '预览',
                    enabled: true,
                    nodes: nodes as any,
                })
            }

            const ctx = await getPromptBuildCtx()
            const systemPrompt = await ctx.buildSystemPrompt({
                workingDir: ctx.workingDir,
                tools: ctx.tools,
                permissionMode: ctx.permissionMode,
                agentTemplates: ctx.agentTemplates,
            }, previewResolver)

            return {success: true, systemPrompt}
        } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            const stack = err instanceof Error ? err.stack : ''
            return {success: false, error: `错误: ${errorMsg || '未知'}\n\n堆栈:\n${stack || '无'}`}
        }
    })
}
