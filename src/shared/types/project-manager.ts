// src/shared/types/project-manager.ts

export interface GitStatus {
  path: string                // 相对 workspace root，统一 '/'
  status: 'M' | 'A' | 'D' | 'R' | '??'
  indexStatus: string         // porcelain 第一列
  worktreeStatus: string      // porcelain 第二列
  oldPath?: string            // R 状态的原始路径
}

export interface GitStatusSummary {
  statusMap: Record<string, GitStatus>
  additions: number
  deletions: number
  updatedAt: number
}

// git log 查询参数（主进程 src/main/project-manager/git/log.ts 同名接口）
export interface LogOptions {
  limit: number
  skip?: number
  filterText?: string
  filterBranch?: string[]
  filterUser?: string[]
  filterDateRange?: [number, number]
  filterPaths?: string[]
  filterFlags?: {caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}
}

export interface GitLogEntry {
  hash: string
  abbreviatedHash: string     // 9 字符
  parents: string[]
  message: string
  body: string
  author: string
  authorEmail: string
  authorDate: number
  date: number
  branches: string[]
  tags: string[]
  isHead: boolean
}

/** git 作者聚合项（`git shortlog -sne`；分组键 = name + email，不做 mailmap 归一） */
export interface GitAuthor {
  name: string
  email: string
  commits: number
}

export interface GitCommitFiles {
  hash: string
  message: string
  files: GitCommitFile[]
}

export interface GitCommitFile {
  path: string
  status: 'M' | 'A' | 'D' | 'R'
  oldPath?: string
  additions: number
  deletions: number
}

export interface DirEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  gitStatus: 'none' | 'M' | 'A' | 'D' | 'R' | '??'
  hasChildren: boolean
  /** 是否被 .gitignore 命中（spec §6.3）。必填：强制所有构造点显式处理，避免新增消费方静默漏掉。 */
  ignored: boolean
}

export interface FileContentResult {
  path: string
  size: number
  content: string | null      // >5MB 或解码失败返回 null
  isBinary: boolean
  isImage: boolean
  decodeError: boolean
  mimeType: string
  truncated: boolean
  mtime: number
  hash: string
  base64?: string             // 图片（≤5MB）返回原始数据 base64，渲染端拼 dataURL
}

export interface DiffResult {
  filePath: string
  oldContent: string
  newContent: string
  diffType: 'working-tree' | 'commit'
  oldRef: string
  newRef: string
  additions: number
  deletions: number
}

export interface BranchTreeNode {
  name: string
  hash: string
  type: 'HEAD' | 'local' | 'remote' | 'tag'
  isCurrent: boolean
  isRemote: boolean
  remoteName?: string
}

// ─── PM 快速导航（QuickOpen）：主进程检索服务的数据形状 ───
// 契约见 .scratch/pm-quickopen/spec.md「数据来源」段：文件清单 / 全文检索 / 按行读取三项能力
// 均由主进程承担，IPC handler 只当薄壳；匹配区间一律由主进程给出，renderer 不重算。

/** File Search 命中项（工作区文件清单里命中查询的文件） */
export interface FileSearchHit {
  /** 相对 workspace root，统一 '/' */
  path: string
  /** 命中区间在 path 中的 0-based 下标（[matchStart, matchEnd)），列表据此标高亮 */
  matchStart: number
  matchEnd: number
}

/** 按行范围读取结果（QuickOpen 预览取数；按行读，不整体载入文件） */
export interface FileSliceResult {
  path: string
  /** 实际返回的首行行号（1-based） */
  startLine: number
  /** 实际返回的末行行号（1-based，含） */
  endLine: number
  /**
   * 文件总行数（空文件为 0）。
   * **-1 = 未知**：因读到 endLine 即停、未走到文件尾时刻意不数总行数（大文件上这是有意的性能取舍）。
   * 消费方必须容忍 -1，不要当成行号渲染。
   */
  totalLines: number
  /** 文件字节数（元信息行用；取数失败时不返回） */
  size?: number
  /** 文件修改时间（ms 时间戳；取数失败时不返回） */
  mtime?: number
  /** 行文本（不含行尾换行符） */
  lines: string[]
  /** 请求范围已抵达文件尾且文件不超过阈值时一并返回全文，供编辑器标签页直接使用（省第二次全量读） */
  fullContent?: string
  /** 与 fullContent 配套的内容哈希 */
  hash?: string
  /** 取数失败的单行原因（超大 / 二进制 / 无权限 / 路径已消失）；有值时 lines 为 [] */
  error?: string
}

/** Find in Files 命中项：一处命中 = 文件 + 行号 + 行文本 */
export interface FindInFilesMatch {
  /** 相对 workspace root，统一 '/' */
  path: string
  /** 1-based 行号 */
  line: number
  /** 该行文本（不含行尾换行符） */
  text: string
  /** 行内命中区间的 0-based 下标（[matchStart, matchEnd)） */
  matchStart: number
  matchEnd: number
}

/** Find in Files 会话的翻页结果（页大小与上限一律以命中项计，不以文件计） */
export interface FindInFilesPage {
  matches: FindInFilesMatch[]
  /** 缓冲达到上限被截断：结果不完整，UI 必须标注 */
  truncated: boolean
  /** 检索是否已结束；false = 后续可能还有命中项（可继续翻页） */
  done: boolean
  /**
   * 检索不可用的单行原因（如 ripgrep 缺失 / 进程异常退出）。
   *
   * 为什么必须有这个字段：检索进程起不来时若只返回「0 个命中项」，UI 上就是
   * 「搜什么都搜不到」且毫无提示——打包产物漏掉 rg.exe 时正是如此（被误当成搜索逻辑的 bug）。
   * 有值即表示**这次检索没有真正执行**，调用方必须把原因显示出来，不能当成「无匹配」。
   */
  error?: string
}

/** 「发送到会话」投递载荷（PM 渲染进程 → 主进程 → 主窗口渲染进程） */
export interface SendToConversationPayload {
  /** 回执关联 ID（PM 生成，crypto.randomUUID()） */
  requestId: string
  /** PM 窗口的项目根（绝对路径） */
  workspacePath: string
  /** 已拼接好的 user 消息全文（上下文 + 指令） */
  content: string
  /** 新会话标题（由指令派生，仅 kind='new' 使用） */
  title?: string
  target: { kind: 'new' } | { kind: 'existing'; conversationId: string }
}

/** 「发送到会话」投递结果（收窄语义：只确认 user 消息已插入主窗口渲染端） */
export interface SendToConversationResult {
  ok: boolean
  error?: string
  /**
   * user 消息已插入后，agent loop 是否已启动/正在处理。
   * false 表示消息已落盘但 loop 未起来（注入失败且回退启动未确认），调用方可提示用户重试。
   */
  started?: boolean
}
