// src/main/repo/origin.ts
import type {RepoSource, RemoteInfo} from './type'

function detectSource(host: string): RepoSource {
  return host.includes('gitee') ? 'gitee' : host.includes('gitlab') ? 'gitlab' : 'github'
}

/**
 * 从 git remote origin URL 解析 owner/name/source。
 * 支持 https / ssh（git@）形式，github/gitee/gitlab。
 * 解析不出时返回 null。
 */
export function parseGitOrigin(originUrl: string): { owner: string; name: string; source: RepoSource } | null {
  if (!originUrl) return null
  const url = originUrl.trim()

  // SSH: git@host:owner/repo.git
  const sshMatch = url.match(/^git@([^:]+):(.+?)(?:\.git)?$/)
  if (sshMatch) {
    const parts = sshMatch[2].split('/')
    if (parts.length < 2) return null
    const owner = parts[parts.length - 2]
    const name = parts[parts.length - 1].replace(/\.git$/, '')
    return name ? {owner, name, source: detectSource(sshMatch[1])} : null
  }

  // https: https://host/owner[/group]/repo[.git]（owner 取倒数第二段，支持嵌套分组）
  const httpsMatch = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/)
  if (httpsMatch) {
    const pathParts = httpsMatch[2].replace(/\.git$/, '').split('/')
    if (pathParts.length < 2) return null
    const owner = pathParts[pathParts.length - 2]
    const name = pathParts[pathParts.length - 1]
    return name ? {owner, name, source: detectSource(httpsMatch[1])} : null
  }

  return null
}

/**
 * 从用户输入的仓库地址解析可克隆信息（origin 归一为可 git clone 的 URL）。
 * 输入可以是 https / ssh / owner/repo 简写（默认 github）。
 */
export function parseCloneUrl(url: string): RemoteInfo | null {
  const trimmed = (url || '').trim()
  if (!trimmed) return null

  // 先尝试完整 URL
  const asRemote = parseGitOrigin(trimmed)
  if (asRemote) {
    return {origin: trimmed, ...asRemote}
  }

  // owner/repo 简写 → github https
  const directMatch = trimmed.match(/^([^/\s]+)\/([^/\s]+)$/)
  if (directMatch) {
    const owner = directMatch[1]
    const name = directMatch[2].replace(/\.git$/, '')
    return {origin: `https://github.com/${owner}/${name}`, owner, name, source: 'github'}
  }

  return null
}

/** 克隆目录名：<repo>@source */
export function repoDirName(repoName: string): string {
  return `${repoName}@source`
}
