/**
 * MCP 工具跨线程投影 payload
 *
 * 动机：MCP Worker 与 Agent Worker 之间通过 MessagePort 传递工具清单，
 * 必须裁剪为纯数据（去除引用），否则跨线程结构化克隆会丢字段/抛错。
 * 本文件是该投影的**唯一定义点** —— 此前等价内联类型散落在 mcpWorker.ts、
 * worker.ts、mcpWorkerManager.ts 多处，且 description 可选性不一致，
 * 是「MCP 工具跨线程丢字段」的唯一风险点，收敛后一次单测即可覆盖全部消费方。
 *
 * ── 约束（改动前必读）────────────────────────────────────
 * 1. annotations 结构单点定义在 ./types 的 MCPToolAnnotations，本文件不得重复声明。
 * 2. 只投影白名单字段：多余字段（title / execution / outputSchema / _meta 等）一律裁掉。
 */

import type {MCPToolAnnotations} from './types'

export interface McpToolPayload {
    name: string
    description?: string
    inputSchema: {
        type: 'object'
        properties?: Record<string, unknown>
        required?: string[]
    }
    annotations?: MCPToolAnnotations
}

/** 将 MCP 工具定义裁剪为纯数据 payload（去除引用，用于跨线程传递） */
export function toToolPayload(t: McpToolPayload): McpToolPayload {
    const payload: McpToolPayload = {
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
    }
    if (t.annotations !== undefined
        && (t.annotations.readOnlyHint !== undefined || t.annotations.destructiveHint !== undefined)) {
        // 仅保留只读守卫所需的两个字段，其余标注（title/idempotentHint/...）一律裁掉。
        // 两字段皆 undefined 时不写该键：SDK 的 ToolAnnotations 全字段可选，只声明 title 等的
        // 工具若投影成空壳，会被 writeClassify 判成 write 而误拦（详见 sdkAdapter 同处说明）。
        payload.annotations = {
            readOnlyHint: t.annotations.readOnlyHint,
            destructiveHint: t.annotations.destructiveHint,
        }
    }
    return payload
}
