/**
 * 工作区路径归一化键。
 *
 * ⚠ 仅用于渲染层的**比较与去重**，绝不可回传给主进程：
 * `workspaceRepository.getByPath` 是 `WHERE path = ?` 精确串匹配，主进程不做任何归一化，
 * 传归一化串会查不到工作区记录（见 src/main/repositories/sqlite/workspaceRepository.ts:150）。
 *
 * 口径：
 *  · 统一分隔符：`\` → `/`（两平台都做——同一目录的路径串可能来自不同来源）。
 *  · 去尾分隔符：`E:\Foo\` / `E:/Foo/` / `/a/b/` 与去尾后的形式等价。
 *  · 保留根：`/` 仍是 `/`（不塌成空串）；Windows 盘根 `C:\` → `C:/`（不削成 `C:`）。
 *  · 不折叠重复分隔符：UNC `\\srv\share` → `//srv/share`，不得塌成 `/srv/share`
 *    （后者会与本地 `/srv/share` 混淆）。
 *  · 大小写折叠**只在 Windows**：
 *      - POSIX 文件系统区分大小写，折叠会把两个真实存在的不同目录误判为同一个；
 *      - macOS 默认大小写不敏感，但存在大小写敏感卷；误合并会显示**错误的工作区**，
 *        比在侧栏留一条重复项更坏 —— 故 darwin 同样不折叠。
 *  · 平台取不到（如 node 环境的单测）→ 默认**不折叠**（POSIX 语义，即失败方向更安全的那一侧）。
 */

/** 平台判定：优先 IPC 预置的 process.platform；回退 navigator.platform（与 lib/platform.ts 同口径） */
function isWindowsPlatform(): boolean {
    const viaIpc = typeof window !== 'undefined' ? window.electronAPI?.platform : undefined
    if (viaIpc) return viaIpc === 'win32'
    const nav = typeof navigator !== 'undefined' ? navigator.platform : ''
    return /^win/i.test(nav || '')
}

/**
 * 「未归属」虚拟工作区键：workspacePath 为空的会话（如 MCP 诊断弹窗、scheduler
 * 定时任务创建的会话）在渲染层收进 workspaces[UNASSIGNED_WORKSPACE_KEY]。
 *
 * ⚠ 仅内存使用，不落库、不参与 workspacePathKey 归一化匹配：
 *  - 归一化只会改分隔符/大小写/尾分隔符，任何真实路径都不可能得到 '__unassigned__'
 *    （下划线开头且无分隔符），不会与真实路径冲突；
 *  - 消费方必须只把它当渲染层段 key，不得传给主进程 IPC。
 */
export const UNASSIGNED_WORKSPACE_KEY = '__unassigned__'

export function workspacePathKey(p: string): string {
    if (!p) return ''
    // 统一分隔符
    let k = p.replace(/\\/g, '/')
    // 去尾分隔符（保留根 '/'：只有长度 > 1 才削）
    if (k.length > 1) k = k.replace(/\/+$/, '')
    // 全部为分隔符（如 '///'）→ 视为根；盘根 'C:' 补回分隔符，与 'C:\' 等价
    if (!k) k = '/'
    else if (/^[A-Za-z]:$/.test(k)) k = `${k}/`
    // 大小写折叠仅 Windows（见上方口径说明）
    return isWindowsPlatform() ? k.toLowerCase() : k
}
