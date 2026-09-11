import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { Solari } from "@solarisdk/browser"
import { validateFlows, type Flow, type FlowsDocument } from "./schema.ts"

const MODEL = "claude-sonnet-5"
const TSC_ARGS = [
  "--noEmit",
  "--strict",
  "--target",
  "es2022",
  "--module",
  "esnext",
  "--moduleResolution",
  "bundler",
  // rrweb-player pulled in @types/css-font-loading-module, whose ambient
  // declarations clash with @types/node unless the loaded set is pinned.
  "--types",
  "node",
]

// One text answer, no tools, no agentic turns: the CLI is the transport
// (subscription setup tokens are enforced to this client shape), the SDK
// handles spawning and the stream protocol.
async function callModel(system: string, user: string): Promise<string> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 180_000)
  try {
    let result: string | undefined
    let stopped = "no result message"
    for await (const message of query({
      prompt: user,
      options: {
        model: MODEL,
        systemPrompt: system,
        allowedTools: [],
        maxTurns: 4,
        abortController: abort,
      },
    })) {
      if (message.type === "result") {
        if (message.subtype === "success") {
          result = message.result
          console.log(`  claude ${message.duration_ms}ms cost=$${message.total_cost_usd.toFixed(4)}`)
        } else {
          stopped = `subtype=${message.subtype}`
        }
      }
    }
    if (result === undefined) throw new Error(`claude returned no result (${stopped})`)
    return result
  } finally {
    clearTimeout(timer)
  }
}

function parseArgs(argv: string[]) {
  let flowsPath = "flows.json"
  let outDir = "specs"
  let run = false
  let only: string | undefined
  let skipGenerate = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--out-dir") outDir = argv[++i]!
    else if (a === "--run") run = true
    else if (a === "--only") only = argv[++i]
    else if (a === "--skip-generate") skipGenerate = true
    else if (!a.startsWith("-")) flowsPath = a
    else throw new Error(`unknown flag ${a}`)
  }
  return { flowsPath, outDir, run, only, skipGenerate }
}

function runCmd(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => {
      stdout += d
    })
    child.stderr.on("data", (d) => {
      stderr += d
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`timeout ${cmd} ${args.join(" ")}`))
    }, opts.timeoutMs ?? 60_000)
    child.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function typecheck(file: string): Promise<string | null> {
  const result = await runCmd("npx", ["tsc", ...TSC_ARGS, file], { timeoutMs: 60_000 })
  if (result.code === 0) return null
  return (result.stdout + "\n" + result.stderr).trim() || `tsc exit ${result.code}`
}

function needsLogin(flow: Flow): boolean {
  return flow.actions.some((a) => {
    const url = a.type === "goto" ? a.url : a.evidence.url
    if (!url) return false
    try {
      const path = new URL(url).pathname
      return path !== "/" && path !== ""
    } catch {
      return false
    }
  })
}

