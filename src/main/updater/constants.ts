/**
 * 关于页面「检查更新」相关常量
 *
 * 集中在常量文件便于：
 *   1. 单测中可单独覆盖测试
 *   2. 未来切换镜像（如改为 Gitee 仓库）时改一处即可
 */

/** GitHub 仓库 owner/name */
export const GITHUB_REPO = 'hamlin-zy/hclaw'

/** GitHub REST API 根地址 */
export const GITHUB_API_BASE = 'https://api.github.com'

/** 百度网盘分享链接（含提取码）—— 与 README.md 保持一致 */
export const BAIDU_PAN_URL = 'https://pan.baidu.com/s/1EIlDiU-EiEEiF-oXrHhFdQ?pwd=nmhb'

/** 内存缓存 TTL：10 分钟内不重复请求 GitHub API */
export const CACHE_TTL_MS = 10 * 60 * 1000

/** 单次 HTTP 请求超时：5 秒（避免用户等待过长） */
export const REQUEST_TIMEOUT_MS = 5000