export interface DocsNavItem {
  slug: string;
  title: string;
}

export interface DocsGroup {
  title: string;
  items: DocsNavItem[];
}

export const docsGroups: DocsGroup[] = [
  {
    title: '快速开始',
    items: [
      { slug: 'model_config', title: '模型配置' },
      { slug: 'model_schema', title: '模型方案' },
      { slug: 'work_dir', title: '工作目录' },
    ],
  },
  {
    title: '核心能力',
    items: [
      { slug: 'agent', title: 'Agent 管理' },
      { slug: 'skills', title: 'Skills 管理' },
      { slug: 'mcp', title: 'MCP 管理' },
      { slug: 'plugins', title: '插件管理' },
      { slug: 'commands', title: '快捷命令' },
      { slug: 'scheduler', title: '定时任务' },
    ],
  },
  {
    title: '会话与工具',
    items: [
      { slug: 'conversation', title: '会话管理' },
      { slug: 'tools', title: '工具管理' },
      { slug: 'prompt', title: '提示词管理' },
      { slug: 'models', title: '模型' },
    ],
  },
  {
    title: '渠道与扩展',
    items: [
      { slug: 'channels', title: '渠道管理' },
      { slug: 'hooks', title: 'Hook 系统' },
    ],
  },
];

export function findTitle(slug: string): string {
  for (const g of docsGroups) {
    const it = g.items.find((x) => x.slug === slug);
    if (it) return it.title;
  }
  return slug;
}
