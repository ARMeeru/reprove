# reprove

reprove is an autonomous QA agent that re-proves every failure before it reports it.
Point it at a URL and it explores the site, writes Playwright specs, runs them inside a Solari sandbox against recorded cloud browser sessions, and reports only the failures that reproduce in an independent session.
Findings, not suspicions: every reported defect ships with the session replays that witnessed it, twice.

The name is the whole pitch. A failure is not a finding until reprove can re-prove it, and the dictionary agrees: to reprove is to call out a fault.

## Why the reverify stage is the product

Test generation is the commodity part. What an agent owes you before it claims your site is broken is the part worth building.
The closest neighbors each stop one step short of an answer:

- QA Wolf reproduces bugs before reporting them, with a human workforce. reprove does it autonomously, in minutes, for cents.
- Meticulous removes flakiness by mocking the network into determinism. reprove keeps the real app in the loop and reports the reproduction rate honestly.
- In this project's own demo lane, [ghostspec](https://github.com/solari-sdk/solari-cookbook/pull/9) re-runs a generated test to confirm it passes, and [Nightshift QA](https://github.com/yayaq1/solari-cookbook) refuses to report a pass without evidence. Its README says, verbatim, "Recording is mandatory."

Nobody gates failures on cross-session reproduction. That gate is reprove: a spec that fails once is a suspicion, and a spec that fails twice in two fresh browser sessions is a finding. A spec that fails once and passes on rerun lands in the flake rate, excluded from findings.

## How it works

```
 URL ──► explore ──► flows.json ──► generate ──► specs/*.spec.ts
                                                   │
              ┌────────────────────────────────────┘
              ▼
           execute: each spec runs in one Solari sandbox against a fresh,
           recorded cloud browser session (REST /sessions, recording: true;
           the SDK's endpoint is a local proxy, so in-guest specs connect
           to the upstream wss endpoint; the API key never enters the VM)
              │
              ▼  failing specs only
           reverify: rerun in fresh independent sessions
              │ failed in 2+ sessions              │ passed on rerun
              ▼                                    ▼
        finding: spec + failure text          flake: counted in the
        + all reproduction runs' replays      rate line, not reported
              │
              ▼
           report: self-contained HTML, rrweb-player bundled and events
           inlined, also served on a public Solari sandbox preview URL
```

Explore and generate run on `claude-sonnet-5` through the Claude Code Agent SDK: the model drives the explore tools itself and hands back a validated emit, so it cannot return broken JSON.
Generated specs typecheck under `tsc --strict` before they are allowed to run, self-contained on `playwright-core`, and connect over CDP to a session the runner owns.

## Quickstart

Requires Node 22+ and the Claude Code CLI on your PATH (`npm install -g @anthropic-ai/claude-code`).

```sh
export SOLARI_API_KEY=slr_live_...    # console.getsolari.com
export ANTHROPIC_AUTH_TOKEN=sk-ant-oat01-...  # Claude setup token: billed to your Claude subscription
  # or: export ANTHROPIC_API_KEY=sk-ant-...     # metered API fallback
  # or: neither, if you are already logged in with `claude login`

npm install
npx tsx src/cli.ts https://your-staging-url.example
```

One command runs all five stages and prints the report path. Expect minutes, not hours.
Runner-only mode runs an existing spec directory verbatim against any URL, with no regeneration:

```sh
npx tsx src/cli.ts run --specs-dir examples/end-to-end-run/specs https://demo-storefront-buggy.vercel.app
```

This is how both-directions checks stay honest: the suite is byte-identical across targets, so a green result on the fixed deploy and findings on the buggy deploy are the same tests talking about the same code.

## The demo target

A deliberately imperfect storefront, deployed twice from one repo, identical except for `NEXT_PUBLIC_BUGGY`: [buggy](https://demo-storefront-buggy.vercel.app) and [fixed](https://demo-storefront-nine.vercel.app).
Source: [ARMeeru/demo-storefront](https://github.com/ARMeeru/demo-storefront). The buggy build ships five seeded, pre-registered defects, each documented with its expected red assertion before any test was generated.
The committed run in `examples/end-to-end-run/` points the full pipeline at both: two findings on the buggy deploy, both reproduced across three sessions each with their replays, and the same suite fully green on the fixed deploy.

## What a finding looks like

Open `examples/end-to-end-run/report-buggy-deploy.html` in any browser, offline.
Each finding carries the intent, the spec source, the failure output, and the rrweb replay of every reproduction run, inlined. No external network dependencies, because a bug report that needs a server to still be up is not evidence.
The header states the rate line plainly: how many failures, how many reproduced, how many did not.

## Cost

Browser time is billed at $0.15/hr. A full pipeline run spends a few minutes of browser time across explore, execute, and reverify: a few cents.
This entire project was developed, including every spike and failed retry, for $0.14 of the free plan's $3 monthly credit.
Model time runs through the Claude Code CLI, and its usage is measurable: a full pipeline run spends roughly $0.30-$0.75 of API-equivalent value in explore plus about $0.10 per generated spec. A subscription setup token absorbs that within plan limits; a metered API key pays it per run.

## Honest limitations

Reproduction filters flakes, not falsehoods. A deterministic defect in the pipeline's own assumptions reproduces just as reliably as a real bug; one such false finding appeared during development (an assertion that matched two elements and timed out under Playwright's strict mode) and was caught by the both-directions gate, never by the reproduction gate. This line came out of an adversarial second-opinion review, and it is the most important sentence here.
A single rerun lets a 70%-flaky spec through with probability 0.7, so the exact claim is "reproduced in an independent session", never "flakes eliminated". The third run adds evidence and a stability note; it never demotes a finding.
The checkout arithmetic postcondition assumes tax is displayed additively. VAT-inclusive pricing would need that rule conditioned before pointing reprove at such a site.
No stealth, proxies, or CAPTCHA solving. The free plan omits them and own-site QA never needed them; that restraint is the point of the framing.
Session recordings capture input values by default. The demo target accepts throwaway data only, and your own targets should assume the same about anything reprove records.

## Roadmap

Flaky-test detective: point it at an existing suite instead of a URL, rerun across parallel sandboxes, and classify flaky versus real with the same replay evidence.
Desktop testing through Solari's VNC product.
Auth-flow testing via Solari login profiles.

## Credit where due

Built on [Solari](https://getsolari.com) for the [solari-cookbook](https://github.com/solari-sdk/solari-cookbook) challenge, with a fork-side example in the cookbook's own conventions. The reverify design survived an adversarial review round; its sharpest finding is quoted in Honest limitations above.
