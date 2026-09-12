import type { ProviderAdapter, ProviderName } from './types';
import { anthropicProvider } from './anthropic';
import { openaiProvider } from './openai';
import { deepseekProvider } from './deepseek';
import { geminiProvider } from './gemini';

const registry: Record<ProviderName, ProviderAdapter> = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  deepseek: deepseekProvider,
  gemini: geminiProvider,
};

export function getProvider(name: ProviderName): ProviderAdapter {
  return registry[name];
}

export function configuredProviders(): ProviderName[] {
  return (Object.keys(registry) as ProviderName[]).filter((name) => registry[name].isConfigured());
}

export * from './types';
export { anthropicProvider, openaiProvider, deepseekProvider, geminiProvider };
