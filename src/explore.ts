import { writeFile } from "node:fs/promises"
import Anthropic from "@anthropic-ai/sdk"
import { Solari } from "@solarisdk/browser"
import { validateFlows, type AuthBootstrap, type FlowsDocument, type PageInventory } from "./schema.ts"

const MODEL = "claude-sonnet-5"
const WALL_MS = 10 * 60_000

const TOOLS: Anthropic.Tool[] = [
  {
    name: "goto",
    description: "Navigate to a same-origin URL.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { url: { type: "string" } },
    },
  },
  {
    name: "read_page",
    description: "Return a DOM digest of the current page (not raw HTML): title, headings, truncated text, forms, buttons, links.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "list_interactive",
    description: "List interactive elements on the current page with selectors.",
    input_schema: { type: "object", additionalProperties: false, properties: {} },
  },
  {
    name: "click",
    description: "Click the element matching selector (CSS, [data-test], or role=button[name=...]).",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["selector"],
      properties: { selector: { type: "string" } },
    },
  },
  {
    name: "fill",
    description: "Fill an input matching selector. Use values visible on the page; do not invent secrets.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "value"],
      properties: { selector: { type: "string" }, value: { type: "string" } },
    },
  },
]

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

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const raw = fence ? fence[1]! : text
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) throw new Error("no JSON object in model output")
  return JSON.parse(raw.slice(start, end + 1))
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
if (!process.env.ANTHROPIC_API_KEY) {
  console.log("FAIL ANTHROPIC_API_KEY is not set")
  process.exit(1)
}

const { url: startUrl, maxPages, maxActions, out } = parseArgs(process.argv.slice(2))
const origin = originOf(startUrl)
const started = Date.now()
const deadline = started + WALL_MS
const pages = new Map<string, PageInventory>()
let actions = 0
let sessionId = ""

