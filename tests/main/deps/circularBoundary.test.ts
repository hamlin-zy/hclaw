import {describe, expect, it} from 'vitest'
import {cruise} from 'dependency-cruiser'

/**
 * circular-boundary：结构性循环依赖不变量（模块强连通分量 SCC）
 *
 * 背景：src/main/config.ts 曾同时扮演「路径能力 / 仓库装配 + IPC / 运行时配置桥」三角色，
 * 导致 repositories/sqlite/index.ts 等为了 getHclawDir 反向 import config.ts，25 个模块塌进
 * 一个大 SCC（外加 SCC#2 的 6 个模块，共 31 个模块在环里）。大 SCC 会让 depcruise 的
 * 「DFS 首环」报告随任意边的增删/重排而漂移，`.dependency-cruiser-known-violations.json`
 * 基线因此反复出现"改一处、红一片"，门禁信噪比趋零。
 * 见 docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md。
 *
 * 实现说明：不用 depcruise 的 no-circular 输出（`circular.mjs` 只给 DFS 找到的第一条回到
 * 起点的路径，不是最短环，集合不稳定），改为用 cruise() API 取完整模块图后自行 Tarjan
 * 求 SCC，断言"哪些模块不允许出现在环里"+"环不能变大"这两类结构事实。
 *
 * 阈值来源（P1/P2 落地后实测，CLI: `npx depcruise --config .dependency-cruiser.js src/main`）：
 * - 改动前：SCC 尺寸 [25, 6]，入环模块 31
 * - P1（路径能力下沉到叶子 src/main/hclawPaths.ts）后：SCC 尺寸 [11, 6]，入环 17
 * - P2（其余 getHclawDir/getHclawDataDir 导入者切到叶子，切断 config.ts 全部反向边）后：
 *   SCC 尺寸 [6, 3]，入环 9 → MAX_SCC_SIZE = 6、MAX_IN_CYCLE_TOTAL = 9（实测值，勿照抄方案文档里的预估）
 *   残留的两个分量：#1 {agent/manager*, startAgentCore, channel/*, utils/llmCallLogStore}（6，有意为之的
 *   dynamic-import 设计，明确不拆）、#2 {window, attention, tray}（3，UI 联动双向引用）
 * - P3（initConfigIPC → src/main/ipc/configIPC.ts、ensureConfigLayout → src/main/config/ensureConfigLayout.ts，
 *   config.ts 退化为纯 re-export 门面）后复核：SCC 尺寸仍为 [6, 3]、入环 9，环集合逐条未变（313 模块 / 840 边）
 * - 后续收紧方向：若通过拆卸 UI 联动把 #2 也解开，再下调阈值。
 *   SCC#2 的 6 模块（agent manager 环）为设计意图，仅用 MAX_SCC_SIZE 锁其不再变大。
 *
 * 与 workerNoElectron.test.ts 的分工：那个测试管 worker 闭包的 electron 隔离；
 * 本测试管主进程依赖图的强连通分量。纯静态图分析、无计时/无并发/无 IO 竞争，CI 稳定。
 */

/** 所有 size>1 的 SCC，其尺寸上限（P2 实测值） */
const MAX_SCC_SIZE = 6

/** 入环模块总数上限（P2 实测值 9；companion-apps 窗口入口接入后：tray → configWindow
 *  （其经 dynamic import 引 window）使 SCC#2 {window, attention, tray} 扩为 4 模块，有意放宽至 10） */
const MAX_IN_CYCLE_TOTAL = 10

/** 图规模守卫阈值：正则/配置写错导致图塌成几个模块时，测试必须失败而不是静默变绿 */
const MIN_MODULE_COUNT = 100

/**
 * 禁止出现在任何 size>1 SCC（环）内的模块（结构性、精确表达架构意图）。
 */
const FORBIDDEN_IN_CYCLE: Array<{re: RegExp; why: string}> = [
    {
        re: /^src\/main\/config\.ts$/,
        why: 'config.ts 已退化为纯 re-export 门面（路径能力→hclawPaths，布局→config/ensureConfigLayout，IPC→ipc/configIPC）；它一旦入环，说明又变成了下层模块的依赖汇点',
    },
    {
        re: /^src\/main\/config\/ensureConfigLayout\.ts$/,
        why: 'ensureConfigLayout 是启动期装配模块，只应由主进程装配根（src/main/index.ts）单向调用',
    },
    {
        re: /^src\/main\/ipc\/configIPC\.ts$/,
        why: 'configIPC 是配置/workspace 的 IPC 注册模块，只应由主进程装配根（src/main/index.ts）单向调用',
    },
    {
        re: /^src\/main\/repositories\//,
        why: 'repository 层是数据访问叶子，仅可单向依赖下层；入环说明又出现了指向装配/上层模块的反向边',
    },
    {
        re: /^src\/main\/hclawPaths\.ts$/,
        why: 'hclawPaths 是只依赖 node 内置模块的叶子（路径/目录能力），必须恒为叶子，不得参与任何环',
    },
]

