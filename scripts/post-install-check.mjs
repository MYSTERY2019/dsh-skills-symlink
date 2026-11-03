#!/usr/bin/env node
/**
 * Post-install check for dsh-skills-symlink.
 *
 * Answers two questions a test suite cannot:
 *   1. Is this build actually installed in a DSH profile, and did the host load it?
 *   2. What does a given project resolve right now?
 *
 *   node scripts/post-install-check.mjs
 *   node scripts/post-install-check.mjs --project ../my-app
 *   node scripts/post-install-check.mjs --profile desktop --json
 *
 * Exit code 0 means the checks that can fail locally all passed. A missing
 * profile, a version mismatch between the profile and this copy, or a project
 * that resolves nothing returns 1.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_CONFIG_FILE,
  expandSkillRoots,
  findProjectRoot,
  parseProjectSkillConfig,
  resolveConfigPath,
  resolveSkillRoots,
} from '../lib/project-config.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE = JSON.parse(await readFile(join(HERE, '..', 'package.json'), 'utf8'))

function parseArgs(argv) {
  const options = { project: process.cwd(), profile: 'desktop', json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') options.json = true
    else if (token === '--project') options.project = argv[index += 1]
    else if (token === '--profile') options.profile = argv[index += 1]
    else if (token === '--help' || token === '-h') options.help = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
if (options.help) {
  process.stdout.write('usage: post-install-check [--project <dir>] [--profile <name>] [--json]\n')
  process.exit(0)
}

const report = { package: { version: PACKAGE.version, dsh: PACKAGE.engines?.dsh ?? null }, profile: null, install: null, log: null, project: null }
const problems = []
const hints = []

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

// ── profile wiring ─────────────────────────────────────────────────────────
const profileDir = join(homedir(), '.dsh', 'profiles', options.profile)
if (!existsSync(profileDir)) {
  problems.push(`no profile at ${profileDir}`)
} else {
  const manifest = JSON.parse((await readText(join(profileDir, 'package.json'))) ?? '{}')
  const spec = manifest.dependencies?.[PACKAGE.name] ?? null
  const patch = (await readText(join(profileDir, 'cordis.patch.yml'))) ?? ''
  const row = patch.match(new RegExp(`-\\s*id:\\s*${PACKAGE.name}\\s*\\n([\\s\\S]*?)(?=\\n\\s*-\\s*id:|$)`))
  const settings = {
    row: row !== null,
    maxDepth: row ? Number((row[1].match(/maxDepth:\s*(\d+)/) ?? [])[1] ?? 2) : 2,
    allowExternalPaths: row ? /allowExternalPaths:\s*true/.test(row[1]) : false,
  }
  report.profile = { dir: profileDir, dependency: spec, ...settings }
  if (spec === null) problems.push(`profile package.json does not depend on ${PACKAGE.name}`)
  if (!settings.row) problems.push(`profile cordis.patch.yml has no "- id: ${PACKAGE.name}" row, so the plugin is off`)

  // ── installed copy ───────────────────────────────────────────────────────
  const installedDir = join(profileDir, 'node_modules', PACKAGE.name)
  const installedManifest = await readText(join(installedDir, 'package.json'))
  if (installedManifest === undefined) {
    problems.push(`nothing installed at ${installedDir}`)
  } else {
    const installed = JSON.parse(installedManifest)
    report.install = { dir: installedDir, version: installed.version, sameAsThisCopy: installed.version === PACKAGE.version }
    if (installed.version !== PACKAGE.version) {
      problems.push(`profile has ${installed.version}, this copy is ${PACKAGE.version}`)
    }
  }

  // ── did the host load it ────────────────────────────────────────────────
  const logPath = join(profileDir, 'logs', 'dsh-skills-symlink.log')
  const log = await readText(logPath)
  if (log === undefined) {
    report.log = { path: logPath, found: false }
    problems.push(`no diagnostics log at ${logPath}; the host has not loaded the plugin since it was installed`)
  } else {
    const applied = [...log.matchAll(/applied v([^\s,]+)/g)].pop()
    const roots = [...log.matchAll(/watchOnlyRoots=(\d+)/g)].pop()
    report.log = { path: logPath, found: true, applied: applied?.[1] ?? null, watchOnlyRoots: roots ? Number(roots[1]) : null }
    if (applied === undefined) problems.push('the log has no "applied v..." line; the host has not started the plugin')
    else if (report.install && applied[1] !== report.install.version) {
      problems.push(`the host is running v${applied[1]}, the profile has v${report.install.version}; restart DSH`)
    }
  }
}

// ── what the project resolves ──────────────────────────────────────────────
const requested = resolve(options.project)
const projectRoot = (await findProjectRoot(requested)) ?? requested
const configPath = resolveConfigPath(projectRoot, DEFAULT_CONFIG_FILE)
const raw = await readText(configPath)
if (raw === undefined) {
  report.project = { root: projectRoot, configPath, configured: false, roots: [], skills: 0 }
  problems.push(`${projectRoot} has no ${DEFAULT_CONFIG_FILE}`)
} else {
  const document = parseProjectSkillConfig(raw, configPath)
  const resolved = resolveSkillRoots(projectRoot, document.skillPaths, {
    allowExternalPaths: report.profile?.allowExternalPaths === true,
  })
  const expanded = await expandSkillRoots(resolved, {
    maxDepth: report.profile?.maxDepth ?? 2,
    allowExternalPaths: report.profile?.allowExternalPaths === true,
  })
  const roots = []
  let skills = 0
  for (const root of expanded) {
    if (root.watchOnly === true) {
      roots.push({ path: root.path, watchOnly: true, skills: 0 })
      continue
    }
    let names = []
    try {
      const entries = await readdir(root.path, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          await stat(join(root.path, entry.name, 'SKILL.md'))
          names.push(entry.name)
        } catch { /* not a skill folder */ }
      }
    } catch { /* unreadable root */ }
    skills += names.length
    roots.push({ path: root.path, watchOnly: false, skills: names.length, names })

    // A root with no skills that is nobody's parent, yet holds skill folders one
    // level further down, is the "maxDepth is too small" case.
    if (names.length === 0 && !root.watchOnly) {
      const isContainer = expanded.some((other) => other !== root && other.path.startsWith(root.path + sep))
      if (!isContainer) {
        let deeper = 0
        try {
          for (const folder of await readdir(root.path, { withFileTypes: true })) {
            if (!folder.isDirectory()) continue
            const grandchildren = await readdir(join(root.path, folder.name), { withFileTypes: true }).catch(() => [])
            for (const child of grandchildren) {
              if (!child.isDirectory()) continue
              const found = await stat(join(root.path, folder.name, child.name, 'SKILL.md')).then(() => true, () => false)
              if (found) { deeper += 1; break }
            }
          }
        } catch { /* unreadable */ }
        if (deeper > 0) {
          hints.push(`${root.path} resolves 0 skills but holds skill folders one level deeper; raise maxDepth (currently ${report.profile?.maxDepth ?? '?'})`)
        }
      }
    }
  }
  report.project = { root: projectRoot, configPath, configured: true, roots, skills }
  if (skills === 0) problems.push(`${projectRoot} resolves zero skills`)
}

