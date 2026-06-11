/**
 * WebFetch 工具 — 获取网页内容
 */

import {z} from 'zod'
import https from 'https'
import http from 'http'
import type {Tool, ToolContext, ToolResult} from '../types'

const DEFAULT_MAX_LENGTH = 5000
const MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT = 15000
const USER_AGENT = 'Mozilla/5.0 (compatible; HClaw/1.0)'

const inputSchema = z.object({
    url: z.string().describe('要获取的 URL'),
    maxLength: z.coerce.number().optional().describe(`返回内容的最大字符数，默认 ${DEFAULT_MAX_LENGTH}`),
    timeout: z.coerce.number().optional().describe(`超时时间（毫秒），默认 ${DEFAULT_TIMEOUT}`),
})

type WebFetchInput = z.infer<typeof inputSchema>

export const webFetchTool: Tool<WebFetchInput, string> = {
    name: 'web_fetch',
    description: '获取指定 URL 的内容并返回文本。支持 HTTP/HTTPS。',
    inputSchema,
    requiredPermissions: ['network:fetch'],
    isDestructive: false,

    async execute(args: WebFetchInput, context: ToolContext): Promise<ToolResult<string>> {
        const {url, maxLength = DEFAULT_MAX_LENGTH} = args
        const effectiveTimeout = args.timeout ?? DEFAULT_TIMEOUT

        try {
            const content = await fetchUrl(url, maxLength, effectiveTimeout, context.abortSignal, 0)
            return {success: true, output: content}
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err)
            return {success: false, output: '', error: `Failed to fetch URL: ${message}`}
        }
    },
}

function fetchUrl(url: string, maxLength: number, timeout: number, abortSignal?: AbortSignal, redirectCount = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        if (redirectCount > MAX_REDIRECTS) {
            reject(new Error('Too many redirects'))
            return
        }

        let client: typeof https | typeof http
        let targetUrl: string

        try {
            const parsed = new URL(url)
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                reject(new Error('Only HTTP/HTTPS protocols are supported'))
                return
            }
            client = parsed.protocol === 'https:' ? https : http
            targetUrl = url
        } catch {
            reject(new Error('Invalid URL'))
            return
        }

        const req = client.get(targetUrl, {
            timeout,
            headers: {'User-Agent': USER_AGENT},
        }, (res) => {
            if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                fetchUrl(res.headers.location, maxLength, timeout, abortSignal, redirectCount + 1)
                    .then(resolve)
                    .catch(reject)
                return
            }

            const chunks: Buffer[] = []
            let bytesAccumulated = 0

            res.on('data', (chunk: Buffer) => {
                chunks.push(chunk)
                bytesAccumulated += chunk.length

                if (maxLength && bytesAccumulated > maxLength * 2) {
                    req.destroy()
                    const raw = Buffer.concat(chunks).toString('utf8')
                    const stripped = stripHtml(raw, maxLength)
                    resolve(stripped + '\n... (truncated)')
                }
            })

            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString('utf8')
                const stripped = stripHtml(raw, maxLength)
                resolve(stripped)
            })

            res.on('error', reject)
        })

        req.on('error', reject)
        req.on('timeout', () => {
            req.destroy()
            reject(new Error('Request timeout'))
        })

        if (abortSignal) {
            const onAbort = () => {
                req.destroy()
                reject(new Error('Aborted'))
            }
            abortSignal.addEventListener('abort', onAbort, {once: true})
        }
    })
}

function stripHtml(html: string, maxLength: number): string {
    let text = html
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim()

    if (text.length > maxLength) {
        text = text.slice(0, maxLength)
    }

    return text
}
