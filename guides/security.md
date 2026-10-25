# Security model

VOID Workshop treats the model's output and the contents of your repository as **untrusted input**. Every action that changes something needs your explicit approval, one action at a time, and several layers sit behind that approval.

## Layers

| Layer | Where | What it does |
|---|---|---|
| Webview isolation | Tauri | The UI has no filesystem, shell or HTTP access. It can only call allow-listed backend methods with size-limited parameters. A strict CSP blocks remote scripts. |
| Root refusal | Rust shell, sidecar, launcher | All three refuse to run with uid/euid 0. |
| Clean environment | Rust shell, sidecar | The sidecar starts with an allow-listed environment; `ANTHROPIC_*`, `CLAUDE_*`, proxies and tokens from your shell are dropped. The agent runtime gets a freshly built environment. |
| Auth gate | Sidecar | Before any message is sent, the runtime must report the chosen account on the first-party API: `apiKeyHelper` for the API key, or a Claude plan login with no API key for the plan. Its config dir is isolated: it never sees `~/.claude`, and the only plan login in it is the one made from VOID Workshop's settings. |
| Parameter validation | Sidecar | Every RPC method validates input with zod. |
| Path policy | Sidecar | Paths are canonicalised (`realpath` on every existing component), so `..`, symlinks, `~` and odd representations can't leave the project or explicitly approved extra directories. Home-directory secrets (`~/.ssh`, `~/.gnupg`, `~/.aws`, keyrings, browser profiles, `~/.claude`, the app's own data) are always off limits. |
| Sensitive files | Sidecar | `.env*` (not `.env.example`), private keys, credential files, `.npmrc`, `.netrc` and similar need explicit approval to read, and are hidden in the file viewer until you click *Show*. Runtime deny rules also cover them for search tools (best effort). |
| Plan mode | Sidecar hook | During planning, writes and non-read-only commands are refused by a PreToolUse hook. |
| Edit automatically / Auto modes | Sidecar approval gate | Only skip the approval dialog. Path policy, the command blocklist, budgets and Changes review still apply; sensitive files always ask; Auto runs commands unasked only when the sandbox is on. |
| File approvals | Sidecar | Each write shows a unified diff. On approval the file's hash must still match what you reviewed, otherwise the edit is refused (external change detection). The original is stored so the change can be rejected later; rejecting refuses to overwrite later external edits unless you confirm. |
| Command approvals | Sidecar + UI | Each command shows the exact text, working directory, the agent's stated reason, what it does (reads / modifies files / network / git / installs), warnings and sandbox status. A single approval never covers later commands; only switching to Auto (sandbox on) stops the dialogs. |
| Command policy | Sidecar | Refused outright: privilege escalation (`sudo`, `pkexec`, …), broad recursive deletion, `find -delete/-exec`, disk and system tools, pushes and history rewriting, publishing, global installs, uploads with curl/wget, raw network tools, SSH, keyring/D-Bus access, reading `/proc/*/environ`, references to the API key or the app's own config, background/detached processes, piping into interpreters, fork bombs. Opt-in (*Settings → Agent behaviour*): `gh`, plain `git push`, `wrangler` and project `release.sh` scripts become approvable; they always ask (also in Auto), must run on their own and run outside the sandbox with your logins, while force/delete pushes, `gh auth` and deletions stay refused. |
| Sandbox | Agent SDK (bubblewrap) | Agent commands can write only inside the project, can't read credential directories, can't reach the network except domains you list under *Project access*, and can't opt out of the sandbox. |
| Process hygiene | Sidecar | Runner commands use argv arrays (no shell), run in their own process group, have a timeout and output cap, and the whole group is killed on cancel/timeout. Background agent commands are refused. |
| Git hardening | Sidecar | Git runs with `core.fsmonitor`, hooks, external diff and credential helpers disabled, so a hostile `.git/config` can't execute programs when VOID Workshop inspects a repository. |
| Redaction | Sidecar | Logs, UI events, task history and command output are scrubbed of API keys, bearer tokens, common cloud/GitHub tokens and PEM private keys. |
| Admin dev session | Sidecar | Opt-in, behind an admin password you set on the PC (scrypt hash in Workshop's credentials folder; five wrong tries lock it for five minutes). While it runs, tasks get full access with Auto publishing, Workshop's source as a writable folder, its logs and database, the agent env-variable names in commands, and a tool that installs a new build and restarts. The credentials and config folder (API key, phone pairings, this password) and the agent runtime folder (Claude sign-in) stay blocked. Started and ended from the PC or VOID Portal; ending it stops tasks still working in it, and the other sessions resume without the extra powers. From the phone, safety settings need the password too. See [admin-dev.md](admin-dev.md). |
| No telemetry | Runtime env | The agent runtime runs with nonessential traffic, telemetry, error reporting and auto-update disabled. There is no remote server or proxy; the only network destination is `api.anthropic.com`. |

## Known limitations

- **Approval is the main control for commands.** The policy is a guard rail, not a complete shell parser. Commands with substitutions, inline interpreter code (`bash -c`, `python -c`) or obfuscation are flagged for careful review but can't be fully analysed. Read every command.
- **Without the sandbox** (if `bubblewrap`/`socat` are missing or you turn it off), approved commands run with your full user permissions.
- **Project scripts are code.** Approving `npm install`, `npm test` or `make` runs whatever the project defines, including install scripts. Treat unfamiliar repositories accordingly.
- **Search tools and sensitive files.** Read access to sensitive files is gated, and deny rules are applied to Grep/Glob on a best-effort basis by the runtime; a broad content search could still surface a line from a sensitive file that isn't hidden or gitignored.
- **D-Bus.** The key helper needs the session bus to read the Secret Service. Sandboxed commands don't get the bus address. Unsandboxed approved commands could reach the Secret Service like any program you run.
- **Cost estimates** are estimates (see [billing.md](billing.md)).
- **Checkpoints** use `git stash create` and include tracked changes only; untracked files the agent changes are still protected by VOID Workshop's own stored originals.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository rather than a public issue.
