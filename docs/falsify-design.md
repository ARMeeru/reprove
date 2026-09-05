# Falsify: a parked side idea

A small game about spec literacy, built in June 2026 and parked after one level: you are handed a spec and a buggy black-box implementation, and you win by writing the test that proves the difference. The judge's anti-cheese rule is the idea worth keeping: you cannot win by asserting garbage, because winning requires expected === spec(input) AND implementation(input) !== expected.

Kept here verbatim (the design contract and the handoff state at park time) since the repo it lived in is archived. If it ever revives, it revives from these files.

---

# Design contract (verbatim)

# Falsify — Engineering Contract

This document is the **single source of truth** for the engine. Code conforms to
this; if code and this doc disagree, the doc wins until the doc is changed.

Genre: "spec vs implementation diff" (Core C). Interaction model: **Test
Builder** — the player assembles a structured test case (input + asserted
expected output), the game runs it.

---

## 1. The judge (the heart)

```ts
// Win condition, stated once:
//   WIN  ⟺  expected === spec(input)  AND  implementation(input) !== expected

type RunResult =
  | { status: 'invalid-assertion'; specValue: Output }       // expected ≠ spec(input)
  | { status: 'passes'; actual: Output }                     // valid test, impl agrees
  | { status: 'bug-caught'; actual: Output; expected: Output }; // valid failing test — WIN

function judge(level: Level, input: Input, expected: Output): RunResult {
  const specValue = level.spec(input);
  if (!eq(expected, specValue)) return { status: 'invalid-assertion', specValue };
  const actual = level.implementation(input);
  if (eq(actual, specValue)) return { status: 'passes', actual };
  return { status: 'bug-caught', actual, expected };
}
```

`eq` is a deep structural equality helper (handles the small output types we
allow). No reference equality on objects.

The `invalid-assertion` branch is the anti-cheese: a player cannot win by
asserting nonsense. They must know the correct answer per the spec first.

---

## 2. The level contract

A level is a typed object. **Metadata and schemas are data** (they drive the UI
generically). **Spec and implementation are pure functions** (independently
unit-testable). No DSL, no interpreter — that is an explicit non-goal.

```ts
interface Level {
  id: string;
  title: string;
  bugClass: 'boundary' | 'off-by-one' | 'type-confusion' | 'encoding' | 'logic-gap';
  specText: string;                          // human-readable spec shown to the player
  inputSchema: Record<string, FieldSchema>;  // drives the Input Builder UI
  outputSchema: FieldSchema;                 // drives the Assertion Builder UI
  spec: (input: Input) => Output;            // correct oracle (hidden from player)
  implementation: (input: Input) => Output;  // buggy black box (hidden from player)
  knownDivergence?: Input;                    // a witness input where spec ≠ impl (for tests)
}

type Input = Record<string, unknown>;
type Output = unknown; // constrained by outputSchema; keep low-cardinality (see §4)

type FieldSchema =
  | { kind: 'boolean' }
  | { kind: 'number'; min?: number; max?: number; integer?: boolean }
  | { kind: 'string'; maxLength?: number }
  | { kind: 'enum'; options: string[] };
```

---

## 3. Meta-QA: the level validation suite

Every registered level — authored by human or by Codex — MUST pass automated
validation or CI rejects it. Invariants:

1. **Solvable.** There exists an input where `spec(input) !== implementation(input)`.
   A level with no divergence is unwinnable. (`knownDivergence`, if present, must
   be a real witness.)
2. **Edge case, not wholesale-wrong.** Over a sampled input domain, the divergence
   rate is **below a threshold** (start at 25%). One sneaky input, not "the whole
   function is broken." This is what makes a level *fair*.
3. **Deterministic.** `spec` and `implementation` are pure. Same input → same
   output across repeated calls.
4. **Schema-sound.** Outputs of both `spec` and `implementation` conform to
   `outputSchema`; every field declared in `inputSchema` is consumed by `spec`.

The validation suite is itself the project's flagship QA artifact. We test the
thing that tests the player.

---

## 4. Content rules

- Keep **outputs low-cardinality**: boolean, small int, short enum, short string.
  Asserting the expected value must be cheap in the UI. Long-string outputs make
  the Assertion Builder miserable — avoid.
- One bug per level. The divergence should map to exactly one `bugClass`.
- A level must be **fair**: a careful reader of `specText` could find the witness.
  No moon logic, no information the player can't see.

---

## 5. Directory structure

```
src/engine/   types.ts  judge.ts  eq.ts
src/levels/   index.ts  01-boundary.ts ...        ← pure-function levels, registered in index.ts
src/ui/       SpecPanel  InputBuilder  AssertionBuilder  ResultPanel  LevelScreen
tests/        judge.test.ts  levels.validation.test.ts
```

UI state via `useReducer`. Levels bundled at build time. No backend for MVP.

---

