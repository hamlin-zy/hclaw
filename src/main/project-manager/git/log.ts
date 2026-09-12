// src/main/project-manager/git/log.ts
import type {GitLogEntry} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'

// 行格式：<hash|parents|author|email|authorDate|date|refs|subject|body
// refs 字段使用 %D，同一字段同时承载 branches（HEAD -> main、origin/main）与 tags（tag: v1.0）
const LOG_FORMAT = '--pretty=format:<%H|%P|%an|%ae|%at|%at|%D|%s|%b'

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
  return raw.split('\n')
    .filter(line => line.startsWith('<'))
    .map(line => {
      const parts = line.slice(1).split('|')
      const [hash, parents, author, email, date, , refs, message, ...bodyParts] = parts
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
        body: bodyParts.join('\n').trim(),
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
