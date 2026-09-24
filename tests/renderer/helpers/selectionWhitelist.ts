/**
 * 选区白名单挂点清单（契约文件）。
 *
 * 每一条 = 一个「内容容器」应当在源码里带上 `select-text`。
 * 判定用 hasNearbyAnchor：marker 出现处的前后 window 字符内必须出现 needle，
 * 因此对类名顺序、多行 JSX、属性换行等书写形态都稳健。
 *
 * 该判定的能力边界（请勿高估）：
 *
 * 1. 能抓到：挂点被删掉；marker 所在的那段代码被整段删除；挂点被搬到距 marker
 *    超过 window 个字符的地方；marker 本身写错（元素属性或类名改动后 marker 不再命中）。
 * 2. 抓不到：marker 附近确实出现了 `select-text`，但它并未挂在该元素上 ——
 *    把挂点移到同一窗口内的邻近元素、兄弟节点或叶子节点，断言依然全绿；
 *    把类名写进模板字符串的动态段（字符串在源码里存在，运行时却不一定落到该元素）同样不报警。
 *    也就是说，它只校验「附近存在」，不校验「挂在哪个元素上」，也不校验层叠后是否真的生效。
 * 3. 宽松侧：同一文件内同名 marker 出现多次时，只要仍被搜索到的任一出现处附近命中，即视为通过。
 *
 * 另外，hasNearbyAnchor 对空 marker 直接返回 false：空串的 indexOf 恒为 0、搜索起点无法推进，
 * 会让下面的 while 永不终止，故清单条目的 marker 必须非空。
 */
export interface WhitelistAnchor {
  /** 相对仓库根的文件路径 */
  file: string
  /** 该文件内的稳定锚点标识（data-name 或既有容器类名） */
  marker: string
  /** 人类可读说明，失败信息用 */
  label: string
}

