import {Switch} from '../../common/Switch'
import CollapsibleSection from '../../common/CollapsibleSection'
import {useSettingsStore} from '../../../stores/settingsStore'
import {PAGE_FIELD_SETS} from '../primitives/fieldSets'
import FormRow from '../primitives/FormRow'
import NumberField, {clampPositive} from '../primitives/NumberField'
import {PageResetRow} from '../primitives/ResetButton'
import SectionHeader from '../primitives/SectionHeader'
import SelectRow from '../primitives/SelectRow'
import SwitchStatus from '../primitives/SwitchStatus'

/**
 * Agent 运行 Tab（spec §3.1）：分节「任务循环」/「上下文交接」/「循环检测」/「子 Agent（委派）」
 * 与默认折叠的「高级·超时与重试」（spec §5.4）。
 *
 * 迁移自旧 `dialogs/SettingsDialog.tsx`（Agent 区 L237-383 + Subagent 区 L385-436）：
 * 行为语义不动（含各处 clamp 换算逐字保持），字段一律 updatePending，不落盘。
 * 文案落地 spec §4.4 命名表：英文键名与「(s)」括号去除、单位走 `unit` 后缀、说明迁 InfoTip；
 * 生效时机 InfoTip 按 spec §5.3 清单（maxTurns / 检测阈值「下次任务生效」、子 Agent 两项「下次派生」）。
 */
