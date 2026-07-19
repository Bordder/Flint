# Maintaining and releasing Flint

Notes for whoever builds and publishes Flint. People who just use the app never
need any of this; their guide is `README.md`. This file is not bundled into the
installer.

## Build the installer

Install Node.js LTS from https://nodejs.org, then in the project folder run:

```
npm install
npm run dist
```

The installer lands at `dist\Flint-Setup-<version>.exe`. `npm test` runs the
data-layer self-checks; `npm start` runs the app without installing.

## The fuses (why one is deliberately left alone)

The `electronFuses` block in `package.json` hardens the built `Flint.exe` so it
cannot be misused as a general-purpose Node interpreter (`ELECTRON_RUN_AS_NODE`,
`NODE_OPTIONS`, `--inspect`) and will only load the app from a verified
`app.asar`. One fuse is deliberately left alone: `grantFileProtocolExtraPrivileges`.
Flint's own window is a `file://` page loaded out of `app.asar`, and turning that
fuse off stops the page loading at all, so the app opens as a blank window. What
it would have guarded against (a `file://` page reaching other `file://`
resources) is already covered by the page's Content-Security-Policy and by
`lockDownNetwork` in `main.js`, which cancels every request that is not one of the
app's own files. If you ever build and get a blank window, that fuse is the first
thing to check.

## Release a new version

Updates reach installed copies through GitHub releases. The app is configured to
look at `Bordder/Flint` (`package.json`, `build` then `publish`); that repo must
be public.

Before you publish, make sure the build is sound:

- `npm ci && npm test` pass (a clean install of the exact locked versions, then the
  data-layer self-checks). Use `npm ci`, not `npm install`, so you ship what you tested.
  These also run automatically on every push via GitHub Actions.
- `npm run smoke:pdf` and `npm run smoke:updater` pass (the PDF export path, and that
  the updater reaches GitHub without crossing the sealed writing window).
- After `npm run dist`, `dist\` holds exactly three release files,
  `Flint-Setup-<version>.exe`, its `.exe.blockmap`, and `latest.yml`, and `latest.yml`'s
  `version` matches the exe. A missing or stale `latest.yml` or `.blockmap` silently
  breaks auto-update for every existing user, so never skip this.
- Note the version's changes for the release body (a committed `CHANGELOG.md` at the
  repo root is worth starting, so the history survives outside the gitignored `dist`).

Then:

1. Bump `"version"` in `package.json`.
2. Run `npm run dist`.
3. Create a release at `https://github.com/Bordder/Flint/releases/new`, set the
   tag to `v` plus that version (for example `v1.2.0`), and drag all three files
   from your `dist\` folder onto it, then Publish:
   - `Flint-Setup-<version>.exe`
   - `Flint-Setup-<version>.exe.blockmap`
   - `latest.yml`
4. Paste the installer's checksum into the release notes so downloaders can
   confirm they got the file you built. Get it with:

   ```
   certutil -hashfile dist\Flint-Setup-<version>.exe SHA256
   ```

The filenames have no spaces on purpose, so GitHub keeps them exactly as-is and
the update check matches them. Every installed copy offers the update the next
time it opens.

**Faster alternative (uploads everything for you):** create a GitHub personal
access token (a fine-grained token scoped to just this repository's Contents and
Releases is safest, since this token can push an update to every user), then run:

```
set GH_TOKEN=your_token_here
npm run publish
```

That builds and uploads all three files in one go. Keep the token private, and
never commit or share it. (It also works from any web host instead of GitHub, by
switching the `publish` config in `package.json`.)
