// muted-text/informative：禁止把 --text-muted 用在「承载信息的小字」上。
//
// 契约（见 src/renderer/styles/globals.css 的 Text colors 段）：
//   --text-muted 是 AA 豁免档，四主题在 surface 上只有 3.28/4.22/3.34/3.31:1，
//   只允许用于图标、装饰线、placeholder、disabled 态、水印、进度轨道、纯分隔符。
//   凡承载信息（数值/时间/作者/类型/状态/说明文案）——无论字号多小——一律用
//   --text-secondary（四主题 surface 上 4.74/5.64/5.41/4.79:1，全部达标）。
//
// 命中 = className 字面量里同时出现
//          (1) `text-[var(--text-muted)]`
//          (2) 小字号档：text-xs / text-sm / text-base 或 text-[<=13px]
//   豁免 = 字面量看起来是「图标槽」：
//          同时有 w-<n> 与 h-<n>，或有 shrink-0，或同一 JSX 元素内渲染 *Icon 组件。
// （`scripts/audit-muted-text.mjs` 的口径更粗：它只认 text-xs/sm/base，text-[Npx] 记 UNKNOWN。）
//
// ── 已知盲区 / Known limitations ───────────────────────────────────────────
// stringLiteralOf() 只认「纯字符串字面量」形式的 className（见下方实现）：
//   "..." / {"..."} / {`...`}（无插值）。因此下列写法里的 className **看不见**：
//     - ConditionalExpression 的分支：
//         className={active ? 'text-[var(--text-muted)] text-xs' : '...'}
//     - TemplateLiteral 的插值分支：
//         className={`text-xs ${dim ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'}`}
//   这些分支里的 text-[var(--text-muted)] 不会命中本规则。
//
//   已知样本（均为条件类名）：
//     TodoStrip.tsx
//     TaskHistoryDialog.tsx
//     ConversationSidebar.tsx
//     UsageWindow.tsx
//     MessageBubble.tsx
//     llmTrace/TimelineView.tsx
//   其中多数是「未选中 / 已完成 / 折叠态」这类**有意压暗的 affordance**
//   （非信息性文案本身），压暗即设计意图，不应按信息性文案迁移。
//
//   结论：**有意不扩 AST**。扩 AST 到条件分支会把这些「有意压暗」误判为
//   违规，制造噪音；代价是少量真实违规可能漏网，靠人工 review 兜底。
import type {Rule} from 'eslint'

const TARGET = 'text-[var(--text-muted)]'
// 口径与 scripts/audit-muted-text.mjs 的 SMALL_SIZES 存在**有意**差异（本正则额外认
// text-[<=13px]），由 tests/eslint-rules/auditMutedTextSync.test.ts 钉住。导出以便测试断言。
export const SMALL_SIZE = /\btext-(?:xs|sm|base)\b|text-\[(?:\d|1[0-3])(?:\.\d+)?px\]/
const W_SIZE = /\bw-(?:\d+(?:\.\d+)?|\[[^\]]+\])/
const H_SIZE = /\bh-(?:\d+(?:\.\d+)?|\[[^\]]+\])/
const SHRINK = /\bshrink-0\b/
const ICON_NAME = /(?:^|[^A-Za-z0-9])[A-Z][A-Za-z0-9]*Icon$/

interface AttrLike {
  name?: {name?: string}
  value?: any
  parent?: any
}

/** 取出 className 的字符串字面量（支持 "..." / {"..."} / {`...`} 无插值）。取不到返回 null。 */
function stringLiteralOf(attr: AttrLike): {node: any; text: string} | null {
  const v = attr.value
  if (!v) return null
  if (v.type === 'Literal' && typeof v.value === 'string') return {node: v, text: v.value}
  if (v.type === 'JSXExpressionContainer') {
    const e = v.expression
    if (e?.type === 'Literal' && typeof e.value === 'string') return {node: e, text: e.value}
    if (e?.type === 'TemplateLiteral' && e.expressions?.length === 0 && e.quasis?.length === 1) {
      return {node: e, text: e.quasis[0].value?.cooked ?? e.quasis[0].value?.raw ?? ''}
    }
  }
  return null
}

/** 该属性所在的 JSX 元素是否内含 *Icon 组件（含自身标签名）。 */
function insideIconElement(attr: AttrLike): boolean {
  let el = attr.parent
  while (el && el.type === 'JSXAttribute') el = el.parent
  if (el?.type === 'JSXOpeningElement') el = el.parent
  if (el?.type !== 'JSXElement') return false
  const selfName = el.openingElement?.name?.name
  if (typeof selfName === 'string' && ICON_NAME.test(selfName)) return true
  for (const child of el.children ?? []) {
    if (child?.type !== 'JSXElement') continue
    const name = child.openingElement?.name?.name
    if (typeof name === 'string' && ICON_NAME.test(name)) return true
  }
  return false
}

const rule: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        '承载信息的小字不得使用 --text-muted（四主题均低于 WCAG AA 4.5:1），请改用 --text-secondary',
    },
    messages: {
      informative:
        '`{{target}}` 搭配小字号（{{size}}）承载信息时对比度不足（四主题 3.28/4.22/3.34/3.31:1，AA 需 4.5:1）。' +
        '信息性文字请改用 `--text-secondary`（4.74/5.64/5.41/4.79:1）。' +
        '若此处确为装饰/占位/禁用态/图标，请加 `// eslint-disable-next-line muted-text/informative` 并说明理由。',
    },
    schema: [],
  },
  create(context: Rule.RuleContext) {
    return {
      JSXAttribute(node: any) {
        if (node.name?.name !== 'className') return
        const lit = stringLiteralOf(node)
        if (!lit) return
        const text = lit.text
        if (!text.includes(TARGET)) return
        const size = text.match(SMALL_SIZE)?.[0]
        if (!size) return
        if (W_SIZE.test(text) && H_SIZE.test(text)) return
        if (SHRINK.test(text)) return
        if (insideIconElement(node)) return
        context.report({node: lit.node, messageId: 'informative', data: {target: TARGET, size}})
      },
    }
  },
}

export default rule
