# Billing, credits and spend limits

VOID Workshop sends requests with your Console API key, so usage is billed to **the Console organization and workspace that own the key**, at standard API rates for the selected model. There are three separate controls, and it helps to know which is which.

## 1. Local app limits (in VOID Workshop)

*Settings → Spending limits.* Defaults are deliberately conservative:

| Limit | Default | What happens |
|---|---|---|
| Estimated spend per task | $1.00 | The agent runtime is given this cap; the task stops with *Limit reached*. |
| Estimated spend per day | $3.00 | New tasks are refused; a running task is capped to what is left today. |
| Agent turns per task | 20 | The task stops with *turn limit reached*. |
| Output tokens per request | 16,000 | Passed to the runtime as `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. |
| Confirm before expensive tasks | at ≥ $2 budget | A confirmation dialog before starting. |

These figures are **estimates**: the Agent SDK multiplies the token counts it observes by its built-in price table for the model that served each request. They are not your bill. Things that make the real number differ:

- retries after errors, prompt-cache reads and writes, and price changes;
- server-side features the SDK prices differently;
- other tasks, other apps or other people using the same organization;
- a cap can be slightly exceeded, because the check happens between requests.

VOID Workshop shows *“Estimates only: Console billing not connected”* in the status bar because it cannot see your real balance (see below).

## 2. Workspace and organization spend limits (in the Console)

*Console → Settings → Limits*, and per-workspace limits under *Workspaces*. These are enforced by Anthropic. When a limit is reached the API refuses requests; VOID Workshop shows the error and stops.

Recommended setup:

- a **dedicated workspace** for VOID Workshop, with its own key;
- a **workspace monthly spend limit** as low as practical (for example a little above what you expect to use);
- **auto-reload turned off** in Console Billing if you want work to stop when credit runs out instead of charging your card.

VOID Workshop never changes these settings, never buys credits and never enables auto-reload. The only switch it makes is between your Claude plan and your API key, and only when you leave *Switch when one runs out* on (see [claude-plan.md](claude-plan.md)); the dollar limits always apply to the API key.

## 3. Included monthly API credits

Some Claude plans include a monthly API credit that is applied to a Console organization you link to the plan. Treat the following as the general shape and confirm the exact terms for your account in the Console and Anthropic's help center:

- the credit belongs to the **linked organization**, not to VOID Workshop, and is **shared** with every other API key and app in that organization;
- it typically **expires** at the end of each period if unused;
- once it is used up, requests are either billed to your payment method or refused, depending on your billing setup;
- interactive Claude Code usage under your subscription is separate from API usage.

To make sure VOID Workshop draws on the included credit, create its workspace and key **inside the linked organization**, then check *Console → Billing* and *Usage* after a small first task.

## Why the app can't show your remaining balance

There is no supported API endpoint that lets an ordinary API key read the organization's remaining credit. VOID Workshop therefore never displays a "balance"; it shows its own estimates and links you to the Console Billing and Usage pages. When the API reports a billing error (for example *credit balance too low*), the app stops all requests, records a billing stop, and refuses new tasks until you confirm under *Settings → Billing & usage* that you have checked the Console.
