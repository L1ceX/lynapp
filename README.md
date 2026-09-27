# lynapp

Windows-first Minecraft launcher. Electron + React + TypeScript (electron-vite, electron-builder NSIS + portable).

## Features

- Instances: vanilla, Fabric, Quilt, Forge, NeoForge with per-instance version, loader version and RAM.
- `.mrpack` (Modrinth modpack) import via drag & drop onto the Instances section, with progress bar and Modrinth project linking.
- Modrinth browse/install: mods, resource packs, shaders, data packs, modpacks, with local file manager (enable/disable/delete).
- Accounts: multiple Microsoft (licensed) and offline profiles, click to switch, per-account remembered skin.
- Skins: upload 64x64 PNG, Wide/Slim, upload to Mojang for Microsoft accounts, cape equip, 3D preview (skinview3d) with idle pose and spring cape physics. Offline profiles cannot change skins.
- Theming: 13 color tokens, presets, cursor glow, animations toggle.
- Automatic Java provisioning (Adoptium Temurin) per Minecraft requirement, detected from Mojang's `javaVersion.majorVersion`.

## Data layout (`%APPDATA%\lynapp`)

`instances/`, `minecraft/` (versions, libraries, assets, natives), `runtimes/`, `skins/`, `cache/`, `launcher-data.json`. Electron/Chromium caches live in `app/`.

## Commands

```powershell
npm install
npm run dev      # dev with hot reload
npm run build    # typecheck + bundle
npm run dist     # build + NSIS setup + portable into release/
```

## Notes

- Microsoft login uses the bundled desktop OAuth client id in `src/main/config.ts`.
- Skins of offline profiles can't be shown to others by the client alone. On `online-mode=false` servers, server-side plugins (e.g. SkinsRestorer) can display them. On `online-mode=true` servers offline profiles can't join at all (Mojang rejects the session).
- `launcher-data.json` contains Microsoft access tokens in plain text — same trade-off as other launchers, never commit it (it lives outside the repo).
