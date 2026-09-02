// Stage 4: every failing spec reruns in a fresh independent session. Only failures
// that reproduce become findings; the rest are "did not reproduce" and feed the
// flake-rate line. Third run (on by default, --no-third-run to disable) never
// demotes a finding — 2-of-3 majority holds; a passing third run adds a stability note.
// Usage: npx tsx src/reverify.ts --run runs/<ts> [--specs specs] [--target <url>] [--no-third-run]
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  createRecordedSession,
  createSandboxWithNode,
  errMsg,
  killLeftoverSandboxes,
  makeClients,
  pollReplay,
  runSpecInSandbox,
  uploadSpecsAndInstall,
} from "./runner-lib.ts"

function parseArgs(argv: string[]) {
  const out: { run?: string; specs?: string; target?: string; thirdRun?: boolean; specTimeoutMs?: number } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--run") out.run = argv[++i]
    else if (a === "--specs") out.specs = argv[++i]!
    else if (a === "--target") out.target = argv[++i]
    else if (a === "--no-third-run") out.thirdRun = false
    else if (a === "--spec-timeout-ms") out.specTimeoutMs = Number(argv[++i])
    else throw new Error(`unknown flag ${a}`)
  }
  if (!out.run) throw new Error("--run <dir> is required")
  if (out.thirdRun === undefined) out.thirdRun = true
  if (!out.specTimeoutMs) out.specTimeoutMs = 120_000
  return out as { run: string; specs: string; target?: string; thirdRun: boolean; specTimeoutMs: number }
}

const { run: runDir, specs, target: targetArg, thirdRun, specTimeoutMs } = parseArgs(process.argv.slice(2))

type ExecResults = {
  target: string
  results: {
    spec: string
    pass: boolean
    stdoutTail: string
    stderrTail: string
    sessionId: string
    replayFile: string | null
  }[]
}

const execDoc = JSON.parse(await readFile(join(runDir, "results.json"), "utf8")) as ExecResults
const target = targetArg ?? execDoc.target
const failures = execDoc.results.filter((r) => !r.pass)

type Rerun = { sessionId: string; pass: boolean; timedOut: boolean; replayFile: string | null }
type Finding = {
  spec: string
  verdict: "finding"
  runs: { sessionId: string; pass: boolean }[]
  replays: string[]
  stability: "stable" | "third-run-passed"
}
type Flake = { spec: string; verdict: "did-not-reproduce"; runs: { sessionId: string; pass: boolean }[] }

const findings: Finding[] = []
const flakes: Flake[] = []
let reran = 0

async function rerun(box: Awaited<ReturnType<typeof createSandboxWithNode>>, spec: string, priorSessionId: string, label: string): Promise<Rerun> {
  const session = await createRecordedSession(clients.browser)
  if (session.id === priorSessionId) {
    throw new Error(`reverify session id did not differ (${session.id}) — independence violated`)
  }
  console.log(`${label} ${spec} session=${session.id}`)
  let runRes
  try {
    runRes = await runSpecInSandbox(
      box,
      spec,
      { SOLARI_CDP_ENDPOINT: session.cdpUrl, TARGET_URL: target },
      specTimeoutMs,
    )
  } finally {
    try {
      await clients.browser.sessions.releaseAndWait(session.id)
    } catch (err) {
      console.log(`releaseAndWait: ${errMsg(err)}`)
    }
  }
  if (!runRes.ok) {
    const out = (runRes.stdout + "\n" + runRes.stderr).trim()
    console.log(out.slice(-300))
  }
  let replayFile: string | null = null
  try {
    const blob = await pollReplay(clients.browser, session.id)
    if (blob) {
      const dir = join(runDir, "reverify", spec.replace(/\.spec\.ts$/, ""))
      await mkdir(dir, { recursive: true })
      replayFile = join(dir, `replay-${label}.ndjson`)
      await writeFile(replayFile, blob)
    }
  } catch (err) {
    console.log(`replay: ${errMsg(err)}`)
  }
  return { sessionId: session.id, pass: runRes.ok, timedOut: runRes.timedOut, replayFile }
}

const clients = makeClients()
const { browser, pt } = clients
let box: Awaited<ReturnType<typeof createSandboxWithNode>> | undefined

try {
  if (failures.length === 0) {
    console.log("0 failures in execute — nothing to reverify")
  } else {
    await killLeftoverSandboxes(pt)
    box = await createSandboxWithNode(pt)
    await uploadSpecsAndInstall(
      box,
      failures.map((f) => f.spec),
      specs,
      (p) => readFile(p, "utf8"),
    )

    for (const f of failures) {
      reran++
      const run2 = await rerun(box, f.spec, f.sessionId, "run2")
      const execReplay = f.replayFile ?? null
      if (!run2.pass) {
        // reproduced in >=2 independent sessions -> finding; optional third run
        let stability: Finding["stability"] = "stable"
        let run3: Rerun | null = null
        if (thirdRun) {
          run3 = await rerun(box, f.spec, run2.sessionId, "run3")
          stability = run3.pass ? "third-run-passed" : "stable"
        }
        findings.push({
          spec: f.spec,
          verdict: "finding",
          runs: [
            { sessionId: f.sessionId, pass: false },
            { sessionId: run2.sessionId, pass: false },
            ...(run3 ? [{ sessionId: run3.sessionId, pass: run3.pass }] : []),
          ],
          replays: [execReplay, run2.replayFile, run3?.replayFile ?? null].filter(Boolean) as string[],
          stability,
        })
        console.log(`FINDING ${f.spec} (${stability})`)
      } else {
        flakes.push({
          spec: f.spec,
          verdict: "did-not-reproduce",
          runs: [
            { sessionId: f.sessionId, pass: false },
            { sessionId: run2.sessionId, pass: true },
          ],
        })
        console.log(`DID-NOT-REPRODUCE ${f.spec}`)
      }
    }
  }
} catch (err) {
  console.log(`FAIL reverify aborted: ${errMsg(err)}`)
  process.exitCode = 1
} finally {
  if (box) {
    try {
      await box.kill()
    } catch (err) {
      console.log(`sandbox.kill: ${errMsg(err)}`)
    }
  }
  await browser.close()
}

const verdicts = {
  target,
  runDir,
  reran,
  reproduced: findings.length,
  didNotReproduce: flakes.length,
  findings,
  flakes,
}
await writeFile(join(runDir, "verdicts.json"), JSON.stringify(verdicts, null, 2))
console.log(
  `reverify done: ${failures.length} failures, ${findings.length} reproduced, ${flakes.length} did not reproduce -> ${join(runDir, "verdicts.json")}`,
)
