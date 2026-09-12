/**
 * tab 条横向滚动几何换算（EditorArea 用）。
 *
 * 为什么单独抽出来：jsdom 没有布局引擎，元素 rect 全为 0，在组件里伪造几何再断言等价于自证；
 * 抽成纯函数后可以直接喂数值做单测，组件侧只保留「取 rect → 应用 scrollLeft」的胶水。
 *
 * 为什么用 getBoundingClientRect 而不是 offsetLeft：.pm-tabbar-scroll 没有 position: relative，
 * 其子 tab 的 offsetParent 不是它，offsetLeft 的参照系不对；只有两个 rect 之差才是容器内的真实偏移。
 *
 * 策略为「最小滚动」（而非居中）：只把越界的边缘带进可视区。
 * 激活相邻 tab 时视野不跳变，少量 tab 已可见时零位移，单行不可滚动容器公式自然收敛为 no-op。
 */

export interface RectLike {
  left: number
  right: number
}

export function computeTabScrollLeft(containerRect: RectLike, tabRect: RectLike, scrollLeft: number): number {
  // 左边缘落在容器左侧之外 → 向左滚动，使 tab 左边缘贴齐容器左边缘
  if (tabRect.left < containerRect.left) {
    return scrollLeft - (containerRect.left - tabRect.left)
  }
  // 右边缘落在容器右侧之外 → 向右滚动，使 tab 右边缘贴齐容器右边缘
  if (tabRect.right > containerRect.right) {
    return scrollLeft + (tabRect.right - containerRect.right)
  }
  // 已完全可见（含 jsdom 全零几何）→ 不动
  return scrollLeft
}
