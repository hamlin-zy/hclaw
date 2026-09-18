/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    // 注意：worker 侧依赖闭包的 electron 隔离规则（worker-no-electron）不在此文件中——
    // reachable 规则配合 --ignore-known 基线会按"worker入口 → electron"端点匹配、忽略 via 链，
    // 连未来的新违规一起豁免，规则形同虚设。该规则由
    // tests/main/deps/workerNoElectron.test.ts 用 cruise() API 实现（惰性 require 白名单制）。
    //
    // 基线的匹配语义（已核对 node_modules/dependency-cruiser/src/analyze/summarize/
    // is-same-violation.mjs:5-18）：cycle 违规比的是「cycle 数组长度相同 + 模块名集合互相包含」，
    // **不是** from/to 端点对；只有非 cycle 违规才退化为 from/to 比较。
    // 而 depcruise 报出的具体环是 DFS 找到的第一条回到起点的路径（src/analyze/derive/circular.mjs），
    // 不是最短环——同一个 SCC 内任意增删/重排一条边都可能改变报告的 cycle 集合，即"集合等价即豁免 +
    // 集合本身不稳定"。因此本文件中的 no-circular + 基线只是**存量账本**，不再承担"是否劣化"的主判据：
    // 主判据已换成 tests/main/deps/circularBoundary.test.ts（SCC 规模上限 + 禁入环模块，自行 Tarjan）
    // 与 tests/main/deps/baselineRatchet.test.ts（条目数/环长/模块集合冻结）。
    // 见 docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md。
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment:
                '禁止新增循环依赖。既有循环通过 .dependency-cruiser-known-violations.json ' +
                '基线豁免（由 npm run lint:deps 中的 --ignore-known 载入）；任何新增/扩大循环都会失败。\n' +
                '豁免匹配按「模块集合 + 环长」而非端点对（见文件头注释），故基线是存量账本、' +
                '不能当作"不会再劣化"的保证；结构不变量由 tests/main/deps 下的测试守护。\n' +
                '基线再生成命令（仅在有意调整既有循环时执行）：\n' +
                '  npx depcruise --config .dependency-cruiser.js src/main --output-type baseline > .dependency-cruiser-known-violations.json',
            from: {},
            to: {
                circular: true,
            },
        },
    ],
    options: {
        doNotFollow: {
            path: 'node_modules',
            dependencyTypes: ['npm'],
        },
        includeOnly: '^src/main',
        exclude: {
            path: 'src/main/agent/mcpWorker.ts',
        },
        tsConfig: { fileName: 'tsconfig.json' },
    },
};
