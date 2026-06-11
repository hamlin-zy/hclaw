import path from 'path';
import fs from 'fs';
import os from 'os';
import {createConfigRepository} from './repositories';
import {systemSettingsRepo} from './repositories/sqlite/systemSettingsRepository';
import {workspaceRepo} from './repositories/sqlite/workspaceRepository';
import {getPresetCommandMarkdownFiles, OBSOLETE_PRESET_COMMANDS} from './command/presetCommands';

// --- 共享常量 ---

export const HCLAW_DIR = path.join(os.homedir(), '.hclaw');

/** 配置文件顶层子目录 */
const SUBDIRS = ['agents', 'skills', 'hooks', 'logs'];

/**
 * 数据目录子路径
 * 注意：data/ 由 SQLite 初始化时创建（src/main/repositories/sqlite/index.ts），
 * 但 channels/attachments 等子目录不会自动创建，需在此统一保证。
 */
const DATA_SUBDIRS = ['channels']; // data/<name> 下的子目录

// ── 系统配置目录管理 ──────────────────────────────

/** 获取引导文件路径（用于持久化用户自定义配置目录） */
function getBootstrapFilePath(): string {
    const appData = process.env.APPDATA
        || (process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Application Support')
            : path.join(os.homedir(), '.config'))
    return path.join(appData, 'hclaw', 'config-path.json')
}

let _cachedHclawDir: string | null = null

/**
 * 获取系统配置目录
 * 优先级：引导文件 > 默认值 ~/.hclaw
 */
export function getHclawDir(): string {
    if (_cachedHclawDir) return _cachedHclawDir

    // 1. 引导文件（用户自定义路径）
    const bootstrapFile = getBootstrapFilePath()
    if (fs.existsSync(bootstrapFile)) {
        try {
            const data = JSON.parse(fs.readFileSync(bootstrapFile, 'utf-8'))
            if (data.configDir) {
                _cachedHclawDir = path.resolve(data.configDir)
                return _cachedHclawDir
            }
        } catch { /* 忽略损坏的引导文件 */
        }
    }

    // 2. 默认值
    _cachedHclawDir = HCLAW_DIR
    return _cachedHclawDir
}

/**
 * 设置系统配置目录并持久化到引导文件
 * 传入空字符串则删除引导文件，恢复默认路径
 */
export function setHclawDir(dir: string): void {
    const bootstrapFile = getBootstrapFilePath()
    if (!dir) {
        // 空字符串 = 恢复默认路径，删除引导文件
        _cachedHclawDir = null
        if (fs.existsSync(bootstrapFile)) {
            fs.unlinkSync(bootstrapFile)
        }
        return
    }
    _cachedHclawDir = path.resolve(dir)
    const bootstrapDir = path.dirname(bootstrapFile)
    if (!fs.existsSync(bootstrapDir)) {
        fs.mkdirSync(bootstrapDir, {recursive: true})
    }
    fs.writeFileSync(bootstrapFile, JSON.stringify({configDir: _cachedHclawDir}, null, 2), 'utf-8')
}

// --- 工具函数 ---

/** 安全检查：确保路径在配置目录内 */
export function isSafePath(target: string): boolean {
    const resolved = path.resolve(target);
    return resolved.startsWith(path.resolve(getHclawDir()));
}

/**
 * 获取系统数据目录根目录 (~/.hclaw/data/)
 * 用于持久化存储各类业务数据（渠道附件、会话快照等）
 */
export function getHclawDataDir(): string {
    const dir = path.join(getHclawDir(), 'data');
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
    return dir;
}

/** 确保目录存在，不存在则创建 */
function ensureDir(dir: string, _label: string): string {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {recursive: true});
    }
    return dir;
}

const CHANNELS_BASE = () => path.join(getHclawDataDir(), 'channels');

/**
 * 获取指定渠道的媒体附件存储目录 (~/.hclaw/data/channels/<channelId>/attachments/)
 * 用于持久化保存渠道收到的图片/语音/视频/文件，代替临时目录
 */
export function getChannelMediaDir(channelId: string): string {
    const dir = path.join(CHANNELS_BASE(), channelId, 'attachments');
    return ensureDir(dir, 'channel media');
}

/**
 * 获取带日期子目录的会话附件存储目录
 * 路径: {dataDir}/channels/{channelId}/attachments/{conversationId}/{yyyyMMdd}/
 */
