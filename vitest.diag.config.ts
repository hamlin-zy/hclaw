import { defineConfig } from 'vitest/config'
import path from 'path'

// 手动诊断专用配置：npm run diag:memory 使用。
// 与 vitest.config.ts 的区别仅在于不排除 *.diag.test.ts（含超时放宽）。
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // worker 进程不继承主进程的 --expose-gc，需在池级别显式注入（Vitest 4 顶层 execArgv）
    execArgv: ['--expose-gc'],
    testTimeout: 180_000,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared')
    }
  }
})
