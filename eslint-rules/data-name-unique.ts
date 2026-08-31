// data-name 唯一性规则：JSX 中 data-name 字面量值全局唯一。
// 规范见 docs/superpowers/specs/2026-08-31-data-name-design.md
import type { Rule } from 'eslint'

const seen = new Map<string, { line: number; column: number }>()
const NAME_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/

const rule: Rule.RuleModule = {
  create(context: Rule.RuleContext) {
    return {
      JSXAttribute(node: any) {
        if (node.name?.name !== 'data-name') return
        const value = node.value
        if (!value || value.type !== 'Literal' || typeof value.value !== 'string') return
        const name = value.value
        const loc = { line: node.loc?.start.line ?? 0, column: node.loc?.start.column ?? 0 }
        const prev = seen.get(name)
        if (prev && !(prev.line === loc.line && prev.column === loc.column)) {
          context.report({ node, messageId: 'duplicate', data: { name } })
          return
        }
        seen.set(name, loc)
        if (!NAME_RE.test(name)) {
          context.report({ node, messageId: 'badFormat', data: { name } })
        }
      },
      'Program:exit'() {
        // flat config 单文件一份 Program：跨文件去重靠 lint 进程级 Map，
        // 每个文件 exit 后不清空（进程结束时 Map 随之销毁）。
      },
    }
  },
  meta: {
    type: 'problem',
    docs: { description: 'data-name 值必须全局唯一且为 kebab-case' },
    messages: {
      duplicate: 'data-name "{{name}}" 重复（规范要求全局唯一）',
      badFormat: 'data-name "{{name}}" 不符合 kebab-case 规范 ^[a-z][a-z0-9]*(-[a-z0-9]+)*$',
    },
    schema: [],
  },
} as any

export default rule
