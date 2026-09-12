// src/main/project-manager/git/showCommit.ts
import type {GitCommitFiles, GitCommitFile} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'

export function parseShowCommit(raw: string, hash: string, message: string): GitCommitFiles {
  const files: GitCommitFile[] = []
  let inFiles = false
  for (const line of raw.split('\n')) {
    if (!inFiles) {
      // 元信息段直到第一个空行结束
      if (line === '') inFiles = true
      continue
    }
    if (!line.trim()) continue
    const m = line.match(/^R\d+\t(.*)\t(.*)$/)
    if (m) {
      files.push({path: m[2]!, status: 'R', oldPath: m[1]!, additions: 0, deletions: 0})
      continue
    }
    const [status, ...rest] = line.split('\t')
    if (rest.length && ['M', 'A', 'D'].includes(status!)) {
      files.push({path: rest.join('\t'), status: status as GitCommitFile['status'], additions: 0, deletions: 0})
    }
  }
  return {hash, message, files}
}

export async function getShowCommit(workspace: string, hash: string): Promise<GitCommitFiles> {
  const raw = await gitExec(workspace, ['show', '--name-status', '--format=%H%n%s', hash])
  const [hashLine, subject] = raw.split('\n')
  return parseShowCommit(raw, hashLine?.trim() || hash, subject ?? '')
}
