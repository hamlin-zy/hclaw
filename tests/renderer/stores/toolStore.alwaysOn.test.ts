import {describe, expect, it, vi, beforeEach} from 'vitest'

// mock window.electronAPI（toolStore 依赖）
const setEnabled = vi.fn()
const list = vi.fn().mockResolvedValue({success: true, data: []})
;(globalThis as any).window = {
  electronAPI: {tool: {setEnabled, list}},
}

import {ALWAYS_ON_TOOLS} from '../../../src/shared/alwaysOnTools'
import {useToolStore} from '../../../src/renderer/stores/toolStore'

describe('toolStore 对 ALWAYS_ON_TOOLS 的 no-op', () => {
  beforeEach(() => {
    setEnabled.mockClear()
  })

  it('toggleTool 豁免工具 → 不调用 IPC（no-op）', () => {
    const store = useToolStore.getState()
    // 构造含豁免工具的初始状态
    useToolStore.setState({
      tools: [
        {id: 'analyze_image', name: 'analyze_image', description: '', enabled: false, timeout: null},
        {id: 'bash', name: 'bash', description: '', enabled: true, timeout: null},
      ],
    })
    store.toggleTool('analyze_image')
    expect(setEnabled).not.toHaveBeenCalledWith('analyze_image', expect.anything())
    // 非豁免工具正常
    store.toggleTool('bash')
    expect(setEnabled).toHaveBeenCalledWith('bash', false)
  })

  it('setToolEnabled 豁免工具 → 不调用 IPC', () => {
    const store = useToolStore.getState()
    useToolStore.setState({tools: [{id: 'speech_to_text', name: 'speech_to_text', description: '', enabled: false, timeout: null}]})
    store.setToolEnabled('speech_to_text', true)
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('ALWAYS_ON_TOOLS 契约（两个工具）', () => {
    expect(Array.from(ALWAYS_ON_TOOLS).sort()).toEqual(['analyze_image', 'speech_to_text'])
  })
})
