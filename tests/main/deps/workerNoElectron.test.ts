import {describe, expect, it} from 'vitest'
import {cruise} from 'dependency-cruiser'

/**
 * worker-no-electron：worker 侧模块的依赖闭包不得（静态/动态）引入 electron
 *
 * 背景：内置工具等运行在 Agent Worker 线程，electron 主进程 API（BrowserWindow/ipcMain 等）
 * 不可用；memoTool 曾因 memoTool → memoStore → broadcast → electron 传递依赖链炸掉
 * （症状是"数据已落盘但工具返回失败"）。
 *
 * 语义（比"禁止一切 electron 边"更精确）：
 * - 以 worker 入口为起点的传递依赖闭包内，任何指向 electron 的依赖边：
 *   - 静态 import / dynamic-import → 一律违规（worker 加载即引入风险，且容易演化为调用）
 *   - 惰性 require（dependencyTypes 含 'require'）→ 仅白名单模块豁免
 *     （均为"防御式 require + try/catch 兜底"的有意设计，新增白名单须逐个审查）
 *   - 例外：broadcast.ts 的顶层 import 属已审查设计（环境感知 isMainThread 分支，
 *     worker 内 electron 模块可解析、仅 API 调用受限），以 'reviewed' 级别豁免
 *
 * 实现说明：不用 depcruise 的 reachable 规则 + --ignore-known 基线，因为基线按
 * "worker入口 → electron"端点匹配、忽略 via 链，会连未来的新违规一起豁免，规则形同虚设；
 * reachable 规则的 to 部分也不支持按依赖类型过滤惰性 require。改为用 cruise() API
 * 取完整模块图后自行计算闭包逐边校验，结果精确且随新代码自动覆盖。
 *
 * 闭包范围：沿静态 import 边传递扩展（memoTool 故障类）。已知局限：经 dynamic-import
 * 边可达的既有主进程模块（如 powerManager → … → manager.impl）不在本规则覆盖内，
 * 属另一层架构耦合，另行治理。
 *
 * 与 .dependency-cruiser.js 的分工：lint:deps（no-circular + 基线）管循环依赖；
 * 本测试管 worker 闭包的 electron 隔离。
 */

// worker 入口清单（新增 worker 线程入口时需同步更新）
const WORKER_ENTRY_PATTERNS: RegExp[] = [
    /^src\/main\/agent\/worker\.ts$/,
    /^src\/main\/agent\/mcpWorker\.ts$/,
    /^src\/main\/channel\/worker\.ts$/,
    /^src\/main\/scheduler\/worker\.ts$/,
    /^src\/main\/repositories\/sqlite\/checkpointWorker\.ts$/,
]

// 白名单：worker 闭包内允许存在 electron 依赖边的模块（新增须逐个审查）
// - 'lazy'：仅允许防御式惰性 require（dependencyTypes 含 'require'）
// - 'reviewed'：允许任意形式的依赖边（含静态 import，须给出环境感知/兜底的设计依据）
const ELECTRON_EDGE_ALLOWLIST: Record<string, 'lazy' | 'reviewed'> = {
    'src/main/config.ts': 'lazy', // initConfigIPC 内：worker 也会间接加载本模块，electron 必须延迟加载
    'src/main/utils/llmTraceRecorder.ts': 'lazy', // 环境探测 + 主进程窗口转发，防御式 require
    'src/main/utils/opencodeHeaders.ts': 'lazy', // 版本探测，require('electron')?.app?. 链式兜底
    'src/main/auth/googleAuth.ts': 'lazy', // 仅主进程 initGoogleAuthIPC 使用；worker 只走纯 axios 刷新
    'src/main/memo/broadcast.ts': 'reviewed', // 环境感知 isMainThread 分支，worker 内仅解析不调用主进程 API
}

describe('worker-no-electron：worker 依赖闭包不得引入 electron', () => {
    it('闭包内所有 electron 依赖边均为白名单内的惰性 require', async () => {
        const cruiseResult = await cruise(
            ['src/main'],
            {
                doNotFollow: {path: 'node_modules', dependencyTypes: ['npm']},
                // electron 必须作为图节点存在，否则闭包永远无法"到达"electron
                includeOnly: '^src/main|node_modules/electron',
                tsConfig: {fileName: 'tsconfig.json'},
            },
        )
        const modules = typeof cruiseResult.output === 'string'
            ? JSON.parse(cruiseResult.output).modules
            : cruiseResult.output.modules
        const bySource = new Map<string, {source: string; dependencies: Array<{resolved: string; dependencyTypes: string[]}>}>(
            modules.map((m: {source: string; dependencies: Array<{resolved: string; dependencyTypes: string[]}>}) => [m.source, m]),
        )

        // 从 worker 入口出发计算静态传递依赖闭包（沿 import 边；环由 visited 集合兜底）
        const closure = new Set<string>()
        const walk = (source: string): void => {
            if (closure.has(source)) return
            closure.add(source)
            for (const dep of bySource.get(source)?.dependencies ?? []) {
                if (dep.dependencyTypes.includes('import') && bySource.has(dep.resolved)) walk(dep.resolved)
            }
        }
        for (const m of modules) {
            if (WORKER_ENTRY_PATTERNS.some(re => re.test(m.source))) walk(m.source)
        }

        // 防御：入口正则写错导致闭包为空时测试必须失败，不能静默变绿
        expect(closure.size).toBeGreaterThan(50)
        for (const m of modules) {
            if (WORKER_ENTRY_PATTERNS.some(re => re.test(m.source))) {
                expect(closure.has(m.source), `worker 入口未进入闭包: ${m.source}`).toBe(true)
            }
        }

        // 逐边校验闭包内指向 electron 的依赖
        const offenders: string[] = []
        for (const source of closure) {
            for (const dep of bySource.get(source)?.dependencies ?? []) {
                if (!/^node_modules\/electron/.test(dep.resolved)) continue
                const allowMode = ELECTRON_EDGE_ALLOWLIST[source]
                const isLazyRequire = dep.dependencyTypes.includes('require')
                if (allowMode === 'reviewed') continue
                if (allowMode === 'lazy' && isLazyRequire) continue
                offenders.push(
                    `${source} -> ${dep.resolved} [${dep.dependencyTypes.join(',')}]` +
                    (isLazyRequire ? '（惰性 require 但模块不在白名单）' : '（静态/动态引入 electron）'),
                )
            }
        }

        expect(offenders).toEqual([])
    })
})
