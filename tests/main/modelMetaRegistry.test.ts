import {describe, expect, it, beforeEach, afterEach} from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {ModelMetaRegistry} from '@/main/modelMetaRegistry'

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-meta-test-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, {recursive: true, force: true})
})

/** 构造 OpenRouter 响应 JSON */
function orResponse(models: unknown[]): string {
  return JSON.stringify({data: models})
}

function okFetch(body: string): typeof fetch {
  const fn = (async () => ({
    ok: true,
    status: 200,
    text: async () => body,
  })) as unknown as typeof fetch
  return fn
}

describe('ModelMetaRegistry', () => {
  it('refresh 成功：getMeta 命中（含价格字符串转数字 + top_provider 兜底）', async () => {
    const fetchFn = okFetch(orResponse([
      {
        id: 'deepseek/deepseek-chat',
        context_length: 163840,
        pricing: {prompt: '0.00000014', completion: '0.00000028', input_cache_read: '0.000000028'},
      },
      {id: 'qwen/qwen2.5', top_provider: {context_length: 262144}},
    ])) as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()

    const meta = reg.getMeta('deepseek-chat')
    expect(meta.contextLength).toBe(163840)
    expect(meta.inputPrice).toBe(0.00000014)
    expect(meta.outputPrice).toBe(0.00000028)
    expect(meta.cacheReadPrice).toBe(0.000000028)

    // context_length 缺失 + top_provider.context_length 兜底
    expect(reg.getContextLength('qwen/qwen2.5')).toBe(262144)
  })

  it('价格非法字符串 → 0', async () => {
    const fetchFn = okFetch(orResponse([
      {id: 'x/y', context_length: 1000, pricing: {prompt: 'abc', completion: 0.1}},
    ])) as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()

    const meta = reg.getMeta('x/y')
    expect(meta.inputPrice).toBe(0)
    expect(meta.outputPrice).toBe(0.1)
  })

  it('未命中 → 全 0', async () => {
    const fetchFn = okFetch(orResponse([{id: 'a/b', context_length: 100}])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()

    const meta = reg.getMeta('nonexistent')
    expect(meta).toEqual({contextLength: 0, inputPrice: 0, outputPrice: 0, cacheReadPrice: 0})
  })

  it('refresh 失败保留旧数据', async () => {
    // 第一次成功
    let fail = false
    const fetchFn = (async () => {
      if (fail) throw new Error('network down')
      return {ok: true, status: 200, text: async () => orResponse([{id: 'a/b', context_length: 100}])}
    }) as unknown as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getContextLength('a/b')).toBe(100)

    // 第二次失败：保留旧数据
    fail = true
    await reg.refresh()
    expect(reg.getContextLength('a/b')).toBe(100)
  })

  it('无缓存 + 首次 refresh 失败 → 返回 0', async () => {
    const fetchFn = (async () => { throw new Error('network down') }) as unknown as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.init()
    expect(reg.getContextLength('a/b')).toBe(0)
  })

  it('init 读缓存文件立即生效', async () => {
    // 预写缓存文件
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(
      path.join(tmpDir, 'or-models.json'),
      JSON.stringify({fetchedAt: Date.now(), models: [{id: 'cached/model', context_length: 999}]}),
    )

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn: (async () => {
      throw new Error('should not reach fetch during cache-only check')
    }) as unknown as typeof fetch})

    // 直接读缓存（不触发 refresh）
    await reg.init()
    // 注意：init 会后台 refresh（mock fetch 抛错），但缓存已加载，应仍可查
    expect(reg.getContextLength('cached/model')).toBe(999)
  })

  it('init 缓存含缺 id 的坏条目 → 跳过坏条目且正常条目可查', async () => {
    // 合法 JSON，但 models 数组里有一条缺 id 的坏数据
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(
      path.join(tmpDir, 'or-models.json'),
      JSON.stringify({fetchedAt: Date.now(), models: [{id: 'ok/model', context_length: 5}, {context_length: 9}]}),
    )

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn: (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch})

    await reg.init()
    // 不崩溃，且正常条目仍可命中
    expect(reg.getContextLength('ok/model')).toBe(5)
    // 缺 id 的坏条目被跳过，不影响其它条目
    expect(reg.getMeta('nonexistent')).toEqual({contextLength: 0, inputPrice: 0, outputPrice: 0, cacheReadPrice: 0})
  })

  it('init 缓存含合法 id 但可选字段非字符串 → 查询不抛错且返回全 0', async () => {
    // hugging_face_id 为数字：matchOpenRouterModel 的 typeof 守卫必须拦下，否则 normalizeModelId 抛 TypeError
    fs.mkdirSync(tmpDir, {recursive: true})
    fs.writeFileSync(
      path.join(tmpDir, 'or-models.json'),
      JSON.stringify({fetchedAt: Date.now(), models: [{id: 'x/y', hugging_face_id: 123}]}),
    )

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn: (async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch})

    await reg.init()
    expect(() => reg.getMeta('some-query')).not.toThrow()
    expect(reg.getMeta('some-query')).toEqual({contextLength: 0, inputPrice: 0, outputPrice: 0, cacheReadPrice: 0})
  })

  it('refresh 成功写盘', async () => {
    const fetchFn = okFetch(orResponse([{id: 'a/b', context_length: 123}])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()

    const cacheFile = path.join(tmpDir, 'or-models.json')
    expect(fs.existsSync(cacheFile)).toBe(true)
    const parsed = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    expect(parsed.models).toHaveLength(1)
    expect(parsed.models[0].id).toBe('a/b')
  })

  it('refresh 防并发：连续两次只发一次网络请求', async () => {
    let callCount = 0
    const fetchFn = (async () => {
      callCount++
      await new Promise(r => setTimeout(r, 20))
      return {ok: true, status: 200, text: async () => orResponse([{id: 'a/b', context_length: 1}])}
    }) as unknown as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await Promise.all([reg.refresh(), reg.refresh()])
    expect(callCount).toBe(1)
  })

  it('ensureLoaded：空表时触发 refresh 并加载数据', async () => {
    let callCount = 0
    const fetchFn = (async () => {
      callCount++
      return {ok: true, status: 200, text: async () => orResponse([{id: 'a/b', context_length: 100}])}
    }) as unknown as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.ensureLoaded()
    expect(callCount).toBe(1)
    expect(reg.getContextLength('a/b')).toBe(100)
  })

  it('ensureLoaded：有数据时不触发额外 fetch', async () => {
    let callCount = 0
    const fetchFn = (async () => {
      callCount++
      return {ok: true, status: 200, text: async () => orResponse([{id: 'a/b', context_length: 100}])}
    }) as unknown as typeof fetch

    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()  // 第一次 fetch 加载数据
    expect(callCount).toBe(1)
    await reg.ensureLoaded()  // 已有数据，不再 fetch
    expect(callCount).toBe(1)
  })
})

