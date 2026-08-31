import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import {isDevMode, isViteDevServer} from '../../../src/main/utils/devMode'

describe('devMode', () => {
    const savedEnv = {...process.env}

    beforeEach(() => {
        process.env.NODE_ENV = undefined as unknown as string
        delete process.env.HCLAW_DEV_MODE
    })
    afterEach(() => {
        process.env = {...savedEnv}
    })

    it('isViteDevServer: 打包版带 --devtools 启动时为 false（避免窗口连不存在的 dev server 黑屏）', () => {
        const argv = process.argv
        process.argv = [...argv, '--devtools']
        try {
            expect(isViteDevServer()).toBe(false)
            // --devtools 只影响 isDevMode（渲染层 dev 菜单项透传用）
            expect(isDevMode()).toBe(true)
        } finally {
            process.argv = argv
        }
    })

    it('isViteDevServer: --inspect 为 true', () => {
        const argv = process.argv
        process.argv = [...argv, '--inspect']
        try {
            expect(isViteDevServer()).toBe(true)
            expect(isDevMode()).toBe(true)
        } finally {
            process.argv = argv
        }
    })
})
