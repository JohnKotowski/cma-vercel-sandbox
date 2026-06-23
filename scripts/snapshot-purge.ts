/* Purge orphaned Vercel sandbox snapshots. DRY-RUN by default; pass --execute to delete.
 * KEEP = explicit active IDs (local .env.local) ∪ any snapshot used within KEEP_DAYS.
 * Everything else (old, never-reused build artifacts) is deleted. */
import { Snapshot } from "@vercel/sandbox";

const token = process.env.VERCEL_TOKEN!;
const teamId = process.env.VERCEL_TEAM_ID!;
const projectId = process.env.VERCEL_PROJECT_ID!;
const EXECUTE = process.argv.includes("--execute");
const KEEP_DAYS = 7;
const CONCURRENCY = 16;

const ACTIVE = [
  process.env.SANDBOX_SNAPSHOT_ID,
  process.env.SANDBOX_ADD_SNAPSHOT_ID,
  process.env.SANDBOX_SCRAPE_SNAPSHOT_ID,
  process.env.SANDBOX_DIFF_SNAPSHOT_ID,
].filter(Boolean) as string[];
const activeIds = new Set(ACTIVE);

const gb = (b: number) => (b / 1e9).toFixed(2);
const day = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");
const now = Date.now();
const cutoff = now - KEEP_DAYS * 86400_000;

async function deleteSnapshot(id: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(
      `https://vercel.com/api/v2/sandboxes/snapshots/${id}?teamId=${teamId}`,
      { method: "DELETE", headers: { authorization: `Bearer ${token}` } }
    );
    if (r.ok || r.status === 404) return true;
    if (r.status === 429 || r.status >= 500) {
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
      continue;
    }
    console.error(`  delete ${id} -> ${r.status} ${await r.text().catch(() => "")}`);
    return false;
  }
  return false;
}

async function main() {
  const res = await Snapshot.list({ token, teamId, projectId } as any);
  const all: any[] = await (res as any).toArray();
  const created = all.filter((s) => s.status === "created");

  // by-day histogram of lastUsedAt
  const hist: Record<string, number> = {};
  for (const s of created) hist[day(s.lastUsedAt ?? s.createdAt)] = (hist[day(s.lastUsedAt ?? s.createdAt)] || 0) + 1;

  const keep: any[] = [];
  const del: any[] = [];
  for (const s of created) {
    const lu = s.lastUsedAt ?? s.createdAt;
    if (activeIds.has(s.id) || lu >= cutoff) keep.push(s);
    else del.push(s);
  }

  const sum = (arr: any[]) => arr.reduce((n, s) => n + (s.sizeBytes || 0), 0);
  console.log(`\nMODE: ${EXECUTE ? "EXECUTE (deleting)" : "DRY-RUN"}   KEEP_DAYS=${KEEP_DAYS}`);
  console.log(`lastUsedAt histogram (by day):`);
  for (const d of Object.keys(hist).sort()) console.log(`  ${d}: ${hist[d]}`);
  console.log(`\nactive IDs from env (${activeIds.size}):`, [...activeIds]);
  console.log(`\nKEEP: ${keep.length} snapshots, ${gb(sum(keep))} GB`);
  for (const s of keep.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0)))
    console.log(`  keep ${s.id}  ${gb(s.sizeBytes || 0)}GB  created ${day(s.createdAt)} lastUsed ${day(s.lastUsedAt)}${activeIds.has(s.id) ? "  ★ENV" : "  (recent)"}`);
  console.log(`\nDELETE: ${del.length} snapshots, ${gb(sum(del))} GB`);

  if (!EXECUTE) {
    console.log(`\nDRY-RUN — nothing deleted. Re-run with --execute to delete the ${del.length} above.`);
    return;
  }

  let ok = 0, fail = 0, done = 0;
  const queue = [...del];
  async function worker() {
    while (queue.length) {
      const s = queue.shift();
      if (!s) break;
      const success = await deleteSnapshot(s.id);
      success ? ok++ : fail++;
      if (++done % 250 === 0) console.log(`  ...${done}/${del.length} (ok=${ok} fail=${fail})`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`\nDONE. deleted=${ok} failed=${fail} reclaimed≈${gb(sum(del.filter((_, i) => i < ok)))}GB (approx)`);
}
main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
