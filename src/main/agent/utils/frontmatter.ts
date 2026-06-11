/**
 * YAML Frontmatter 读写工具
 *
 * 用于可靠地更新 Markdown/YAML 文件中的 frontmatter 字段，
 * 比直接正则替换更安全、可维护。
 */

export interface FrontmatterUpdate {
    key: string
    value: string | boolean | number | undefined  // undefined 表示删除该字段
}

/**
 * 转义 YAML 双引号字符串值中的特殊字符
 * YAML 双引号字符串中需要转义: " \ 以及控制字符
 */
function escapeYamlValue(value: string): string {
    return value
        .replace(/\\/g, '\\\\')   // 反斜杠必须先转义
        .replace(/"/g, '\\"')     // 双引号
        .replace(/\n/g, '\\n')    // 换行符
        .replace(/\r/g, '\\r')    // 回车符
        .replace(/\t/g, '\\t')    // 制表符
}

/**
 * 将 YAML 值格式化为字符串
 * - boolean: 输出为 "true" 或 "false"（不带引号，YAML原生布尔值）
 * - number: 输出为数字字符串（不带引号）
 * - string: 包裹双引号并转义
 */
function formatYamlValue(value: string | boolean | number): string {
    if (typeof value === 'boolean') {
        return value ? 'true' : 'false'
    }
    if (typeof value === 'number') {
        return String(value)
    }
    return `"${escapeYamlValue(value)}"`
}

/**
 * 更新 Markdown/YAML 文件中的 YAML frontmatter 字段
 *
 * 支持：
 * - 更新已有字段
 * - 删除字段（value 为 undefined）
 * - 在 description 后插入新字段
 * - 在 frontmatter 末尾追加新字段
 *
 * @param content 原始文件内容
 * @param updates 要更新的字段列表
 * @returns 更新后的内容，如果没有 frontmatter 则返回原内容
 */
export function updateMarkdownFrontmatter(
    content: string,
    updates: FrontmatterUpdate[]
): string {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return content

    let frontmatter = match[1]

    for (const {key, value} of updates) {
        const keyRegex = new RegExp(`^(${key}:\\s*).+$`, 'm')

        if (keyRegex.test(frontmatter)) {
            // 字段已存在
            if (value !== undefined) {
                // 更新值
                frontmatter = frontmatter.replace(
                    keyRegex,
                    `$1${formatYamlValue(value)}`
                )
            } else {
                // 删除字段（包括后面的换行）
                frontmatter = frontmatter.replace(
                    new RegExp(`^${key}:.*\\r?\\n?`, 'm'),
                    ''
                )
            }
        } else if (value !== undefined) {
            // 字段不存在，需要添加
            // 优先在 description 字段后插入
            const descMatch = frontmatter.match(/^(description:\s*.+)$/m)
            if (descMatch) {
                frontmatter = frontmatter.replace(
                    /^(description:\s*.+)$/m,
                    `$1\n${key}: ${formatYamlValue(value)}`
                )
            } else {
                // 在 frontmatter 末尾追加
                frontmatter += `\n${key}: ${formatYamlValue(value)}`
            }
        }
    }

    return content.replace(match[0], `---\n${frontmatter}\n---`)
}

/**
 * 更新 JSON 对象中的指定字段
 *
 * @param content 原始 JSON 字符串
 * @param key 字段名
 * @param value 新值（undefined 表示删除）
 * @returns 更新后的 JSON 字符串
 */
export function updateJsonField(
    content: string,
    key: string,
    value: string | undefined
): string {
    const parsed = JSON.parse(content)
    if (value !== undefined) {
        parsed[key] = value
    } else {
        delete parsed[key]
    }
    return JSON.stringify(parsed, null, 2)
}
