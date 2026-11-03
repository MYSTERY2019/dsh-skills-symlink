# Security policy

## Supported versions

Security fixes are applied to the latest tagged release.

## Data and permission model

`dsh-skills-symlink` has no telemetry and makes no outbound network requests. It reads Skill files from configured directories while DSH resolves Skills and writes only `<project>/.dsh/skill-paths.yaml` through its settings endpoint.

The settings endpoint is `/api/dsh-skills-symlink/config` on DSH's own connection, so it is reached only after the host's sign-in and Host/Origin checks. It serves only workspaces DSH knows, accepts writes only as same-origin `application/json` of at most 16 KiB, refuses to write through a symbolic link, and validates a new file before writing it atomically.

External or absolute Skill paths are rejected by default, and the check uses real paths, so a symbolic link inside the project that points outside it is rejected as well. Enabling `allowExternalPaths` broadens the files that DSH may read, so use it only for directories you trust.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository. Do not include credentials, private Skill contents, or other secrets in a public issue.
