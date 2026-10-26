/**
 * 复合命令切段（权限层共用）
 *
 * 用途：权限判定需要逐段校验，避免 `cd X; Set-Content Y` 这类复合命令
 * 因首段命中安全白名单而整体放行。
 *
 * 切分规则：
 * - 分隔符：`;`、`&&`、`||`、`|`、换行（`\n` / `\r\n`）；单个 `&`（后台执行）
 *   同样视为分隔符，否则 `echo hi & rm x` 会因首段命中白名单被整体放行
 * - 单/双引号内的分隔符不切
 * - `\` 与 PowerShell 反引号 `` ` `` 转义下一个字符
 * - `(` / `$(` 括号深度 > 0 时不切
 * - trim 后过滤空段
 * - 不做变量展开、不做语法校验：未闭合引号等异常输入按单段返回（fail-safe）
 */

/**
 * 切分 shell 复合命令；引号、转义、括号内的分隔符不切。
 *
 * @returns 非空段数组；无有效内容时返回空数组
 */
export function splitCommandSegments(command: string): string[] {
    if (typeof command !== 'string' || command.length === 0) return []

    const segments: string[] = []
    let buffer = ''
    let quote: "'" | '"' | null = null
    let escapeNext = false
    let depth = 0

    const flush = (): void => {
        const trimmed = buffer.trim()
        if (trimmed) segments.push(trimmed)
        buffer = ''
    }

    for (let i = 0; i < command.length; i++) {
        const ch = command[i]!

        // 转义状态：下一个字符原样进入当前段（分隔符失去分隔语义）
        if (escapeNext) {
            buffer += ch
            escapeNext = false
            continue
        }

        // 单引号内：只有单引号能结束，反斜杠不转义
        if (quote === "'") {
            if (ch === "'") quote = null
            buffer += ch
            continue
        }

        // 双引号内：`\` 与反引号转义下一个字符
        if (quote === '"') {
            if (ch === '\\' || ch === '`') {
                buffer += ch
                escapeNext = true
                continue
            }
            if (ch === '"') quote = null
            buffer += ch
            continue
        }

        // 引号外
        if (ch === '\\' || ch === '`') {
            buffer += ch
            escapeNext = true
            continue
        }
        if (ch === "'" || ch === '"') {
            quote = ch
            buffer += ch
            continue
        }
        if (ch === '(') {
            depth++
            buffer += ch
            continue
        }
        if (ch === ')') {
            if (depth > 0) depth--
            buffer += ch
            continue
        }
        if (depth === 0) {
            if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
                flush()
                continue
            }
            if (ch === '&') {
                // `&&` 消费第二个 `&`；单个 `&` 同为分隔符
                if (command[i + 1] === '&') i++
                flush()
                continue
            }
        }
        buffer += ch
    }

    flush()
    return segments
}

/** 写操作指示符（命中任一即视为会写文件） */
const WRITE_INDICATORS: RegExp[] = [
    />/, // 重定向 `>` / `>>`（含 `2>` 等）
    /\bSet-Content\b/i,
    /\bOut-File\b/i,
    /\bAdd-Content\b/i,
    /(?:^|[\s|;&])tee(?:[\s|;&]|$)/i,
    /\bsed\s+(?:-[a-zA-Z]*i\b|--in-place)/i,
    /\bWriteAllText\b/i,
    /\bwriteFileSync\b/i,
]

/**
 * 段是否含写文件指示符：
 * 重定向 > / >>、Set-Content、Out-File、Add-Content、tee、sed -i、WriteAllText、writeFileSync
 */
export function isWriteSegment(segment: string): boolean {
    if (!segment) return false
    return WRITE_INDICATORS.some(pattern => pattern.test(segment))
}
