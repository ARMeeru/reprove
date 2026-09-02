export type Evidence = {
  url: string
  selector?: string
  observedText?: string
}

export type FlowAction = {
  type: "goto" | "click" | "fill"
  url?: string
  selector?: string
  value?: string
  evidence: Evidence
}

export type Flow = {
  id: string
  intent: string
  actions: FlowAction[]
  evidence: Evidence
}

export type FormField = {
  name: string
  type: string
  selector: string
  label?: string
}

export type FormInventory = {
  selector: string
  fields: FormField[]
  submit?: string
}

export type Interactive = {
  selector: string
  text: string
  href?: string
  role?: string
}

export type PageInventory = {
  url: string
  title: string
  forms: FormInventory[]
  buttons: Interactive[]
  links: Interactive[]
  navigation: Interactive[]
}

export type AuthBootstrap = {
  gate?: { urlPattern: string; input: string; submit: string }
  login?: { trigger: string; email: string; password: string; submit: string }
}

export type FlowsDocument = {
  site: {
    url: string
    origin: string
    title?: string
    exploredAt: string
  }
  auth?: AuthBootstrap
  pages: PageInventory[]
  flows: Flow[]
}

export const FLOWS_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://reprove.dev/flows.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["site", "pages", "flows"],
  properties: {
    site: {
      type: "object",
      additionalProperties: false,
      required: ["url", "origin", "exploredAt"],
      properties: {
        url: { type: "string" },
        origin: { type: "string" },
        title: { type: "string" },
        exploredAt: { type: "string" },
      },
    },
    auth: {
      // Recorded by the explore bootstrap when it passed a site gate and/or an
      // email/password login using env-provided credentials. Secrets never
      // appear here — only the selectors that worked.
      type: "object",
      additionalProperties: false,
      properties: {
        gate: {
          type: "object",
          additionalProperties: false,
          required: ["urlPattern", "input", "submit"],
          properties: {
            urlPattern: { type: "string" },
            input: { type: "string" },
            submit: { type: "string" },
          },
        },
        login: {
          type: "object",
          additionalProperties: false,
          required: ["trigger", "email", "password", "submit"],
          properties: {
            trigger: { type: "string" },
            email: { type: "string" },
            password: { type: "string" },
            submit: { type: "string" },
          },
        },
      },
    },
    pages: { type: "array", items: { $ref: "#/$defs/page" } },
    flows: { type: "array", minItems: 1, items: { $ref: "#/$defs/flow" } },
  },
  $defs: {
    evidence: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string" },
        selector: { type: "string" },
        observedText: { type: "string" },
      },
    },
    interactive: {
      type: "object",
      additionalProperties: false,
      required: ["selector", "text"],
      properties: {
        selector: { type: "string" },
        text: { type: "string" },
        href: { type: "string" },
        role: { type: "string" },
      },
    },
    page: {
      type: "object",
      additionalProperties: false,
      required: ["url", "title", "forms", "buttons", "links", "navigation"],
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        forms: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["selector", "fields"],
            properties: {
              selector: { type: "string" },
              submit: { type: "string" },
              fields: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "type", "selector"],
                  properties: {
                    name: { type: "string" },
                    type: { type: "string" },
                    selector: { type: "string" },
                    label: { type: "string" },
                  },
                },
              },
            },
          },
        },
        buttons: { type: "array", items: { $ref: "#/$defs/interactive" } },
        links: { type: "array", items: { $ref: "#/$defs/interactive" } },
        navigation: { type: "array", items: { $ref: "#/$defs/interactive" } },
      },
    },
    flow: {
      type: "object",
      additionalProperties: false,
      required: ["id", "intent", "actions", "evidence"],
      properties: {
        id: { type: "string" },
        intent: { type: "string" },
        evidence: { $ref: "#/$defs/evidence" },
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
              evidence: { $ref: "#/$defs/evidence" },
            },
          },
        },
      },
    },
  },
} as const

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

function checkEvidence(path: string, v: unknown, errors: string[]) {
  if (!isObj(v)) {
    errors.push(`${path}: evidence must be an object`)
    return
  }
  if (typeof v.url !== "string" || !v.url) errors.push(`${path}.url: required string`)
  if (v.selector !== undefined && typeof v.selector !== "string") {
    errors.push(`${path}.selector: must be string`)
  }
  if (v.observedText !== undefined && typeof v.observedText !== "string") {
    errors.push(`${path}.observedText: must be string`)
  }
}