if (options.json) {
  process.stdout.write(JSON.stringify({ ...report, problems }, null, 2) + '\n')
  process.exit(problems.length === 0 ? 0 : 1)
}

const line = (label, value) => process.stdout.write(`${label.padEnd(14)}${value}\n`)
line('plugin', `${PACKAGE.name} ${PACKAGE.version} (needs DSH ${report.package.dsh ?? 'any'})`)
if (report.profile) {
  line('profile', `${report.profile.dir}`)
  line('dependency', report.profile.dependency ?? 'missing')
  line('plugin row', report.profile.row ? `on (maxDepth ${report.profile.maxDepth}, external ${report.profile.allowExternalPaths})` : 'missing')
}
if (report.install) line('installed', `${report.install.version}${report.install.sameAsThisCopy ? '' : '  (differs from this copy)'}`)
if (report.log) line('host loaded', report.log.applied ? `v${report.log.applied}` : 'not since install')
if (report.project) {
  line('project', report.project.root)
  if (report.project.configured) {
    line('roots', String(report.project.roots.length))
    for (const root of report.project.roots) {
      line('', `  ${root.path}  ${root.watchOnly ? '(watched only)' : `${root.skills} skill${root.skills === 1 ? '' : 's'}`}`)
    }
    line('skills', String(report.project.skills))
  } else {
    line('config', 'no .dsh/skill-paths.yaml')
  }
}

if (hints.length > 0) {
  process.stdout.write('\nHints:\n')
  for (const hint of hints) process.stdout.write(`  - ${hint}\n`)
}

if (problems.length === 0) {
  process.stdout.write('\nOK: installed, loaded, and the project resolves.\n')
  process.exit(0)
}
process.stdout.write('\nProblems:\n')
for (const problem of problems) process.stdout.write(`  - ${problem}\n`)
process.exit(1)
