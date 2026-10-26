import {execFile} from 'child_process'
import {simpleGit, type SimpleGit} from 'simple-git'

/**
 * simple-git 默认会把继承环境中的 EDITOR/GIT_ASKPASS/GIT_SSH_* 等视为不安全而直接拒绝。
 * 这里的 env 来自宿主进程自身（不是用户可控的任务参数），入参只有受解析约束的仓库 URL，
 * 因此显式放行这些「仅环境变量」类别，以保留用户的代理、证书、SSH agent 与凭据配置。
 */
const GIT_ENV_UNSAFE_OPTIONS = {
  allowUnsafeEditor: true,
  allowUnsafeAskPass: true,
  allowUnsafeConfigPaths: true,
  allowUnsafeConfigEnvCount: true,
  allowUnsafeDiffExternal: true,
  allowUnsafePager: true,
  allowUnsafeGitProxy: true,
  allowUnsafeTemplateDir: true,
  allowUnsafeSshCommand: true,
} as const

/** 创建统一配置的 git 实例：保留父进程环境，仅禁用交互式凭据提示 */
export function createGit(baseDir?: string): SimpleGit {
  const options = {unsafe: GIT_ENV_UNSAFE_OPTIONS}
  const git = baseDir ? simpleGit(baseDir, options) : simpleGit(options)
  return git.env({...process.env, GIT_TERMINAL_PROMPT: '0'})
}

/** Git 未安装时的统一提示（多行，UI 以 pre-line 展示） */
export const GIT_NOT_INSTALLED_MESSAGE =
  '未检测到 Git，无法完成仓库操作。\n请先安装 Git 并确保它已加入系统 PATH，然后重启 HClaw 再试。\n下载地址：https://git-scm.com/downloads'

/** Git 预检超时（进程被杀）时的提示 */
export const GIT_TIMEOUT_MESSAGE =
  'Git 响应超时，无法完成仓库操作。\n请稍后重试；若持续失败，请检查 Git 安装是否正常。'

/** Git 存在但无法执行 git --version 时的提示 */
export const GIT_UNAVAILABLE_MESSAGE =
  'Git 不可用（无法执行 git --version）。\n请检查 Git 安装与系统 PATH 配置后重试。'

/** 预检失败原因：未安装 / 超时 / 其他执行错误 */
export type GitUnavailableReason = 'not-found' | 'timeout' | 'error'

export interface GitAvailability {
  available: boolean
  version?: string
  reason?: GitUnavailableReason
}

/** 按预检失败原因选择面向用户的提示 */
export function gitUnavailableMessage(reason?: GitUnavailableReason): string {
  if (reason === 'timeout') return GIT_TIMEOUT_MESSAGE
  if (reason === 'error') return GIT_UNAVAILABLE_MESSAGE
  return GIT_NOT_INSTALLED_MESSAGE
}

const NOT_INSTALLED_RE =
  /spawn git ENOENT|command not found|not recognized as an internal or external command|不是内部或外部命令/i
const AUTH_RE =
  /could not read Username|Authentication failed|terminal prompts disabled|Permission denied \(publickey\)|Invalid username or password/i
const REPO_NOT_FOUND_RE = /Repository not found|repository .* not found|does not appear to be a git repository/i
const SSL_RE = /SSL certificate problem|certificate verify failed/i
const NETWORK_RE =
  /Could not resolve host|Failed to connect|Connection timed out|Network is unreachable/i
/** Git 输出中的 HTTP 状态码（认证/权限/不存在/代理认证） */
const HTTP_STATUS_RE = /The requested URL returned error: (401|403|404|407)/i

const PROGRESS_LINE_RE = /^(Cloning into|正克隆到|正在克隆|克隆到)/
const STACK_LINE_RE = /^\s+at\s/
const PREFERRED_DETAIL_RE = /^(fatal|error|remote):/i
const DETAIL_PREFIX_RE = /^(remote: |fatal: |error: |Error: )/

