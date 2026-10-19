# Dulli provider

Dulli runs your installed [Pi](https://github.com/earendil-works/pi) coding agent with its profiles, extensions, skills, prompt templates, and project `.pi` resources. It is separate from T3's **Pi** provider; both launch the native `pi` executable, but Dulli retains the fork's profile and configuration-set options.

## Set up Dulli

Install Pi on the machine running your T3 environment, run `pi` in a terminal, and configure credentials with `/login` or your normal Pi configuration. In **Settings → Providers → Dulli**, check these settings:

- **Binary path** defaults to `pi` on the environment's `PATH`.
- **Profile** defaults to `coder`.
- **Agent directory** overrides Pi's configuration home. If empty, Dulli uses `PI_CODING_AGENT_DIR`, then the legacy `TAU_CODING_AGENT_DIR`, then `~/.pi/agent`. Home-relative paths use the environment's home directory.
- **pi-sessions** permits the native extension when loaded by your Pi configuration. Turning it off sets `PI_SESSIONS=off` for new connections.

The environment owns the process and configuration, including when you connect from another computer or mobile device. Dulli uses full local access; it does not offer T3's supervised-access modes.

## Models and configuration

Model names use `provider/model`, such as `anthropic/claude-sonnet-5`. Discovery uses the SDK from your installed Pi, falling back to the bundled SDK if necessary, and lists models available with your configured credentials. Changes to the root model, auth, profile, and settings files refresh the catalog. Extension changes are picked up on a later refresh.

Choose **Config set** and **Profile** separately from reasoning, context-window, and speed options in the web or desktop composer. On mobile, these choices are in the thread's model options. Config sets are homes registered with Profile Manager. Selecting one applies only to this thread; Dulli never switches the global home or mounts remote directories. Remote sets must already be mounted and synchronized on the environment machine.

Changing the profile or config set restarts the idle Pi process before the next message, retaining the absolute conversation file. Wait for the current turn to finish first. A selected profile must exist in that home. If a model temporarily disappears from discovery, Dulli keeps the saved selection rather than silently choosing another one.

Reasoning choices follow the model's supported thinking levels. Context-window choices come from the loaded `/context` extension. **Fast** requires the loaded `/fast` extension and a supported OpenAI Codex model; it is not available for every model. A stale context or speed option warns rather than sending an unknown command to the model.

## Chat and extension commands

Send text and images normally, steer an active turn, or stop it. `/compact` reduces conversation context; it can include instructions. Registered extension commands can run while the agent is working. A command that does not start agent work finishes without leaving the thread marked busy.

Extension selections, confirmations, inputs, and editors appear as questions in chat on web, desktop, and mobile. Dismiss a question to cancel; Dulli never chooses its first option for you. Timed questions expire, and session-scoped questions can outlive an unrelated model turn.

Assistant text blocks remain separate paragraphs. Thinking rows contain actual reasoning provided by the model. Native tool calls and the Claude Agent SDK's tool-lifecycle notifications appear in the work log. Growing tool previews are bounded; completed results retain their structured content.

Dulli stores Pi's absolute session-file path to resume the native conversation. If that file is gone, it starts a new Pi conversation with a warning: earlier T3 messages remain visible but are not automatically restored into Pi's memory. Native session-tree rollback and fork are supported when Pi exposes the required session-tree RPC methods.

Without shared terminal chats, Dulli owns one Pi RPC process per active thread. Do not open that same session file in another writer while it is active.

## Agent tools

Pi is Dulli's agent harness. Use your Pi extensions for child agents, new threads, browsers, and HTML; Dulli does not register T3's duplicate delegation, thread-creation, browser-preview, or HTML tools. New Pi threads use `pi-sessions`.

The **T3 Code** tool group remains available for projects, thread records, schedules, secrets, PR links, attachments, worktree handoff, devices, and environment settings. Its provider/model catalog remains available too. To show an image in chat, the agent should embed a standalone Markdown image using an absolute path, such as `![Screenshot](/absolute/path.png)`, rather than only linking the file; never use base64.

## Shared terminal chats

Install the native `pi-sessions` extension on the environment machine and leave **pi-sessions** and **Share with terminal** enabled in Dulli's provider settings. Dulli and the terminal can then use the same live Pi conversation. If sharing is unavailable, new connections fall back to a private RPC process; a session already open elsewhere is never opened as a second writer. Closing a shared connection detaches T3 rather than killing Pi.

A shared connection stays bound to its native Pi conversation file. Resuming the same chat keeps its native history; opening another chat detaches and reconnects through `pi-sessions`. Shared chats do not support T3's native conversation rollback or fork, and `/compact` must be run in the terminal. Model and thinking changes, messages, and conversation snapshots remain available.

Terminal chats appear automatically in an existing project with the same working directory, including that project's `.worktrees/<name>` directories. Discovery never creates projects and skips ambiguous provider-home or project matches. Initial imports keep up to 200 text messages. Reconnecting an already-linked chat resumes live events but does not backfill completed turns missed while disconnected; terminal-only images appear as placeholders.

Terminal messages, aborts, model and thinking changes follow into the live chat. Web and desktop also update the composer's model and thinking selection; mobile keeps any unsent composer selection. Settling or reopening a linked chat follows in either direction; simultaneous conflicting changes keep it visible. Worktree branch changes follow only when they match the checkout's current HEAD. Extension dialogs in a shared process remain in the terminal: when T3 says **Waiting for you in the terminal**, answer there.

## Shared terminals

With the `pi-background-terminals` extension installed, web and desktop can inspect the live Dulli session's running and settled commands. Type `/ps` to open **Shared terminals**, or choose it from the right-panel menu (`S` in an empty panel). Running commands also appear above the composer.

Start a command there or type `/terminal <command>`. Add `-k` or `--keep-open` to keep an interactive shell open afterward. Commands run in the live Pi process's current directory and are shared with the agent. Send a message first if the thread has no live session; starting a terminal never starts a replacement provider.

Interactive terminals support **Take control** and **Release control**, including keyboard input, paste, and resizing. Only one client, including Pi's terminal UI, can control a terminal at a time. Hiding or closing the view releases its watch and control; a disconnected client's lease expires within a minute. You can stop running commands from their details. Output is a bounded live tail, rebuilt on reconnect, not saved in thread history. Mobile has no shared-terminal inspector.

## Subagents and workflows

With the optional `pi-subagents` extension installed, Pi's child agents and workflows appear in **Agents & workflows**, separately from T3's own subagents and chat timeline. Type `/subagents` or `/workflows` to open the inspector. Web and desktop also offer it in the right-panel menu; on mobile, tap a child row above the composer.

Select a workflow phase or child to read its prompt, model and effort, thinking, tool output, result, and usage. Transcripts are retained with the thread, including after a reload; each child retains up to 1,000 transcript items and 2 MiB of content. **Steer**, **Reply** (when the child is waiting), and **Stop agent** act on the running child without stopping its parent. Controls require the original live Dulli session and the subagent extension; opening history never restarts a child.

## Background text generation

Dulli can generate thread titles, branch names, commit messages, and pull-request text with an explicitly selected model. These helpers disable tools, extensions, skills, and prompt templates and do not apply a thread's profile or config-set override. Investigation-based review-guide generation is not supported.
