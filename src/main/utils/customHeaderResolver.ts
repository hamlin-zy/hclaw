// src/main/utils/customHeaderResolver.ts
/**
 * 服务商自定义请求头解析器（纯函数，无 IO）
 *
 * value 模式 = 固定前缀（prefix）+ 系统变量（可选）。
 * 首版变量：system.version（应用版本号）、session.id（会话 ID）。
 */
import {randomUUID} from 'crypto'
import type {ProviderCustomHeader} from '@shared/types/model'
import {hclawVersion} from './opencodeHeaders'

/** 进程级回退 session ID（无会话上下文的请求复用，进程生命周期内稳定） */
const PROCESS_SESSION_ID = randomUUID()

/** 请求头变量解析注册表；命中即取值，未命中视为未知变量（跳过该行） */
const VARIABLE_RESOLVERS: Record<string, () => string> = {
    'system.version': () => hclawVersion(),
}

/**
 * 解析自定义请求头为扁平键值对。
 *
 * 规则：
 * - headerName 为空（空白）→ 跳过
 * - 未知 variable（注册表未命中）→ 解析失败，跳过该行
 * - variable 为 undefined → 纯静态值（仅 prefix）
 * - session.id：优先 sessionId 参数，缺失时回退进程级 ID
 *
 * @returns 可直接交给 Headers.set 的键值对
 */
export function resolveCustomHeaders(
    headers: ProviderCustomHeader[] | undefined,
    sessionId?: string,
): Record<string, string> {
    const result: Record<string, string> = {}
    for (const header of headers ?? []) {
        const name = header?.headerName?.trim()
        if (!name) continue

        let value = header.prefix ?? ''
        if (header.variable) {
            let resolved: string | undefined
            if (header.variable === 'session.id') {
                resolved = sessionId ?? PROCESS_SESSION_ID
            } else {
                resolved = VARIABLE_RESOLVERS[header.variable]?.()
            }
            if (resolved === undefined) continue
            value += resolved
        }
        result[name] = value
    }
    return result
}
