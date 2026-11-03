# Contributing

Issues and pull requests are welcome.

## Development setup

Use a supported Node.js version (22.19+ or 24+) and npm:

```powershell
corepack enable
npm ci
npm run check
npm pack --dry-run
```

Keep project fixtures and generated profile data free of credentials and machine-specific absolute paths. New behavior should include a focused Node test. Changes to the settings UI should also update the client bundle assertion in `test/settings-ui.integration.test.mjs`.

## Release notes

A release note is the delta from the previous tag, not a second copy of the README. Leave install
steps, configuration details and the comparison with upstream in the README, where they stay
current; `CHANGELOG.md` carries the long form. Write it in both languages, English first and
Chinese after a horizontal rule, and keep the two halves saying the same thing.

## Pull requests

- Describe the user-visible behavior and its project-scope boundary.
- Include validation output or explain what could not be run.
- Do not commit DSH profile data, API keys, personal Skill contents, or `node_modules`.
- Keep official `@deepseek-ai/*` packages in `peerDependencies`.