## 6. Non-goals (do not build these without a new decision)

- No level DSL / scripting language. Levels are TS modules.
- No multiplayer, no backend, no persistence (MVP).
- No canvas / sprite rendering. It's panels and forms.
- No free-text code input from the player. Input is structured via schemas.


---

# Handoff state at park time (verbatim)

# STATE — Falsify

Current working state and the active ticket. For a cold start, read this together
with `CLAUDE.md` (working rules) and `DESIGN.md` (engineering contract).
`DESIGN.md` is the source of truth for the engine.

## Where we are

Engine and first UI are built, reviewed, and merged to `main`.

- **FAL-1 — engine core** — accepted, merged.
  `src/engine/` (`types.ts`, `judge.ts`, `eq.ts`); seed level
  `src/levels/01-boundary.ts` (spec `age >= 18` vs implementation `age > 18`,
  off-by-one, witness `{ age: 18 }`); meta-QA suite
  `tests/levels.validation.test.ts` (invariants: solvable, edge-case-not-
  wholesale-wrong, deterministic, schema-sound). `tests/judge.test.ts` covers all
  three `RunResult` branches.
- **FAL-2 — Test Builder UI** — accepted, merged (PR #2).
  `src/ui/LevelScreen.tsx` (SpecPanel / InputBuilder / AssertionBuilder /
  ResultPanel + a shared `FieldControl`, single `useReducer`), `src/main.tsx`,
  `index.html`, `src/ui/styles.css`. UI test `tests/ui/level-screen.test.tsx`.
  `ResultPanel` never reveals the spec value on `invalid-assertion`; the no-leak
  test is scoped to the `aria-live` result region only. Build tooling lives in
  `devDependencies`; `vite.config.ts` imports `defineConfig` from `vitest/config`.

Scripts: `npm run dev`, `npm test`, `npm run typecheck`.

## Next: FAL-3 — harden the validation harness

**Do this BEFORE authoring any new level.** The meta-QA suite is the product's
core promise; right now it is only trustworthy for the one seed level.

**Problem.** In `tests/levels.validation.test.ts`, `sampleValuesForField` hardcodes
`17, 18, 19` — the seed level's boundary. The framework carries level-specific
knowledge, with two consequences:

1. The "edge case, not wholesale-wrong" check computes `divergences / inputs.length`
   over ~6 cherry-picked points (one of which is the witness by construction). That
   is not a meaningful fairness rate.
2. The "solvable" check requires the *blind sample* to contain a divergent input. A
   future level whose bug sits at a value the sampler does not generate will be
   reported unsolvable even though `knownDivergence` documents a real witness — a
   false negative that will fire the moment level 2 lands.

**Scope.**

1. Remove every level-specific literal from the sampler. The framework must be
   level-agnostic.
2. Domain-aware number sampling: for bounded integer domains where
   `(max - min) <= EXHAUSTIVE_INTEGER_CAP`, sample every integer in `[min, max]`.
   For larger or non-integer domains, sample boundaries densely (`min`, `min + 1`,
   `max - 1`, `max`, midpoint) plus a fixed set of representative interior points.
   This makes the fairness rate real.
3. Solvability trusts the witness: require `knownDivergence` on every level and
   assert it is a genuine witness (`spec !== implementation` there). Do not fail a
   level solely because a coarse sample missed the witness. Use sampled divergences
   only for the fairness-rate denominator.
4. Cap the cartesian product across fields with `MAX_SAMPLED_INPUTS`; when exceeded,
   fall back to deterministic boundary/representative sampling. No unseeded
   randomness — sampling stays pure and reproducible.
5. Named constants only (`EXHAUSTIVE_INTEGER_CAP`, `MAX_SAMPLED_INPUTS`, existing
   `DIVERGENCE_RATE_THRESHOLD`). No magic numbers (see `CLAUDE.md`).

**Acceptance.**

- Seed level still passes all four invariants; its fairness rate is now computed
  over the exhaustive `[0, 120]` integer domain (≈ 0.008).
- No numeric literals tied to any specific level remain in the sampler.
- Regression fixture: a throwaway level whose only divergence sits at a deep
  interior value (e.g. diverges only at `age === 65`) is reported **solvable** —
  proving the false-negative is gone. Remove the fixture or keep it clearly marked
  as a harness test, not game content.
- Deterministic across runs. `npm test` and `npm run typecheck` green.
- Do not modify `src/engine/`. Do not commit without human sign-off.

## Working mode

Lanes are defined in `CLAUDE.md`: Claude plans / owns architecture / reviews,
Codex implements, the human is domain expert + adversarial playtester + final
sign-off. **Open decision for the next session:** inside Claude Code, "Claude" can
also implement directly. Decide deliberately whether Claude Code *replaces* Codex
as the implementer, or merely adds the ability to run tests and commit while Codex
keeps the implementation lane. Pick one. Do not drift between them.
