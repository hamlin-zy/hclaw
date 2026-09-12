import {gitExec, gitExecResult} from './gitExec'
import {invalidateStatusCache} from './status'
import {assertValidRef} from './validation'

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
