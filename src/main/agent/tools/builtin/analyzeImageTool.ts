/**
 * analyze_image 工具 — 调用视觉理解模型分析图片
 *
 * 使用模型方案中独立配置的视觉理解模型（image_understanding 角色）分析图片。
 * 不依赖主模型的视觉能力，主模型可以是纯文本模型。
 * 如果未配置视觉模型，返回明确错误提示。
 */

import {z} from 'zod'
import * as path from 'path'
import * as fs from 'fs/promises'
import type {Tool, ToolContext, ToolResult} from '../types'
import {getRoleConfig} from '@shared/modelSchemeHelpers'
import {isNetworkImageUrl, localImageToBase64} from '../../utils/imageProcessor'
import {runtimeConfigManager} from '../../runtimeConfigManager'
import {resolveModelConfig} from '../../model/modelSelector'
import {createModelAdapter} from '../../model/index'
import type {ChatMessage, ContentPart} from '../../model/types'
import {logger} from '../../logger'

const inputSchema = z.object({
    imagePath: z.string().describe('【必须使用完整路径】图片的完整文件路径（绝对路径，如 /home/user/screenshot.png 或 C:\\Users\\...\\screenshot.png）。不要只传文件名！如果你不确定路径，查看用户消息中 "【图片文件路径】" 标注的完整路径。也支持 data: URI（base64图片数据）或 http/https 网络图片URL。'),
    prompt: z.string().describe('关于图片的问题或指令，描述你想从图片中了解什么'),
})

type Input = z.infer<typeof inputSchema>

