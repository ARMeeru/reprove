// One command, five stages: explore -> generate -> execute -> reverify -> report.
// Runner-only mode (`run --specs-dir <dir> <url>`) skips explore+generate entirely —
// the suite is verifiably identical across targets, which is what the both-directions
// sensor checks and the demo clip depend on.
// Usage:
//   npx tsx src/cli.ts <url> [--max-pages N] [--max-actions N] [--skip-explore flows.json] [--budget-usd X] [--serve]
//   npx tsx src/cli.ts run --specs-dir <dir> <url> [--budget-usd X] [--serve]
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { spawn } from "node:child_process"

function parseArgs(argv: string[]) {
  const out: { mode?: "full" | "run"; url?: string; specsDir?: string; flowsPath?: string; maxPages?: number; maxActions?: number; budgetUsd?: number; serve?: boolean; outDir?: string } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "run") out.mode = "run"
    else if (a === "--specs-dir") out.specsDir = argv[++i]
    else if (a === "--skip-explore") out.flowsPath = argv[++i]
    else if (a === "--max-pages") out.maxPages = Number(argv[++i])
    else if (a === "--max-actions") out.maxActions = Number(argv[++i])
    else if (a === "--budget-usd") out.budgetUsd = Number(argv[++i])
    else if (a === "--out") out.outDir = argv[++i]
    else if (a === "--serve") out.serve = true
    else if (!a.startsWith("-")) out.url = a
    else throw new Error(`unknown flag ${a}`)
  }
  if (!out.url) throw new Error("target <url> is required")
  if (out.mode === "run" && !out.specsDir) throw new Error("run mode requires --specs-dir <dir>")
  if (!out.mode) out.mode = "full"
  return out as { mode: "full" | "run"; url: string; specsDir?: string; flowsPath?: string; maxPages?: number; maxActions?: number; budgetUsd?: number; serve: boolean; outDir?: string }
}

const args = parseArgs(process.argv.slice(2))
const runDir = args.outDir ?? join("runs", `cli-${new Date().toISOString().replace(/[:.]/g, "-")}`)
const specsDir = args.specsDir ?? "specs-cli"
const flowsPath = args.flowsPath ?? "flows.json"
const started = Date.now()

function stage(name: string, cmdArgs: string[]): Promise<void> {
  console.log(`\n=== ${name} ===`)
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["tsx", ...cmdArgs], { stdio: "inherit" })
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${name} exited ${code}`))))
    child.on("error", reject)
  })
}

async function browserCostSoFar(): Promise<{ minutes: number; usd: number }> {
  // Fail closed: a budget check that silently passes when results.json is
  // unreadable is not a budget check.
  const doc = JSON.parse(await readFile(join(runDir, "results.json"), "utf8")) as {
    results: { durationMs: number }[]
  }
  const minutes = doc.results.reduce((n, r) => n + r.durationMs, 0) / 60000
  return { minutes, usd: (minutes / 60) * 0.15 }
}

try {
  if (args.mode === "full") {
    if (!args.flowsPath || args.flowsPath === "flows.json") {
      const exploreArgs = ["src/explore.ts", args.url, "--out", flowsPath]
      if (args.maxPages) exploreArgs.push("--max-pages", String(args.maxPages))
      if (args.maxActions) exploreArgs.push("--max-actions", String(args.maxActions))
      await stage("explore", exploreArgs)
    }
    await stage("generate", ["src/generate.ts", flowsPath, "--out-dir", specsDir])
  } else {
    console.log(`\n=== runner-only mode: suite ${specsDir} verbatim, no regeneration ===`)
  }
  await stage("execute", ["src/execute.ts", "--target", args.url, "--specs", specsDir, "--out", runDir])

  if (args.budgetUsd !== undefined) {
    const cost = await browserCostSoFar()
    if (cost.usd > args.budgetUsd) {
      throw new Error(`budget exceeded after execute: $${cost.usd.toFixed(3)} > $${args.budgetUsd} — stopping before reverify`)
    }
  }
  await stage("reverify", ["src/reverify.ts", "--run", runDir, "--specs", specsDir])

  const reportArgs = ["src/report.ts", "--run", runDir]
  if (args.mode === "full") reportArgs.push("--flows", flowsPath)
  if (args.serve) reportArgs.push("--serve")
  await stage("report", reportArgs)
} catch (err) {
  console.log(`FAIL pipeline aborted: ${err instanceof Error ? err.message : String(err)}`)
  process.exitCode = 1
}

let cost = { minutes: 0, usd: 0 }
try {
  cost = await browserCostSoFar()
} catch {
  // summary-only fallback; the budget gate above still fails closed
}
console.log(
  `\npipeline ${process.exitCode ? "ABORTED" : "done"} in ${((Date.now() - started) / 60000).toFixed(1)} min — run dir ${runDir}; execute-stage browser time ${cost.minutes.toFixed(1)} min (× $0.15/hr ≈ $${cost.usd.toFixed(3)}; reverify sessions extra)`,
)