export default function AgentTab() {
    const {settings, pendingSettings, updatePending} = useSettingsStore()
    // 当前生效的值：优先 pending（未保存），否则用已保存值
    const current = pendingSettings || settings
    const handoffRatio = current.agent.handoffThresholdRatio ?? 0.5
    const thresholdMode = current.agent.handoffThresholdMode ?? 'ratio'
    const loopMode = current.agent.loopDetection?.mode ?? 'notify'
    // 交接引导关闭（ratio=0）时两个阈值字段一并禁用（旧语义）
    const handoffOff = handoffRatio === 0

    return (
        <div className="space-y-[var(--space-spacious)]">
            <PageResetRow paths={PAGE_FIELD_SETS.agent}/>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>任务循环</SectionHeader>
                <NumberField
                    label="最大轮次"
                    tip="maxTurns：Agent 推理循环的最大迭代次数；下次任务生效"
                    value={current.agent.maxTurns}
                    onChange={(v) => updatePending('agent', {maxTurns: clampPositive(v, 500)})}
                    min={1}
                    fallback={500}
                />
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>上下文交接</SectionHeader>
                <FormRow label="交接引导" tip="关闭后发送消息前不再询问是否交接（等价于把阈值设为 0）">
                    <div className="flex items-center gap-2">
                        <Switch
                            checked={handoffRatio > 0}
                            ariaLabel="交接引导"
                            onChange={(checked) => updatePending('agent', {handoffThresholdRatio: checked ? 0.5 : 0})}
                        />
                        <SwitchStatus on={handoffRatio > 0}/>
                    </div>
                </FormRow>
                {/* 当前模式语义（spec §4.2 保留的「当前状态提示」类）经 hint 渲染在控件下方 */}
                <SelectRow
                    label="阈值计算方式"
                    value={thresholdMode}
                    onChange={(v) => updatePending('agent', {handoffThresholdMode: v as 'ratio' | 'tokens'})}
                    options={[{value: 'ratio', label: '按比例'}, {value: 'tokens', label: '按窗口大小'}]}
                    hint={thresholdMode === 'ratio'
                        ? '阈值 = 当前模型窗口 × 比例。'
                        : '阈值 = 固定 token 数（不随各模型窗口变化）。'}
                />
                {/* R20：两个阈值字段按「阈值计算方式」互斥呈现（旧行为，被 T20 迁移测试固化）；交接引导关闭时禁用 */}
                {thresholdMode === 'ratio' ? (
                    <NumberField
                        label="交接引导阈值"
                        unit="%"
                        tip="handoffThresholdRatio：发送消息时上下文占用超过此比例即询问是否交接到新会话；默认 50%，设 0 同时关闭弹窗与单轮内保护（不推荐）"
                        value={Math.round(handoffRatio * 100)}
                        onChange={(v) => updatePending('agent', {handoffThresholdRatio: Math.min(100, Math.max(0, Math.round(v))) / 100})}
                        min={0}
                        fallback={50}
                        disabled={handoffOff}
                    />
                ) : (
                    <NumberField
                        label="交接阈值大小"
                        unit="K"
                        tip="handoffThresholdTokens：按固定 token 数触发交接，最低 50K、默认 200K；不受各模型窗口差异影响。"
                        value={Math.round((current.agent.handoffThresholdTokens ?? 200_000) / 1000)}
                        onChange={(v) => updatePending('agent', {handoffThresholdTokens: (Number.isFinite(v) ? Math.max(50, Math.round(v)) : 200) * 1000})}
                        min={50}
                        fallback={200}
                        disabled={handoffOff}
                    />
                )}
                <SelectRow
                    label="上下文溢出处理"
                    tip="midLoopOverflowMode：单次任务执行中上下文接近窗口上限时的处理。自动交接 = 自动总结并交接到新会话继续执行；优雅停止 = 停止本轮并提示手动处理。"
                    value={current.agent.midLoopOverflowMode ?? 'auto-handoff'}
                    onChange={(v) => updatePending('agent', {midLoopOverflowMode: v as 'auto-handoff' | 'graceful-stop'})}
                    options={[{value: 'auto-handoff', label: '自动交接（推荐）'}, {value: 'graceful-stop', label: '优雅停止'}]}
                />
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>循环检测</SectionHeader>
                <SelectRow
                    label="循环检测"
                    tip="loopDetection.mode：检测到 Agent 陷入重复循环时提醒，避免无意义的 token 消耗。提示 = 显示警告条不打断任务；暂停 = 暂停循环等待您选择；关闭 = 停用此功能。"
                    value={loopMode}
                    onChange={(v) => updatePending('agent', {
                        loopDetection: {
                            mode: v as 'notify' | 'pause' | 'off',
                            threshold: current.agent.loopDetection?.threshold ?? 3,
                        },
                    })}
                    options={[{value: 'notify', label: '提示（推荐）'}, {value: 'pause', label: '暂停'}, {value: 'off', label: '关闭'}]}
                />
                {loopMode !== 'off' && (
                    <NumberField
                        label="检测阈值"
                        tip="loopDetection.threshold：连续相同工具调用的轮数达到该值时触发；低于 3 易误判，不推荐。下次任务生效"
                        value={current.agent.loopDetection?.threshold ?? 3}
                        onChange={(v) => updatePending('agent', {
                            loopDetection: {
                                mode: current.agent.loopDetection?.mode ?? 'notify',
                                threshold: Math.max(2, Math.round(v) || 3),
                            },
                        })}
                        min={2}
                        fallback={3}
                    />
                )}
            </section>

            <section className="space-y-[var(--space-relaxed)]">
                <SectionHeader>子 Agent（委派）</SectionHeader>
                <NumberField
                    label="最大并发数"
                    tip="maxConcurrency：子 Agent 同时运行的最大数量；下次派生"
                    value={current.subagent?.maxConcurrency ?? 3}
                    onChange={(v) => updatePending('subagent', {maxConcurrency: clampPositive(v, 3)})}
                    min={1}
                    fallback={3}
                />
                <NumberField
                    label="委派深度"
                    tip="maxDepth：子 Agent 嵌套的最大层级深度，防止无限递归；下次派生"
                    value={current.subagent?.maxDepth ?? 3}
                    onChange={(v) => updatePending('subagent', {maxDepth: clampPositive(v, 3)})}
                    min={1}
                    max={10}
                    fallback={3}
                    decimals={0}
                />
            </section>

            {/* 高级项收进折叠区（spec §5.4：默认值合理，慢模型需可调） */}
            {/* R: 折叠标题曾因字号小且排最末被误认为「配置丢失」→ 加徽章 + 提色提升发现性 */}
            <CollapsibleSection
                title="高级·超时与重试"
                defaultExpanded={false}
                className="pb-[var(--space-spacious)]"
                buttonClassName="text-[var(--text-primary)]"
                headerContent={
                    <span
                        className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-[10px] leading-none text-[var(--text-secondary)]"
                    >
                        重试 / 超时
                    </span>
                }
            >
                <div className="space-y-[var(--space-relaxed)] pt-3">
                    <NumberField
                        label="最大尝试次数"
                        tip="retryCount：LLM 超时或异常时的最大尝试次数（含首次尝试）"
                        value={current.agent.retryCount}
                        onChange={(v) => updatePending('agent', {retryCount: clampPositive(v, 10)})}
                        min={1}
                        fallback={10}
                    />
                    <div className="grid grid-cols-2 gap-4">
                        <NumberField
                            label="首次重试延迟"
                            unit="秒"
                            tip="initialRetryDelay：首次重试的等待时间，后续按指数增加"
                            value={current.agent.initialRetryDelay / 1000}
                            onChange={(v) => updatePending('agent', {initialRetryDelay: clampPositive(v, 5) * 1000})}
                            min={1}
                            fallback={5}
                            decimals={1}
                        />
                        <NumberField
                            label="最大重试延迟"
                            unit="秒"
                            tip="maxRetryDelay：重试间隔上限"
                            value={current.agent.maxRetryDelay / 1000}
                            onChange={(v) => updatePending('agent', {maxRetryDelay: clampPositive(v, 120) * 1000})}
                            min={1}
                            fallback={120}
                            decimals={1}
                        />
                    </div>
                    <NumberField
                        label="LLM 超时时间"
                        unit="秒"
                        tip="llmTimeout：单次 LLM 调用的超时时间"
                        value={current.agent.llmTimeout / 1000}
                        onChange={(v) => updatePending('agent', {llmTimeout: clampPositive(v, 600) * 1000})}
                        min={10}
                        fallback={600}
                        decimals={1}
                    />
                </div>
            </CollapsibleSection>
        </div>
    )
}
