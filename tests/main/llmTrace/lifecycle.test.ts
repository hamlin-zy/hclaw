// tests/main/llmTrace/lifecycle.test.ts
import {describe, it, expect} from 'vitest'
import {clearTraceLogs, waitForIdleWriters, setRecordingEnabled, __setDepsForTest} from '../../../src/main/utils/llmTraceRecorder'

describe('清空安全顺序', () => {
    it('clearTraceLogs 等待在途写完成后才删除', async () => {
        const {mkdtempSync, rmSync, existsSync, writeFileSync} = await import('fs')
        const {tmpdir} = await import('os')
        const path = await import('path')
        const dir = mkdtempSync(path.join(tmpdir(), 'clear-'))
        writeFileSync(path.join(dir, 'keep.txt'), 'x')
        __setDepsForTest({rootDir: () => dir})
        await clearTraceLogs()
        expect(existsSync(dir)).toBe(false)
        rmSync(dir, {recursive: true, force: true})
    })
})
