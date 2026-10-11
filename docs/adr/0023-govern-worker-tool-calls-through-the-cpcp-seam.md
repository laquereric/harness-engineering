# Govern worker tool calls through one CpCp seam

Status: Accepted
Date: 2026-10-11

Every tool call a worker host makes while `HARNESS_IQ_GATE=1` is a CpCp PUSH to one gate seam before it touches the world: `{operationId, session, tool, args}` in, a Decision out.
The seam authenticates the credential to a real actor, checks policy and token scopes, and journals the Decision; the harness never re-implements that check.
A refusal is a value with a reason code, never an exception; `operationId` is required and idempotent, so a retry replays the first verdict.
One gate, N thin adapters: Claude Code attaches through a `PreToolUse` hook (`claude --settings`), OpenCode through a plugin in its config `plugins/` directory; the orchestrator only appends the attach flag and preflights the seam.
Fail closed: if the gate is enabled and the seam is unreachable, no Claude hook settings exist, or the host has no adapter, the orchestrator does not spawn that worker and reports why.
Observation Method `browser` under the gate is satisfied only by a governed engine: the IQ CpCp browser (`POST /_cpcp`) or the IQ app webview drive surface (`iq_drive`); Playwright MCP is the ungoverned path and is not admitted while the gate is on.
Do not invent a second ACL in the harness (`roles.json`, prompts, or installer) — the seam is the single policy.
Vocabulary and the full contract live in `docs/iq-standards.md`; CpCp seam and Decision terms are in `CONTEXT.md`.
