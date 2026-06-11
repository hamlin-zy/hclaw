/**
 * 参数类型转换器
 *
 * 在 LLM 输出传递给 MCP Server 或工具执行器前，根据 JSON Schema 自动修正参数类型。
 * 解决 LLM 输出类型漂移问题（如将 boolean 输出为 string "true"）。
 *
 * 支持递归处理嵌套对象和数组。
 */

import type {ToolDefinitionForLLM} from './types'

export interface CoercionResult {
    success: boolean
    params: Record<string, unknown>
    warnings: string[]
}

/**
 * 递归类型转换：根据 JSON Schema 定义修正值类型
 */
function coerceValue(value: unknown, schema: any, path: string, warnings: string[]): unknown {
    if (value === null || value === undefined) return value

    const expectedType = schema?.type
    if (!expectedType) return value

    // ── 对象类型：递归处理每个属性 ──
    if (expectedType === 'object' && typeof value === 'object' && !Array.isArray(value)) {
        const properties = schema.properties || {}
        const result: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(value)) {
            const propSchema = properties[key]
            if (propSchema) {
                result[key] = coerceValue(val, propSchema, `${path}.${key}`, warnings)
            } else {
                result[key] = val
            }
        }
        return result
    }

    // ── 数组类型：处理每个元素 ──
    if (expectedType === 'array' && Array.isArray(value)) {
        const itemSchema = schema.items
        if (itemSchema) {
            return value.map((item, i) =>
                coerceValue(item, itemSchema, `${path}[${i}]`, warnings)
            )
        }
        return value
    }

    // ── 基本类型转换（仅当值是字符串时） ──
    if (typeof value !== 'string') return value

    // boolean
    if (expectedType === 'boolean') {
        const lower = value.toLowerCase()
        if (lower === 'true') {
            warnings.push(`${path}: 已将字符串 "true" 转换为 boolean true`)
            return true
        }
        if (lower === 'false') {
            warnings.push(`${path}: 已将字符串 "false" 转换为 boolean false`)
            return false
        }
    }

    // number / integer
    if (expectedType === 'number' || expectedType === 'integer') {
        const num = Number(value)
        if (!Number.isNaN(num)) {
            if (expectedType === 'integer' && !Number.isInteger(num)) {
                warnings.push(`${path}: 已将字符串 "${value}" 转换为 number ${num} (schema 期望 integer)`)
            } else {
                warnings.push(`${path}: 已将字符串 "${value}" 转换为 ${expectedType} ${num}`)
            }
            return num
        }
    }

    return value
}

/**
 * 根据工具的 inputSchema 对 LLM 输出的参数进行类型转换
 */
export function coerceToolParams(
    params: Record<string, unknown>,
    toolDef: ToolDefinitionForLLM,
): CoercionResult {
    const warnings: string[] = []
    const properties = toolDef.inputSchema.properties || {}
    const coerced: Record<string, unknown> = {}

    for (const [key, value] of Object.entries(params)) {
        const propSchema = properties[key]
        if (propSchema) {
            coerced[key] = coerceValue(value, propSchema, key, warnings)
        } else {
            coerced[key] = value
        }
    }

    return {success: true, params: coerced, warnings}
}
