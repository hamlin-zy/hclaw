// 守门（回归）：启动初始化不得把 'safe' 落库到 system_settings.permission_mode。
// 该键是「全局默认模式」的唯一权威键；启动无条件 setMode('safe') 会覆盖用户配置的 auto
//（permissionRule.applyUpdate → saveToDatabase），导致重启后无会话级覆盖的历史会话回退安全模式。
import {describe, it, expect} from 'vitest'
import {readFileSync} from 'node:fs'
import path from 'node:path'

const src = readFileSync(path.resolve(__dirname, '../../../src/main/agent/index.ts'), 'utf8')

/** 截取 initAgent 函数体（内部语句均有缩进，故首个行首 `}` 即函数结束） */
const initAgentBody = src.match(/export async function initAgent[\s\S]*?\n\}/)?.[0] ?? ''

describe('启动初始化：权限模式不得落库', () => {
    it('initAgent 内不存在 permissionEngine.setMode( 调用（启动写库会覆盖 system_settings.permission_mode 用户配置）', () => {
        expect(initAgentBody).not.toMatch(/permissionEngine\.setMode\s*\(/)
    })

    it('initAgent 调用 ensureReady() 懒加载已持久化的全局默认', () => {
        expect(initAgentBody).toMatch(/permissionEngine\.ensureReady\s*\(/)
    })
})
