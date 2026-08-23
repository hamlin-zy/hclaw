import {useEffect, useState} from 'react'
import {getUsdCnyRate, syncExchangeRate} from '../lib/format'

/**
 * 同步主进程实时汇率（与 App.tsx 主窗口启动逻辑共用 syncExchangeRate）
 *
 * dialogWindow 等独立窗口是独立渲染进程，模块变量 currentUsdCnyRate 不会自动获得
 * 主窗口同步的汇率，此前恒为默认值 7.2，导致 CNY 成本换算与 InfoTip 口径文案错误
 * （与右键菜单用量统计弹窗不一致）。挂载时同步并用 state 驱动重渲染（避免 IPC 返回
 * 晚于数据加载时展示过期的默认汇率）。未暴露 API（可选链）/ 同步失败 → 保留默认值。
 */
export function useExchangeRateSync(): number {
  const [rate, setRate] = useState<number>(() => getUsdCnyRate())
  useEffect(() => {
    let cancelled = false
    void syncExchangeRate().then((r) => {
      if (!cancelled) setRate(r)
    })
    return () => {
      cancelled = true
    }
  }, [])
  return rate
}
