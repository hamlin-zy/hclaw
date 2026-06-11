/**
 * speech_to_text 工具 — 调用音频理解模型识别/理解音频内容
 *
 * 使用模型方案中独立配置的音频理解模型（audio_understanding 角色）处理音频。
 * 不依赖主模型的音频能力，主模型可以是纯文本模型。
 * 如果未配置音频理解模型，返回明确错误提示。
 *
 * 支持格式：WAV / MP3 / M4A / FLAC / OGG
 *   - 仅 WAV: 直接读取，无需 ffmpeg
 *   - 其他格式: 需要 ffmpeg 转换为 WAV 16kHz 16bit mono
 */

import {z} from 'zod'
import * as path from 'path'
import * as fs from 'fs/promises'
import * as childProcess from 'child_process'
import {promisify} from 'util'
import type {Tool, ToolContext, ToolResult} from '../types'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {resolveModelConfig} from '../../model/modelSelector'
import {createModelAdapter} from '../../model/index'
import type {ChatMessage, ContentPart} from '../../model/types'

const execFile = promisify(childProcess.execFile)

const inputSchema = z.object({
    audioPath: z.string().describe('【必须使用完整路径】音频文件的完整路径（绝对路径，如 D:\\audio\\speech.wav 或 /home/user/audio.mp3）。支持 WAV / MP3 / M4A / FLAC / OGG 等格式。'),
    prompt: z.string().describe('关于音频的问题或指令，描述你想从音频中了解什么（如"转录这段音频"、"这是什么声音"）'),
})

type Input = z.infer<typeof inputSchema>

/** 清理临时转换文件 */
async function cleanupTempFile(filePath: string | undefined): Promise<void> {
    if (!filePath) return
    try { await fs.unlink(filePath) } catch { /* ignore */ }
}

export const speechToTextTool: Tool<Input, string> = {
    name: 'speech_to_text',
    description: '【语音转文字 ASR】使用独立的音频多模态模型将音频转为文字。自动转换非 WAV 格式（需要 ffmpeg）。注意：audioPath 参数必须传完整路径，仅传文件名找不到文件！优先从用户消息中标注的"【音频文件路径】"处获取完整路径。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: Input, context: ToolContext): Promise<ToolResult<string>> {
        const {audioPath, prompt} = args

        try {
            // ── 1. 验证音频文件存在 ──
            const absPath = path.resolve(context.workingDir, audioPath)
            try {
                await fs.access(absPath)
            } catch {
                return {
                    success: false,
                    output: '',
                    error: `音频文件不存在: ${absPath}`,
                }
            }

            // ── 2. 获取音频理解模型配置 ──
            const scheme = runtimeConfigManager.getScheme()
            const providers = runtimeConfigManager.getProviders()
            const roleConfig = scheme ? getRoleConfig(scheme, 'audio_understanding') : undefined

            if (!roleConfig?.enabled || !roleConfig.endpointId || !roleConfig.modelId) {
                return {
                    success: false,
                    output: '',
                    error: '尚未配置音频理解模型（audio_understanding），请在 设置 → 模型方案 中配置音频理解角色。',
                }
            }

            // ── 3. 解析为完整的 ModelConfig（含 apiKey、baseUrl 等） ──
            const modelConfig = resolveModelConfig(roleConfig, providers)
            if (!modelConfig) {
                return {
                    success: false,
                    output: '',
                    error: '音频理解模型配置无效：找不到对应的服务商或模型，请在 设置 → 模型方案 中检查音频理解角色的配置。',
                }
            }

            // ── 4. 检查 ffmpeg（仅非 WAV 时需要） ──
            const ext = path.extname(absPath).toLowerCase()
            let audioFileForBase64 = absPath
            let needsCleanup = false

            if (ext !== '.wav') {
                try {
                    await execFile('ffmpeg', ['-version'], {timeout: 5000})
                } catch {
                    return {
                        success: false,
                        output: '',
                        error: '非 WAV 格式的音频需要 ffmpeg 转换。请安装 ffmpeg 或直接提供 WAV（16kHz 16bit mono）格式的音频文件。',
                    }
                }

                // 转换为 WAV 16kHz 16bit mono
                audioFileForBase64 = absPath + '.converted.wav'
                try {
                    await execFile('ffmpeg', [
                        '-y',
                        '-i', absPath,
                        '-ar', '16000',
                        '-ac', '1',
                        '-sample_fmt', 's16',
                        audioFileForBase64,
                    ], {timeout: 60000})
                    needsCleanup = true
                } catch (ffmpegErr: any) {
                    return {
                        success: false,
                        output: '',
                        error: `音频格式转换失败 (ffmpeg): ${ffmpegErr.message}`,
                    }
                }
            }

            // ── 5. 编码音频为 base64 ──
            let audioBase64: string
            try {
                audioBase64 = (await fs.readFile(audioFileForBase64)).toString('base64')
            } catch (err: any) {
                await cleanupTempFile(needsCleanup ? audioFileForBase64 : undefined)
                return {
                    success: false,
                    output: '',
                    error: `读取音频文件失败: ${err.message}`,
                }
            }

            // ── 6. 构建多模态消息（OpenRouter / OpenAI 兼容格式） ──
            const contentParts: ContentPart[] = [
                {type: 'text', text: prompt},
                {type: 'input_audio', input_audio: {data: audioBase64, format: 'wav'}},
            ]

            const messages: ChatMessage[] = [
                {
                    role: 'user',
                    content: contentParts,
                },
            ]

            // ── 7. 创建适配器并调用音频理解模型 ──
            const adapter = createModelAdapter(modelConfig)
            const stream = adapter.chat({
                messages,
                maxTokens: 4096,
                abortSignal: context.abortSignal,
            })

            // ── 8. 收集流式响应 ──
            const textParts: string[] = []
            for await (const chunk of stream) {
                if (chunk.type === 'text') {
                    textParts.push(chunk.content)
                }
                if (chunk.type === 'error') {
                    await cleanupTempFile(needsCleanup ? audioFileForBase64 : undefined)
                    const errorMsg = chunk.error?.message || '未知错误'
                    return {
                        success: false,
                        output: textParts.join(''),
                        error: `音频模型调用失败: ${errorMsg}`,
                    }
                }
            }

            // ── 9. 清理临时转换文件 ──
            await cleanupTempFile(needsCleanup ? audioFileForBase64 : undefined)

            const result = textParts.join('').trim()
            if (!result) {
                return {
                    success: false,
                    output: '',
                    error: '音频模型返回了空结果，请检查音频文件是否有效',
                }
            }

            return {success: true, output: `[音频模型: ${modelConfig.model}]\n\n${result}`}
        } catch (err: any) {
            return {
                success: false,
                output: '',
                error: `音频处理失败: ${err.message}`,
            }
        }
    },
}
