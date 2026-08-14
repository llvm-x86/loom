<search-directive cycle="{{cycle}}">
The outer loop reviewed the last {{windowIterations}} iterations of this goal and adjusted how you should search. This directive governs your *process*, not the objective — the objective is unchanged and still authoritative.

Strategy: **{{strategy}}**
{{#if strategyHint}}
{{strategyHint}}
{{/if}}
{{#if diagnosis}}

Assessment of the loop so far: {{diagnosis}}
{{/if}}
{{#if guidance}}

Guidance:
{{guidance}}
{{/if}}
{{#if frozenApproaches}}

Ruled out — do NOT spend further iterations on these, and do not re-derive them under a new name:
{{#each frozenApproaches}}
- {{this}}
{{/each}}
{{/if}}
{{#if mechanisms}}

Active mechanisms — follow each while its condition holds:
{{#each mechanisms}}
- **{{this.name}}**: {{this.intervention}}{{#if this.revertWhen}} (stop when: {{this.revertWhen}}){{/if}}
{{/each}}
{{/if}}

This directive tunes your search; it NEVER lowers the bar for completion. The completion audit below still applies in full.
</search-directive>
