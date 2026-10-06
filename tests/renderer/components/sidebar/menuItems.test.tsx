// @vitest-environment node
import {describe, it, expect} from 'vitest'
import {SIDEBAR_MENU_NODES, SIDEBAR_MENU_GROUP_NODES, itemHasUpdate, nodeHasUpdate, findGroupNode, groupNodeId, nodeIdOf} from '@/renderer/components/sidebar/menuItems'

describe('SIDEBAR_MENU_NODES structure', () => {
    it('T1: has 7 nodes', () => {
        expect(SIDEBAR_MENU_NODES.length).toBe(7)
    })

    it('T2: node order matches spec §4.2', () => {
        const signatures = SIDEBAR_MENU_NODES.map((n) =>
            n.kind === 'group' ? `group:${n.group}` : `direct:${n.item.type}`
        )
        expect(signatures).toEqual([
            'group:模型配置',
            'group:能力中心',
            'group:运行时',
            'group:内容数据',
            'group:运维管理',
            'direct:settings',
            'direct:about',
        ])
    })

    it('T3: mcp lives in 能力中心, not in 运行时', () => {
        const ability = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === '能力中心')!
        const runtime = SIDEBAR_MENU_NODES.find((n) => n.kind === 'group' && n.group === '运行时')!
        expect(ability.kind === 'group' && ability.items.some((i) => i.type === 'mcp')).toBe(true)
        expect(runtime.kind === 'group' && runtime.items.some((i) => i.type === 'mcp')).toBe(false)
    })

    it('T4: group sizes = 2 / 6 / 4 / 5 / 2', () => {
        const sizes = SIDEBAR_MENU_NODES
            .filter((n) => n.kind === 'group')
            .map((n) => (n.kind === 'group' ? n.items.length : 0))
        expect(sizes).toEqual([2, 6, 4, 5, 2])
    })

    it('T5: about & settings are kind=direct nodes', () => {
        const about = SIDEBAR_MENU_NODES.find((n) => n.kind === 'direct' && n.item.type === 'about')!
        const settings = SIDEBAR_MENU_NODES.find((n) => n.kind === 'direct' && n.item.type === 'settings')!
        expect(about).toBeDefined()
        expect(settings).toBeDefined()
        expect(about.kind).toBe('direct')
        expect(settings.kind).toBe('direct')
    })

    it('T6: no "in"-based loose discrimination in source', async () => {
        const fs = await import('node:fs')
        const url = new URL('../../../../src/renderer/components/sidebar/menuItems.tsx', import.meta.url)
        const src = fs.readFileSync(url, 'utf8')
        expect(src).not.toMatch(/'group'\s+in\b/)
        expect(src).not.toMatch(/'items'\s+in\b/)
        expect(src).not.toMatch(/'kind'\s+in\b/)
    })

    it('T7: collapsed icon bar flatMap yields 21 items', () => {
        const flat = SIDEBAR_MENU_NODES.flatMap((n) => (n.kind === 'group' ? n.items : [n.item]))
        expect(flat.length).toBe(21)
        const types = flat.map((i) => i.type)
        expect(types).toContain('about')
        expect(types).toContain('settings')
        expect(types).toContain('mcp')
        expect(types).toContain('schedules')
    })
})

