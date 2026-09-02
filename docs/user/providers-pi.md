# Pi provider

T3 Dulli can run [Pi](https://github.com/badlogic/pi-mono) as a built-in provider. Each T3 thread owns one long-lived `pi --mode rpc` process, so normal Pi profiles, extensions, skills, prompt templates, and project `.pi` resources remain available.

## Configure Pi

Open **Settings → Providers**, add or select **Pi**, and configure any overrides you need:

- **Binary path** – defaults to `pi` on `PATH`.
- **Profile** – defaults to `coder`.
- **Agent directory** – overrides Pi's configuration root. T3 Dulli also honors `PI_CODING_AGENT_DIR` and the legacy Tau directory variables when no explicit value is set.

Pi model names use `provider/model`, for example `openai-codex/gpt-5.6-sol`. The model picker also exposes profile, reasoning, context-window, and supported service-tier options discovered from the configured Pi installation.

Pi sessions always run with full local access because T3 owns the surrounding runtime approval boundary, so the composer does not show an access-mode selector for Pi. The Pi profile selector occupies that footer position, while reasoning, context-window, and service-tier controls remain separate. Pi reasoning streams into the work log while a turn is running, and tool calls appear as compact, expandable cards with action-specific icons and output previews. Extension input and editor prompts that cannot be represented safely in the provider protocol are cancelled rather than answered with fabricated values.

## Background terminals

Background terminals started by Pi appear above the composer for the active thread. Running terminals show their title and status without mixing terminal output into the chat timeline; selecting one opens its command, directory, process details, stdout, and stderr. A running terminal can be stopped from this view. Settled terminals remain available in a collapsed summary for the rest of the provider session.

Terminal state belongs to the active Pi process. T3 requests a replay when a client subscribes, ignores updates from an older manager after Pi restarts, and never sends a terminal control to a stale provider session.

## Agents and workflows

When the optional `pi-subagents` extension is installed, Pi mirrors its child runs and workflows into T3's normal `task.*` activity stream:

- Web and desktop show them in an adaptive **Agents** inspector: a live roster and detail pane at wider panel widths, or a focused list/detail flow in compact layouts. Runs are separated by the prompt that introduced them. Each workflow occupies one roster row; selecting it opens a visual phase tree in the detail pane, where every nested agent shows its own model and can be selected.
- Selecting a direct agent or workflow child opens the same live conversation view. It includes the originating prompt, streamed and persisted reasoning, assistant messages, tool calls and output, final results, status, model and effort, token/tool usage, and available controls. Durable child events are restored after a reconnect while bounded live deltas update in place.
- Mobile shows compact agent-run rows above the composer and opens a detail sheet for each run.

For a live Pi run, its details expose immediate controls:

- **Steer** sends guidance between turns.
- **Reply** answers a run waiting for input.
- **Stop agent** terminates the selected child run.

Controls are routed through the active provider session and are never recovered against a stale Pi process. If `pi-subagents` is absent, T3 leaves the rest of the Pi provider usable and does not forward the private control command as a model prompt.

## Usage history

The Usage view includes bounded scans of Pi and legacy Tau session layouts, including child sessions discovered from supported subagent transcripts. An explicit Pi agent directory or session-directory environment override takes precedence over default locations.
