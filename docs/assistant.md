# Assistant

A read-only assistant inside VerdFlow. It answers questions such as **"What is scheduled under my
name?"** from the signed-in person's own rota, and works across their work, the team, studies,
turnaround and escalations.

## Engines

- **Claude** (`AI_MODEL`, default `claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set and `AI_ENABLED` is
  not `false`. A manual tool loop (at most 6 rounds) with adaptive thinking, low effort for chat, strict
  tool schemas, and server-side refusal fallbacks (`fallbacks: "default"`).
- **Built-in** otherwise, and whenever a Claude call fails. It recognises the common questions from their
  wording and answers from the same tools with templates. The schedule question works with no key at all.

## Tools (all read-only)

| Tool | Answers | Needs |
|---|---|---|
| `my_schedule` | Shifts, leave, breaks, training under your name; whether you can take work now | signed in, linked to a radiologist profile |
| `my_work` | Studies assigned to you with turnaround, your open peer reviews, vetting waiting | signed in |
| `who_is_on_shift` | Who is on at a time, teams, status, load | studies.view |
| `find_studies` | Studies by state, accession, priority, overdue or at risk | studies.view |
| `explain_study` | Routing decision, exclusions, delivery, clocks, escalations, peer review | studies.view |
| `operations_summary` | Backlog, states, delivery problems, escalations, availability | dashboard.view |
| `turnaround_report` | Met and late by interval and priority, median minutes | studies.view |
| `open_escalations` | Open escalations and who acknowledged them | studies.view |

Every call is checked against the user's permissions and validated before it runs. The "my" tools use
the radiologist profile linked to the sign-in (Masters, or `radiologists.user_id`).

## Other AI features

- **Explain in plain English** on the study page.
- **Briefing** on the dashboard.
- **Draft rules from a description** in the rule editor: Claude proposes a full rule set, VerdFlow
  validates it (one retry with the errors), and the author reviews it in the editor. It is never saved or
  published by the assistant; the normal draft → submit → second-person approval still applies.

## Data protection

- Tools never return patient names or patient identifiers; studies are named by accession.
- Conversations are stored per user and only that user can read them.
- The audit log records each question's engine and the tools used, not the text typed.
- Sending VerdFlow data to Claude needs the deployment's data-processing agreement and residency
  approval. Set `AI_ENABLED=false` to keep the assistant on the built-in engine.
