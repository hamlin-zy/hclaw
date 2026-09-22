/** memory:list 返回的文件条目 */
export interface MemoryFileEntry {
  /** 文件绝对路径 */
  path: string;
  /** 语义化标签 */
  label: string;
  /** 字节上限（0=不限） */
  sizeLimit: number;
}

/** memory:list 返回的项目条目 */
export interface MemoryProjectEntry {
  /** 项目目录名（ref/ 下的子目录名） */
  dir: string;
  /** index.json 中的 projectName */
  projectName: string;
  /** index.json 中的 key（workspace 路径） */
  workspacePath: string;
  /** memory.md */
  memoryFile?: MemoryFileEntry;
  /** archive/*.md */
  archiveFiles: MemoryFileEntry[];
}

/** memory:list 返回结构 */
export interface MemoryListResult {
  /** 全局文件（_user/preferences.md） */
  globalFiles: MemoryFileEntry[];
  /** 项目列表 */
  projects: MemoryProjectEntry[];
}

/** memory:read 响应 */
export type MemoryReadResult =
  | { content: string }
  | { error: 'not-found' }
  | { error: 'invalid-path' }
  | { error: 'read-error'; message: string };

/** memory:write 响应 */
export type MemoryWriteResult =
  | { success: true }
  | { error: string; message: string };

/** memory:delete 响应 */
export type MemoryDeleteResult =
  | { success: true }
  | { error: string; message: string };

/** memory IPC 请求参数 */
export interface MemoryReadArgs {
  filePath: string;
}
export interface MemoryWriteArgs {
  filePath: string;
  content: string;
}
export interface MemoryDeleteArgs {
  targetPath: string;
  recursive: boolean;
}
