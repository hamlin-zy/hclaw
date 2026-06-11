import {create} from 'zustand'
import {persist, type PersistStorage} from 'zustand/middleware'
import {sqliteStorage} from '../lib/sqliteStorage'
import {decryptSecret, encryptSecret} from '../lib/crypto'
import type {LLMProvider, ProviderCredentials, ProviderModel} from '@shared/types'

// Re-export for consumers
export type {LLMProvider, ProviderCredentials, ProviderModel}

/** @alias ProviderModel */
export type LLMModel = ProviderModel

interface LLMStore {
  providers: LLMProvider[];
  activeProviderId: string | null;
  activeModelId: string | null;
  hasRehydrated: boolean;

  // Actions
    addProvider: (provider: Omit<LLMProvider, 'id' | 'credentials'> & {
        credentials?: LLMProvider['credentials']
    }) => Promise<string>;
  updateProvider: (id: string, updates: Partial<LLMProvider>) => Promise<void>;
  removeProvider: (id: string) => void;
  addModel: (providerId: string, model: Omit<LLMModel, 'enabled'>) => void;
  updateModel: (providerId: string, modelId: string, updates: Partial<LLMModel>) => void;
  removeModel: (providerId: string, modelId: string) => void;
  setActiveProvider: (providerId: string) => void;
  setActiveModel: (modelId: string) => void;

  // Helpers
  getEnabledProviders: () => LLMProvider[];
  getActiveProvider: () => LLMProvider | null;
  getActiveModel: () => LLMModel | null;
  getDecryptedApiKey: (providerId: string) => Promise<string | null>;
    /** 获取所有解密后的 providers（主进程需要明文 API Key） */
    getAllDecryptedProviders: () => Promise<LLMProvider[]>;
}

// ─── Store 定义 ───────────────────────────────────────

export const useLLMStore = create<LLMStore>()(
  persist(
    (set, get) => ({
      providers: [],
      activeProviderId: null,
      activeModelId: null,
      hasRehydrated: false,

      addProvider: async (provider) => {
        const id = crypto.randomUUID();
          const models = provider.models || [];
          // 加密 apiKey
          let credentials = provider.credentials || {};
          if (credentials.apiKey) {
              credentials = {
                  ...credentials,
                  apiKey: await encryptSecret(credentials.apiKey),
              };
        }
        set((state) => ({
            providers: [...state.providers, {...provider, id, credentials, models}],
          // 自动激活新增的服务商
          activeProviderId: id,
          activeModelId: models[0]?.id || null,
        }));
        return id;
      },

      updateProvider: async (id, updates) => {
        let processed = { ...updates };
          // 加密 credentials 中的 apiKey
          if (updates.credentials?.apiKey) {
              processed.credentials = {
                  ...updates.credentials,
                  apiKey: await encryptSecret(updates.credentials.apiKey),
              };
        }
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === id ? { ...p, ...processed } : p
          ),
        }));
      },

      removeProvider: (id) => {
        set((state) => {
          const newProviders = state.providers.filter((p) => p.id !== id);
          return {
            providers: newProviders,
            activeProviderId: state.activeProviderId === id
              ? (newProviders[0]?.id || null)
              : state.activeProviderId,
          };
        });
      },

      addModel: (providerId, model) => {
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId
              ? { ...p, models: [...p.models, { ...model, enabled: true }] }
              : p
          ),
        }));
      },

      updateModel: (providerId, modelId, updates) => {
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId
              ? {
                  ...p,
                  models: p.models.map((m) =>
                    m.id === modelId ? { ...m, ...updates } : m
                  ),
                }
              : p
          ),
        }));
      },

      removeModel: (providerId, modelId) => {
        set((state) => ({
          providers: state.providers.map((p) =>
            p.id === providerId
              ? { ...p, models: p.models.filter((m) => m.id !== modelId) }
              : p
          ),
        }));
      },

      setActiveProvider: (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId);
        const enabledModel = provider?.models.find((m) => m.enabled);
        set({
          activeProviderId: providerId,
          activeModelId: enabledModel?.id || provider?.models[0]?.id || null,
        });
      },

      setActiveModel: (modelId) => {
        set({ activeModelId: modelId });
      },

      getEnabledProviders: () => {
        return get().providers.filter((p) => p.enabled && p.models.some((m) => m.enabled));
      },

      getActiveProvider: () => {
        const state = get();
        return state.providers.find((p) => p.id === state.activeProviderId) || null;
      },

      getActiveModel: () => {
        const state = get();
        const provider = state.providers.find((p) => p.id === state.activeProviderId);
        return provider?.models.find((m) => m.id === state.activeModelId) || null;
      },

      getDecryptedApiKey: async (providerId) => {
        const provider = get().providers.find((p) => p.id === providerId);
          if (!provider?.credentials?.apiKey) return null;
          try {
              return await decryptSecret(provider.credentials.apiKey);
          } catch {
              return null;
          }
      },

        getAllDecryptedProviders: async () => {
            const providers = get().providers;
            console.log('[llmStore] getAllDecryptedProviders 调用 - Providers数量:', providers.length);

            const result = await Promise.all(
                providers.map(async (provider) => {
                    let decryptedCredentials = {...provider.credentials};

                    console.log(`[llmStore] 处理 Provider: ${provider.name} (${provider.type}), authType: ${provider.authType}`);

                    // OAuth2 模式：token 已存储在 providers.credentials 中，直接使用
                    // 不再从 auth.json 读取（已废弃）

                    // 解密 apiKey
                    if (decryptedCredentials.apiKey) {
                        try {
                            decryptedCredentials.apiKey = await decryptSecret(decryptedCredentials.apiKey);
                            console.log(`[llmStore] API Key 解密成功: ${provider.name}`);
                        } catch (err) {
                            console.warn(`[llmStore] API Key 解密失败，使用原值: ${provider.name}`, err);
                        }
                    }

                    const resultApiKey = decryptedCredentials.apiKey || provider.apiKey || undefined;
                    console.log(`[llmStore] Provider ${provider.name} apiKey来源:`, resultApiKey ? `${resultApiKey.slice(0, 8)}...(${resultApiKey.length}字)` : 'undefined');
                    return {
                        ...provider,
                        credentials: decryptedCredentials,
                        apiKey: resultApiKey,
                    };
                })
            );

            console.log('[llmStore] getAllDecryptedProviders 完成, 返回数量:', result.length);
            return result;
        },
    }),
    {
      name: 'llm',
        storage: sqliteStorage as PersistStorage<LLMStore>,
        version: 1,
        onRehydrateStorage: () => (state) => {
            if (state) state.hasRehydrated = true
        },
    }
  )
);
