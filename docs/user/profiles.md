# Profiles

Profiles combine reusable prompt parts and skills with optional provider, model, and effort presets. Keep the folder in a Git repository and sync a checkout onto each environment. T3 reads that environment's checkout; your browser or phone never needs filesystem access to it. T3 does not run Git sync for you.

In **Settings → General → Profiles** on web/desktop, or **Settings → Providers** on mobile, set the environment's profiles folder (blank uses `<T3 home>/profiles`), then **Refresh profiles**. A missing `profiles.json` disables the feature. Invalid files are reported here. You can choose a default for new threads, use the folder's default, or choose **No profile**.

```text
profiles/
  profiles.json
  prompts/
    coding.md
  skills/
    review/
      SKILL.md
```

```json
{
  "default": "coding",
  "profiles": {
    "coding": {
      "description": "Coding with review guidance",
      "prompts": ["coding"],
      "skills": ["review"]
    },
    "lean": {
      "prompts": ["coding"],
      "skills": [],
      "provider": "claudeAgent-lean",
      "model": "claude-haiku-4-5",
      "effort": "low"
    }
  }
}
```

Names use letters, numbers, hyphens, or underscores. Prompt names omit `.md`. Each skill uses Agent Skills frontmatter:

```markdown
---
name: review
description: Review a code change for correctness and regressions.
---

Read the diff, check the changed behavior, and report actionable findings.
```

Choose a profile beside the composer on web, desktop, or mobile. Its provider/model/effort are starting choices, not locks; you can change them afterwards. Provider switches are saved with the next sent message. **No profile** removes the profile without resetting your model settings. Delegated tasks do not inherit a parent's profile by default.

Prompt parts are appended in the listed order. Selected skills contribute their name, description, and absolute `SKILL.md` path; the agent reads a skill when needed. Only select content you trust. Paths point to the environment running the agent, not your browser's machine.

Profiles are read again at each session start. Changing a profile or syncing its files does not rewrite an already-running session: stop and restart the thread to apply it. Claude, Codex, Muse, Pi, and generic ACP providers (including Replay) support profiles. Other providers gray out the profile picker and ignore the profile. Your selection is kept for when you switch back to a supported provider. Claude and Pi use their system-prompt append hooks; Codex uses developer context; Muse and ACP use their runtime-instruction channel.

## Lean and full Claude

Keep your usual Claude provider instance for the full experience. Add a second Claude instance in **Settings → Providers**, give it a separate home path, and set launch arguments to `--settings /absolute/path/claude-debloat.json`. The separate home becomes `CLAUDE_CONFIG_DIR`, isolating that instance's Claude configuration and login. Authenticate the instance separately if necessary.

A small `claude-debloat.json` can start with:

```json
{
  "autoMemoryEnabled": false,
  "disableBundledSkills": true,
  "disableWorkflows": true,
  "syncClaudeAiSkills": false,
  "syncClaudeAiPlugins": false,
  "attribution": { "commit": "", "pr": "" }
}
```

These are Claude settings and may vary with your installed Claude version. T3 passes the file through the SDK's settings option, retaining T3's required runtime settings. Do not disable tools that your workflow needs.

Set a profile's `provider` to the second instance's **id**, not its display name. Use the same id on each environment. Portable ids such as `claudeAgent-lean`, `codex-work`, `muse-work`, and `pi-work` can fall back to the driver's default instance if that custom instance is missing. The picker shows a notice. If an opaque id cannot identify a driver, T3 keeps your current instance and warns; check the model before sending.