function authPreambleRule(doc: FlowsDocument): string {
  if (!doc.auth) return ""
  const parts: string[] = []
  parts.push(`0. Right after connecting, set a desktop viewport — await page.setViewportSize({ width: 1440, height: 900 }) — login controls and headers are routinely hidden below desktop breakpoints.`)
  parts.push(`1. Consent dialogs re-open on navigation until accepted: on the first page load, if a [role="dialog"][aria-modal="true"] is visible, click its ACCEPT-style button (/accept all|accept|agree|got it/i — accepting stores the choice; use /close|dismiss|later/ or Escape only as fallback) and wait for it to detach. Before any later click, if such a dialog is visible again, accept it the same way first — a modal dialog silently intercepts every pointer event on the page.`)
  if (doc.auth.gate) {
    parts.push(`1. Site gate: await page.goto(process.env.TARGET_URL!); if the URL path matches /${doc.auth.gate.urlPattern}/i, fill the first ${doc.auth.gate.input} with process.env.SITE_PASSWORD!, click the first ${doc.auth.gate.submit}, and wait until the path no longer matches.`)
  }
  if (doc.auth.login) {
    const gateStep = doc.auth.gate ? " (after the gate step)" : ""
    parts.push(`${parts.length + 1}. Login${gateStep}: open the login form — if the email input is not already visible, click the visible login control (page.getByText(/^\\s*(log\\s*in|sign\\s*in)\\s*$/i).first()); fill ${doc.auth.login.email} with process.env.AUTH_EMAIL! and the same form's ${doc.auth.login.password} with process.env.AUTH_PASSWORD!; click the form's ${doc.auth.login.submit}; wait for that form to detach, then poll page.context().cookies() until a cookie matching /auth-token/i appears (up to 30s) — that cookie is the logged-in proof.`)
  }
  return `
- This site sits behind auth that the explorer passed using env-provided credentials. EVERY spec begins with this exact preamble, reading values from process.env — never hardcode credentials, never log their values:
${parts.join("\n")}
- Credentials come only from the env vars above; do not take fill values from sibling flows for the auth preamble.`
}

function systemPrompt(doc: FlowsDocument): string {
  return `You write one Playwright spec file for a QA flow.
Rules:
- ESM TypeScript, top-level await, no tsconfig.
- Import playwright-core only. No @playwright/test, no Solari SDK, no other packages.
- Connect with chromium.connectOverCDP(process.env.SOLARI_CDP_ENDPOINT!).
- Navigate using process.env.TARGET_URL! as the site origin (join relative paths against it). Do not hardcode a different host.
- Single async script, not a test() block. console.log("PASS ...") on success. On failure throw or process.exit(1).
- Close the browser in finally. Do not call process.exit on success (the runner must see PASS and exit 0).
- Locators: getByRole / getByText first, CSS ([data-test=...]) as fallback.
- No waitForTimeout / sleep. Use locator.waitFor, expect-style web-first checks (waitForURL, waitFor).
- One flow per file. Deterministic data only from the flow's fill values.
- Assertions must check the flow intent (URL, visible text, cart state), not only that clicks succeeded.
- Postconditions come from the intent, not only from what exploration observed — the observed site may itself be broken. A form-submission flow must end with a visible acknowledgement (text matching /thank|received|confirm/i or equivalent); a checkout flow must verify the page's own arithmetic (displayed total equals displayed subtotal plus displayed tax); a cart-edit flow must verify the header cart badge equals the remaining item count.
- When reading amounts off the page, locate the value element itself (prefer the row/cell's data-test or equivalent attribute) rather than parsing surrounding text. Never treat a label ("Subtotal") or a rate in a label ("Tax (10%)") as an amount; strip currency symbols; parse only the numeric value shown for that row. Within a row's text, the amount is the currency-prefixed token (e.g. /\\$[\\d.,]+/ or the local equivalent) — a row like "Tax (10%)$2.50" contains exactly one amount, 2.50; percentages and concatenated digits from labels are not amounts.
- Text assertions must resolve to exactly one element — Playwright strict mode makes an ambiguous locator (e.g. a /404|not found/i regex matching both the h1 and h2 of a Next.js error page) time out deterministically. Scope the locator (specific heading, section, data-test) or use .first(); for not-found intents, assert on the navigation's HTTP response status first and treat visible text as corroboration only.
- Specs start from a fresh browser. If the flow begins on a post-login page, prepend login using fill values from other flows in the document (never invent credentials).
- If a logout/sidebar link is not visible, open the burger/menu button first.
- After every navigation or click that changes the page, wait for the next locator to be visible before using it.
- Never goto a deep path that requires session state; drive there with UI actions from TARGET_URL.${authPreambleRule(doc)}
- TARGET_URL origin is ${doc.site.origin}.`
}

