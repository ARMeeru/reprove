import { readFile } from "node:fs/promises"
import { validateFlows } from "./schema.ts"

const path = process.argv[2]
if (!path) {
  console.log("usage: npx tsx src/inspect-flows.ts <flows.json>")
  process.exit(1)
}
const doc = JSON.parse(await readFile(path, "utf8"))
const errors = validateFlows(doc)
if (errors.length) {
  console.log(`FAIL ${path}`)
  for (const e of errors) console.log(" ", e)
  process.exit(1)
}
console.log(`PASS ${path} flows=${doc.flows.length} pages=${doc.pages.length}`)
for (const f of doc.flows) console.log(`  flow ${f.id}: ${f.intent} (${f.actions.length} actions)`)
for (const p of doc.pages) console.log(`  page ${p.url} forms=${p.forms.length} buttons=${p.buttons.length}`)
