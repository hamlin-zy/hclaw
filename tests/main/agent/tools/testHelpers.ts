import {z} from 'zod'
import type {Tool, ToolDefinitionForLLM, ToolResult} from '../../../../src/main/agent/tools/types'

/** 构造一个可注册的 Tool 实例（用于 filterToolsForAgent 测试） */
export function makeTool(
    name: string,
    overrides?: Partial<Pick<Tool, 'requiredPermissions' | 'isDestructive'>>,
): Tool {
    return {
        name,
        description: `desc-${name}`,
        inputSchema: z.object({}),
        execute: async (): Promise<ToolResult> => ({success: true, output: ''}),
        ...overrides,
    }
}

/** 构造一个 LLM 工具定义（用于 filterToolsByAgentType / filterTools 测试） */
export function makeToolDefinition(name: string): ToolDefinitionForLLM {
    return {
        name,
        description: `desc-${name}`,
        inputSchema: {type: 'object', properties: {}},
    }
}
