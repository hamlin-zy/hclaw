/**
 * 关于页面「检查更新」相关类型定义
 *
 * 数据流：
 *   主进程 updateChecker → IPC → 渲染层 updaterStore → AboutDialog / MenuBar
 */

export type UpdateStatus = 'up-to-date' | 'update-available' | 'error'

export type UpdateErrorCode = 'network' | 'rate-limit' | 'parse' | 'unknown'

export interface UpdateError {
  code: UpdateErrorCode
  message: string
}

export interface UpdateResult {
  /** 当前结果状态 */
  status: UpdateStatus
  /** 当前 app 版本号（package.json 中的 version） */
  currentVersion: string
  /** 最新稳定版版本号（仅在 update-available 时有值） */
  latestVersion?: string
  /** Release notes Markdown（仅在 update-available 时有值） */
  releaseNotes?: string
  /** 发布时间 ISO 8601（仅在 update-available 时有值） */
  publishedAt?: string
  /** 两个下载源 URL（错误时 baiduPan 仍保留作为兜底入口） */
  downloads: {
    /** GitHub Release tag 详情页 */
    github: string
    /** 百度网盘分享链接（带提取码） */
    baiduPan: string
  }
  /** 错误信息（仅在 status === 'error' 时有值） */
  error?: UpdateError
  /** 检查时间戳（毫秒） */
  checkedAt: number
}