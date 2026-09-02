import { validateFlows, type FlowsDocument } from "./schema.ts"

const valid: FlowsDocument = {
  site: {
    url: "https://www.saucedemo.com/",
    origin: "https://www.saucedemo.com",
    title: "Swag Labs",
    exploredAt: "2026-09-01T00:00:00.000Z",
  },
  pages: [
    {
      url: "https://www.saucedemo.com/",
      title: "Swag Labs",
      forms: [
        {
          selector: "form",
          fields: [{ name: "username", type: "text", selector: "[data-test=username]" }],
          submit: "[data-test=login-button]",
        },
      ],
      buttons: [{ selector: "[data-test=login-button]", text: "Login", role: "button" }],
      links: [],
      navigation: [],
    },
  ],
  flows: [
    {
      id: "login",
      intent: "log in",
      evidence: { url: "https://www.saucedemo.com/", selector: "[data-test=login-button]", observedText: "Login" },
      actions: [
        {
          type: "goto",
          url: "https://www.saucedemo.com/",
          evidence: { url: "https://www.saucedemo.com/" },
        },
        {
          type: "fill",
          selector: "[data-test=username]",
          value: "standard_user",
          evidence: { url: "https://www.saucedemo.com/", selector: "[data-test=username]" },
        },
        {
          type: "click",
          selector: "[data-test=login-button]",
          evidence: { url: "https://www.saucedemo.com/", selector: "[data-test=login-button]", observedText: "Login" },
        },
      ],
    },
  ],
}

const rejectedValid = validateFlows(valid)
if (rejectedValid.length) {
  console.log("FAIL valid fixture rejected")
  for (const e of rejectedValid) console.log(" ", e)
  process.exit(1)
}

const acceptedEmpty = validateFlows({})
if (acceptedEmpty.length === 0) {
  console.log("FAIL empty object accepted")
  process.exit(1)
}

const acceptedBadAction = validateFlows({
  ...valid,
  flows: [
    {
      id: "x",
      intent: "y",
      evidence: { url: "https://www.saucedemo.com/" },
      actions: [{ type: "click", evidence: { url: "https://www.saucedemo.com/" } }],
    },
  ],
})
if (!acceptedBadAction.some((e) => e.includes("selector"))) {
  console.log("FAIL click without selector accepted", acceptedBadAction)
  process.exit(1)
}

console.log("PASS schema validator")
