/**
 * PermissionEngine 单元测试
 *
 * 覆盖 check() 决策链：
 * 1. 显式规则（allow/deny/ask、glob、bash:命令）
 * 2. auto 模式全部放行
 * 3. 细粒度权限：bash 安全命令 / 危险命令硬拦截 / 普通命令确认、
 *    file_edit/file_write 路径检查
 * 4. safe 模式兜底（非破坏性放行、破坏性拒绝）
 * 5. checkPlannedCommands、isHighRisk
 *
 * Mock 策略（风格参照 permissionRule.test.ts）：
 * - vi.mock '@/main/agent/permissions/permissionRule'，mock 单例 permissionRulesManager
 * - getContext 返回受控 mockState，applyUpdate 同步维护 mockState 模拟规则增删/模式切换
 * - DANGEROUS_COMMAND_PATTERNS / SAFE_COMMAND_PATTERNS 为真实模块，不做 mock
 * - 危险命令用字符串拼接构造，避免测试文件出现危险命令字面量
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import * as fsSync from 'fs'
import * as os from 'os'
import * as path from 'path'
import {z} from 'zod'
import {PermissionEngine} from '@/main/agent/tools/permission'
import type {Tool} from '@/main/agent/tools/types'
import type {PermissionRule, RunMode} from '@shared/types'

// ── mock 状态（vi.hoisted 保证在 vi.mock 工厂执行前就绪）──
const {mockState, applyMockUpdate} = vi.hoisted(() => {
  const state: {mode: RunMode; rules: PermissionRule[]} = {mode: 'safe', rules: []}
  return {
    mockState: state,
    applyMockUpdate: (update: any) => {
      switch (update.type) {
        case 'setMode':
          state.mode = update.mode as RunMode
          break
        case 'addRule':
          state.rules = state.rules.filter((r) => r.tool !== update.rule.tool)
          state.rules.push(update.rule)
          break
        case 'setRules': {
          const map = new Map<string, PermissionRule>()
          for (const r of update.rules) map.set(r.tool, r)
          state.rules = Array.from(map.values())
          break
        }
        case 'removeRule':
          state.rules = state.rules.filter((r) => r.tool !== update.tool)
          break
      }
      return {mode: state.mode, rules: [...state.rules]}
    },
  }
})

vi.mock('@/main/agent/permissions/permissionRule', () => ({
  permissionRulesManager: {
    getContext: vi.fn(async () => ({
      mode: mockState.mode,
      rules: [...mockState.rules],
      strippedDangerousRules: undefined,
      additionalWorkingDirectories: [],
      isBypassPermissionsModeAvailable: false,
      isAutoModeAvailable: true,
    })),
    getMode: vi.fn(async () => mockState.mode),
    getRules: vi.fn(async () => [...mockState.rules]),
    applyUpdate: vi.fn(async (update: any) => applyMockUpdate(update)),
    getDangerousPermissions: vi.fn(async () => []),
    reload: vi.fn(async () => {}),
  },
}))

/** 构造最小 Tool */
function makeTool(name: string, opts: {isDestructive?: boolean} = {}): Tool {
  return {
    name,
    description: name,
    inputSchema: z.object({}),
    execute: async () => ({success: true, output: ''}),
    requiredPermissions: [],
    isDestructive: opts.isDestructive,
  }
}

/** 构造并完成懒初始化（check 是同步方法，必须先触发 ensureInit） */
async function makeEngine(): Promise<PermissionEngine> {
  const engine = new PermissionEngine()
  await engine.getMode()
  return engine
}

function makeRule(tool: string, action: 'allow' | 'deny' | 'ask' = 'allow'): PermissionRule {
  return {tool, action}
}

function resetState(): void {
  mockState.mode = 'safe'
  mockState.rules = []
  vi.clearAllMocks()
}

