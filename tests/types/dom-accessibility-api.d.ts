/**
 * `dom-accessibility-api` 的类型补丁。
 *
 * 该包的 package.json `exports` 只映射了 `import`/`require` 两个条件、**没有 `types`**，
 * 于是 `moduleResolution: "bundler"` 下 TS 解析到 `dist/index.mjs` 后找不到同名声明
 * （声明其实就在 `dist/index.d.ts`，只是 exports 没把它暴露出来）。
 * 这里补上本仓用到的那两个函数——只声明用得到的签名，不做全量复刻。
 */
declare module 'dom-accessibility-api' {
    export function computeAccessibleName(element: Element, options?: unknown): string
    export function computeAccessibleDescription(element: Element, options?: unknown): string
}
