import {useSettingsStore} from '../../../stores/settingsStore'
import {INPUT_FOCUS} from '../../../lib/inputFocus'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import InfoTip from '../primitives/InfoTip'
import NumberField, {clampPositive} from '../primitives/NumberField'
import {PageResetRow} from '../primitives/ResetButton'

/**
 * 模型参数 Tab（spec §3.1）：默认最大 Token 数 / 默认温度 / 图片压缩质量。
 *
 * 迁移自旧 `dialogs/SettingsDialog.tsx`（`renderModelSettings`，L410-484）：
 * 行为语义不动（两组滑杆的 min/max/step 与 clamp/onBlur 逐字保持），字段一律 updatePending，不落盘。
 * 文案落地 spec §4.4/§4.2：标签去英文键名括号（键名进 InfoTip）、解释性说明迁 InfoTip。
 * DOM 保持旧形态（label 在上、控件在下、同父容器）——T20 迁移测试以 label.parentElement 定位控件。
 */
export default function ModelTab() {
    const {settings, pendingSettings, updatePending} = useSettingsStore()
    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.model}/>

            <div className="space-y-[var(--space-relaxed)]">
                <NumberField
                    label="默认最大 Token 数"
                    tip="maxTokens：LLM 输出的最大 Token 数"
                    value={current.model.defaultMaxTokens}
                    onChange={(v) => updatePending('model', {defaultMaxTokens: clampPositive(v, 8000)})}
                    min={1}
                    fallback={8000}
                />
                <div className="space-y-1">
                    <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                        默认温度
                        <InfoTip text="temperature：0 = 确定性输出，2 = 高随机性。建议代码任务使用 0。"/>
                    </label>
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min="0"
                            max="2"
                            step="0.1"
                            aria-label="默认温度"
                            className="flex-1 accent-[var(--brand-primary)]"
                            value={current.model.defaultTemperature}
                            onChange={(e) => updatePending('model', {defaultTemperature: parseFloat(e.target.value)})}
                            data-name="settings-model-temperature-range"/>
                        <input
                            type="number"
                            min="0"
                            max="2"
                            step="0.1"
                            aria-label="默认温度"
                            className={`w-16 bg-[var(--surface-muted)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-center outline-none ${INPUT_FOCUS}`}
                            value={current.model.defaultTemperature}
                            onChange={(e) => {
                                const v = parseFloat(e.target.value)
                                if (!isNaN(v) && v >= 0) updatePending('model', {defaultTemperature: Math.min(2, v)})
                            }}
                            onBlur={(e) => {
                                const v = parseFloat(e.target.value)
                                if (isNaN(v) || v < 0) updatePending('model', {defaultTemperature: 0})
                            }}
                            data-name="settings-model-temperature-number"/>
                    </div>
                </div>
                <div className="space-y-1">
                    <label className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
                        图片压缩质量
                        <InfoTip text="imageCompressQuality：数值越高越清晰，体积、耗时与计费 token 越大。仅影响 load_image 加载的图片；未超过体积/尺寸阈值的小图不会被重新编码。"/>
                    </label>
                    <div className="flex items-center gap-3">
                        <input
                            type="range"
                            min="1"
                            max="100"
                            step="1"
                            aria-label="图片压缩质量"
                            className="flex-1 accent-[var(--brand-primary)]"
                            value={current.model.imageCompressQuality ?? 85}
                            onChange={(e) => updatePending('model', {imageCompressQuality: parseInt(e.target.value)})}
                            data-name="settings-model-image-quality-range"/>
                        <input
                            type="number"
                            min="1"
                            max="100"
                            step="1"
                            aria-label="图片压缩质量"
                            className={`w-16 bg-[var(--surface-muted)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-center outline-none ${INPUT_FOCUS}`}
                            value={current.model.imageCompressQuality ?? 85}
                            onChange={(e) => {
                                const v = parseInt(e.target.value)
                                if (!isNaN(v) && v >= 1) updatePending('model', {imageCompressQuality: Math.min(100, v)})
                            }}
                            onBlur={(e) => {
                                const v = parseInt(e.target.value)
                                if (isNaN(v) || v < 1) updatePending('model', {imageCompressQuality: 85})
                            }}
                            data-name="settings-model-image-quality-number"/>
                    </div>
                </div>
            </div>
        </div>
    )
}
