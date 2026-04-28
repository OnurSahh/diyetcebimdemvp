export type AiProviderMode = 0 | 1;

export function getConfiguredAiProviderMode(): AiProviderMode {
  const raw = String(process.env.AI_PROVIDER_MODE ?? "0").trim();
  return raw === "1" ? 1 : 0;
}
