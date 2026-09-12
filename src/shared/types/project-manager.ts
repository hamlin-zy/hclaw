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
