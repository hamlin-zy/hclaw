/**
 * 设置默认值常量测试
 *
 * 覆盖 851eab6（默认最大 Token 数 8000 → 50000）统一为 DEFAULT_MAX_TOKENS 常量的约定：
 * - 常量值 = 50000
 * - 各默认设置文件引用常量而非硬编码 50000（避免将来改默认值时漏改）
 */
import {describe, expect, it} from 'vitest'
import {readFileSync} from 'fs'
import {resolve} from 'path'
import {DEFAULT_MAX_TOKENS} from '@shared/types/settings'

const PROJECT_ROOT = resolve(__dirname, '../../')

describe('DEFAULT_MAX_TOKENS', () => {
    it('默认最大 Token 数为 50000', () => {
        expect(DEFAULT_MAX_TOKENS).toBe(50000)
    })

    it('默认设置文件引用常量而非硬编码数字', () => {
        const files = [
            'src/main/agent/loop/execute.ts',
            'src/main/agent/manager.impl.ts',
            'src/main/agent/worker.ts',
            'src/renderer/stores/settingsStore.ts',
        ]
        for (const file of files) {
            const content = readFileSync(resolve(PROJECT_ROOT, file), 'utf8')
            // 默认值处应引用 DEFAULT_MAX_TOKENS
            expect(content).toContain('DEFAULT_MAX_TOKENS')
            // 不应再出现硬编码的 50000 默认值
            expect(content).not.toContain('?? 50000')
            expect(content).not.toMatch(/defaultMaxTokens:\s*50000/)
        }
    })
})
