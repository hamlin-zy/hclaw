/**
 * Capability catalog 注入器（纯函数核心）
 *
 * 能力目录（技能 + 代理 + 命令）已迁出 System Prompt，改为在 agent 循环
 * 每轮 pre-step 以 user 角色消息注入消息流尾部，仅在 digest 变化时替换。
 * 本模块只提供纯函数：收集条目、计算 digest、渲染文案、发布决策。
 */

import {createHash} from 'crypto'
import type {
  CatalogEntry,
  CatalogMetadata,
} from '@shared/types/message'
import {SOURCE_KIND_CATALOG} from '@shared/types/message'
import {skillRegistry} from './registry'
import {createLogger} from '../logger'

const logger = createLogger('catalogInjector')

/** 描述字段最大长度（沿用原 buildCapabilityIndex 的截断规则） */
const MAX_DESC_CHARS = 200

const SOURCE_RANK: Record<string, number> = {user: 100, plugin: 200, builtin: 300}

/** 复审 U4/U5：rank 排序，同名 rank 小者胜，缺失 source 视为 250 */
export function sortEntries(entries: CatalogEntry[]): CatalogEntry[] {
  const rankOf = (e: CatalogEntry): number =>
    e.source && SOURCE_RANK[e.source] !== undefined ? SOURCE_RANK[e.source] : 250
  const deduped = new Map<string, CatalogEntry>()
  for (const e of [...entries].sort((a, b) =>
    rankOf(a) - rankOf(b) || a.name.localeCompare(b.name)
  )) {
    if (!deduped.has(e.name)) deduped.set(e.name, e)
  }
  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** 截断描述到 MAX_DESC_CHARS */
function truncateDesc(desc: string): string {
  if (desc.length <= MAX_DESC_CHARS) return desc
  return desc.slice(0, MAX_DESC_CHARS)
}

export interface CatalogSnapshot {
    entries: CatalogEntry[]
    /** 所有数据源读取成功 */
    complete: boolean
}

/**
 * 收集当前启用的 skills（复审后仅此一源；agents 走 list_agents 工具，
 * commands 移出模型通道）。逐源 try/catch，失败置 complete=false。
 */
export function collectCatalogSnapshot(): CatalogSnapshot {
  const entries: CatalogEntry[] = []
  let complete = true
  try {
    for (const skill of skillRegistry.getEnabled()) {
      // V1 契约：原始可调用名，禁止后缀装饰
      if (!skill.name?.trim()) continue
      // spec §4.2 full 模式逐字保持旧 collectEntries 行为：
      // userDescription 优先于 description；desc+trigger 全空的条目跳过
      // （与旧实现一致，names/full 两种模式均在 snapshot 层排除，索引行为一致）。
      const desc = skill.userDescription || skill.description || ''
      const trigger = skill.whenToUse || undefined
      if (!desc && !trigger) continue
      entries.push({
        name: skill.name,
        type: 'skill',
        description: truncateDesc(desc),
        trigger,
        ...(skill.source ? {source: skill.source} : {}),
      } as CatalogEntry)
    }
  } catch (err) {
    logger.warn('[catalogInjector] skill source failed', {error: String(err)})
    complete = false
  }
  return {entries: sortEntries(entries), complete}
}

/**
 * 对条目列表计算 sha256 digest。
 * ⚠️ 必须覆盖全部语义字段（name/type/description/trigger）：
 * 任何字段遗漏都会导致"目录变了但不替换"的陈旧目录 bug。
 */
export function computeDigest(input: {mode: 'names' | 'full'; entries: CatalogEntry[]}): string {
  const payload = input.entries
    .map(e => JSON.stringify([e.name, e.type, e.description, e.trigger ?? '']))
    .join('\n')
  return createHash('sha256').update(`${input.mode}\n${payload}`).digest('hex')
}

const INDEX_DELEGATION_RULES = `Delegation rules:
- skill: call the \`skill\` tool with the exact skill name before taking task actions. Names are an index only \u2014 call \`describe_skills\` when a name looks relevant but you need to know what it does before invoking it.
- agent: no roster is provided in this session. When delegation might help, call \`list_agents\` first, then delegate via the \`agent\` tool by exact name.`

const FULL_DELEGATION_RULES = `Delegation rules:
- skill: call the \`skill\` tool with the exact skill name before taking task actions. Catalog entries are summaries only; do not infer or follow a skill's instructions until it has been loaded via the tool.
- agent: delegate via the \`agent\` tool, selecting the agent by name. If unsure which agent fits, call \`list_agents\` first.`

/**
 * 渲染目录正文（user 角色，<system-reminder> 包裹）。
 * names 模式仅输出名称索引，full 模式逐字保持旧格式条目行。
 * 注：kind === 'empty' 时忽略 mode（空目录无内容可区分模式），
 * 始终输出 empty 文案。
 */
export function renderCatalogContent(
  entries: CatalogEntry[],
  mode: 'names' | 'full',
  kind: 'first' | 'replacement' | 'empty'
): string {
  const rules = mode === 'names' ? INDEX_DELEGATION_RULES : FULL_DELEGATION_RULES

  if (kind === 'empty') {
    return `<system-reminder>
No skills are currently available. Do not use skill names from earlier catalogs.
</system-reminder>`
  }

  let listing: string
  if (mode === 'names') {
    listing = `\n<available_skills>\n${entries.map(e => e.name).join(', ')}\n</available_skills>\n`
  } else {
    listing = entries.length
      ? `\n<available_skills>\n${entries.map(renderFullEntryLine).join('\n')}\n</available_skills>\n`
      : '\n<available_skills>\n</available_skills>\n'
  }

  if (kind === 'replacement') {
    return `<system-reminder>
The capability catalog changed. This complete catalog replaces every earlier capability list in this session:
${listing}
${rules}

Use only names in this replacement catalog.
</system-reminder>`
  }

  return `<system-reminder>
The following capabilities are available in this session:
${listing}
${rules}
</system-reminder>`
}

/** 旧格式条目行（R2 快照锁定目标，与改造前 renderEntryLine 一致，但不再产生 command 类型） */
function renderFullEntryLine(e: CatalogEntry): string {
  const base = `- [${e.type}] \`${e.name}\`: ${e.description}`
  return e.trigger ? `${base} | ${e.trigger}` : base
}

export interface PublishDecision {
  action: 'none' | 'publish'
  content?: string
  metadata?: CatalogMetadata
}

/**
 * 两段式发布决策（spec §5.2）。
 *
 * 第一段：完整性门控（先于决策表执行）
 * - complete === false && incompleteStreak < 3 → 直接 none（不更新 lastDigest）
 * - complete === false && incompleteStreak ≥ 3 → 残缺数据照常进入决策 + warn
 *
 * 第二段：决策表（追加式，spec §3.1：变化即追加新消息，旧字节不动）
 * | digest vs lastDigest | 已有 catalog 消息 | 动作 |
 * | 相同 | 有 | none |
 * | 相同 | 无 | publish（异常态重发布，first 文案；空目录不发）|
 * | 不同 | 无 | publish（first 文案；空目录不发消息）|
 * | 不同 | 有 | publish（追加新消息；replacement / empty 文案）|
 */
export function decidePublish(
  snapshot: CatalogSnapshot,
  mode: 'names' | 'full',
  lastDigest: string | undefined,
  hasPublished: boolean,
  incompleteStreak: number
): {decision: PublishDecision; nextIncompleteStreak: number} {
  // —— 第一段：完整性门控 ——
  if (!snapshot.complete) {
    if (incompleteStreak < 3) {
      return {decision: {action: 'none'}, nextIncompleteStreak: incompleteStreak + 1}
    }
    logger.warn('[catalogInjector] catalog degraded: publishing incomplete snapshot', {streak: incompleteStreak})
  }
  const nextIncompleteStreak = snapshot.complete ? 0 : incompleteStreak + 1

  // —— 第二段：决策（追加式，spec §3.1：变化即追加新消息，旧字节不动）——
  const entries = snapshot.entries
  const digest = computeDigest({mode, entries})
  if (lastDigest && digest === lastDigest && hasPublished) {
    return {decision: {action: 'none'}, nextIncompleteStreak}
  }
  // digest 相同但流中无已发布记录（异常态）→ 重新发布 first 文案
  if (!hasPublished) {
    if (entries.length === 0) {
      return {decision: {action: 'none'}, nextIncompleteStreak}
    }
    return {
      decision: {
        action: 'publish',
        content: renderCatalogContent(entries, mode, 'first'),
        metadata: makeMetadata(digest),
      },
      nextIncompleteStreak,
    }
  }
  // digest 变化：追加新消息；空目录发 empty 文案提醒模型旧目录已失效
  const kind = entries.length === 0 ? 'empty' : 'replacement'
  return {
    decision: {
      action: 'publish',
      content: renderCatalogContent(entries, mode, kind),
      metadata: makeMetadata(digest),
    },
    nextIncompleteStreak,
  }
}

function makeMetadata(digest: string): CatalogMetadata {
  return {
    sourceKind: SOURCE_KIND_CATALOG,
    catalogEntries: [],
    catalogDigest: digest,
  }
}
