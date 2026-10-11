# IQ standards for the harness

<!--
@use_case Development/UseCase/UC_IqManagedHarnesses
@facet Agent
@status Active
-->

> *A coding harness is an agent at a terminal. IQ submerges beneath it as the governance layer: every tool call a worker makes is a permit-checked, journaled Decision before it touches the world. The harness keeps its workflow; IQ owns what each worker is allowed to do.*

This document is the harness-side statement of the IQ standards: the **CpCp gate seam**, the **browser util reached through CpCp**, and the **IQ app's Tauri webview as a governed drive surface**. It is written in harness vocabulary (`CONTEXT.md`); the source of truth for each contract is the IQ repository (paths in [References](#references)).

The decision that adopts these standards is [ADR-0023](adr/0023-govern-worker-tool-calls-through-the-cpcp-seam.md). Turn them on per run with `HARNESS_IQ_GATE=1` after installing the `iq-gate` module ([extras](extras.md)).

## 1. The CpCp seam: one gate, N thin adapters

A **CpCp seam** is one HTTP endpoint on the worker's machine (default `http://127.0.0.1:8099`, `IQ_SEAM_URL`) that every worker host hits before performing a tool call. A tool call is a CpCp **PUSH**:

```
POST {IQ_SEAM_URL}/push
{ "operationId": "iq:op:…", "session": "<credential>", "actor": "", "tool": "Bash", "args": {…}, "realm": "root" }

→ Decision
{ "operation_id": "iq:op:…", "capability": "mcp:call:Bash", "actor": "iq:identity:…",
  "realm": "root", "tool": "Bash", "admitted": false, "reason": "no_permit" }
```

Rules the seam enforces, in this fixed order (authenticate → authorize → shape → dispatch → journal):

| Rule | Meaning for the harness |
| --- | --- |
| **Authenticated actor** | The seam resolves the presented credential at `memory /whoami` to a subject. A self-asserted `actor` is never trusted. No credential → `unauthenticated`. |
| **Scopes narrow policy** | A token's scopes must admit the capability (`mcp:call:<tool>`, globs allowed) → else `out_of_scope`. |
| **`operationId` is required** | A PUSH names its intent before performing it. Missing → `operation_id_required`. |
| **Idempotent replay** | A repeated `operationId` returns the first Decision without re-deciding, so a worker may retry safely. |
| **Permit is the gate** | Policy (IAM: explicit deny > allow > default-deny) decides `admitted`. Denied → `no_permit`. |
| **Refusal is a value** | A refusal is JSON with a reason code, never an exception or an HTTP error. The worker reads the reason. |
| **Journaled** | Every Decision is a journal row (`auth_events`), stamped with the artifact IRI the call touched when its args name a path. |

The **capability** of a tool call is `mcp:call:<tool>` (`mcp:call:Read`, `mcp:call:Edit`, `mcp:call:drive:navigate`, `mcp:call:launcher:flush`). Grants live on the seam host in `~/.iq/harness-iam.json` (policies + attachments to groups or principals); tokens are minted at `https://memory.intentionalquality.com/settings/tokens` and stored in `~/.iq/harness-token`.

**One gate, N thin adapters.** The gate logic exists once, in the seam. Each host attaches with an adapter that does exactly two things: translate its native tool event into a PUSH, and apply the verdict in its own terms. All adapters **fail closed** when the seam is unreachable.

| Host | Adapter | Admit / deny |
| --- | --- | --- |
| Claude Code | `PreToolUse` hook (`iq-gate-hook.py`) wired per session via `claude --settings <hooks json>`; `SessionStart` banner prints the actor and scopes | exit 0 / `permissionDecision: deny` + exit 2 |
| Claude Code (mods API ≥ 2.1.290) | mod `on('tool.call', ($, e, next))` | `next(e)` / `{ deny: reason }` |
| OpenCode | plugin `iq-harness-gate.ts` in the config `plugins/` dir (`tool.execute.before`, `permission.ask`) | return / throw with the reason |
| MCP servers, other hosts | the gating MCP proxy (`harness_mcp.GatingProxy`) | dispatch / MCP `isError` value |
| Codex, Pi, Cursor Agent | no adapter yet | **not admitted** under the gate |

### How the harness attaches (what this repo adds)

