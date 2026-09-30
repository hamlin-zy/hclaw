/**
 * mermaid 代码块识别（B 策略）
 *
 * 判定一个 markdown 围栏代码块是否应按 mermaid 图渲染：
 * 1. 语言标注为 `mermaid`（大小写不敏感）→ 是；
 * 2. 有其它语言标注 → 否（交回 Prism 高亮）；
 * 3. 无语言标注：首行（去空白）以已知 mermaid diagram 关键字开头，
 *    且代码块至少两行 → 是。
 *
 * 为什么需要「无标注嗅探」：模型/用户常常直接把 mermaid 源码放进无语言围栏
 * （``` 后直接 `flowchart TB`），只认 `language-mermaid` 会漏掉这类主流写法。
 *
 * 误判有兜底：即便嗅探命中而内容并非合法 mermaid，MermaidBlock 渲染失败会降级
 * 回普通代码块，因此这里宁可放宽首行匹配，也不引入更重的语法校验。
 */

/**
 * mermaid 全部 diagram 起始关键字（小写，用于大小写不敏感匹配）。
 *
 * 覆盖官方常见图类型；`-v2` / `-beta` 等后缀由词边界自动涵盖（如 `stateDiagram-v2`
 * 命中 `statediagram` 前缀后即遇 `-` 边界）。
 */
const MERMAID_DIAGRAM_STARTERS = [
    'flowchart',
    'graph',
    'sequencediagram',
    'classdiagram',
    'statediagram',
    'erdiagram',
    'gantt',
    'pie',
    'journey',
    'gitgraph',
    'mindmap',
    'timeline',
    'quadrantchart',
    'sankey',
    'xychart',
    'block',
    'architecture',
    'packet',
    'requirementdiagram',
    'c4context',
    'c4container',
    'c4component',
    'c4dynamic',
    'c4deployment',
    'kanban',
    'treemap',
    'radar',
    'ishikawa',
    'treeview',
    'zenuml',
] as const

/** 首行匹配：关键字后必须紧跟词边界（避免 `flowchartx` 这类前缀误伤）。 */
const MERMAID_STARTER_RE = new RegExp(`^(?:${MERMAID_DIAGRAM_STARTERS.join('|')})\\b`, 'i')

/**
 * 判定代码块是否应走 mermaid 渲染。
 *
 * @param code 代码块原始文本
 * @param lang 语言标注（不含 `language-` 前缀），无标注传 undefined / 空串
 */
export function isMermaidSource(code: string, lang?: string): boolean {
    const normalizedLang = (lang ?? '').trim().toLowerCase()
    if (normalizedLang === 'mermaid') return true
    // 其它语言标注：明确不是 mermaid（如 ```ts 里恰好含 flowchart 字样）
    if (normalizedLang) return false

    if (!code) return false
    // 过滤空白行后至少两行：单行 `graph` / `flowchart TB` 不足以判定，避免误伤
    const lines = code.split(/\r?\n/).filter(line => line.trim().length > 0)
    if (lines.length < 2) return false

    return MERMAID_STARTER_RE.test(lines[0].trim())
}