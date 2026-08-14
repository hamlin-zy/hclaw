import {describe, expect, it} from 'vitest'
import {GOOGLE_BASE_URL, PROVIDER_PRESETS, presetModelsFor, recognizeProvider} from '@shared/modelPresets'
import {buildAnthropicFallbackRequest, buildModelsRequest, classifyFetchError, inferModelType, parseModelsResponse} from '@shared/modelPresets'

describe('recognizeProvider', () => {
  it('识别 DeepSeek 域名', () => {
    expect(recognizeProvider('https://api.deepseek.com/v1')?.name).toBe('DeepSeek')
  })
  it('识别 OpenRouter', () => {
    expect(recognizeProvider('https://openrouter.ai/api/v1')?.name).toBe('OpenRouter')
  })
  it('识别 Ollama localhost（hostname 不含端口）', () => {
    expect(recognizeProvider('http://localhost:11434')?.name).toBe('Ollama')
  })
  it('大小写不敏感', () => {
    expect(recognizeProvider('HTTPS://API.DEEPSEEK.COM/V1')?.name).toBe('DeepSeek')
  })
  it('尾斜杠不影响识别', () => {
    expect(recognizeProvider('https://api.deepseek.com/v1/')?.name).toBe('DeepSeek')
  })
  it('无协议无法解析 → 不命中', () => {
    expect(recognizeProvider('api.deepseek.com/v1')).toBeNull()
  })
  it('IP 地址不命中', () => {
    expect(recognizeProvider('http://192.168.1.100:8080')).toBeNull()
  })
  it('子域名命中 x.ai', () => {
    expect(recognizeProvider('http://sub.x.ai')).not.toBeNull()
  })
  it('空值不命中', () => {
    expect(recognizeProvider('')).toBeNull()
    expect(recognizeProvider('   ')).toBeNull()
  })
  it('maas workspace 域识别为百炼但不补全 baseUrl', () => {
    const p = recognizeProvider('https://llm-abc.cn-beijing.maas.aliyuncs.com/compatible-mode/v1')
    expect(p?.name).toBe('阿里百炼')
    expect(p?.baseUrl).toBeUndefined()
  })
})

describe('presetModelsFor', () => {
  it('使用服务商自己的预设', () => {
    const p = recognizeProvider('https://api.deepseek.com/v1')!
    expect(presetModelsFor(p, 'openai')).toContain('deepseek-v4-pro')
  })
  it('服务商无预设时回退类型默认', () => {
    const p = recognizeProvider('https://openrouter.ai/api/v1')!
    expect(presetModelsFor(p, 'openai')).toContain('gpt-4o')
  })
  it('ollama 无预设', () => {
    const p = recognizeProvider('http://localhost:11434')!
    expect(presetModelsFor(p, 'ollama')).toEqual([])
  })
})

describe('inferModelType', () => {
  it('文本模型 → text', () => expect(inferModelType('gpt-4o')).toBe('text'))
  it('图像模型 → image', () => {
    expect(inferModelType('dall-e-3')).toBe('image')
    expect(inferModelType('qwen-image-3.0')).toBe('image')
  })
  it('视频模型 → video', () => expect(inferModelType('sora-2')).toBe('video'))
  it('语音模型 → voice', () => {
    expect(inferModelType('whisper-1')).toBe('voice')
    expect(inferModelType('qwen-audio-3.0-asr-flash')).toBe('voice')
  })
  it('向量模型 → embedding', () => expect(inferModelType('doubao-embedding-text-240515')).toBe('embedding'))
  it('音乐模型 → music', () => expect(inferModelType('suno-v4')).toBe('music'))
  it('未知 → text', () => expect(inferModelType('random-model-xyz')).toBe('text'))
})

