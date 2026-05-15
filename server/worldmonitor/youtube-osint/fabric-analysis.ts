export interface FabricResult {
  pattern: string;
  summary: string;
  events: string[];
}

/**
 * Run one or more Fabric/Ollama patterns against a text corpus.
 *
 * Falls back gracefully when Fabric/Ollama is unavailable — patterns that
 * fail are silently skipped so the rest of the pipeline can continue.
 *
 * Environment variables:
 *   FABRIC_API_URL  — Fabric REST endpoint (default: Ollama local)
 *   OLLAMA_URL      — Ollama endpoint (fallback)
 *   FABRIC_MODEL    — Model name (default: llama3)
 */
export async function analyzeWithFabric(
  text: string,
  patterns: string[] = [
    'extract_wisdom',
    'summarize',
    'extract_extraordinary_claims',
  ],
): Promise<FabricResult[]> {
  const apiUrl =
    process.env.FABRIC_API_URL ??
    process.env.OLLAMA_URL ??
    'http://localhost:11434';
  const model = process.env.FABRIC_MODEL ?? 'llama3';
  const results: FabricResult[] = [];

  for (const pattern of patterns) {
    try {
      const res = await fetch(`${apiUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt: `${pattern}:\n\n${text.slice(0, 8000)}`,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as { response: string };
      results.push({ pattern, summary: data.response, events: [] });
    } catch {
      // Fabric/Ollama unavailable — skip pattern
    }
  }

  return results;
}
