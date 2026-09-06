import type {Variants} from 'framer-motion'

/**
 * 共享动画预设（framer-motion Variants）
 *
 * 集中管理 UI 进出场动画，消除各组件内联重复的 initial/animate/exit 对象，
 * 统一动画节奏。用法：<motion.div {...fade} transition={...} />
 * 展开后等价于手写 initial/animate/exit 三个 prop。
 */

/** 纯淡入淡出：遮罩层、toast、overlay */
export const fade: Variants = {
  initial: {opacity: 0},
  animate: {opacity: 1},
  exit: {opacity: 0},
}

/** 缩放 + 淡入淡出：弹窗面板（无位移） */
export const scaleFade: Variants = {
  initial: {scale: 0.95, opacity: 0},
  animate: {scale: 1, opacity: 1},
  exit: {scale: 0.95, opacity: 0},
}

/** 高度折叠/展开：可折叠区块 */
export const collapse: Variants = {
  initial: {height: 0, opacity: 0},
  animate: {height: 'auto', opacity: 1},
  exit: {height: 0, opacity: 0},
}

/** 向上展开的弹层（从按钮上方弹出，如 ModelSelector/ToolMenu 的 popover） */
export const popoverUp: Variants = {
  initial: {opacity: 0, y: 8, scale: 0.95},
  animate: {opacity: 1, y: 0, scale: 1},
  exit: {opacity: 0, y: 8, scale: 0.95},
}

/** 向下展开的弹层（带缩放，如从按钮向下弹出的面板） */
export const popoverDown: Variants = {
  initial: {opacity: 0, y: -8, scale: 0.95},
  animate: {opacity: 1, y: 0, scale: 1},
  exit: {opacity: 0, y: -8, scale: 0.95},
}

/** 下拉选择器（纯滑动，无缩放） */
export const dropdown: Variants = {
  initial: {opacity: 0, y: -8},
  animate: {opacity: 1, y: 0},
  exit: {opacity: 0, y: -8},
}

/** 浮层/tooltip（缩放弹出，缩放幅度比弹窗面板更明显） */
export const tooltip: Variants = {
  initial: {opacity: 0, scale: 0.9},
  animate: {opacity: 1, scale: 1},
  exit: {opacity: 0, scale: 0.9},
}
