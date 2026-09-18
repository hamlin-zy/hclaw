import {Switch} from '../../common/Switch'
import {useSettingsStore} from '../../../stores/settingsStore'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import FormRow from '../primitives/FormRow'
import NumberField, {clampPositive} from '../primitives/NumberField'
import {PageResetRow} from '../primitives/ResetButton'
import SwitchStatus from '../primitives/SwitchStatus'

/**
 * IM 配置 Tab（spec §3.1）：连接后发送打招呼信息 / 连接超时时间。
 *
 * 迁移自旧 `dialogs/SettingsDialog.tsx`（`renderChannelSettings`，L912-937）：
 * 行为语义不动（开关默认值、clampPositive 与 fallback 逐字保持），字段一律 updatePending，不落盘。
 * 文案落地 spec §4.4/§4.2：标签去英文键名与「(秒)」括号（单位走 `unit`、键名进 InfoTip），
 * 旧内联说明 `<p>` 收敛进 FormRow 的 tip；两项均属连接路径（R24 裁定）→ 生效时机统一标「下次连接生效」。
 * 单分节页不渲染 SectionHeader（spec §3.1 中间列为「—」，与 ModelTab 同型）。
 */
export default function ChannelsTab() {
    const {settings, pendingSettings, updatePending} = useSettingsStore()
    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.channels}/>

            <div className="space-y-[var(--space-relaxed)]">
                <FormRow
                    label="连接后发送打招呼信息"
                    tip="sendGreeting：渠道连接成功后，自动发送问候消息给登录用户；下次连接生效"
                >
                    <div className="flex items-center gap-2">
                        <Switch
                            checked={current.channels?.sendGreeting ?? true}
                            ariaLabel="连接后发送打招呼信息"
                            onChange={(checked) => updatePending('channels', {sendGreeting: checked})}
                        />
                        <SwitchStatus on={!!current.channels?.sendGreeting}/>
                    </div>
                </FormRow>

                <NumberField
                    label="连接超时时间"
                    unit="秒"
                    tip="渠道建立连接的超时时间，超时后标记为连接失败；下次连接生效"
                    value={current.channels?.connectionTimeout ?? 30}
                    onChange={(v) => updatePending('channels', {connectionTimeout: clampPositive(v, 30)})}
                    min={5}
                    fallback={30}
                />
            </div>
        </div>
    )
}
