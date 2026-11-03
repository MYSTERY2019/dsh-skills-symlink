import { isAbsolute, resolve } from 'node:path'

import {
  DEFAULT_CONFIG_FILE,
  findProjectRoot,
  realpathDeep,
  writeProjectSkillConfig,
} from './project-config.js'

/**
 * Settings route for the plugin's settings card.
 *
 * It is registered as an exact Fetch route of the host's own client
 * connection (`ctx.connection.fetch.register`), under the host's `/api`
 * prefix. So every request first passes the host's own Host/Origin fence and
 * its cookie authentication, and only the owner principal reaches the
 * handler. The plugin adds its own checks on top:
 *
 * - the project must be a workspace DSH knows (or one a session has used);
 * - POST must be `application/json`, at most 16 KiB, and same-origin when the
 *   browser sends an Origin;
 * - the new file is validated before it is written, and written atomically
 *   without following symbolic links.
 *
 * Errors carry a stable `code` so the client can show them in its own
 * language; `error` is an English detail line.
 */
export const CONFIG_ROUTE_PATH = '/api/dsh-skills-symlink/config'
export const MAX_BODY_BYTES = 16 * 1024

export class RouteError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** Build the Fetch route object. Exported for tests. */
export function createConfigRoute(options = {}) {
  const configFile = options.configFile ?? DEFAULT_CONFIG_FILE
  const allowExternalPaths = options.allowExternalPaths === true
  const invalidate = typeof options.invalidate === 'function' ? options.invalidate : () => {}
  const inspect = options.inspect
  const knownProjects = typeof options.knownProjects === 'function' ? options.knownProjects : async () => []

  if (typeof inspect !== 'function') throw new TypeError('createConfigRoute needs an inspect(projectRoot) function')

  async function locate(rawProjectRoot, rawBaseRoot) {
    if (typeof rawProjectRoot !== 'string' || rawProjectRoot.trim().length === 0) {
      throw new RouteError(400, 'missing-project', 'projectRoot is required')
    }
    const base = typeof rawBaseRoot === 'string' && rawBaseRoot.trim() ? rawBaseRoot.trim() : undefined
    const requested = rawProjectRoot.trim()
    if (!isAbsolute(requested) && base === undefined) {
      throw new RouteError(400, 'relative-project', 'projectRoot must be absolute when no baseRoot is given')
    }
    const start = isAbsolute(requested) ? resolve(requested) : resolve(base, requested)
    const projectRoot = await findProjectRoot(start)
    const projectReal = await realpathDeep(projectRoot)
    const known = await knownProjectSet(knownProjects)
    if (!known.has(pathKey(projectReal))) {
      throw new RouteError(403, 'not-a-workspace',
        'this folder is not a workspace DSH knows; open it as a workspace in DSH first')
    }
    return projectRoot
  }

  async function handleGet(request) {
    const url = new URL(request.url)
    const projectRoot = await locate(url.searchParams.get('projectRoot'), url.searchParams.get('baseRoot'))
    const view = await inspect(projectRoot)
    return json(200, { ok: true, ...view })
  }

  async function handlePost(request) {
    const origin = request.headers.get('origin')
    if (origin !== null && !isSameOrigin(origin, request.headers.get('host'))) {
      throw new RouteError(403, 'forbidden-origin', 'cross-origin requests are not allowed')
    }
    const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      throw new RouteError(415, 'unsupported-media-type', 'the request body must be application/json')
    }
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      throw new RouteError(413, 'payload-too-large', `the request body is larger than ${MAX_BODY_BYTES} bytes`)
    }
    const bytes = new Uint8Array(await request.arrayBuffer())
    if (bytes.byteLength > MAX_BODY_BYTES) {
      throw new RouteError(413, 'payload-too-large', `the request body is larger than ${MAX_BODY_BYTES} bytes`)
    }
    let body
    try {
      body = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw new RouteError(400, 'invalid-json', 'the request body is not valid JSON')
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new RouteError(400, 'invalid-json', 'the request body must be a JSON object')
    }
    if (!Array.isArray(body.skillPaths)) {
      throw new RouteError(400, 'invalid-config', 'skillPaths must be an array')
    }
    const projectRoot = await locate(body.projectRoot, body.baseRoot)
    try {
      await writeProjectSkillConfig(projectRoot, body.skillPaths, configFile, { allowExternalPaths })
    } catch (error) {
      if (error?.code === 'external-path') throw new RouteError(400, 'external-path', error.message)
      if (error?.code === 'unsafe-config-path') throw new RouteError(400, 'unsafe-config-path', error.message)
      if (error instanceof TypeError) throw new RouteError(400, 'invalid-config', error.message)
      throw error
    }
    invalidate()
    const view = await inspect(projectRoot)
    return json(200, { ok: true, ...view })
  }

  return {
    path: CONFIG_ROUTE_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      try {
        if (request.method === 'GET') return await handleGet(request)
        if (request.method === 'POST') return await handlePost(request)
        return json(405, { ok: false, code: 'method-not-allowed', error: 'method not allowed' })
      } catch (error) {
        if (error instanceof RouteError) {
          return json(error.status, { ok: false, code: error.code, error: error.message })
        }
        options.onError?.(error)
        return json(500, { ok: false, code: 'internal', error: 'internal error; see the plugin log' })
      }
    },
  }
}

/**
 * Register the settings route on the host connection's Fetch registry.
 * Returns the disposer the registry gives back.
 */
/**
 * The host hands Fetch routes a Request whose URL is an internal placeholder
 * (`http://dsh.internal/...`), not the address the browser used, so the
 * browser's Origin is compared with the Host header it was sent with. The host
 * has already checked that Host is one of its own listen addresses.
 */
export function isSameOrigin(origin, host) {
  if (typeof host !== 'string' || host === '') return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  let expected
  try {
    expected = new URL(`${parsed.protocol}//${host}`)
  } catch {
    return false
  }
  return parsed.host === expected.host
}

export function mountProjectSkillPathRoutes(fetchRegistry, options = {}) {
  if (!fetchRegistry || typeof fetchRegistry.register !== 'function') {
    throw new TypeError('mountProjectSkillPathRoutes needs the host connection fetch registry')
  }
  return fetchRegistry.register(createConfigRoute(options))
}

async function knownProjectSet(knownProjects) {
  const set = new Set()
  let list
  try {
    list = await knownProjects()
  } catch {
    list = []
  }
  for (const path of Array.isArray(list) ? list : []) {
    if (typeof path !== 'string' || path.length === 0) continue
    set.add(pathKey(await realpathDeep(path)))
    set.add(pathKey(await realpathDeep(await findProjectRoot(path))))
  }
  return set
}

function pathKey(path) {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}
