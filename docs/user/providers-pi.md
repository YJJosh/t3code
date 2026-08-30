# Pi provider

T3 Dulli can run [Pi](https://github.com/badlogic/pi-mono) as a built-in provider. Each T3 thread owns one long-lived `pi --mode rpc` process, so normal Pi profiles, extensions, skills, prompt templates, and project `.pi` resources remain available.

## Configure Pi

Open **Settings → Providers**, add or select **Pi**, and configure any overrides you need:

- **Binary path** – defaults to `pi` on `PATH`.
- **Profile** – defaults to `coder`.
- **Agent directory** – overrides Pi's configuration root. T3 Dulli also honors `PI_CODING_AGENT_DIR` and the legacy Tau directory variables when no explicit value is set.

Pi model names use `provider/model`, for example `openai-codex/gpt-5.6-sol`. The model picker also exposes profile, reasoning, context-window, and supported service-tier options discovered from the configured Pi installation.

Pi sessions run with Pi's approval mode enabled because T3 owns the surrounding runtime approval boundary. Extension input and editor prompts that cannot be represented safely in the provider protocol are cancelled rather than answered with fabricated values.

## Agents and workflows

When the optional `pi-subagents` extension is installed, Pi mirrors its child runs and workflows into T3's normal `task.*` activity stream:

- Web and desktop show them in the **Agents** panel.
- Mobile shows compact agent-run rows above the composer and opens a detail sheet for each run.
- Run details include status, role, model and effort, token/tool usage, recent activity, results, and available Pi run handles.

For a live Pi run, its details expose immediate controls:

- **Steer** sends guidance between turns.
- **Reply** answers a run waiting for input.
- **Stop agent** terminates the selected child run.

Controls are routed through the active provider session and are never recovered against a stale Pi process. If `pi-subagents` is absent, T3 leaves the rest of the Pi provider usable and does not forward the private control command as a model prompt.

## Usage history

The Usage view includes bounded scans of Pi and legacy Tau session layouts, including child sessions discovered from supported subagent transcripts. An explicit Pi agent directory or session-directory environment override takes precedence over default locations.