function checkInteractive(path: string, v: unknown, errors: string[]) {
  if (!isObj(v)) {
    errors.push(`${path}: must be an object`)
    return
  }
  if (typeof v.selector !== "string" || !v.selector) errors.push(`${path}.selector: required string`)
  if (typeof v.text !== "string") errors.push(`${path}.text: required string`)
}

export function validateFlows(data: unknown): string[] {
  const errors: string[] = []
  if (!isObj(data)) return ["root: must be an object"]

  if (!isObj(data.site)) errors.push("site: required object")
  else {
    if (typeof data.site.url !== "string" || !data.site.url) errors.push("site.url: required string")
    if (typeof data.site.origin !== "string" || !data.site.origin) {
      errors.push("site.origin: required string")
    }
    if (typeof data.site.exploredAt !== "string" || !data.site.exploredAt) {
      errors.push("site.exploredAt: required string")
    }
    if (data.site.title !== undefined && typeof data.site.title !== "string") {
      errors.push("site.title: must be string")
    }
  }

  if (!Array.isArray(data.pages)) errors.push("pages: required array")
  else {
    data.pages.forEach((page, i) => {
      const p = `pages[${i}]`
      if (!isObj(page)) {
        errors.push(`${p}: must be an object`)
        return
      }
      if (typeof page.url !== "string" || !page.url) errors.push(`${p}.url: required string`)
      if (typeof page.title !== "string") errors.push(`${p}.title: required string`)
      if (!Array.isArray(page.forms)) errors.push(`${p}.forms: required array`)
      else {
        page.forms.forEach((form, j) => {
          const f = `${p}.forms[${j}]`
          if (!isObj(form)) {
            errors.push(`${f}: must be an object`)
            return
          }
          if (typeof form.selector !== "string" || !form.selector) {
            errors.push(`${f}.selector: required string`)
          }
          if (!Array.isArray(form.fields)) errors.push(`${f}.fields: required array`)
          else {
            form.fields.forEach((field, k) => {
              const fp = `${f}.fields[${k}]`
              if (!isObj(field)) {
                errors.push(`${fp}: must be an object`)
                return
              }
              if (typeof field.name !== "string") errors.push(`${fp}.name: required string`)
              if (typeof field.type !== "string") errors.push(`${fp}.type: required string`)
              if (typeof field.selector !== "string" || !field.selector) {
                errors.push(`${fp}.selector: required string`)
              }
            })
          }
        })
      }
      for (const key of ["buttons", "links", "navigation"] as const) {
        if (!Array.isArray(page[key])) errors.push(`${p}.${key}: required array`)
        else page[key].forEach((item, j) => checkInteractive(`${p}.${key}[${j}]`, item, errors))
      }
    })
  }

  if (!Array.isArray(data.flows)) errors.push("flows: required array")
  else if (data.flows.length < 1) errors.push("flows: at least one flow required")
  else {
    data.flows.forEach((flow, i) => {
      const f = `flows[${i}]`
      if (!isObj(flow)) {
        errors.push(`${f}: must be an object`)
        return
      }
      if (typeof flow.id !== "string" || !flow.id) errors.push(`${f}.id: required string`)
      if (typeof flow.intent !== "string" || !flow.intent) errors.push(`${f}.intent: required string`)
      checkEvidence(`${f}.evidence`, flow.evidence, errors)
      if (!Array.isArray(flow.actions) || flow.actions.length < 1) {
        errors.push(`${f}.actions: required non-empty array`)
        return
      }
      flow.actions.forEach((action, j) => {
        const a = `${f}.actions[${j}]`
        if (!isObj(action)) {
          errors.push(`${a}: must be an object`)
          return
        }
        if (action.type !== "goto" && action.type !== "click" && action.type !== "fill") {
          errors.push(`${a}.type: must be goto|click|fill`)
        }
        if (action.type === "goto" && (typeof action.url !== "string" || !action.url)) {
          errors.push(`${a}.url: required for goto`)
        }
        if ((action.type === "click" || action.type === "fill") && (typeof action.selector !== "string" || !action.selector)) {
          errors.push(`${a}.selector: required for ${action.type}`)
        }
        if (action.type === "fill" && typeof action.value !== "string") {
          errors.push(`${a}.value: required string for fill`)
        }
        checkEvidence(`${a}.evidence`, action.evidence, errors)
      })
    })
  }

  return errors
}
