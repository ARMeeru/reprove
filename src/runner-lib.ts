// Shared machinery for execute.ts and reverify.ts. Encodes the Spike-C constraints:
// base template + in-guest Node 22, REST POST /sessions for the upstream CDP endpoint
// (the SDK's session.cdpEndpoint is a loopback proxy), API key never enters the guest.
import { Solari, SolariError } from "@solarisdk/browser"
import { SolariClient } from "@solarisdk/sdk"
import type { Sandbox } from "@solarisdk/sdk"
import { join } from "node:path"

export const GUEST_PATH = "/usr/local/bin:/usr/bin:/bin"
export const GUEST_DIR = "/tmp/reprove-spec"

const NODE_INSTALL = `set -eu
arch=$(uname -m)
case "$arch" in
  x86_64) nodearch=x64 ;;
  aarch64|arm64) nodearch=arm64 ;;
  *) echo "FAIL unsupported arch $arch"; exit 1 ;;
esac
curl -fsSL "https://nodejs.org/dist/v22.18.0/node-v22.18.0-linux-\${nodearch}.tar.xz" -o /tmp/node.tar.xz
tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
/usr/local/bin/node -v
`

export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export type Clients = { browser: Solari; pt: SolariClient }

export function makeClients(): Clients {
  if (!process.env.SOLARI_API_KEY) throw new Error("SOLARI_API_KEY is not set")
  return {
    browser: new Solari({ apiKey: process.env.SOLARI_API_KEY }),
    pt: new SolariClient({ apiKey: process.env.SOLARI_API_KEY }),
  }
}

export async function killLeftoverSandboxes(pt: SolariClient): Promise<void> {
  for await (const leftover of pt.sandboxes.listAll()) {
    if (leftover.state !== "gone") {
      await pt.sandboxes.kill(leftover.sandboxId)
      console.log(`killed leftover sandbox id=${leftover.sandboxId} state=${leftover.state}`)
    }
  }
}

export async function createSandboxWithNode(pt: SolariClient): Promise<Sandbox> {
  const box = await pt.sandboxes.create({
    template: "base",
    timeoutMs: 10 * 60_000,
    lifecycle: { onTimeout: "kill" },
  })
  await box.connect()
  const install = await box.commands.run("sh", {
    args: ["-c", NODE_INSTALL],
    timeoutMs: 120_000,
  })
  if (install.exitCode !== 0) {
    throw new Error(`in-guest Node 22 install failed: ${install.stderr.slice(0, 400)}`)
  }
  await box.files.mkdir(GUEST_DIR)
  return box
}

export type SpecRun = {
  ok: boolean
  timedOut: boolean
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
}

export async function runSpecInSandbox(
  box: Sandbox,
  specFile: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpecRun> {
  try {
    const res = await box.commands.run("node", {
      args: ["node_modules/tsx/dist/cli.mjs", specFile],
      cwd: GUEST_DIR,
      env: { PATH: GUEST_PATH, ...env },
      timeoutMs,
    })
    const ok = res.exitCode === 0 && /\bPASS\b/.test(res.stdout + res.stderr)
    return { ok, timedOut: false, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr }
  } catch (err) {
    // generate.ts let this reject and kill the whole suite; here a timeout or
    // transport failure is one spec's failure, classified for reverify.
    return {
      ok: false,
      timedOut: true,
      exitCode: null,
      stdout: "",
      stderr: "",
      error: errMsg(err),
    }
  }
}

export type RecordedSession = { id: string; cdpUrl: string }

export async function createRecordedSession(browser: Solari): Promise<RecordedSession> {
  const res = await browser.request("POST", "/sessions", { recording: true })
  if (!res.ok) {
    throw new Error(`POST /sessions ${res.status} ${(await res.text()).slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    sessionId?: string
    wsEndpoint?: string
    cdpEndpoint?: string
  }
  if (!data.sessionId) throw new Error("POST /sessions missing sessionId")
  let cdp = data.cdpEndpoint
  if (!cdp && data.wsEndpoint) {
    const u = new URL(data.wsEndpoint)
    if (u.pathname.startsWith("/ws/")) u.pathname = "/cdp/" + u.pathname.slice("/ws/".length)
    cdp = u.toString()
  }
  if (!cdp) throw new Error("POST /sessions missing cdp/ws endpoint")
  const host = new URL(cdp).hostname
  if (host === "127.0.0.1" || host === "localhost") {
    throw new Error("REST /sessions returned a loopback endpoint; refusing to pass into guest")
  }
  return { id: data.sessionId, cdpUrl: cdp }
}

export async function pollReplay(
  browser: Solari,
  sessionId: string,
  attempts = 10,
  delayMs = 3000,
): Promise<Uint8Array | null> {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await browser.sessions.downloadReplay(sessionId)
    } catch (err) {
      const status = err instanceof SolariError ? err.status : undefined
      if (status === 404 && i < attempts) {
        await new Promise((r) => setTimeout(r, delayMs))
        continue
      }
      throw err
    }
  }
  return null
}

// Shared by execute and reverify so the guest environment is prepared identically
// in both — drift here would masquerade as "did not reproduce".
export async function uploadSpecsAndInstall(
  box: Sandbox,
  specFiles: string[],
  specsDir: string,
  readFileUtf8: (p: string) => Promise<string>,
): Promise<void> {
  await box.files.write(join(GUEST_DIR, "package.json"), `{ "type": "module" }\n`)
  for (const f of specFiles) {
    await box.files.write(join(GUEST_DIR, f), await readFileUtf8(join(specsDir, f)))
  }
  const install = await box.commands.run("npm", {
    args: ["install", "--omit=dev", "playwright-core", "tsx"],
    cwd: GUEST_DIR,
    env: { PATH: GUEST_PATH },
    timeoutMs: 5 * 60_000,
  })
  if (install.exitCode !== 0) throw new Error(`guest npm install failed: ${install.stderr.slice(0, 400)}`)
}