export const analyzeImageTool: Tool<Input, string> = {
    name: 'analyze_image',
    description: '分析图片内容（文字、物体、场景等）。注意：imagePath 参数必须传完整路径，仅传文件名找不到文件！优先从用户消息中标注的"【图片文件路径】"处获取完整路径。如果你自身具备视觉理解能力，优先直接处理用户消息中的图片，不需要调用此工具。',
    inputSchema,
    requiredPermissions: [],
    isDestructive: false,

    async execute(args: Input, context: ToolContext): Promise<ToolResult<string>> {
        const {imagePath, prompt} = args

        logger.info('[analyzeImage] 收到请求', {imagePath: imagePath.slice(0, 200), prompt: prompt.slice(0, 100), workingDir: context.workingDir})

        try {
            // ── 1. 判断图片来源：data: URI / 网络 URL / 本地文件 ──
            const isDataUri = imagePath.startsWith('data:')
            const isUrl = !isDataUri && isNetworkImageUrl(imagePath)
            logger.info('[analyzeImage] 来源类型判断', {isDataUri, isUrl})

            let absPath = imagePath
            if (!isUrl && !isDataUri) {
                absPath = path.resolve(context.workingDir, imagePath)
                logger.info('[analyzeImage] 本地路径解析', {absPath, originalPath: imagePath})

                try {
                    await fs.access(absPath)
                    // 文件存在，检查文件大小
                    const stat = await fs.stat(absPath)
                    logger.info('[analyzeImage] 文件存在', {size: stat.size, isFile: stat.isFile()})
                } catch {
                    logger.error('[analyzeImage] 文件不存在', {absPath})
                    return {
                        success: false,
                        output: '',
                        error: `图片文件不存在: ${absPath}`,
                    }
                }
            }

            // ── 2. 获取视觉理解模型配置 ──
            const scheme = runtimeConfigManager.getScheme()
            const providers = runtimeConfigManager.getProviders()
            const roleConfig = scheme ? getRoleConfig(scheme, 'image_understanding') : undefined

            logger.info('[analyzeImage] 视觉模型配置', {
                enabled: roleConfig?.enabled,
                endpointId: roleConfig?.endpointId,
                modelId: roleConfig?.modelId,
                schemeName: scheme?.name,
                providersCount: providers?.length,
            })

            if (!roleConfig?.enabled || !roleConfig.endpointId || !roleConfig.modelId) {
                return {
                    success: false,
                    output: '',
                    error: '尚未配置视觉理解模型',
                }
            }

            // ── 3. 解析为完整的 ModelConfig（含 apiKey、baseUrl 等） ──
            const modelConfig = resolveModelConfig(roleConfig, providers)
            if (!modelConfig) {
                logger.error('[analyzeImage] 模型配置解析失败', {endpointId: roleConfig.endpointId, modelId: roleConfig.modelId})
                return {
                    success: false,
                    output: '',
                    error: '视觉理解模型配置无效：找不到对应的服务商或模型，请在 设置 → 模型方案 中检查图片理解角色的配置',
                }
            }

            logger.info('[analyzeImage] 模型配置解析成功', {
                model: modelConfig.model,
                provider: modelConfig.provider,
                baseUrl: modelConfig.baseUrl?.slice(0, 80),
                hasApiKey: !!modelConfig.apiKey,
            })

            // ── 4. 获取图片数据 ──
            let imageUrl: string

            if (isUrl) {
                // 网络图片 URL：直接传递给模型（适配器会自动处理）
                imageUrl = absPath
                logger.info('[analyzeImage] 使用网络图片URL', {url: imageUrl.slice(0, 150)})
            } else if (isDataUri) {
                // data: URI（base64 数据）：直接使用（来自消息中的 ContentPart[]）
                imageUrl = imagePath
                const dataLen = imageUrl.length
                logger.info('[analyzeImage] 使用data:URI', {length: dataLen, preview: imageUrl.slice(0, 60)})
            } else {
                // 本地图片：读取为 base64 data URL
                try {
                    imageUrl = await localImageToBase64(absPath)
                    logger.info('[analyzeImage] base64转换成功', {
                        dataUrlLength: imageUrl.length,
                        mimeType: imageUrl.split(';')[0]?.replace('data:', ''),
                        imagePath: absPath,
                    })
                } catch (err: any) {
                    logger.error('[analyzeImage] base64转换失败', {error: err.message, stack: err.stack?.slice(0, 300)})
                    return {
                        success: false,
                        output: '',
                        error: `读取图片文件失败: ${err.message}`,
                    }
                }
            }

            // ── 5. 构建多模态消息 ──
            const contentParts: ContentPart[] = [
                {type: 'text', text: prompt},
                {type: 'image_url', image_url: {url: imageUrl}},
            ]

            const messages: ChatMessage[] = [
                {
                    role: 'user',
                    content: contentParts,
                },
            ]

            // ── 6. 创建适配器并调用视觉模型 ──
            const adapter = createModelAdapter(modelConfig)
            logger.info('[analyzeImage] 适配器创建完成，开始调用视觉模型', {adapterType: adapter.constructor?.name})

            const stream = adapter.chat({
                messages,
                maxTokens: 4096,
                abortSignal: context.abortSignal,
            })

            // ── 7. 收集流式响应 ──
            const textParts: string[] = []
            let hasError = false
            for await (const chunk of stream) {
                if (chunk.type === 'text') {
                    textParts.push(chunk.content)
                }
                if (chunk.type === 'error') {
                    hasError = true
                    const errorMsg = chunk.error?.message || '未知错误'
                    logger.error('[analyzeImage] 视觉模型流式错误', {error: errorMsg})
                    return {
                        success: false,
                        output: textParts.join(''),
                        error: `视觉模型调用失败: ${errorMsg}`,
                    }
                }
            }

            if (!hasError) {
                logger.info('[analyzeImage] 视觉模型响应完成', {
                    totalChars: textParts.reduce((s, c) => s + c.length, 0),
                    chunkCount: textParts.length,
                })
            }

            const result = textParts.join('').trim()
            if (!result) {
                logger.warn('[analyzeImage] 视觉模型返回了空结果')
                return {
                    success: false,
                    output: '',
                    error: '视觉模型返回了空结果，请检查图片是否有效',
                }
            }

            logger.info('[analyzeImage] 分析成功', {resultLength: result.length})
            return {success: true, output: `[视觉模型: ${modelConfig.model}]\n\n${result}`}
        } catch (err: any) {
            logger.error('[analyzeImage] 执行异常', {error: err.message, stack: err.stack?.slice(0, 500)})
            return {
                success: false,
                output: '',
                error: `图片分析失败: ${err.message}`,
            }
        }
    },
}
