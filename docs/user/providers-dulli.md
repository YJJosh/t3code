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

This integration owns one Pi RPC process per active thread. Do not open that same session file in another writer while it is active.

## Background text generation

Dulli can generate thread titles, branch names, commit messages, and pull-request text with an explicitly selected model. These helpers disable tools, extensions, skills, and prompt templates and do not apply a thread's profile or config-set override. Investigation-based review-guide generation is not supported.