export function getChannelMediaDirWithDate(channelId: string, conversationId: string, date?: string): string {
    const dateStr = date || new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const dir = path.join(CHANNELS_BASE(), channelId, 'attachments', conversationId, dateStr);
    return ensureDir(dir, 'session media with date');
}

/**
 * 获取指定渠道的会话附件存储目录（无日期子目录）
 * 路径: {dataDir}/channels/{channelId}/attachments/{conversationId}/
 */
export function getChannelSessionMediaDir(channelId: string, conversationId: string): string {
    const dir = path.join(CHANNELS_BASE(), channelId, 'attachments', conversationId);
    return ensureDir(dir, 'session media');
}

/** 获取 .json 文件路径，支持子目录路径分隔符 */
export function configPath(name: string): string {
    // 修复 P1-7: 禁止包含路径分隔符和特殊字符，防止路径遍历攻击
    if (name.includes('/') || name.includes('\\') || name.includes('..')) {
        throw new Error(`Invalid config name: path traversal not allowed`)
    }

    // 禁止包含特殊字符
    if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
        throw new Error(`Invalid config name: only alphanumeric, underscore, and hyphen allowed`)
    }

    const filePath = path.join(getHclawDir(), `${name}.json`);
    if (!isSafePath(filePath)) throw new Error(`Unsafe path: ${name}`);
    return filePath;
}

/**
 * 将 DB 中的旧用户命令迁移到文件系统
 * 读取 user_commands WHERE source='user'，写入 ~/.hclaw/commands/{name}.md，然后删除 DB 记录
 */
