import { writeFile } from "node:fs/promises"
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { Solari } from "@solarisdk/browser"
import { validateFlows, type AuthBootstrap, type FlowsDocument, type PageInventory } from "./schema.ts"

const MODEL = "claude-sonnet-5"
const WALL_MS = 10 * 60_000

function parseArgs(argv: string[]) {
  let url = ""
  let maxPages = 10
  let maxActions = 40
  let out = "flows.json"
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "--max-pages") maxPages = Number(argv[++i])
    else if (a === "--max-actions") maxActions = Number(argv[++i])
    else if (a === "--out") out = argv[++i]!
    else if (!a.startsWith("-")) url = a
    else throw new Error(`unknown flag ${a}`)
  }
  if (!url || !Number.isFinite(maxPages) || !Number.isFinite(maxActions)) {
    throw new Error("usage: npx tsx src/explore.ts <url> [--max-pages N] [--max-actions N] [--out path]")
  }
  return { url, maxPages, maxActions, out }
}

function originOf(url: string): string {
  return new URL(url).origin
}

function pageKey(url: string): string {
  const u = new URL(url)
  u.hash = ""
  return u.toString()
}

type Digest = {
  url: string
  title: string
  headings: string[]
  bodyText: string
  forms: PageInventory["forms"]
  buttons: PageInventory["buttons"]
  links: PageInventory["links"]
  navigation: PageInventory["navigation"]
}

// tsx/esbuild injects __name into function expressions; Playwright serializes
// page.evaluate callbacks into the browser where __name does not exist.
const DIGEST_FN = new Function(
  "limit",
  `const trim = (s, n = 80) => String(s || "").replace(/\\s+/g, " ").trim().slice(0, n);
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/"/g, '\\\\"'));
  const selector = (el) => {
    const dt = el.getAttribute("data-test");
    if (dt) return '[data-test="' + esc(dt) + '"]';
    const tid = el.getAttribute("data-testid");
    if (tid) return '[data-testid="' + esc(tid) + '"]';
    if (el.id) return "#" + esc(el.id);
    const name = el.getAttribute("name");
    if (name) return el.tagName.toLowerCase() + '[name="' + esc(name) + '"]';
    const aria = el.getAttribute("aria-label");
    if (aria) return el.tagName.toLowerCase() + '[aria-label="' + esc(aria) + '"]';
    const text = trim(el.textContent || "", 40);
    if (text) return el.tagName.toLowerCase() + ':has-text("' + text.replace(/"/g, '\\\\"') + '")';
    return el.tagName.toLowerCase();
  };
  const interactive = (el, extra) => Object.assign({
    selector: selector(el),
    text: trim(el.getAttribute("aria-label") || el.textContent || el.getAttribute("value") || ""),
  }, extra || {});
  const forms = Array.from(document.querySelectorAll("form")).slice(0, limit).map((form) => {
    const fields = Array.from(form.querySelectorAll("input, select, textarea")).map((field) => {
      const label = field.labels && field.labels[0] ? trim(field.labels[0].innerText) : undefined;
      const row = {
        name: field.name || field.id || field.getAttribute("data-test") || field.type || "field",
        type: field.type || field.tagName.toLowerCase(),
        selector: selector(field),
      };
      if (label) row.label = label;
      return row;
    });
    const submitEl = form.querySelector("[type=submit], button:not([type]), [data-test=login-button]");
    const row = { selector: selector(form), fields };
    if (submitEl) row.submit = selector(submitEl);
    return row;
  });
  if (forms.length === 0) {
    const orphans = Array.from(document.querySelectorAll("input, select, textarea")).slice(0, limit);
    if (orphans.length) {
      const submitEl = document.querySelector("[type=submit], button");
      const row = {
        selector: "body",
        fields: orphans.map((field) => ({
          name: field.name || field.id || field.getAttribute("data-test") || field.type || "field",
          type: field.type || field.tagName.toLowerCase(),
          selector: selector(field),
        })),
      };
      if (submitEl) row.submit = selector(submitEl);
      forms.push(row);
    }
  }
  const buttons = Array.from(document.querySelectorAll("button, [role=button], input[type=submit], input[type=button]"))
    .slice(0, limit)
    .map((el) => interactive(el, { role: "button" }));
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, limit)
    .map((el) => interactive(el, { href: el.href, role: "link" }));
  const navigation = Array.from(document.querySelectorAll("nav a, [role=navigation] a, .bm-item-list a"))
    .slice(0, limit)
    .map((el) => interactive(el, { href: el.href, role: "link" }));
  const headings = Array.from(document.querySelectorAll("h1, h2, h3")).slice(0, 8).map((el) => trim(el.textContent || ""));
  return {
    url: location.href,
    title: document.title,
    headings,
    bodyText: trim(document.body && document.body.innerText || "", 600),
    forms,
    buttons,
    links,
    navigation,
  };`,
)

