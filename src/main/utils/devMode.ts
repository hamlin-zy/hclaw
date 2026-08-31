/**
 * 开发模式判定（主进程统一出口）
 *
 * 覆盖：npm run dev（NODE_ENV/HCLAW_DEV_MODE）、--inspect 调试、
 * 打包版带 --devtools 参数启动（HClaw.exe --devtools）。
 * 结果经 additionalArguments 以 --hclaw-dev 透传给渲染进程（preload 解析）。
 */
export function isDevMode(): boolean {
    return process.env.NODE_ENV === 'development'
        || process.env.HCLAW_DEV_MODE === 'true'
        || process.argv.includes('--inspect')
        || process.argv.includes('--devtools')
}

/**
 * Vite dev server 加载判定（仅窗口加载决策使用）
 *
 * 与 isDevMode 的区别：不含 --devtools。打包版带 --devtools 启动时，
 * dev server 并未运行，窗口若走 loadURL(localhost:5173) 会黑屏；
 * --devtools 只应影响 DevTools 开关与渲染层 dev 菜单项（经 --hclaw-dev 透传）。
 */
export function isViteDevServer(): boolean {
    return process.env.NODE_ENV === 'development'
        || process.env.HCLAW_DEV_MODE === 'true'
        || process.argv.includes('--inspect')
}
