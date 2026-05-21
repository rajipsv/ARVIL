/**
 * Optional LLM pass to refine root-cause groups (NVIDIA NIM or OpenAI).
 */

import type { RootCauseGroup } from "./types";

const NVIDIA_BASE = "https://integrate.api.nvidia.com/v1";
const OPENAI_BASE = "https://api.openai.com/v1";
const LLM_TIMEOUT_MS = 28_000;

function pickProvider(): "nvidia" | "openai" | null {
  if (process.env.NVIDIA_API_KEY?.trim()) return "nvidia";
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return null;
}

function parseLlmJson(raw: string): {
  narrative?: string;
  root_causes?: Array<Record<string, unknown>>;
} {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text) as {
    narrative?: string;
    root_causes?: Array<Record<string, unknown>>;
  };
}

async function chatJson(
  provider: "nvidia" | "openai",
  system: string,
  user: string
): Promise<string> {
  const key =
    provider === "nvidia"
      ? process.env.NVIDIA_API_KEY!
      : process.env.OPENAI_API_KEY!;
  const base = provider === "nvidia" ? NVIDIA_BASE : OPENAI_BASE;
  const model =
    provider === "nvidia"
      ? process.env.NVIDIA_MODEL?.trim() || "meta/llama-3.1-70b-instruct"
      : process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

  const body: Record<string, unknown> = {
    model,
    temperature: 0.2,
    max_tokens: 2048,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
  if (provider === "openai") {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM ${provider} ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!content) throw new Error("LLM returned empty content");
  return content;
}

export interface LlmGroupResult {
  groups: RootCauseGroup[];
  narrative: string;
  provider: "nvidia" | "openai";
}

export async function refineRootCausesWithLlm(
  logSnippet: string,
  ruleGroups: RootCauseGroup[]
): Promise<LlmGroupResult | null> {
  const provider = pickProvider();
  if (!provider) return null;
  if (ruleGroups.length === 0) return null;

  const system = `You are ARVIL, a CI log triage assistant for ROCm/TheRock.
Return a single JSON object only (no markdown), shape:
{"narrative":"2-4 sentences","root_causes":[{"id":"rc-1","primary_line":158,"primary_message":"full log line","severity":"HIGH","category":"Configuration","recommendation":"action","one_line_summary":"short title","related_lines":[{"line_number":157,"message":"...","role":"stack"}]}]}
Merge duplicate causes. Do not treat ##[error] exit code lines as separate root causes.`;

  const user = JSON.stringify({
    rule_groups: ruleGroups,
    log_excerpt: logSnippet.slice(0, 12000),
  });

  let raw: string;
  try {
    raw = await chatJson(provider, system, user);
  } catch (e) {
    console.error("[ARVIL] LLM chat failed:", provider, e);
    throw e;
  }

  let parsed: ReturnType<typeof parseLlmJson>;
  try {
    parsed = parseLlmJson(raw);
  } catch (e) {
    console.error("[ARVIL] LLM JSON parse failed:", provider, e);
    throw new Error("LLM returned non-JSON response");
  }

  const merged: RootCauseGroup[] = (parsed.root_causes ?? []).map((rc, i) => ({
    id: String(rc.id ?? `rc-${i + 1}`),
    primary_line: Number(rc.primary_line ?? ruleGroups[i]?.primary_line ?? 0),
    primary_message: String(
      rc.primary_message ?? ruleGroups[i]?.primary_message ?? ""
    ),
    severity: String(rc.severity ?? ruleGroups[i]?.severity ?? "HIGH"),
    category: String(rc.category ?? ruleGroups[i]?.category ?? "Runtime"),
    recommendation: String(
      rc.recommendation ?? ruleGroups[i]?.recommendation ?? ""
    ),
    kb_pattern_id: ruleGroups[i]?.kb_pattern_id ?? null,
    type: ruleGroups[i]?.type ?? "ERROR",
    one_line_summary: rc.one_line_summary
      ? String(rc.one_line_summary)
      : undefined,
    related_lines: Array.isArray(rc.related_lines)
      ? (rc.related_lines as RootCauseGroup["related_lines"])
      : ruleGroups[i]?.related_lines ?? [],
  }));

  const valid = merged.filter((g) => g.primary_message.trim().length > 10);

  return {
    groups: valid.length > 0 ? valid : ruleGroups,
    narrative: String(parsed.narrative ?? "").trim(),
    provider,
  };
}
