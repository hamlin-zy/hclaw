/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    // 注意：worker 侧依赖闭包的 electron 隔离规则（worker-no-electron）不在此文件中——
    // reachable 规则配合 --ignore-known 基线会按"worker入口 → electron"端点匹配、忽略 via 链，
    // 连未来的新违规一起豁免，规则形同虚设。该规则由
    // tests/main/deps/workerNoElectron.test.ts 用 cruise() API 实现（惰性 require 白名单制）。
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment:
                '禁止新增循环依赖。既有循环通过 .dependency-cruiser-known-violations.json ' +
                '基线豁免（由 npm run lint:deps 中的 --ignore-known 载入）；任何新增/扩大循环都会失败。\n' +
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
