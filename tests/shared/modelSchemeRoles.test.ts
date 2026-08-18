import {describe, expect, it} from 'vitest'
import {createDefaultRoles, getModelRoleInfo, MODEL_ROLE_INFO} from '@/shared/modelSchemeHelpers'
import type {ModelRole} from '@shared/types'

const FIXED_ROLES: ModelRole[] = [
    'primary', 'lightweight', 'reasoning',
    'image_understanding', 'audio_understanding', 'video_understanding',
]

const FIXED_DISPLAY_NAMES: Record<string, string> = {
    primary: '主力模型',
    lightweight: '轻量模型',
    reasoning: '推理模型',
    image_understanding: '图像理解',
    audio_understanding: '音频理解',
    video_understanding: '视频理解',
}

describe('固定 6 角色模型', () => {
    it('MODEL_ROLE_INFO 恰好 6 键，无生成类死角色', () => {
        expect(Object.keys(MODEL_ROLE_INFO).sort()).toEqual([...FIXED_ROLES].sort())
    })

    it('displayName 完全固定为内置中文名', () => {
        for (const role of FIXED_ROLES) {
            expect(MODEL_ROLE_INFO[role].name).toBe(FIXED_DISPLAY_NAMES[role])
        }
    })

    it('createDefaultRoles 返回 6 个固定角色，含 video_understanding', () => {
        const roles = createDefaultRoles()
        expect(roles.map(r => r.role).sort()).toEqual([...FIXED_ROLES].sort())
        const video = roles.find(r => r.role === 'video_understanding')
        expect(video).toBeDefined()
        expect(video!.modelType).toBe('video')
        expect(video!.enabled).toBe(false)
    })

    it('getModelRoleInfo 对任意固定角色返回图标', () => {
        for (const role of FIXED_ROLES) {
            expect(getModelRoleInfo(role).icon.length).toBeGreaterThan(0)
        }
    })
})
