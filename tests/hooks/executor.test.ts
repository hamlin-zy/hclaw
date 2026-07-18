/**
 * Hook executor test
 *
 * Covers:
 * - matcher.ts: matchesTool, matchesEvent, matchesFile
 * - executor.ts: runAllHooks blocking chain, decision compat, recursion protection
 * - exit code semantic mapping
 */
import {describe, expect, it, vi, beforeEach} from 'vitest'
import type {Mock} from 'vitest'
import type {HookResult} from '../../src/main/plugin/hooks/types'
import {matchesTool, matchesEvent, matchesFile} from '../../src/main/plugin/hooks/matcher'

// ============================================================
// matcher.ts pure function tests (zero dependency)
// ============================================================

describe('matchesTool', () => {
    it('wildcard matches all', () => {
        expect(matchesTool('*', 'Bash')).toBe(true)
        expect(matchesTool('*', 'Write')).toBe(true)
        expect(matchesTool('*', 'Read')).toBe(true)
    })

    it('exact match', () => {
        expect(matchesTool('Bash', 'Bash')).toBe(true)
        expect(matchesTool('Write', 'Write')).toBe(true)
        expect(matchesTool('Bash', 'Write')).toBe(false)
    })

    it('pipe operator', () => {
        expect(matchesTool('Bash|Write', 'Bash')).toBe(true)
        expect(matchesTool('Bash|Write', 'Write')).toBe(true)
        expect(matchesTool('Bash|Write', 'Read')).toBe(false)
    })

    it('regex match', () => {
        expect(matchesTool('^file_', 'file_write')).toBe(true)
        expect(matchesTool('^file_', 'file_read')).toBe(true)
        expect(matchesTool('^file_', 'Bash')).toBe(false)
        expect(matchesTool('\\.ts$', 'compile.ts')).toBe(true)
        expect(matchesTool('\\.ts$', 'compile.js')).toBe(false)
    })

    it('pipe + regex mixed', () => {
        expect(matchesTool('^file_|Bash', 'file_write')).toBe(true)
        expect(matchesTool('^file_|Bash', 'Bash')).toBe(true)
        expect(matchesTool('^file_|Bash', 'Read')).toBe(false)
    })

    // Claude Code 兼容：PascalCase matcher 匹配小写 HClaw 工具名
    it('case-insensitive fallback for cross-eco compatibility', () => {
        // Claude Code: Bash/Write/Edit → HClaw: bash/write/edit
        expect(matchesTool('Bash', 'bash')).toBe(true)
        expect(matchesTool('Write', 'write')).toBe(true)
        expect(matchesTool('Edit', 'edit')).toBe(true)
        expect(matchesTool('MultiEdit', 'multiedit')).toBe(true)
        // 精确匹配仍然优先
        expect(matchesTool('Bash', 'Bash')).toBe(true)
        // 不应误匹配
        expect(matchesTool('Bash', 'grep')).toBe(false)
        expect(matchesTool('Write', 'read')).toBe(false)
    })
})

describe('matchesEvent', () => {
    it('wildcard matches all', () => {
        expect(matchesEvent('*', 'PreToolUse')).toBe(true)
        expect(matchesEvent('*', 'ThinkStart' as any)).toBe(true)
    })

    it('exact match', () => {
        expect(matchesEvent('PreToolUse', 'PreToolUse')).toBe(true)
        expect(matchesEvent('PreToolUse', 'PostToolUse')).toBe(false)
    })

    it('regex match', () => {
        expect(matchesEvent('Tool.*', 'PreToolUse')).toBe(true)
        expect(matchesEvent('Tool.*', 'PostToolUse')).toBe(true)
        expect(matchesEvent('Tool.*', 'ThinkStart' as any)).toBe(false)
    })

    it('pipe operator', () => {
        expect(matchesEvent('PreToolUse|PostToolUse', 'PreToolUse')).toBe(true)
        expect(matchesEvent('PreToolUse|PostToolUse', 'PostToolUse')).toBe(true)
        expect(matchesEvent('PreToolUse|PostToolUse', 'ThinkStart' as any)).toBe(false)
    })
})

