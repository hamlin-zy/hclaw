/**
 * PowerShell UTF-8 初始化命令（公共工具）
 *
 * 拼接在 -Command 脚本之前，确保 PowerShell（5.1 / 7+）的 stdout 以 UTF-8 输出：
 * - PS 7+ 默认已是 UTF-8，显式设置幂等无害；
 * - PS 5.1 在 GBK 等非 UTF-8 代码页控制台下，重定向输出走系统 ANSI，
 *   Node 侧按 UTF-8 解码会得到乱码——必须显式声明。
 *
 * 使用方：bashTool（交互命令）、companion/appEnumerator（枚举脚本）等
 * 一切经 execFile/spawn 调 PowerShell 并读取 stdout 的功能。
 */
export function getPowerShellUtf8Init(): string {
    return '$PSDefaultParameterValues["Out-File:Encoding"]="utf8"; [Console]::OutputEncoding=[System.Text.Encoding]::UTF8; [Console]::InputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8;'
}
