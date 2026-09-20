import fs from 'fs'
import path from 'path'
import {getHclawDir} from '../hclawPaths'
import {logger} from '../agent/logger'
import {hashName} from '../lib/hashName'
import type {CompanionApp, CompanionAppsConfig} from '../../shared/types/companion'

/** 获取 companion-apps.json 文件路径（与 mcp.json 同级） */
export function getCompanionConfigPath(): string {
    return path.join(getHclawDir(), 'companion-apps.json')
}

/** 读配置：文件不存在 / parse 失败 / apps 非数组 → []（与 readMcpConfig 同模式） */
export function readCompanionConfig(): CompanionApp[] {
    const filePath = getCompanionConfigPath()
    try {
        if (!fs.existsSync(filePath)) return []
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CompanionAppsConfig
        if (!raw || !Array.isArray(raw.apps)) return []
        return raw.apps
    } catch (err) {
        logger.warn('companion-config-parse-failed', {error: String(err)})
        return []
    }
}

/** 原子写入：先写同目录临时文件再 rename（同卷保证 rename 原子性） */
function writeCompanionConfigAtomic(apps: CompanionApp[]): void {
    const filePath = getCompanionConfigPath()
    const tmpPath = `${filePath}.tmp`
    fs.writeFileSync(tmpPath, JSON.stringify({apps} satisfies CompanionAppsConfig, null, 2), 'utf8')
    fs.renameSync(tmpPath, filePath)
}

/**
 * 按 id upsert。返回落库后的 id。
 * - input.id 命中已有项 → 原地更新，id 不变
 * - 否则新增：id = hashName(name)；若 hash 与已有项碰撞（同名重复添加）→ 覆盖该旧项
 */
export function upsertCompanionApp(input: CompanionApp): string {
    const apps = readCompanionConfig()
    const existingIdx = input.id ? apps.findIndex(a => a.id === input.id) : -1
    const id = existingIdx >= 0 ? input.id : hashName('companion', input.name)
    const entry: CompanionApp = {...input, id}
    if (existingIdx >= 0) {
        apps[existingIdx] = entry
    } else {
        const collisionIdx = apps.findIndex(a => a.id === id)
        if (collisionIdx >= 0) apps[collisionIdx] = entry
        else apps.push(entry)
    }
    writeCompanionConfigAtomic(apps)
    return id
}

/** 按 id 删除。id 不存在为幂等 no-op（不重写文件）。 */
export function removeCompanionApp(id: string): void {
    const apps = readCompanionConfig()
    const next = apps.filter(a => a.id !== id)
    if (next.length === apps.length) return
    writeCompanionConfigAtomic(next)
}
