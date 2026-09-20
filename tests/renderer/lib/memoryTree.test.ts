import { describe, it, expect } from 'vitest';
import { buildTreeData } from '@/renderer/lib/memoryTree';
import type { MemoryListResult } from '@/shared/types/memoryIPC';

describe('buildTreeData', () => {
  const input: MemoryListResult = {
    globalFiles: [
      { path: '/ref/_user/preferences.md', label: '跨项目偏好', sizeLimit: 4096 },
      { path: '/mem/SKILL.md', label: '记忆索引', sizeLimit: 2048 },
    ],
    projects: [
      {
        dir: 'hclaw',
        projectName: 'hclaw',
        workspacePath: 'E:\\workspace\\hclaw',
        memoryFile: { path: '/ref/hclaw/memory.md', label: '项目记忆', sizeLimit: 8192 },
        archiveFiles: [
          { path: '/ref/hclaw/archive/a.md', label: 'OpenRouter 专项', sizeLimit: 0 },
          { path: '/ref/hclaw/archive/b.md', label: 'UI 配色收敛', sizeLimit: 0 },
        ],
      },
      {
        dir: 'guali',
        projectName: 'guali',
        workspacePath: 'E:\\guali',
        memoryFile: { path: '/ref/guali/memory.md', label: '项目记忆', sizeLimit: 8192 },
        archiveFiles: [],
      },
    ],
  };

  it('converges top level to three nodes in fixed order: 用户偏好 / 记忆索引 / 项目记忆', () => {
    const tree = buildTreeData(input);
    expect(tree).toHaveLength(3);
    expect(tree.map((n) => n.label)).toEqual(['用户偏好', '记忆索引', '项目记忆']);
  });

  it('用户偏好 node keeps children and default expanded', () => {
    const tree = buildTreeData(input);
    expect(tree[0]!.label).toBe('用户偏好');
    expect(tree[0]!.defaultExpanded).toBe(true);
    expect(tree[0]!.children).toHaveLength(1);
    expect(tree[0]!.children![0].filePath).toBe('/ref/_user/preferences.md');
  });

  it('记忆索引 node defaults collapsed with 自动生成 subtitle', () => {
    const tree = buildTreeData(input);
    expect(tree[1]!.label).toBe('记忆索引');
    expect(tree[1]!.defaultExpanded).toBe(false);
    expect(tree[1]!.subtitle).toBe('自动生成');
    expect(tree[1]!.children![0].filePath).toBe('/mem/SKILL.md');
  });

  it('项目记忆 is a virtual grouping node (no filePath) containing project nodes', () => {
    const tree = buildTreeData(input);
    const projectsNode = tree[2]!;
    expect(projectsNode.label).toBe('项目记忆');
    expect(projectsNode.nodeType).toBe('root-projects');
    expect(projectsNode.filePath).toBeUndefined();
    expect(projectsNode.expandable).toBe(true);
    expect(projectsNode.defaultExpanded).toBe(true);
    expect(projectsNode.children).toHaveLength(2);

    const hclaw = projectsNode.children![0]!;
    expect(hclaw.label).toBe('hclaw');
    expect(hclaw.nodeType).toBe('project');
    expect(hclaw.defaultExpanded).toBe(true);
    // 层级：项目记忆 → 项目 → 文件/归档卷
    expect(hclaw.children![0].label).toBe('项目记忆');
    expect(hclaw.children![0].filePath).toBe('/ref/hclaw/memory.md');
    const archive = hclaw.children![1]!;
    expect(archive.label).toBe('归档卷');
    expect(archive.defaultExpanded).toBe(false);
    expect(archive.children).toHaveLength(2);

    const guali = projectsNode.children![1]!;
    expect(guali.label).toBe('guali');
    expect(guali.children![0].filePath).toBe('/ref/guali/memory.md');
  });

  it('handles empty result', () => {
    const tree = buildTreeData({ globalFiles: [], projects: [] });
    expect(tree).toEqual([]);
  });

  it('omits 项目记忆 node when no projects exist', () => {
    const tree = buildTreeData({
      globalFiles: [{ path: '/ref/_user/preferences.md', label: '跨项目偏好', sizeLimit: 4096 }],
      projects: [],
    });
    expect(tree).toHaveLength(1);
    expect(tree[0]!.label).toBe('用户偏好');
  });

  it('handles project with no archive files', () => {
    const input: MemoryListResult = {
      globalFiles: [],
      projects: [
        {
          dir: 'test',
          projectName: 'test',
          workspacePath: '',
          memoryFile: { path: '/ref/test/memory.md', label: '项目记忆', sizeLimit: 8192 },
          archiveFiles: [],
        },
      ],
    };
    const tree = buildTreeData(input);
    expect(tree).toHaveLength(1); // only 项目记忆 virtual node
    expect(tree[0]!.children).toHaveLength(1); // one project
    expect(tree[0]!.children![0].children).toHaveLength(1); // only memory.md, no archive folder
  });

  it('handles project with no memory.md but has archives', () => {
    const input: MemoryListResult = {
      globalFiles: [],
      projects: [
        {
          dir: 'test',
          projectName: 'test',
          workspacePath: '',
          archiveFiles: [
            { path: '/ref/test/archive/a.md', label: 'Archive A', sizeLimit: 0 },
          ],
        },
      ],
    };
    const tree = buildTreeData(input);
    expect(tree[0]!.children![0].children).toHaveLength(1); // only archive folder
    expect(tree[0]!.children![0].children![0].label).toBe('归档卷');
  });
});
