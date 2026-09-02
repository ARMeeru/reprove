// Stage 5: self-contained HTML report. Every finding shows its spec, failure output,
// and ALL reproduction runs' replays inline (bundled rrweb-player, events embedded —
// no external network dependencies). Always written locally; --serve additionally
// hosts it on a Solari sandbox port preview for a bounded window.
// Usage: npx tsx src/report.ts --run runs/<dir> [--flows flows.json] [--serve] [--serve-minutes 30]
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { SolariClient } from "@solarisdk/sdk"

// rrweb-player's exports map hides its umd/dist files from the module resolver,
// so locate them by path from this module instead of require.resolve.
const PLAYER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../node_modules/rrweb-player")

function parseArgs(argv: string[]) {
  const out: { run?: string; flows?: string; serve?: boolean; serveMinutes?: number } = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--run") out.run = argv[++i]
    else if (a === "--flows") out.flows = argv[++i]
    else if (a === "--serve") out.serve = true
    else if (a === "--serve-minutes") out.serveMinutes = Number(argv[++i])
    else throw new Error(`unknown flag ${a}`)
  }
  if (!out.run) throw new Error("--run <dir> is required")
  if (!out.serveMinutes) out.serveMinutes = 30
  return out as { run: string; flows?: string; serve: boolean; serveMinutes: number }
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function parseEvents(text: string): unknown[] {
  const events: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (t) events.push(JSON.parse(t))
  }
  return events
}

const { run: runDir, flows: flowsPath, serve, serveMinutes } = parseArgs(process.argv.slice(2))

type ExecResults = { target: string; startedAt: string; results: { spec: string; pass: boolean; stdoutTail: string; stderrTail: string; sessionId: string; durationMs: number }[] }
type Verdicts = {
  target: string
  reran: number
  reproduced: number
  didNotReproduce: number
  findings: { spec: string; runs: { sessionId: string; pass: boolean }[]; replays: string[]; stability: string }[]
  flakes: { spec: string; runs: { sessionId: string; pass: boolean }[] }[]
}

const execDoc = JSON.parse(await readFile(join(runDir, "results.json"), "utf8")) as ExecResults
const verdicts = JSON.parse(await readFile(join(runDir, "verdicts.json"), "utf8")) as Verdicts

const intents = new Map<string, string>()
if (flowsPath) {
  const flows = JSON.parse(await readFile(flowsPath, "utf8")) as { flows: { id: string; intent: string }[] }
  for (const f of flows.flows) intents.set(f.id, f.intent)
}

const playerJs = (await readFile(join(PLAYER_ROOT, "umd/rrweb-player.min.js"), "utf8")).replace(
  /<\/script/gi,
  "<\\/script",
)
const playerCss = await readFile(join(PLAYER_ROOT, "dist/style.css"), "utf8")

type Embedded = { id: string; spec: string; label: string; events: unknown[] }
const embedded: Embedded[] = []
for (const f of verdicts.findings) {
  for (let i = 0; i < f.replays.length; i++) {
    const text = await readFile(f.replays[i]!, "utf8").catch(() => "")
    if (text) embedded.push({ id: `r-${embedded.length}`, spec: f.spec, label: `reproduction ${i + 1}`, events: parseEvents(text) })
  }
}

const totalFailures = execDoc.results.filter((r) => !r.pass).length
const browserMinutes =
  execDoc.results.reduce((n, r) => n + r.durationMs, 0) / 60000
const costUsd = (browserMinutes / 60) * 0.15

function specSection(f: Verdicts["findings"][number]): string {
  const flowId = f.spec.replace(/\.spec\.ts$/, "")
  const intent = intents.get(flowId) ?? "(intent not recorded)"
  const exec = execDoc.results.find((r) => r.spec === f.spec)
  const failureOut = ((exec?.stdoutTail ?? "") + "\n" + (exec?.stderrTail ?? "")).trim()
  const replays = f.replays
    .map((_, i) => {
      const id = embedded.find((e) => e.spec === f.spec && e.label === `reproduction ${i + 1}`)?.id
      return id ? `<div class="replay"><div class="label">reproduction ${i + 1}</div><div id="${id}"></div></div>` : ""
    })
    .join("")
  return `<section class="finding">
  <h2>Finding: ${esc(flowId)}</h2>
  <p class="intent">${esc(intent)}</p>
  <p>sessions: ${f.runs.map((r) => `<code>${esc(r.sessionId.slice(0, 24))}…</code> ${r.pass ? "pass" : "fail"}`).join(" · ")} — ${f.stability}</p>
  <pre class="failure">${esc(failureOut.slice(-2500))}</pre>
  ${replays}
</section>`
}

