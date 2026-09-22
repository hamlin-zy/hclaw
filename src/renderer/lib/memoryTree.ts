import type { MemoryListResult } from '../../shared/types/memoryIPC';

export interface TreeNodeData {
  key: string;
  label: string;
  icon?: string;
  filePath?: string;
  sizeLimit?: number;
  children?: TreeNodeData[];
  expandable?: boolean;
  defaultExpanded?: boolean;
  subtitle?: string;
  /** Node type for context menu differentiation */
  nodeType: 'root-user' | 'root-projects' | 'project' | 'file' | 'archive-folder' | 'archive-file';
}

export function buildTreeData(listResult: MemoryListResult): TreeNodeData[] {
  const tree: TreeNodeData[] = [];

  // Group globalFiles by _user（按路径段精确判定，避免子串误命中）
  const segsByPath = new Map<string, string[]>();
  for (const f of listResult.globalFiles) {
    segsByPath.set(f.path, f.path.split(/[\\/]+/));
  }
  const isUserFile = (f: { path: string }) => segsByPath.get(f.path)!.includes('_user');
  const userFiles = listResult.globalFiles.filter(isUserFile);

  // _user node
  if (userFiles.length > 0) {
    tree.push({
      key: 'root-user',
      label: '用户偏好',
      nodeType: 'root-user',
      expandable: true,
      defaultExpanded: true,
      children: userFiles.map((f) => ({
        key: `file:${f.path}`,
        label: f.label,
        filePath: f.path,
        sizeLimit: f.sizeLimit,
        nodeType: 'file' as const,
      })),
    });
  }

  // Project nodes（合并到单一虚拟分组「项目记忆」下，②收敛一级节点）
  const projectNodes: TreeNodeData[] = [];
  for (const project of listResult.projects) {
    const children: TreeNodeData[] = [];

    if (project.memoryFile) {
      children.push({
        key: `file:${project.memoryFile.path}`,
        label: '项目记忆',
        filePath: project.memoryFile.path,
        sizeLimit: project.memoryFile.sizeLimit,
        nodeType: 'file',
      });
    }

    if (project.archiveFiles.length > 0) {
      children.push({
        key: `archive:${project.dir}`,
        label: '归档卷',
        nodeType: 'archive-folder',
        expandable: true,
        defaultExpanded: false,
        children: project.archiveFiles.map((f) => ({
          key: `file:${f.path}`,
          label: f.label,
          filePath: f.path,
          sizeLimit: f.sizeLimit,
          nodeType: 'archive-file',
        })),
      });
    }

    if (children.length > 0) {
      projectNodes.push({
        key: `project:${project.dir}`,
        label: project.projectName,
        nodeType: 'project',
        expandable: true,
        defaultExpanded: true,
        children,
      });
    }
  }

  if (projectNodes.length > 0) {
    tree.push({
      key: 'root-projects',
      label: '项目记忆',
      nodeType: 'root-projects',
      expandable: true,
      defaultExpanded: true,
      children: projectNodes,
    });
  }

  return tree;
}

/** Flatten tree to a list of file-leaf nodes (for keyboard navigation). */
export function flattenFileNodes(tree: TreeNodeData[]): TreeNodeData[] {
  const result: TreeNodeData[] = [];
  function walk(nodes: TreeNodeData[]) {
    for (const node of nodes) {
      if (node.filePath) result.push(node);
      if (node.children) walk(node.children);
    }
  }
  walk(tree);
  return result;
}
