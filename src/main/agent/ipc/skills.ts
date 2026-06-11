/**
 * 技能 IPC handlers
 *
 * 处理技能的刷新、安装、添加、删除、启用/禁用等操作
 * 包含技能刷新的互斥锁机制
 */

import {ipcMain} from 'electron'
import {skillRegistry} from '../skills'
import {serializeSkills, writeSkillOverride, writeSkillOverrides, getAndClearLoadErrors} from '../skills/loader'
import {powerManager} from '../powerManager'
import {updateMarkdownFrontmatter, type FrontmatterUpdate} from '../utils/frontmatter'
import {logger} from '../logger'
import {getHclawDir} from '../../config'
import * as path from 'path'
import * as fs from 'fs/promises'
import extract from 'extract-zip'

// ─── 技能待删除标记 ─────────────────────────────────
const pendingDeleteDirs = new Set<string>()

/**
 * 尝试从 skillRegistry 缓存返回（非强制模式且缓存非空时），否则返回 null
 */
function tryCachedSkills(forceRefresh?: boolean): {
    success: true;
    count: number;
    skills: Record<string, unknown>[]
} | null {
    if (forceRefresh) return null
    const cached = skillRegistry.getAll()
    if (cached.length === 0) return null
    const skills = serializeSkills(cached)
    logger.debug('[SkillsRefresh]', {action: 'from-cache', skillsCount: skills.length})
    return {success: true, count: skills.length, skills}
}

/** 技能加载互斥锁 — 防止并发的 skills-refresh 导致竞争条件 */
let skillRefreshLock: Promise<void> | null = null

/**
 * 执行技能刷新的互斥操作
 * 如果已有刷新在进行，等待其完成后再执行新请求
 */
async function doSkillRefresh<T>(fn: () => Promise<T>): Promise<T> {
    // 等待当前刷新完成（如果存在）
    if (skillRefreshLock !== null) {
        await skillRefreshLock
    }

    // 创建新的刷新任务 - 通过 powerManager.refresh() 统一刷新所有能力
    skillRefreshLock = powerManager.refresh()

    try {
        await skillRefreshLock
    } finally {
        skillRefreshLock = null
    }

    return fn()
}

/** 刷新技能注册表并返回序列化结果（消除 IPC handler 中的重复代码） */
async function refreshAndRespond(
    skillName?: string,
    targetDir?: string,
    hasSkillMd?: boolean,
    extra?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    return doSkillRefresh(async () => {
        // 重新抹除待删除的技能（防 powerManager.refresh() 重新加载）
        for (const dir of pendingDeleteDirs) {
            for (const s of skillRegistry.getAll()) {
                if (s.filePath && path.dirname(s.filePath) === dir) {
                    skillRegistry.unregister(s.id)
                }
            }
        }
        // 获取所有技能（包括 enabled: false 的），前端负责渲染启用状态
        const allSkills = skillRegistry.getAll()
        const base: Record<string, unknown> = {success: true, skills: serializeSkills(allSkills), count: 0}
        if (skillName !== undefined) Object.assign(base, {skillName})
        if (targetDir !== undefined) Object.assign(base, {targetDir})
        if (hasSkillMd !== undefined) Object.assign(base, {hasSkillMd})
        if (extra) Object.assign(base, extra)
        return base
    })
}

