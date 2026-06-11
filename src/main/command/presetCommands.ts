/**
 * 预设命令定义
 *
 * 仅保留无对应 Agent 的预设命令（commit-msg），
 * 其余已有专用 Agent 的命令（explain/review/fix/test/plan/refactor/optimize）
 * 已移除——使用对应 Agent 可获得更完整的能力。
 *
 * 首次启动时由 ensureConfigLayout() 写入 ~/.hclaw/commands/ 目录。
 */

import yaml from 'js-yaml'

interface CommandArg {
  name: string
  description?: string
  required?: boolean
  default?: string
}

interface PresetCommandDef {
  name: string
  description: string
  enabled?: boolean
  args?: CommandArg[]
  content: string
}

const PRESET_COMMANDS: PresetCommandDef[] = [
  {
    name: 'commit-msg',
    description: '生成规范的 Git 提交信息——符合 Conventional Commits',
    args: [{name: 'diff', description: 'git diff 输出', required: true}],
    content: [
      '请根据以下 git diff 信息，生成规范的 Git 提交信息。',
      '',
      '## 格式要求',
      '',
      '- 遵循 Conventional Commits 规范',
      '- 类型：feat / fix / refactor / perf / docs / test / chore / style / ci',
      '',
      '```',
      '<type>(<scope>): <简短描述>',
      '',
      '<详细说明（可选的）>',
      '',
      '<关联 Issue / PR（可选的）>',
      '```',
      '',
      '## 输出内容',
      '',
      '1. **提交信息** — 直接可用的 git commit 标题',
      '2. **说明** — 改动的背景和动机',
      '3. **文件变更清单** — 新增/修改/删除的文件及其概要',
      '',
      '## 注意事项',
      '',
      '- 标题不超过 72 字符',
      '- 使用祈使句（Add 而不是 Added 或 Adds）',
      '- 如果存在破坏性变更，必须在尾部标注 BREAKING CHANGE',
      '- 如有多个独立变更，生成多个提交信息并标注建议合并还是拆分',
      '',
      '以下是 git diff 输出：',
      '```',
      '$ARGUMENTS',
      '```',
    ].join('\n'),
  },
]

/**
 * 不再属于预设的命令列表（已被对应的 Agent 取代）
 * 用于 ensureConfigLayout 清理磁盘上的冗余文件
 */
export const OBSOLETE_PRESET_COMMANDS = [
  'explain',   // → code-explorer agent
  'refactor',  // → code-simplifier / refactor-cleaner agent
  'test',      // → tdd-guide agent
  'plan',      // → Plan Agent / architect agent
  'review',    // → code-reviewer agent
  'optimize',  // → performance-optimizer agent
  'fix',       // → build-error-resolver agent
]

/**
 * 将预设命令定义生成为 Markdown 字符串（YAML frontmatter + body）
 */
export function commandToMarkdown(cmd: PresetCommandDef): string {
  const frontmatter: Record<string, unknown> = {
    name: cmd.name,
    description: cmd.description,
    enabled: cmd.enabled ?? true,
  }
  if (cmd.args?.length) {
    frontmatter.args = cmd.args
  }

  return `---\n${yaml.dump(frontmatter).trimEnd()}\n---\n\n${cmd.content}`
}

/**
 * 获取所有预设命令的 Markdown 内容
 */
export function getPresetCommandMarkdownFiles(): Array<{filename: string; content: string}> {
  return PRESET_COMMANDS.map(cmd => ({
    filename: `${cmd.name}.md`,
    content: commandToMarkdown(cmd),
  }))
}

/**
 * 根据命令名查找预设命令
 */
export function getPresetCommand(name: string): PresetCommandDef | undefined {
  return PRESET_COMMANDS.find(cmd => cmd.name === name)
}

/**
 * 获取预设命令名列表
 */
export function getPresetCommandNames(): string[] {
  return PRESET_COMMANDS.map(cmd => cmd.name)
}
