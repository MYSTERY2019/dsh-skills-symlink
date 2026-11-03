# Changelog

## 0.4.0 - 2026-11-04

First release under the unified name. The repository, the npm package, the plugin id and the
diagnostics log are all `dsh-skills-symlink`.

The `v0.4.0` tag was moved on 2026-11-04 to a commit with the security and robustness fixes
below. An install made from the earlier tag does not update itself: remove the plugin and add it
again.

Security:

- `allowExternalPaths: false` is enforced on real paths. A configured root, a category folder or a
  single skill folder that is a symbolic link pointing outside the project is rejected, and a
  skill's real file is checked again when its body is loaded.
- The settings endpoint moved to `/api/dsh-skills-symlink/config` on the host's own connection, so
  it passes DSH's sign-in and Host/Origin checks. It only serves workspaces DSH knows; POST must be
  same-origin `application/json` of at most 16 KiB; writes refuse a symlinked `.dsh` folder or
  config file.
- A save is validated before anything is written and is written atomically (temporary file, then
  rename). A rejected save leaves the old file untouched.

Robustness:

- Invalid numbers in the plugin row (`configWatchIntervalMs: 0`, `maxDepth: 2.5`, ...) fall back to
  their defaults with a warning instead of stopping DSH from starting.
- In `.dsh/skill-paths.yaml`, plugin options such as `maxDepth` or `ignore` are ignored with a hint,
  and one invalid path only drops that path, instead of emptying the whole project.
- Empty folders watched for new skills no longer use up `maxRoots`.
- Shadowed skills are reported with both paths at every `maxDepth`, and again when the set changes.
- Each root is scanned through a separate single-root scanner; diagnostics are written
  asynchronously; a relative `logFile` is resolved from the profile directory.
- `engines.dsh` and the DSH peer dependencies are `>=0.2.1-rc.5 <0.3.0`; `docs/` is no longer
  packed into the tarball.

Packaging:

- `docs/` ships again, because both READMEs embed its images and a tarball without them renders
  four broken pictures.
- `.gitattributes` pins `eol=lf`. Two tests matched `\n` in fenced blocks and regexes, so a
  Windows checkout with `core.autocrlf` failed them for reasons unrelated to the code.
- `scripts/post-install-check.mjs` reports a root that resolves 0 skills while skill folders sit one
  level deeper, and names the `maxDepth` to raise. That is the failure mode of a too-shallow depth,
  which otherwise shows up as a silently empty category.
- `scripts/post-install-check.mjs` ships with the package. It reports which profile holds the
  plugin, which version the host loaded, and what a project resolves, and exits non-zero when any
  of those disagree. Tests cannot see a stale install or a host that never restarted; this can.
- The DSH range is `>=0.2.1-rc.5` with no upper bound. A closed range makes the host skip the
  plugin silently on the next minor release, which is harder to notice than an error.

The settings card shows what a project actually resolves:

- Read a project and the card lists every root this project scanned, in expansion order, with the
  skill names under each one. The roots are what `maxDepth` produced, not the lines in the yaml.
- Watch-only directories are listed apart from the roots that contribute skills.
- Errors are shown by error code in the card's language.

If you installed an earlier build, these identifiers moved:

- Plugin id is `dsh-skills-symlink` (was `project-skill-paths`). Update the `- id:` row in a
  profile's `cordis.patch.yml`, or the plugin falls back to `maxDepth: 1` and
  `allowExternalPaths: false`.
- Package name is `dsh-skills-symlink`; `dsh plugin remove` takes the new name.
- Settings namespace is `dsh-skills-symlink`, so settings saved under the old name are not read.
- Diagnostics log is `dsh-skills-symlink.log`, with lines prefixed `dsh-skills-symlink:`.
