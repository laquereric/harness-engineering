#!/usr/bin/env node
// @use_case Development/UseCase/UC_GherkinIq
// @facet Observation
// @module_cpcp_public
/**
 * cpcp-browser — drive the IQ CpCp browser from a harness worker (ADR-0023, docs/iq-standards.md §3).
 *
 * The IQ browser util (`utils/browser/browser_cpcp.py`, started by `iq-browser --cpcp`) holds one
 * WebDriver-BiDi Firefox — headless, normally inside a Lima microVM — behind a CpCp seam:
 *
 *   POST {IQ_BROWSER_URL}/_cpcp  {operationId, op, params}
 *     -> {operation_id, status: "ok" | "refused", result | reason}
 *
 * This client is the thin adapter: it mints an operationId (or reuses `--op-id` so a retry REPLAYS the first
 * response), posts one envelope, prints the response JSON, and maps status to the exit code. A refusal is a
 * VALUE on stdout (exit 1), never a stack trace; an unreachable endpoint is reported the same way (exit 2,
 * reason `endpoint_unreachable`) — fail closed, no fallback to another browser.
 *
 *   node scripts/cpcp-browser.mjs health
 *   node scripts/cpcp-browser.mjs navigate --url http://127.0.0.1:5170/ [--wait complete]
 *   node scripts/cpcp-browser.mjs eval --expr 'document.body.innerText'
 *   node scripts/cpcp-browser.mjs title | console | screenshot
 *   options: --endpoint URL (default $IQ_BROWSER_URL or http://127.0.0.1:8930), --op-id ID
 *
 * Zero dependencies: node:http only. Usable from any worker host, so a browser Acceptance Check stays
 * black-box and governed regardless of which coding tool runs the QA agent.
 */
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8930'
export const OPS = Object.freeze({
  navigate: 'browser.navigate',
  eval: 'browser.eval',
  title: 'browser.title',
  console: 'browser.console',
  screenshot: 'browser.screenshot',
})

export function newOperationId() {
  return `iq:op:harness-${randomUUID()}`
}

/** Parse argv: first bare word is the op; `--k v` pairs are params/options. */
export function parseArgs(argv) {
  const out = { op: '', opts: {}, params: {} }
  const optionKeys = new Set(['endpoint', 'op-id'])
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      if (optionKeys.has(key)) out.opts[key] = value
      else out.params[key] = value
    } else if (!out.op) {
      out.op = arg
    }
  }
  return out
}

/** Build the CpCp PUSH envelope for a browser op. Unknown op → null (the caller refuses it as a value). */
export function buildEnvelope(op, params = {}, operationId = newOperationId()) {
  const wire = OPS[op]
  if (!wire) return null
  return { operationId, op: wire, params }
}

export function refusal(operationId, reason, extra = {}) {
  return { operation_id: operationId || '', status: 'refused', reason, ...extra }
}

/** POST one envelope. Resolves to the parsed response; rejects only on transport failure. */
export function pushBrowser(endpoint, envelope, { timeoutMs = 30_000 } = {}) {
  const url = new URL('/_cpcp', endpoint.replace(/\/+$/, '') + '/')
  const body = JSON.stringify(envelope)
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')) } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end(body)
  })
}

export function healthz(endpoint, { timeoutMs = 3000 } = {}) {
  const url = new URL('/healthz', endpoint.replace(/\/+$/, '') + '/')
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try { resolve({ code: res.statusCode, body: JSON.parse(data || '{}') }) } catch (err) { reject(err) }
      })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
  })
}

/** Exit code from a CpCp response: 0 ok, 1 refused (a value), 2 unreachable (fail closed). */
export function exitCodeFor(response) {
  if (!response || response.reason === 'endpoint_unreachable') return 2
  return response.status === 'ok' ? 0 : 1
}

export async function run(argv, { env = process.env, push = pushBrowser, health = healthz } = {}) {
  const { op, opts, params } = parseArgs(argv)
  const endpoint = opts.endpoint || env.IQ_BROWSER_URL || DEFAULT_ENDPOINT
  if (!op || op === 'help' || op === '--help') {
    return { response: refusal('', 'usage', { usage: 'cpcp-browser <health|navigate|eval|title|console|screenshot> [--url U] [--expr JS] [--wait W] [--op-id ID] [--endpoint URL]' }) }
  }
  if (op === 'health') {
    try {
      const { code, body } = await health(endpoint)
      return { response: code === 200 ? { status: 'ok', endpoint, ...body } : refusal('', 'endpoint_unhealthy', { endpoint, code }) }
    } catch (err) {
      return { response: refusal('', 'endpoint_unreachable', { endpoint, error: String(err.message || err) }) }
    }
  }
  const operationId = opts['op-id'] || newOperationId()
  const envelope = buildEnvelope(op, params, operationId)
  if (!envelope) return { response: refusal(operationId, `not_admitted:${op}`, { known_ops: Object.keys(OPS) }) }
  try {
    const response = await push(endpoint, envelope)
    return { envelope, response }
  } catch (err) {
    return { envelope, response: refusal(operationId, 'endpoint_unreachable', { endpoint, error: String(err.message || err) }) }
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  run(process.argv.slice(2)).then(({ response }) => {
    process.stdout.write(`${JSON.stringify(response)}\n`)
    process.exit(exitCodeFor(response))
  })
}
