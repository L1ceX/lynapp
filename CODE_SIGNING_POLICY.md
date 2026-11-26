# Code Signing Policy

This policy describes how official releases of **lynapp** (`https://github.com/L1ceX/lynapp`) are built and signed.

## Current Status

- **Signing Status:** Pending review (we are applying for free open-source code signing through the **SignPath Foundation**).
- Until code signing is active, official Windows release binaries are unsigned and may show a Windows SmartScreen warning on first run.
- Once approved and integrated: *Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).*

## Scope of Signed Artifacts

Once code signing is active, digital signatures will apply exclusively to first-party binaries built by this repository's official GitHub Actions release workflows:

- Main Windows launcher executable (`lynapp.exe` / `lynapp-portable-*.exe`)
- Official Windows NSIS installer (`lynapp_*_x64-setup.exe` / `lynapp-setup-*.exe`)

Third-party files downloaded at runtime by the user (such as Minecraft game files, mod loaders, mods, or Eclipse Temurin Java runtimes) are never modified or signed by this project.

## Build Provenance & Security

- All official release binaries are built exclusively in automated **GitHub Actions** runners (`windows-latest` and `ubuntu-latest`) directly from tagged commits in `https://github.com/L1ceX/lynapp` — never from local developer machines.
- Source code is 100% open source under the **MIT License** (`LICENSE`).
- All runtime secrets (such as optional CurseForge API keys) are stored in GitHub Actions Secrets and never committed to the repository.

## Roles & Responsibilities

- **Maintainer / Author / Reviewer / Approver:** [@L1ceX](https://github.com/L1ceX) — maintains the repository, reviews changes, tags releases, and will review and approve production signing requests.

## Privacy

- **lynapp** does not include telemetry, analytics, ads, or crash uploaders.
- All user data, instances, and account tokens remain locally on the user's machine (`%APPDATA%\lynapp` on Windows, `~/.config/lynapp` on Linux), with Windows tokens encrypted via DPAPI.
