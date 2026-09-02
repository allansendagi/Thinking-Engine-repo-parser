# Eval harness

Scores the extraction → identity-resolution → state pipeline against hand-labelled
conversations. Run it with:

```sh
bun run eval          # = bun src/cli.ts eval
```

It needs `ANTHROPIC_API_KEY` in the environment (`.env` is loaded) — every case runs the real
extraction and reasoning providers, so a run costs real tokens. It is **not** part of `bun test`
and does **not** run in CI unless the key is present (the workflow skips the step otherwise).

Exit code is non-zero if any aggregate gate fails, a required event was discarded, an expected
open loop was missed, or any case failed its parser precondition — so it can gate a release once
the golden set is real.

## Layout

```
eval/
  cases/
    <case-name>/
      conversations.json   # a raw export, exactly as the provider gives it
      labels.json          # ground truth (schema below)
  out/
    <case-name>.db          # written each run; inspect with the MCP tools or sqlite3 (gitignored)
```

Every directory under `cases/` is a case. Metrics are **micro-averaged** across cases (sum of
numerators / sum of denominators), so one 60-conversation case and one 4-conversation case
contribute in proportion to their size, not equally.

## The golden set

`cases/authority-payments` is a mechanics smoke test — ~5 substantive events. It proves branch
resolution, verbatim grounding, and the authority-vs-payments non-merge work end to end. It is
**not** a statistically meaningful measurement of the signal gate.

To make the gate numbers real, drop in 50–100 conversations' worth of real, hand-labelled
export as one or more additional cases:

1. **Export.** ChatGPT → Settings → Data controls → Export. The email contains
   `conversations.json`. (Only the ChatGPT export shape parses today — see `format` below.)
2. **Trim** to the conversations you want scored, keeping each conversation object intact.
3. **Label** — write `labels.json` per the schema below. Budget ~5 min per conversation.
4. Drop it under `cases/<name>/` and run `bun run eval`.

Labelling is the work. The harness is done; the golden set is not — it needs real thinking
data, which only you have.

## `labels.json` schema

```jsonc
{
  // Only "chatgpt-export" is understood. A Claude export needs parseClaudeExport wired into
  // parseCase() in harness.ts first.
  "format": "chatgpt-export",

  // The ideas the pipeline should reconstruct. `anchorSourceEventId` is a message id that must
  // end up in that idea after the run — the harness locates the idea by it, so every check below
  // that names a group works without hardcoding an idea id.
  "identityGroups": [
    { "name": "authority", "anchorSourceEventId": "c1_u1" },
    { "name": "payments",  "anchorSourceEventId": "c3_u1" }
  ],

  // Message ids on abandoned branches of an edited conversation. The parser must NOT emit these
  // (editing a turn forks the tree; only the kept path is canonical).
  "excludedNodeIds": ["c1_u1_orig"],

  // Exact count the parser must produce from conversations.json. A precondition — if it's wrong,
  // the case is reported FAIL and its downstream metrics are skipped.
  "expectedCanonicalEventCount": 14,

  // The substantive user turns. `required: true` ones drive recall. `requiredSubstrings` are
  // content stems (e.g. "verif" covers verify/verification), matched against the model's
  // statement OR its verbatim evidence quote — never an exact phrase (the model picks a
  // different valid span each run). `acceptableTypes` is broad for turns whose true type only
  // resolves cross-conversation. `isFirstInGroup` marks the founding event (excluded from
  // identity-precision, since it has nothing earlier to merge into).
  "substantiveEvents": [
    { "sourceEventId": "c1_u1", "required": true,  "acceptableTypes": ["new_idea", "claim"],
      "requiredSubstrings": ["authority", "boundar"], "identityGroup": "authority",
      "isFirstInGroup": true },
    { "sourceEventId": "c2_u1", "required": true,  "acceptableTypes": ["refinement", "claim"],
      "requiredSubstrings": ["executable"], "identityGroup": "authority" }
  ],

  // Exactly one open loop the run must surface, on the named group's idea.
  "expectedOpenLoop": {
    "sourceEventId": "c4_u1",
    "requiredSubstrings": ["who", "verif"],
    "identityGroup": "authority"
  },

  // User turns that are real but not idea-worthy (logistics, thanks, tangents). Drive precision:
  // any of these that reaches an idea is a false positive.
  "noiseSourceEventIds": ["c5_u1", "c5_u2"],

  // The dangerous confusions. Each names a source event and a group it must NOT be merged into.
  // A violation is a CRITICAL failure in the report.
  "criticalNonMatches": [
    { "sourceEventId": "c3_u1", "mustNotMatchGroup": "authority" }
  ]
}
```

## Metrics & gates

| Metric | Gate | What a miss means |
| --- | --- | --- |
| Idea-attribution recall | ≥ 80% | a `required` substantive turn produced no matching cognitive event |
| Idea-attribution precision | ≥ 90% | a `noiseSourceEventIds` turn reached an idea |
| Identity-resolution precision | ≥ 95% | a follow-up turn merged into the wrong idea, or a `criticalNonMatch` merged where it must not |
| Provenance accuracy | ≥ 98% | a model claim wasn't verbatim-grounded in its cited source |
| Hallucinated attribution rate | < 2% | same, as a rate |
| Expected open loop captured | all cases | the labelled open question didn't surface on its idea |
| No required event discarded by the gate | always | the signal gate dropped a turn the label says matters — the worst error class |
