/**
 * 命令名校验工具
 *
 * 命令名称会被直接用作 `${name}.md` 文件名（见 src/main/plugin/ipc.ts），
 * 因此只允许「Unicode 字母、数字、下划线、连字符」。
 * 这样既支持中文等非 ASCII 命名，又排除了会破坏文件路径的字符
 * （空格、`/` `\` `:` `*` `?` `"` `<` `>` `|` `.` 等）。
 *
 * 此外还需拒绝 Windows 保留设备名（CON/NUL/COM1 等）：这类名称能通过字符
 * 白名单，但在 Windows 上创建同名文件会失败或指向设备。因白名单已禁止 `.`，
 * 名称即 basename，无需再做去扩展名处理。注意 `COM10`、`COM`、`CONT`、`LPT`
 * 并非保留名，应当放行。
 */

const COMMAND_NAME_PATTERN = /^[\p{L}\p{N}_-]+$/u

/** Windows 保留设备名（大小写不敏感） */
const WINDOWS_RESERVED_NAMES = new Set<string>([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

/**
 * 返回命令名称的校验错误（中文，供 UI 直接展示），合法时返回 null。
 * @param name 待校验的命令名称
 */
export function getCommandNameError(name: string): string | null {
    if (!name) {
        return '命令名称不能为空'
    }
    if (!COMMAND_NAME_PATTERN.test(name)) {
        return '命令名称只能包含中英文、数字、下划线或连字符'
    }
    if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) {
        return '该名称是系统保留名（如 CON、NUL、COM1），请换一个名称'
    }
    return null
}

/**
 * 判断命令名称是否合法。
 * @param name 待校验的命令名称
 */
export function isValidCommandName(name: string): boolean {
    return getCommandNameError(name) === null
}
