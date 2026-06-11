/**
 * 工具列表 & MCP 服务器 & 语音转文字 IPC handlers
 */

import {ipcMain} from 'electron'
import {powerManager} from '../powerManager'
import {runtimeConfigManager} from '../runtimeConfigManager'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {resolveModelConfig} from '../model/modelSelector'
import {createModelAdapter} from '../model/index'
import type {ChatMessage} from '../model/types'
import {logger} from '../logger'
import {promisify} from 'util'
import {execFile} from 'child_process'
const execFileAsync = promisify(execFile)
import * as path from 'path'
import * as fs from 'fs/promises'

export function registerHandlers(): void {
    // 工具列表 + MCP 服务器列表（用于测试）
    ipcMain.handle('tool-mcp-list', async () => {
        try {
            // 确保 powerManager 已初始化
            await powerManager.initialize()

            // 获取内置工具定义（包含完整的 inputSchema，用于传递给 LLM）
            const {toolRegistry} = await import('../tools/registry')
            const toolDefinitions = await toolRegistry.getToolDefinitions()

            // 获取 MCP 服务器及其提供的工具列表
            const {mcpService} = await import('../../services/mcpService')
            const runtimeServers = mcpService.list()

            // 只显示已启用且已连接的服务器的工具（只有这些才会传递给 LLM）
            const activeServers = runtimeServers.filter(
                server => server.enabled && server.status === 'connected'
            )

            // 构建 MCP 工具列表（按服务器分组）
            const mcpTools = activeServers.map(server => ({
                serverId: server.id,
                serverName: server.name,
                status: server.status,
                tools: (server.tools || []).map((t: any) => ({
                    name: t.name,
                    description: t.description || '',
                    inputSchema: t.inputSchema || {type: 'object', properties: {}},
                })),
            }))

            return {
                success: true,
                tools: toolDefinitions,
                mcpServers: mcpTools,
            }
        } catch (err: any) {
            const errorMsg = err instanceof Error ? err.message : String(err)
            return {success: false, error: `错误: ${errorMsg || '未知'}`}
        }
    })

    // 语音转文字 IPC（供前端录音按钮使用）
    ipcMain.handle('speech-to-text-convert', async (_event, audioPath: string) => {
        try {
            const absPath = path.resolve(audioPath)
            await fs.access(absPath)

            const scheme = runtimeConfigManager.getScheme()
            const providers = runtimeConfigManager.getProviders()
            const roleConfig = scheme ? getRoleConfig(scheme, 'audio_understanding') : undefined

            if (!roleConfig?.enabled || !roleConfig.endpointId || !roleConfig.modelId) {
                return {success: false, error: '尚未配置音频理解模型，请在 设置 → 模型方案 中配置音频理解角色。'}
            }

            const modelConfig = resolveModelConfig(roleConfig, providers)
            if (!modelConfig) {
                return {success: false, error: '音频理解模型配置无效，请检查模型方案配置。'}
            }

            // 非 WAV 格式需要 ffmpeg 转换
            const ext = path.extname(absPath).toLowerCase()
            let wavPath = absPath

            if (ext !== '.wav') {
                try {
                    await execFileAsync('ffmpeg', ['-version'], {timeout: 5000})
                } catch {
                    return {success: false, error: '非 WAV 格式需要 ffmpeg，请安装 ffmpeg 或直接提供 WAV 格式。'}
                }

                wavPath = absPath + '.converted.wav'
                try {
                    await execFileAsync('ffmpeg', [
                        '-y', '-i', absPath, '-ar', '16000', '-ac', '1', '-sample_fmt', 's16', wavPath,
                    ], {timeout: 60000})
                } catch (ffmpegErr: any) {
                    return {success: false, error: `音频转换失败: ${ffmpegErr.message}`}
                }
            }

            // 读取音频并调用模型（finally 中清理临时转换文件）
            try {
                const audioBase64 = (await fs.readFile(wavPath)).toString('base64')

                const adapter = createModelAdapter(modelConfig)
                const messages: ChatMessage[] = [{
                    role: 'user',
                    content: [
                        {type: 'text', text: '转写这段音频的内容，直接返回文字结果。'},
                        {type: 'input_audio', input_audio: {data: audioBase64, format: 'wav'}},
                    ],
                }]

                const textParts: string[] = []
                const stream = adapter.chat({messages, maxTokens: 4096})
                for await (const chunk of stream) {
                    if (chunk.type === 'text') {
                        textParts.push(chunk.content)
                    }
                    if (chunk.type === 'error') {
                        return {success: false, error: chunk.error?.message || '模型调用失败'}
                    }
                }

                const result = textParts.join('').trim()
                if (!result) {
                    return {success: false, error: '模型返回了空结果，请检查音频是否有效'}
                }

                return {success: true, text: result}
            } finally {
                if (ext !== '.wav') {
                    fs.unlink(wavPath).catch(() => {})
                }
            }
        } catch (err: any) {
            return {success: false, error: `语音转文字失败: ${err.message}`}
        }
    })
}
