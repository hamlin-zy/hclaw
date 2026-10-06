// src/main/repo/uninstaller.ts
import * as fs from 'fs'
import * as path from 'path'
import type {GitRepo} from './type'

export interface UninstallResult {
  success: boolean
  removed?: {skills: number; agents: number}
  warnings?: string[]
  error?: string
}

/**
 * 卸载依赖（均由调用方注入实现，本模块不 import 任何实现模块）：
 * - getRepo / roots：仓库注册表与两个可卸载根目录
 * - rm：删除目录（失败按 retryDelaysMs 重试）
 * - deleteSkillOverrides / deleteAgentOverrides：Task 5 的 override 清理（唯一删除路径）
 * - dropVersionCache：Task 2 的 RepoVersionManager.drop
 * - reloadCapabilities / discoverRepos / broadcastMeta：Task 3/4 的能力重载与广播
 */
export interface UninstallDeps {
  getRepo(id: string): GitRepo | undefined
  roots: {skillsPublic: string; agents: string}
  rm(dir: string): Promise<void>
  deleteSkillOverrides(ids: string[]): void
  deleteAgentOverrides(ids: string[]): Promise<void>
  dropVersionCache(id: string): void
  reloadCapabilities(): Promise<void>
  discoverRepos(): Promise<GitRepo[]>
  broadcastMeta(): void
  retryDelaysMs?: number[]
}

/** 目录删除失败的重试间隔：默认 9 次 × 500ms（Windows 上文件句柄释放有延迟） */
export const DEFAULT_RETRY_DELAYS_MS: number[] = Array.from({length: 9}, () => 500)

/**
 * dir 是否**严格位于** root 之下（不含 root 本身）。
 * 用 path.relative 判路径段，不做字符串前缀比较 —— 否则 `skills/publicX/repo`
 * 会被误判为位于 `skills/public` 之下；而 `skills/public/..foo`（真实的合法子目录，
 * rel 为 `..foo`）又会被字符串前缀判断误判为在根之外。
 * 只有相对路径中真的含有 `..` 路径段（目标在根之外）才拒绝。
 * 跨盘符时 path.relative 返回绝对路径（isAbsolute），一并拒绝。
 */
export function isStrictlyUnderRoot(dir: string, root: string): boolean {
  const rel = path.relative(root, dir)
  return rel !== '' && !rel.split(path.sep).includes('..') && !path.isAbsolute(rel)
}

/**
 * 读取 `<dir>/.git/config` 中 `[remote "origin"]` 段的 `url` 值。
 * 文件不存在 / 无该段 / 无 url / url 为空 → undefined（调用方按「解析不出」处理）。
 * 直接读文件而非走 git 命令：本模块已直接用 fs，且此处只需一次的轻量读取。
 */
export function readOriginUrl(dir: string): string | undefined {
  const configPath = path.join(dir, '.git', 'config')
  if (!fs.existsSync(configPath)) return undefined
  let content: string
  try {
    content = fs.readFileSync(configPath, 'utf8')
  } catch {
    return undefined
  }
  let inOrigin = false
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line)
      continue
    }
    if (!inOrigin) continue
    const matched = line.match(/^url\s*=\s*(.*)$/i)
    if (matched) return matched[1].trim() || undefined
  }
  return undefined
}

/** origin 规范化（仅用于比较是否同源）：去首尾空白 + 去尾部 .git + 统一小写 */
function normalizeOrigin(url: string): string {
  return url.trim().replace(/\.git$/i, '').toLowerCase()
}

/**
 * 两份克隆是否同源（用于判断另一根下的同名目录是真副本，还是碰巧撞名的另一仓库）。
 * - 都能解析出 origin → 必须规范化后相等；
 * - 都解析不出（无 origin 的 local 退化仓库）→ 视为同源（仍删，保住「两份都要清除」）；
 * - 只有一方解析得出 → 无法确认，保守判为不同源（不删）。
 */
function isSameOrigin(mainOrigin: string | undefined, mirrorOrigin: string | undefined): boolean {
  if (mainOrigin === undefined && mirrorOrigin === undefined) return true
  if (mainOrigin === undefined || mirrorOrigin === undefined) return false
  return normalizeOrigin(mainOrigin) === normalizeOrigin(mirrorOrigin)
}

export function asError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 单步 try/catch：失败只 push warning 并继续，不外抛。
 * `fn` 既可以是同步函数也可以是 async 函数 —— `await` 对同步返回值会做 Promise.resolve 包裹，
 * 同步抛错同样被本条 catch 兜住（与原 inline `try { await deps.xxx() } catch` 行为一致）。
 * 文案格式：`${label}: ${asError(err)}`（label 已含「...失败」前缀）。
 */
async function tryStep(fn: () => unknown, label: string, warnings: string[]): Promise<void> {
  try {
    await fn()
  } catch (err) {
    warnings.push(`${label}: ${asError(err)}`)
  }
}

/** 按 delays 逐次重试：尝试次数 = delays.length + 1，最后一次仍失败则抛出。 */
async function removeWithRetry(rm: (dir: string) => Promise<void>, dir: string, delays: number[]): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(dir)
      return
    } catch (err) {
      if (attempt >= delays.length) throw err
      await sleep(delays[attempt])
    }
  }
}

