import { globalShortcut } from 'electron';
import { getMainWindow } from './window';

/** 注册全局快捷键 */
export const registerGlobalShortcuts = (): void => {
  globalShortcut.register('CommandOrControl+Shift+Space', () => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return;

    // Toggle: 窗口可见时隐藏，不可见/最小化时显示
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
      mainWindow.hide();
    } else {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.show();
      mainWindow.focus();
    }
  });
};