interface CruiseModule {
    source: string
    dependencies: Array<{resolved: string; dependencyTypes: string[]}>
}

/** Tarjan 求强连通分量（仅统计 src/* 内部边） */
function findStronglyConnectedComponents(modules: CruiseModule[]): string[][] {
    const adjacency = new Map<string, string[]>()
    const known = new Set(modules.map(m => m.source))
    for (const m of modules) {
        adjacency.set(
            m.source,
            m.dependencies
                .filter(d => d.resolved && known.has(d.resolved))
                .map(d => d.resolved),
        )
    }

    const index = new Map<string, number>()
    const lowLink = new Map<string, number>()
    const onStack = new Set<string>()
    const stack: string[] = []
    const components: string[][] = []
    let counter = 0

    const strongConnect = (v: string): void => {
        index.set(v, counter)
        lowLink.set(v, counter)
        counter++
        stack.push(v)
        onStack.add(v)
        for (const w of adjacency.get(v) ?? []) {
            if (!index.has(w)) {
                strongConnect(w)
                lowLink.set(v, Math.min(lowLink.get(v)!, lowLink.get(w)!))
            } else if (onStack.has(w)) {
                lowLink.set(v, Math.min(lowLink.get(v)!, index.get(w)!))
            }
        }
        if (lowLink.get(v) === index.get(v)) {
            const component: string[] = []
            let w: string
            do {
                w = stack.pop() as string
                onStack.delete(w)
                component.push(w)
            } while (w !== v)
            if (component.length > 1) components.push(component)
        }
    }

    for (const source of adjacency.keys()) {
        if (!index.has(source)) strongConnect(source)
    }
    return components
}

describe('circular-boundary：主进程依赖图的结构性循环不变量', () => {
    it('SCC 规模与禁入环模块符合不变量', async () => {
        const cruiseResult = await cruise(
            ['src/main'],
            {
                doNotFollow: {path: 'node_modules', dependencyTypes: ['npm']},
                includeOnly: '^src/main',
                exclude: {path: 'src/main/agent/mcpWorker.ts'},
                tsConfig: {fileName: 'tsconfig.json'},
            },
        )
        const modules: CruiseModule[] = typeof cruiseResult.output === 'string'
            ? JSON.parse(cruiseResult.output).modules
            : cruiseResult.output.modules

        // 守卫：图规模异常（配置/正则写错导致空图或只剩几模块）时必须失败
        expect(modules.length).toBeGreaterThan(MIN_MODULE_COUNT)

        const components = findStronglyConnectedComponents(modules)
        const sizes = components.map(c => c.length).sort((a, b) => b - a)

        // 1) 禁止入环的模块
        for (const {re, why} of FORBIDDEN_IN_CYCLE) {
            const offenders = components.filter(c => c.some(m => re.test(m))).flat()
            expect(
                offenders.filter(m => re.test(m)),
                `以下模块进入了环（SCC）：${offenders.join(', ')}\n理由：${why}`,
            ).toEqual([])
        }

        // 2) 最大 SCC 规模
        const maxSccSize = sizes.length > 0 ? sizes[0] : 0
        expect(
            maxSccSize,
            `最大 SCC 规模 ${maxSccSize} 超过上限 ${MAX_SCC_SIZE}，SCC 尺寸=[${sizes.join(', ')}]`,
        ).toBeLessThanOrEqual(MAX_SCC_SIZE)

        // 3) 入环模块总数
        const inCycleTotal = sizes.reduce((sum, n) => sum + n, 0)
        expect(
            inCycleTotal,
            `入环模块总数 ${inCycleTotal} 超过上限 ${MAX_IN_CYCLE_TOTAL}，SCC 尺寸=[${sizes.join(', ')}]`,
        ).toBeLessThanOrEqual(MAX_IN_CYCLE_TOTAL)
    // 与 workerNoElectron.test.ts 同因：全量跑时与其它用例并发，depcruise 全图扫描受 CPU 竞争
    // 影响波动大；单独跑约 2s，这里放宽超时避免 flaky（vitest 全局默认 10s）
    }, 60_000)
})