const solari = new Solari({ apiKey: process.env.SOLARI_API_KEY })
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

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
    const GATE_PATH = /site-login|site-password|gate/i
    const GATE_INPUT = 'input[type="password"]'
    const GATE_SUBMIT = 'form button[type="submit"], form button:not([type="button"])'
    const LOGIN_TRIGGER = 'header button, header a'
    const LOGIN_EMAIL = 'input[name="email"], input[type="email"]'
    // Consent/promo dialogs mount over the page and intercept pointer events
    // (a Radix modal eats the gate submit click otherwise). Accept or escape
    // them before interacting with anything else.
    const dismissDialogs = async () => {
      for (let i = 0; i < 2; i++) {
        const dialog = page.locator('[role="dialog"][aria-modal="true"]').first()
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
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 20_000 })
    await dismissDialogs()
    if (GATE_PATH.test(new URL(page.url()).pathname)) {
      if (!sitePassword) {
        throw new Error(`landed on a site gate (${page.url()}) but SITE_PASSWORD is not set`)
      }
      await page.locator(GATE_INPUT).first().fill(sitePassword, { timeout: 10_000 })
      await page.locator(GATE_SUBMIT).first().click({ timeout: 10_000 })
      await page.waitForURL((u) => !GATE_PATH.test(u.pathname), { timeout: 20_000 })
      await snapshot()
      auth.gate = { urlPattern: "site-login", input: GATE_INPUT, submit: GATE_SUBMIT }
      console.log(`bootstrap: site gate passed -> ${page.url()}`)
    } else {
      await snapshot()
    }
    if (authEmail && authPassword) {
      await dismissDialogs()
      const email = page.locator(LOGIN_EMAIL).first()
      if (!(await email.isVisible().catch(() => false))) {
        await page
          .locator(LOGIN_TRIGGER)
          .filter({ hasText: /^\s*(log ?in|sign ?in)\s*$/i })
          .first()
          .click({ timeout: 10_000 })
      }
      await email.waitFor({ state: "visible", timeout: 15_000 })
      await email.fill(authEmail)
      const form = email.locator("xpath=ancestor::form").first()
      await form.locator('input[type="password"]').first().fill(authPassword)
      await form.locator('button[type="submit"], button:not([type="button"])').first().click()
      await form.waitFor({ state: "detached", timeout: 45_000 })
      await page.waitForLoadState("domcontentloaded").catch(() => {})
      auth.login = {
        trigger: LOGIN_TRIGGER,
        email: LOGIN_EMAIL,
        password: 'input[type="password"]',
        submit: 'button[type="submit"]',
      }
      await snapshot()
      console.log(`bootstrap: logged in -> ${page.url()}`)
    }

    const runTool = async (name: string, input: Record<string, unknown>): Promise<string> => {
      if (Date.now() >= deadline) return JSON.stringify({ error: "wall-clock budget exhausted" })
      try {
        if (name === "goto") {
          const target = String(input.url ?? "")
          if (!target) return JSON.stringify({ error: "url required" })
          let abs: URL
          try {
            abs = new URL(target, page.url() || startUrl)
          } catch {
            return JSON.stringify({ error: "invalid url" })
          }
          if (abs.origin !== origin) return JSON.stringify({ error: "off-origin blocked", origin })
          const key = pageKey(abs.toString())
          if (!pages.has(key) && pages.size >= maxPages) {
            return JSON.stringify({ error: "max-pages reached", ...remaining() })
          }
          if (overBudget()) return JSON.stringify({ error: "action budget exhausted", ...remaining() })
          actions++
          await page.goto(abs.toString(), { waitUntil: "domcontentloaded", timeout: 20_000 })
          if (originOf(page.url()) !== origin) {
            await page.goto(startUrl, { waitUntil: "domcontentloaded" })
            return JSON.stringify({ error: "navigation left origin; returned to start" })
          }
          const d = await snapshot()
          console.log(`goto ${d.url} actions=${actions} pages=${pages.size}`)
          return JSON.stringify({ ok: true, url: d.url, title: d.title, ...remaining() })
        }
        if (name === "read_page") {
          const d = await snapshot()
          return JSON.stringify({ ...d, ...remaining() })
        }
        if (name === "list_interactive") {
          const d = await digest(page, 40)
          pages.set(pageKey(d.url), asPage(d))
          return JSON.stringify({
            url: d.url,
            forms: d.forms,
            buttons: d.buttons,
            links: d.links,
            navigation: d.navigation,
            ...remaining(),
          })
        }
        if (name === "click") {
          if (overBudget()) return JSON.stringify({ error: "action budget exhausted", ...remaining() })
          const selector = String(input.selector ?? "")
          if (!selector) return JSON.stringify({ error: "selector required" })
          actions++
          await locator(page, selector).first().click({ timeout: 10_000 })
          await page.waitForLoadState("domcontentloaded").catch(() => {})
          if (originOf(page.url()) !== origin) {
            await page.goBack().catch(() => page.goto(startUrl, { waitUntil: "domcontentloaded" }))
            return JSON.stringify({ error: "click left origin; navigated back", ...remaining() })
          }
          const d = await snapshot()
          console.log(`click ${selector} -> ${d.url} actions=${actions}`)
          return JSON.stringify({ ok: true, url: d.url, title: d.title, ...remaining() })
        }
        if (name === "fill") {
          if (overBudget()) return JSON.stringify({ error: "action budget exhausted", ...remaining() })
          const selector = String(input.selector ?? "")
          const value = String(input.value ?? "")
          if (!selector) return JSON.stringify({ error: "selector required" })
          actions++
          await locator(page, selector).first().fill(value, { timeout: 10_000 })
          console.log(`fill ${selector} actions=${actions}`)
          return JSON.stringify({ ok: true, ...remaining() })
        }
        return JSON.stringify({ error: `unknown tool ${name}` })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`tool error ${name}: ${msg}`)
        return JSON.stringify({ error: msg, ...remaining() })
      }
    }

    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: `Explore ${startUrl}. Start with goto then list_interactive. Produce at least 3 distinct flows by the end.`,
      },
    ]

    while (!overBudget()) {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 4096,
        system,
        tools: TOOLS,
        messages,
      })
      messages.push({ role: "assistant", content: res.content })
      if (res.stop_reason !== "tool_use") break
      const results: Anthropic.ToolResultBlockParam[] = []
      for (const block of res.content) {
        if (block.type !== "tool_use") continue
        const output = await runTool(block.name, block.input as Record<string, unknown>)
        results.push({ type: "tool_result", tool_use_id: block.id, content: output })
      }
      if (results.length === 0) break
      messages.push({ role: "user", content: results })
    }

    const observed = [...pages.values()]
    if (observed.length === 0) {
      throw new Error("no pages inventoried; browser tools never succeeded")
    }

    const emitTool: Anthropic.Tool = {
      name: "emit_flows",
      description: "Submit at least 3 QA flows derived from the observed pages.",
      input_schema: {
        type: "object",
        additionalProperties: false,
        required: ["flows"],
        properties: {
          flows: {
            type: "array",
            minItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["id", "intent", "actions", "evidence"],
              properties: {
                id: { type: "string" },
                intent: { type: "string" },
                evidence: {
                  type: "object",
                  required: ["url"],
                  properties: {
                    url: { type: "string" },
                    selector: { type: "string" },
                    observedText: { type: "string" },
                  },
                },
                actions: {
                  type: "array",
                  minItems: 1,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["type", "evidence"],
                    properties: {
                      type: { type: "string", enum: ["goto", "click", "fill"] },
                      url: { type: "string" },
                      selector: { type: "string" },
                      value: { type: "string" },
                      evidence: {
                        type: "object",
                        required: ["url"],
                        properties: {
                          url: { type: "string" },
                          selector: { type: "string" },
                          observedText: { type: "string" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }

    const assemble = (flows: unknown): FlowsDocument => {
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

    const compact = observed.map((p) => ({
      url: p.url,
      title: p.title,
      forms: p.forms,
      buttons: p.buttons.map((b) => ({ selector: b.selector, text: b.text })),
      links: p.links.slice(0, 12).map((l) => ({ selector: l.selector, text: l.text, href: l.href })),
      navigation: p.navigation.map((n) => ({ selector: n.selector, text: n.text, href: n.href })),
    }))

    messages.push({
      role: "user",
      content: `Exploration finished. Call emit_flows with at least 3 distinct intents (login, add to cart, checkout, logout, ...).
Use selectors from this inventory. Every flow and action needs evidence.url from these pages.
${JSON.stringify(compact)}`,
    })

    const takeFlows = (res: Anthropic.Message): unknown => {
      const block = res.content.find((b) => b.type === "tool_use" && b.name === "emit_flows")
      if (block && block.type === "tool_use") {
        const input = block.input as { flows?: unknown }
        return input.flows
      }
      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n")
      const parsed = extractJson(text) as { flows?: unknown }
      if (parsed && typeof parsed === "object" && "flows" in parsed) return parsed.flows
      return (parsed as FlowsDocument).flows
    }

    let final = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system,
      tools: [emitTool],
      tool_choice: { type: "tool", name: "emit_flows" },
      messages,
    })
    let doc: FlowsDocument
    try {
      doc = assemble(takeFlows(final))
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.log(`flows invalid, retrying: ${why}`)
      messages.push({ role: "assistant", content: final.content })
      messages.push({
        role: "user",
        content: `emit_flows failed validation: ${why}. Call emit_flows again with a corrected flows array.`,
      })
      final = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 8192,
        system,
        tools: [emitTool],
        tool_choice: { type: "tool", name: "emit_flows" },
        messages,
      })
      doc = assemble(takeFlows(final))
    }

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
