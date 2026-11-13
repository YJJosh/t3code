# Profiles

A profile bundles prompt parts, skills and, for each provider, a named set of **provider settings**
that shape how that provider's harness runs. Pick a profile beside the composer on web, desktop or
mobile. New threads use the default profile. Delegated tasks do not inherit a parent's profile.

Manage everything in **Settings → Profiles**. Mobile shows the same page with fewer controls; edit
provider settings and prompt text on web or desktop.

## The profiles folder

Each environment keeps its profiles in a folder, `<T3 home>/profiles` unless you set another path in
**Settings → Profiles**. **Open in editor** opens it on the selected environment's machine when
that environment has a supported editor.

```text
profiles/
  profiles.json            profiles and the default
  provider-settings.json   named provider settings per provider
  prompts/<name>.md        prompt parts
  .agents/skills/<name>/   skills, one SKILL.md each
  skills-lock.json         where installed skills came from
```

A broken profile stays in the list with a warning; the others keep working.

## Sharing between environments

You do not run Git for this. When you save in **Settings → Profiles**, T3 copies the folder to every
environment the app is connected to. An environment that was offline gets the newer copy when the app
connects to it again, and **Sync now** does the same on demand. The newest copy wins. If an
environment's folder was also changed by hand since its last sync, T3 keeps that version in a backup
folder under `<T3 home>/profiles-backups` and shows a notice.

An environment no app connects to keeps its last copy until the app connects to it. `node_modules` is
never copied: a skill that needs dependencies shows **Install** on each machine.

## Skills

**Add skill** takes a repository such as `YJJosh/Portler` and installs it with the
[`skills`](https://github.com/vercel-labs/skills) command (`npx skills`), so the environment needs Node
and `npx`. **Update all** updates every installed skill from its source, then syncs. Skills you write
yourself go in `.agents/skills/<name>/SKILL.md`; they are not updated.

Skills are not added to profiles automatically. Tick them in each profile. A selected skill gives the
agent its name, description and the path of its `SKILL.md`, which the agent reads when needed. Skills
can contain scripts and run with the agent's permissions, and syncing copies them to every
environment, so only add skills you trust.

## Provider settings

Provider settings are named per provider, such as `lean` or `full` for Claude. A profile picks one for
each provider, so two threads on the same provider can run different settings at the same time.
**Detect** reads what this machine's provider offers (tools, skills, plugins, features). An option
another machine lacks is marked and skipped there.

| Provider | What provider settings can change                                                                                    |
| -------- | -------------------------------------------------------------------------------------------------------------------- |
| Claude   | Blocked tools, bundled skills, skills and plugins, memory, attribution, Claude in Chrome, other Claude Code settings |
| Codex    | Features and config that Codex applies per thread                                                                    |
| Pi       | Pi's own skills and prompt templates on or off                                                                       |

Login, binary path and home directory stay with the provider in **Settings → Providers**. Settings T3
itself needs, such as its own tools and MCP servers, cannot be turned off. Provider settings are copied
to every environment, so do not put secrets in them.

<!-- REVIEW: Profile prompts/skills are supported more widely than named provider settings. -->

Changes apply when a session starts or resumes, not to a turn that is running. Claude, Codex, Pi,
Muse and ACP providers support profile prompts and skills. Named provider settings apply only to
Claude, Codex and Pi. Cursor, OpenCode and other unsupported providers gray out the picker and start
sessions normally.