function migrateUserCommandsFromDbToFs(commandsDir: string): void {
    const {getDatabase, saveDatabase} = require('./repositories/sqlite')
    const {commandToMarkdown} = require('./command/presetCommands')
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
    const yaml = require('js-yaml') as typeof import('js-yaml')

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

// --- IPC Handlers ---

/**
 * 注册配置相关 IPC handlers
 *
 * 注意：使用 dynamic require 而非顶层 import。
 * 因为 Worker 进程也会间接加载此模块（通过工具链），但 Worker 中无法 resolve electron。
 * 所有 electron 依赖集中在 initConfigIPC() 内延迟加载，该函数仅在主进程被调用。
 */
export function initConfigIPC(): void {
    const {ipcMain, safeStorage, app, clipboard, nativeImage} = require('electron')
    const configRepo = createConfigRepository()

    // System config directory — get/set with bootstrap file persistence
    ipcMain.handle('config-get-hclaw-dir', () => {
        return getHclawDir()
    })

    ipcMain.handle('config-set-hclaw-dir', async (_event: any, dir: string) => {
        setHclawDir(dir)
        return dir
    })

    ipcMain.handle('app-restart', () => {
        app.relaunch()
        app.exit()
    })

    // Config file read/write (.json / SQLite)
    // SQLite 中存储的 key（新增请加入此 Set）
    const SQLITE_KEYS = new Set(['settings', 'prompt-config', 'message-display-mode'])

    ipcMain.handle('config-read', async (_event: any, name: string) => {
        return SQLITE_KEYS.has(name)
            ? systemSettingsRepo.getJson(name)
            : configRepo.read(name)
    });

    ipcMain.handle('config-write', async (_event: any, name: string, data: unknown) => {
        return SQLITE_KEYS.has(name)
            ? systemSettingsRepo.setJson(name, data)
            : configRepo.write(name, data)
    });

    // Directory-level config (agents/skill/hooks)

    ipcMain.handle('config-dir-read', async (_event: any, dir: string, filename: string) => {
        return configRepo.readDir(dir, filename)
    });

    ipcMain.handle('config-dir-write', async (_event: any, dir: string, filename: string, data: unknown) => {
        return configRepo.writeDir(dir, filename, data)
    });

    ipcMain.handle('config-dir-list', async (_event: any, dir: string) => {
        return configRepo.listDir(dir)
    });

    ipcMain.handle('config-dir-delete', async (_event: any, dir: string, filename: string) => {
        return configRepo.deleteDir(dir, filename)
    });

    // Secret encryption via Electron safeStorage

    ipcMain.handle('secret-encrypt', (_event: any, plainText: string) => {
        if (typeof plainText !== 'string') return null;
        try {
            const buffer = safeStorage.encryptString(plainText);
            return buffer.toString('base64');
        } catch {
            return null;
        }
    });

    ipcMain.handle('secret-decrypt', (_event: any, cipherText: string) => {
        if (typeof cipherText !== 'string') return null;
        try {
            const buffer = Buffer.from(cipherText, 'base64');
            return safeStorage.decryptString(buffer);
        } catch (err) {
            console.error('[secret-decrypt] FAILED:', err, 'cipherText length:', cipherText?.length)
            return null;
        }
    });

    // Prompt config IPC — 读写 SQLite，兼顾旧 JSON 文件迁移

    ipcMain.handle('prompt-config-read', async () => {
        // 优先从 SQLite 读取
        let data = systemSettingsRepo.getJson('prompt-config')
        if (data !== null) return data

        // 兼容旧文件：从 JSON 文件迁移到 SQLite
        try {
            data = configRepo.read('prompt-config')
            if (data) {
                systemSettingsRepo.setJson('prompt-config', data)
                // 迁移后删除旧文件
                const oldPath = configPath('prompt-config')
                if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath)
            }
        } catch {
        }

        return data ?? {enabled: true, nodes: {}}
    });

    ipcMain.handle('prompt-config-write', async (_event: any, data: unknown) => {
        return systemSettingsRepo.setJson('prompt-config', data)
    });

    // Save blob/image to persistent temp directory (renderer-side uploads)
    ipcMain.handle('save-temp-file', async (_event: any, data: { buffer: number[], name: string }) => {
        try {
            // 使用持久化目录替代系统临时目录，避免进程重启后文件丢失
            const tempDir = ensureDir(path.join(getHclawDataDir(), 'attachments', 'temp'), 'temp attachments');
            const uniqueName = `${Date.now()}_${data.name}`
            const filePath = path.join(tempDir, uniqueName);
            fs.writeFileSync(filePath, Buffer.from(data.buffer));
            return filePath;
        } catch (err) {
            return null;
        }
    });

    // Save dropped file to persistent temp directory (drag-and-drop from OS)
    ipcMain.handle('save-dropped-file', async (_event: any, data: { sourcePath: string, name: string }) => {
        try {
            const tempDir = ensureDir(path.join(getHclawDir(), 'temp'), 'temp files');
            const uniqueName = `${Date.now()}_${data.name}`
            const filePath = path.join(tempDir, uniqueName);
            fs.copyFileSync(data.sourcePath, filePath);
            return filePath;
        } catch (err) {
            return null;
        }
    });

    // Write image to system clipboard (expects PNG/JPEG buffer)
    ipcMain.handle('clipboard-write-image', async (_event: any, data: { buffer: number[] }) => {
        try {
            const buffer = Buffer.from(data.buffer);
            const image = nativeImage.createFromBuffer(buffer);
            clipboard.writeImage(image);
            return {success: true};
        } catch (err) {
            return {success: false, error: String(err)};
        }
    });

    // ── Workspace IPC handlers ──────────────────────────────────

    ipcMain.handle('workspace:list', () => {
        return workspaceRepo.list();
    });

    ipcMain.handle('workspace:get', (_event: any, id: string) => {
        return workspaceRepo.getById(id);
    });

    ipcMain.handle('workspace:getByPath', (_event: any, workspacePath: string) => {
        return workspaceRepo.getByPath(workspacePath);
    });

    ipcMain.handle('workspace:create', (_event: any, id: string, workspacePath: string, name: string) => {
        return workspaceRepo.create(id, workspacePath, name);
    });

    ipcMain.handle('workspace:update', (_event: any, id: string, updates: { path?: string; name?: string }) => {
        return workspaceRepo.update(id, updates);
    });

    ipcMain.handle('workspace:delete', (_event: any, id: string) => {
        return workspaceRepo.delete(id);
    });

    ipcMain.handle('workspace:getCurrent', () => {
        return workspaceRepo.getCurrentWorkspace();
    });

    ipcMain.handle('workspace:setCurrent', async (_event: any, id: string) => {
        const result = workspaceRepo.setCurrentWorkspace(id);
        if (result) {
            // 获取新工作区路径并更新 runtimeConfigManager
            const workspace = workspaceRepo.getById(id);
            if (workspace) {
                try {
                    const {runtimeConfigManager} = await import('./agent/runtimeConfigManager');
                    runtimeConfigManager.setWorkingDir(workspace.path);
                } catch (err) {
                    console.error('[config] 更新 runtimeConfigManager 失败:', err);
                }
            }
        }
        return result;
    });
}