/**
 * 结果行清洗：去空行与本地化进度行、跳过堆栈行，
 * 优先取首条 fatal/error/remote 行，否则退回首个可用行；
 * 去掉常见前缀后按码点截断 200 字符。
 */
function extractDetail(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .filter(line => !STACK_LINE_RE.test(line))
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .filter(line => !PROGRESS_LINE_RE.test(line))

  const line = lines.find(candidate => PREFERRED_DETAIL_RE.test(candidate)) ?? lines[0]
  if (line === undefined) return '未知错误'

  const stripped = line.replace(DETAIL_PREFIX_RE, '').trim()
  if (!stripped) return '未知错误'

  const chars = Array.from(stripped)
  return chars.length > 200 ? `${chars.slice(0, 200).join('')}…` : stripped
}

/** 把 Git 原始错误转为面向用户的分类提示；保证不暴露堆栈与克隆进度行 */
export function formatGitError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)

  if (NOT_INSTALLED_RE.test(raw)) {
    return GIT_NOT_INSTALLED_MESSAGE
  }

  const detail = extractDetail(raw)
  const httpStatus = HTTP_STATUS_RE.exec(raw)?.[1]
  const hasAuthSignal = AUTH_RE.test(raw)
  const hasNotFoundSignal = REPO_NOT_FOUND_RE.test(raw) || httpStatus === '404'

  // 仓库不存在（HTTP 404 同属此类）；同时命中认证关键词时给出双信号文案
  if (hasNotFoundSignal) {
    if (hasAuthSignal) {
      return `仓库不存在，或当前凭据无权访问。\n请检查地址是否正确，并确认当前账号有访问权限后重试。\n详情：${detail}`
    }
    return `仓库不存在或无权访问。\n请检查地址是否正确；私有仓库需要在本机配置 Git 凭据。\n详情：${detail}`
  }

  if (httpStatus === '401' || httpStatus === '403') {
    return `访问被拒绝（HTTP ${httpStatus}）。\n请检查该仓库的访问权限，或配置可用的访问令牌后重试。\n详情：${detail}`
  }

  if (hasAuthSignal) {
    return `仓库需要认证，但当前 Git 凭据不可用。\n请在本机完成 Git 登录或配置访问令牌后重试。\n详情：${detail}`
  }

  if (httpStatus === '407') {
    return `代理需要认证（HTTP 407）。\n请检查系统代理设置后重试。\n详情：${detail}`
  }

  if (SSL_RE.test(raw)) {
    return `HTTPS 证书校验失败。\n请检查代理或系统证书配置。\n详情：${detail}`
  }

  if (NETWORK_RE.test(raw)) {
    return `无法连接仓库服务器。\n请检查网络或代理设置后重试。\n详情：${detail}`
  }

  return `仓库操作失败：${detail}`
}

/** 判定预检失败原因：ENOENT → 未安装；被杀/超时 → timeout；其余 → error */
function classifyGitFailure(error: {message?: string; code?: string | number | null; killed?: boolean}): GitUnavailableReason {
  if (error.code === 'ENOENT' || /spawn git ENOENT/.test(error.message ?? '')) {
    return 'not-found'
  }
  if (error.killed === true || error.code === 'ETIMEDOUT') {
    return 'timeout'
  }
  return 'error'
}

/** 检测本机 Git 是否可用；任何失败（含 ENOENT / 超时）都返回 available:false，绝不 reject */
export function checkGitAvailable(timeoutMs = 2000): Promise<GitAvailability> {
  return new Promise(resolve => {
    try {
      execFile('git', ['--version'], {timeout: timeoutMs, windowsHide: true}, (error, stdout) => {
        if (error) {
          resolve({available: false, reason: classifyGitFailure(error)})
          return
        }
        resolve({available: true, version: String(stdout ?? '').trim()})
      })
    } catch {
      resolve({available: false, reason: 'error'})
    }
  })
}
