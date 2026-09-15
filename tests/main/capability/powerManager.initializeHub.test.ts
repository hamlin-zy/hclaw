/**
 * powerManager.initialize — 全量加载完成后必须投影到 CapabilityHub
 *
 * 锁定本次修复：CapabilityHub 的唯一写入口 `syncToCapabilityHub()` 此前只挂在
 * refresh() 上，冷启动（只跑 initialize，不再有启动预热 refresh）时 Hub 恒为空，
 * 命令管理页（渲染层唯一直接消费 Hub 投影的 UI：capability:get-by-type('command')）
 * 表现为「没有数据」。
 *
 * 隔离：mock config 到临时目录 + mock 重型扫描器（agentLoader / skills /
 * mcpService / seedAgentFiles / CommandDispatcher），使用真实 powerManager 与真实
 * CapabilityHub，断言「initialize() 之后 Hub 里就有命令条目」这一对外可见契约。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest'
import * as fs from 'fs'

vi.mock('@/main/config', async () => {
    const osMod = await import('os')
    const pathMod = await import('path')
    const testDir = pathMod.join(
        osMod.tmpdir(),
        'hclaw-test-init-hub-' + Date.now() + '-' + Math.random().toString(36).slice(2),
    )
    fs.mkdirSync(testDir, {recursive: true})
    return {
        getHclawDir: () => testDir,
        getHclawDataDir: () => pathMod.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
        HCLAW_DIR: testDir,
    }
})

/** 技能注册表替身：initialize() 会 clear/getAll/getEnabled，注册一条技能以覆盖 skill 分支 */
const skillState = vi.hoisted(() => ({items: [] as Array<Record<string, unknown>>}))
vi.mock('@/main/agent/skills', () => ({
    skillRegistry: {
        clear: () => { skillState.items = [] },
        getAll: () => skillState.items,
        getEnabled: () => skillState.items.filter(s => s.enabled),
        register: (s: Record<string, unknown>) => { skillState.items.push(s) },
        unregister: () => {},
        unregisterByPlugin: () => 0,
        syncPluginStatus: () => {},
    },
    loadSkillsFromDirectory: async () => 0,
    loadSkillsFromPluginDirectory: async () => 0,
    loadSkillsFromPlugins: async () => 0,
    applySkillOverrides: () => {},
}))

vi.mock('@/main/agent/agentLoader', () => ({
    scanAllAgents: async () => [],
    scanAgentsFromPlugin: async () => ({templates: [], errors: []}),
}))

vi.mock('@/main/agent/defaults/seedAgentFiles', () => ({
    seedDefaultAgentFiles: () => {},
}))

vi.mock('@/main/services/mcpService', () => ({
    mcpService: {
        list: () => [],
        addPluginServer: () => {},
    },
}))

/** CommandDispatcher 替身：getAllCommands() 的返回值由各用例注入 */
const dispatcherState = vi.hoisted(() => ({result: null as unknown}))
vi.mock('@/main/plugin/commands', () => ({
    CommandDispatcher: {
        getInstance: () => ({
            getAllCommands: () => dispatcherState.result,
            refresh: async () => {},
        }),
    },
}))

import {powerManager} from '@/main/agent/powerManager'
import {capabilityHub} from '@/main/capability/CapabilityHub'

function seedCommands(): void {
    dispatcherState.result = {
        pluginGroups: new Map(),
        userCommands: [
            {
                id: 'commit-msg',
                name: 'commit-msg',
                description: '规范化提交信息',
                content: 'body',
                enabled: true,
                args: [],
            },
        ],
        pluginCommandOverrides: {},
    }
}

describe('powerManager.initialize → CapabilityHub 投影', () => {
    beforeEach(() => {
        skillState.items = []
        seedCommands()
    })

    it('initialize() 之后 Hub 已有命令条目（命令管理页数据源非空）', async () => {
        await powerManager.initialize()

        const commands = capabilityHub.getByType('command')
        expect(commands.map(c => c.id)).toContain('cmd:commit-msg')
        expect(commands[0].source).toBe('user')
    })
})
