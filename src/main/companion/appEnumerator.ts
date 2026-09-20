import {execFile} from 'child_process'
import {promisify} from 'util'
import fs from 'fs'
import path from 'path'
import {logger} from '../agent/logger'
import {getPowerShellUtf8Init} from '../utils/powershellUtf8'
import type {EnumeratedApp} from '../../shared/types/companion'

const execFileAsync = promisify(execFile)

/** PowerShell 枚举超时（spec §2：超时 kill 并返回部分结果） */
const POWERSHELL_TIMEOUT_MS = 15000

const ENUM_SCRIPT = `${getPowerShellUtf8Init()}
$shell = New-Object -ComObject WScript.Shell
$paths = @(
  "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs",
  "$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Get-ChildItem -Path $p -Recurse -Filter *.lnk | ForEach-Object {
      try {
        $lnk = $shell.CreateShortcut($_.FullName)
        Write-Output (ConvertTo-Json -Compress -Depth 2 ([PSCustomObject]@{
          name = $_.BaseName
          exePath = $lnk.TargetPath
          arguments = $lnk.Arguments
          iconLocation = $lnk.IconLocation
          shortcutPath = $_.FullName
        }))
      } catch { }
    }
  }
}`

/** 过滤规则：空 exePath / 文件不存在 / System32 / .lnk 循环引用 */
function isValidExe(exePath: string): boolean {
    if (!exePath) return false
    const lower = exePath.toLowerCase()
    if (lower.endsWith('.lnk')) return false
    const sysRoot = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase()
    const sys32Dir = path.join(sysRoot, 'System32').toLowerCase()
    if (lower === sys32Dir || lower.startsWith(`${sys32Dir}${path.sep}`)) return false
    try {
        return fs.existsSync(exePath)
    } catch {
        return false
    }
}

/** 纯函数：解析 PowerShell stdout（逐行紧凑 JSON，每行一条）并应用过滤规则；坏行跳过不炸整批 */
export function parseEnumerateOutput(stdout: string): EnumeratedApp[] {
    const results: EnumeratedApp[] = []
    for (const rawLine of stdout.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line) continue
        let entry: unknown
        try {
            entry = JSON.parse(line)
        } catch (err) {
            logger.warn('companion-enumerate-parse-failed', {error: String(err), line: line.slice(0, 200)})
            continue
        }
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
        const e = entry as Record<string, unknown>
        const app = {
            name: String(e.name ?? ''),
            exePath: String(e.exePath ?? ''),
            args: String(e.arguments ?? ''),
            shortcutPath: String(e.shortcutPath ?? ''),
        }
        if (isValidExe(app.exePath)) results.push(app)
    }
    return results
}

/** 系统应用枚举。非 Windows stub 返回空数组（spec YAGNI：mac/Linux 后续迭代）。 */
export async function enumerateApps(): Promise<EnumeratedApp[]> {
    if (process.platform !== 'win32') return []
    let stdout = ''
    try {
        const result = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', ENUM_SCRIPT], {
            timeout: POWERSHELL_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        })
        stdout = result.stdout
    } catch (err) {
        // 超时/失败：尽量取 error.stdout 上的部分结果（promisify 的 execFile 失败对象带 stdout）
        const partial = (err as {stdout?: string}).stdout ?? ''
        if (!partial.trim()) {
            logger.warn('companion-enumerate-failed', {error: String(err)})
            return []
        }
        stdout = partial
    }
    return parseEnumerateOutput(stdout)
}
