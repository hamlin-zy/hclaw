import * as fs from 'fs'
import * as path from 'path'
import {simpleGit} from 'simple-git'
import {getHclawDir} from '../config'
import type {InstallTarget} from './type'
import {parseCloneUrl, repoDirName} from './origin'

/** 计算克隆目标目录（不落地）：skill → skills/public/<repo>@source；agent → agents/<repo>@source */
export function installTargetDir(target: InstallTarget, repoName: string): string {
  const hclawDir = getHclawDir()
  const dirName = repoDirName(repoName)
  if (target === 'skill') {
    return path.join(hclawDir, 'skills', 'public', dirName)
  }
  return path.join(hclawDir, 'agents', dirName)
}

/** 克隆仓库到目标目录；失败返回错误结果，不抛异常 */
export async function installRepo(
  target: InstallTarget,
  url: string,
): Promise<{success: boolean; repoId?: string; path?: string; error?: string}> {
  const parsed = parseCloneUrl(url)
  if (!parsed) {
    return {success: false, error: `无法解析仓库地址: ${url}`}
  }
  const dir = installTargetDir(target, parsed.name)
  const repoId = `${parsed.owner}/${parsed.name}`

  if (fs.existsSync(dir)) {
    return {success: false, error: `目标目录已存在: ${dir}（请先卸载或更换仓库）`}
  }

  // 确保父目录存在
  fs.mkdirSync(path.dirname(dir), {recursive: true})

  try {
    await simpleGit().clone(parsed.origin, dir)
    return {success: true, repoId, path: dir}
  } catch (err) {
    // 清理本次 clone 失败残留的目录（existsSync 检查在 clone 前已通过，dir 为本次创建）
    try { fs.rmSync(dir, {recursive: true, force: true}) } catch { /* 忽略清理失败 */ }
    const message = err instanceof Error ? err.message : String(err)
    return {success: false, error: `仓库克隆失败: ${message}`}
  }
}
