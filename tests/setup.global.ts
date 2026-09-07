/**
 * 全局测试 setup：
 * jsdom 不实现 ResizeObserver，而组件树（InputToolbar/CacheRateTooltip 等经
 * 第三方或自研 hook）会间接实例化它，缺失时抛 ReferenceError 导致整组用例失败。
 * 这里提供最小可用 polyfill。
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
    } as unknown as typeof ResizeObserver
}
