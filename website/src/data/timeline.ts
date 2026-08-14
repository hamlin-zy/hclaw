export interface TimelineItem {
  version: string;
  date: string;
  tag?: string;
  title: string;
  items: string[];
}

export const timelineItems: TimelineItem[] = [
  {
    version: 'v0.4.1', date: '2026-08-14', tag: '最新',
    title: '模型管理增强',
    items: ['服务商智能识别填充 + Base URL 格式校验', '一键拉取模型列表、批量测试、密钥脱敏'],
  },
  {
    version: 'v0.4.0', date: '2026-08-09',
    title: '架构级里程碑',
    items: ['块级增量持久化全链路，落库性能大幅优化', 'session_handoff 会话交接，长会话自动续接', '消息增量转换缓存，消除重复全量转换'],
  },
  {
    version: 'v0.3.7', date: '2026-08-05',
    title: '体验与提醒',
    items: ['工作区切换重构为右侧悬浮抽屉', 'Attention 提醒机制，权限请求不再被忽略'],
  },
  {
    version: 'v0.3.6', date: '2026-08-05',
    title: '性能优化',
    items: ['流式渲染帧级合并，流畅度提升约 12 倍', 'Agent 仅展示最终输出并释放过程数据'],
  },
  {
    version: 'v0.3.2', date: '2026-08-03',
    title: '统计与命令面板',
    items: ['会话用量统计完整功能（token / 缓存命中率）', '命令面板类型 tab + 能力徽章渲染'],
  },
  {
    version: 'v0.2.98', date: '2026-08-02',
    title: '视觉与重构',
    items: ['背景图功能（毛玻璃 / 裁边 / 透明度）', '模型适配器统一重构，流式解析与错误处理归一'],
  },
  {
    version: 'v0.2.70', date: '2026-06-15',
    title: '功能完善',
    items: ['核心功能逐步完善，产品趋于可用'],
  },
  {
    version: 'v0.2.31', date: '2026-06-05', tag: '起点',
    title: '项目起步',
    items: ['HClaw 首个记录版本，梦想从这里开始'],
  },
];
