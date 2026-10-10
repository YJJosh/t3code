# Pi provider

T3 Dulli can run [Pi](https://github.com/earendil-works/pi) as a built-in provider. Normal Pi profiles, extensions, skills, prompt templates, and project `.pi` resources remain available. With pi-sessions, the same chat can be used from T3 and the terminal at the same time.

## Configure Pi

Open **Settings → Providers**, add or select **Pi**, and configure any overrides you need:

- **Binary path** – defaults to `pi` on `PATH`.
- **Profile** – defaults to `coder`.
- **pi-sessions** – on by default. T3's Pi loads the pi-sessions extension from where it last ran on this computer (`~/.pi/pi-sessions/start.json`), so it does not need to be in your Pi config set. Off: T3's Pi runs without it (`PI_SESSIONS=off`), nothing is shared and nothing is reported to the daemon. Applies to new connections.
- **Share Pi chats with the terminal** – on by default; needs **pi-sessions** on. Uses pi-sessions when its daemon is available; applies to new connections.
- **Agent directory** – overrides Pi's configuration root. T3 Dulli also honors `PI_CODING_AGENT_DIR` and the legacy `TAU_CODING_AGENT_DIR` when no explicit value is set. Discovery, chat, and text generation use the same resolved directory, including `~` expansion.

Pi model names use `provider/model`, for example `openai-codex/gpt-6-astra`. Model discovery uses your installed Pi with its configured extensions and credentials, so the picker lists the same models as `pi` in your terminal. The picker also exposes profile, reasoning, context-window, and supported service-tier options. Fast is shown only for models supported by the loaded `/fast` extension; GPT-6 Astra does not currently expose it. Context-window sizes come from the loaded `/context` extension, so sizes it adds, such as GPT's opt-in windows up to 872K, appear after the next model refresh without a T3 update.

Pi sessions always run with full local access because T3 owns the surrounding runtime approval boundary, so the composer does not show an access-mode selector for Pi. Its place holds one menu for **Config set** and **Profile** (for example, `main · coder`); reasoning, context-window, and service-tier controls remain separate. On mobile both are in the thread's model options.

Config sets are the Pi homes registered with Profile Manager. The set you choose applies to that thread only and never changes the global selection. Remote sets must already be mounted on the server machine. The set is hidden when fewer than two sets are registered. In T3-owned sessions, changing the set or profile restarts Pi before the next message and keeps the conversation; wait for the current turn to finish first. A profile must exist in the chosen set.

When using T3’s own Pi process, extension menus, confirmations, and text prompts (for example `/pm`) appear as questions in chat on web, desktop, and mobile. Choose an answer or dismiss the question to cancel; T3 never picks a menu entry for you. Timed dialogs disappear when they expire.

## Shared chats with the terminal

Install and start **pi-sessions** on the same machine as your T3 environment, then leave **pi-sessions** and **Share Pi chats with the terminal** on in **Settings → Providers → Pi**. pi-sessions only has to have run once on this computer; it does not have to be in the config set T3's Pi uses. T3 joins the daemon’s interactive Pi instead of starting a second writer. Open the chat from Pi’s `/overview` to use its real terminal screen, including extension UIs. Messages, aborts, model changes and thinking-level changes work against the same chat from either side.

Terminal chats appear automatically when their working directory exactly matches an existing T3 project root, or is a Workler workspace of one (`<project>/.worktrees/<name>`, for example from pi-sessions' `/workler`), and their agent directory matches one enabled, sharing-enabled Pi provider instance. Workspace chats keep their workspace and branch, and a branch the agent renames in the terminal is shown in T3 once the workspace's `HEAD` confirms it. T3 never creates projects for them. Discovery waits until Pi has written a session file; initial history keeps up to 200 text messages from the active conversation branch. Ambiguous provider homes are skipped.

T3 receives changes as they happen; there is no refresh button or periodic session scan. Settle and unsettle synchronize in both directions. Newly discovered chats follow Pi’s settled state; existing T3 chats initially follow T3. If both sides change at once, unsettled wins so work stays visible.

In an existing shared chat, change the profile or config set in the terminal rather than restarting Pi from T3.

Extension dialogs are answered **only in the terminal**. T3 shows “Waiting for you in the terminal” until the dialog closes. Background terminals and subagent panels still work. In a shared chat, Claude Code’s own tool calls show as tool rows with their command or path, but without output.

Closing T3’s connection leaves the shared Pi running. If Pi exits or switches to another session in the terminal, T3 ends that connection. Sending another message reopens the original conversation. A session held by classic Pi or a separate T3 RPC process cannot be shared; T3 reports “open elsewhere” instead of starting a new conversation.

**Current limit:** initial discovery imports bounded history, but reconnecting an already-linked chat does not backfill completed turns missed while T3 was disconnected. Those messages remain in Pi’s session and terminal history; new live messages resume in T3. An in-progress assistant response is replayed on attach. Images sent from the terminal are not copied into T3 attachments; image-only prompts appear as a placeholder.

When no daemon is running yet (for example after a restart, before any terminal ran `pi`), T3 starts it the way pi-sessions last started it, so the first chat is shared too. Without pi-sessions, when the daemon cannot be started, or with sharing turned off, T3 uses its own `pi --mode rpc` process as before. If pi-sessions has never run on this computer (no `start.json` yet), T3 cannot find it: run `pi` in a terminal once. If T3's Pi still does not load pi-sessions, a shared start fails after about 8 seconds and T3 then uses its own Pi for that Pi binary for 10 minutes. Background-terminal and subagent extensions continue to work without pi-sessions. Only the environment’s server talks to the local daemon, so web, desktop, mobile, and remote T3 connections use the same shared chat.

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
