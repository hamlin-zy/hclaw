import path from 'path';
import fs from 'fs';
import {getHclawDir, setHclawDir, getHclawDataDir, ensureDir} from '../hclawPaths';
import {createConfigRepository} from '../repositories';
import {systemSettingsRepo} from '../repositories/sqlite/systemSettingsRepository';
import {workspaceRepo} from '../repositories/sqlite/workspaceRepository';
// gracefulRestart / gitBranch 使用处惰性 require：本模块原先位于 config.ts 内，而 config.ts
// 处于 Agent Worker 的静态依赖闭包内（顶层 import 会把 window.ts/windowBroadcast.ts 等
// electron 模块拉进 worker，见 tests/main/deps/workerNoElectron.test.ts）。搬迁到 ipc/ 后
// 沿用原有惰性时机，保持主进程加载顺序与 worker 隔离行为不变。

/**
 * 配置类 IPC handler 注册（config-* / secret-* / save-temp-file / workspace:*）。
 *
 * 原先内联在 src/main/config.ts 的 initConfigIPC()：把「装配 + IPC 注册」和「路径能力」
 * 混在同一模块，使 config.ts 成为各类反向 import 的汇点并塌进大 SCC（详见
 * docs/superpowers/plans/2026-09-17-main-circular-deps-remediation.md）。搬迁属纯代码搬运，
 * 不改变 handler 名称、注册顺序与惰性时机。
 */

/**
 * 注册配置相关 IPC handlers
 *
 * 注意：使用 dynamic require 而非顶层 import。
 * 本模块由主进程装配根（src/main/index.ts）调用，但其中的 electron 依赖仍集中在
 * initConfigIPC() 内延迟加载，以保持原有的加载时机（不改变 index.ts 的调用顺序）。
 */
export function initConfigIPC(): void {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 保持原有的延迟加载时机（迁移自 config.ts，见文件头说明）
    const {ipcMain, safeStorage, clipboard, nativeImage} = require('electron')
    const configRepo = createConfigRepository()

    // System config directory — get/set with bootstrap file persistence
    ipcMain.handle('config-get-hclaw-dir', () => {
        return getHclawDir()
    })

    ipcMain.handle('config-set-hclaw-dir', async (_event: any, dir: string) => {
        setHclawDir(dir)
        return dir
    })

    ipcMain.handle('app-restart', async () => {
        // 惰性 require：worker 闭包不得静态引入 electron（restart.ts 顶层 import electron）
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 延迟加载
        const {gracefulRestart} = require('../utils/restart');
        await gracefulRestart()
    })

    // Config file read/write (.json / SQLite)
    // SQLite 中存储的 key（新增请加入此 Set）
    const SQLITE_KEYS = new Set(['settings', 'message-display-mode'])

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

    // Directory-level config (agents/skills/logs)

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

    // Save blob/image to persistent temp directory (renderer-side uploads)
    ipcMain.handle('save-temp-file', async (_event: any, data: { buffer: number[], name: string }) => {
        try {
            // 使用持久化目录替代系统临时目录，避免进程重启后文件丢失
            const tempDir = ensureDir(path.join(getHclawDataDir(), 'attachments', 'temp'), 'temp attachments');
            const uniqueName = `${Date.now()}_${data.name}`
            const filePath = path.join(tempDir, uniqueName);
            fs.writeFileSync(filePath, Buffer.from(data.buffer));
            return filePath;
        } catch {
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
        } catch {
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

    ipcMain.handle('workspace:getGitBranch', async (_event: any, cwd: string) => {
        // 惰性 require：gitBranch → windowBroadcast 顶层 import electron（见文件头说明）
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- 延迟加载
        const {getGitBranch, startGitBranchWatch} = require('../workspace/gitBranch');
        if (cwd) {
            // 建立/重建分支 watch（启动加载与工作区切换都会走到这里，保证监听与当前 cwd 一致）
            try {
                startGitBranchWatch(cwd);
            } catch (err) {
                console.error('[config] 启动 git 分支监听失败:', err);
            }
        }
        return getGitBranch(cwd);
    });

    ipcMain.handle('workspace:setCurrent', async (_event: any, id: string) => {
        const result = workspaceRepo.setCurrentWorkspace(id);
        if (result) {
            // 获取新工作区路径并更新 runtimeConfigManager
            const workspace = workspaceRepo.getById(id);
            if (workspace) {
                try {
                    const {runtimeConfigManager} = await import('../agent/runtimeConfigManager');
                    runtimeConfigManager.setWorkingDir(workspace.path);
                } catch (err) {
                    console.error('[config] 更新 runtimeConfigManager 失败:', err);
                }
                // 切换工作区：重建 git 分支 watch（先 stop 旧的）
                try {
                    // eslint-disable-next-line @typescript-eslint/no-require-imports -- 延迟加载，同上
                    const {startGitBranchWatch} = require('../workspace/gitBranch');
                    startGitBranchWatch(workspace.path);
                } catch (err) {
                    console.error('[config] 启动 git 分支监听失败:', err);
                }
            }
        }
        return result;
    });
}
