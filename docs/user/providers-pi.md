# Pi provider

T3 Dulli can run [Pi](https://github.com/earendil-works/pi) as a built-in provider. Each T3 thread owns one long-lived `pi --mode rpc` process, so normal Pi profiles, extensions, skills, prompt templates, and project `.pi` resources remain available.

## Configure Pi

Open **Settings → Providers**, add or select **Pi**, and configure any overrides you need:

- **Binary path** – defaults to `pi` on `PATH`.
- **Profile** – defaults to `coder`.
- **Agent directory** – overrides Pi's configuration root. T3 Dulli also honors `PI_CODING_AGENT_DIR` and the legacy `TAU_CODING_AGENT_DIR` when no explicit value is set. Discovery, chat, and text generation use the same resolved directory, including `~` expansion.

Pi model names use `provider/model`, for example `openai-codex/gpt-6-astra`. Model discovery uses the bundled Pi SDK and your configured extensions and credentials. The picker also exposes profile, reasoning, context-window, and supported service-tier options. Fast is shown only for models supported by the loaded `/fast` extension; GPT-6 Astra does not currently expose it.

Pi sessions always run with full local access because T3 owns the surrounding runtime approval boundary, so the composer does not show an access-mode selector for Pi. The composer’s configuration menu combines **Config set** and **Profile** (for example, `main · coder`); reasoning, context-window, and service-tier controls remain separate. Mobile exposes both in the thread’s model Options sheet.

Config sets are complete Pi homes registered with Profile Manager. Choosing one applies only to this thread: Dulli never changes the global registry or agent link, mounts a share, or synchronizes a set. Remote sets must already be mounted and prepared on the server machine. Without a valid registry the menu shows only Profile; with fewer than two registered sets its label omits the set name. New-thread defaults use the existing model-option defaults in Settings.

Profile names are gathered from the available homes, with the provider’s configured profile as the default. A name can have different settings in each home; choose one that exists in the selected set. Changing a set or profile restarts an idle Pi process on the next send, retaining the thread’s conversation file in its original home. Wait for active work to finish first. Older Pi sessions that cannot report their conversation file require a new thread to change homes. Session-scoped config-set restrictions require a Profile Manager version supporting the session environment contract; Dulli does not install the launcher’s legacy-PM compatibility adapter. Extension input and editor prompts that cannot be represented safely in the provider protocol are cancelled rather than answered with fabricated values.

## Conversation display

Completed work folds intermediate commentary, tool activity, and routine background-notification replies under **Worked for…**. The actual answer stays visible, even if a later subagent or workflow notification produces another reply. Expand the work log to review the progress messages. Pi text blocks render separately so headings, lists, and code blocks do not run into preceding text.

Older saved Pi conversations may still show progress messages outside the fold because they did not record the distinction between commentary and answers. Ambiguous or partial replies also stay visible rather than risk hiding the only answer.

Thinking rows show the reasoning summary or text supplied by the model and expand to reveal its available content. Models that do not expose reasoning have no reasoning text to display. Tool calls remain compact, expandable cards with action-specific icons and output previews.

## Extension commands

Registered extension commands such as `/ps` and `/subagents` run directly in Pi, including while an agent is working. Commands that do not start model work finish without leaving the thread's working indicator active. Private inspector-control commands are hidden from the slash menu.

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

Controls wait for the extension's correlated result, so an accepted request is not reported as successful if the operation fails. They are routed through the active provider session and are never recovered against a stale Pi process. If `pi-subagents` is absent, T3 leaves the rest of the Pi provider usable and does not forward the private control command as a model prompt.

## Usage history

The Usage view includes bounded scans of Pi and legacy Tau session layouts, including child sessions discovered from supported subagent transcripts. An explicit Pi agent directory or session-directory environment override takes precedence over default locations.
