// src/main/project-manager/git/gitExec.ts
import {execFile, spawn} from 'child_process'

export function gitExec(workspace: string, args: string[], timeoutMs = 30 * 1000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: workspace,
      maxBuffer: 20 * 1024 * 1024,
      timeout: timeoutMs,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`))
      else resolve(stdout)
    })
  })
}

export interface GitExecResult {
  /** 进程退出码；-1 表示进程无法启动（git 未安装 / ENOENT） */
  code: number
  stdout: string
  stderr: string
}

/**
 * 不 reject 的孪生实现：返回原始退出码，由调用方按 git 的退出码语义自行处理。
 *
 * 存在的唯一理由：`git check-ignore` 的退出码 1 表示「没有任何路径被忽略」——
 * 这是**正常结果**，但 gitExec 会把任何非零退出码当成失败抛出。
 * 其余场景一律继续用 gitExec，保持「project-manager 下唯一 git 执行入口」这条约束。
 *
 * 超时语义：超过 timeoutMs（默认 30s，与 gitExec 对称）即 kill 子进程并 resolve
 * `code: -1`，绝不 reject —— 契约是「本函数不 reject」，调用方只按退出码语义判断。
 */
export function gitExecResult(
  workspace: string,
  args: string[],
  stdin = '',
  timeoutMs = 30 * 1000,
): Promise<GitExecResult> {
  return new Promise(resolve => {
    const child = spawn('git', args, {
      cwd: workspace,
      env: {...process.env, GIT_TERMINAL_PROMPT: '0'},
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    // error / close / timeout 三条终止路径统一收尾：先清定时器、再 kill、最后 resolve。
    // kill 已退出的进程是安全 no-op。
    const finish = (code: number) => {
      clearTimeout(timer)
      child.kill()
      if (settled) return
      settled = true
      resolve({code, stdout, stderr})
    }
    const timer = setTimeout(() => finish(-1), timeoutMs)
    child.stdout?.on('data', chunk => { stdout += chunk })
    child.stderr?.on('data', chunk => { stderr += chunk })
    // git 未安装 → ENOENT，按 -1 返回而不是抛错
    child.on('error', () => finish(-1))
    child.on('close', code => finish(code ?? -1))
    if (stdin) child.stdin?.write(stdin)
    child.stdin?.end()
  })
}