- `install.sh` / `install.ps1` module **`iq-gate`** writes the Claude hook settings (`~/.local/share/harness/iq-gate/claude-settings.json`, or `$PROJECT/.harness/iq-gate/claude-settings.json` under project scope), installs the `/iq` command, and copies the OpenCode plugin into `plugins/`. It reads the adapters from your IQ checkout (`IQ_REPO`, default `~/NoIcloud/Iq`) and refuses to install without them. It never starts the seam.
- `skills/generator/lib/iq-gate.mjs` is the orchestrator bridge. With `HARNESS_IQ_GATE=1`, `adapters/hosts.mjs` appends `--settings <hooks json>` to every `claude -p` spawn, and `runHostAgentSession` **preflights** before any spawn: seam `GET /healthz` must answer 200, the host must have an adapter, and Claude must have hook settings. A failed preflight returns `{ ok:false, reason: iq_gate_* }` to the route loop (recorded as a fallback reason / Evidence Artifact) and nothing is spawned.
- The seam itself runs outside the harness: `iq-seam-install` (launchd, paired sessions, live IAM) or `iq-seam-dev.sh` (offline, narrow allowlist). `iq` / `/iq` shows identity, scopes, and gate status.

What this does **not** do: it does not add a second ACL. `roles.json`, prompts, and the installer never decide what a worker may call — the seam does.

## 2. Reason codes the harness will see

| Code | Emitted by | Means |
| --- | --- | --- |
| `unauthenticated` | seam | no / invalid credential (`IQ_HARNESS_SESSION` or `~/.iq/harness-token`) → pair with `iq-login` or mint a token |
| `out_of_scope` | seam | the token's scopes do not cover `mcp:call:<tool>` → mint a wider token |
| `operation_id_required` | seam, browser | a PUSH without `operationId` (adapter bug) |
| `no_permit` | seam | policy denies the capability for this actor → widen `~/.iq/harness-iam.json` |
| `not_admitted:<op>` | browser | unknown or un-permitted browser op |
| `effect_error:<Class>` | browser | the browser effect failed; still a value |
| `seam_unreachable` | IQ app `iq_drive` | the app could not reach the seam; nothing was driven |
| `iq_gate_seam_unreachable` | harness bridge | preflight: seam down; worker not spawned |
| `iq_gate_no_adapter` | harness bridge | preflight: host has no IQ adapter; worker not spawned |
| `iq_gate_no_settings` | harness bridge | preflight: Claude hook settings missing; run the `iq-gate` installer or `iq-claude` once |
| `endpoint_unreachable` | `scripts/cpcp-browser.mjs` | the CpCp browser endpoint is down; no fallback browser |

A refused Decision is **evidence**: record its `operation_id` and `reason` in the Workflow Journal / Defect Report like any other Evidence Artifact.

## 3. Browser observation through CpCp

Observation Method `browser` (ADR-0018) means "exercise behavior through a real browser." Under the IQ gate the real browser must itself be governed, so the admitted engines are:

### 3a. The CpCp browser (headless, CI, microVM)

IQ's browser util (`utils/browser`) is a stdlib WebDriver-BiDi driver (Firefox, or Chrome via chromedriver) exposed as a CpCp seam. `iq-browser --cpcp` starts it — inside a Lima microVM when available, host Firefox otherwise — on `http://127.0.0.1:8930`:

```
POST /_cpcp   { "operationId": "iq:op:…", "op": "browser.navigate", "params": { "url": "http://127.0.0.1:5170/" } }
→ 200        { "operation_id": "iq:op:…", "status": "ok", "result": { "url": "…", "title": "…" } }
→ 409        { "operation_id": "iq:op:…", "status": "refused", "reason": "not_admitted:browser.rm_rf" }
GET  /healthz → { "ok": true, "ops": [...], "ctx": "…" }
```

Ops (v1): `browser.navigate {url[, wait]}`, `browser.eval {expr}`, `browser.title`, `browser.console`, `browser.screenshot`. Same contract as the seam: `operationId` required and idempotent, refusals are values, every push journaled.

The harness ships a zero-dependency client any worker host can run:

```sh
node scripts/cpcp-browser.mjs health
node scripts/cpcp-browser.mjs navigate --url "http://127.0.0.1:$PORT/"
node scripts/cpcp-browser.mjs eval --expr 'document.body.innerText'
node scripts/cpcp-browser.mjs console
node scripts/cpcp-browser.mjs navigate --url … --op-id iq:op:ac-001-step-1    # a retry replays the first response
```

Exit codes: `0` ok, `1` refused (the refusal JSON is on stdout), `2` endpoint unreachable (fail closed; do not fall back to another browser). `IQ_BROWSER_URL` / `--endpoint` select the endpoint. The black-box rule still holds: `browser.eval` reads what a user could observe (`innerText`, visible state), not internals.

`iq-browser` brings the IQ dashboard (`:8030`) up with uvicorn reload **off** (`IQ_DASHBOARD_RELOAD=0`): a workspace under observation must not restart itself when a watched `.py` changes mid-check, or a `navigate` lands on a dead port and the Acceptance Check fails for the wrong reason.

