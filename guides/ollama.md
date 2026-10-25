# Local models with Ollama

VOID Workshop can run tasks on models served by a local [Ollama](https://ollama.com) server instead of the Anthropic API. Local models are free, need no Console key, and your key is never sent to Ollama.

## Setup

1. Install Ollama (0.14 or newer; it provides the Anthropic-compatible `/v1/messages` endpoint the agent runtime uses).
2. Start it: `ollama serve`, or `systemctl --user start ollama` / `sudo systemctl start ollama` depending on how it was installed.
3. Pull a capable coding model, e.g. `ollama pull qwen3-coder`, `ollama pull gpt-oss:20b` or `ollama pull devstral`.
4. In VOID Workshop: **Settings → Provider & model → Ollama**, then **Refresh** and choose a model.

The address defaults to `http://127.0.0.1:11434`. Only loopback addresses (`127.0.0.1`, `localhost`, `[::1]`) are accepted, so requests never leave this computer.

## Tips

- The agent sends a long system prompt and many tool definitions. Give Ollama a large context window, e.g. start it with `OLLAMA_CONTEXT_LENGTH=32768` (or more if you have the memory).
- Small models often fail to call tools correctly. Prefer models trained for agentic coding and tool use.
- Spending limits, the budget confirmation and the effort setting apply only to Anthropic models. Turn limits, approvals, the sandbox and path rules apply to both.

## How it works

For an Ollama session the runtime gets `ANTHROPIC_BASE_URL` set to the Ollama address and a placeholder key (`ollama`). The key helper that reads your Console key is not configured. Before the first message is sent, VOID Workshop checks that the runtime is using the placeholder and not the key helper, and stops otherwise.

## What about ChatGPT?

The free ChatGPT plan has no API, and tools that drive it through a web login break OpenAI's terms, so VOID Workshop does not support it. OpenAI's open-weight `gpt-oss` models run in Ollama and work through this provider.
