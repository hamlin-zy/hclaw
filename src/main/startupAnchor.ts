/**
 * 主进程模块图求值锚点（冷启动观测，零依赖副作用模块）
 *
 * 必须作为 src/main/index.ts 的**第一条 import**：
 * ESM 按 import 声明顺序深度优先求值，本模块无任何依赖，因此它的模块体会在
 * 其余主进程模块（electron / repositories/init / config / agent 等）求值之前执行。
 * 这给出「主进程模块图开始求值」的下界锚点，与 startupTrace 的首条打点相减，
 * 即可得出「剩余主进程模块图求值总耗时」。
 *
 * 硬约束：本文件不得 import 任何模块（尤其 electron / config / repositories）。
 * 一旦引入依赖，就会改变既有模块求值顺序（例如把 repositories/init 的 DB 初始化
 * 提到 electron 之前），破坏启动正确性。仅写一个 globalThis 数字，无副作用风险。
 */

;(globalThis as typeof globalThis & {__hclawStartupAnchor?: number}).__hclawStartupAnchor =
    Date.now()
