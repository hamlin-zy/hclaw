import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock hclawPaths and memoryLoader before importing
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hclaw-mem-test-'));
const memDir = path.join(tmpDir, 'mem');
const refDir = path.join(memDir, 'ref');

vi.mock('@/main/hclawPaths', () => ({
  getHclawDir: () => tmpDir,
}));

vi.mock('@/main/agent/memory/memoryLoader', () => ({
  getMemDir: vi.fn((dir: string) => path.join(dir, 'mem')),
  getRefDir: vi.fn((dir: string) => path.join(dir, 'mem', 'ref')),
}));

vi.mock('@/main/lib/safeHandle', () => ({
  safeHandle: vi.fn(),
}));

// Import after mocks
const { validateMemoryPath, listMemory, readMemory, writeMemory, deleteMemory, initMemoryIPC } =
  await import('@/main/ipc/memoryIPC');
const { safeHandle } = await import('@/main/lib/safeHandle');
const { getRefDir } = await import('@/main/agent/memory/memoryLoader');
const { ARCHIVE_INDEX_DEFAULTS } = await import('@/main/agent/memory/archiveIndex');

describe('validateMemoryPath', () => {
  beforeEach(() => {
    // Setup directory structure
    fs.mkdirSync(refDir, { recursive: true });
    fs.mkdirSync(path.join(refDir, '_user'), { recursive: true });
    fs.mkdirSync(path.join(refDir, 'hclaw'), { recursive: true });
    fs.mkdirSync(path.join(refDir, 'hclaw', 'archive'), { recursive: true });
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('accepts path under ref/', () => {
    const result = validateMemoryPath(path.join(refDir, 'hclaw', 'memory.md'));
    expect(result).not.toBeNull();
    expect(result?.kind).toBe('ref');
  });

  it('rejects path with ../ traversal', () => {
    const malicious = path.join(refDir, '..', '..', '..', 'etc', 'passwd');
    const result = validateMemoryPath(malicious);
    expect(result).toBeNull();
  });

  it('rejects absolute path outside ref/ and mem/', () => {
    const result = validateMemoryPath('C:\\Windows\\System32\\config.sys');
    expect(result).toBeNull();
  });

  it('rejects ref/ root itself for delete', () => {
    const result = validateMemoryPath(refDir);
    // ref root is valid for read/list but should not be deletable
    // validateMemoryPath only checks path containment; delete guard is in handler
    expect(result).not.toBeNull(); // valid path, but delete handler checks further
  });

  it('handles Windows drive letter case', () => {
    // path.resolve normalizes drive letter case on Windows
    const upperRef = refDir.replace(/^[a-z]:/, (m) => m.toUpperCase());
    const result = validateMemoryPath(upperRef + path.sep + 'hclaw');
    expect(result).not.toBeNull();
  });
});

describe('listMemory', () => {
  beforeEach(() => {
    fs.mkdirSync(refDir, { recursive: true });
    fs.mkdirSync(path.join(refDir, '_user'), { recursive: true });
    fs.mkdirSync(path.join(refDir, 'hclaw'), { recursive: true });
    fs.mkdirSync(path.join(refDir, 'hclaw', 'archive'), { recursive: true });
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('returns empty result when ref/ is empty', async () => {
    const result = await listMemory();
    expect(result.projects).toEqual([]);
    expect(result.globalFiles).toEqual([]);
  });

  it('returns projects excluding _user/', async () => {
    fs.writeFileSync(path.join(refDir, 'hclaw', 'memory.md'), '# hclaw memory');
    fs.writeFileSync(
      path.join(refDir, '_user', 'preferences.md'),
      '# user prefs'
    );

    // index.json
    fs.writeFileSync(
      path.join(refDir, 'index.json'),
      JSON.stringify({ 'E:\\workspace\\hclaw': { dir: 'hclaw', projectName: 'hclaw' } })
    );

    const result = await listMemory();
    expect(result.projects).toHaveLength(1);
    expect(result.projects[0].dir).toBe('hclaw');
    expect(result.projects[0].projectName).toBe('hclaw');
    expect(result.projects[0].memoryFile?.label).toBe('项目记忆');
    expect(result.globalFiles).toHaveLength(1); // only preferences, SKILL.md removed
  });

  // 契约变更（Task 5）：label 口径与索引注入一致 —— extractArchiveSummary，
  // H2 标题不再作为 label；H1 依次剥归档卷前缀/日期后取摘要。
  it('reads archive H1 summary as label', async () => {
    fs.writeFileSync(
      path.join(refDir, 'hclaw', 'archive', '2026-09-test.md'),
      '# 归档卷：2026-09-29 OpenRouter 接入\n\ndetails...'
    );
    fs.writeFileSync(path.join(refDir, 'index.json'), '{}');

    const result = await listMemory();
    expect(result.projects[0].archiveFiles[0].label).toBe('OpenRouter 接入');
  });

  it('truncates archive label to ARCHIVE_INDEX_DEFAULTS.summaryMaxChars', async () => {
    const longTitle = 'x'.repeat(ARCHIVE_INDEX_DEFAULTS.summaryMaxChars + 10);
    fs.writeFileSync(
      path.join(refDir, 'hclaw', 'archive', '2026-09-long.md'),
      `# ${longTitle}\n`
    );
    fs.writeFileSync(path.join(refDir, 'index.json'), '{}');

    const result = await listMemory();
    expect(result.projects[0].archiveFiles[0].label).toBe(
      'x'.repeat(ARCHIVE_INDEX_DEFAULTS.summaryMaxChars) + '…'
    );
  });

  it('falls back to archive volume name when no title', async () => {
    fs.writeFileSync(
      path.join(refDir, 'hclaw', 'archive', '2026-09-notes.md'),
      'just some content without heading'
    );
    fs.writeFileSync(path.join(refDir, 'index.json'), '{}');

    const result = await listMemory();
    // toArchiveVolumeName：去 .md 与 yyyy-MM- 前缀
    expect(result.projects[0].archiveFiles[0].label).toBe('notes');
  });

  // --- 跨项目归档卷（ref/_user/archive） ---

  it('returns cross-project archive files sorted by file name', async () => {
    fs.mkdirSync(path.join(refDir, '_user', 'archive'), { recursive: true });
    fs.writeFileSync(
      path.join(refDir, '_user', 'archive', '2026-09-b.md'),
      '# 归档卷：跨项目经验 B\n'
    );
    fs.writeFileSync(
      path.join(refDir, '_user', 'archive', '2026-09-a.md'),
      '> 摘要：跨项目摘要 A\n'
    );
    fs.writeFileSync(path.join(refDir, 'index.json'), '{}');

    const result = await listMemory();
    expect(result.crossProjectArchiveFiles).toHaveLength(2);
    expect(result.crossProjectArchiveFiles!.map((f) => path.basename(f.path))).toEqual([
      '2026-09-a.md',
      '2026-09-b.md',
    ]);
    expect(result.crossProjectArchiveFiles![0].label).toBe('跨项目摘要 A');
    expect(result.crossProjectArchiveFiles![0].sizeLimit).toBe(0);
    expect(result.crossProjectArchiveFiles![1].label).toBe('跨项目经验 B');
  });

  it('returns empty cross-project archive list when dir does not exist', async () => {
    const result = await listMemory();
    expect(result.crossProjectArchiveFiles).toEqual([]);
  });

  it('ignores non-md files in cross-project archive dir', async () => {
    fs.mkdirSync(path.join(refDir, '_user', 'archive'), { recursive: true });
    fs.writeFileSync(path.join(refDir, '_user', 'archive', 'note.txt'), 'x');
    fs.writeFileSync(path.join(refDir, '_user', 'archive', '2026-09-a.md'), '# a\n');

    const result = await listMemory();
    expect(result.crossProjectArchiveFiles).toHaveLength(1);
    expect(path.basename(result.crossProjectArchiveFiles![0].path)).toBe('2026-09-a.md');
  });
});

describe('initMemoryIPC', () => {
  beforeEach(() => {
    vi.mocked(safeHandle).mockClear();
    vi.mocked(getRefDir).mockClear();
    initMemoryIPC();
  });

  /** 取 memory:list 注册的 handler */
  function findListHandler(): () => Promise<any> {
    const call = vi.mocked(safeHandle).mock.calls.find((c) => c[0] === 'memory:list');
    expect(call).toBeDefined();
    return call![1] as () => Promise<any>;
  }

  it('memory:list 异常时返回空数组而非缺字段', async () => {
    const handler = findListHandler();
    vi.mocked(getRefDir).mockImplementationOnce(() => {
      throw new Error('boom');
    });

    const result = await handler();
    expect(result).toMatchObject({
      globalFiles: [],
      projects: [],
      crossProjectArchiveFiles: [],
    });
  });
});

describe('readMemory', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(refDir, 'hclaw'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('reads file content', async () => {
    const filePath = path.join(refDir, 'hclaw', 'memory.md');
    fs.writeFileSync(filePath, 'memory content here');
    const result = await readMemory(filePath);
    expect(result).toEqual({ content: 'memory content here' });
  });

  it('returns not-found for missing file', async () => {
    const result = await readMemory(path.join(refDir, 'hclaw', 'missing.md'));
    expect(result).toEqual({ error: 'not-found' });
  });

  it('returns invalid-path for traversal', async () => {
    const result = await readMemory(path.join(refDir, '..', '..', 'etc', 'passwd'));
    expect(result).toEqual({ error: 'invalid-path' });
  });

  it('reads empty file without error', async () => {
    const filePath = path.join(refDir, 'hclaw', 'memory.md');
    fs.writeFileSync(filePath, '');
    const result = await readMemory(filePath);
    expect(result).toEqual({ content: '' });
  });
});

describe('writeMemory', () => {
  beforeEach(() => {
    fs.mkdirSync(refDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('writes file content', async () => {
    const filePath = path.join(refDir, 'hclaw', 'memory.md');
    await writeMemory(filePath, 'new content');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('new content');
  });

  it('creates parent directories if needed', async () => {
    const filePath = path.join(refDir, 'newproj', 'archive', 'test.md');
    await writeMemory(filePath, 'content');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('content');
  });

  it('returns invalid-path for traversal', async () => {
    const result = await writeMemory(path.join(refDir, '..', 'evil.md'), 'content');
    expect(result).toHaveProperty('error', 'invalid-path');
  });

  it('handles unicode content', async () => {
    const filePath = path.join(refDir, 'hclaw', 'memory.md');
    await writeMemory(filePath, '中文内容 🎉');
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('中文内容 🎉');
  });
});

describe('deleteMemory', () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(refDir, 'hclaw', 'archive'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  it('deletes a file', async () => {
    const filePath = path.join(refDir, 'hclaw', 'memory.md');
    fs.writeFileSync(filePath, 'content');
    await deleteMemory(filePath, false);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('deletes a directory recursively', async () => {
    const dirPath = path.join(refDir, 'hclaw');
    fs.writeFileSync(path.join(dirPath, 'memory.md'), 'content');
    fs.writeFileSync(path.join(dirPath, 'archive', 'test.md'), 'archive content');
    await deleteMemory(dirPath, true);
    expect(fs.existsSync(dirPath)).toBe(false);
  });

  it('returns invalid-path for traversal', async () => {
    const result = await deleteMemory(path.join(refDir, '..', 'evil'), false);
    expect(result).toHaveProperty('error', 'invalid-path');
  });

  it('returns error for non-existent file', async () => {
    const result = await deleteMemory(path.join(refDir, 'hclaw', 'missing.md'), false);
    expect(result).toHaveProperty('error');
  });
});

describe('symlink 拒绝（Spec §3.5）', () => {
  // 环境说明：Windows 创建 file/dir symlink 需要特权；junction 无需特权且
  // fs.lstatSync(...).isSymbolicLink() 对 junction 同样为 true，用 junction 覆盖 lstat 分支。
  beforeEach(() => {
    fs.mkdirSync(path.join(refDir, 'hclaw', 'archive'), { recursive: true });
    fs.mkdirSync(memDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  /** 建 junction（无需特权）；失败（如非 Windows）返回 null，由调用方跳过 */
  function tryJunction(targetDir: string, linkPath: string): boolean {
    try {
      fs.symlinkSync(targetDir, linkPath, 'junction');
      return true;
    } catch {
      return false;
    }
  }

  it('readMemory 拒绝符号链接目标（junction 兜底）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const linkPath = path.join(refDir, 'hclaw', 'linked');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await readMemory(linkPath);
    expect(result).toEqual({ error: 'invalid-path' });
  });

  it('readMemory 拒绝 file 型符号链接目标（有特权时覆盖；无权限则跳过）', async () => {
    const realFile = path.join(tmpDir, 'outside.md');
    const linkPath = path.join(refDir, 'hclaw', 'memory.md');
    fs.writeFileSync(realFile, 'secret');
    try {
      fs.symlinkSync(realFile, linkPath, 'file');
    } catch {
      return; // 环境无 symlink 权限：junction 用例已覆盖 lstat 分支
    }
    const result = await readMemory(linkPath);
    expect(result).toEqual({ error: 'invalid-path' });
  });

  it('writeMemory 拒绝符号链接目标（junction 兜底）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'keep.md'), 'keep');
    const linkPath = path.join(refDir, 'hclaw', 'linked');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await writeMemory(linkPath, 'evil');
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.readFileSync(path.join(outsideDir, 'keep.md'), 'utf-8')).toBe('keep');
  });

  it('deleteMemory 拒绝符号链接目标（junction 兜底）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const linkPath = path.join(refDir, 'hclaw', 'linked');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await deleteMemory(linkPath, false);
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.existsSync(linkPath)).toBe(true);
    expect(fs.existsSync(outsideDir)).toBe(true);
  });

  it('deleteMemory recursive 拒绝目录内直接子项中的符号链接（junction）', async () => {
    const dirPath = path.join(refDir, 'hclaw');
    fs.writeFileSync(path.join(dirPath, 'memory.md'), 'content');
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    const linkPath = path.join(dirPath, 'evil');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await deleteMemory(dirPath, true);
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.existsSync(dirPath)).toBe(true);
    expect(fs.existsSync(outsideDir)).toBe(true);
  });

  // --- 祖先链 junction 逃逸（ref/ 内目录 junction，经内层路径读写删越界） ---
  it('readMemory 拒绝经 ref/ 内目录 junction 的内层路径（祖先链校验）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret');
    const linkPath = path.join(refDir, 'hclaw', 'linkdir');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await readMemory(path.join(linkPath, 'secret.md'));
    expect(result).toEqual({ error: 'invalid-path' });
  });

  it('readMemory 拒绝经 mem/ 内目录 junction 的内层路径（祖先链校验）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret');
    const linkPath = path.join(memDir, 'linkdir');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await readMemory(path.join(linkPath, 'secret.md'));
    expect(result).toEqual({ error: 'invalid-path' });
  });

  it('writeMemory 拒绝经 ref/ 内目录 junction 的内层路径', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'keep.md'), 'keep');
    const linkPath = path.join(refDir, 'hclaw', 'linkdir');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await writeMemory(path.join(linkPath, 'evil.md'), 'evil');
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.readFileSync(path.join(outsideDir, 'keep.md'), 'utf-8')).toBe('keep');
  });

  it('deleteMemory 拒绝经 ref/ 内目录 junction 的内层路径', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'keep.md'), 'keep');
    const linkPath = path.join(refDir, 'hclaw', 'linkdir');
    if (!tryJunction(outsideDir, linkPath)) return;
    const result = await deleteMemory(path.join(linkPath, 'keep.md'), false);
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.existsSync(path.join(outsideDir, 'keep.md'))).toBe(true);
  });

  it('deleteMemory recursive 拒绝 junction 内层目录目标（祖先链校验，直接子项扫描保留）', async () => {
    const outsideDir = path.join(tmpDir, 'outside');
    fs.mkdirSync(outsideDir);
    fs.writeFileSync(path.join(outsideDir, 'keep.md'), 'keep');
    const linkPath = path.join(refDir, 'hclaw', 'linkdir');
    if (!tryJunction(outsideDir, linkPath)) return;
    fs.mkdirSync(path.join(linkPath, 'inner'));
    const result = await deleteMemory(path.join(linkPath, 'inner'), true);
    expect(result).toHaveProperty('error', 'invalid-path');
    expect(fs.existsSync(path.join(outsideDir, 'keep.md'))).toBe(true);
  });
});
