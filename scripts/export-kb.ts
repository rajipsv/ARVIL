/**
 * Export kb_patterns (Neon) -> lib/data/patterns.json.
 *
 * Same spirit as `python -m rag --export-index`: Neon is where patterns are
 * built and grown (seeded once via scripts/migrate-kb-to-neon.ts, then edited
 * directly or promoted via triage); this regenerates the checked-in JSON file
 * both lib/knowledge.ts (TS, web tier) and python/rag/knowledge.py (Python,
 * RAG retrieval) already read, so neither consumer needs to change.
 *
 * Run manually after editing/promoting patterns in Neon, then commit the
 * regenerated file: npx tsx scripts/export-kb.ts
 */
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";
import { getDb } from "../lib/db";

interface KbPatternRow {
  id: string;
  pattern: string;
  category: string | null;
  severity: string | null;
  signatures: string[] | null;
  causes: string | null;
  solutions: string | null;
  similar_errors: string | null;
}

function formatPattern(p: KbPatternRow): string {
  const lines = [
    `    "id": ${JSON.stringify(p.id)}`,
    `    "pattern": ${JSON.stringify(p.pattern)}`,
    `    "category": ${JSON.stringify(p.category ?? "")}`,
    `    "severity": ${JSON.stringify(p.severity ?? "")}`,
    `    "signatures": [${(p.signatures ?? []).map((s) => JSON.stringify(s)).join(", ")}]`,
    `    "causes": ${JSON.stringify(p.causes ?? "")}`,
    `    "solutions": ${JSON.stringify(p.solutions ?? "")}`,
    `    "similar_errors": ${JSON.stringify(p.similar_errors ?? "")}`,
  ];
  return `  {\r\n${lines.join(",\r\n")}\r\n  }`;
}

async function main() {
  const sql = getDb();
  if (!sql) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  const rows = (await sql`
    SELECT id, pattern, category, severity, signatures, causes, solutions, similar_errors
    FROM kb_patterns
    ORDER BY id
  `) as KbPatternRow[];

  if (rows.length === 0) {
    console.error("kb_patterns is empty — run scripts/migrate-kb-to-neon.ts first.");
    process.exit(1);
  }

  const outPath = join(__dirname, "..", "lib", "data", "patterns.json");
  const before = readFileSync(outPath, "utf8");
  const out = `[\r\n${rows.map(formatPattern).join(",\r\n")}\r\n]\r\n`;

  writeFileSync(outPath, out);
  console.log(`Wrote ${rows.length} patterns to ${outPath}`);
  console.log(out === before ? "(content unchanged from previous file)" : "(content changed — review the diff before committing)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
