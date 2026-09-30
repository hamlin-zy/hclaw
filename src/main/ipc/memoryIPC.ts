import * as fs from 'fs';
import * as path from 'path';
import { getHclawDir } from '../hclawPaths';
import { getMemDir, getRefDir } from '../agent/memory/memoryLoader';
import {
  ARCHIVE_HEAD_BYTES,
  ARCHIVE_INDEX_DEFAULTS,
  extractArchiveSummary,
  toArchiveVolumeName,
} from '../agent/memory/archiveIndex';
import { safeHandle } from '../lib/safeHandle';
import type {
  MemoryListResult,
  MemoryFileEntry,
  MemoryProjectEntry,
  MemoryReadResult,
  MemoryWriteResult,
  MemoryDeleteResult,
} from '../../shared/types/memoryIPC';

// --- Path safety ---

export function validateMemoryPath(
  inputPath: string
): { kind: 'ref' | 'mem'; absPath: string; baseDir: string } | null {
  // Reject any input containing '..' segments outright — a resolved traversal
  // may still land inside mem/ or ref/, so containment check alone is not enough
  if (inputPath.split(/[\\/]+/).includes('..')) return null;

  const hclawDir = getHclawDir();
  const refDir = getRefDir(hclawDir);
  const memDir = getMemDir(hclawDir);
  const abs = path.resolve(inputPath);

  // Reject if the resolved path escapes both ref/ and mem/
  const relToRef = path.relative(refDir, abs);
  const relToMem = path.relative(memDir, abs);

  const inRef = relToRef === '' || (!relToRef.startsWith('..') && !path.isAbsolute(relToRef));
  const inMem = relToMem === '' || (!relToMem.startsWith('..') && !path.isAbsolute(relToMem));

  if (inRef) return { kind: 'ref', absPath: abs, baseDir: refDir };
  if (inMem) return { kind: 'mem', absPath: abs, baseDir: memDir };
  return null;
}

// --- Label resolution ---

