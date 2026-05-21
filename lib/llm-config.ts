/** LLM env diagnostics (no secret values). */

export function getLlmDiag() {
  const nvidia = Boolean(process.env.NVIDIA_API_KEY?.trim());
  const openai = Boolean(process.env.OPENAI_API_KEY?.trim());
  return {
    nvidia_api_key_set: nvidia,
    openai_api_key_set: openai,
    llm_ready: nvidia || openai,
    preferred_provider: nvidia ? "nvidia" : openai ? "openai" : null,
    nvidia_model:
      process.env.NVIDIA_MODEL?.trim() || "meta/llama-3.1-70b-instruct",
    vercel_env: process.env.VERCEL_ENV ?? null,
    hint: !nvidia && !openai
      ? "Add NVIDIA_API_KEY (or OPENAI_API_KEY) in Vercel → Settings → Environment Variables, then redeploy."
      : undefined,
  };
}
