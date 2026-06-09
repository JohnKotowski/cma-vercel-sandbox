/**
 * Batch extraction: run managed-agent pricing extractions for multiple slugs.
 *
 * Uses the Anthropic managed agent + Vercel Sandbox path. Each extraction runs
 * fully autonomously — no Claude Code reasoning needed. API billing applies.
 *
 * Usage:
 *   npx tsx scripts/batch-extract.ts <slugs-file>           # one slug per line
 *   npx tsx scripts/batch-extract.ts --slugs=a]1password,github,notion
 *   npx tsx scripts/batch-extract.ts --from-api              # fetch slugs needing extraction
 *   npx tsx scripts/batch-extract.ts <slugs-file> --concurrency=3 --no-upload
 *
 * Options:
 *   --concurrency=N   Max parallel extractions (default: 2)
 *   --no-upload       Extract only, don't run pipeline upload
 *   --output-dir=DIR  Output directory (default: ./tmp/batch-YYYYMMDD-HHMM)
 *   --url-map=FILE    JSON file mapping slug → custom pricing URL
 */

import { config } from "dotenv";
config({ path: `${__dirname}/../.env.local` });
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox } from "@vercel/sandbox";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import ms from "ms";
import { execSync } from "node:child_process";

const ENV_ID = process.env.ANTHROPIC_ENVIRONMENT_ID!;
const ENV_KEY = process.env.ANTHROPIC_ENVIRONMENT_KEY!;
const SNAPSHOT = process.env.SANDBOX_SNAPSHOT_ID!;
const AGENT = process.env.ANTHROPIC_AGENT_ID!;
const BETA = "managed-agents-2026-04-01";
const MGMT_API_URL = process.env.MANAGEMENT_API_URL;
const MGMT_API_KEY = process.env.MANAGEMENT_API_KEY;

interface BatchResult {
  slug: string;
  status: "success" | "error" | "timeout";
  plans?: number;
  error?: string;
  durationMs?: number;
  outputFile?: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let slugsFile = "";
  let slugsList: string[] = [];
  let fromApi = false;
  let concurrency = 2;
  let noUpload = false;
  let outputDir = "";
  let urlMapFile = "";

  for (const arg of args) {
    if (arg === "--from-api") fromApi = true;
    else if (arg === "--no-upload") noUpload = true;
    else if (arg.startsWith("--concurrency=")) concurrency = parseInt(arg.split("=")[1]);
    else if (arg.startsWith("--output-dir=")) outputDir = arg.split("=")[1];
    else if (arg.startsWith("--slugs=")) slugsList = arg.split("=")[1].split(",");
    else if (arg.startsWith("--url-map=")) urlMapFile = arg.split("=")[1];
    else if (!arg.startsWith("--")) slugsFile = arg;
  }

  const now = new Date();
  const ts = now.toISOString().replace(/[-:]/g, "").slice(0, 13);
  if (!outputDir) outputDir = `./tmp/batch-${ts}`;

  return { slugsFile, slugsList, fromApi, concurrency, noUpload, outputDir, urlMapFile };
}