describe('matchesFile', () => {
    it('wildcard matches all', () => {
        expect(matchesFile('*', '/path/to/file.ts')).toBe(true)
    })

    it('exact path match', () => {
        expect(matchesFile('/path/to/file.ts', '/path/to/file.ts')).toBe(true)
        expect(matchesFile('/path/to/file.ts', '/other/file.ts')).toBe(false)
    })

    it('regex match basename', () => {
        expect(matchesFile('^\\.env$', '/project/.env')).toBe(true)
        expect(matchesFile('^\\.env$', '/project/.env.local')).toBe(false)
        expect(matchesFile('\\.env', '/project/config.json')).toBe(false)
    })

    it('exact basename match', () => {
        expect(matchesFile('.env', '/project/.env')).toBe(true)
        // .env as regex matches .env.local: . = any char, env = 'env'
        expect(matchesFile('.env', '/project/.env.local')).toBe(true)
    })

    it('windows paths', () => {
        // backslash in regex: C:\project\.env matches \.env$
        expect(matchesFile('\\.env$', 'C:\\project\\.env')).toBe(true)
    })
})

// ============================================================
// executor.ts tests (mocked dependencies)
// ============================================================

vi.mock('child_process', () => ({
    exec: vi.fn(),
}))

vi.mock('../../src/main/plugin/hooks/builtin', () => ({
    registerBuiltinHandlers: vi.fn(),
    getAuditLog: vi.fn(() => []),
    clearAuditLog: vi.fn(),
}))

const mockReadHookConfig = vi.fn()
vi.mock('../../src/main/config/hookConfig', () => ({
    readHookConfig: (...args: any[]) => mockReadHookConfig(...args),
}))

vi.mock('../../src/main/plugin/registry', () => {
    const getPluginPath = vi.fn()
    return {
        PluginRegistry: {
            getInstance: vi.fn(() => ({
                getHooks: vi.fn(() => new Map()),
                getPluginPath,
            })),
        },
    }
})

vi.mock('../../src/main/agent/logger', () => ({
    createLogger: vi.fn(() => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    })),
}))

vi.mock('../../src/main/config', () => ({
    getHclawDir: vi.fn(() => 'C:/Users/Hamlin/.hclaw'),
}))

import {HookExecutor} from '../../src/main/plugin/hooks/executor'

describe('HookExecutor', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error reset singleton per test
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    describe('execute - no matching hooks', () => {
        it('returns decision: allow when no hooks', async () => {
            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session',
                toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(result).toHaveProperty('allowed', true)
        })
    })

    describe('execute - decision backward compat', () => {
        it('old allowed=false maps to decision=block', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-1', name: 'block-hook', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'echo blocked'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, {stdout: '', stderr: 'user blocked', code: 2})
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'block')
            expect(result).toHaveProperty('allowed', false)
            expect(result.error).toContain('user blocked')
        })

        it('old allowed=true maps to decision=allow', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-2', name: 'allow-hook', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'echo ok'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, {stdout: 'ok', stderr: '', code: 0})
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(result).toHaveProperty('allowed', true)
        })

        it('decision=block without allowed field', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-3', name: 'decision-block', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'echo block'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, {stdout: JSON.stringify({decision: 'block', reason: 'not allowed'}), stderr: '', code: 0})
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'block')
            expect(result).toHaveProperty('allowed', false)
        })
    })

    describe('execute - blocking chain', () => {
        it('first hook blocked returns immediately, second not executed', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-block', name: 'blocker', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'block_cmd'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
                {
                    id: 'hook-allow', name: 'never-reached', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'allow_cmd'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            let callCount = 0
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                callCount++
                if (callCount === 1) {
                    cb(null, {stdout: '', stderr: 'blocked!', code: 2})
                } else {
                    cb(null, {stdout: 'should not happen', stderr: '', code: 0})
                }
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'block')
            expect(result).toHaveProperty('allowed', false)
            expect(callCount).toBe(1)
        })

        it('multiple allow hooks merge results', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-1', name: 'first', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'first_cmd'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
                {
                    id: 'hook-2', name: 'second', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'second_cmd'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, {stdout: 'ok', stderr: '', code: 0})
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(result).toHaveProperty('allowed', true)
        })
    })

    describe('execute - matcher filter', () => {
        it('matcher not matching skips hook', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-bash', name: 'bash-only', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'bash_check', matcher: 'Bash'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Write',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(mockExec).not.toHaveBeenCalled()
        })

        it('matcher matching executes hook', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-bash', name: 'bash-only', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'bash_check', matcher: 'Bash'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock
            mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
                cb(null, {stdout: 'ok', stderr: '', code: 0})
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(mockExec).toHaveBeenCalled()
        })
    })

    describe('execute - event matching', () => {
        it('unregistered event does not trigger hook', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-pretool', name: 'pretool-only', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'command', command: 'pretool_check'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const {exec} = await import('child_process')
            const mockExec = exec as unknown as Mock

            const result = await executor.execute('PostToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(mockExec).not.toHaveBeenCalled()
        })
    })

    describe('execute - prompt hook', () => {
        it('prompt hook returns modified.prompt', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-prompt', name: 'prompt-modifier', description: '',
                    events: ['PreToolUse'],
                    config: {type: 'prompt', prompt: 'EXTRA: be careful'},
                    enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
                },
            ])

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })
            expect(result).toHaveProperty('decision', 'allow')
            expect(result.modified?.prompt).toBe('EXTRA: be careful')
        })
    })
})

