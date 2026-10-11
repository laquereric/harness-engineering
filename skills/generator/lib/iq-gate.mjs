// @use_case Development/UseCase/UC_IqManagedHarnesses
// @facet Agent
// @module_cpcp_caller
/**
 * IQ gate bridge (ADR-0023): the harness side of the one CpCp gate seam.
 *
 * The gate logic lives in the IQ seam (`seam_server.py`, 127.0.0.1:8099 by default); this module only
 * (1) resolves how a worker host attaches to it and (2) preflights the seam before a worker is spawned.
 * It never decides a tool call itself — that is the seam's job, once, for every harness.
 *
 * Fail closed: when `HARNESS_IQ_GATE=1` and the seam is unreachable, the host has no IQ adapter, or the
 * Claude hook settings cannot be found, `iqGatePreflight` refuses the spawn with a reason code. A refusal
 * is a value the orchestrator records; it is never thrown.
 *
 * Env:
 *   HARNESS_IQ_GATE=1               govern worker hosts through the IQ seam (off by default)
 *   IQ_SEAM_URL                     the seam (default http://127.0.0.1:8099)
 *   HARNESS_IQ_CLAUDE_SETTINGS      explicit path to the Claude hook settings JSON (overrides discovery)
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import http from 'node:http'

/** Hosts with a thin IQ adapter (UC_IqManagedHarnesses/adapters). Others are refused under the gate. */
export const IQ_GATE_HOSTS = Object.freeze(['claude', 'opencode'])
export const DEFAULT_SEAM_URL = 'http://127.0.0.1:8099'

/** CpCp reason codes the bridge itself can emit (the seam has its own: unauthenticated, out_of_scope, …). */
export const IQ_GATE_REASONS = Object.freeze({
  NO_ADAPTER: 'iq_gate_no_adapter',
  NO_SETTINGS: 'iq_gate_no_settings',
  SEAM_UNREACHABLE: 'iq_gate_seam_unreachable',
})

export function iqGateEnabled(env = process.env) {
  return String(env.HARNESS_IQ_GATE || '') === '1'
}

export function iqSeamUrl(env = process.env) {
  return String(env.IQ_SEAM_URL || DEFAULT_SEAM_URL).replace(/\/+$/, '')
}

/**
 * Where the Claude `--settings` hook file lives, first match wins:
 * explicit env → project `.harness/iq-gate/` (installer project scope) → user install → what `iq-claude` writes.
 */
export function claudeSettingsCandidates({ env = process.env, cwd = process.cwd(), home = homedir() } = {}) {
  return [
    env.HARNESS_IQ_CLAUDE_SETTINGS,
    join(cwd, '.harness', 'iq-gate', 'claude-settings.json'),
    join(home, '.local', 'share', 'harness', 'iq-gate', 'claude-settings.json'),
    join(home, '.iq', 'claude-hook-settings.json'),
  ].filter(Boolean)
}

/**
 * An explicit HARNESS_IQ_CLAUDE_SETTINGS is authoritative: if it is set and missing, nothing else is tried
 * (no silent fallback to a different gate file). Discovery runs only when it is unset.
 */
export function resolveClaudeSettings({ env = process.env, cwd, home, exists = existsSync } = {}) {
  if (env.HARNESS_IQ_CLAUDE_SETTINGS) return exists(env.HARNESS_IQ_CLAUDE_SETTINGS) ? env.HARNESS_IQ_CLAUDE_SETTINGS : null
  return claudeSettingsCandidates({ env, cwd, home }).find((path) => exists(path)) || null
}

/**
 * Extra argv that attaches a host to the seam. Claude: `--settings <hooks json>`; OpenCode: none (its plugin
 * is discovered from the config `plugins/` dir). Never throws — a missing file is reported by the preflight.
 */
export function iqGateHostArgs(harness, { env = process.env, cwd, home, exists } = {}) {
  if (!iqGateEnabled(env)) return []
  if (harness !== 'claude') return []
  const settings = resolveClaudeSettings({ env, cwd, home, exists })
  return settings ? ['--settings', settings] : []
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(res.statusCode || 0)
    })
    req.on('timeout', () => { req.destroy(new Error('timeout')) })
    req.on('error', () => resolve(0))
  })
}

/** GET {seam}/healthz → true iff 200. Any error, non-200, or timeout → false (fail closed). */
export async function seamHealthy(url, { timeoutMs = 2000, get = httpGet } = {}) {
  try {
    return (await get(`${url}/healthz`, timeoutMs)) === 200
  } catch {
    return false
  }
}

/**
 * Decide whether a worker on `harness` may be spawned under the gate.
 * Returns { ok, gated, reason?, detail?, seam? }. Never throws.
 */
export async function iqGatePreflight({ harness, env = process.env, cwd, home, exists, get } = {}) {
  if (!iqGateEnabled(env)) return { ok: true, gated: false }
  const seam = iqSeamUrl(env)
  if (!IQ_GATE_HOSTS.includes(harness)) {
    return {
      ok: false, gated: true, seam, reason: IQ_GATE_REASONS.NO_ADAPTER,
      detail: `IQ gate: no CpCp adapter for host "${harness}" (governed hosts: ${IQ_GATE_HOSTS.join(', ')}); refusing to spawn an ungoverned worker`,
    }
  }
  if (harness === 'claude' && !resolveClaudeSettings({ env, cwd, home, exists })) {
    return {
      ok: false, gated: true, seam, reason: IQ_GATE_REASONS.NO_SETTINGS,
      detail: env.HARNESS_IQ_CLAUDE_SETTINGS
        ? `IQ gate: HARNESS_IQ_CLAUDE_SETTINGS=${env.HARNESS_IQ_CLAUDE_SETTINGS} does not exist (explicit path, no fallback)`
        : `IQ gate: no Claude hook settings found (looked at ${claudeSettingsCandidates({ env, cwd, home }).join(', ')}); install the iq-gate module or run iq-claude once`,
    }
  }
  if (!(await seamHealthy(seam, { get }))) {
    return {
      ok: false, gated: true, seam, reason: IQ_GATE_REASONS.SEAM_UNREACHABLE,
      detail: `IQ gate: seam unreachable at ${seam}/healthz; refusing to spawn ${harness} (fail closed). Start it with iq-seam-install (prod) or iq-seam-dev.sh (offline)`,
    }
  }
  return { ok: true, gated: true, seam }
}
