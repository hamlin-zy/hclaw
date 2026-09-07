import {describe, expect, it, beforeEach, afterEach, vi} from 'vitest'

// mock modelMetaRegistry（不依赖磁盘缓存）
vi.mock('../../../src/main/modelMetaRegistry', () => {
  return {
    modelMetaRegistry: {
      getInputModalities: vi.fn(),
    },
  }
})

import {supportsImageInput} from '../../../src/main/agent/modelCapability'
import {modelMetaRegistry} from '../../../src/main/modelMetaRegistry'

const mockGetModalities = modelMetaRegistry.getInputModalities as ReturnType<typeof vi.fn>

describe('supportsImageInput 判定优先级', () => {
  beforeEach(() => {
    mockGetModalities.mockReset()
    // 默认不命中元数据 → 回退命名模式（shared/modelParams 内置正则）
    mockGetModalities.mockReturnValue(null)
  })
  afterEach(() => vi.restoreAllMocks())

  it('① 元数据含 image → true', () => {
    mockGetModalities.mockReturnValue(['text', 'image'])
    expect(supportsImageInput('deepseek-v4-flash-vision-exp')).toBe(true)
  })

  it('② 元数据明确不含 image（["text"]） → false（权威，不回退命名模式）', () => {
    mockGetModalities.mockReturnValue(['text'])
    // 即使命名模式会命中（如 gpt-4o），也不回退
    expect(supportsImageInput('gpt-4o')).toBe(false)
  })

  it('②b 元数据含 video 不含 image → false', () => {
    mockGetModalities.mockReturnValue(['text', 'video'])
    expect(supportsImageInput('qwen/qwen3-vl')).toBe(false)
  })

  it('③ 元数据 null → 回退命名模式命中 → true（shared 内置正则，与 helpers 同源）', () => {
    mockGetModalities.mockReturnValue(null)
    // 注意：'gpt-4o' 已在用例②被记忆化为 false（per-modelId 缓存跨用例保留），
    // 此处用全新 id 验证回退路径，避免与用例②共享缓存。
    expect(supportsImageInput('gpt-4o-fallback')).toBe(true)
  })

  it('④ 元数据 null + 命名模式不命中 → false', () => {
    mockGetModalities.mockReturnValue(null)
    expect(supportsImageInput('deepseek-v4-flash')).toBe(false)
  })

  it('⑤ 自定义 modelTypes 优先于元数据（含 image/multimodal → true）', () => {
    mockGetModalities.mockReturnValue(['text'])
    expect(supportsImageInput('text-only-model', ['text', 'image'])).toBe(true)
    expect(supportsImageInput('text-only-model', ['multimodal'])).toBe(true)
  })

  it('⑤b 自定义 modelTypes 明确不含 image → false（覆盖元数据命中）', () => {
    mockGetModalities.mockReturnValue(['image'])
    expect(supportsImageInput('or-vision-model', ['text'])).toBe(false)
  })

  // ★ 回归（glm-5.3-flash 误判事件）：无 customTypes（modelSelector 不再包装旧单值默认值）
  //   时，元数据含 image 必须生效。历史 bug：调用方把导入默认值 'text' 包装成 ['text']
  //   传入，本用例 ① 本应成立的判定被 ⑤b 路径短路。
  it('回归：无 customTypes + 元数据含 image → true（不被单值默认值短路）', () => {
    mockGetModalities.mockReturnValue(['text', 'image', 'video'])
    expect(supportsImageInput('z-ai/glm-5.3-flash')).toBe(true)
  })

  it('⑤c 同一 modelId 在有无 customTypes 时缓存不串扰', () => {
    mockGetModalities.mockReturnValue(['text'])
    expect(supportsImageInput('dual-key-model')).toBe(false)
    expect(supportsImageInput('dual-key-model', ['image'])).toBe(true)
    expect(supportsImageInput('dual-key-model')).toBe(false)
  })

  it('边界：空串 / undefined → false（不抛异常）', () => {
    expect(supportsImageInput('')).toBe(false)
    expect(supportsImageInput(undefined as unknown as string)).toBe(false)
  })

  it('记忆化：同 modelId 连续调用结果一致，元数据查询只发生一次', () => {
    mockGetModalities.mockReturnValue(['text', 'image'])
    expect(supportsImageInput('m1')).toBe(true)
    expect(supportsImageInput('m1')).toBe(true)
    expect(mockGetModalities).toHaveBeenCalledTimes(1)
  })

  it('记忆化：不同 modelId 不串扰', () => {
    mockGetModalities.mockReturnValueOnce(['text', 'image']).mockReturnValueOnce(['text'])
    expect(supportsImageInput('vis-model')).toBe(true)
    expect(supportsImageInput('text-model')).toBe(false)
  })

  it('记忆化上限：超过 100 个模型后清空（防内存泄漏）', () => {
    mockGetModalities.mockReturnValue(['text', 'image'])
    for (let i = 0; i < 105; i++) supportsImageInput(`model-${i}`)
    // 清空后重新查询第一个 → 再次触发元数据查询
    mockGetModalities.mockClear()
    supportsImageInput('model-0')
    expect(mockGetModalities).toHaveBeenCalled()
  })
})
