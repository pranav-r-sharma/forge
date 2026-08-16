import * as vscode from 'vscode';
import { ProviderCredentials } from './types';

const SECRET_PREFIX = 'forge.webSearchKey.';

/** Provider ids whose credentials are secrets (API keys) rather than plain settings. SearXNG's instance URL and DuckDuckGo (no credentials at all) are handled directly from forge.webSearch.* config instead — see extension.ts's credential-resolution closure. */
export const SECRET_BACKED_PROVIDERS = ['brave', 'tavily', 'google'] as const;
export type SecretBackedProviderId = (typeof SECRET_BACKED_PROVIDERS)[number];

/**
 * Stores web-search provider API keys via `vscode.SecretStorage` (OS
 * keychain-backed on every platform VS Code supports) instead of plain
 * `settings.json`, which is the correct way to hold credentials in a VS
 * Code extension — settings.json is plain text, commonly synced/backed up,
 * and easy to accidentally commit if a workspace ever stores settings in
 * the repo. Every other Forge setting is intentionally plain `forge.*`
 * config (simple, visible, diffable); API keys are the one deliberate
 * exception given what they are.
 */
export class WebSearchKeyStore {
  constructor(private secrets: vscode.SecretStorage) {}

  /** Google needs both an API key and a Search Engine ID (cx) — stored together as one JSON blob per provider so callers get a single ProviderCredentials object. */
  async get(providerId: string): Promise<ProviderCredentials> {
    if (!(SECRET_BACKED_PROVIDERS as readonly string[]).includes(providerId)) return {};
    const raw = await this.secrets.get(SECRET_PREFIX + providerId);
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  async set(providerId: SecretBackedProviderId, creds: ProviderCredentials): Promise<void> {
    await this.secrets.store(SECRET_PREFIX + providerId, JSON.stringify(creds));
  }

  async clear(providerId: SecretBackedProviderId): Promise<void> {
    await this.secrets.delete(SECRET_PREFIX + providerId);
  }
}
