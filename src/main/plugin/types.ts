export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  author?: {
    name: string;
    email?: string;
    url?: string;
  };
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  dependencies?: string[];
  commands?: string | string[] | Record<string, string>;
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | string[] | Record<string, unknown>;
  mcpServers?: string | Record<string, unknown>;
  lspServers?: string | Record<string, unknown>;
  settings?: Record<string, unknown>;
  userConfig?: UserConfigSchema;
}

export interface UserConfigSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean';
    title?: string;
    description?: string;
    required?: boolean;
    sensitive?: boolean;
    default?: unknown;
    min?: number;
    max?: number;
  };
}

export type PluginSource =
  | { source: 'github'; repo: string; ref?: string }
  | { source: 'gitee'; repo: string; ref?: string }
  | { source: 'gitlab'; repo: string; ref?: string }
  | { source: 'url'; url: string; ref?: string }
  | { source: 'local'; path: string };

export interface LoadedPlugin {
  name: string;
  source: string;
  path: string;
  manifest: PluginManifest;
  enabled: boolean;
  isBuiltin: boolean;
  commands?: CommandDef[];
  skills?: SkillDefinition[];
  agents?: AgentDefinition[];
  hooks?: HookConfig[];
  mcpServers?: McpServerConfig[];
  userConfig?: UserConfigSchema;
}

export interface CommandDef {
  id: string;           // plugin:command
  name: string;
  description?: string;
  args?: ArgumentDef[];
  content: string;
  filePath: string;
}

export interface ArgumentDef {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  filePath: string;
  allowedTools?: string[];
  userInvocable?: boolean;
}

export interface AgentDefinition {
  name: string;
  description: string;
  filePath: string;
  type?: string;
}

export interface HookConfig {
  id?: string;
  name?: string;
  description?: string;
  events?: string[];
  type: 'command' | 'function' | 'prompt' | 'http' | 'agent';
  command?: string;
  handler?: (context: any) => any;  // function 类型 hook 的处理函数
  prompt?: string;
  url?: string;
  method?: 'GET' | 'POST' | 'PUT';
  headers?: Record<string, string>;
  body?: string;
  shell?: 'bash' | 'powershell';
  timeout?: number;
  once?: boolean;
  async?: boolean;
  matcher?: string;
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export type HookEvent =
  | 'SessionStart' | 'SessionEnd'
  | 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure'
  | 'Stop' | 'StopFailure'
  | 'SubagentStart' | 'SubagentStop'
  | 'PreCompact' | 'PostCompact'
  | 'UserPromptSubmit' | 'PermissionRequest'
  | 'Notification';

export type PluginError =
  | { type: 'git-clone-failed'; message: string }
  | { type: 'manifest-not-found'; path: string }
  | { type: 'manifest-invalid'; errors: string[] }
  | { type: 'plugin-not-found'; name: string }
  | { type: 'dependency-unsatisfied'; deps: string[] };
