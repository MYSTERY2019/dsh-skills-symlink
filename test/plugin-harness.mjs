// Shared test harness: boots the plugin with the real @deepseek-ai/dsh-skill
// registry, a fake host connection that captures the settings Fetch route,
// and a fake workspace registry. Not a test file by itself (no tests here).
import { readFile } from 'node:fs/promises'

import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'

import ProjectSkillPaths from '../lib/index.js'

export const ORIGIN = 'http://127.0.0.1:43120'
export const HOST_INTERNAL_URL = 'http://dsh.internal'

export async function bootPlugin(config = {}, { workspaces = [], profileDir, connection = true } = {}) {
  const ctx = new Context()
  if (profileDir !== undefined) ctx.provide('profileContext', { name: 'fixture', dir: profileDir })
  const info = []
  const warnings = []
  ctx.logger.info = (...args) => info.push(args.join(' '))
  ctx.logger.warn = (...args) => warnings.push(args.join(' '))
  const routes = []
  if (connection) {
    ctx.provide('connection', {
      fetch: {
        register(route) {
          routes.push(route)
          return () => {}
        },
      },
    })
  }
  const workspaceList = [...workspaces]
  ctx.provide('workspaceRegistry', { list: async () => workspaceList.map((path) => ({ path })) })
  const registryFiber = ctx.plugin(SkillRegistry)
  await registryFiber
  const fiber = ctx.plugin(ProjectSkillPaths, config)
  await fiber
  return {
    ctx,
    info,
    warnings,
    routes,
    workspaces: workspaceList,
    get route() {
      return routes[0]
    },
    list: (cwd) => ctx.skills.list({ cwd }),
    async get(query) {
      return requestRoute(routes[0], 'GET', query)
    },
    async post(body, init = {}) {
      return requestRoute(routes[0], 'POST', undefined, body, init)
    },
    async close() {
      await fiber.dispose()
      await registryFiber.dispose()
    },
  }
}

export async function requestRoute(route, method, query, body, init = {}) {
  // Mirror the DSH 0.2.x host: the Request URL is an internal placeholder and
  // the browser's address only survives in the Host header.
  const url = new URL(route.path, HOST_INTERNAL_URL)
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value)
  const headers = new Headers(init.headers ?? {})
  if (!headers.has('host')) headers.set('host', new URL(ORIGIN).host)
  let payload
  if (method === 'POST') {
    if (!headers.has('content-type') && init.contentType !== null) headers.set('content-type', init.contentType ?? 'application/json')
    if (!headers.has('origin') && init.origin !== null) headers.set('origin', init.origin ?? ORIGIN)
    payload = typeof body === 'string' ? body : JSON.stringify(body)
  }
  const response = await route.fetch(new Request(url, { method, headers, body: payload }))
  return { status: response.status, body: await response.json() }
}

/** Read the diagnostics file once the async writer has caught up. */
export async function readLogEventually(file, pattern, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    try {
      text = await readFile(file, 'utf8')
      if (pattern === undefined || pattern.test(text)) return text
    } catch {
      // not written yet
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return text
}
