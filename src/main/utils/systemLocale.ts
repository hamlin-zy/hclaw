/**
 * 主进程侧读取系统语言（渲染端显示「跟随系统(简体中文)」的真源）
 *
 * 为什么需要它：`app.getLocale()` 只在主进程可用，而设置页要展示**系统语言**本身。
 * settings.language.nativeLocale 虽由启动兜底刷新为系统语言，但它同时承担
 * 「当前生效母语」语义 —— 用户把下拉从手选切回「跟随系统」时，nativeLocale 要到下次启动
 * 才会刷新，此刻的标签就会显示旧语言。窗口创建时把系统语言经 additionalArguments
 * 同步传给渲染端（与 --hclaw-theme / --hclaw-win11 / --hclaw-dev 同模式，零 IPC 往返），
 * 切换时即可立即对齐。
 *
 * app.getLocale() 依赖 app ready；未 ready 时返回空串，调用方据此省略该参数，
 * 渲染端回退到 nativeLocale 快照。
 */
import {app} from 'electron'

export function readSystemLocale(): string {
    return app.isReady() ? app.getLocale() : ''
}
