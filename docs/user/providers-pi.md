# Pi provider

T3 Dulli can run [Pi](https://github.com/earendil-works/pi) as a built-in provider. Each T3 thread owns one long-lived `pi --mode rpc` process, so normal Pi profiles, extensions, skills, prompt templates, and project `.pi` resources remain available.

## Configure Pi

Open **Settings → Providers**, add or select **Pi**, and configure any overrides you need:

- **Binary path** – defaults to `pi` on `PATH`.
- **Profile** – defaults to `coder`.
- **Agent directory** – overrides Pi's configuration root. T3 Dulli also honors `PI_CODING_AGENT_DIR` and the legacy `TAU_CODING_AGENT_DIR` when no explicit value is set. Discovery, chat, and text generation use the same resolved directory, including `~` expansion.

Pi model names use `provider/model`, for example `openai-codex/gpt-6-astra`. Model discovery uses the bundled Pi SDK and your configured extensions and credentials. The picker also exposes profile, reasoning, context-window, and supported service-tier options. Fast is shown only for models supported by the loaded `/fast` extension; GPT-6 Astra does not currently expose it.

Pi sessions always run with full local access because T3 owns the surrounding runtime approval boundary, so the composer does not show an access-mode selector for Pi. Its place holds one menu for **Config set** and **Profile** (for example, `main · coder`); reasoning, context-window, and service-tier controls remain separate. On mobile both are in the thread's model options.

Config sets are the Pi homes registered with Profile Manager. The set you choose applies to that thread only and never changes the global selection. Remote sets must already be mounted on the server machine. The set is hidden when fewer than two sets are registered. Changing the set or profile restarts Pi before the next message and keeps the conversation; wait for the current turn to finish first. A profile must exist in the chosen set.

Extension menus, confirmations, and text prompts (for example `/pm`) appear as questions in chat on web, desktop, and mobile. Choose an answer or dismiss the question to cancel; T3 never picks a menu entry for you. Timed dialogs disappear when they expire.

## Conversation display

Completed work folds intermediate commentary, tool activity, and routine background-notification replies under **Worked for…**. The actual answer stays visible, even if a later subagent or workflow notification produces another reply. Expand the work log to review the progress messages. Pi text blocks render separately so headings, lists, and code blocks do not run into preceding text.

Older saved Pi conversations may still show progress messages outside the fold because they did not record the distinction between commentary and answers. Ambiguous or partial replies also stay visible rather than risk hiding the only answer.

Thinking rows show the reasoning summary or text supplied by the model and expand to reveal its available content. Models that do not expose reasoning have no reasoning text to display. Tool calls remain compact, expandable cards with action-specific icons and output previews.

## Extension commands

Registered extension commands such as `/ps` and `/subagents` run directly in Pi, including while an agent is working. Commands that do not start model work finish without leaving the thread's working indicator active. Private inspector-control commands are hidden from the slash menu.

## Background threads

With `pi-background-threads` installed, ask Pi to use `thread_spawn` with a task and optional title. The new thread appears in the same project, shares the parent’s branch and working directory, and inherits its provider instance, model options (including profile), and modes. Its first turn starts with the requested task. Open the new thread to follow, reply to, or stop it; the extension’s `thread_status` does not mirror T3 thread status. Both threads can edit the same files, so give parallel tasks non-overlapping scope.

## Background terminals

Background terminals started by Pi, and terminals you start yourself, live in the **Shared terminals** surface of the right panel. Open it from the panel's **+** menu, press **S** in the empty panel, or type `/ps` in the composer. The surface lists running and settled terminals; selecting one shows its command, directory, process details and output, and a running terminal can be stopped there. **Start terminal** runs a command in the thread's working directory inside the live Pi session, so Pi can see and use it too; `/terminal <command>` (or `/terminal -k <command>` to keep a shell open after the command exits) does the same from the composer. Both need Pi to be running in the thread, so send a message first in a brand-new thread. Running terminals also show in a compact strip above the composer that opens the surface. With an updated `pi-background-terminals` extension, interactive terminals open a live color screen in web and desktop. Choose **Take control** to type, paste, use arrow keys or Ctrl+C, and resize the terminal to the panel; **Release control** returns input to the agent. Only one person (including Pi’s terminal UI) can control a terminal at a time. Closing the panel releases it; a disconnected browser’s control expires within a minute. Ordinary background commands and mobile retain the read-only text view. `/subagents` and `/workflows` open the Agents surface the same way.

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

## Import sessions from pi-sessions

If you use the optional **pi-sessions** extension, T3 can import stopped Pi sessions
from its running daemon on the same machine as your T3 environment. T3 checks after
startup and every five minutes. To check now, use **Refresh Pi sessions** in Pi's
provider settings (web or desktop), or in the environment's settings on mobile.
Agents can also call the `refresh_pi_sessions` MCP tool.

Only sessions whose working directory exactly matches an existing project's root
are imported. T3 does not create projects, start the daemon, or import sessions
that are still open in another process. The session's Pi agent directory must
match exactly one enabled provider instance; unknown or ambiguous configurations
are skipped. Each check processes a bounded batch, so larger lists can take more
than one check.

Imported threads follow the daemon's settled state; settled threads appear in the
project's history, where you can open or unsettle them to continue. History is
imported once, as user and assistant text from the active branch (up to 200
messages). Files over 64 MiB or corrupt session files are skipped. Later transcript
edits and live viewing are not supported yet. T3-created sessions are linked
rather than imported again. When resuming, stop or detach the session's other Pi
process first if pi-sessions reports an ownership conflict.

Settled state syncs both ways on the same five-minute checks and explicit refreshes,
for imported threads and T3-created Pi threads linked to this environment. On the
first check, an imported thread follows the daemon; a T3-created thread follows
T3. Later changes on either side carry over to the other. If both sides changed
and disagree, **unsettled wins**, keeping the thread visible on both sides. A
settlement T3 cannot accept yet (for example, while the agent is running) is
retried on a later check. Older daemons without settlement revisions still support
imports, but skip settled-state synchronization.

Without a running compatible daemon, Pi works as usual. Existing background
terminal, subagent, and background-thread integrations do not require pi-sessions.