describe('getInputModalities', () => {
  it('命中：architecture.input_modalities=["text","image"] → 返回数组', async () => {
    const fetchFn = okFetch(orResponse([
      {id: 'deepseek/deepseek-v4-flash-vision-exp', architecture: {input_modalities: ['text', 'image']}},
    ])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getInputModalities('deepseek-v4-flash-vision-exp')).toEqual(['text', 'image'])
  })

  it('命中但无 architecture → null（触发回退）', async () => {
    const fetchFn = okFetch(orResponse([{id: 'x/y'}])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getInputModalities('x/y')).toBeNull()
  })

  it('命中但 input_modalities 非数组（脏数据） → null', async () => {
    const fetchFn = okFetch(orResponse([
      {id: 'x/y', architecture: {input_modalities: 'image' as unknown as string[]}},
    ])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getInputModalities('x/y')).toBeNull()
  })

  it('未匹配（模型不在清单） → null', async () => {
    const fetchFn = okFetch(orResponse([{id: 'x/y'}])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getInputModalities('nonexistent/model')).toBeNull()
  })

  it('归一化匹配：直连 id 无 provider 前缀也能命中', async () => {
    const fetchFn = okFetch(orResponse([
      {id: 'deepseek/deepseek-v4-flash-vision-exp', architecture: {input_modalities: ['text', 'image']}},
    ])) as typeof fetch
    const reg = new ModelMetaRegistry({cacheDir: tmpDir, fetchFn})
    await reg.refresh()
    expect(reg.getInputModalities('DeepSeek.V4.Flash.Vision.Exp')).toEqual(['text', 'image'])
  })
})
