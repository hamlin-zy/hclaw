import {describe, expect, it} from 'vitest'
import {cruise} from 'dependency-cruiser'

/**
 * lazy-require-registry：src/main 内「指向项目文件的 CJS 惰性 require 边」白名单制。
 *
 * 为什么需要它：这条边在静态依赖图里与顶层 import 等价（depcruise 一样会把它算进环，
 * 见 .dependency-cruiser.js 的说明），但它在运行时**推迟到调用点才求值**——于是它既能
 * 被用来"临时绕开"依赖方向约束，也能被用来做真正必要的事（worker 内不能静态引入
 * electron、避免模块初始化顺序/循环）。两种意图在 diff 里长得一模一样，只能靠书面理由区分。
 * 本测试要求每条这样的边都登记在下方 allowlist 并写明理由；新增未登记 = 失败。
 *
 * 它不是环检测（环由 lint:deps + tests/main/deps/circularBoundary.test.ts 管），
 * 也不覆盖 `await import()`（depcruise 无法区分函数内 dynamic-import 与顶层 import，
 * src/main 内现有 50+ 处、且属于本仓主流的按需加载写法，逐个登记只会稀释信号）。
 */

/** worker 侧入口不在静态闭包覆盖内，与其它 deps 测试保持一致地排除 */
const EXCLUDE_MCP_WORKER = {path: 'src/main/agent/mcpWorker.ts'}

/**
 * 允许保留的惰性 require 边（key = `from -> to`）。
 * 新增必须在此登记并写明理由；删除后本清单也要同步删除（陈旧条目同样会失败，
 * 以免清单退化成"永远为真"的摆设）。
 */
const ALLOWED_LAZY_REQUIRES: Record<string, string> = {
    'src/main/auth/googleAuth.ts -> src/main/window.ts':
        'getMainWindow 仅主进程 OAuth 回调使用；worker 侧只走纯 axios 刷新，不得静态引入 electron',
    'src/main/utils/llmTraceRecorder.ts -> src/main/repositories/sqlite/llmProviderRepository.ts':
        '自定义请求头数据源：首次记录 trace 时才建 repo，避免顶层依赖 repositories',
    'src/main/agent/tools/builtin/agentTool.ts -> src/main/window.ts':
        'agentTool 运行在 MCP Worker 上下文，顶层 import window.ts 会把 electron 拉进 worker bundle',
    'src/main/agent/tools/builtin/sessionHandoffTool.ts -> src/main/window.ts':
        '同上：sessionHandoffTool 运行在 MCP Worker 上下文',
    'src/main/channel/adapters/mediaUtils.ts -> src/main/hclawPaths.ts':
        '路径能力（叶子）按需加载，维持既有求值时机与 worker 侧加载顺序',
    'src/main/config/ensureConfigLayout.ts -> src/main/repositories/sqlite/index.ts':
        '数据迁移专用（迁移自 config.ts），沿用原有的延迟时机',
    'src/main/ipc/configIPC.ts -> src/main/utils/restart.ts':
        'app-restart handler 使用：restart.ts 顶层 import electron，需延迟加载（迁移自 config.ts）',
    'src/main/ipc/configIPC.ts -> src/main/workspace/gitBranch.ts':
        'git 分支监听使用：gitBranch → windowBroadcast 顶层 import electron，需延迟加载（迁移自 config.ts）',
    'src/main/repo/ipc.ts -> src/main/agent/agentRegistry.ts':
        'collectCapabilityInputs 收集能力清单时按需取注册表，避免顶层装配顺序耦合',
    'src/main/repo/ipc.ts -> src/main/agent/skills/index.ts':
        '同上：collectCapabilityInputs 内按需取 skillRegistry',
    'src/main/repo/ipc.ts -> src/main/plugin/registry.ts':
        '同上：collectCapabilityInputs 内按需取 PluginRegistry',
    'src/main/scheduler/index.ts -> src/main/window.ts':
        'requireMainWindow：worker 闭包不得静态引入 electron',
}

interface CruiseModule {
    source: string
    dependencies: Array<{resolved: string; dependencyTypes: string[]}>
}

describe('lazy-require-registry：惰性 require 边必须逐个登记', () => {
    it('src/main 内指向项目文件的 CJS require 边与 allowlist 完全一致', async () => {
        const cruiseResult = await cruise(
            ['src/main'],
            {
                doNotFollow: {path: 'node_modules', dependencyTypes: ['npm']},
                includeOnly: '^src/main',
                exclude: EXCLUDE_MCP_WORKER,
                tsConfig: {fileName: 'tsconfig.json'},
            },
        )
        const modules: CruiseModule[] = typeof cruiseResult.output === 'string'
            ? JSON.parse(cruiseResult.output).modules
            : cruiseResult.output.modules

        // 守卫：图规模异常（配置/正则写错）时必须失败，不能静默变绿
        expect(modules.length).toBeGreaterThan(100)

        const found = new Set<string>()
        for (const m of modules) {
            for (const dep of m.dependencies) {
                if (!dep.dependencyTypes.includes('require')) continue
                if (!dep.resolved?.startsWith('src/')) continue
                found.add(`${m.source} -> ${dep.resolved}`)
            }
        }

        const declared = new Set(Object.keys(ALLOWED_LAZY_REQUIRES))
        const unregistered = [...found].filter(k => !declared.has(k)).sort()
        const stale = [...declared].filter(k => !found.has(k)).sort()

        expect(
            unregistered,
            '出现未登记的惰性 require 边：请说明为何不能改用顶层 import/依赖注入，'
            + '并在 tests/main/deps/lazyRequireRegistry.test.ts 的 ALLOWED_LAZY_REQUIRES 中登记',
        ).toEqual([])
        expect(
            stale,
            'allowlist 中的条目在图里已不存在：请一并删除，避免清单退化为永远为真的摆设',
        ).toEqual([])
    // 与其它 deps 测试同因：全量跑时与其它用例并发，depcruise 全图扫描受 CPU 竞争影响波动大
    }, 60_000)
})
