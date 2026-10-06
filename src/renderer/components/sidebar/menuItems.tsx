import type {JSX} from 'react'

/** 侧边栏齿轮菜单复用的菜单项（type 是路由键，禁止改动；label / icon 保留原样） */
export interface SidebarMenuItem {
    type: string | null
    label: string
    icon: JSX.Element
}

/**
 * 齿轮菜单节点。union 判别用 `node.kind === 'group' | 'direct'`。
 * - `group`: 一组带组标题的菜单项（原有分组结构）；icon 用于侧栏折叠态图标栏
 * - `direct`: 单个独立项（无组标题，直接展示；用于「系统设置」「关于」等）
 */
export type SidebarMenuNode =
    | {kind: 'group'; group: string; icon: JSX.Element; items: SidebarMenuItem[]}
    | {kind: 'direct'; item: SidebarMenuItem}

/** 收进齿轮菜单的全部节点（顺序即折叠态图标栏扁平顺序；共 21 项、7 节点） */
export const SIDEBAR_MENU_NODES: SidebarMenuNode[] = [
    {
        kind: 'group',
        group: '模型配置',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <rect x="4" y="4" width="16" height="16" rx="2"/>
            <rect x="9" y="9" width="6" height="6"/>
            <path d="M9 2v2M15 2v2M9 20v2M15 20v2M2 9h2M2 15h2M20 9h2M20 15h2"/>
        </svg>,
        items: [
            {
                type: 'scheme-config', label: '模型方案',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <path d="M12 8v4M12 16h.01"/>
                </svg>,
            },
            {
                type: 'llm-config', label: '服务商',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="4" y="4" width="16" height="16" rx="2"/>
                    <rect x="9" y="9" width="6" height="6"/>
                    <line x1="9" y1="1" x2="9" y2="4"/>
                    <line x1="15" y1="1" x2="15" y2="4"/>
                    <line x1="9" y1="20" x2="9" y2="23"/>
                    <line x1="15" y1="20" x2="15" y2="23"/>
                    <line x1="20" y1="9" x2="23" y2="9"/>
                    <line x1="20" y1="14" x2="23" y2="14"/>
                    <line x1="1" y1="9" x2="4" y2="9"/>
                    <line x1="1" y1="14" x2="4" y2="14"/>
                </svg>,
            },
        ],
    },
    {
        kind: 'group',
        group: '能力中心',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>,
        items: [
            {
                type: 'agents', label: 'Agents',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                    <circle cx="9" cy="7" r="4"/>
                    <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
                </svg>,
            },
            {
                type: 'skills', label: 'Skills',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <polygon points="12 2 2 7 12 12 22 7 12 2"/>
                    <polyline points="2 17 12 22 22 17"/>
                    <polyline points="2 12 12 17 22 12"/>
                </svg>,
            },
            {
                type: 'commands', label: '命令',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M13 10V3L4 14h7v7l9-11h-7z"/>
                </svg>,
            },
            {
                type: 'plugins', label: '插件',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M20 7h-9"/>
                    <path d="M14 17H5"/>
                    <circle cx="17" cy="17" r="3"/>
                    <circle cx="7" cy="7" r="3"/>
                </svg>,
            },
            {
                type: 'tool-manage', label: '内置工具',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
                </svg>,
            },
            {
                type: 'mcp', label: 'MCP 服务',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
                    <line x1="8" y1="21" x2="16" y2="21"/>
                    <line x1="12" y1="17" x2="12" y2="21"/>
                </svg>,
            },
        ],
    },
    {
        kind: 'group',
        group: '运行时',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
        </svg>,
        items: [
            {
                type: 'companion-apps', label: '跟随启动',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/>
                    <polygon points="10 8 16 12 10 16 10 8"/>
                </svg>,
            },
            {
                type: 'schedules', label: '定时任务',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="10"/>
                    <polyline points="12 6 12 12 16 14"/>
                </svg>,
            },
            {
                type: 'permission-rules', label: '权限配置',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                </svg>,
            },
            {
                type: 'channels', label: 'IM 渠道',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-2.51.49"/>
                    <path d="M4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9.6 4.6"/>
                    <path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>
                </svg>,
            },
        ],
    },
    {
        kind: 'group',
        group: '内容数据',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M12 2L2 7l10 5 10-5-10-5z"/>
            <path d="M2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>,
        items: [
            {
                type: 'conversations', label: '历史会话',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>,
            },
            {
                type: 'task-history', label: '任务历史',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                    <path d="M3 3v5h5"/>
                    <path d="M12 7v5l4 2"/>
                </svg>,
            },
            {
                type: 'quick-phrases', label: '快捷短语',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M4 5a2 2 0 0 1 2-2h8l6 6v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>
                    <path d="M8 9h6M8 13h6M8 17h3"/>
                </svg>,
            },
            {
                type: 'memory-manager', label: '记忆管理',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 4a4 4 0 0 0-4 4 4 4 0 0 0-3 6.5A4 4 0 0 0 8 21h1a2 2 0 0 0 2-2V6a3 3 0 0 1 1-.9z"/>
                    <path d="M12 4a4 4 0 0 1 4 4 4 4 0 0 1 3 6.5A4 4 0 0 1 16 21h-1a2 2 0 0 1-2-2"/>
                    <path d="M12 4v15"/>
                </svg>,
            },
            {
                type: 'prompt-scheme', label: '系统提示词',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M12 20h9"/>
                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                </svg>,
            },
        ],
    },
    {
        kind: 'group',
        group: '运维管理',
        icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="20" x2="18" y2="10"/>
            <line x1="12" y1="20" x2="12" y2="4"/>
            <line x1="6" y1="20" x2="6" y2="14"/>
        </svg>,
        items: [
            {
                type: 'llm-call-logs', label: 'LLM调用日志',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
                    <polyline points="14 2 14 8 20 8"/>
                    <line x1="16" y1="13" x2="8" y2="13"/>
                    <line x1="16" y1="17" x2="8" y2="17"/>
                </svg>,
            },
            {
                type: 'usage-stats', label: 'LLM用量统计',
                icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <line x1="18" y1="20" x2="18" y2="10"/>
                    <line x1="12" y1="20" x2="12" y2="4"/>
                    <line x1="6" y1="20" x2="6" y2="14"/>
                </svg>,
            },
        ],
    },
    {
        kind: 'direct',
        item: {
            type: 'settings', label: '系统设置',
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="3"/>
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>,
        },
    },
    {
        kind: 'direct',
        item: {
            type: 'about', label: '关于',
            icon: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="16" x2="12" y2="12"/>
                <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>,
        },
    },
]

