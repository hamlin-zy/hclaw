import {absPath} from './absPath'
import {formatLineRanges} from './lineRanges'

/** 五种入口归约为三种上下文形态（spec §4.1） */
export type SendToConversationKind = 'files' | 'lines' | 'commits'

export type SendToConversationContext =
  | {kind: 'files'; paths: string[]}
  | {kind: 'lines'; filePath: string; lineNumbers: number[]; revision?: string}
  | {kind: 'commits'; hashes: string[]}

/**
 * 生成投递消息的「上下文头」（用户消息中位于指令上方的那一段）。
 * - files：每行一个绝对路径（顺序即传入顺序）
 * - lines：`绝对路径[@revision]:行号范围`
 * - commits：`commit：hash1,hash2`（全角冒号，用户明确要求）
 */
export function buildContext(ctx: SendToConversationContext, workspacePath: string): string {
  switch (ctx.kind) {
    case 'files':
      return ctx.paths.map(p => absPath(workspacePath, p)).join('\n')
    case 'lines':
      return `${absPath(workspacePath, ctx.filePath)}${ctx.revision ? `@${ctx.revision}` : ''}:${formatLineRanges(ctx.lineNumbers)}`
    case 'commits':
      return `commit：${ctx.hashes.join(',')}`
  }
}

/** 上下文 + 指令 → 最终 user 消息全文 */
export function composeContent(context: string, instruction: string): string {
  return `${context}\n${instruction}`
}