function userPrompt(doc: FlowsDocument, flow: Flow, priorError?: string): string {
  const loginHint = needsLogin(flow)
    ? "This flow likely needs login first. Reuse username/password fill values from sibling flows."
    : ""
  const err = priorError ? `\nPrevious attempt failed typecheck:\n${priorError}\nFix the code.\n` : ""
  return `${err}Write the spec for this flow via emit_spec.
${loginHint}

Site: ${JSON.stringify(doc.site)}
Pages (locator inventory): ${JSON.stringify(doc.pages.map((p) => ({ url: p.url, title: p.title, forms: p.forms, buttons: p.buttons, navigation: p.navigation })))}
Sibling fill values: ${JSON.stringify(
    doc.flows.flatMap((f) => f.actions.filter((a) => a.type === "fill").map((a) => ({ selector: a.selector, value: a.value }))),
  )}

Flow:
${JSON.stringify(flow, null, 2)}`
}

function takeCode(text: string): string {
  const fence = text.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/)
  if (fence) return fence[1]!.trim() + "\n"
  throw new Error("model output contained no fenced TypeScript code block")
}

// Model calls run through the Claude Code CLI. A subscription setup token
// (ANTHROPIC_AUTH_TOKEN) outranks the API key in the CLI's own precedence;
// scrub the key so the billing mode is deterministic, not precedence-dependent.
if (process.env.ANTHROPIC_AUTH_TOKEN) delete process.env.ANTHROPIC_API_KEY
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.log("NOTE no ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY set; relying on claude login auth")
}

const { flowsPath, outDir, run, only, skipGenerate } = parseArgs(process.argv.slice(2))
const raw = JSON.parse(await readFile(flowsPath, "utf8"))
const schemaErrors = validateFlows(raw)
if (schemaErrors.length) {
  console.log(`FAIL invalid flows: ${schemaErrors.join("; ")}`)
  process.exit(1)
}
const doc = raw as FlowsDocument
await mkdir(outDir, { recursive: true })

// ANTHROPIC_AUTH_TOKEN (a Claude setup token) bills the subscription via
// Bearer auth; ANTHROPIC_API_KEY is the pay-per-call fallback.
const log: string[] = []
const written: string[] = []

const flows = only ? doc.flows.filter((f) => f.id === only) : doc.flows
if (only && flows.length === 0) {
  console.log(`FAIL no flow id=${only}`)
  process.exit(1)
}

async function generateOne(flow: Flow, priorError?: string): Promise<string | null> {
  const file = join(outDir, `${flow.id}.spec.ts`)
  let lastErr = priorError
  for (let attempt = 0; attempt <= 2; attempt++) {
    let code: string
    try {
      code = takeCode(await callModel(systemPrompt(doc), userPrompt(doc, flow, lastErr)))
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      console.log(`  attempt ${attempt} no code: ${lastErr}`)
      continue
    }
    if (code.includes("@solarisdk") || code.includes("@playwright/test")) {
      lastErr = "spec imported a forbidden package"
      console.log(`  attempt ${attempt}: ${lastErr}`)
      continue
    }
    if (!code.includes("connectOverCDP") || !code.includes("SOLARI_CDP_ENDPOINT")) {
      lastErr = "spec missing connectOverCDP / SOLARI_CDP_ENDPOINT"
      console.log(`  attempt ${attempt}: ${lastErr}`)
      continue
    }
    await writeFile(file, code)
    const tscErr = await typecheck(file)
    if (!tscErr) {
      console.log(`  wrote ${file} attempt=${attempt}`)
      return file
    }
    lastErr = tscErr
    console.log(`  attempt ${attempt} tsc failed: ${tscErr.slice(0, 400)}`)
  }
  return null
}

