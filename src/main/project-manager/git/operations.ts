import {gitExec, gitExecResult} from './gitExec'
import {invalidateStatusCache} from './status'
import {assertValidRef} from './validation'
import {deletePath} from '../fileSystem'

/** 写操作超时：网络 push 与 pre-commit hook 都可能远超默认 30s（spec §6.3） */
const WRITE_TIMEOUT_MS = 120_000
/** 错误净化后的 stderr 摘要上限（spec §6.3） */
const STDERR_LIMIT = 2000

export async function gitAdd(workspace: string, filePaths: string | string[]): Promise<void> {
  const paths = Array.isArray(filePaths) ? filePaths : [filePaths]
  await gitExec(workspace, ['add', '--', ...paths])
  invalidateStatusCache(workspace)
}

export async function gitRmCached(workspace: string, filePath: string): Promise<void> {
  await gitExec(workspace, ['rm', '--cached', '--', filePath])
  invalidateStatusCache(workspace)
}

/**
 * 当前分支名；不在分支上（detached HEAD）时抛错。
 *
 * 必须用 `symbolic-ref --short HEAD` 的**退出码**判定，不能用 `rev-parse --abbrev-ref HEAD`：
 * 后者在「未出生分支」（刚 git init、尚无 commit）上同样输出 `HEAD`，与 detached 无法区分，
 * 那会拒绝空仓库的首次提交——正是 §2.3 要修好的场景（spec §4.1 [rev3]，已真机实测）。
 */
async function currentBranch(workspace: string, action: string): Promise<string> {
  const head = await gitExecResult(workspace, ['symbolic-ref', '--short', 'HEAD'])
  if (head.code !== 0) throw new Error(`当前处于 detached HEAD，无法${action}`)
  return head.stdout.trim()
}

/** 剥离 gitExec 组合消息里 `git <args>: ` 前缀，只留 stderr 摘要（避免提交消息回显到 UI，spec §4.1/§6.3）。
 *  按**已知命令行**精确匹配，不用 `indexOf(': ')` —— 提交消息自身可能含 ': '（如 'feat: x'），
 *  标点启发式会截错位置、把消息片段漏进错误框。 */
function summarize(err: unknown, commands: string[][]): Error {
  const raw = err instanceof Error ? err.message : String(err)
  let detail = raw
  for (const args of commands) {
    const prefix = `git ${args.join(' ')}: `
    if (raw.startsWith(prefix)) { detail = raw.slice(prefix.length); break }
  }
  return new Error(detail.slice(0, STDERR_LIMIT))
}

export async function gitCommit(workspace: string, message: string): Promise<void> {
  if (!message.trim()) throw new Error('提交消息不能为空')
  await currentBranch(workspace, '提交')
  try {
    // 等号形式：以 `-` 开头的消息不会被 git 当选项解析（execFile 不经 shell，无注入面）
    await gitExec(workspace, ['commit', '-a', `--message=${message}`], WRITE_TIMEOUT_MS)
  } catch (err) {
    throw summarize(err, [['commit', '-a', `--message=${message}`]])
  }
  invalidateStatusCache(workspace)
}

/**
 * 丢弃工作区改动，按 git status 的两字符码分流（spec 删除类能力）。
 *
 * - `??` 未跟踪：git 无法「还原」一个从未入库的文件，用户语义是「删掉它」，
 *   故走系统回收站（deletePath），而不是 checkout。
 * - `D` 已删除：工作区文件已没了，需从 HEAD 检出恢复 —— 只写 `checkout --` 会因
 *   索引里有删除记录且工作区无文件而失败，必须显式指定 `HEAD`。
 * - 其余（M/A/R）及未知状态：`git checkout --` 从索引还原工作区改动。
 *   未知状态**不 throw**：UI 不应对某个新状态码直接死路，退化为最通用的还原语义。
 */
export async function gitDiscardChanges(workspace: string, filePath: string, status: string): Promise<void> {
  if (status === '??') {
    await deletePath(workspace, filePath)
  } else if (status === 'D') {
    await gitExec(workspace, ['checkout', 'HEAD', '--', filePath])
  } else {
    await gitExec(workspace, ['checkout', '--', filePath])
  }
  invalidateStatusCache(workspace)
}

