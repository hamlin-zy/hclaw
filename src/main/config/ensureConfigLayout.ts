import path from 'path';
import fs from 'fs';
import yaml from 'js-yaml';
import {getHclawDir, configPath} from '../hclawPaths';
import {getPresetCommandMarkdownFiles, OBSOLETE_PRESET_COMMANDS} from '../command/presetCommands';

/**
 * 配置目录布局初始化 + 一次性数据迁移。
 *
 * 原先内联在 src/main/config.ts 里，与「路径能力」「IPC 注册」挤在同一模块，
 * 使 config.ts 承担装配层角色并进入依赖环（详见
 * docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md）。
 * 这里只保留「启动时准备 ~/.hclaw 目录结构」这一职责，由主进程装配根
 * （src/main/index.ts）调用；路径能力已下沉到叶子 src/main/hclawPaths.ts。
 */

/** 配置文件顶层子目录 */
const SUBDIRS = ['agents', 'skills', 'logs'];

/**
 * 数据目录子路径
 * 注意：data/ 由 SQLite 初始化时创建（src/main/repositories/sqlite/index.ts），
 * 但 channels/attachments 等子目录不会自动创建，需在此统一保证。
 */
const DATA_SUBDIRS = ['channels']; // data/<name> 下的子目录

/**
 * 将 DB 中的旧用户命令迁移到文件系统
 * 读取 user_commands WHERE source='user'，写入 ~/.hclaw/commands/{name}.md，然后删除 DB 记录
 */
function migrateUserCommandsFromDbToFs(commandsDir: string): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 数据迁移专用，惰性加载以维持既有的模块初始化顺序（getHclawDir 已下沉至叶子 hclawPaths，本处已不在环内，仅沿用原有延迟时机）
    const {getDatabase, saveDatabase} = require('../repositories/sqlite')
    const db = getDatabase()

    const rows = db.prepare("SELECT * FROM user_commands WHERE source = 'user'").all() as Array<{
        id: string
        name: string
        description: string | null
        content: string
        args: string
        enabled: number
    }>

    if (rows.length === 0) {
        console.warn('[migrateUserCommands] No user commands to migrate')
        return
    }

    let migrated = 0

    for (const row of rows) {
        const filePath = path.join(commandsDir, `${row.name}.md`)
        if (fs.existsSync(filePath)) {
            // 不覆盖已存在的文件
            continue
        }

        try {
            const frontmatter: Record<string, unknown> = {
                name: row.name,
                description: row.description || '',
            }

            const args = JSON.parse(row.args || '[]')
            if (Array.isArray(args) && args.length > 0) {
                frontmatter.args = args
            }

            // enabled=0 时，写入文件标记为 false
            if (row.enabled !== 1) {
                frontmatter.enabled = false
            }

            const content = `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n\n${row.content}`
            fs.writeFileSync(filePath, content, 'utf-8')

            // 如果用户禁用了命令，同时写入 command_overrides
            if (row.enabled !== 1) {
                const now = Date.now()
                db.prepare(
                    'INSERT OR REPLACE INTO command_overrides (command_id, enabled, updated_at) VALUES (?, ?, ?)'
                ).run(row.name, row.enabled, now)
            }

            migrated++
        } catch (err) {
            console.error(`[migrateUserCommands] Failed to migrate command "${row.name}":`, err)
        }
    }

    // 删除已迁移的 DB 记录
    db.prepare("DELETE FROM user_commands WHERE source = 'user'").run()
    saveDatabase()

    console.warn(`[migrateUserCommands] Migrated ${migrated}/${rows.length} user commands, deleted from DB`)
}

/** 初始化配置目录结构 */
export function ensureConfigLayout(): void {
    const hclawDir = getHclawDir()

    // 创建根目录
    if (!fs.existsSync(hclawDir)) {
        fs.mkdirSync(hclawDir, {recursive: true});
    }

    // 创建所有子目录
    for (const dir of SUBDIRS) {
        fs.mkdirSync(path.join(hclawDir, dir), {recursive: true});
    }

    // 初始化 data/ 下的子目录（渠道附件存储等）
    const dataDir = path.join(hclawDir, 'data');
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, {recursive: true});
    }
    for (const sub of DATA_SUBDIRS) {
        fs.mkdirSync(path.join(dataDir, sub), {recursive: true});
    }

    // 初始化 skills 子目录结构
    const skillsDir = path.join(hclawDir, 'skills');
    const skillsSubdirs = ['public', 'custom'];
    for (const subdir of skillsSubdirs) {
        fs.mkdirSync(path.join(skillsDir, subdir), {recursive: true});
    }

    // 初始化命令目录：首次启动时写入预设命令
    const commandsDir = path.join(hclawDir, 'commands');
    if (!fs.existsSync(commandsDir)) {
        fs.mkdirSync(commandsDir, {recursive: true});
        try {
            const presetFiles = getPresetCommandMarkdownFiles()
            for (const {filename, content} of presetFiles) {
                const filePath = path.join(commandsDir, filename)
                fs.writeFileSync(filePath, content, 'utf-8')
            }
            console.warn(`[ensureConfigLayout] Wrote preset command files to ${commandsDir}`)
        } catch (err) {
            console.error('[ensureConfigLayout] Failed to write preset commands:', err)
        }
    }

    // 数据迁移：将 DB 中已有的旧用户命令迁移到文件系统（仅执行一次）
    try {
        migrateUserCommandsFromDbToFs(commandsDir)
    } catch (err) {
        console.error('[ensureConfigLayout] Failed to migrate user commands:', err)
    }

    // 清理冗余命令文件（已被对应 Agent 取代的旧预设命令）
    for (const name of OBSOLETE_PRESET_COMMANDS) {
        const filePath = path.join(commandsDir, `${name}.md`)
        if (fs.existsSync(filePath)) {
            try {
                fs.unlinkSync(filePath)
                console.warn(`[ensureConfigLayout] Removed obsolete preset command: ${name}.md`)
            } catch (err) {
                console.error(`[ensureConfigLayout] Failed to remove obsolete command ${name}.md:`, err)
            }
        }
    }

    // 数据迁移：旧 .conf → 新 .json
    const migrations: Array<[string, string]> = [
        ['knowledge.conf', 'knowledge.json'],
        ['mcp.conf', 'mcp.json'],
    ];
    for (const [oldName, newName] of migrations) {
        const oldPath = path.join(hclawDir, oldName);
        const newPath = path.join(hclawDir, newName);
        if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
            fs.renameSync(oldPath, newPath);
        }
    }

    // 清理旧的 workspace.json（已迁移到 SQLite）
    const workspaceFile = configPath('workspace');
    if (fs.existsSync(workspaceFile)) {
        try {
            fs.unlinkSync(workspaceFile);
        } catch (err) {
            console.error('[ensureConfigLayout] remove old workspace.json failed:', err);
        }
    }

    // 默认 .json 文件已全部迁移到 SQLite，不再创建本地文件
}
