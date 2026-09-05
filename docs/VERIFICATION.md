# The verification gate

reprove's reverify stage is a protocol before it is code. The protocol first ran as prompts in a config-only experiment (saucedemo-loop, June 2026): a scheduled agent hunted functional bugs on SauceDemo, and an independent verifier subagent with a different model decided which candidates were real. That loop ran daily and caught real defects: a broken sort order for a specific user class, dead add-to-cart buttons, a state clobber between checkout form fields. This doc keeps the rules visible so the code keeps obeying them.

## Default-FAIL

The verifier assumes the bug is fake until it reproduces it itself. A candidate that arrives with confident prose is still a suspicion. The only thing that changes a verdict is a clean reproduction: fresh session, no cookies or storage carried over from the hunter, steps followed exactly, no improvised path that "should" trigger it.

## One verdict per candidate, from a fixed set

- CONFIRMED: the verifier personally reproduced a functional defect, with concrete evidence of what the UI/DOM actually showed.
- NOT_REPRODUCED: the claimed failure did not occur, or the steps were too vague to follow deterministically. The correct verdict for a hunter false positive.
- WORKING_AS_INTENDED: the behavior reproduced, but it is correct, not a defect.
- COSMETIC: real but non-blocking; does not break a functional flow.
- OUT_OF_SCOPE: the candidate is a security probe. Return it unexecuted.

CONFIRMED is reserved for a reproduced functional defect. Nothing softens into it.

## Calibration

The gate itself gets tested before it gets trusted. Plant a known non-bug: the verifier must reject it. Plant a known real bug: it must confirm. If either lands wrong, the gate is broken and everything it reports is noise until it is fixed.

## Nothing is silently dropped

Every verdict is routed and named. Confirmed findings go to the report. Rejected candidates are named in the run summary, individually, because they are the evidence the gate is checking itself. A run that drops a verdict without naming it has failed its own audit.

## The hunter forgets; the record does not

Sessions are disposable and stateless on purpose. Continuity lives in the artifacts: findings with first-seen dates, replays of the failing sessions, and the flake rate.

## Scope wall

Functional behavior only. No auth bypass, injection, object-ID tampering, cookie manipulation, or rate-limit probing. Anything security-adjacent is recorded for a human and not explored. The agent is a user, not an attacker.

## What reprove adds on top

The prompt protocol becomes a mechanical gate: a spec that fails once is a suspicion, and a spec that fails twice in two fresh recorded sessions is a finding. Single failures land in the reported flake rate instead of the findings. What the protocol cannot fix still holds: reproduction filters flakes, not falsehoods.
