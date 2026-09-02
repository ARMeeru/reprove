// Stage 3: run every spec inside one Solari sandbox, each against its own fresh
// recorded cloud browser session. Failures are collected, not gated — reverify decides.
// Usage: npx tsx src/execute.ts --target <url> [--specs specs] [--out runs/<ts>] [--spec-timeout-ms 120000]
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import {
  GUEST_DIR,
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
  const out: { target?: string; specs?: string; outDir?: string; specTimeoutMs?: number } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--target") out.target = argv[++i]
    else if (a === "--specs") out.specs = argv[++i]!
    else if (a === "--out") out.outDir = argv[++i]!
    else if (a === "--spec-timeout-ms") out.specTimeoutMs = Number(argv[++i])
    else throw new Error(`unknown flag ${a}`)
  }
  if (!out.target) throw new Error("--target <url> is required")
  if (!out.outDir) out.outDir = join("runs", new Date().toISOString().replace(/[:.]/g, "-"))
  if (!out.specTimeoutMs) out.specTimeoutMs = 120_000
  return out as { target: string; specs: string; outDir: string; specTimeoutMs: number }
}

const { target, specs, outDir, specTimeoutMs } = parseArgs(process.argv.slice(2))
const specFiles = (await readdir(specs)).filter((f) => f.endsWith(".spec.ts")).sort()
if (specFiles.length === 0) throw new Error(`no .spec.ts files in ${specs}`)

await mkdir(outDir, { recursive: true })
const { browser, pt } = makeClients()
const started = Date.now()
let box: Awaited<ReturnType<typeof createSandboxWithNode>> | undefined
const results: unknown[] = []
let passed = 0
let failed = 0

try {
  await killLeftoverSandboxes(pt)
  box = await createSandboxWithNode(pt)
  console.log(`sandbox ready id=${box.sandboxId} node=v22 target=${target}`)

  await uploadSpecsAndInstall(box, specFiles, specs, (p) => readFile(p, "utf8"))
  console.log(`guest npm install ok (${specFiles.length} specs uploaded)`)

  for (const f of specFiles) {
    const t0 = Date.now()
    const session = await createRecordedSession(browser)
    console.log(`run ${f} session=${session.id}`)
    let run
    try {
      run = await runSpecInSandbox(
        box,
        f,
        { SOLARI_CDP_ENDPOINT: session.cdpUrl, TARGET_URL: target },
        specTimeoutMs,
      )
    } finally {
      try {
        await browser.sessions.releaseAndWait(session.id)
      } catch (err) {
        console.log(`releaseAndWait: ${errMsg(err)}`)
      }
    }
    const out = (run.stdout + "\n" + run.stderr).trim()
    console.log(out.slice(-400))
    let replayBytes = 0
    let replayFile: string | null = null
    try {
      const blob = await pollReplay(browser, session.id)
      if (blob) {
        replayFile = join(outDir, f.replace(/\.spec\.ts$/, ""), "replay.ndjson")
        await mkdir(join(outDir, f.replace(/\.spec\.ts$/, "")), { recursive: true })
        await writeFile(replayFile, blob)
        replayBytes = blob.byteLength
      }
    } catch (err) {
      console.log(`replay: ${errMsg(err)}`)
    }
    if (run.ok) passed++
    else failed++
    results.push({
      spec: f,
      target,
      pass: run.ok,
      timedOut: run.timedOut,
      exitCode: run.exitCode,
      error: run.error ?? null,
      stdoutTail: run.stdout.slice(-2000),
      stderrTail: run.stderr.slice(-2000),
      sessionId: session.id,
      replayFile,
      replayBytes,
      durationMs: Date.now() - t0,
    })
    console.log(`${run.ok ? "PASS" : "FAIL"} ${f} replayBytes=${replayBytes} elapsedMs=${Date.now() - t0}`)
  }
} catch (err) {
  console.log(`FAIL execute aborted: ${errMsg(err)}`)
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

await writeFile(join(outDir, "results.json"), JSON.stringify({ target, specs, startedAt: new Date(started).toISOString(), results }, null, 2))
console.log(`execute done: ${results.length} specs, ${passed} pass, ${failed} fail -> ${join(outDir, "results.json")}`)
