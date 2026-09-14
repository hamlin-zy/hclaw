import {describe, expect, it} from 'vitest'
import {cruise} from 'dependency-cruiser'

/**
 * shared-no-main：src/shared 的依赖边不得 resolve 到 src/main。
 *
 * 背景：src/shared 是"依赖叶子层"，被 main / preload / renderer 三侧共用；
 * 一旦 shared import main，会把 main 的进程假设（electron、worker_threads）泄漏给 renderer。
 *
 * 为什么不用 lint:deps：depcruise 配置 options.includeOnly === '^src/main'，
 * `from: ^src/shared` 的规则永远不会被求值；改扫描根为 src 会让 known-violations 基线失效。
 * 因此镜像既有先例 tests/main/deps/workerNoElectron.test.ts，用 cruise() API 自算依赖边。
 *
 * 注：cruise() 默认 tsPreCompilationDeps=false，即按 TS 编译后依赖巡航——
 * 未被使用的 import 会被 TS elide，type-only 导入同样不产生边，正合"只守运行时依赖"的口径。
 */
/**
 * 变异验证记录：
 * - 变异手法：向 src/shared 注入一条指向 src/main 的 import。
 * - 复现结论（实测）：注入未被引用的 import 不变红 —— 根因是 cruise() 默认
 *   tsPreCompilationDeps: false，TS 编译期会 elide 未使用的 import，不产生运行时依赖边；
 *   改用被引用的 import 后测试变红（offenders 非空）。
 * - 守护范围：本用例守的是「编译后仍存在的运行时依赖边」，与 spec §3.3.1 口径一致；
 *   type-only 导入被显式豁免（见 :46 的 `type-only` 过滤）。
 * - 不可静默变绿：:40 的 `expect(modules.length).toBeGreaterThan(0)` 防御断言，
 *   正则写错导致模块集为空时必须失败。
 */
describe('shared-no-main：src/shared 不得依赖 src/main', () => {
  it('src/shared 的所有非 type-only 依赖边都不 resolve 到 src/main', async () => {
    const result = await cruise(['src/shared'], {
      doNotFollow: {path: 'node_modules', dependencyTypes: ['npm']},
      includeOnly: '^src/shared|^src/main',
      tsConfig: {fileName: 'tsconfig.json'},
    })
    const modules = typeof result.output === 'string'
      ? JSON.parse(result.output).modules
      : result.output.modules

    // 防御：正则写错导致模块集为空时测试必须失败，不能静默变绿
    expect(modules.length).toBeGreaterThan(0)

    const offenders: string[] = []
    for (const m of modules) {
      for (const dep of m.dependencies ?? []) {
        if (!/^src\/main\//.test(dep.resolved)) continue
        if (dep.dependencyTypes.includes('type-only')) continue // 类型导入不产生运行时依赖
        offenders.push(`${m.source} -> ${dep.resolved} [${dep.dependencyTypes.join(',')}]`)
      }
    }
    expect(offenders).toEqual([])
    // 全量跑时与其它用例并发，dependency-cruiser 全图扫描受 CPU 竞争影响波动大，
    // 这里放宽超时避免 flaky（vitest 全局默认 10s）
  }, 60_000)
})
