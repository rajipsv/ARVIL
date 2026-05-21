/**
 * Run: npx tsx scripts/test-root-cause.ts
 */
import { lookupKnownFailure } from "../lib/knowledge";
import { groupRootCauses, selfTestRootCause } from "../lib/root-cause";
import type { LogError } from "../lib/types";

const FIXTURE: LogError[] = [
  {
    type: "ERROR",
    line_number: 157,
    message:
      "2026-05-21T14:39:09.0065514Z raise CalledProcessError(retcode, process.args,",
    severity: "HIGH",
    category: "Runtime",
    recommendation: "generic",
    kb_pattern_id: null,
  },
  {
    type: "CRITICAL",
    line_number: 158,
    message:
      "2026-05-21T14:39:09.0068130Z subprocess.CalledProcessError: Command '['git', 'diff', '--name-only', 'bb1c030b66709b958a09596ff1bc76923024d497']' returned non-zero exit status 128.",
    severity: "CRITICAL",
    category: "GPU/Driver",
    recommendation: "wrong",
    kb_pattern_id: "rocm_hsa_status",
  },
  {
    type: "ERROR",
    line_number: 159,
    message:
      "2026-05-21T14:39:09.0251367Z ##[error]Process completed with exit code 1.",
    severity: "MEDIUM",
    category: "Other",
    recommendation: "wrapper",
    kb_pattern_id: "github_actions_fail",
  },
];

function main() {
  let ok = true;

  if (!selfTestRootCause()) {
    console.error("FAIL: selfTestRootCause");
    ok = false;
  } else {
    console.log("OK: selfTestRootCause");
  }

  const groups = groupRootCauses(FIXTURE);
  if (groups.length !== 1) {
    console.error(`FAIL: expected 1 group, got ${groups.length}`);
    ok = false;
  } else {
    console.log("OK: L157–L159 → 1 group");
  }

  const kb = lookupKnownFailure(groups[0]?.primary_message ?? "", 1);
  const pid = kb[0]?.pattern_id;
  if (pid !== "git_diff_ci_fail") {
    console.error(`FAIL: KB expected git_diff_ci_fail, got ${pid ?? "none"}`);
    ok = false;
  } else {
    console.log("OK: primary matches git_diff_ci_fail");
  }

  const wrappers = groups[0]?.related_lines.filter((r) => r.role === "wrapper");
  if (!wrappers?.length) {
    console.error("FAIL: expected wrapper line in related_lines");
    ok = false;
  } else {
    console.log("OK: GHA wrapper attached");
  }

  process.exit(ok ? 0 : 1);
}

main();