describe('buildModelsRequest', () => {
  it('openai 追加 /models + Bearer', () => {
    const r = buildModelsRequest({type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k'})
    expect(r.url).toBe('https://api.deepseek.com/v1/models')
    expect(r.headers.Authorization).toBe('Bearer k')
  })
  it('anthropic 无 /v1 自动补', () => {
    const r = buildModelsRequest({type: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', apiKey: 'k'})
    expect(r.url).toBe('https://api.minimaxi.com/anthropic/v1/models')
    expect(r.headers['x-api-key']).toBe('k')
    expect(r.headers['anthropic-version']).toBe('2023-06-01')
  })
  it('anthropic 已含 /v1 不重复', () => {
    const r = buildModelsRequest({type: 'anthropic', baseUrl: 'https://x.com/v1', apiKey: 'k'})
    expect(r.url).toBe('https://x.com/v1/models')
  })
  it('google api-key 用固定端点 + x-goog-api-key', () => {
    const r = buildModelsRequest({type: 'google', baseUrl: '', apiKey: 'k'})
    expect(r.url).toBe(`${GOOGLE_BASE_URL}/models`)
    expect(r.headers['x-goog-api-key']).toBe('k')
  })
  it('google oauth2 用 Bearer', () => {
    const r = buildModelsRequest({type: 'google', authType: 'google-oauth2', accessToken: 'tok'})
    expect(r.headers.Authorization).toBe('Bearer tok')
  })
  it('ollama 用 /api/tags', () => {
    const r = buildModelsRequest({type: 'ollama', baseUrl: 'http://localhost:11434'})
    expect(r.url).toBe('http://localhost:11434/api/tags')
  })
  it('尾部斜杠去重', () => {
    const r = buildModelsRequest({type: 'openai', baseUrl: 'https://api.deepseek.com/v1/', apiKey: 'k'})
    expect(r.url).toBe('https://api.deepseek.com/v1/models')
  })
})

describe('buildAnthropicFallbackRequest', () => {
  it('去掉 /anthropic 后缀并切 Bearer', () => {
    const r = buildAnthropicFallbackRequest('https://api.deepseek.com/anthropic', 'k')!
    expect(r.url).toBe('https://api.deepseek.com/models')
    expect(r.headers.Authorization).toBe('Bearer k')
  })
  it('尾斜杠也能回退', () => {
    const r = buildAnthropicFallbackRequest('https://api.deepseek.com/anthropic/', 'k')!
    expect(r.url).toBe('https://api.deepseek.com/models')
  })
  it('无 /anthropic 后缀 → null', () => {
    expect(buildAnthropicFallbackRequest('https://api.anthropic.com', 'k')).toBeNull()
  })
})

describe('parseModelsResponse', () => {
  it('OpenAI 格式 data[].id', () => {
    expect(parseModelsResponse('openai', '{"data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}')).toEqual(['gpt-4o', 'gpt-4o-mini'])
  })
  it('Anthropic 格式 data[].id', () => {
    expect(parseModelsResponse('anthropic', '{"data":[{"id":"claude-sonnet-4-20250514","display_name":"Claude Sonnet 4"}]}')).toEqual(['claude-sonnet-4-20250514'])
  })
  it('Google 格式 models[].name 去前缀', () => {
    expect(parseModelsResponse('google', '{"models":[{"name":"models/gemini-2.5-pro"}]}')).toEqual(['gemini-2.5-pro'])
  })
  it('Ollama 格式 models[].name', () => {
    expect(parseModelsResponse('ollama', '{"models":[{"name":"llama3:latest"}]}')).toEqual(['llama3:latest'])
  })
  it('缺 id 的元素被过滤 → 空数组', () => {
    expect(parseModelsResponse('openai', '{"data":[{}]}')).toEqual([])
  })
  it('数字 id 转字符串', () => {
    expect(parseModelsResponse('openai', '{"data":[{"id":123}]}')).toEqual(['123'])
  })
  it('非 JSON → null', () => {
    expect(parseModelsResponse('openai', '<html>login</html>')).toBeNull()
  })
  it('JSON null → null 且不抛错', () => {
    expect(parseModelsResponse('openai', 'null')).toBeNull()
  })
  it('空数组 → []（与解析失败区分）', () => {
    expect(parseModelsResponse('openai', '[]')).toEqual([])
  })
})

describe('classifyFetchError', () => {
  it('401 → auth', () => expect(classifyFetchError(401, '', 'openai')).toBe('auth'))
  it('403 → auth', () => expect(classifyFetchError(403, '', 'openai')).toBe('auth'))
  it('Google 400 无效 key → auth', () => expect(classifyFetchError(400, 'API key not valid. Please pass a valid API key.', 'google')).toBe('auth'))
  it('普通 400 → parse', () => expect(classifyFetchError(400, 'bad request', 'openai')).toBe('parse'))
  it('404 → unsupported', () => expect(classifyFetchError(404, '', 'anthropic')).toBe('unsupported'))
  it('500 → server', () => expect(classifyFetchError(500, '', 'openai')).toBe('server'))
  it('200 → null', () => expect(classifyFetchError(200, '{}', 'openai')).toBeNull())
})

import {validateBaseUrl} from '@shared/modelPresets'

describe('validateBaseUrl', () => {
  it('openai 非 /v1 结尾 → warn', () => {
    expect(validateBaseUrl('openai', 'https://api.deepseek.com').level).toBe('warn')
  })
  it('openai /v1 结尾 → ok', () => {
    expect(validateBaseUrl('openai', 'https://api.deepseek.com/v1').level).toBe('ok')
  })
  it('anthropic /v1 结尾 → error', () => {
    expect(validateBaseUrl('anthropic', 'https://api.minimaxi.com/anthropic/v1').level).toBe('error')
  })
  it('anthropic 官方地址 → ok 无警告', () => {
    expect(validateBaseUrl('anthropic', 'https://api.anthropic.com').level).toBe('ok')
  })
  it('anthropic 中转地址 → ok', () => {
    expect(validateBaseUrl('anthropic', 'https://api.minimaxi.com/anthropic').level).toBe('ok')
  })
  it('openai 官方地址 → ok', () => {
    expect(validateBaseUrl('openai', 'https://api.openai.com/v1').level).toBe('ok')
  })
  it('google → ok', () => expect(validateBaseUrl('google', '').level).toBe('ok'))
  it('ollama → ok', () => expect(validateBaseUrl('ollama', 'http://localhost:11434').level).toBe('ok'))
  it('空值 → ok', () => expect(validateBaseUrl('openai', '').level).toBe('ok'))
  it('无协议无法解析 → ok 无警告', () => expect(validateBaseUrl('openai', 'api.deepseek.com').level).toBe('ok'))
})