/**
 * 删除本地或远程分支（spec 删除类能力）。
 *
 * - 本地：不带 force 用 `-d`（git 会拒绝删未合并分支），带 force 用 `-D` 强删。
 *   不带 force 且 `-d` 失败时，用 locale 无关的 `merge-base --is-ancestor` 复核是否真的未合并
 *   （详见下方内联注释），并把「未合并」标记写进错误消息供渲染层触发强制删除二次确认。
 * - 远程：走 `push <remote> --delete <branch>`。上游 BranchTreeNode 的远程分支名
 *   形如 `origin/main`，需先剥掉 `<remoteName>/` 前缀，否则会请求删除 `origin/origin/main`。
 *   缺 remoteName 时无法确定目标远端，抛中文错误。
 * - 入口对 name / remoteName 做 ref 校验（`isValidRef` 已拒绝前导 `-`），与 gitPush 同口径，
 *   防止以 `-` 开头的名字被 git 当选项解析（防御纵深，即使数组传参不经过 shell）。
 * - 全部数组传参（execFile 不经 shell），分支名中的特殊字符无注入面。
 */
export async function gitDeleteBranch(
  workspace: string,
  opts: {name: string; isRemote: boolean; remoteName?: string; force?: boolean},
): Promise<void> {
  const {name, isRemote, remoteName, force} = opts
  assertValidRef(name)
  if (isRemote) {
    if (!remoteName) throw new Error('缺少远程仓库名，无法删除远程分支')
    assertValidRef(remoteName)
    const prefix = `${remoteName}/`
    const branch = name.startsWith(prefix) ? name.slice(prefix.length) : name
    await gitExec(workspace, ['push', remoteName, '--delete', branch], WRITE_TIMEOUT_MS)
  } else if (force) {
    await gitExec(workspace, ['branch', '-D', name])
  } else {
    try {
      await gitExec(workspace, ['branch', '-d', name])
    } catch (err) {
      // git 的「未合并」拒绝文案会被本地化（中文 locale 下 stderr 不含 "not fully merged"），
      // 且跨 IPC 传递的 Error 会丢失自定义属性，无法靠结构化字段区分。故用 locale 无关的
      // `merge-base --is-ancestor <name> HEAD` 复核：exit 0 = name 是 HEAD 祖先（已合并），
      // 非 0 = 未合并。该命令在分支不存在等异常下同样返回非 0，因此只在 `-d` 已失败时复核，
      // 避免把「分支不存在」等误判成未合并。
      const probe = await gitExecResult(workspace, ['merge-base', '--is-ancestor', name, 'HEAD'])
      if (probe.code === 0) throw err
      // 取舍：probe.code === -1 表示 git 不可用（无法复核）。此时保守按「未合并」处理，
      // 宁可多弹一次强制删除确认，也不让用户失去强制删除入口。
      throw new Error('分支未合并，需强制删除')
    }
  }
  invalidateStatusCache(workspace)
}

export async function gitPush(workspace: string): Promise<void> {
  // 顺序不可交换：detached 必须**先于** @{u} 探测失败（spec §4.1 [rev3]）
  const branch = await currentBranch(workspace, '推送')
  assertValidRef(branch)
  const probe = await gitExecResult(workspace, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  if (probe.code === -1) throw new Error('git 不可用')
  try {
    if (probe.code === 0) {
      await gitExec(workspace, ['push'], WRITE_TIMEOUT_MS)
    } else {
      // 只在 upstream 缺失时补 -u，不覆盖用户自定的跟踪关系
      const remotes = await gitExec(workspace, ['remote'])
      if (!remotes.split('\n').map(r => r.trim()).includes('origin')) {
        throw new Error('当前分支无 upstream，且未配置 origin 远端，请手动推送')
      }
      await gitExec(workspace, ['push', '-u', 'origin', branch], WRITE_TIMEOUT_MS)
    }
  } catch (err) {
    throw summarize(err, [['push'], ['push', '-u', 'origin', branch], ['remote']])
  }
  invalidateStatusCache(workspace)
}
