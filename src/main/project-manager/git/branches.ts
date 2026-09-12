// src/main/project-manager/git/branches.ts
import type {BranchTreeNode} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'

export async function getBranches(workspace: string): Promise<BranchTreeNode[]> {
  const nodes: BranchTreeNode[] = []
  let current = ''
  try {
    current = (await gitExec(workspace, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // 用完整 refname 判定命名空间：`refname:short` 不足以区分（`feat/foo` 是本地分支，
    // `origin/main` 是远端分支，`origin` 是 refs/remotes/origin/HEAD 的塌缩短名）。
    const localRaw = await gitExec(workspace, ['branch', '-a', '--format=%(refname) %(refname:short) %(objectname)'])
    for (const line of localRaw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      // 先剥离可能的 `* ` 前缀（`git branch --format` 实际不输出，但保留容错），
      // 再按空白分离 full refname / short refname / objectname。
      const isMarkedCurrent = trimmed.startsWith('* ')
      const lineNoStar = trimmed.replace(/^\*\s*/, '')
      const [fullRef, shortRef, hash] = lineNoStar.split(/\s+/)
      if (!fullRef || !shortRef) continue
      if (fullRef.startsWith('refs/heads/')) {
        // 本地分支：name = short refname（含 `/` 的 `feat/foo` 也归此分支）
        nodes.push({
          name: shortRef,
          hash: hash ?? '',
          type: 'local',
          isCurrent: shortRef === current || isMarkedCurrent,
          isRemote: false,
          remoteName: undefined,
        })
      } else if (fullRef.startsWith('refs/remotes/')) {
        // 远端分支：refs/remotes/<remote>/<branch...>（`refs/remotes/origin` 是 HEAD 的塌缩写，只剩一段）
        const [remoteName = '', ...branchParts] = fullRef.slice('refs/remotes/'.length).split('/')
        const branchPart = branchParts.join('/')
        // 跳过 refs/remotes/*/HEAD（符号引用，不是真实分支），否则会出现幽灵项
        if (!remoteName || !branchPart || branchPart === 'HEAD') continue
        nodes.push({
          name: shortRef,
          hash: hash ?? '',
          type: 'remote',
          isCurrent: shortRef === current || isMarkedCurrent,
          isRemote: true,
          remoteName,
        })
      } else {
        // 其他命名空间（如 refs/stash）不渲染
        continue
      }
    }
    const tagRaw = await gitExec(workspace, ['tag', '--format=%(refname:short) %(objectname)'])
    for (const line of tagRaw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const [name, hash] = trimmed.split(/\s+/)
      if (!name) continue
      nodes.push({name, hash: hash ?? '', type: 'tag', isCurrent: false, isRemote: false})
    }
  } catch {
    return []   // 非 git 仓库
  }
  return nodes
}