// Escape < so recorded DOM snapshots (which can contain literal </script>) cannot
// terminate the script block early in the reviewer's browser. JSON permits \u003c.
const replaysJson = JSON.stringify(embedded.map((e) => ({ id: e.id, events: e.events }))).replace(
  /</g,
  "\\u003c",
)

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>reprove report — ${esc(execDoc.target)}</title>
<style>
${playerCss}
body{font-family:system-ui,sans-serif;max-width:60rem;margin:0 auto;padding:1.5rem;color:#1a1a1a}
header{border-bottom:2px solid #1a1a1a;padding-bottom:1rem}
.rateline{font-size:1.15rem;margin:.5rem 0}
.finding{border:1px solid #ddd;border-radius:8px;padding:1rem;margin:1.5rem 0}
.intent{color:#555}
pre.failure{background:#f6f6f6;border:1px solid #eee;padding:.75rem;white-space:pre-wrap;word-break:break-word;font-size:.8rem}
.replay{margin-top:1rem}
.replay .label{font-weight:600;margin-bottom:.25rem}
footer{margin-top:2rem;color:#555;font-size:.85rem}
</style></head><body>
<header>
  <h1>reprove — findings, not suspicions</h1>
  <p>target <code>${esc(execDoc.target)}</code> · run ${esc(execDoc.startedAt)}</p>
  <p class="rateline">${totalFailures} failures, ${verdicts.reproduced} reproduced in an independent session, ${verdicts.didNotReproduce} did not reproduce.</p>
  <p>${execDoc.results.length} specs · every finding above failed in ≥2 independent fresh browser sessions and ships its session replays.</p>
</header>
${verdicts.findings.map(specSection).join("\n")}
${verdicts.flakes.length ? `<section><h2>Did not reproduce (excluded from findings)</h2><ul>${verdicts.flakes
  .map((f) => `<li><code>${esc(f.spec)}</code> — failed once, passed on independent rerun</li>`)
  .join("")}</ul></section>` : ""}
<footer>
  Browser time this run ≈ ${browserMinutes.toFixed(1)} min (× console-verified $0.15/hr ≈ $${costUsd.toFixed(3)}). Sandbox minutes not priced: hourly rate unread in console.
  Report is self-contained: replays are embedded rrweb events rendered by a bundled player, no network needed.
</footer>
<script>${playerJs}</script>
<script>
window.__REPLAYS__ = ${replaysJson};
window.addEventListener("DOMContentLoaded", function () {
  var w = window;
  var Ctor = (w.rrwebPlayer && w.rrwebPlayer.default) || w.rrwebPlayer;
  if (!Ctor) { document.body.insertAdjacentHTML("beforeend", "<p>player failed to load</p>"); return; }
  window.__REPLAYS__.forEach(function (r) {
    new Ctor({ target: document.getElementById(r.id), props: { events: r.events, autoPlay: false, showController: true } });
  });
});
</script>
</body></html>
`

const reportPath = join(runDir, "report.html")
await writeFile(reportPath, html)
console.log(`report written ${reportPath} (${(html.length / 1024).toFixed(0)} KB, ${embedded.length} replays embedded)`)

if (serve) {
  if (!process.env.SOLARI_API_KEY) throw new Error("SOLARI_API_KEY is not set")
  const pt = new SolariClient({ apiKey: process.env.SOLARI_API_KEY })
  let sbx: Awaited<ReturnType<typeof pt.sandboxes.create>> | undefined
  try {
    sbx = await pt.sandboxes.create({ template: "base", timeoutMs: (serveMinutes + 5) * 60_000, lifecycle: { onTimeout: "kill" } })
    await sbx.connect()
    await sbx.files.mkdir("/tmp/site")
    await sbx.files.write("/tmp/site/index.html", html)
    await sbx.commands.run("sh", { args: ["-c", "cd /tmp/site && nohup python3 -m http.server 3000 >/dev/null 2>&1 &"] })
    const preview = await sbx.previewUrl(3000)
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      const res = await fetch(preview.url)
      if (res.ok) break
    }
    console.log(`PREVIEW ${preview.url} (alive ~${serveMinutes} min; report.html is also saved locally)`)
    await new Promise((r) => setTimeout(r, serveMinutes * 60_000))
  } finally {
    if (sbx) await sbx.kill().catch(() => {})
  }
}
