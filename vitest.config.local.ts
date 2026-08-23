import {defineConfig} from 'vitest/config'
import path from 'path'

/**
 * 本地扩展配置 — 用于跑 src/main 下的单元测试。
 * 默认 vitest.config.ts 的 include 限定在 tests/，本配置扩展到整个 src/main/agent/loop/。
 *
 * 用法：npx vitest run --config vitest.config.local.ts
 *
 * 不提交到 git（可选）；或合并到主 vitest.config.ts 也可。
 */
export default defineConfig({
    test: {
        globals: true,
        environment: 'node',
        include: [
            'tests/**/*.test.ts',
            'src/main/agent/loop/**/*.test.ts',
        ],
        exclude: [
            // 手动诊断脚本：连接真实用户 DB（HCLAW_DB/CONV_ID），非 CI 常规测试，不自动收集
            '**/main/agent/ipc/*.diag.test.ts',
            '**/main/agent/ipc/*.verify.test.ts',
            '**/node_modules/**',
            '**/dist/**',
        ],
        coverage: {
            provider: 'v8',
            reporter: ['text', 'json', 'html'],
            include: ['src/main/agent/**/*.ts'],
            exclude: ['**/*.d.ts', '**/*.config.ts', '**/*.test.ts'],
        },
        testTimeout: 10000,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@shared': path.resolve(__dirname, './src/shared'),
        },
    },
})