### 3b. The IQ app webview (desktop, Tauri)

The IQ app (`UC_IqApp`, Tauri v2) presents the IQ workspace — dashboard `:8030` and herdr-web `:7317` — in its own OS webview, and that webview is a **governed drive surface**. Every drive verb is a CpCp PUSH to the seam first, with capability `mcp:call:drive:<tool>`:

```js
// from a page loaded in the app's webview (dashboard / herdr origins have IPC reachability)
const r = await window.__TAURI__.core.invoke('iq_drive', { tool: 'navigate', args: { url: 'http://127.0.0.1:8030/' } })
// { ok: true,  decision: {…admitted:true…},  result: { navigated: '…' } }
// { ok: false, refused: true, decision: {…admitted:false, reason:'no_permit'…} }   // nothing was driven
```

| Verb | Args | Effect |
| --- | --- | --- |
| `navigate` | `{url}` | navigate the main webview |
| `tab` | `{name: "dashboard" \| "herdr"}` | switch between the two services |
| `reload` | — | reload |
| `eval` | `{js}` | evaluate in the page |

Invariants the app keeps, which the harness relies on:

- **Capability ≠ authority.** The Tauri capability file only grants the local IQ origins IPC *reachability* to `iq_drive`; whether a call is performed is decided by the seam. There is no second ACL in `tauri.conf.json`.
- **Fail closed.** Seam unreachable → `seam_unreachable`, nothing driven. The app defers to a running seam on `:8099` (prod, paired sessions required) or starts a narrow offline dev seam allowing only `drive:*` and `launcher:*`.
- **Effectful launcher actions are gated too** (`launcher:mount|umount|flush`); **pairing is ungated** (identity bootstrap cannot be gated on identity); **status is read-only and ungated** and never exposes the credential.
- Not yet an external MCP/WS endpoint: an agent reaches `iq_drive` from inside the webview today. The headless CpCp browser (3a) is the CI path.
- **The OS open-file path is not a drive verb.** macOS opens the IQ file-type family in the app (`RunEvent::Opened` → dashboard `GET /open?path=…`): `.jsonld`, `.iq-decision`, `.iq-permit`, `.iq-prod-agent`, `.iq-dev-agent`, `.iq-ctx`, `.iq-warm-agent`, `.iq-intention`, `.iq-use-case` (single hyphenated extensions, declared in `tauri.conf.json` `bundle.fileAssociations`). That navigation is initiated by the user through the OS, renders a local file read-only, and is not pushed to the seam — like pairing and status, it carries no effect worth a Decision. An agent that wants the same page goes through `iq_drive navigate` (gated) or the CpCp browser (3a). The app relies on macOS native single-instancing; it does not use `tauri-plugin-single-instance` (it swallowed the cold-launch open-file event).

**What a worker observes there.** The dashboard file page (`/open?path=`) has tabs **Content / Data / Code / Relationship / Causation / History**. Three of them are the browser-observable record of governance and are legitimate Acceptance-Check evidence:

| Tab | Shows | Use in a check |
| --- | --- | --- |
| **Causation** (decisions only) | the context the Decision was made under — Intention → Use Case, the prior events it is `based_on`, its evidence, fan-in SVG; "No intention mapped" when unmapped | a governed action is attributable to an intention and a use case |
| **History** | the file's GitBlob change log (added / changed, author, timestamp, message) — one causation model for data (`.iq-*`, `.jsonld`) and code (`.py`, `.iq-*-agent`) | a write the harness made landed as a governed commit |
| **Relationship** | the IRI→file graph: a decision's agent (above, "decided by"), the permit that gated it, a warm agent's `.iq-ctx` chunks; every `iq:` IRI is an open-in-IQ link | the permit/decision/agent trio is wired, not asserted |

Read these pages black-box (`browser.eval` → `innerText`, visible labels), the same as any other page.

### 3c. Playwright MCP (ungoverned)

The `playwright` module remains available when the gate is **off**. With `HARNESS_IQ_GATE=1` the QA and Integrated Verification prompts tell the worker not to use Playwright MCP or launch an ungoverned browser, because such a browser's actions are not Decisions and leave no journal row.

## 4. Identity, scopes, grants

| Piece | Where | Notes |
| --- | --- | --- |
| Pairing | `iq-login` (device flow) | binds this box to your identity; the only ungated step |
| Credential | `~/.iq/harness-token` or `IQ_HARNESS_SESSION` | an IQ access token (Bearer at `/whoami` → subject + scopes) |
| Grants | `~/.iq/harness-iam.json` | IAM policies + attachments; evaluated on the seam host |
| Seam service | `iq-seam-install` | launchd keep-alive; `iq-seam-dev.sh` for offline work |
| Panel | `iq` in a shell, `/iq` in Claude | identity, scopes, gate status, next option |

