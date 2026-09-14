/**
 * 工具名解析模块
 *
 * 将 Claude Code / Codex / Cursor 等外部平台的惯用工具名映射到 HClaw 实际工具名。
 * 被 filterToolsForAgent（agent 级过滤）、filterToolsByAgentType（类型级过滤）
 * 与 executeTool（运行时调用纠偏）共用。
 *
 * 为什么需要：everything-claude-code 等插件中的 Agent 定义使用 Claude Code 的工具名约定
 * （如 Read / Write / Edit / Bash / Grep / Glob），与 HClaw 的实际工具名不一致；
 * 运行时 LLM 也可能凭先验幻觉出不存在的工具名（如 read_file / readFile）。
 *
 * ── 安全模型（绝不能误调用）────────────────────────────────────────────
 * 解析分三层，逐层收紧；任何歧义一律失败关闭（返回 undefined）：
 *
 *   1. 精确匹配（HClaw 原生工具名）—— 最高优先级，别名绝不覆盖已存在的工具名。
 *   2. 候选唯一性判定 —— 对以下两条来源求并集，**只有恰好 1 个候选**才解析：
 *        a) 别名表命中：canonical(输入) → 别名目标（目标必须已注册）
 *        b) 归一化同名：已注册工具中 canonical(工具名) === canonical(输入)
 *      并集 > 1 表示歧义（如插件注册了字面量 `Read`，同时 `read` 别名指向 `file_read`）
 *      → 拒绝解析，宁可漏报不可误报。
 *
 * 归一化 canonical(name) 仅做**机械等价**（小写 + 去分隔符），不做语义近似：
 * 不查子串、不剥前缀、不算编辑距离。
 *
 * 另：解析结果仍需通过 Agent 白名单/黑名单与权限引擎校验（executor 内），纵深防御。
 */

/**
 * 机械归一化：小写 + 移除所有非字母数字字符。
 *
 * `read_file` / `readFile` / `Read File` / `read-file` / `READ_FILE` → `readfile`
 * 这是纯粹的字面等价变换，不引入任何语义猜测。
 */
export function normalizeToolKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * 工具名别名表：key 必须为**归一化形式**（小写、无分隔符），查找前对输入做
 * normalizeToolKey。仅保留"目标工具名与源名不同"的条目；同名的写法差异
 * （如 fileRead → file_read）由 resolveToolName 的归一化同名层自动覆盖，无需列条目。
 *
 * 【准入三条件】新增条目前必须同时满足：
 *   1. 源参数键 ⊆ 目标工具 schema 键集，必填键能一一对应；
 *   2. 语义方向一致（创建/覆盖、读/写不得混淆）；
 *   3. 目标工具 isDestructive 为 true 时，源名必须同样是破坏性语义。
 * 因此 `create_file`（语义＝不存在才建）**禁止**映射到无条件覆盖的 file_write。
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  // ── Claude Code 语义名（单字） ──
  'read': 'file_read',
  'write': 'file_write',
  'edit': 'file_edit',
  'notebookedit': 'notebook_edit',
  'todowrite': 'task_create',
  'todoread': 'task_list',
  'todoupdate': 'task_update',
  'task': 'agent',

  // ── 文件工具：其他平台的「动词_名词」/ 动词式命名 ──
  'readfile': 'file_read',
  'cat': 'file_read',
  'writefile': 'file_write',
  'strreplace': 'file_edit',
  'strreplaceeditor': 'file_edit',
  'applypatch': 'file_edit',

  // ── 命令执行 ──
  'shell': 'bash',
  'runcommand': 'bash',
  'exec': 'bash',

  // ── 搜索 / 列文件 ──
  'searchfiles': 'grep',
  'ripgrep': 'grep',
  'findfiles': 'glob',
  'listfiles': 'glob',

  // 注意：以下名字**故意不收录**（语义漂移风险）
  //   create_file / append_file —— file_write 为无条件覆盖，语义不等价
  //   search —— 无法唯一确定是 grep 还是 glob
  //   ls / list_dir —— HClaw 无对应内置工具（glob 需 pattern，语义不同）
}

/**
 * 将 Agent 定义 / LLM 调用中的工具名解析为 HClaw 实际工具名。
 *
 * 返回 undefined 表示：无法解析，或存在歧义（失败关闭）。
 */
export function resolveToolName(
  specName: string,
  availableToolNames: string[],
): string | undefined {
  // 1. 精确匹配（原生工具名优先，别名不得覆盖）
  if (availableToolNames.includes(specName)) {
    return specName
  }

  const key = normalizeToolKey(specName)
  if (key === '') return undefined

  // 2. 候选唯一性判定：别名目标 + 归一化同名工具，求并集
  const candidates = new Set<string>()

  const aliasTarget = TOOL_NAME_ALIASES[key]
  if (aliasTarget && availableToolNames.includes(aliasTarget)) {
    candidates.add(aliasTarget)
  }
  for (const name of availableToolNames) {
    if (normalizeToolKey(name) === key) {
      candidates.add(name)
    }
  }

  // 恰好 1 个候选才解析；0 个＝未命中，≥2 个＝歧义 → 均失败关闭
  if (candidates.size === 1) {
    return [...candidates][0]
  }
  return undefined
}

/**
 * 为"未知工具"报错生成**仅供提示**的最相近候选（不参与路由）。
 *
 * 判定顺序：归一化同名前缀命中 → 归一化编辑距离最近（阈值内）。
 * 命中不到返回 undefined。
 */
export function findToolNameHint(
  specName: string,
  availableToolNames: string[],
): string | undefined {
  const key = normalizeToolKey(specName)
  if (key === '') return undefined

  // 前缀命中优先（read_file_xxx → readfile）
  const prefixHit = availableToolNames.find(name => {
    const n = normalizeToolKey(name)
    return n !== key && (n.startsWith(key) || key.startsWith(n))
  })
  if (prefixHit) return prefixHit

  // 编辑距离最近（限制在长度差 <= 3 的候选内，避免给出离谱建议）
  let best: string | undefined
  let bestDist = Number.POSITIVE_INFINITY
  for (const name of availableToolNames) {
    const n = normalizeToolKey(name)
    if (Math.abs(n.length - key.length) > 3) continue
    const dist = levenshtein(n, key)
    if (dist < bestDist) {
      bestDist = dist
      best = name
    }
  }
  // 距离阈值：不超过 key 长度的 1/3，否则宁可不给建议
  return best && bestDist <= Math.max(1, Math.floor(key.length / 3)) ? best : undefined
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!
  }
  return prev[b.length]!
}

/**
 * 解析工具规范
 * 例如: "bash:always" → { toolName: "bash", rule: "always" }
 */
export interface ParsedToolSpec {
  toolName: string
  rule?: string
}

export function parseToolSpec(spec: string): ParsedToolSpec {
  const parts = spec.split(':')
  return {
    toolName: parts[0]!,
    rule: parts[1],
  }
}