/**
 * 卸载一个仓库：删本地克隆目录 + 清理该仓库能力的 override 残留 + 刷新缓存与红点。
 *
 * 失败语义：
 * - 目录删除是唯一的原子边界。主目录删除失败（重试耗尽）→ 立即返回错误，后续步骤一律不执行
 *   （注册表与红点不变、可重试）。注意 `fs.rm(recursive)` 是**部分删除**语义：遍历到被占用的
 *   子项才抛错，此前已删的子项不回滚 —— 磁盘可能残留部分文件（极端情况下 `.git` 已被删掉，
 *   重试会被「目录缺少 .git」守卫拒绝），故错误文案必须提示用户手动清理后重试，而不是
 *   宣称「磁盘零改动」；副本删除失败 → 记 warnings 继续。
 * - 步骤 3-7（override / 缓存 / 重载 / 重新发现 / 广播）各自 try/catch，失败记 warnings
 *   并继续，不回滚（目录已删，仓库事实上已移除）。
 */
export async function uninstallRepo(repoId: string, deps: UninstallDeps): Promise<UninstallResult> {
  // 守卫（全部在任何副作用之前）
  const repo = deps.getRepo(repoId)
  if (!repo) return {success: false, error: `仓库不存在: ${repoId}`}
  if (repo.rootType === 'plugin') {
    return {success: false, error: `该仓库是插件，请在插件页签中卸载: ${repoId}`}
  }
  const mainDir = repo.path
  const underSkills = isStrictlyUnderRoot(mainDir, deps.roots.skillsPublic)
  const underAgents = isStrictlyUnderRoot(mainDir, deps.roots.agents)
  if (!underSkills && !underAgents) {
    return {success: false, error: `仓库路径不在可卸载的根目录下: ${mainDir}`}
  }
  if (!fs.existsSync(path.join(mainDir, '.git'))) {
    return {success: false, error: `仓库目录缺少 .git: ${mainDir}`}
  }

  const warnings: string[] = []
  const delays = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS

  // 副本：另一根下同名且含 .git 的目录（同一仓库在两类根下的两份克隆）。
  // 目录名来自 repoDirName()，形如 `${repoName}@source` —— 不含 owner，无法区分
  // alice/tool 与 bob/tool（都叫 tool@source）。仅凭目录名判定会不可逆地误删别人的克隆，
  // 且列表与确认弹窗都不会告知用户，故必须再比对 .git/config 的 origin（见 isSameOrigin）。
  const mirrorRoot = underSkills ? deps.roots.agents : deps.roots.skillsPublic
  const mirrorDir = path.join(mirrorRoot, path.basename(mainDir))
  const mirrorDirs: string[] = []
  if (fs.existsSync(path.join(mirrorDir, '.git'))) {
    if (isSameOrigin(readOriginUrl(mainDir), readOriginUrl(mirrorDir))) {
      mirrorDirs.push(mirrorDir)
    } else {
      warnings.push(`跳过疑似不同源的目录（origin 不匹配）: ${mirrorDir}`)
    }
  }

  // 步骤 2：删除目录（主目录失败即整体失败；副本失败只记 warnings）
  try {
    await removeWithRetry(deps.rm, mainDir, delays)
  } catch (err) {
    return {
      success: false,
      error: `删除仓库目录失败: ${mainDir}（${asError(err)}）；目录可能已被部分删除，可手动清理该目录后重试`,
    }
  }
  for (const dir of mirrorDirs) {
    try {
      await removeWithRetry(deps.rm, dir, delays)
    } catch (err) {
      warnings.push(`删除副本目录失败: ${dir}（${asError(err)}）`)
    }
  }

  // 步骤 3-7：失败只记 warnings 并继续，不回滚（目录已删，仓库事实上已移除）
  const skills = repo.capabilities.skills
  const agents = repo.capabilities.agents
  // 用注入的删除函数清理 override（空数组由 Task 5 的实现自行 no-op）
  await tryStep(() => deps.deleteSkillOverrides(skills), '清理技能残留失败', warnings)
  await tryStep(() => deps.deleteAgentOverrides(agents), '清理代理残留失败', warnings)
  await tryStep(() => deps.dropVersionCache(repoId), '清理版本缓存失败', warnings)
  await tryStep(() => deps.reloadCapabilities(), '重载能力失败', warnings)
  // 目录已变化，必须重新发现仓库边界（装配方注入的 discoverRepos 自带就绪守卫）
  await tryStep(() => deps.discoverRepos(), '重新发现仓库失败', warnings)
  // 同步广播：契约返回 void，故不 await（同步抛错同样被本条 catch 兜住）
  await tryStep(() => deps.broadcastMeta(), '广播仓库元数据失败', warnings)

  // removed 计数为仓库聚合的能力数（目录删除即能力已移除）；override 残留清理失败只记 warnings
  const result: UninstallResult = {success: true, removed: {skills: skills.length, agents: agents.length}}
  if (warnings.length > 0) result.warnings = warnings
  return result
}
