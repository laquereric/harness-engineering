# Optional integrations

Installer checklist rows that are not marketplace plugins.
Plugin rows (Playwright, Crawl4AI, hallmark, …) live in [plugins.md](plugins.md); the catalog SoT is `config/installable-catalog.json` (ADR-0013).

| Integration | Hosts | Behavior |
| --- | --- | --- |
| Status line | Claude, Codex | Claude: bundled `scripts/statusline.sh` copied to `~/.claude/statusline.sh` and wired via settings. Codex: native `[tui] status_line` in `~/.codex/config.toml`. OpenCode has no equivalent hook yet. |
| Shared config | Claude | Atomically merges sanitized `config/settings.json`, preserving unrelated settings and a backup. |
| IQ gate (`iq-gate`) | Claude, OpenCode | Attaches each host to the IQ **CpCp seam** so every worker tool call is a permit-checked, journaled Decision ([ADR-0023](adr/0023-govern-worker-tool-calls-through-the-cpcp-seam.md), [IQ standards](iq-standards.md)). Claude: writes the `PreToolUse`/`SessionStart` hook settings (`~/.local/share/harness/iq-gate/claude-settings.json`, or `$PROJECT/.harness/iq-gate/` under project scope) and the `/iq` command; OpenCode: copies `iq-harness-gate.ts` into the config `plugins/` dir. Adapters are read from your IQ checkout (`IQ_REPO`, default `~/NoIcloud/Iq`); the installer refuses without them and never starts the seam. Workers attach when the orchestrator runs with `HARNESS_IQ_GATE=1` (seam preflight, fail closed). |

Role routing uses project-local `.harness/roles.json` from `config/roles.example.json`.
See the [routing guide](../README.md#optional-role-routing).

MCP registration differs by host (`claude mcp add-json`, `codex mcp add`, OpenCode native shapes).
Dry-run performs none of these writes or downloads.
