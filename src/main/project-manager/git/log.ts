// src/main/project-manager/git/log.ts
import type {GitLogEntry} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'

// 记录格式（RS 记录分隔）：<RS>hash|parents|author|email|authorDate|date|refs|subject|body…
// refs 字段使用 %D，同一字段同时承载 branches（HEAD -> main、origin/main）与 tags（tag: v1.0）
//
// 必须用 ASCII RS(\x1e) 而不是换行来分隔记录：%b 是含换行的多行正文，按 '\n' 切分后
// 只能靠行首特征辨认记录起点，正文续行会被整行丢弃（详情面板的提交信息于是永远只剩
// 标题与正文第一行）。RS 不会出现在正文里，切分与正文内容无关。
const RECORD_SEP = '\x1e'
const LOG_FORMAT = `--pretty=format:${RECORD_SEP}%H|%P|%an|%ae|%at|%at|%D|%s|%b`
// 固定字段数（hash/parents/author/email/authorDate/date/refs/subject），其后全部属于正文
const FIXED_FIELD_COUNT = 8

export interface LogOptions {
  limit: number
  skip?: number
  filterText?: string
  filterBranch?: string[]
  filterUser?: string[]
  filterDateRange?: [number, number]
  filterPaths?: string[]
  filterFlags?: {caseSensitive?: boolean, regex?: boolean, wholeWord?: boolean}
}

export function parseLog(raw: string): GitLogEntry[] {
  return raw.split(RECORD_SEP)
    .filter(record => record.trim().length > 0)
    .map(record => {
      const parts = record.split('|')
      const [hash, parents, author, email, date, , refs, message] = parts
      const commitHash = hash ?? ''
      const dateMs = parseInt(date ?? '0', 10) * 1000
      const refList = (refs ?? '').split(', ')
        .map(r => r.startsWith('HEAD -> ') ? r.slice('HEAD -> '.length) : r)
        .filter(r => r && !r.startsWith('HEAD'))
      const tags = refList.filter(r => r.startsWith('tag:')).map(t => t.slice('tag: '.length))
      const branches = refList.filter(r => !r.startsWith('tag:'))
      return {
        hash: commitHash,
        abbreviatedHash: commitHash.slice(0, 9),
        parents: (parents ?? '').split(' ').filter(Boolean),
        message: message ?? '',
        // 正文自身可能含 '|'，按段 join 回来，避免竖线被解析成换行
        body: parts.slice(FIXED_FIELD_COUNT).join('|').trim(),
        author: author ?? '',
        authorEmail: email ?? '',
        authorDate: dateMs,
        date: dateMs,
        branches,
        tags,
        isHead: (refs ?? '').includes('HEAD'),
      }
    })
}

export async function getGitLog(workspace: string, opts: LogOptions): Promise<GitLogEntry[]> {
  const args = ['log', LOG_FORMAT, `--max-count=${opts.limit}`]
  if (opts.skip) args.push(`--skip=${opts.skip}`)
  if (opts.filterText) {
    if (opts.filterFlags?.regex) args.push(`--grep=${opts.filterText}`)
    else args.push(`--grep=${opts.filterText}`, '--fixed-strings')
    if (!opts.filterFlags?.caseSensitive) args.push('--regexp-ignore-case')
  }
  for (const b of opts.filterBranch ?? []) args.push(b)
  for (const u of opts.filterUser ?? []) args.push(`--author=${u}`)
  if (opts.filterDateRange) {
    args.push(`--since=${new Date(opts.filterDateRange[0]).toISOString()}`)
    args.push(`--until=${new Date(opts.filterDateRange[1]).toISOString()}`)
  }
  if (opts.filterPaths?.length) args.push('--', ...opts.filterPaths)
  let raw = ''
  try {
    raw = await gitExec(workspace, args)
  } catch {
    return []   // 非 git 仓库 / 无 commit
  }
  return parseLog(raw)
}
