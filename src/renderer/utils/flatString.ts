/**
 * 叶子工具：生成扁平字符串副本。
 *
 * V8 的 slice/substring 对长串返回 SlicedString（引用整个父串，Chromium Issue 2869），
 * 截断大字符串后若不强制复制，被截掉的父串无法被 GC 释放，导致内存滞留。
 *
 * ★ 内存优化 D2：叶子工具，避免 store 循环依赖。
 *   本模块定义不得 import 任何 store / 组件 / 有副作用的模块。
 *   此前 flatString 定义在 conversationStore，被 toolCallsStore 反向引用，形成
 *   toolCallsStore → conversationStore → agentStore/* → toolCallsStore 的循环依赖；
 *   迁到叶子模块后该环被切断。conversationStore 仍 re-export 以兼容既有导入方。
 */
export function flatString(s: string): string {
    return s.split('').join('')
}