describe('PermissionEngine — 基本决策链', () => {
  beforeEach(resetState)

  it('safe 模式 + 非破坏性工具自动放行', async () => {
    const engine = await makeEngine()
    expect(engine.check(makeTool('file_read'), {}).allowed).toBe(true)
  })

  it('safe 模式 + 破坏性工具（无规则）拒绝且 reason 含 is destructive', async () => {
    const engine = await makeEngine()
    const result = engine.check(makeTool('bash', {isDestructive: true}), {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('is destructive')
  })

  it('auto 模式任意工具自动放行', async () => {
    mockState.mode = 'auto'
    const engine = await makeEngine()
    expect(engine.check(makeTool('file_read'), {}).allowed).toBe(true)
    expect(engine.check(makeTool('bash', {isDestructive: true}), {command: 'whatever'}).allowed).toBe(true)
  })
})

describe('PermissionEngine — 显式规则', () => {
  beforeEach(resetState)

  it('allow 规则放行对应工具', async () => {
    mockState.rules = [makeRule('file_read', 'allow')]
    const engine = await makeEngine()
    expect(engine.check(makeTool('file_read'), {}).allowed).toBe(true)
  })

  it('deny 规则拒绝对应工具且 reason 含 denied', async () => {
    mockState.rules = [makeRule('file_read', 'deny')]
    const engine = await makeEngine()
    const result = engine.check(makeTool('file_read'), {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('denied')
  })

  it('ask 规则要求用户确认且 reason 含 confirmation', async () => {
    mockState.rules = [makeRule('file_read', 'ask')]
    const engine = await makeEngine()
    const result = engine.check(makeTool('file_read'), {})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('confirmation')
  })

  it('glob 规则（file_*）匹配多个工具，其他工具不受影响', async () => {
    const engine = await makeEngine()
    // compileGlobPattern 只在 addRule/setRules 时编译 → 必须走 setRules 而非直接注入 mockState
    await engine.setRules([makeRule('file_*', 'allow')])

    expect(engine.check(makeTool('file_read'), {}).allowed).toBe(true)
    expect(engine.check(makeTool('file_write'), {}).allowed).toBe(true)
    // 不匹配的工具走 safe 兜底（破坏性 → 拒绝），证明 glob 未误匹配
    const other = engine.check(makeTool('bash', {isDestructive: true}), {})
    expect(other.allowed).toBe(false)
    expect(other.reason).toContain('is destructive')
  })
})

describe('PermissionEngine — bash 细粒度权限', () => {
  beforeEach(resetState)

  const bash = () => makeTool('bash', {isDestructive: true})

  it('bash:git status 规则精确匹配命令，其他 git 命令需确认', async () => {
    const engine = await makeEngine()
    await engine.setRules([makeRule('bash:git status', 'allow')])

    expect(engine.check(bash(), {command: 'git status'}).allowed).toBe(true)
    const push = engine.check(bash(), {command: 'git push'})
    expect(push.allowed).toBe(false)
    expect(push.reason).toBe('command_confirm')
  })

  it('bash:git* 通配规则匹配 git 只读命令', async () => {
    const engine = await makeEngine()
    await engine.setRules([makeRule('bash:git*', 'allow')])

    expect(engine.check(bash(), {command: 'git status'}).allowed).toBe(true)
    expect(engine.check(bash(), {command: 'git log --oneline'}).allowed).toBe(true)
  })

  it('safe 模式安全命令自动放行（SAFE_COMMAND_PATTERNS 命中）', async () => {
    const engine = await makeEngine()
    expect(engine.check(bash(), {command: 'ls -la'}).allowed).toBe(true)
    expect(engine.check(bash(), {command: 'cat file'}).allowed).toBe(true)
  })

  it('危险命令硬拦截（DANGEROUS_COMMAND_PATTERNS 真实模块）', async () => {
    const engine = await makeEngine()
    const dangerous = 'rm -rf ' + '/'
    const result = engine.check(bash(), {command: dangerous})
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('硬性禁止')
  })

  it('普通命令需要确认并返回命令详情', async () => {
    const engine = await makeEngine()
    const result = engine.check(bash(), {command: 'npm install'})
    expect(result.allowed).toBe(false)
    expect(result.reason).toBe('command_confirm')
    expect(result.detail).toEqual({type: 'bash_command', command: 'npm install'})
  })
})

describe('PermissionEngine — file_edit/file_write 路径检查', () => {
  let tmpDir: string

  beforeEach(() => {
    resetState()
    tmpDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'permission-engine-test-'))
  })

  afterEach(() => {
    fsSync.rmSync(tmpDir, {recursive: true, force: true})
  })

  it('工作目录内文件放行，逃逸路径被拦截', async () => {
    const engine = await makeEngine()
    engine.setWorkingDir(tmpDir)

    const fileEdit = makeTool('file_edit')
    // 工作目录内（相对路径与子目录绝对路径）→ 放行（继续后续逻辑）
    expect(engine.check(fileEdit, {filePath: 'inside.txt'}).allowed).toBe(true)
    expect(engine.check(fileEdit, {filePath: path.join(tmpDir, 'sub', 'file.txt')}).allowed).toBe(true)

    // 逃逸工作目录 → 拦截
    const escape = engine.check(fileEdit, {filePath: path.join('..', 'outside.txt')})
    expect(escape.allowed).toBe(false)
    expect(escape.reason).toBe('path_outside_working_dir')

    // file_write 同样校验
    const fileWrite = makeTool('file_write')
    const escape2 = engine.check(fileWrite, {filePath: path.join('..', '..', 'etc', 'x')})
    expect(escape2.allowed).toBe(false)
    expect(escape2.reason).toBe('path_outside_working_dir')
  })
})

describe('PermissionEngine — checkPlannedCommands', () => {
  beforeEach(resetState)

  it('safe 模式：混合命令需要确认，危险命令被拒（不进入放行/确认列表）', async () => {
    const engine = await makeEngine()
    const result = engine.checkPlannedCommands(['git add .', 'rm -rf ' + '/'])

    expect(result.needsConfirmation).toBe(true)
    expect(result.commandsToConfirm).toContain('git add .')
    // 危险命令被内部拒绝，不会出现在确认或放行列表中
    expect(result.commandsToConfirm).not.toContain('rm -rf /')
    expect(result.allowedCommands).not.toContain('rm -rf /')
  })

  it('safe 模式：纯安全命令无规则时仍进入确认列表（后半段源码行为，不做安全前缀放行）', async () => {
    const engine = await makeEngine()
    const result = engine.checkPlannedCommands(['git status', 'ls -la'])
    expect(result.needsConfirmation).toBe(true)
    expect(result.commandsToConfirm).toEqual(['git status', 'ls -la'])
  })

  it('auto 模式：纯安全命令无需确认', async () => {
    mockState.mode = 'auto'
    const engine = await makeEngine()
    const result = engine.checkPlannedCommands(['git status', 'ls -la'])
    expect(result.needsConfirmation).toBe(false)
    expect(result.allowedCommands).toEqual(['git status', 'ls -la'])
    expect(result.confirmationMessage).toBeUndefined()
  })
})

describe('PermissionEngine — isHighRisk', () => {
  it('高危命令返回 true', () => {
    const engine = new PermissionEngine()
    expect(engine.isHighRisk('rm -rf ' + '/')).toBe(true)
  })

  it('安全命令返回 false', () => {
    const engine = new PermissionEngine()
    expect(engine.isHighRisk('ls -la')).toBe(false)
  })
})
