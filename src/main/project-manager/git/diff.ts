// src/main/project-manager/git/diff.ts
import type {DiffResult} from '../../../shared/types/project-manager'
import {readFileText} from '../fileSystem'
import {gitExec} from './gitExec'
import {parseNumstat} from './numstat'

export type DiffMode = {ref?: string, from?: string, to?: string}

// 导出仅供测试（锁定三模式 refs 映射），不进 IPC 契约，行为与改造前逐条等价。
export function resolveRefs(mode: DiffMode): {baseRef: string, targetRef: string, diffType: DiffResult['diffType']} {
  if (mode.from && mode.to) return {baseRef: mode.from, targetRef: mode.to, diffType: 'commit'}
  if (mode.ref) return {baseRef: `${mode.ref}^`, targetRef: mode.ref, diffType: 'commit'}
  return {baseRef: 'HEAD', targetRef: '', diffType: 'working-tree'}
}

// argv 由 resolveRefs 派生，保证与 refs/diffType 映射单一来源。
// working-tree 模式 targetRef 为空串 → 直接省略该位置参数（`git diff HEAD -- file`）。
// 注意只剔除空 ref，不用 filter(Boolean)：后者会连空 filePath 一起吞掉，改变 argv 语义。
export function buildDiffArgs(mode: DiffMode, filePath: string): string[] {
  const {baseRef, targetRef} = resolveRefs(mode)
  return targetRef
    ? ['diff', '--no-color', baseRef, targetRef, '--', filePath]
    : ['diff', '--no-color', baseRef, '--', filePath]
}

async function showBlob(workspace: string, ref: string, filePath: string): Promise<string> {
  try {
    return await gitExec(workspace, ['show', `${ref}:${filePath}`])
  } catch {
    return ''   // 文件在该 ref 不存在（新增文件）
  }
}

export async function getDiff(workspace: string, filePath: string, mode: DiffMode): Promise<DiffResult> {
  const {baseRef, targetRef, diffType} = resolveRefs(mode)
  const oldContent = await showBlob(workspace, baseRef, filePath)
  // brief Interfaces 语义：working-tree 模式 newContent 直接读磁盘（与 numstat 的工作区改动一致）
  // 已删除文件读盘 ENOENT → 回退 ''（对齐 showBlob 吞错语义）
  const newContent = diffType === 'working-tree'
    ? await readFileText(workspace, filePath).catch(() => '')
    : await showBlob(workspace, targetRef, filePath)
  const numstat = await gitExec(workspace, ['diff', '--no-color', '--numstat', baseRef, targetRef, '--', filePath].filter(Boolean))
  const {additions, deletions} = parseNumstat(numstat)
  return {
    filePath,
    oldContent,
    newContent,
    diffType,
    oldRef: baseRef,
    newRef: targetRef || 'worktree',
    additions,
    deletions,
  }
}
