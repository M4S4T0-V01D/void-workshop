# Setting up your API key securely

With **API key** selected (see [claude-plan.md](claude-plan.md) for the other option, your Claude plan), VOID Workshop authenticates with an Anthropic **Console API key**: a personal key (`sk-ant-usr-…`), a service-account key, or an older workspace key (`sk-ant-api03-…`). It never reads your normal Claude Code credentials, never accepts pasted OAuth tokens, and refuses to send a request if the agent runtime would authenticate any other way than the account you chose.

## 1. Create a dedicated workspace and key

In the [Anthropic Console](https://platform.claude.com):

1. **Settings → Workspaces → Create workspace**, e.g. `void-workshop`. (Workspaces are available to most organizations; if yours does not offer them, use the default workspace and rely on the organization-level limit.)
2. In that workspace, set a **monthly spend limit** as low as is practical for you (see [billing.md](billing.md)).
3. **Settings → API keys → Create key**, choose the `void-workshop` workspace, name it e.g. `void-workshop-<hostname>`. Pick a workspace even for a personal key: a personal key without one can't tell the API which workspace to bill, and requests fail.
4. Copy the key. You will paste it into VOID Workshop once; you can't view it in the Console again.

Do **not** paste the key into a chat, an AI conversation, an issue, a commit or a screenshot.

## 2. Store the key

### Desktop (recommended): Secret Service

Open **Settings → API key**, paste the key into the password field, keep **Desktop Secret Service** selected and click **Save key**. The key goes from the window to the backend and straight into KWallet (KDE) or GNOME Keyring via `secret-tool`. VOID Workshop then calls the free Models API to verify it and to load the list of models your key can use.

The settings screen shows only whether a key is stored, where, and a short SHA-256 fingerprint (so you can tell keys apart). It never displays the key.

### Headless or terminal: key file

```bash
void-workshop-key set          # Secret Service if available
void-workshop-key set --file   # force the file backend
void-workshop-key status
```

The file backend writes `~/.config/void-workshop/credentials/anthropic-api-key` with mode `600` inside a `700` directory, and refuses to read the file if its permissions are looser. Set `VOID_WORKSHOP_KEY_FILE` to keep it elsewhere (for example on an encrypted volume or a `systemd-creds` tmpfs).

### What about `ANTHROPIC_API_KEY`?

VOID Workshop deliberately ignores it. The launcher unsets it and the backend builds the agent's environment from scratch. The key reaches the agent runtime only through an `apiKeyHelper` script that reads the Secret Service or key file when a request needs it. As a result:

- the key is not in the environment of commands the agent runs;
- it is not written to settings, the database, logs or the UI;
- every log line and UI event passes through a redactor that strips `sk-ant-…` keys and other common tokens anyway.

## 3. How authentication is enforced

Before the first message of every session, VOID Workshop asks the runtime which credential it will use. For an API-key session, unless the answer is *“apiKeyHelper, first-party Anthropic API”*, the session is closed and **no request is sent**. The runtime's config directory is isolated (`~/.local/share/void-workshop/agent-runtime`); the only other credential that can exist there is the Claude plan login you made in VOID Workshop, and the key helper takes precedence over it. If the API rejects the key, the task stops immediately instead of retrying.

## 4. Revoking or replacing a key

If a key may be compromised (pasted somewhere, laptop lost, unexpected usage):

1. **Console → Settings → API keys → disable or delete the key.** This is what actually stops it from working.
2. Create a new key in the same workspace.
3. In VOID Workshop: **Settings → API key → Remove key**, then save the new key. (Terminal: `void-workshop-key delete`, then `void-workshop-key set`.)
4. Check **Console → Usage** for activity you don't recognise.

Removing a key in VOID Workshop only deletes the local copy; it does not revoke it.
