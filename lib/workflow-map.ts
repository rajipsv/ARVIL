import type { WorkflowPreset } from "./types";

/** Main TheRock categories shown in the UI (excludes "All workflows"). */
export const CATEGORY_PRESETS: WorkflowPreset[] = [
  "therock_multi_arch",
  "therock_pytorch",
  "therock_install",
  "therock_unit_tests",
];

/** User-facing labels (matches analyzer WORKFLOW_HINTS). */
export const PRESET_LABELS: Record<WorkflowPreset, string> = {
  therock_multi_arch: "Multi-Arch CI",
  therock_install: "Native Package Install",
  therock_pytorch: "PyTorch Wheels",
  therock_unit_tests: "Unit Tests / ctest",
  custom: "All workflows",
};

/**
 * Classify a TheRock workflow run/workflow file name into a preset.
 * Uses both display name and workflow path when available.
 */
export function workflowNameToPreset(name: string, path?: string): WorkflowPreset {
  const n = `${name} ${path ?? ""}`.toLowerCase();

  if (n.includes("pytorch") || n.includes("wheel")) return "therock_pytorch";
  if (
    n.includes("multi-arch") ||
    n.includes("multi_arch") ||
    n.includes("multiarch") ||
    (n.includes("asan") && !n.includes("pytorch"))
  ) {
    return "therock_multi_arch";
  }
  if (
    n.includes("unit test") ||
    n.includes("unit_test") ||
    n.includes("ctest") ||
    n.includes("test_component") ||
    n.includes("component.yml")
  ) {
    return "therock_unit_tests";
  }
  if (
    n.includes("install") ||
    n.includes("native linux") ||
    n.includes("native_linux") ||
    n.includes("package install") ||
    n.includes("dpkg") ||
    n.includes("rpm")
  ) {
    return "therock_install";
  }
  if (n.includes("test_artifacts") || n.includes("test artifacts")) {
    if (n.includes("pytorch") || n.includes("wheel") || n.includes("torch"))
      return "therock_pytorch";
    if (
      n.includes("multi-arch") ||
      n.includes("multi_arch") ||
      n.includes("asan") ||
      n.includes("gfx")
    ) {
      return "therock_multi_arch";
    }
  }
  return "custom";
}

/** Whether a GitHub workflow run belongs to the selected UI preset. */
export function presetMatchesWorkflowName(
  preset: WorkflowPreset,
  workflowName: string,
  workflowPath?: string
): boolean {
  if (preset === "custom") return true;
  return workflowNameToPreset(workflowName, workflowPath) === preset;
}

/**
 * Bucket a CI run for executive charts — prefer stored preset, else infer from
 * workflow/job names (same rules as the engineer log list).
 */
export function resolveRunPreset(
  stored: string | null | undefined,
  workflowName: string,
  jobName?: string | null
): WorkflowPreset {
  if (
    stored &&
    (CATEGORY_PRESETS as readonly string[]).includes(stored)
  ) {
    return stored as WorkflowPreset;
  }
  const hint = `${workflowName} ${jobName ?? ""}`.trim();
  return workflowNameToPreset(hint || "unknown");
}
