// src/main/utils/opencodeHeaders.ts
/**
 * OpenCode Go 合规请求头注入（https://opencode.ai/docs/zh-cn/go）
 *
 * 要求：
 * 1. 不产生滥用流量 —— 由 agent loop 现有串行节奏 + 重试退避保证，不在本模块处理
 * 2. 明确标识自身 —— User-Agent: HClaw/<版本>
 * 3. x-opencode-session —— 会话级稳定 ID，供服务端提示词缓存命中（直接降低缓存 token 成本）
 *
 * 注入条件：仅当请求目标为 opencode.ai 域名时附加，避免向第三方 API 泄露内部头。
 */
import {randomUUID} from 'crypto'
import {workerData} from 'worker_threads'

const OPENCODE_HOST_SUFFIX = 'opencode.ai'

/** 进程级回退 session ID（无会话上下文的请求复用，进程生命周期内稳定） */
const PROCESS_SESSION_ID = randomUUID()

/** HClaw 版本（惰性缓存）：Worker 内 electron 暴露面有限，防御式 require */
let cachedVersion: string | null = null
export function hclawVersion(): string {
    if (cachedVersion) return cachedVersion
    let version: string | null = null
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- electron 需防御式 require
        version = require('electron')?.app?.getVersion?.() ?? null
    } catch {
        // 主线程外 electron 不可用，走下方 workerData 回退
    }
    // Worker 线程或测试环境：优先复用主进程下发的版本（若有），否则保持 dev
    version ??= (workerData as {params?: {hclawVersion?: string}} | undefined)?.params?.hclawVersion ?? 'dev'
    cachedVersion = version
    return version
}

function isOpencodeUrl(url: string): boolean {
    try {
        const hostname = new URL(url).hostname.toLowerCase()
        return hostname === OPENCODE_HOST_SUFFIX || hostname.endsWith(`.${OPENCODE_HOST_SUFFIX}`)
    } catch {
        return false
    }
}

/**
 * 向 init 注入 OpenCode 合规头，返回（可能新建的）init。
 * 非_opencode.ai 域名原样返回，不做任何修改。
 *
 * @param sessionId 会话级稳定 ID（通常取 trace ctx.conversationId 加 hclaw- 前缀）
 */
export function withOpenCodeHeaders(
    input: string | URL | Request,
    init: RequestInit | undefined,
    sessionId?: string,
): RequestInit {
    const url = typeof input === 'string'
        ? input
        : input instanceof URL ? input.href : input.url
    if (!isOpencodeUrl(url)) return init ?? {}

    const headers = new Headers(init?.headers)
    // 无条件覆盖：SDK（OpenAI/Anthropic 等）会自带 User-Agent，
    // 必须替换为 HClaw 标识才能满足「明确标识自身」要求
    headers.set('User-Agent', `HClaw/${hclawVersion()}`)
    headers.set('x-opencode-session', sessionId ?? PROCESS_SESSION_ID)
    return {...(init ?? {}), headers}
}
