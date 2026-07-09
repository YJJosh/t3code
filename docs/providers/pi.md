# Pi

T3 Code can run threads through the [Pi coding agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) as a built-in provider.

## Setup

1. Install the Pi CLI so `pi` is on the server's `PATH`.
2. Configure and authenticate Pi normally.
3. Open **Settings → Providers**, enable **Pi**, and refresh provider status.

The provider settings are:

- **Binary path** — defaults to `pi`.
- **Profile** — defaults to `coder` and is passed to Pi with `--profile`.
- **Agent directory override** — blank by default. Leave it blank to use the normal `~/.pi/agent` directory; set it only when Pi should use another agent configuration directory.

T3 does not copy or replace Pi configuration. Each thread starts Pi in that thread's checkout, so Pi discovers both the user's global `~/.pi/agent` resources and the checkout's project-local `.pi/` resources in the normal way.

## Runtime behavior

T3 keeps one long-lived `pi --mode rpc` process per active thread. It starts Pi with `--approve`, uses LF-delimited JSON RPC framing, and persists Pi's authoritative session id so a thread can resume after the server restarts. Model and thinking-level choices come from Pi's own model registry and authentication state; credentials are not returned to the client.

Extension confirmation prompts are approved automatically for the full-access runtime. Prompts that require fabricated text input are cancelled instead.

## Subagent activity

When the Pi session has a compatible `pi-subagents` extension, T3 displays compact child-run rows below the composer. On desktop and responsive web, selecting a row opens a detail drawer with status, usage, activity, results, and steer/reply/stop controls. Native mobile shows the same live run state and transcript in a read-only detail sheet. The event stream uses durable snapshots and replay after reconnects.

Subagent integration is optional. T3 checks that the private `subagents-rpc` extension command is registered before sending a control, so a Pi setup without that extension does not receive an accidental slash-command prompt.

## Troubleshooting

- **Pi is unavailable** — verify the configured binary path by running `pi --version` as the same user that runs the T3 server.
- **No models appear** — authenticate the model providers in Pi, then refresh provider status in T3.
- **Project resources are missing** — confirm the thread checkout contains the expected `.pi/` directory and that the agent directory override is blank unless an override is intentional.
- **Subagent rows do not appear** — confirm the active Pi session loads a compatible `pi-subagents` extension. Normal Pi threads continue to work without it.
