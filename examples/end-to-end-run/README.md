# Committed end-to-end run

One real pipeline run against the demo storefront, both directions, preserved as evidence.

- `flows.json` — what explore found on the buggy deploy (5 flows).
- `specs/` — what generate wrote from those flows. No hand edits; every spec typechecked.
- `report-buggy-deploy.html` — the report from the buggy deploy: 2 failures, 2 reproduced, 0 did not reproduce. Open it offline; the rrweb replays are inlined.
- `verdicts-buggy-deploy.json` — the machine-readable verdicts behind that report.
- `results-fixed-deploy.json` — the same spec directory, byte-identical, against the fixed deploy: 5 of 5 pass.

Session ids in these artifacts were scrubbed after the runs; they identified sessions that
expired long before publication (free-tier replay retention is one day). The replays
embedded in the report survive because they were downloaded and inlined at run time.

Reproduce it live:

```sh
npx tsx src/cli.ts run --specs-dir examples/end-to-end-run/specs https://demo-storefront-buggy.vercel.app
npx tsx src/cli.ts run --specs-dir examples/end-to-end-run/specs https://demo-storefront-nine.vercel.app
```
