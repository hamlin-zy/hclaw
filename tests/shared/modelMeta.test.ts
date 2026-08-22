import {describe, expect, it} from 'vitest'
import {
  matchOpenRouterModel,
  normalizeModelId,
  parseOpenRouterModels,
  type OpenRouterModelRaw,
} from '@shared/modelMeta'

describe('normalizeModelId（分隔符归一化）', () => {
  it('小写 + trim', () => {
    expect(normalizeModelId('  Claude-Opus ')).toBe('claudeopus')
  })

  it('分隔符删除：. - _ 归一化后相等', () => {
    const a = normalizeModelId('claude-opus-4-6')
    const b = normalizeModelId('claude-opus-4.6')
    const c = normalizeModelId('claude_opus_4_6')
    expect(a).toBe('claudeopus46')
    expect(a).toBe(b)
    expect(a).toBe(c)
  })

  it('/ 保留：provider/model 分隔符不可被归一化掉', () => {
    const n = normalizeModelId('deepseek/deepseek-chat')
    expect(n.split('/')).toEqual(['deepseek', 'deepseekchat'])
  })

  it('边界：空串、纯分隔符', () => {
    expect(normalizeModelId('')).toBe('')
    expect(normalizeModelId('.-_')).toBe('')
  })
})

describe('parseOpenRouterModels', () => {
  it('正常解析：提取 id/context_length/pricing/canonical_slug/hugging_face_id/top_provider', () => {
    const text = JSON.stringify({
      data: [
        {
          id: 'qwen/qwen3.8-27b',
          name: 'Qwen: Qwen3.8 27B',
          context_length: 262144,
          canonical_slug: 'qwen/qwen3.8-27b-20260814',
          hugging_face_id: 'Qwen/Qwen3.8-27B',
          pricing: {prompt: '0.00000045', completion: '0.0000032'},
          top_provider: {context_length: 262144},
        },
      ],
    })
    const models = parseOpenRouterModels(text)
    expect(models).toHaveLength(1)
    expect(models[0]).toEqual({
      id: 'qwen/qwen3.8-27b',
      name: 'Qwen: Qwen3.8 27B',
      context_length: 262144,
      canonical_slug: 'qwen/qwen3.8-27b-20260814',
      hugging_face_id: 'Qwen/Qwen3.8-27B',
      pricing: {prompt: '0.00000045', completion: '0.0000032'},
      top_provider: {context_length: 262144},
    })
  })

  it('非法 JSON → []', () => {
    expect(parseOpenRouterModels('not json')).toEqual([])
  })

  it('data 缺失 → []', () => {
    expect(parseOpenRouterModels(JSON.stringify({object: 'list'}))).toEqual([])
  })

  it('data 非数组 → []', () => {
    expect(parseOpenRouterModels(JSON.stringify({data: 'oops'}))).toEqual([])
  })

  it('字段缺失不崩溃（无 context_length、无 pricing）', () => {
    const models = parseOpenRouterModels(JSON.stringify({data: [{id: 'foo/bar'}]}))
    expect(models).toHaveLength(1)
    expect(models[0].context_length).toBeUndefined()
    expect(models[0].pricing).toBeUndefined()
  })
})

describe('matchOpenRouterModel 规则链（独立命中）', () => {
  const models: OpenRouterModelRaw[] = [
    {id: 'openai/gpt-5', context_length: 400000},
    {id: 'deepseek/deepseek-chat', context_length: 163840},
    {id: 'meta-llama/llama-3.1-8b-instant'},
    {id: 'qwen/qwen2.5-72b-instruct', hugging_face_id: 'Qwen/Qwen2.5-72B-Instruct'},
    {id: 'anthropic/claude-opus-4-6-20260814', canonical_slug: 'anthropic/claude-opus-4.6'},
  ]

  it('hugging_face_id 精确命中 HF 格式', () => {
    const r = matchOpenRouterModel('Qwen/Qwen2.5-72B-Instruct', models)
    expect(r?.id).toBe('qwen/qwen2.5-72b-instruct')
  })

  it('canonical_slug 精确命中带日期版本', () => {
    const r = matchOpenRouterModel('anthropic/claude-opus-4.6', models)
    expect(r?.id).toBe('anthropic/claude-opus-4-6-20260814')
  })

  it('or.id 精确命中', () => {
    const r = matchOpenRouterModel('openai/gpt-5', models)
    expect(r?.id).toBe('openai/gpt-5')
  })

  it('slug model 段精确命中（queryId 无 provider 前缀）', () => {
    const r = matchOpenRouterModel('deepseek-chat', models)
    expect(r?.id).toBe('deepseek/deepseek-chat')
  })

  it('子串命中（Groq 专属 ID）', () => {
    const r = matchOpenRouterModel('llama-3.1-8b-instant', models)
    expect(r?.id).toBe('meta-llama/llama-3.1-8b-instant')
  })

  it('未命中 → null', () => {
    expect(matchOpenRouterModel('nonexistent-model-xyz', models)).toBeNull()
  })
})

describe('matchOpenRouterModel 优先级冲突', () => {
  it('slug model 段精确 优先于 子串', () => {
    const models: OpenRouterModelRaw[] = [
      {id: 'deepseek/deepseek-chat-v2'},
      {id: 'deepseek/deepseek-chat'},
    ]
    const r = matchOpenRouterModel('deepseek-chat', models)
    expect(r?.id).toBe('deepseek/deepseek-chat')
  })

  it('hugging_face_id 优先于 canonical_slug 与 or.id', () => {
    const models: OpenRouterModelRaw[] = [
      {id: 'a/b', hugging_face_id: 'Hf/Model', canonical_slug: 'a/canonical'},
    ]
    const r = matchOpenRouterModel('Hf/Model', models)
    expect(r?.id).toBe('a/b')
  })

  it('canonical_slug 优先于 or.id 精确', () => {
    const models: OpenRouterModelRaw[] = [
      {id: 'x/some-model', canonical_slug: 'x/canonical-slug'},
    ]
    const r = matchOpenRouterModel('x/canonical-slug', models)
    expect(r?.id).toBe('x/some-model')
  })
})

describe('parseOpenRouterModels — architecture 字段提取', () => {
  it('提取 architecture.input_modalities（deepseek-v4-flash-vision-exp 样例）', () => {
    const text = JSON.stringify({
      data: [{
        id: 'deepseek/deepseek-v4-flash-vision-exp',
        architecture: {modality: 'text+image->text', input_modalities: ['text', 'image'], output_modalities: ['text']},
      }],
    })
    const models = parseOpenRouterModels(text)
    expect(models[0].architecture?.input_modalities).toEqual(['text', 'image'])
    expect(models[0].architecture?.modality).toBe('text+image->text')
  })

  it('architecture 缺失 → 字段为 undefined，条目仍有效', () => {
    const text = JSON.stringify({data: [{id: 'x/y'}]})
    const models = parseOpenRouterModels(text)
    expect(models).toHaveLength(1)
    expect(models[0].architecture).toBeUndefined()
  })

  it('architecture 存在但 input_modalities 缺失 → undefined', () => {
    const text = JSON.stringify({data: [{id: 'x/y', architecture: {modality: 'text->text'}}]})
    const models = parseOpenRouterModels(text)
    expect(models[0].architecture?.input_modalities).toBeUndefined()
  })
})
