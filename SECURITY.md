# Security policy

## Supported versions

This package is in active development (`0.x`). Security fixes land on the latest release of `main`.

| Version | Supported |
| --- | --- |
| Latest `0.x` release | Yes |
| Older `0.x` releases | Best effort |
| Pre-release / development builds | No |

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Use [GitHub private vulnerability reporting](https://github.com/harnesstap/opencode-agent-plugin-support/security/advisories/new) on this repository.

Repository owners: enable **Private vulnerability reporting** under GitHub **Settings → Code security and analysis** (or **Settings → Security**) if the advisory form is not available yet.

Include as much detail as you can: impact, reproduction steps, affected versions or commits, and logs or a proof of concept when it is safe to share.

We aim to acknowledge reports within **3 business days** and will work with you on a fix and coordinated disclosure.

## Scope

In scope: this npm package, its CLI, and GitHub Actions workflows in this repository.

Out of scope: third-party Claude Code plugins you load through this bridge (their hook commands run as your user; see the README Security section), OpenCode itself, and Claude Code.

## Safe disclosure

We appreciate responsible disclosure. We will credit reporters in release notes when they wish to be named.
