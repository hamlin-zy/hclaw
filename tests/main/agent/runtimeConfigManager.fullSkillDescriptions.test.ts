/**
 * I5 集成断言：SystemSettings 更新经 runtimeConfigManager 广播后，
 * getSettings()?.fullSkillDescriptions 返回新值（设置链路 §8）。
 *
 * 隔离方式参照 runtimeConfigManager.convPermissionMode.db.test.ts：
 * vi.mock config → getHclawDir() 重定向到临时目录，绝不触碰真实 ~/.hclaw。
 */
import {describe, expect, it, beforeEach, vi} from 'vitest'

vi.mock('@/main/config', () => {
    const os = require('os')
    const path = require('path')
    const testDir = path.join(os.tmpdir(), 'hclaw-test-fullskilldesc-' + Date.now())
    return {
        getHclawDir: () => testDir,
        HCLAW_DIR: testDir,
        getHclawDataDir: () => path.join(testDir, 'data'),
        isSafePath: (p: string) => p.startsWith(testDir),
    }
})

import {runtimeConfigManager} from '@/main/agent/runtimeConfigManager'
import type {SystemSettings} from '@shared/types'

describe('fullSkillDescriptions 设置广播链路', () => {
    beforeEach(() => {
        // 重置内部状态，避免用例间串扰
        ;(runtimeConfigManager as any).currentSettings = null
    })

    it('缺省（未设置）时为 undefined → 上层 ?? false 兜底', () => {
        expect(runtimeConfigManager.getSettings()).toBeNull()
    })

    it('updateSettings 广播 fullSkillDescriptions=true 后 getSettings 返回 true', () => {
        const settings = {fullSkillDescriptions: true} as SystemSettings
        runtimeConfigManager.updateSettings(settings)
        expect(runtimeConfigManager.getSettings()?.fullSkillDescriptions).toBe(true)
    })

    it('updateSettings 广播 fullSkillDescriptions=false 后 getSettings 返回 false', () => {
        const settings = {fullSkillDescriptions: false} as SystemSettings
        runtimeConfigManager.updateSettings(settings)
        expect(runtimeConfigManager.getSettings()?.fullSkillDescriptions).toBe(false)
    })
})
