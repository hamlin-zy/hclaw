/** workspace 基名（跨平台：兼容 \ 与 /）；空串/全部为分隔符时回退为原串 */
export const basename = (ws: string): string => ws.split(/[\\/]/).filter(Boolean).pop() || ws
