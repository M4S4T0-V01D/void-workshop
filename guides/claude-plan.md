# Using your Claude plan (Pro / Max)

Besides a Console API key, VOID Workshop can run on the usage included in your Claude plan. You can switch between the two at any time, and it can switch for you when one runs out.

## Sign in

**Settings → Sign-in & API key → Sign in with Claude.** Your browser opens Claude's sign-in page; approve access and come back. The settings screen then shows the account and plan, and the plan's models join the model list.

What happens underneath:

- The sign-in is done by the Claude Code runtime that ships inside VOID Workshop (`claude auth login --claudeai`), not by VOID Workshop's own code.
- The resulting tokens are stored in VOID Workshop's isolated runtime folder (`~/.local/share/void-workshop/agent-runtime`), **not** in `~/.claude`. Your normal Claude Code login (terminal, VS Code) is a separate login and is never read or changed; signing out of one does not sign you out of the other.
- The tokens never pass through the window. The agent can't read that folder: it is outside every project, blocked by the path policy, and hidden from sandboxed commands.

**Sign out** removes the tokens from that folder. **Check** re-reads the sign-in state.

## Choose which account pays

Under the prompt box, next to the model picker, the account button switches between **Claude plan** and **API key** (also under *Settings → Sign-in & API key → Which account pays*).

| | Claude plan | API key |
|---|---|---|
| Paid by | your subscription's usage limits | Console credit, per token |
| Dollar limits (per task / per day) | not applied (no per-token cost) | applied |
| Turn limit, approvals, sandbox, path and command policy | applied | applied |

Switching in the middle of a conversation is fine: the next message closes the session and resumes the same conversation with the other account.

## Switch when one runs out

With **Switch when one runs out** on (the default):

- When the Claude plan reaches its 5-hour or weekly limit, the current task stops, and continues where it left off with your API key. New tasks also use the API key until the reset time the plan reported; then the plan is used again. The dollar limits apply while the API key is in use.
- When the API key runs out of credit (a billing error), the task continues on your Claude plan.

The status bar and the account button show *(fallback)* while the other account stands in. **Try the plan again now** in Settings clears the plan limit early if it reset sooner.

With it off, the task stops with *Plan limit* or *Billing stop*, and you switch by hand.

## How the account is checked

Before the first message of each session VOID Workshop asks the runtime how it will authenticate, and closes the session without sending anything unless the answer matches the chosen account:

- **Claude plan:** a Claude plan login, with no API key of any kind loaded (the key helper is not configured for these sessions).
- **API key:** the VOID Workshop key helper. The API key takes precedence over the plan login in the runtime, so a plan login stored alongside can't be used by an API-key session.

## Personal use

This lets *you* use *your* plan in your own copy of VOID Workshop. Anthropic's terms do not allow third-party products to offer Claude plan sign-in to their users without approval, so if you distribute VOID Workshop to others, leave this feature out of what you offer them or get Anthropic's approval first.
