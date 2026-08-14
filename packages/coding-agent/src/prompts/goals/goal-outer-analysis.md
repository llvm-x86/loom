## Objective the inner loop is pursuing

{{objective}}

## Inner loop trace (last {{windowIterations}} iterations)

{{iterationLines}}

## Current search configuration

- Strategy: {{strategy}}
- Frozen approaches: {{frozenApproaches}}
- Current guidance: {{guidance}}
- Active mechanisms: {{mechanisms}}

## Trace statistics

- Total iterations: {{totalIterations}}
- Distinct tool signatures in window: {{distinctSignatures}}
- Tool calls: {{totalToolCalls}} ({{totalFailures}} failed)
- Iterations that touched the `goal` tool without ending the goal: {{goalToolTouches}}
- Tokens in window: {{totalTokens}}
{{#if stagnationReason}}
- **Stagnation detected**: {{stagnationReason}}
{{/if}}

## Tool usage history

{{toolHistogram}}

## Your task

Analyze the inner loop's search behavior and rewrite its configuration.

Consider:

1. Which tools and moves have produced progress? Focus the search there.
2. Which approaches have been repeated with no payoff? Freeze them.
3. Is the search too broad (touching everything) or too narrow (stuck in one file)?
4. Should the strategy change (`explore` → `exploit`, or the reverse)?
5. What concrete guidance would make the next iterations better?

Rules:

- Do NOT propose specific code changes, file edits, or commands — that is the inner loop's job.
- Focus on PROCESS: what to search, how aggressively, in what order, what to abandon.
- If the loop has been making steady progress, change very little.
- If the loop is stuck, make a significant strategy shift.
- `guidance` replaces the previous guidance wholesale, so restate anything still worth keeping.
- Frozen approaches are named in natural language and enforced by instruction, so make them specific enough to recognize (`"rewriting the tokenizer from scratch"`, not `"bad ideas"`).
{{#if stagnationReason}}
- The loop is stagnating, so you SHOULD propose one `mechanism`: a named, self-limiting intervention on the loop's process, with an observable trigger and an explicit condition for retiring it.
{{else}}
- The loop is not stagnating. Omit `mechanism` unless the trace makes a clear case for one.
{{/if}}
- Retire any active mechanism whose `revertWhen` condition the trace now satisfies.

## Output

Call the `analysis` tool. If that tool is not available to you, reply with the same object as raw
JSON and nothing else — no prose, no code fence:

```
{
  "diagnosis": "what the inner loop is doing right or wrong",
  "strategy": "explore" | "exploit" | "focused",
  "guidance": "process guidance injected into the next inner-loop prompt; replaces prior guidance",
  "reasoning": "why these changes",
  "freezeApproaches": ["approach the inner loop must stop retrying"],
  "unfreezeApproaches": ["previously frozen approach worth reopening"],
  "retireMechanisms": ["name of an active mechanism whose revertWhen condition is now satisfied"],
  "mechanism": { "name": "", "trigger": "", "intervention": "", "revertWhen": "" }
}
```

`diagnosis`, `strategy`, and `guidance` are required. Omit the optional keys rather than sending
empty values, and omit `mechanism` entirely unless you are proposing one.