export function registerHandlers(): void {
    // 刷新技能（通过 powerManager 统一刷新）
    ipcMain.handle('skills-refresh', async (_event, forceRefresh?: boolean) => {
        // 非强制刷新且缓存可用时直接返回，避免重复扫描卡顿
        const cached = tryCachedSkills(forceRefresh)
        if (cached) return cached
        return doSkillRefresh(async () => {
            // 获取所有技能（包括 enabled: false 的），前端负责渲染启用状态
            const allSkills = skillRegistry.getAll()
            logger.debug('[SkillsRefresh]', {action: 'total', totalSkills: allSkills.length})
            const skills = serializeSkills(allSkills)
            const loadErrors = getAndClearLoadErrors()
            logger.debug('[SkillsRefresh]', {action: 'returning', skillsCount: skills.length, errorsCount: loadErrors.length})
            return {success: true, count: skills.length, skills, loadErrors}
        })
    })

    // 安装技能（上传 zip 包）
    ipcMain.handle('skill-install', async (_event, zipPath: string) => {
        try {
            const skillsDir = path.join(getHclawDir(), 'skills', 'custom')

            // 确保 custom 目录存在
            await fs.mkdir(skillsDir, {recursive: true})

            // 从 zip 路径提取名称（去除 .zip 后缀）
            const baseName = path.basename(zipPath)
            const skillName = baseName.replace(/\.zip$/i, '')

            // 目标目录：配置目录/skills/custom/{skillName}
            const targetDir = path.join(skillsDir, skillName)

            // 如果目标目录已存在，先删除
            try {
                await fs.rm(targetDir, {recursive: true, force: true})
            } catch {
                // 目录不存在，忽略
            }

            // 解压 zip 到目标目录
            await extract(zipPath, {dir: targetDir})

            // 验证解压后是否有 SKILL.md 文件
            const skillMdPath = path.join(targetDir, 'SKILL.md')
            const hasSkillMd = await fs.access(skillMdPath).then(() => true).catch(() => false)

            return refreshAndRespond(skillName, targetDir, hasSkillMd)
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 添加技能（创建 SKILL.md 目录和文件）
    //
    // params.content 来自前端 SKILL_TEMPLATE + 用户编辑，已含完整 frontmatter。
    // 后端直接写入，不额外构造 frontmatter，防双 frontmatter / 字段丢失。
    ipcMain.handle('skill-add', async (_event, params: {
        name: string
        description: string
        content: string
        enabled?: boolean
        allowedTools?: string[]
    }) => {
        try {
            const skillsDir = path.join(getHclawDir(), 'skills', 'custom')
            await fs.mkdir(skillsDir, {recursive: true})

            // 使用 name 作为目录名（转小写、替换空格）
            const skillDirName = params.name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '')
            if (!skillDirName) {
                return {success: false, error: 'Invalid skill name'}
            }

            const targetDir = path.join(skillsDir, skillDirName)
            await fs.mkdir(targetDir, {recursive: true})

            // 直接写入 params.content（前端已构建完整 SKILL.md，含 frontmatter + body）
            await fs.writeFile(path.join(targetDir, 'SKILL.md'), params.content || '', 'utf-8')

            return refreshAndRespond(undefined, undefined, undefined, {skillDirName})
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 删除技能（删除 SKILL.md 所在目录）
    // 策略：
    // 1. 立即从注册表中移除（UI 即刻消失）
    // 2. 后台不限时重试删除磁盘目录（Windows Defender 可能锁住，多次重试即可）
    // 3. refreshAndRespond() 之后重新抹除一次，防 powerManager.refresh() 重新加载
    ipcMain.handle('skill-remove', async (_event, skillId: string) => {
        try {
            const skill = skillRegistry.get(skillId)
            if (!skill || !skill.filePath) {
                return {success: false, error: `Skill "${skillId}" not found`}
            }

            const skillDir = path.dirname(skill.filePath)

            // 标记待删除 + 取消注册（UI 立即生效）
            pendingDeleteDirs.add(skillDir)
            skillRegistry.unregister(skillId)

            // 后台不限时重试删除，不阻塞用户
            const attemptDelete = async (): Promise<void> => {
                try {
                    await fs.rm(skillDir, {recursive: true, force: true})
                    pendingDeleteDirs.delete(skillDir)
                    logger.info(`[skill-remove] background delete succeeded for ${skillDir}`)
                } catch {
                    setTimeout(attemptDelete, 2000)
                }
            }

            // ⚠️ 必须等 refreshAndRespond 完成后再启动后台删除
            // 否则 fs.rm 与 powerManager.refresh() 的 readdir 并发竞争同一目录句柄 → EBUSY
            const result = await refreshAndRespond()
            attemptDelete()
            return result
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 更新技能的用户自定义描述（修改 SKILL.md 的 YAML frontmatter）
    ipcMain.handle('skill-update-description', async (_event, skillId: string, userDescription: string) => {
        try {
            const skill = skillRegistry.get(skillId)
            if (!skill || !skill.filePath) {
                return {success: false, error: `Skill "${skillId}" not found`}
            }

            const content = await fs.readFile(skill.filePath, 'utf-8')
            const updatedContent = updateMarkdownFrontmatter(content, [
                {key: 'user_description', value: userDescription || undefined}
            ])

            await fs.writeFile(skill.filePath, updatedContent, 'utf-8')

            return refreshAndRespond(undefined, undefined, undefined, {skillId, userDescription})
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 更新技能字段（name / description / body）
    //
    // 前端不拼文件，只发独立字段。后端用 updateMarkdownFrontmatter
    // 将变更合并到原文件，确保：
    // 1. 其他 frontmatter 字段（enabled / when_to_use / allowed_tools 等）不丢失
    // 2. 新值经过 formatYamlValue 正确 YAML 引号转义
    // 3. body-only 无需正则提取 frontmatter，直接拼接原 frontmatter + 新 body
    ipcMain.handle('skill-update-content', async (_event, params: {
        skillId: string
        name?: string
        description?: string
        body?: string
    }) => {
        try {
            const {skillId, name, description, body} = params
            const skill = skillRegistry.get(skillId)
            if (!skill || !skill.filePath) {
                return {success: false, error: `Skill "${skillId}" not found`}
            }

            const originalContent = await fs.readFile(skill.filePath, 'utf-8')

            // 合并 frontmatter 字段变更
            const updates: FrontmatterUpdate[] = []
            if (name !== undefined) updates.push({key: 'name', value: name})
            if (description !== undefined) updates.push({key: 'description', value: description})

            let newContent = updates.length > 0
                ? updateMarkdownFrontmatter(originalContent, updates)
                : originalContent

            // 替换 body（--...-- 之间的为 frontmatter，之后的是 body）
            if (body !== undefined) {
                const fmEnd = newContent.match(/^---[\r\n]+[\s\S]*?[\r\n]+---/m)
                if (fmEnd) {
                    newContent = fmEnd[0] + '\n' + body
                } else {
                    // 无 frontmatter — 直接作为 body 写入（兜底）
                    newContent = body
                }
            }

            await fs.writeFile(skill.filePath, newContent, 'utf-8')

            return refreshAndRespond(undefined, undefined, undefined, {skillId})
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 切换技能启用状态（仅写 skill_overrides 表，不修改文件）
    ipcMain.handle('skill-toggle', async (_event, skillId: string) => {
        try {
            const skill = skillRegistry.get(skillId)
            if (!skill) {
                return {success: false, error: `Skill "${skillId}" not found`}
            }

            const newEnabled = !skill.enabled
            writeSkillOverride(skillId, newEnabled)

            return refreshAndRespond(undefined, undefined, undefined, {enabled: newEnabled})
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })

    // 批量切换技能启用状态（仅写 skill_overrides 表，不修改文件）
    ipcMain.handle('skill-toggle-batch', async (_event, params: {skillIds: string[]; enabled: boolean}) => {
        try {
            const overrides: Array<{skillId: string; enabled: boolean}> =
                params.skillIds.map(skillId => ({skillId, enabled: params.enabled}))

            writeSkillOverrides(overrides)

            await powerManager.refresh()
            const allSkills = skillRegistry.getAll()
            return {success: true, skills: serializeSkills(allSkills)}
        } catch (err: any) {
            return {success: false, error: err.message}
        }
    })
}
