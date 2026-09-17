/**
 * resetFieldsToDefault 测试（spec §5.3）：
 * 页面级字段集重置：只动路径内字段；基座 = pendingSettings || settings；不触发写盘。
 * （替换原 resetCategoryToDefault 分类重置测试；不得再引用已删除 API）
 */
import {describe, it, expect, vi, beforeEach} from 'vitest'
import {useSettingsStore, DEFAULT_SETTINGS} from '../../../src/renderer/stores/settingsStore'
import {PAGE_FIELD_SETS} from '../../../src/renderer/components/settings/primitives/fieldSets'

describe('resetFieldsToDefault（页面级字段集重置）', () => {
    const configWriteMock = vi.fn(async () => true)

    beforeEach(() => {
        configWriteMock.mockClear()
        ;(globalThis as any).window = {electronAPI: {configWrite: configWriteMock}}
        useSettingsStore.setState({
            settings: {
                ...DEFAULT_SETTINGS,
                ui: {...DEFAULT_SETTINGS.ui, theme: 'dark', background: {enabled: true, imagePath: 'bg.png', overlay: 60, blur: 20}},
                fullSkillDescriptions: true,
            },
            pendingSettings: null,
            isDirty: false,
        })
    })

    it('general 字段集：只复位分配字段；theme/background 与其他字段保留；不写盘', () => {
        useSettingsStore.getState().updatePending('agent', {maxTurns: 999}) // 制造无关 pending
        useSettingsStore.getState().resetFieldsToDefault([...PAGE_FIELD_SETS.general])

        const s = useSettingsStore.getState()
        const p = s.pendingSettings!
        expect(p.agent.defaultPermissionMode).toBe('safe')
        expect(p.agent.defaultDisplayMode).toBe('detailed')
        expect(p.linkOpening!.mode).toBe('ask')
        expect(p.fullSkillDescriptions).toBeUndefined()   // 缺省 = 关闭
        expect(p.agent.maxTurns).toBe(999)                // 未列入字段集 → 保留
        expect(p.ui.theme).toBe('dark')                   // 外观字段不在 general 集
        expect(p.ui.background).toEqual({enabled: true, imagePath: 'bg.png', overlay: 60, blur: 20})
        expect(s.isDirty).toBe(true)
        expect(configWriteMock).not.toHaveBeenCalled()    // 重置只进 pending
    })

    it('appearance 字段集：theme/background 整体复位到默认', () => {
        useSettingsStore.getState().resetFieldsToDefault([...PAGE_FIELD_SETS.appearance])
        const p = useSettingsStore.getState().pendingSettings!
        expect(p.ui.theme).toBe('system')
        expect(p.ui.background).toEqual(DEFAULT_SETTINGS.ui.background)
    })

    it('agent 字段集：含子 Agent 字段，但保留 defaultPermissionMode/DefaultDisplayMode（归 general）', () => {
        useSettingsStore.setState({
            settings: {
                ...useSettingsStore.getState().settings,
                agent: {...DEFAULT_SETTINGS.agent, maxTurns: 1, defaultPermissionMode: 'auto', defaultDisplayMode: 'compact'},
            },
        })
        useSettingsStore.getState().resetFieldsToDefault([...PAGE_FIELD_SETS.agent])
        const p = useSettingsStore.getState().pendingSettings!
        expect(p.agent.maxTurns).toBe(500)
        expect(p.agent.loopDetection).toEqual(DEFAULT_SETTINGS.agent.loopDetection)
        expect(p.subagent!.maxConcurrency).toBe(3)
        expect(p.subagent!.maxDepth).toBe(3)
        expect(p.agent.defaultPermissionMode).toBe('auto')  // 不在 agent 字段集 → 保留
        expect(p.agent.defaultDisplayMode).toBe('compact')
    })

    it('pending 基座：已有 pending 时在其上重置，不退回已保存值', () => {
        useSettingsStore.getState().updatePending('model', {defaultTemperature: 1.2})
        useSettingsStore.getState().resetFieldsToDefault(['model.defaultTemperature'])
        expect(useSettingsStore.getState().pendingSettings!.model.defaultTemperature).toBe(0)
    })

    it('resetAllToDefault：七分类全复位 + fullSkillDescriptions 复位 undefined', () => {
        useSettingsStore.getState().resetAllToDefault()
        const s = useSettingsStore.getState()
        const p = s.pendingSettings!
        expect(p.agent).toEqual(DEFAULT_SETTINGS.agent)
        expect(p.model).toEqual(DEFAULT_SETTINGS.model)
        expect(p.ui).toEqual(DEFAULT_SETTINGS.ui)
        expect(p.subagent).toEqual(DEFAULT_SETTINGS.subagent)
        expect(p.channels).toEqual(DEFAULT_SETTINGS.channels)
        expect(p.linkOpening).toEqual(DEFAULT_SETTINGS.linkOpening)
        expect(p.shortcuts).toEqual(DEFAULT_SETTINGS.shortcuts)
        expect(p.fullSkillDescriptions).toBeUndefined()
        expect(s.isDirty).toBe(true)
    })
})
