/**
 * 应用图标工具函数
 *
 * 统一图标路径解析逻辑，避免在 window.ts 和 tray.ts 中重复代码
 */

import {nativeImage} from 'electron'
import path from 'path'

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined

/** 获取应用图标路径 */
export function getAppIconPath(): string {
    const isDev = !!MAIN_WINDOW_VITE_DEV_SERVER_URL;
    // 统一使用 icon.png（Windows 的 .ico 由打包工具生成，运行时用 PNG 即可）
    const iconName = 'icon.png';

    if (isDev) {
        return path.join(__dirname, `../../public/${iconName}`);
    } else {
        // 打包后 extraResource 的文件直接位于 resources/ 目录下
        return path.join(process.resourcesPath, iconName);
    }
}

/** 获取应用图标 NativeImage，失败返回 undefined */
export function getAppIcon(): Electron.NativeImage | undefined {
    const icon = nativeImage.createFromPath(getAppIconPath())
    return icon.isEmpty() ? undefined : icon
}