/** group 节点窄化类型（折叠态 group 列表 / 二级面板查找共用） */
export type SidebarMenuGroupNode = Extract<SidebarMenuNode, {kind: 'group'}>

/** 折叠态一级图标栏的 group 节点（顺序与 SIDEBAR_MENU_NODES 中 group 的出现顺序一致） */
export const SIDEBAR_MENU_GROUP_NODES: SidebarMenuGroupNode[] =
    SIDEBAR_MENU_NODES.filter((n): n is SidebarMenuGroupNode => n.kind === 'group')

/** group 名 → 节点 id（`group:<group>`，即 data-node-id / data-panel-node-id 契约） */
export function groupNodeId(group: string): string {
    return `group:${group}`
}

/** 节点 → 节点 id：group → `group:<group>`，direct → `direct:<item.type>` */
export function nodeIdOf(node: SidebarMenuNode): string {
    return node.kind === 'group' ? groupNodeId(node.group) : `direct:${node.item.type}`
}

/** 按节点 id 查找 group 节点（direct 节点 / null / 未命中 → undefined） */
export function findGroupNode(nodeId: string | null): SidebarMenuGroupNode | undefined {
    if (nodeId === null) return undefined
    return SIDEBAR_MENU_GROUP_NODES.find((n) => groupNodeId(n.group) === nodeId)
}

/** 4 类更新源收敛的上下文（由调用方从 store 读取后传入） */
export interface UpdateCtx {
    hasUpdate: boolean         // 应用本体（对应 about 项）
    pluginHasUpdate: boolean   // 插件（对应 plugins 项）
    repoHasUpdate: boolean     // Skills 仓库（对应 skills 项）
    mcpHasUpdate: boolean      // MCP 服务（对应 mcp 项）
}

/** type → ctx.key 映射表：非映射 type 返回 undefined，itemHasUpdate 走 false 分支 */
const ITEM_UPDATE_SOURCE: Partial<Record<NonNullable<SidebarMenuItem['type']>, keyof UpdateCtx>> = {
    about:   'hasUpdate',
    plugins: 'pluginHasUpdate',
    skills:  'repoHasUpdate',
    mcp:     'mcpHasUpdate',
}

/** 单个菜单项是否命中更新条件 */
export function itemHasUpdate(item: SidebarMenuItem, ctx: UpdateCtx): boolean {
    if (item.type === null) return false
    const key = ITEM_UPDATE_SOURCE[item.type]
    return key ? ctx[key] : false
}

/** 菜单节点是否命中更新条件（group 递归 OR 组内 items；direct 直接判 item） */
export function nodeHasUpdate(node: SidebarMenuNode, ctx: UpdateCtx): boolean {
    return node.kind === 'group'
        ? node.items.some(i => itemHasUpdate(i, ctx))
        : itemHasUpdate(node.item, ctx)
}