async function digest(page: { evaluate: (fn: Function, arg: number) => Promise<Digest> }, cap: number) {
  return page.evaluate(DIGEST_FN, cap)
}

function asPage(d: Awaited<ReturnType<typeof digest>>): PageInventory {
  return {
    url: d.url,
    title: d.title,
    forms: d.forms,
    buttons: d.buttons,
    links: d.links,
    navigation: d.navigation,
  }
}

function locator(page: { getByRole: Function; locator: Function }, selector: string) {
  const role = selector.match(/^role=([a-z]+)\[name=(?:"([^"]+)"|'([^']+)')\]$/i)
  if (role) return page.getByRole(role[1], { name: role[2] || role[3] })
  return page.locator(selector)
}

if (!process.env.SOLARI_API_KEY) {
  console.log("FAIL SOLARI_API_KEY is not set")
  process.exit(1)
}
// Model calls run through the Claude Code CLI (Agent SDK transport): a
// subscription setup token (ANTHROPIC_AUTH_TOKEN) is honored natively; the
// API key is scrubbed when a token is present so billing mode is deterministic.
if (process.env.ANTHROPIC_AUTH_TOKEN) delete process.env.ANTHROPIC_API_KEY
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.log("NOTE no ANTHROPIC_AUTH_TOKEN/ANTHROPIC_API_KEY set; relying on claude login auth")
}

const { url: startUrl, maxPages, maxActions, out } = parseArgs(process.argv.slice(2))
const origin = originOf(startUrl)
const started = Date.now()
const deadline = started + WALL_MS
const pages = new Map<string, PageInventory>()
let actions = 0
let sessionId = ""

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY })

function remaining() {
  return {
    actionsLeft: maxActions - actions,
    pages: pages.size,
    maxPages,
    msLeft: deadline - Date.now(),
  }
}

function overBudget() {
  return Date.now() >= deadline || actions >= maxActions
}

const system = `You explore one website for QA. Stay on origin ${origin}. Never follow off-origin URLs.
Tools: goto, read_page, list_interactive, click, fill.
Use only values visible on the page (demo credentials printed on a login screen are allowed).
Prefer data-test / role+name selectors from list_interactive.
Goal: visit the important pages and understand login, catalog, cart, checkout, forms, and navigation.
Stop when you have seen enough to propose at least 3 distinct user flows, or when told the budget is exhausted.
Do not dump raw HTML. Do not leave the origin.`

