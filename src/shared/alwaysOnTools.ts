/**
 * ★ 能力驱动工具（永久常开，豁免 DB 启用开关）— main 与 renderer 共享
 * - analyze_image：可用性由 supportsImageInput 动态决定（多模态隐藏/非多模态保留）
 * - speech_to_text：音频理解唯一通道，恒启用
 * - call_mcp_tool：MCP 调用唯一通道（catalog 通道下 MCP 工具不进 tools 数组，
 *   由目录 + 本调用器承载）——禁用它会让 MCP 目录的调用指引与实际工具集自相矛盾
 * 只豁免 DB 开关层；agent 白名单层语义不变。
 */
export const ALWAYS_ON_TOOLS: ReadonlySet<string> = new Set(['analyze_image', 'speech_to_text', 'call_mcp_tool'])