/** Spec §3.5：拒绝符号链接（fs.lstat 不跟随链接自身）。目标不存在时返回 false，由上层按 ENOENT 处理。 */
function isSymbolicLinkSafe(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 祖先链校验：从 baseDir 起对 absPath 的每一级组件 lstat，任一级是符号链接
 * （Windows 目录 junction 同样命中）即拒绝。防止经 ref/、mem/ 内的目录 junction
 * 用内层路径读写删逃逸 containment（单查目标/直接子项拦不住中间层链接）。
 * 路径深度有限（数级目录），每次调用数个 lstat，性能可接受。
 * 组件不存在时停止（lstat 失败按 safe 返回 false），交由后续 read/write 的 ENOENT 处理。
 */
function hasSymlinkAncestor(baseDir: string, absPath: string): boolean {
  const rel = path.relative(baseDir, absPath);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  let cur = baseDir;
  for (const seg of rel.split(path.sep)) {
    cur = path.join(cur, seg);
    if (isSymbolicLinkSafe(cur)) return true;
  }
  return false;
}

const SIZE_LIMITS: Record<string, number> = {
  'memory.md': 8192,
  'preferences.md': 4096,
};

/** 只读归档卷头部 ARCHIVE_HEAD_BYTES 字节（与索引注入同一口径），避免整卷读入内存 */
function readArchiveHead(filePath: string): string {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(ARCHIVE_HEAD_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, ARCHIVE_HEAD_BYTES, 0);
    // 字节截断可能切出半个多字节字符，末尾的替换符直接丢掉
    return buf.subarray(0, bytesRead).toString('utf-8').replace(/\uFFFD$/, '');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 归档卷文件条目：label 与归档索引注入同口径（extractArchiveSummary +
 * ARCHIVE_INDEX_DEFAULTS.summaryMaxChars），读取失败时回落卷名。
 */
function toArchiveFileEntry(filePath: string, fileName: string): MemoryFileEntry {
  let label: string;
  try {
    label = extractArchiveSummary(
      readArchiveHead(filePath),
      fileName,
      ARCHIVE_INDEX_DEFAULTS.summaryMaxChars
    );
  } catch {
    // 扫描与读取之间卷被删除或不可读：回落卷名，不中断列表
    label = toArchiveVolumeName(fileName);
  }
  return { path: filePath, label, sizeLimit: 0 };
}

/** 扫描归档目录下的 .md 卷（目录不存在/不可读 → 空数组），按文件名排序 */
function scanArchiveFiles(dir: string): MemoryFileEntry[] {
  let fileNames: string[];
  try {
    fileNames = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
  return fileNames.map((fileName) => toArchiveFileEntry(path.join(dir, fileName), fileName));
}

// --- IPC handlers (exported for testing) ---

export async function listMemory(): Promise<MemoryListResult> {
  const hclawDir = getHclawDir();
  const refDir = getRefDir(hclawDir);

  const globalFiles: MemoryFileEntry[] = [];

  // Global files: _user/preferences.md
  const prefPath = path.join(refDir, '_user', 'preferences.md');
  if (fs.existsSync(prefPath)) {
    globalFiles.push({
      path: prefPath,
      label: '跨项目偏好',
      sizeLimit: SIZE_LIMITS['preferences.md'],
    });
  }

  // Projects: scan ref/ subdirectories, exclude _user and _-prefixed
  const projects: MemoryProjectEntry[] = [];

  // Read index.json for project name mapping
  let indexData: Record<string, { dir: string; projectName: string }> = {};
  const indexPath = path.join(refDir, 'index.json');
  if (fs.existsSync(indexPath)) {
    try {
      indexData = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
    } catch {
      // ignore corrupted index
    }
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(refDir).filter((name) => {
      const fullPath = path.join(refDir, name);
      return (
        fs.statSync(fullPath).isDirectory() &&
        !name.startsWith('_') &&
        name !== 'archive'
      );
    });
  } catch {
    // ref/ doesn't exist yet
  }

  for (const dir of entries) {
    const projectDir = path.join(refDir, dir);

    // Find projectName from index.json
    let projectName = dir;
    let workspacePath = '';
    for (const [ws, info] of Object.entries(indexData)) {
      if (info.dir === dir) {
        projectName = info.projectName || dir;
        workspacePath = ws;
        break;
      }
    }

    const entry: MemoryProjectEntry = {
      dir,
      projectName,
      workspacePath,
      archiveFiles: [],
    };

    // memory.md
    const memoryPath = path.join(projectDir, 'memory.md');
    if (fs.existsSync(memoryPath)) {
      entry.memoryFile = {
        path: memoryPath,
        label: '项目记忆',
        sizeLimit: SIZE_LIMITS['memory.md'],
      };
    }

    // archive/*.md
    const archiveDir = path.join(projectDir, 'archive');
    if (fs.existsSync(archiveDir)) {
      entry.archiveFiles = scanArchiveFiles(archiveDir);
    }

    // Only include projects that have memory.md or archive files
    if (entry.memoryFile || entry.archiveFiles.length > 0) {
      projects.push(entry);
    }
  }

  // 跨项目归档卷：ref/_user/archive/*.md（目录不存在 → 空数组，不报错）
  const crossProjectArchiveFiles = scanArchiveFiles(path.join(refDir, '_user', 'archive'));

  return { globalFiles, projects, crossProjectArchiveFiles };
}

export async function readMemory(filePath: string): Promise<MemoryReadResult> {
  const validated = validateMemoryPath(filePath);
  if (!validated) return { error: 'invalid-path' };
  // Spec §3.5：拒绝符号链接（防止经由链接读写边界外文件），含祖先链目录 junction
  if (hasSymlinkAncestor(validated.baseDir, validated.absPath)) return { error: 'invalid-path' };

  try {
    const content = fs.readFileSync(validated.absPath, 'utf-8');
    return { content };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { error: 'not-found' };
    return { error: 'read-error', message: e.message };
  }
}

export async function writeMemory(
  filePath: string,
  content: string
): Promise<MemoryWriteResult> {
  const validated = validateMemoryPath(filePath);
  // mem/ 只读，写入仅允许 ref/ 子树
  if (!validated || validated.kind !== 'ref')
    return { error: 'invalid-path', message: 'Path outside memory directories' };
  // Spec §3.5：拒绝符号链接（防止经由链接写边界外文件），含祖先链目录 junction
  if (hasSymlinkAncestor(validated.baseDir, validated.absPath))
    return { error: 'invalid-path', message: 'Symbolic links are not allowed' };

  try {
    fs.mkdirSync(path.dirname(validated.absPath), { recursive: true });
    fs.writeFileSync(validated.absPath, content, 'utf-8');
    return { success: true };
  } catch (e: any) {
    return { error: 'write-failed', message: e.message };
  }
}

export async function deleteMemory(
  targetPath: string,
  recursive: boolean
): Promise<MemoryDeleteResult> {
  const validated = validateMemoryPath(targetPath);
  // mem/ 与 ref/ 根目录只读，删除仅允许 ref/ 子树内的条目
  if (!validated || validated.kind !== 'ref')
    return { error: 'invalid-path', message: 'Path outside memory directories' };

  // Reject deleting root directories
  const hclawDir = getHclawDir();
  const refDir = getRefDir(hclawDir);
  const memDir = getMemDir(hclawDir);
  if (
    validated.absPath === refDir ||
    validated.absPath === memDir ||
    validated.absPath === path.join(refDir, '_user')
  ) {
    return { error: 'forbidden', message: 'Cannot delete root memory directories' };
  }

  // Spec §3.5：拒绝符号链接——目标祖先链（含目标，防目录 junction 内层逃逸），
  // 以及递归删除时目录内的直接子项（逐项 lstat，不跟随链接深入，
  // 防止 rmSync 递归穿越链接删边界外内容）
  if (hasSymlinkAncestor(validated.baseDir, validated.absPath))
    return { error: 'invalid-path', message: 'Symbolic links are not allowed' };
  if (recursive) {
    let childNames: string[] = [];
    try {
      childNames = fs.readdirSync(validated.absPath);
    } catch {
      // 目录不存在：交给下方 rmSync/unlink 的 ENOENT 分支
    }
    for (const name of childNames) {
      if (isSymbolicLinkSafe(path.join(validated.absPath, name)))
        return { error: 'invalid-path', message: 'Symbolic links are not allowed' };
    }
  }

  try {
    if (recursive) {
      fs.rmSync(validated.absPath, { recursive: true, force: false });
    } else {
      fs.unlinkSync(validated.absPath);
    }
    return { success: true };
  } catch (e: any) {
    if (e.code === 'ENOENT') return { error: 'not-found', message: 'File not found' };
    return { error: 'delete-failed', message: e.message };
  }
}

// --- IPC registration ---

export function initMemoryIPC(): void {
  safeHandle('memory:list', async () => {
    try {
      return await listMemory();
    } catch (e: any) {
      // 防御：异常也保持返回结构完整（渲染层对可选字段一律 ?? [] 兜底）
      return { globalFiles: [], projects: [], crossProjectArchiveFiles: [], error: e.message };
    }
  });

  safeHandle('memory:read', async (_e, args: { filePath: string }) => {
    return readMemory(args.filePath);
  });

  safeHandle('memory:write', async (_e, args: { filePath: string; content: string }) => {
    return writeMemory(args.filePath, args.content);
  });

  safeHandle('memory:delete', async (_e, args: { targetPath: string; recursive: boolean }) => {
    return deleteMemory(args.targetPath, args.recursive);
  });
}