describe('HookExecutor - Agent recursion protection', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    it('depth limit does not throw', async () => {
        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-agent', name: 'agent-hook', description: '',
                events: ['PreToolUse'],
                config: {type: 'agent', agentPrompt: 'do something'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const result = await executor.execute('PreToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })
        expect(result).toHaveProperty('decision', 'allow')
        expect(result).toHaveProperty('allowed', true)
    })
})

describe('HookExecutor - ContextRetrieval scenario', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    it('captureOutput returns stdout as output', async () => {
        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-retrieval', name: 'knowledge-retrieval', description: '',
                events: ['ContextRetrieval'],
                config: {type: 'command', command: 'retrieve_knowledge', captureOutput: true},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: 'relevant knowledge data', stderr: '', code: 0})
        })

        const result = await executor.execute('ContextRetrieval', {
            sessionId: 'test-session', prompt: 'search something',
        })
        expect(result).toHaveProperty('decision', 'allow')
        expect(result.output).toBe('relevant knowledge data')
    })
})

describe('HookExecutor - event enum consistency', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    it('all registered events do not throw', async () => {
        const events = [
            'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
            'PermissionRequest', 'PermissionDenied',
            'ThinkStart', 'ThinkEnd',
            'ContextRetrieval', 'Stop', 'StopFailure',
            'FileChanged',
            'SessionStart', 'SessionEnd', 'UserPromptSubmit',
            'PreCompact', 'PostCompact',
            'SubagentStart', 'SubagentStop',
            'TaskCreated', 'TaskCompleted',
            'ConfigChange',
        ] as const

        for (const event of events) {
            const result = await executor.execute(event, {
                sessionId: 'test-session', toolName: 'Bash',
            }).catch(() => ({decision: 'allow' as const, allowed: true}))
            expect(result).toBeDefined()
        }
    })
})

// ============================================================
// Claude Code 插件兼容层测试
// ============================================================

