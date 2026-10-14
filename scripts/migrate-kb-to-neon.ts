/**
 * One-time seed: lib/data/patterns.json -> kb_patterns table in Neon.
 *
 * After this runs, kb_patterns is the canonical KB store. patterns.json stops
 * being hand-edited and becomes a generated export (see scripts/export-kb.ts).
 *
 * Safe to re-run: existing rows are left untouched (ON CONFLICT DO NOTHING),
 * so it never overwrites a pattern a human has since edited directly in Neon.
 *
 * Run: npx tsx scripts/migrate-kb-to-neon.ts
 */
import { ensureSchemaV2, getDb } from "../lib/db";
import patterns from "../lib/data/patterns.json";

async function main() {
  const sql = getDb();
  if (!sql) {
    console.error("DATABASE_URL not set.");
    process.exit(1);
  }

  await ensureSchemaV2();

  let inserted = 0;
  let skipped = 0;

  for (const p of patterns) {
    const rows = (await sql`
      INSERT INTO kb_patterns (id, pattern, category, severity, signatures, causes, solutions, similar_errors)
      VALUES (
        ${p.id}, ${p.pattern}, ${p.category}, ${p.severity},
        ${JSON.stringify(p.signatures)}::jsonb, ${p.causes}, ${p.solutions}, ${p.similar_errors}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `) as { id: string }[];

    if (rows.length > 0) {
      inserted++;
      console.log(`inserted: ${p.id}`);
    } else {
      skipped++;
      console.log(`skipped (already exists): ${p.id}`);
    }
  }

  console.log(`\nDone. ${inserted} inserted, ${skipped} already present. Total patterns in file: ${patterns.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
