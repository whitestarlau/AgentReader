export * from "./providers/openai-compatible.ts";
export * from "./types.ts";

import type { Model, Provider } from "./types.ts";

const registry = new Map<string, Provider>();

export function registerProvider(provider: Provider) {
	registry.set(provider.name, provider);
}

export function getProvider(name: string): Provider | undefined {
	return registry.get(name);
}

export function listModels(): Model[] {
	return [...registry.values()].flatMap((p) => p.models);
}

export function listProviders(): string[] {
	return [...registry.keys()];
}
