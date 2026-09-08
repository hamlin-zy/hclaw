import {globalShortcut} from 'electron';
import {SHORTCUT_DEFS, mergeOverrides, type ShortcutAction} from '../shared/shortcuts';
import {getMainWindow} from './window';
import {systemSettingsRepo} from './repositories/sqlite/systemSettingsRepository';
import {logger} from './agent/logger';

/** 当前已注册的全局键（actionId → accelerator），仅一条（toggleWindow），结构上支持扩展 */
const registered = new Map<ShortcutAction, string>();

const toggleWindow = (): void => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.hide();
    } else {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.show();
        mainWindow.focus();
    }
};

const handlers: Partial<Record<ShortcutAction, () => void>> = {
    toggleWindow,
};

/**
 * 按配置同步全局键。换绑顺序：先注册新键，成功后才注销旧键；
 * 失败时旧键保持生效。返回 {actionId: 失败原因}（成功者无条目）。
 */
export function syncGlobalShortcuts(overrides?: Record<string, string>): Record<string, string> {
    const failures: Record<string, string> = {};
    const effective = mergeOverrides(overrides);
    const wanted = new Map<ShortcutAction, string>();

    for (const def of SHORTCUT_DEFS) {
        if (def.scope !== 'global') continue;
        // 冲突时全局键组内按声明序取第一个；同 acc 多 global action 时后者跳过
        if ([...wanted.values()].includes(effective[def.id])) continue;
        wanted.set(def.id, effective[def.id]);
    }

    // 1. 注册新增/变更的键
    for (const [id, acc] of wanted) {
        if (registered.get(id) === acc) continue;
        let ok = false;
        try {
            ok = globalShortcut.register(acc, () => handlers[id]?.());
        } catch (err: any) {
            logger.warn('syncGlobalShortcuts', {id, acc, error: err?.message});
        }
        if (!ok) {
            // 旧键保持注册（不动 registered），报告失败
            failures[id] = `组合键 ${acc} 已被系统或其他应用占用`;
            continue;
        }
        // 2. 新键注册成功 → 注销该 action 的旧键
        const old = registered.get(id);
        if (old && old !== acc) globalShortcut.unregister(old);
        registered.set(id, acc);
    }

    // 3. 注销配置中已消失的键（防御性保留）
    for (const [id, acc] of registered) {
        if (!wanted.has(id)) {
            globalShortcut.unregister(acc);
            registered.delete(id);
        }
    }

    logger.info('syncGlobalShortcuts', {registered: [...registered.entries()], failures});
    return failures;
}

/** 启动时调用：从 system_settings 读取覆盖项并注册 */
export function registerGlobalShortcutsAtStartup(): void {
    try {
        const settings = systemSettingsRepo.getJson<{shortcuts?: {overrides?: Record<string, string>}}>('settings');
        syncGlobalShortcuts(settings?.shortcuts?.overrides);
    } catch (err: any) {
        logger.warn('registerGlobalShortcutsAtStartup', {error: err?.message});
        syncGlobalShortcuts(undefined);
    }
}