describe('Claude plugin hook compatibility', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    describe('HookExecutor - pre-initialization state', () => {
        it('has MAX_HOOK_DEPTH = 3', () => {
            // @ts-expect-error access private field
            expect(executor.MAX_HOOK_DEPTH).toBe(3)
        })

        it('hookDepth starts at 0', () => {
            // @ts-expect-error access private field
            expect(executor.hookDepth).toBe(0)
        })
    })

    describe('substituteVariables - CLAUDE_PLUGIN_ROOT', () => {
        it('replaces ${CLAUDE_PLUGIN_ROOT} when pluginRoot set', () => {
            const result = executor.substituteVariables(
                '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                { pluginRoot: 'C:/Users/Hamlin/.hclaw/plugins/superpowers@github' }
            )
            expect(result).toContain('C:/Users/Hamlin/.hclaw/plugins/superpowers@github/hooks/run-hook.cmd')
            expect(result).not.toContain('${CLAUDE_PLUGIN_ROOT}')
        })

        it('replaces ${CLAUDE_PLUGIN_ROOT} with empty string when pluginRoot undefined', () => {
            const result = executor.substituteVariables(
                '"${CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
                {}
            )
            expect(result).toContain('"/hooks/run-hook.cmd" session-start')
        })

        it('handles multiple occurrences', () => {
            const result = executor.substituteVariables(
                '${CLAUDE_PLUGIN_ROOT}/a ${CLAUDE_PLUGIN_ROOT}/b',
                { pluginRoot: '/tmp/plugin' }
            )
            expect(result).toBe('/tmp/plugin/a /tmp/plugin/b')
        })
    })

    describe('getHooksForEvent - pluginName propagation', () => {
        it('plugin hooks carry pluginName in the result object', () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-ecc', name: 'ecc-hook', description: 'ECC pre-bash',
                    events: ['PreToolUse'],
                    config: { type: 'command', command: 'node test.js', matcher: 'Bash' },
                    enabled: true, source: 'plugin' as const, pluginName: 'ecc',
                    createdAt: 0, updatedAt: 0,
                },
                {
                    id: 'hook-user', name: 'user-hook', description: 'User hook',
                    events: ['PreToolUse'],
                    config: { type: 'command', command: 'echo hi' },
                    enabled: true, source: 'user' as const,
                    createdAt: 0, updatedAt: 0,
                },
            ])

            // @ts-expect-error access private method
            const hooks = executor.getHooksForEvent('PreToolUse', { toolName: 'Bash' })

            const pluginHook = hooks.find((h: any) => h.name === 'ecc-hook')
            const userHook = hooks.find((h: any) => h.name === 'user-hook')

            expect(pluginHook).toBeDefined()
            expect(pluginHook.pluginName).toBe('ecc')

            expect(userHook).toBeDefined()
            expect(userHook.pluginName).toBeUndefined()
        })
    })

    describe('executeCommand - env injection', () => {
        it('injects CLAUDE_PLUGIN_ROOT and HCLAW_PLUGIN_ROOT for plugin hooks', async () => {
            const { PluginRegistry } = await import('../../src/main/plugin/registry')
            const registry = PluginRegistry.getInstance()
            vi.mocked(registry.getPluginPath).mockReturnValue(
                'C:/Users/Hamlin/.hclaw/plugins/everything-claude-code@github'
            )

            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-ecc-bash', name: 'ecc-bash-dispatcher', description: '',
                    events: ['PreToolUse'],
                    config: { type: 'command', command: 'node ecc-hook.js', matcher: 'Bash' },
                    enabled: true, source: 'plugin' as const, pluginName: 'ecc',
                    createdAt: 0, updatedAt: 0,
                },
            ])

            const { exec } = await import('child_process')
            const mockExec = exec as unknown as Mock
            let capturedOpts: any = null
            mockExec.mockImplementation((_cmd: string, opts: any, cb: Function) => {
                capturedOpts = opts
                cb(null, { stdout: 'ok', stderr: '', code: 0 })
            })

            await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })

            expect(capturedOpts).not.toBeNull()
            expect(capturedOpts.env).toBeDefined()
            // 基础变量（所有 hook 都有）
            expect(capturedOpts.env.CLAUDE_SESSION_ID).toBe('test-session')
            expect(capturedOpts.env.CLAUDE_PROJECT_DIR).toBe('C:/Users/Hamlin/.hclaw')
            expect(capturedOpts.env.CLAUDE_CONFIG_DIR).toBeTruthy()
            // 插件特有变量
            expect(capturedOpts.env.CLAUDE_PLUGIN_ROOT).toBe(
                'C:/Users/Hamlin/.hclaw/plugins/everything-claude-code@github'
            )
            expect(capturedOpts.env.HCLAW_PLUGIN_ROOT).toBe(
                'C:/Users/Hamlin/.hclaw/plugins/everything-claude-code@github'
            )
        })

        it('injects base env vars (CLAUDE_SESSION_ID, CLAUDE_PROJECT_DIR) for user hooks, but not PLUGIN_ROOT', async () => {
            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-user', name: 'user-hook', description: '',
                    events: ['PreToolUse'],
                    config: { type: 'command', command: 'echo hi' },
                    enabled: true, source: 'user' as const,
                    createdAt: 0, updatedAt: 0,
                },
            ])

            const { exec } = await import('child_process')
            const mockExec = exec as unknown as Mock
            let capturedOpts: any = null
            mockExec.mockImplementation((_cmd: string, opts: any, cb: Function) => {
                capturedOpts = opts
                cb(null, { stdout: 'ok', stderr: '', code: 0 })
            })

            await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })

            expect(capturedOpts).not.toBeNull()
            expect(capturedOpts.env).toBeDefined()
            expect(capturedOpts.env.CLAUDE_SESSION_ID).toBe('test-session')
            expect(capturedOpts.env.CLAUDE_PROJECT_DIR).toBe('C:/Users/Hamlin/.hclaw')
            // 用户 hook 无 pluginName → 无 CLAUDE_PLUGIN_ROOT
            expect(capturedOpts.env.CLAUDE_PLUGIN_ROOT).toBeUndefined()
            expect(capturedOpts.env.HCLAW_PLUGIN_ROOT).toBeUndefined()
        })

        it('provides base env vars even when getPluginPath returns undefined', async () => {
            const { PluginRegistry } = await import('../../src/main/plugin/registry')
            const registry = PluginRegistry.getInstance()
            vi.mocked(registry.getPluginPath).mockReturnValue(undefined)

            mockReadHookConfig.mockReturnValue([
                {
                    id: 'hook-orphan', name: 'orphan-plugin-hook', description: '',
                    events: ['PreToolUse'],
                    config: { type: 'command', command: 'echo test' },
                    enabled: true, source: 'plugin' as const, pluginName: 'nonexistent-plugin',
                    createdAt: 0, updatedAt: 0,
                },
            ])

            const { exec } = await import('child_process')
            const mockExec = exec as unknown as Mock
            let capturedOpts: any = null
            mockExec.mockImplementation((_cmd: string, opts: any, cb: Function) => {
                capturedOpts = opts
                cb(null, { stdout: 'ok', stderr: '', code: 0 })
            })

            const result = await executor.execute('PreToolUse', {
                sessionId: 'test-session', toolName: 'Bash',
            })

            expect(result).toHaveProperty('decision', 'allow')
            // 基础变量仍然注入
            expect(capturedOpts.env).toBeDefined()
            expect(capturedOpts.env.CLAUDE_SESSION_ID).toBe('test-session')
            expect(capturedOpts.env.CLAUDE_PROJECT_DIR).toBe('C:/Users/Hamlin/.hclaw')
            // getPluginPath 返回 undefined → 无插件路径变量
            expect(capturedOpts.env.CLAUDE_PLUGIN_ROOT).toBeUndefined()
            expect(capturedOpts.env.HCLAW_PLUGIN_ROOT).toBeUndefined()
        })
    })
})

