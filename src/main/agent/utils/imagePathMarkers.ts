/**
 * 用户消息文本中的图片路径标记（两种语义必须保持可区分）
 *
 * 历史缺陷：附件注入与 load_image 快照合成消息共用同一字符串 `【图片文件路径】`。
 * 同一字符串承载互斥语义 → 请求期无法定向剥离 → 视觉模型看到「附件已随消息给出 image_url」
 * 的同时，文本中的路径又命中 load_image 的工具描述触发条件（"用户消息只在文字里提到某个本地图片路径"），
 * 于是对已可见图片重复调用 load_image，其结果再经 injectLoadedImages 派生出合成 user 消息，
 * 同一张图被二次注入（token 翻倍 + 浪费一次工具往返）。
 *
 * 因此拆分为互不重叠的两个常量，命名统一为 `<来源>_PATH_PREFIX` 单轴（唯一差异只在「来源」上）：
 * 附件注入用 ATTACHMENT_IMAGE_PATH_PREFIX（视觉模型可直接看到图片，该标注是纯噪声，可在请求期剥离）；
 * load_image 快照用 LOAD_IMAGE_SNAPSHOT_PATH_PREFIX（图片由工具产生，降级/非视觉模型仍需该路径
 * 回调 analyze_image，绝不能剥离）。
 */

/**
 * 附件注入专用前缀。语义：该图已随本条消息直接提供给模型（紧随 text 的 image_url 块），视觉模型可直接看到。
 */
export const ATTACHMENT_IMAGE_PATH_PREFIX = '【附件图片路径】'

/**
 * load_image 工具加载后的合成消息专用前缀。语义：图片由工具产生，路径供降级/非视觉模型 analyze_image 回退分析。
 */
export const LOAD_IMAGE_SNAPSHOT_PATH_PREFIX = '【图片文件路径】'
