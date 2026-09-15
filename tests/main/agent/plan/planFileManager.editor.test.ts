/**
 * PlanFileManager 编辑器解析 · 回归护栏
 *
 * 背景：旧 `resolveEditor` 对候选列表逐个 `spawn(ed, ['--version'])` 并用**同步** try/catch
 * 判断“是否抛错”，但 spawn 对 ENOENT 只异步 emit('error')、不抛同步异常 → try/catch 永不
 * 触发、循环恒在首项 `code` 返回（`auto ≡ code`），且每个探测进程都挂一个空 error 监听，
 * 把 ENOENT 静默吞掉。收敛为确定性纯函数后：
 *   1. `auto` 仍解析为 `code`（可观测行为逐字不变）；
 *   2. 不再产生任何 `--version` 探测进程（副作用收敛的唯一差异，用 spawn 调用形参锁定）。
 */
import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

const spawnMock = vi.hoisted(() => vi.fn(() => ({unref: () => {}, pid: 4242})))
vi.mock('child_process', () => ({spawn: spawnMock}))
// config 链会拉起 repositories/sqlite（测试环境无 DB 且存在模块初始化循环）→ 仅需 getHclawDir
vi.mock('../../../../src/main/config', () => ({
    getHclawDir: () => process.env.TEMP || '/tmp',
}))

import {
    resolveEditorCommand,
    createPlanFileManager,
} from '../../../../src/main/agent/plan/planFileManager'

describe('resolveEditorCommand（纯函数，不 spawn）', () => {
    it("auto → 'code'（与旧实现实际行为一致：探测循环恒命中首项）", () => {
        expect(resolveEditorCommand('auto')).toBe('code')
        expect(spawnMock).not.toHaveBeenCalled()
    })

    it('显式编辑器名原样透传（不做任何校验/归一化）', () => {
        for (const ed of ['vim', 'vi', 'nano', 'subl', 'code-insiders', 'webstorm'] as const) {
            expect(resolveEditorCommand(ed)).toBe(ed)
        }
        expect(spawnMock).not.toHaveBeenCalled()
    })
})

describe('openInEditor 不再产生探测进程', () => {
    let tmpDir: string

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-fm-'))
        spawnMock.mockClear()
    })

    afterEach(() => {
        fs.rmSync(tmpDir, {recursive: true, force: true})
    })

    it("auto：只 spawn 一次（启动编辑器），且参数不含 `--version`", () => {
        // 预置项目本地 PLAN.md → getPlanFilePath 走本地路径，避免写入用户主目录
        const localDir = path.join(tmpDir, '.hclaw')
        fs.mkdirSync(localDir, {recursive: true})
        const localPlan = path.join(localDir, 'PLAN.md')
        fs.writeFileSync(localPlan, '# plan', 'utf-8')

        const result = createPlanFileManager(tmpDir).openInEditor('auto')

        expect(result.success).toBe(true)
        expect((result as {editor: string}).editor).toBe('code')
        expect((result as {pid?: number}).pid).toBe(4242)

        expect(spawnMock).toHaveBeenCalledTimes(1)
        const [cmd, args] = spawnMock.mock.calls[0] as unknown as [string, string[]]
        expect(cmd).toBe('code')
        expect(args).toEqual([localPlan])
        expect(args).not.toContain('--version')
    })
})
