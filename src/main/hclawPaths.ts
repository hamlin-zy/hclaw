import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * 主进程路径 / 目录能力的叶子模块。
 *
 * 结构性约束：本模块是依赖图的叶子——只允许依赖 node 内置模块（path/fs/os），
 * 不得引入任何项目内模块（入口除外）。它原先与「仓库装配 + IPC 注册」一起挤在
 * src/main/config.ts，导致 repositories/sqlite/index.ts、configRepository.ts 等
 * 为了 getHclawDir/isSafePath 反向 import config.ts，形成 config.ts ⇄ repositories/*
 * 互指并塌成大 SCC（见 docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md）。
 *
 * 兼容性：config.ts 通过 `export {...} from './hclawPaths'` 重新导出这些符号，
 * 现有调用方（`from '../config'`）无需改动，且因 ESM/CJS 的 live binding 共享同一份
 * 模块状态（`_cachedHclawDir` 全局唯一）。
 */

// --- 共享常量 ---

export const HCLAW_DIR = path.join(os.homedir(), '.hclaw');

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
export function ensureDir(dir: string, _label: string): string {
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