try {
  const browser = await solari.launch()
  sessionId = browser.id
  console.log(`session=${sessionId} origin=${origin}`)
  const page = await browser.newPage()
  try {
    const snapshot = async () => {
      const d = await digest(page, 30)
      pages.set(pageKey(d.url), asPage(d))
      return d
    }

    // Auth bootstrap (optional): pass a site password gate and/or an
    // email/password login with env-provided credentials BEFORE the agent
    // explores. Secrets stay out of the model context and out of flows.json;
    // only the selectors that worked are recorded for the spec generator.
    const auth: AuthBootstrap = {}
    const sitePassword = process.env.SITE_PASSWORD || ""
    const authEmail = process.env.AUTH_EMAIL || ""
    const authPassword = process.env.AUTH_PASSWORD || ""
    const GATE_INPUT = 'input[type="password"]'
    const GATE_SUBMIT = 'form button[type="submit"], form button:not([type="button"])'
    const LOGIN_EMAIL = 'input[name="email"], input[type="email"]'
    // Consent/promo dialogs mount over the page and intercept pointer events
    // (a Radix modal eats the gate submit click otherwise). Accept or escape
    // them before interacting with anything else.
    const dismissDialogs = async () => {
      const dialog = page.locator('[role="dialog"][aria-modal="true"]').first()
      for (let i = 0; i < 3; i++) {
        // consent dialogs mount client-side after hydration; give a late
        // mount a moment before concluding the coast is clear
        await dialog.waitFor({ state: "visible", timeout: 2500 }).catch(() => {})
        if (!(await dialog.isVisible().catch(() => false))) return
        const accept = dialog
          .locator("button")
          .filter({ hasText: /accept all|accept|agree|got it|close|dismiss|later/i })
          .first()
        if (await accept.isVisible().catch(() => false)) {
          await accept.click({ timeout: 5000 }).catch(() => {})
        } else {
          await page.keyboard.press("Escape").catch(() => {})
          await page.waitForTimeout(500)
        }
        await dialog.waitFor({ state: "detached", timeout: 5000 }).catch(() => {})
      }
    }
    // Login UIs are routinely gated behind desktop breakpoints; the header
    // login button only exists from 1280px up on this class of site.
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
    await dismissDialogs()
    // A site gate is detected structurally, not by URL pattern: the landing
    // page offers a visible password field and no email field (login pages
    // ask for both), which describes any password-only gate.
    const gatePath = new URL(page.url()).pathname
    const gateIsVisible =
      (await page.locator(GATE_INPUT).first().isVisible().catch(() => false)) &&
      !(await page.locator(LOGIN_EMAIL).first().isVisible().catch(() => false))
    if (gateIsVisible) {
      if (!sitePassword) {
        throw new Error(`landed on a site gate (${page.url()}) but SITE_PASSWORD is not set`)
      }
      await page.locator(GATE_INPUT).first().fill(sitePassword, { timeout: 10_000 })
      await dismissDialogs()
      await page.locator(GATE_SUBMIT).first().click({ timeout: 10_000 })
      // "load" can hang on third-party scripts in a cloud browser; the gate
      // page itself hard-navigates on success, so domcontentloaded is enough.
      try {
        await page.waitForURL((u) => u.pathname !== gatePath, {
          timeout: 30_000,
          waitUntil: "domcontentloaded",
        })
      } catch (err) {
        const visible = await page
          .locator("text=/incorrect|error|wrong|invalid|try again/i")
          .first()
          .textContent({ timeout: 2_000 })
          .catch(() => "")
        throw new Error(
          `site gate did not navigate past ${page.url()} — ${visible?.trim() || "no visible error"}`,
        )
      }
      await snapshot()
      auth.gate = { urlPattern: gatePath.replace(/^\//, ""), input: GATE_INPUT, submit: GATE_SUBMIT }
      console.log(`bootstrap: site gate passed -> ${page.url()}`)
    } else {
      await snapshot()
    }
    if (authEmail && authPassword) {
      await dismissDialogs()
      const email = page.locator(LOGIN_EMAIL).first()
      const trigger = page.getByText(/^\s*(log\s*in|sign\s*in)\s*$/i).first()
      // Env credentials are an offer, not an instruction: a site with no
      // login affordance at all (an open demo, a marketing site) is
      // explored logged out rather than failing the run.
      const triggerVisible = await trigger.isVisible().catch(() => false)
      const emailVisible = await email.isVisible().catch(() => false)
      if (!triggerVisible && !emailVisible) {
        console.log("bootstrap: no login affordance found; continuing logged out")
      } else {
        if (!emailVisible) {
          // Not every login control is a semantic button or link (one observed
          // site renders it as styled text), so match on the visible label.
          await trigger.click({ timeout: 10_000 })
        }
        await email.waitFor({ state: "visible", timeout: 15_000 })
        await email.fill(authEmail)
        const form = email.locator("xpath=ancestor::form").first()
        await form.locator('input[type="password"]').first().fill(authPassword)
        // no dialog dismissal here: the login modal itself is aria-modal
        await form.locator('button[type="submit"], button:not([type="button"])').first().click()
        await form.waitFor({ state: "detached", timeout: 45_000 })
        // The definitive logged-in signal is the auth session cookie; a closed
        // modal alone can also mean a validation round-trip.
        let authed = false
        for (let i = 0; i < 15 && !authed; i++) {
          authed = (await page.context().cookies()).some((c) => /auth-token/i.test(c.name))
          if (!authed) await page.waitForTimeout(2000)
        }
        if (!authed) {
          throw new Error("login form submitted but no auth session cookie appeared within 30s")
        }
        await page.waitForLoadState("domcontentloaded").catch(() => {})
        auth.login = {
          trigger: 'getByText(/^\\s*(log\\s*in|sign\\s*in)\\s*$/i)',
          email: LOGIN_EMAIL,
          password: 'input[type="password"]',
          submit: 'button[type="submit"]',
        }
        await snapshot()
        console.log(`bootstrap: logged in -> ${page.url()}`)
      }
    }

    // The agent loop is Claude Code's: the explore tools ride an in-process
    // MCP server, and the model drives them until it calls emit_flows.
    let emitted: FlowsDocument | undefined
    const text = (obj: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(obj) }] })
    const toolError = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`tool error: ${msg}`)
      return { content: [{ type: "text" as const, text: JSON.stringify({ error: msg, ...remaining() }) }], isError: true }
    }

    const assemble = (flows: unknown): FlowsDocument => {
      const observed = [...pages.values()]
      if (observed.length === 0) throw new Error("no pages inventoried; browser tools never succeeded")
      const doc: FlowsDocument = {
        site: {
          url: startUrl,
          origin,
          title: observed[0]?.title,
          exploredAt: new Date().toISOString(),
        },
        ...(Object.keys(auth).length ? { auth } : {}),
        pages: observed,
        flows: flows as FlowsDocument["flows"],
      }
      const errors = validateFlows(doc)
      if (errors.length) throw new Error(errors.join("; "))
      if (doc.flows.length < 3) throw new Error(`need at least 3 flows, got ${doc.flows.length}`)
      return doc
    }

    const evidenceShape = {
      url: z.string(),
      selector: z.string().optional(),
      observedText: z.string().optional(),
    }
    const mcpServer = createSdkMcpServer({
      name: "reprove",
      version: "1.0.0",
      tools: [
        tool("goto", "Navigate the browser to a same-origin URL.", { url: z.string() }, async ({ url }) => {
          try {
            if (Date.now() >= deadline) return text({ error: "wall-clock budget exhausted" })
            let abs: URL
            try {
              abs = new URL(url, page.url() || startUrl)
            } catch {
              return text({ error: "invalid url" })
            }
            if (abs.origin !== origin) return text({ error: "off-origin blocked", origin })
            const key = pageKey(abs.toString())
            if (!pages.has(key) && pages.size >= maxPages) {
              return text({ error: "max-pages reached", ...remaining() })
            }
            if (overBudget()) return text({ error: "action budget exhausted", ...remaining() })
            actions++
            await page.goto(abs.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 })
            if (originOf(page.url()) !== origin) {
              await page.goto(startUrl, { waitUntil: "domcontentloaded" })
              return text({ error: "navigation left origin; returned to start" })
            }
            const d = await snapshot()
            console.log(`goto ${d.url} actions=${actions} pages=${pages.size}`)
            return text({ ok: true, url: d.url, title: d.title, ...remaining() })
          } catch (err) {
            return toolError(err)
          }
        }),
        tool("read_page", "DOM digest of the current page: title, headings, text, forms, buttons, links.", {}, async () => {
          try {
            const d = await snapshot()
            return text({ ...d, ...remaining() })
          } catch (err) {
            return toolError(err)
          }
        }),
        tool("list_interactive", "Interactive elements on the current page with selectors.", {}, async () => {
          try {
            const d = await digest(page, 40)
            pages.set(pageKey(d.url), asPage(d))
            return text({ url: d.url, forms: d.forms, buttons: d.buttons, links: d.links, navigation: d.navigation, ...remaining() })
          } catch (err) {
            return toolError(err)
          }
        }),
        tool("click", "Click the element matching a selector.", { selector: z.string() }, async ({ selector }) => {
          try {
            if (overBudget()) return text({ error: "action budget exhausted", ...remaining() })
            actions++
            await locator(page, selector).first().click({ timeout: 10_000 })
            await page.waitForLoadState("domcontentloaded").catch(() => {})
            if (originOf(page.url()) !== origin) {
              await page.goBack().catch(() => page.goto(startUrl, { waitUntil: "domcontentloaded" }))
              return text({ error: "click left origin; navigated back", ...remaining() })
            }
            const d = await snapshot()
            console.log(`click ${selector} -> ${d.url} actions=${actions}`)
            return text({ ok: true, url: d.url, title: d.title, ...remaining() })
          } catch (err) {
            return toolError(err)
          }
        }),
        tool("fill", "Fill an input matching a selector.", { selector: z.string(), value: z.string() }, async ({ selector, value }) => {
          try {
            if (overBudget()) return text({ error: "action budget exhausted", ...remaining() })
            actions++
            await locator(page, selector).first().fill(value, { timeout: 10_000 })
            console.log(`fill ${selector} actions=${actions}`)
            return text({ ok: true, ...remaining() })
          } catch (err) {
            return toolError(err)
          }
        }),
        tool("emit_flows", "Submit at least 3 QA flows derived from the observed pages. Validating ends the exploration; fix and re-call if validation fails.", {
          flows: z.array(z.looseObject({
            id: z.string(),
            intent: z.string(),
            evidence: z.object(evidenceShape),
            actions: z.array(z.looseObject({
              type: z.enum(["goto", "click", "fill"]),
              url: z.string().optional(),
              selector: z.string().optional(),
              value: z.string().optional(),
              evidence: z.object(evidenceShape),
            })).min(1),
          })),
        }, async ({ flows }) => {
          try {
            emitted = assemble(flows)
            console.log(`emit_flows accepted: ${emitted.flows.length} flows`)
            return text({ ok: true, flows: emitted.flows.length })
          } catch (err) {
            return toolError(err)
          }
        }),
      ],
    })

    const allowedTools = [
      "mcp__reprove_goto",
      "mcp__reprove_read_page",
      "mcp__reprove_list_interactive",
      "mcp__reprove_click",
      "mcp__reprove_fill",
      "mcp__reprove_emit_flows",
    ]
    const abort = new AbortController()
    const wall = setTimeout(() => abort.abort(), Math.max(1_000, deadline - Date.now()))
    try {
      for await (const message of query({
        prompt: `Explore ${startUrl} with the reprove tools. Start with goto then list_interactive. Visit the important pages and understand login, catalog, product pages, cart/purchase affordances, forms, and navigation. When you have seen enough to propose at least 3 distinct user flows, call emit_flows.`,
        options: {
          model: MODEL,
          systemPrompt: system,
          mcpServers: { reprove: mcpServer },
          allowedTools,
          tools: allowedTools,
          permissionMode: "bypassPermissions",
          maxTurns: 60,
          abortController: abort,
          cwd: process.cwd(),
        },
      })) {
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "tool_use") console.log(`claude ${block.name}`)
            else if (block.type === "text" && block.text.trim()) console.log(`claude: ${block.text.trim().slice(0, 160)}`)
          }
        } else if (message.type === "result") {
          if (message.subtype === "success") {
            console.log(`claude done in ${(message.duration_ms / 1000).toFixed(0)}s cost=$${message.total_cost_usd.toFixed(4)}`)
          } else {
            console.log(`claude stopped: ${message.subtype}`)
          }
        }
      }
    } finally {
      clearTimeout(wall)
    }

    if (!emitted) throw new Error("exploration ended without emit_flows")
    const doc = emitted
    await writeFile(out, JSON.stringify(doc, null, 2) + "\n")
    console.log(
      `PASS wrote ${out} flows=${doc.flows.length} pages=${doc.pages.length} intents=${JSON.stringify(doc.flows.map((f) => f.intent))} actions=${actions} elapsedMs=${Date.now() - started}`,
    )
  } finally {
    await browser.close()
  }
} catch (err) {
  console.log(`FAIL ${err instanceof Error ? err.message : String(err)} session=${sessionId} elapsedMs=${Date.now() - started}`)
  process.exitCode = 1
} finally {
  await solari.close()
  console.log(`session closed id=${sessionId || "none"}`)
}
