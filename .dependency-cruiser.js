/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
    forbidden: [
        {
            name: 'no-circular',
            severity: 'error',
            comment:
                '禁止新增循环依赖。既有循环（27 个）通过 .dependency-cruiser-known-violations.json ' +
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
