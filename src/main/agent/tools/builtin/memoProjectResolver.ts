/**
 * memoProjectResolver — 备忘录跨项目归属：项目清单与目标项目解析
 *
 * 纯函数模块（不碰 electron / DB / IPC），供 memo_tool 使用：
 *   - collectProjectEntries：把 workspaces（唯一带 name 的来源）与项目组拼成扁平清单
 *   - resolveTargetPath：按 project / projectGroup 参数解析唯一目标路径
 *   - formatProjectsText：把清单渲染成给 LLM 看的文本
 *
 * 约定：ProjectEntry.groupName === '' 表示未分组；未分组条目永远排在数组末尾。
 */
import type {ProjectGroupWithMembers} from '@shared/types/projectGroup'

/** 未归属虚拟键（与渲染端 workspacePath.ts 同源）：不是真实路径，不进项目清单 */
const UNASSIGNED_PROJECT_PATH = '__unassigned__'

export interface ProjectEntry {
    /** 展示名：workspaces.name 去空白；为空则回退路径末段 */
    name: string
    /** 项目路径（原串，不做归一化） */
    path: string
    /** 所属项目组名；'' 表示未分组 */
    groupName: string
}

/**
 * 路径末段。刻意不用 `path.basename`：项目路径是 Windows 串，而 path 行为随运行平台变，
 * 分隔符无关的实现（与渲染端 workspaceBadgeLabel 同口径）在任何平台结果都一致。
 */
function baseName(p: string): string {
    const parts = p.split(/[/\\]/).filter(Boolean)
    return parts[parts.length - 1] || p
}

/** 展示名：name 去空白后仍为空则回退路径末段 */
function entryName(path: string, name: string): string {
    return name.trim() || baseName(path)
}

/**
 * 收集项目清单：以 workspaces 为主表，用 groups[].members[].projectPath 补组名。
 * 顺序 = groups 数组顺序 → 组内 members 顺序 → 未分组（workspaces 顺序）排在最后。
 */
export function collectProjectEntries(
    workspaces: Array<{path: string; name: string}>,
    groups: ProjectGroupWithMembers[],
): ProjectEntry[] {
    const wsByPath = new Map<string, {path: string; name: string}>()
    for (const ws of workspaces) {
        if (!wsByPath.has(ws.path)) wsByPath.set(ws.path, ws)
    }

    const entries: ProjectEntry[] = []
    const emitted = new Set<string>()

    // ① 分组条目：按 groups / members 顺序输出；成员不在 workspaces 里的跳过
    for (const group of groups) {
        for (const member of group.members) {
            const ws = wsByPath.get(member.projectPath)
            if (!ws || ws.path === UNASSIGNED_PROJECT_PATH || emitted.has(ws.path)) continue
            emitted.add(ws.path)
            entries.push({name: entryName(ws.path, ws.name), path: ws.path, groupName: group.name})
        }
    }

    // ② 未分组条目：剔除虚拟键，排在最后
    for (const ws of workspaces) {
        if (ws.path === UNASSIGNED_PROJECT_PATH || emitted.has(ws.path)) continue
        emitted.add(ws.path)
        entries.push({name: entryName(ws.path, ws.name), path: ws.path, groupName: ''})
    }

    return entries
}

/**
 * 解析目标项目路径。
 *
 * 「两者都空」返回错误：调用方（memo_tool）已对空参数短路，正常路径不会走到；
 * 该分支作为纯函数自身的防护保留，避免裸调用时静默落到非预期目标。
 * 名称匹配一律精确（大小写敏感），仅做首尾去空白。
 */
export function resolveTargetPath(
    entries: ProjectEntry[],
    spec: {projectGroup?: string; project?: string},
): {ok: true; path: string} | {ok: false; error: string} {
    const groupName = spec.projectGroup?.trim() ?? ''
    const projectName = spec.project?.trim() ?? ''

    if (!groupName && !projectName) {
        return {ok: false, error: '需要提供 project 或 projectGroup 参数。'}
    }

    // 1. 只给组：项目组本身没有备忘落点
    if (!projectName) {
        return {ok: false, error: '需要同时提供 project（项目组本身没有备忘落点）。'}
    }

    // 2. 组 + 项目：组内精确匹配
    if (groupName) {
        if (!entries.some(e => e.groupName === groupName)) {
            return {ok: false, error: `未找到名为「${groupName}」的项目组，可调用 list_projects 查看可用项目组。`}
        }
        const inGroup = entries.filter(e => e.groupName === groupName && e.name === projectName)
        if (inGroup.length === 0) {
            return {ok: false, error: `项目组「${groupName}」中没有名为「${projectName}」的项目。`}
        }
        if (inGroup.length > 1) {
            return {ok: false, error: `项目组「${groupName}」中有 ${inGroup.length} 个名为「${projectName}」的项目，无法确定唯一目标。`}
        }
        return {ok: true, path: inGroup[0].path}
    }

    // 3. 只给项目：全局精确匹配
    const hits = entries.filter(e => e.name === projectName)
    if (hits.length === 1) return {ok: true, path: hits[0].path}
    if (hits.length === 0) {
        return {ok: false, error: `未找到名为「${projectName}」的项目，可调用 list_projects 查看可用项目。`}
    }
    return {ok: false, error: `有 ${hits.length} 个名为「${projectName}」的项目，请补充 projectGroup 参数以确定目标。`}
}

/**
 * 渲染项目清单文本：组头一行，条目行两空格 + `- <name>`。
 * 依赖 entries 已按组连续排列（即 collectProjectEntries 的输出顺序）。
 */
export function formatProjectsText(entries: ProjectEntry[]): string {
    if (entries.length === 0) return '当前没有可用的项目。'

    const lines: string[] = []
    let currentGroup: string | null = null
    for (const entry of entries) {
        if (entry.groupName !== currentGroup) {
            if (currentGroup !== null) lines.push('')
            lines.push(entry.groupName ? `项目组「${entry.groupName}」:` : '未分组项目:')
            currentGroup = entry.groupName
        }
        lines.push(`  - ${entry.name}`)
    }
    return lines.join('\n')
}