describe('red dot aggregation', () => {
    // 用最小 SidebarMenuItem 结构（label/icon 可为占位）
    const ABOUT   = {type: 'about',     label: 'x', icon: null as any}
    const PLUGINS = {type: 'plugins',   label: 'x', icon: null as any}
    const SKILLS  = {type: 'skills',    label: 'x', icon: null as any}
    const MCP     = {type: 'mcp',       label: 'x', icon: null as any}
    const OTHER   = {type: 'schedules', label: 'x', icon: null as any}

    it('T8: about + hasUpdate => true', () => {
        expect(itemHasUpdate(ABOUT, {hasUpdate: true, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: false})).toBe(true)
    })

    it('T9: plugins + pluginHasUpdate => true', () => {
        expect(itemHasUpdate(PLUGINS, {hasUpdate: false, pluginHasUpdate: true, repoHasUpdate: false, mcpHasUpdate: false})).toBe(true)
    })

    it('T10: skills + repoHasUpdate => true', () => {
        expect(itemHasUpdate(SKILLS, {hasUpdate: false, pluginHasUpdate: false, repoHasUpdate: true, mcpHasUpdate: false})).toBe(true)
    })

    it('T11: mcp + mcpHasUpdate => true', () => {
        expect(itemHasUpdate(MCP, {hasUpdate: false, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: true})).toBe(true)
    })

    it('T12: other types never hit any ctx (even all-true)', () => {
        expect(itemHasUpdate(OTHER, {hasUpdate: true, pluginHasUpdate: true, repoHasUpdate: true, mcpHasUpdate: true})).toBe(false)
    })

    it('T13: group node ORs inner items', () => {
        const group = {kind: 'group' as const, group: '能力中心', icon: null as any, items: [SKILLS, MCP, PLUGINS]}
        // 仅 mcp 命中 → group 应为 true
        expect(nodeHasUpdate(group, {hasUpdate: false, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: true})).toBe(true)
        // 全部未命中 → group 应为 false
        expect(nodeHasUpdate(group, {hasUpdate: false, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: false})).toBe(false)
    })

    it('T14: direct node delegates to itemHasUpdate', () => {
        const direct = {kind: 'direct' as const, item: ABOUT}
        expect(nodeHasUpdate(direct, {hasUpdate: true, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: false})).toBe(true)
        expect(nodeHasUpdate(direct, {hasUpdate: false, pluginHasUpdate: false, repoHasUpdate: false, mcpHasUpdate: false})).toBe(false)
    })
})

describe('节点 id 原语与 group 派生常量', () => {
    it('T15: findGroupNode 按真实节点 id 命中 group（运维管理 2 项 / 能力中心 6 项）', () => {
        expect(findGroupNode('group:运维管理')?.items.length).toBe(2)
        expect(findGroupNode('group:能力中心')?.items.length).toBe(6)
    })

    it('T16: findGroupNode 对 direct 节点 / null / 未命中一律 undefined', () => {
        expect(findGroupNode('direct:about')).toBeUndefined()
        expect(findGroupNode('direct:settings')).toBeUndefined()
        expect(findGroupNode(null)).toBeUndefined()
        expect(findGroupNode('group:不存在的组')).toBeUndefined()
    })

    it('T17: SIDEBAR_MENU_GROUP_NODES 顺序 = 全节点中的 group 子序列，长度 5', () => {
        const groupSubsequence = SIDEBAR_MENU_NODES
            .map((n) => (n.kind === 'group' ? groupNodeId(n.group) : null))
            .filter((s): s is string => s !== null)
        expect(SIDEBAR_MENU_GROUP_NODES.map((n) => groupNodeId(n.group))).toEqual(groupSubsequence)
        expect(SIDEBAR_MENU_GROUP_NODES.length).toBe(5)
        expect(SIDEBAR_MENU_GROUP_NODES.map((n) => n.group))
            .toEqual(['模型配置', '能力中心', '运行时', '内容数据', '运维管理'])
    })

    it('T18: 生成的节点 id 与 DOM 契约（group:<组名> / direct:<type>）逐字一致', () => {
        expect(groupNodeId('能力中心')).toBe('group:能力中心')
        expect(nodeIdOf({kind: 'group', group: '运维管理', icon: null as any, items: []})).toBe('group:运维管理')
        expect(nodeIdOf({kind: 'direct', item: {type: 'about', label: 'x', icon: null as any}})).toBe('direct:about')
        // 与全节点签名（T2 的同一口径）逐个对齐，防止拼接逻辑漂移
        expect(SIDEBAR_MENU_NODES.map((n) => nodeIdOf(n))).toEqual(SIDEBAR_MENU_NODES.map((n) =>
            n.kind === 'group' ? `group:${n.group}` : `direct:${n.item.type}`
        ))
    })
})