if (skipGenerate) {
  for (const flow of flows) written.push(join(outDir, `${flow.id}.spec.ts`))
} else {
  // A full generation owns the out-dir: remove specs left over from earlier
  // generations (a stale spec still executes and its failures masquerade as
  // findings of this run). --only regenerates in place and sweeps nothing —
  // sweeping there would delete sibling specs from other --only runs.
  if (!only) {
    const existing = (await readdir(outDir).catch(() => [] as string[])).filter((f) => f.endsWith(".spec.ts"))
    const currentIds = new Set(doc.flows.map((f) => f.id))
    for (const f of existing) {
      const id = f.replace(/\.spec\.ts$/, "")
      if (!currentIds.has(id)) {
        await rm(join(outDir, f), { force: true })
        log.push(`STALE-REMOVED ${f}: flow id not in current flows.json`)
      }
    }
  }
  for (const flow of flows) {
    console.log(`generate ${flow.id}`)
      const file = await generateOne(flow)
      if (file) written.push(file)
      else {
        const note = `DROP ${flow.id}: failed typecheck after 2 retries`
        console.log(note)
        log.push(note)
        // A dropped spec must not linger in the out-dir: execute globs *.spec.ts,
        // and a deterministically crashing spec would reproduce and launder
        // itself into a finding.
        await rm(join(outDir, `${flow.id}.spec.ts`), { force: true })
      }
  }
}

const logPath = join(outDir, "generate.log")
await writeFile(logPath, log.join("\n") + (log.length ? "\n" : ""))
console.log(`generated ${written.length}/${flows.length} specs dropped=${log.length}`)

if (written.length === 0) {
  console.log("FAIL no specs generated")
  process.exit(1)
}

if (!run) {
  console.log(`PASS wrote ${written.length} specs to ${outDir}`)
  process.exit(0)
}

if (!process.env.SOLARI_API_KEY) {
  console.log("FAIL SOLARI_API_KEY is not set")
  process.exit(1)
}

const target = doc.site.url
const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY })
let failed = 0
try {
  for (const file of written) {
    const session = await solari.sessions.create()
    console.log(`run ${file} session=${session.id}`)
    try {
      const result = await runCmd("npx", ["tsx", file], {
        env: {
          ...process.env,
          SOLARI_CDP_ENDPOINT: session.cdpEndpoint,
          TARGET_URL: target,
        },
        timeoutMs: 90_000,
      })
      const out = (result.stdout + result.stderr).trim()
      console.log(out)
      if (result.code !== 0 || !/\bPASS\b/.test(out)) {
        console.log(`FAIL ${file} exit=${result.code}`)
        const id = file.replace(/^.*\//, "").replace(/\.spec\.ts$/, "")
        const flow = doc.flows.find((f) => f.id === id)
        if (flow) {
          console.log(`regenerate ${id} after runtime failure`)
          const regenerated = await generateOne(flow, out.slice(0, 1500))
          if (!regenerated) {
            failed++
          } else {
            const session2 = await solari.sessions.create()
            try {
              const retry = await runCmd("npx", ["tsx", regenerated], {
                env: {
                  ...process.env,
                  SOLARI_CDP_ENDPOINT: session2.cdpEndpoint,
                  TARGET_URL: target,
                },
                timeoutMs: 90_000,
              })
              const retryOut = (retry.stdout + retry.stderr).trim()
              console.log(retryOut)
              if (retry.code !== 0 || !/\bPASS\b/.test(retryOut)) {
                console.log(`FAIL ${regenerated} after regenerate exit=${retry.code}`)
                failed++
              } else {
                console.log(`PASS ${regenerated}`)
              }
            } finally {
              await solari.sessions.releaseAndWait(session2.id)
            }
          }
        } else {
          failed++
        }
      } else {
        console.log(`PASS ${file}`)
      }
    } finally {
      await solari.sessions.releaseAndWait(session.id)
    }
  }
} finally {
  await solari.close()
}

if (failed || log.length) {
  console.log(`FAIL run failed=${failed} dropped=${log.length} written=${written.length}`)
  process.exit(1)
}
console.log(`PASS ${written.length} specs green against ${target}`)
