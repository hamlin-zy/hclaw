/**
 * Ollama 本地模型适配器
 *
 * Ollama 兼容 OpenAI API，因此直接复用 OpenAIAdapter。
 * 默认 baseUrl: http://localhost:11434/v1
 */

import {OpenAIAdapter} from './openaiAdapter'
import type {ModelConfig} from './types'
import type OpenAI from 'openai'

export class OllamaAdapter extends OpenAIAdapter {
    constructor(config: ModelConfig, injectedClient?: OpenAI) {
    super(
      {
        ...config,
        apiKey: config.apiKey || 'ollama', // Ollama 不需要真实 key
        baseUrl: config.baseUrl || 'http://localhost:11434/v1',
          _providerName: 'ollama',
      },
        injectedClient,
    )
  }
}
