// src/main/project-manager/git/authors.ts
import type {GitAuthor} from '../../../shared/types/project-manager'
import {gitExec} from './gitExec'
import {assertValidRef} from './validation'

/**
 * 作者列表上限。`shortlog -s` 的输出行数 = 不同 author 身份数，本身不大；
 * 但超大仓库（数万作者）仍可能把 IPC payload 与渲染层撑爆，故硬性截断。
 */
export const MAX_AUTHOR_COUNT = 200

/**
 * `git shortlog -sne <ref>` 的一行：`<右对齐计数>\t<Name> <email>`。
 * 计数可含前导空格（git 用 `%6d`），身份分隔符为 **tab**（不是空格）。
 */
const LINE_RE = /^\s*(\d+)\t(.*)$/

/**
 * 解析 shortlog 汇总输出。语义契约：
 * - **分组键 = `name + email`**（git shortlog 的实际行为）：同名不同 email 是两条记录；
 *   同 email 不同名（作者改过 user.name）同样是两条记录 —— 不做 mailmap 归一。
 * - 排序：提交数降序 → 作者名升序 → email 升序（第三键仅为消除同名同数的歧义，保证确定性）。
 * - 截断：排序后保留前 {@link MAX_AUTHOR_COUNT} 条。
 * - 畸形行（无 tab 计数）直接丢弃，不抛异常。
 */
export function parseShortlog(raw: string): GitAuthor[] {
  const authors: GitAuthor[] = []
  for (const line of raw.split('\n')) {
    const m = LINE_RE.exec(line.replace(/\r$/, ''))
    if (!m) continue
    const commits = parseInt(m[1]!, 10)
    if (!Number.isFinite(commits)) continue
    const identity = m[2]!
    const lt = identity.lastIndexOf('<')
    if (lt < 0 || !identity.endsWith('>')) {
      // 身份里没有 email（git 无法解析出 ident 时的兜底形态）
      authors.push({name: identity.trim(), email: '', commits})
      continue
    }
    authors.push({
      name: identity.slice(0, lt).trim(),
      email: identity.slice(lt + 1, -1).trim(),
      commits,
    })
  }
  authors.sort((a, b) =>
    b.commits - a.commits || a.name.localeCompare(b.name) || a.email.localeCompare(b.email))
  return authors.slice(0, MAX_AUTHOR_COUNT)
}

/**
 * 校验作者查询用的 ref：在共享 {@link assertValidRef} 之上再拒绝 revision range（`a..b` / `..`）。
 * 本 API 的 branch 语义是「单个 ref」；合法 git 分支名本身禁止 `..`，收紧不会误伤真实分支，
 * 只是把「语法合法但必然报错的 range」提前变成清晰错误。
 * 主进程 IPC 边界与 {@link getGitAuthors} 共用此校验，避免两处规则漂移。
 */
export function assertValidAuthorRef(ref: string): void {
  assertValidRef(ref)
  if (ref.includes('..')) throw new Error(`无效的 git ref: ${ref}`)
}

/**
 * 统计某 ref（默认 `HEAD`）可达提交的作者列表。
 *
 * 命令选择：`git shortlog -sne <ref>`
 * - `-s` 只输出每个身份的提交数（聚合在 git 侧完成，结果集 = 作者数，天然小）；
 *   `git log --format=%an%x00%ae` 会把**全部提交历史**拉到 Node 侧再 JS 去重，
 *   超大仓库下 stdout 体积与解析耗时与提交数同阶，明显劣于 shortlog。
 * - `-n` 按提交数降序（我们仍在 JS 侧重排，保证并列时的确定性次序）。
 * - `-e` 输出 email，使分组键可表达为 name+email。
 * - **不传 `--max-count`**：那会改变计数语义（变成「最近 N 条提交内的作者统计」）。
 *
 * 边界：
 * - 非 git 仓库 / 空仓库（unborn HEAD）/ ref 不存在 → git 非零退出 → 返回 `[]`（与
 *   `getGitLog` / `getBranches` 的既有失败语义一致：不抛未捕获异常）。
 * - worktree / submodule：只需 workspace 是工作树内任意目录，`git shortlog` 自行解析
 *   gitdir，无需特殊处理。
 * - 失败原因（如 git 未安装）同样收敛为 `[]`，不向 IPC 抛错。
 *
 * @throws 当 `opts.branch` 未通过 ref 校验（含前导 `-`、空白、`;`、`..` 等注入 / 范围语法）时抛出
 */
export async function getGitAuthors(
  workspace: string,
  opts?: {branch?: string},
): Promise<GitAuthor[]> {
  let ref = 'HEAD'
  if (opts?.branch) {
    // 共享 ref 校验（防前导 `-` 触发 git 选项注入 + 拒绝 revision range）
    assertValidAuthorRef(opts.branch)
    ref = opts.branch
  }
  let raw = ''
  try {
    raw = await gitExec(workspace, ['shortlog', '-sne', ref])
  } catch {
    return []   // 非 git 仓库 / 空仓库 / ref 不存在
  }
  return parseShortlog(raw)
}
