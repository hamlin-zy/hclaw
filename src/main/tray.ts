import {app, Menu, nativeImage, Tray} from 'electron';
import path from 'path';
import {createWindow, getMainWindow} from './window';
import {getAppIconPath} from './utils/icon';

let tray: Tray | null = null;
let trayIconLoaded = false;

/** 获取 tray 实例 */
export function getTray(): Tray | null {
  return tray;
}

/** 获取 trayIconLoaded 状态 */
export function getTrayIconLoaded(): boolean {
  return trayIconLoaded;
}

/** 创建 1x1 白点图标作为保底 */
function createFallbackIcon(): Electron.NativeImage {
    return nativeImage.createFromBuffer(
        Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==', 'base64')
    );
}

export const createTray = (): void => {
  const isMac = process.platform === 'darwin';
  let icon: Electron.NativeImage;
  try {
      const iconPath = getAppIconPath();
      icon = nativeImage.createFromPath(iconPath);
    if (icon.isEmpty()) {
      // 尝试备用路径
      const fallbackPath = path.join(app.getAppPath(), 'public/icon.png');
      icon = nativeImage.createFromPath(fallbackPath);
    }
    if (icon.isEmpty()) {
        icon = createFallbackIcon();
    } else {
      trayIconLoaded = true;
    }
  } catch {
      icon = createFallbackIcon();
  }

  // macOS 托盘图标：缩放到 18x18 并设为 Template 图片
  // macOS 会自动对 Template 图片进行反色处理，适配深色/浅色菜单栏
  // createFallbackIcon() 保证 icon 永不空，无需 isEmpty 检查
  if (isMac) {
      const resized = icon.resize({width: 18, height: 18, quality: 'better'});
      resized.setTemplateImage(true);
      tray = new Tray(resized);
  } else {
      tray = new Tray(icon);
  }

  const menuItems: Electron.MenuItemConstructorOptions[] = [
    {
      label: '显示 HClaw',
      click: () => {
        const win = getMainWindow();
          if (win && !win.isDestroyed()) {
              win.show();
              win.focus();
              // 如果渲染进程崩溃/断连，尝试重载
              if ((win.webContents as any).isResponsive?.() || win.webContents.getURL() === 'about:blank') {
                  win.webContents.reload();
              }
          } else {
              // 窗口已销毁，重新创建
              createWindow();
          }
      }
    },
    {
      label: '隐藏',
      click: () => getMainWindow()?.hide()
    },
    { type: 'separator' },
  ];

  // 开发/调试环境下保留强制重载入口，打包后隐藏
  if (!app.isPackaged) {
    menuItems.push({
      label: '强制重载 (渲染进程崩溃后恢复)',
      click: () => {
        const win = getMainWindow();
        if (win && !win.isDestroyed()) {
          win.webContents.reload();
          win.show();
          win.focus();
        }
      }
    });
    menuItems.push({ type: 'separator' });
  }

  menuItems.push({
    label: '重启',
    click: () => {
      app.relaunch();
      app.exit(0);
    }
  });

  menuItems.push({
    label: '退出',
    click: () => {
      tray?.destroy();
      tray = null;
      app.quit();
    }
  });

  const contextMenu = Menu.buildFromTemplate(menuItems);

  tray.setToolTip('HClaw');
  tray.setContextMenu(contextMenu);

  tray.on('click', () => {
    const win = getMainWindow();
    if (win?.isVisible()) {
      win.hide();
    } else {
      win?.show();
      win?.focus();
    }
  });
};
