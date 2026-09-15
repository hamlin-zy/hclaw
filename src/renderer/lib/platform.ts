/** 渲染进程平台判定（navigator.platform 口径，与 Kbd / ShortcutRow 既有实现一致） */
export const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().indexOf('MAC') >= 0
