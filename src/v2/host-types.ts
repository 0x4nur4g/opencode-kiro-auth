/**
 * Ambient host-surface types for the OpenCode V2 (2.0.x) plugin contract.
 *
 * Hand-written from runtime-verified evidence on opencode v2.0.6 — see
 * docs/opencode-v2-plugin-auth-and-aisdk-surfaces-2.0.6.md in the workspace.
 * Only the surfaces this plugin consumes are typed. No `@opencode/*` runtime
 * imports; the plugin stays dependency-free against host types.
 */

export type FormFieldValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormFieldValue>

export interface FormField {
  key: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external'
  title?: string
  description?: string
  required?: boolean
  when?: Array<{ key: string; op: 'eq' | 'neq'; value: string | number | boolean }>
  placeholder?: string
  format?: 'email' | 'uri' | 'date' | 'date-time'
  minLength?: number
  maxLength?: number
  pattern?: string
  default?: FormFieldValue
  options?: Array<{ value: string; label: string; description?: string }>
  minimum?: number
  maximum?: number
  minItems?: number
  maxItems?: number
  custom?: boolean
  url?: string
}

export interface CredentialOAuth {
  type: 'oauth'
  methodID: string
  refresh: string
  access: string
  expires: number
  metadata?: Record<string, unknown>
}

export type ConnectionInfo =
  | { type: 'credential'; id: string; label: string }
  | { type: 'env'; name: string }

export type IntegrationOAuthAuthorization =
  | {
      url: string
      instructions: string
      expiresAt?: number
      mode: 'auto'
      callback: () => Promise<CredentialOAuth>
    }
  | {
      url: string
      instructions: string
      expiresAt?: number
      mode: 'code'
      callback: (code: string) => Promise<CredentialOAuth>
    }

export interface IntegrationOAuthMethodRegistration {
  integrationID: string
  method: { id: string; type: 'oauth'; label: string; form?: FormField[] }
  authorize: (answer: FormAnswer) => Promise<IntegrationOAuthAuthorization>
  refresh?: (credential: CredentialOAuth) => Promise<CredentialOAuth>
  label?: (credential: CredentialOAuth) => string | undefined
}

export interface IntegrationRef {
  id: string
  name: string
}

export interface IntegrationEditor {
  list(): readonly IntegrationRef[]
  get(id: string): IntegrationRef | undefined
  update(id: string, update: (integration: IntegrationRef) => void): void
  remove(id: string): void
  method: {
    list(integrationID: string): unknown[]
    update(input: IntegrationOAuthMethodRegistration): void
    remove(integrationID: string, method: unknown): void
  }
}

export interface ModelInfoDraft {
  id: string
  modelID?: string
  providerID: string
  name: string
  status?: 'active' | 'beta' | 'alpha' | 'deprecated'
  enabled?: boolean
  capabilities?: { tools: boolean; input: string[]; output: string[] }
  limit?: { context: number; output: number; input?: number }
  variants?: Array<{ id: string; settings?: Record<string, unknown> }>
  time?: { released: number }
  cost?: Array<Record<string, unknown>>
  settings?: Record<string, unknown>
  package?: string
  family?: string
  /**
   * V2 wire-compatibility knobs. `reasoningField` is the V2 replacement for the
   * V1 `interleaved.field` (see the runtime schema `ReasoningField`).
   */
  compatibility?: {
    reasoningField?: string
    requireReasoning?: boolean
    maxTokensField?: 'max_completion_tokens' | 'max_tokens'
    requireFinishReason?: boolean
    requireAssistantAfterTool?: boolean
    supportsPromptCacheKey?: boolean
  }
}

export interface ProviderInfoDraft {
  id: string
  name: string
  activation: 'auto' | 'enabled' | 'disabled'
  package: string
  settings?: Record<string, unknown>
  headers?: Record<string, string>
  integrationID?: string
  transport?: 'http' | 'websocket'
}

export interface ModelEditor {
  list(providerID?: string): unknown[]
  get(providerID: string, modelID: string): unknown
  update(providerID: string, modelID: string, update: (model: ModelInfoDraft) => void): void
  remove(providerID: string, modelID: string): void
  default: {
    get(): { providerID: string; modelID: string } | undefined
    set(providerID: string, modelID: string): void
  }
  provider: { list(): unknown[]; get(providerID: string): unknown }
}

export interface ToolDraft {
  name: string
  description: string
  input?: unknown
  execute: (input: unknown, context: unknown) => Promise<unknown>
}

export interface ToolEditor {
  list(): unknown[]
  get(id: string): unknown
  namespace(namespace: unknown): void
  add(tool: ToolDraft): void
  update(id: string, update: (tool: ToolDraft) => void): void
  remove(id: string): void
}

export interface Registration {
  dispose(): Promise<void> | void
}

export interface PluginContext {
  location: { directory: string }
  options: Record<string, unknown>
  provider: {
    transform(callback: (draft: ProviderEditor) => void): Promise<Registration>
    reload?(): Promise<void>
  }
  model: {
    transform(callback: (draft: ModelEditor) => void): Promise<Registration>
    reload?(): Promise<void>
  }
  tool: { transform(callback: (draft: ToolEditor) => void): Promise<Registration> }
  integration: {
    transform(callback: (editor: IntegrationEditor) => void): Promise<Registration>
    reload?(): Promise<void>
    connection?: {
      active(integrationID: string): Promise<ConnectionInfo | undefined>
      resolve(
        connection: ConnectionInfo
      ): Promise<CredentialOAuth | { type: 'key'; key: string } | undefined>
    }
    oauth?: {
      connect(input: {
        integrationID: string
        methodID: string
        answer?: FormAnswer
      }): Promise<unknown>
    }
  }
  session?: {
    synthetic(input: { sessionID: string; text: string; description?: string }): Promise<unknown>
  }
}

export interface PluginDefinition {
  id: string
  setup(context: PluginContext): Promise<void | (() => void | Promise<void>)> | void
}

export interface ProviderEditor {
  list(): unknown[]
  get(id: string): unknown
  add(input: {
    info: ProviderInfoDraft
    models: ModelInfoDraft[]
    sourceConnection?: ConnectionInfo
  }): void
  update(id: string, update: (provider: ProviderInfoDraft) => void): void
  remove(id: string): void
  models: {
    set(providerID: string, models: ModelInfoDraft[]): void
    update(providerID: string, modelID: string, update: (model: ModelInfoDraft) => void): void
    remove(providerID: string, modelID: string): void
  }
}
