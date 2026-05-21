import type { WorkflowPreset } from "./types";

/** Map TheRock workflow display name to analyzer preset. */
export function workflowNameToPreset(name: string): WorkflowPreset {
  const n = name.toLowerCase();
  if (n.includes("multi-arch") && n.includes("asan")) return "therock_multi_arch";
  if (n.includes("multi-arch")) return "therock_multi_arch";
  if (n.includes("pytorch") || n.includes("wheel")) return "therock_pytorch";
  if (n.includes("unit test") || n.includes("ctest")) return "therock_unit_tests";
  if (n.includes("install") || n.includes("native linux")) return "therock_install";
  return "custom";
}