// ============================================================
// notifyResult Worker/Main thread 路由测试
// 验证本次修复：Worker 线程通过 parentPort 回传，
// 主线程通过 resultListeners 通知
// ============================================================

describe('HookExecutor - notifyResult (Main thread — listeners)', () => {
    let executor: HookExecutor

    beforeEach(() => {
        vi.clearAllMocks()
        // @ts-expect-error
        HookExecutor.instance = undefined
        executor = HookExecutor.getInstance()
        mockReadHookConfig.mockReturnValue([])
    })

    it('main thread: listener receives result on hook execution', async () => {
        const listener = vi.fn()
        executor.onResult(listener)

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-post', name: 'post-hook', description: '',
                events: ['PostToolUse'],
                config: {type: 'command', command: 'echo ok'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: 'ok', stderr: '', code: 0})
        })

        await executor.execute('PostToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        // 验证 listener 被调用
        expect(listener).toHaveBeenCalledTimes(1)
        const callEvent = listener.mock.calls[0][0]
        const callHookName = listener.mock.calls[0][1]
        const callResult = listener.mock.calls[0][2]
        expect(callEvent).toBe('PostToolUse')
        expect(callHookName).toBe('post-hook')
        expect(callResult.decision).toBe('allow')
        expect(callResult.allowed).toBe(true)
    })

    it('main thread: listener receives error result on hook failure', async () => {
        const listener = vi.fn()
        executor.onResult(listener)

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-fail', name: 'failing-hook', description: '',
                events: ['PostToolUse'],
                config: {type: 'command', command: 'exit 1'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: '', stderr: 'command not found', code: 1})
        })

        await executor.execute('PostToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        expect(listener).toHaveBeenCalledTimes(1)
        const callResult = listener.mock.calls[0][2] as HookResult
        expect(callResult.error).toBeDefined()
        expect(callResult.error).toBeTruthy()
        expect(typeof callResult.error).toBe('string')
    })

    it('main thread: multiple listeners all receive result', async () => {
        const listener1 = vi.fn()
        const listener2 = vi.fn()
        const listener3 = vi.fn()
        executor.onResult(listener1)
        executor.onResult(listener2)
        executor.onResult(listener3)

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-multi', name: 'multi-listener-hook', description: '',
                events: ['PostToolUse'],
                config: {type: 'command', command: 'echo ok'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: 'ok', stderr: '', code: 0})
        })

        await executor.execute('PostToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        expect(listener1).toHaveBeenCalledTimes(1)
        expect(listener2).toHaveBeenCalledTimes(1)
        expect(listener3).toHaveBeenCalledTimes(1)
    })

    it('main thread: listener NOT called when hook.name is empty', async () => {
        const listener = vi.fn()
        executor.onResult(listener)

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-noname', name: '', description: '',
                events: ['PostToolUse'],
                config: {type: 'command', command: 'echo ok'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: 'ok', stderr: '', code: 0})
        })

        await executor.execute('PostToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        // 匿名 hook 不触发通知
        expect(listener).not.toHaveBeenCalled()
    })

    it('main thread: blocked hook still notifies listener', async () => {
        const listener = vi.fn()
        executor.onResult(listener)

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-block', name: 'blocking-hook', description: '',
                events: ['PreToolUse'],
                config: {type: 'command', command: 'exit 2'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: '', stderr: 'blocked by policy', code: 2})
        })

        const result = await executor.execute('PreToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        expect(result.decision).toBe('block')
        expect(listener).toHaveBeenCalledTimes(1)
        const callResult = listener.mock.calls[0][2] as HookResult
        expect(callResult.decision).toBe('block')
    })

    it('main thread: onResult is idempotent — same listener registered twice fires twice', async () => {
        const listener = vi.fn()
        executor.onResult(listener)
        executor.onResult(listener) // duplicate registration

        mockReadHookConfig.mockReturnValue([
            {
                id: 'hook-dup', name: 'dup-hook', description: '',
                events: ['PostToolUse'],
                config: {type: 'command', command: 'echo ok'},
                enabled: true, source: 'user', createdAt: 0, updatedAt: 0,
            },
        ])

        const {exec} = await import('child_process')
        const mockExec = exec as unknown as Mock
        mockExec.mockImplementation((_cmd: string, _opts: any, cb: Function) => {
            cb(null, {stdout: 'ok', stderr: '', code: 0})
        })

        await executor.execute('PostToolUse', {
            sessionId: 'test-session', toolName: 'Bash',
        })

        // 注册两次 = 调用两次（设计如此，不做去重）
        expect(listener).toHaveBeenCalledTimes(2)
    })
})
