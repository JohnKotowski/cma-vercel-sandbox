/* Read-only inventory of all Vercel sandbox snapshots for the team. */
import { Snapshot } from "@vercel/sandbox";

const token = process.env.VERCEL_TOKEN!;
const teamId = process.env.VERCEL_TEAM_ID!;
const projectId = process.env.VERCEL_PROJECT_ID!;

const ACTIVE = {
  SANDBOX_SNAPSHOT_ID: process.env.SANDBOX_SNAPSHOT_ID,
  SANDBOX_ADD_SNAPSHOT_ID: process.env.SANDBOX_ADD_SNAPSHOT_ID,
  SANDBOX_SCRAPE_SNAPSHOT_ID: process.env.SANDBOX_SCRAPE_SNAPSHOT_ID,
  SANDBOX_DIFF_SNAPSHOT_ID: process.env.SANDBOX_DIFF_SNAPSHOT_ID,
};
const activeIds = new Set(Object.values(ACTIVE).filter(Boolean) as string[]);

const gb = (b: number) => (b / 1e9).toFixed(2);
const day = (ms?: number) => (ms ? new Date(ms).toISOString().slice(0, 10) : "—");

async function main() {
  const res = await Snapshot.list({ token, teamId, projectId } as any);
  const all: any[] = await (res as any).toArray();

  const created = all.filter((s) => s.status === "created");
  let total = 0,
    activeBytes = 0,
    orphanBytes = 0;
  const rows = created
    .map((s) => {
      total += s.sizeBytes || 0;
      const isActive = activeIds.has(s.id);
      if (isActive) activeBytes += s.sizeBytes || 0;
      else orphanBytes += s.sizeBytes || 0;
      return {
        id: s.id,
        gb: gb(s.sizeBytes || 0),
        created: day(s.createdAt),
        lastUsed: day(s.lastUsedAt),
        active: isActive ? "★ACTIVE" : "",
      };
    })
    .sort((a, b) => Number(b.gb) - Number(a.gb));

  console.log(`\nSTATUS COUNTS:`, all.reduce((m: any, s) => ((m[s.status] = (m[s.status] || 0) + 1), m), {}));
  console.log(`TOTAL created snapshots: ${created.length}`);
  console.log(`TOTAL storage:  ${gb(total)} GB`);
  console.log(`  in-use (4 active): ${gb(activeBytes)} GB`);
  console.log(`  ORPHANED:          ${gb(orphanBytes)} GB  (${created.length - activeIds.size} snapshots)\n`);
  console.table(rows);
}
main().catch((e) => {
  console.error("ERR", e?.message || e);
  process.exit(1);
});
