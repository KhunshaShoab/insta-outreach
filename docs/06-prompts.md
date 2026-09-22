# 6. AI prompts

Ten production prompts in `prompts/`, each a plain Markdown file with front
matter. They are reviewed and diffed like code, inlined into the n8n Code nodes
at build time, and loaded from disk by the Node tooling — one copy, never two.

Every prompt has the same six sections, because a prompt missing any of them
produces unreliable output:

**ROLE** · **INPUT** · **TASK** · **QUALIFICATION RULES** · **OUTPUT FORMAT** ·
**JSON SCHEMA** · **EDGE CASES**

`tests/prompts.test.mjs` asserts all of that, plus that each prompt names a
schema that exists and demands strict JSON.

| File | Job | Model | Output schema |
| --- | --- | --- | --- |
| `01-qualification.md` | Judge whether a business is worth approaching, and say why | default | `qualification` |
| `02-decision-maker.md` | Pick the person to address and justify it | default | `decision_maker` |
| `03-business-research.md` | The brief the writer opens with | heavy | `research` |
| `04-outreach-angle.md` | Choose the angle when qualification and research disagree | default | `outreach_angle` |
| `05-outreach-message.md` | Three DM variations | heavy | `outreach_message` |
| `06-followup-message.md` | One follow-up, matched to its step | heavy | `followup_message` |
| `07-reply-classification.md` | Classify an inbound reply | default | `reply_classification` |
| `08-suggested-response.md` | Draft the reply for the operator | heavy | `suggested_response` |
| `09-conversation-analysis.md` | Where the thread actually stands | default | `conversation_analysis` |
| `10-daily-report.md` | The narrative around measured numbers | default | `daily_report_summary` |

## Rendering

```js
import { parseFrontMatter, renderPrompt } from './lib/prompts.js';

const prompt = parseFrontMatter(readFileSync('prompts/01-qualification.md', 'utf8'));
const { prompt: text, model, max_tokens, temperature } = renderPrompt(prompt, {
  campaign, niche, lead, company, contacts
});
```

Placeholders:

| Form | Behaviour |
| --- | --- |
| `{{lead.business_name}}` | Required. Rendering **throws** if it is missing. |
| `{{lead.website?}}` | Optional. Renders as `(not available)`. |
| `{{list:niche.pain_points}}` | Array as `- item` lines, or `- (none)`. |
| `{{json:niche.outreach_angles}}` | Pretty-printed JSON block. |

A missing required variable failing loudly is deliberate: a prompt with a hole
in it produces plausible, wrong output, and that is worse than an error.

## The rules that matter most

**Qualification** does not return the final score. It returns five judgement
sub-scores, a reason, two to four grounded pain points, a recommended service
and an angle id from the niche's own list. It may only set `disqualify: true`
for a business that must never be contacted — a competitor, an agency, an
info-product, a personal or fan account, or a genuinely different industry.
Being outside the follower band or the geography is not its call; the
deterministic scorer handles that.

**Research** exists for one field: `specific_observations`. Two to four things
that are demonstrably true about this business and could open a message. "Love
your feed" is not an observation. "Their bio routes pricing questions to DMs
while the clinic runs appointments all day" is.

**Outreach** bans, explicitly and by name: opening with who OptiFlow is, service
lists, generic compliments, fake familiarity, corporate filler ("I hope this
message finds you well", "synergy", "streamline your operations"), AI tells,
pressure, meeting requests, more than one emoji, and any claim about the
business that is not in the input. The model also returns a `self_check` object
and is told to rewrite if any check is false.

Those bans are not only instructions. `wf06`'s guardrail node checks the output
against the same list, plus character limits, emoji count and question count.
A flagged draft still reaches the reviewer — flagged, not silently sent and not
silently dropped.

**Follow-ups** ban "just following up", "circling back", "bumping this", guilt,
pressure, repeating the first message's structure, and emojis. Each step has a
distinct intent: continue the thought (day 2), add something new (day 5),
close the loop respectfully (day 9).

**Reply classification** must return `stop_followups: true` for everything
except an automated away message, and `requires_human: true` for pricing,
objections, opt-outs, wrong-person and not-interested. An opt-out is never
softened and never given a rebuttal.

**The response assistant** may only use facts from a `company_facts` object
built in the workflow. It has no client names and no metrics unless you put
them there, and the prompt tells it to write around a missing fact and flag the
gap rather than invent one. Pricing always routes to a human.

**The daily report** is told not to declare a best niche, state or angle. It
reports measured rates, flags any segment with fewer than 20 sends as too small
to read, and only ranks when the operator has explicitly chosen a metric.

## Changing a prompt

1. Edit the file.
2. Bump `version` in its front matter — `qualification_results.prompt_version`
   and `outreach.prompt_version` record it, so you can compare before and after.
3. `npm test` — the structural checks and the mock-response schema checks run.
4. `npm run build:n8n` — the new text is inlined into the workflows.