export const SELECTION_WHITELIST: WhitelistAnchor[] = [
  // ── Task 2：主窗口核心内容容器 ──
  {file: 'src/renderer/components/message-list/MessageList.tsx', marker: 'data-name="message-list-scroll-container"', label: '消息列表滚动容器'},
  {file: 'src/renderer/components/ConversationSidebar.tsx', marker: 'ref={listRef}', label: '会话列表容器'},
  // marker 由计划的 space-y-1.5（该文件内出现 3 次，判别力不足）替换为唯一的结构类名组合
  {file: 'src/renderer/components/memo/MemoPanel.tsx', marker: 'flex-1 overflow-y-auto px-[var(--space-relaxed)] py-[var(--space-snug)]', label: '备忘录内容区'},
  {file: 'src/renderer/components/common/Modal.tsx', marker: 'data-name="modal-panel"', label: '通用弹窗面板'},
  {file: 'src/renderer/components/ConfirmDialog.tsx', marker: 'whitespace-pre-wrap', label: '确认弹窗正文'},
  {file: 'src/renderer/components/AskUserModal.tsx', marker: 'max-h-[50vh] overflow-y-auto', label: '提问弹窗正文'},
  {file: 'src/renderer/components/message-list/SubAgentViewer.tsx', marker: 'custom-scrollbar', label: '子 Agent 查看器正文'},
  // ── Task 3：主窗口浮层与选择器 ──
  {file: 'src/renderer/components/plugin/CommandList.tsx', marker: 'ref={scrollRef}', label: '命令面板列表'},
  {file: 'src/renderer/components/PhrasePicker.tsx', marker: 'ref={listRef}', label: '短语选择器列表'},
  {file: 'src/renderer/components/plugin/ParamInputModal.tsx', marker: 'param-modal-body', label: '参数输入弹窗正文'},
  {file: 'src/renderer/components/ThemedSelect.tsx', marker: 'max-h-[240px] overflow-y-auto', label: '下拉选择器选项容器'},
  {file: 'src/renderer/components/ThemedCombobox.tsx', marker: 'max-h-[240px] overflow-y-auto', label: '组合框候选容器'},
  {file: 'src/renderer/components/ModelSelector.tsx', marker: 'min-h-0 overflow-y-auto', label: '模型选择器服务商列表'},
  {file: 'src/renderer/components/ModelSelector.tsx', marker: 'max-h-72 overflow-y-auto', label: '模型选择器模型列表'},
  {file: 'src/renderer/components/SchemeSelector.tsx', marker: 'p-1.5 flex flex-col', label: '方案选择器选项列表'},
  // ── Task 4：独立窗口正文 ──
  {file: 'src/renderer/components/LlmLogsWindow.tsx', marker: 'font-mono text-xs leading-relaxed', label: '日志窗口请求/响应正文区'},
  {file: 'src/renderer/components/LlmLogsWindow.tsx', marker: 'data-name="llm-logs-summary"', label: '日志窗口摘要条（统计卡）'},
  {file: 'src/renderer/components/llmTrace/TimelineView.tsx', marker: 'px-4 pt-3 pb-10', label: '日志时间线列表'},
  {file: 'src/renderer/components/usage/UsageWindow.tsx', marker: 'p-5 space-y-5', label: '用量窗口数据区'},
  {file: 'src/renderer/components/ConfigDialogWindow.tsx', marker: 'flex-1 min-h-0 overflow-hidden', label: '配置类窗口内容区（覆盖全部 dialogType）'},
  {file: 'src/renderer/components/dialogs/AboutDialog.tsx', marker: 'pt-7 pb-6 px-8', label: '关于弹窗正文'},
  {file: 'src/renderer/components/dialogs/AboutDialog.tsx', marker: 'data-name="about-dialog-update-detail"', label: '关于弹窗更新详情'},
  {file: 'src/renderer/components/dialogs/UpdateNoticeDialog.tsx', marker: 'w-full mt-3 rounded-[10px] overflow-hidden', label: '更新提示对话框详情'},
  {file: 'src/renderer/components/dialogs/UpdateNoticeDialog.tsx', marker: 'px-6 pb-4', label: '更新提示对话框内容区'},
  // ── Task 5：错误文字与路径 ──
  {file: 'src/renderer/components/message-list/ToolCallError.tsx', marker: 'whitespace-pre-wrap font-mono', label: '工具调用错误正文'},
  {file: 'src/renderer/App.tsx', marker: 'text-center space-y-3', label: '错误边界错误信息'},
  // marker 由计划的 pl-5 text-[var(--text-muted)]（该文件内出现 2 次：错误行与底部 tip，判别力不足）替换为带 key 的唯一前缀；
  // 注意不能以 className 的闭合引号结尾，否则追加类名后 marker 自身即失效
  {file: 'src/renderer/components/common/LoadErrorBanner.tsx', marker: 'key={i} className="pl-5 text-[var(--text-muted)]', label: '加载失败横幅错误行'},
  {file: 'src/renderer/components/common/AsyncBoundary.tsx', marker: 'role="alert"', label: '异步边界错误区'},
  {file: 'src/renderer/components/common/WindowTitleBar.tsx', marker: 'data-testid="titlebar-subtitle"', label: '标题栏副标题（路径）'},
  // marker 由计划的 currentWorkspacePath（该文件内出现 18 次，判别力不足）替换为工作目录行 <span> 的唯一类名组合
  {file: 'src/renderer/components/ConversationSidebar.tsx', marker: 'text-[11px] text-gray-400 dark:text-gray-500 font-medium truncate block w-full', label: '侧栏当前工作目录'},
  // Task 5-6 逐批追加
  // ── Task 6：项目管理窗口 ──
  {file: 'src/renderer/project-manager/components/EditorArea.tsx', marker: 'pm-editor-body', label: 'PM 编辑区正文'},
  {file: 'src/renderer/project-manager/components/FileTree.tsx', marker: 'aria-label="文件树"', label: 'PM 文件树'},
  // marker 由计划的 role="tree" className="pm-tree-scroll"（以 className 闭合引号结尾，挂类后自身即失效）削去尾部引号
  {file: 'src/renderer/project-manager/components/GitStatusPanel.tsx', marker: 'role="tree" className="pm-tree-scroll', label: 'PM 变更列表'},
  {file: 'src/renderer/project-manager/components/GitDagGraph.tsx', marker: 'pm-commits-scroll', label: 'PM 提交列表'},
  {file: 'src/renderer/project-manager/components/GitCommitDetail.tsx', marker: 'pm-detail-scroll', label: 'PM 提交详情滚动区'},
  {file: 'src/renderer/project-manager/components/GitCommitDetail.tsx', marker: 'pm-detail-footer', label: 'PM 提交详情 footer（提交信息）'},
  // marker 同上：削去 className 的尾部引号，避免挂 select-text 后 marker 自毁
  {file: 'src/renderer/project-manager/components/GitBranchTree.tsx', marker: 'role="tree" className="pm-tree-scroll', label: 'PM 分支树'},
  // marker 由计划的 pm-quickopen-list（该文件内出现 2 次：className 与同级 data-testid，同一元素）替换为唯一的 data-testid 前缀
  // 注意不能以 className 的闭合引号结尾，否则追加类名后 marker 自身即失效
  {file: 'src/renderer/project-manager/components/QuickOpen.tsx', marker: 'data-testid="pm-quickopen-list', label: 'PM QuickOpen 结果列表'},
  // marker 由计划的 pm-quickopen-preview-lines（该文件内出现 2 次：同一行内的 className 与 data-testid）替换为唯一的 data-testid 前缀
  {file: 'src/renderer/project-manager/components/QuickOpenPreview.tsx', marker: 'data-testid="pm-quickopen-preview-lines', label: 'PM QuickOpen 预览代码'},
  {file: 'src/renderer/project-manager/components/StatusBar.tsx', marker: 'pm-status-bar-path', label: 'PM 状态栏路径与分支'},
  {file: 'src/renderer/project-manager/ui/ShortcutHelpDialog.tsx', marker: 'pointer-events-auto flex flex-col gap-3', label: 'PM 快捷键说明弹窗内容'},
  // ── 复核补挂：主窗口弹窗数据区与审批文本 ──
  {file: 'src/renderer/components/dialogs/UsageStatsDialog.tsx', marker: 'px-5 py-4 max-h-[60vh] overflow-y-auto', label: '用量统计弹窗数据区'},
  // marker 取铺底容器（而非行内 <code>）：该容器一次覆盖全部命令行，与仓内容器级挂点约定一致；
  // 同样不以 className 的闭合引号结尾，避免追加类名后 marker 自毁
  {file: 'src/renderer/components/PermissionConfirmModal.tsx', marker: 'bg-[var(--surface-muted)] rounded-lg p-3 space-y-1.5', label: '权限确认弹窗待执行命令文本'},
]

/** marker 附近（前后 window 字符窗口内）是否出现 needle */
export function hasNearbyAnchor(src: string, marker: string, needle: string, window = 400): boolean {
  // 空 marker 时 indexOf('') 恒为 0、搜索起点不推进，会让下面的 while 永不终止
  if (!marker) return false
  let i = src.indexOf(marker)
  while (i !== -1) {
    const seg = src.slice(Math.max(0, i - window), i + marker.length + window)
    if (seg.includes(needle)) return true
    i = src.indexOf(marker, i + 1)
  }
  return false
}

/** 校验整个清单，返回未命中的条目（空数组 = 全部通过） */
export function findMissingAnchors(srcByFile: Map<string, string>): WhitelistAnchor[] {
  return SELECTION_WHITELIST.filter(a => {
    const src = srcByFile.get(a.file)
    if (src === undefined) return true
    return !hasNearbyAnchor(src, a.marker, 'select-text')
  })
}