A governed session announces itself at start: `IQ gate active — <subject> · scopes: …`. A session with no resolvable credential is still governed — every tool is refused (`unauthenticated`), which is the intended fail-closed state, not a bug.

## 5. Mapping to harness vocabulary

| IQ | Harness |
| --- | --- |
| CpCp seam | the single governance gate every worker host hits (`IQ_SEAM_URL`) |
| Decision (admit / refusal-as-value) | the per-call verdict; a refusal is an Evidence Artifact, not a crash |
| `operationId` | the idempotency key of one tool call / browser op (safe retries) |
| Journal row (`auth_events`) | provenance for a tool call; reference its `operation_id` from the Workflow Journal |
| Harness adapter | the thin bridge per host (hook / plugin / proxy) — never a fork of the host |
| CpCp browser `/_cpcp` | the governed engine for Observation Method `browser` in CI |
| `iq_drive` (Tauri webview) | the governed engine for Observation Method `browser` on the desktop |
| Permit / IAM | policy; lives on the seam host, never in `roles.json` or prompts |
| `iq-gate` preflight | an Observation-Hard-Gate-style spawn gate: seam up + adapter present, or do not spawn |

## 6. File annotation standard (when contributing to IQ)

Every file in the IQ repository is traceable to a Use Case. Files this repo adds to bridge IQ carry the same header so they can be moved or mirrored into IQ without a reconcile step:

```
// @use_case Development/UseCase/UC_IqManagedHarnesses
// @facet Agent
// @status Active            (Proposed | Active | Deprecated)
```

Orthogonal CPCP annotations classify composition: `@module_cpcp_public` (a leaf with a stable public contract; its public methods are `@method_cpcp_public`) and `@module_cpcp_caller` (an orchestrator that calls public modules; its orchestration methods are `@method_cpcp_caller`). A public module never calls another module's internals and never calls a caller. In this repo `scripts/cpcp-browser.mjs` is a public leaf and `skills/generator/lib/iq-gate.mjs` is a caller. Determinism annotations (`@method_deterministic`, …) and state annotations (`@module_stateless`, …) are independent axes.

## 7. Invariants

1. **One gate.** Every effectful action under the gate is a CpCp Decision through the seam. The harness adds surface, never a bypass.
2. **No rewrite.** Governance attaches at documented seams (hooks, plugins, proxies). No host is forked or patched.
3. **Refusal is a value.** Reason codes are stable; workers and the orchestrator branch on them.
4. **Fail closed, no fallback.** Seam down, no credential, no adapter, no settings → do not act. KISS: no silent degrade to an ungoverned path.
5. **Capability is reachability, policy is the seam.** Tauri capabilities, MCP configs, and installer scopes decide who can *reach* a surface; only the seam decides what is *admitted*.
6. **Read-only status is ungated; identity bootstrap is ungated.** Everything else is gated, including read tools.

## References

Paths are in the IQ repository (`IQ_REPO`, default `~/NoIcloud/Iq`):

- `Development/UseCase/UC_IqManagedHarnesses/DESIGN.md` — the use case; `harness_seam.py` (the seam), `seam_server.py` (the endpoint), `adapters/README.md`, `adapters/claude-code-hook/`, `adapters/claude-code/`, `adapters/opencode/`, `iq_config.py` (`/iq`), `iq-seam-dev.sh`, `service/` (launchd).
- `Development/UseCase/UC_SubstrateService/iq-shellrc.zsh` — `iq-claude`, `iq-login`, `iq-seam-install`, `iq`; `brew install iq-substrate`.
- `utils/browser/` — `browser_cpcp.py` (`/_cpcp`), `iq-browser.sh`, `iq-browser-cpcp.sh`, `closed_loop.py` (closed-loop page observation: a verdict, never a raise).
- `Development/UseCase/UC_IqApp/DESIGN.md` and `app/src-tauri/src/main.rs`, `capabilities/default.json` — the Tauri app, `iq_drive`, `iq_launch`, `iq_status`.
- `Development/UseCase/UC_IqApp/app/src-tauri/tauri.conf.json` (`bundle.fileAssociations`) and `UC_IqDashboard/tabs/blob/blob.py` (`GET /open`, the file page tabs) — the `.iq-*` family and what the webview renders.
- `GherkinIq/Annotation/CPCP_Annotation.md`, `IQ_ANNOTATION_GOVERNANCE.md` — annotation standard.
- `docs/deployment/microvm-control-plane-cpcp-plan.md` — the CPCP external contract (`/_cpcp`, `operationId` semantics, refusal taxonomy, journal).
