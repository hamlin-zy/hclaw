/**
 * Agent Markdown frontmatter 解析工具
 *
 * 独立于 agentLoader 的纯函数模块（仅依赖 js-yaml），便于单元测试，
 * 避免测试加载 agentLoader 时触发 sqlite/config 初始化。
 */

import yaml from 'js-yaml'

/**
 * 修复未加引号纯量值中的 `: `（冒号+空格）序列，使其能被 js-yaml 正常解析。
 *
 * YAML 规范要求纯量（scalar）值中若含 `: `，必须在值外层加引号，否则 js-yaml 会把该序列
 * 误判为“映射分隔符”，抛出 `bad indentation of a mapping entry`。第三方仓库（如
 * msitarzewski/agency-agents）的 description 常包含 `great DX: intuitive` 这类写法，
 * 导致严格解析失败。这里仅在严格解析失败后触发：对顶层 `key: value` 行，若其值含 `: `
 * 且不是已加引号/流式集合/块标量/列表项，则用 JSON.stringify 安全地加双引号。
 */
export function repairUnquotedColonValues(fmText: string): string {
    return fmText.split('\n').map((line) => {
        const m = line.match(/^(\s*)([A-Za-z0-9_.-]+):\s?(.*)$/)
        if (!m) return line
        const [, indent, key, value] = m
        const v = value.trim()
        // 仅处理含 ": " 且未被显式标注为其他 YAML 结构的纯量值
        if (v.includes(': ') && !/^['"\[{\|>]/.test(v) && !/^- /.test(v)) {
            return `${indent}${key}: ${JSON.stringify(v)}`
        }
        return line
    }).join('\n')
}

/**
 * 解析 Markdown 文件中的 YAML frontmatter。
 *
 * 优先使用严格 js-yaml；若失败（常见于未加引号的 `: ` 序列），
 * 回退到 repairUnquotedColonValues 修复后再解析，第三方仓库的 agent 定义因此能正常加载。
 */
export function parseMarkdownFrontmatter(content: string): {
    frontmatter: Record<string, unknown>
    bodyContent: string
} | null {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
    if (!match) return null

    const bodyContent = match[2].trim()

    try {
        const frontmatter = yaml.load(match[1]) as Record<string, unknown>
        return {frontmatter, bodyContent}
    } catch {
        // 严格解析失败，尝试容错修复
    }

    try {
        const frontmatter = yaml.load(repairUnquotedColonValues(match[1])) as Record<string, unknown>
        return {frontmatter, bodyContent}
    } catch {
        return null
    }
}
