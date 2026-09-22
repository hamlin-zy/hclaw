/**
 * 关于页面「检查更新」相关常量
 *
 * 集中在常量文件便于：
 *   1. 单测中可单独覆盖测试
 *   2. 未来切换镜像（如改为 Gitee 仓库）时改一处即可
 */

/** GitHub 仓库 owner/name */
export const GITHUB_REPO = 'hamlin-zy/hclaw'

/** 下载页基础 URL（拼接 releases/tag/vX.Y.Z 得到具体下载页） */
export const GITHUB_DOWNLOADS_BASE_URL = `https://github.com/${GITHUB_REPO}`

/** GitHub raw 上的 CHANGELOG.json — 更新检查唯一数据源 */
export const GITHUB_RAW_CHANGELOG_URL = `https://raw.githubusercontent.com/${GITHUB_REPO}/main/CHANGELOG.json`

/** Gitee 仓库路径（GitHub raw 拉取失败时的兜底版本源） */
const GITEE_REPO = 'sunshao/hclaw'

/** Gitee raw 上的 CHANGELOG.json — 与 GitHub 同一文件镜像 */
export const GITEE_RAW_CHANGELOG_URL = `https://gitee.com/${GITEE_REPO}/raw/main/CHANGELOG.json`

/** 百度网盘分享链接（含提取码）—— 与 README.md 保持一致 */
export const BAIDU_PAN_URL = 'https://pan.baidu.com/s/1EIlDiU-EiEEiF-oXrHhFdQ?pwd=nmhb'

/** 内存缓存 TTL：10 分钟内不重复请求 */
export const CACHE_TTL_MS = 10 * 60 * 1000

/** 单次 HTTP 请求超时：5 秒 */
export const REQUEST_TIMEOUT_MS = 5000