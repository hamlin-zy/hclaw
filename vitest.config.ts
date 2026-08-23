import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
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
      include: ['src/main/agent/common/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.config.ts']
    },
    testTimeout: 10000
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './src/shared')
    }
  }
})