async function getSlugs(opts: ReturnType<typeof parseArgs>): Promise<string[]> {
  if (opts.slugsList.length > 0) return opts.slugsList;

  if (opts.slugsFile) {
    return readFileSync(opts.slugsFile, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  }

  if (opts.fromApi && MGMT_API_URL && MGMT_API_KEY) {
    const resp = await fetch(`${MGMT_API_URL}/pages?needs_extraction=true&limit=100`, {
      headers: { "X-API-Key": MGMT_API_KEY },
    });
    const data = (await resp.json()) as { data?: Array<{ slug: string }> };
    return (data.data || []).map((p) => p.slug);
  }

  console.error("Provide slugs via file, --slugs=, or --from-api");
  process.exit(1);
}

async function extractSlug(
  slug: string,
  api: Anthropic,
  worker: Anthropic,
  outputDir: string,
  urlMap: Record<string, string>
): Promise<BatchResult> {
  const start = Date.now();
  let sandbox: Sandbox | null = null;

  try {
    const session = await api.beta.sessions.create({
      agent: AGENT,
      environment_id: ENV_ID,
      betas: [BETA],
    });

    const url = urlMap[slug] || `https://${slug.replace(/_/g, ".")}.com/pricing`;
    const prompt = `Extract pricing data from ${slug}. The pricing page URL is ${url}. Write the JSON to /tmp/extract-output.json. Be efficient — do not repeat browser actions you've already taken. Stop after extracting all visible pricing data.`;

    await api.beta.sessions.events.send(session.id, {
      events: [{ type: "user.message", content: [{ type: "text", text: prompt }] }],
    });

    // Poll for work
    let work: Awaited<ReturnType<typeof worker.beta.environments.work.poll>> = null;
    for (let i = 0; i < 30; i++) {
      const item = await worker.beta.environments.work.poll(ENV_ID, {
        betas: [BETA],
        reclaim_older_than_ms: 2000,
      });
      if (item?.data.type === "session" && item.data.id === session.id) {
        work = item;
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!work) return { slug, status: "error", error: "no work item after 30s", durationMs: Date.now() - start };

    await worker.beta.environments.work.ack(work.id, { environment_id: ENV_ID, betas: [BETA] });

    // Spawn sandbox
    sandbox = await Sandbox.create({
      source: { type: "snapshot", snapshotId: SNAPSHOT },
      runtime: "node24",
      timeout: ms("10m"),
    });

    await sandbox.writeFiles([{
      path: "/vercel/sandbox/runner.ts",
      content: readFileSync("./sandbox/runner.ts"),
    }]);

    await sandbox.runCommand({
      cmd: "npx",
      args: ["tsx", "runner.ts"],
      cwd: "/vercel/sandbox",
      env: {
        ENVIRONMENT_ID: ENV_ID,
        ENVIRONMENT_KEY: ENV_KEY,
        WORK_ID: work.id,
        SESSION_ID: session.id,
      },
      detached: true,
    });

    // Wait for completion
    for (let i = 0; i < 120; i++) {
      for await (const ev of api.beta.sessions.events.list(session.id, { limit: 10 })) {
        if (
          ev.type === "session.status_idle" &&
          (ev as { stop_reason?: { type: string } }).stop_reason?.type === "end_turn"
        ) {
          // Extract complete — read output
          try {
            const result = await sandbox.runCommand("cat", ["/tmp/extract-output.json"]);
            const output = await result.stdout();
            if (output) {
              const outFile = `${outputDir}/${slug}.json`;
              writeFileSync(outFile, output, "utf8");
              const data = JSON.parse(output);
              await sandbox.stop();
              sandbox = null;
              return {
                slug,
                status: "success",
                plans: data.plans?.length || 0,
                durationMs: Date.now() - start,
                outputFile: outFile,
              };
            }
          } catch {
            // No output file
          }
          await sandbox.stop();
          sandbox = null;
          return { slug, status: "error", error: "no output file", durationMs: Date.now() - start };
        }
      }
      await new Promise((r) => setTimeout(r, 3000));
    }

    return { slug, status: "timeout", error: "6 min timeout", durationMs: Date.now() - start };
  } catch (e) {
    return { slug, status: "error", error: e instanceof Error ? e.message : String(e), durationMs: Date.now() - start };
  } finally {
    if (sandbox) await sandbox.stop().catch(() => {});
  }
}

async function runUpload(slug: string, jsonFile: string, version: string) {
  const script = `${__dirname}/upload-extraction.sh`;
  try {
    execSync(`bash "${script}" "${slug}" "${jsonFile}" --version=${version}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const opts = parseArgs();
  const slugs = await getSlugs(opts);

  if (slugs.length === 0) {
    console.log("No slugs to process.");
    return;
  }

  mkdirSync(opts.outputDir, { recursive: true });

  const urlMap: Record<string, string> = opts.urlMapFile
    ? JSON.parse(readFileSync(opts.urlMapFile, "utf8"))
    : {};

  const version = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const api = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const worker = new Anthropic({ authToken: ENV_KEY });

  console.log(`\nBatch extraction: ${slugs.length} slugs, concurrency=${opts.concurrency}`);
  console.log(`Output: ${opts.outputDir}\n`);

  const results: BatchResult[] = [];
  const queue = [...slugs];
  const active = new Set<Promise<void>>();

  async function processSlug(slug: string) {
    console.log(`[start] ${slug}`);
    const result = await extractSlug(slug, api, worker, opts.outputDir, urlMap);
    results.push(result);

    if (result.status === "success") {
      console.log(`[done]  ${slug} — ${result.plans} plans (${Math.round((result.durationMs || 0) / 1000)}s)`);
      if (!opts.noUpload && result.outputFile) {
        const uploaded = await runUpload(slug, result.outputFile, version);
        if (!uploaded) console.log(`[warn]  ${slug} — upload failed`);
      }
    } else {
      console.log(`[fail]  ${slug} — ${result.error} (${Math.round((result.durationMs || 0) / 1000)}s)`);
    }
  }

  while (queue.length > 0 || active.size > 0) {
    while (queue.length > 0 && active.size < opts.concurrency) {
      const slug = queue.shift()!;
      const p = processSlug(slug).then(() => { active.delete(p); });
      active.add(p);
    }
    if (active.size > 0) await Promise.race(active);
  }

  // Summary
  const success = results.filter((r) => r.status === "success");
  const errors = results.filter((r) => r.status !== "success");

  console.log("\n============================================================");
  console.log(` Batch complete: ${success.length}/${results.length} succeeded`);
  console.log("============================================================");

  if (errors.length > 0) {
    console.log("\nFailed:");
    for (const r of errors) {
      console.log(`  ${r.slug}: ${r.error}`);
    }
  }

  // Write summary
  const summaryFile = `${opts.outputDir}/batch-summary.json`;
  writeFileSync(summaryFile, JSON.stringify({ version, results, summary: {
    total: results.length,
    success: success.length,
    errors: errors.length,
    totalPlans: success.reduce((sum, r) => sum + (r.plans || 0), 0),
  }}, null, 2));
  console.log(`\nSummary: ${summaryFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
