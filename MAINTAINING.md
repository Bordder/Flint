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
- `npm run smoke:pdf` and `npm run smoke:updater` pass. pdf-smoke renders the real
  export markup in a real window and is what actually exercises the renderer air gap.
  updater-smoke only shows the updater can reach GitHub from the main process: it
  opens no window, so it cannot prove anything about the air gap, and no longer
  claims to.
- `npm run check:mutation` passes. It breaks each guarded behaviour in a scratch copy
  and requires the suite to fail. A green suite is not the same as a suite that would
  catch a regression, and several tests here once passed on deliberately broken code.
- `npm run check:package` now runs automatically as the second half of `npm run dist`,
  so the file you drag onto the release is the file that was checked. `npm run publish`
  builds a second time to upload; that rebuild is not itself re-inspected, which is
  fine for what this gate catches (stray files in the project folder are identical
  across both builds) but is not a guarantee about the uploaded bytes. If you want
  that guarantee, use the manual path: `npm run dist`, then upload from `dist\`.
  It inspects what actually went
  into the build and refuses to publish if a username, home path, session id or dev
  folder is present. `build.files` is a denylist starting from everything on disk, so
  anything new in the project root ships by default, and `.gitignore` has no say in it.
  A privacy check against the git diff cannot catch this: that is how 1.4.3 through
  1.5.0 shipped a `.claude` folder.
- After `npm run dist`, `dist\` holds exactly three release files,
  `Flint-Setup-<version>.exe`, its `.exe.blockmap`, and `latest.yml`, and `latest.yml`'s
  `version` matches the exe. A missing or stale `latest.yml` or `.blockmap` silently
  breaks auto-update for every existing user, so never skip this.
- Note the version's changes for the release body (a committed `CHANGELOG.md` at the
  repo root is worth starting, so the history survives outside the gitignored `dist`).

**`latest.yml` is the file that must never be missing.** The updater finds the newest
version from the releases feed, then fetches `latest.yml` from that release to learn
the installer's filename, size and checksum. If the newest release has no `latest.yml`
(or a `v<version>` tag was pushed ahead of its release), that fetch 404s and *every
existing user* sees "couldn't check for updates" until you upload it. It is only about
300 bytes sitting next to a 100 MB installer, so it is far and away the easiest of the
three to forget. Upload all three together, then confirm the update path is actually
live:

```
curl -sI https://github.com/Bordder/Flint/releases/download/v<version>/latest.yml
```

`200` means updates work; `404` means they are broken for everyone until you fix it.

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

## Accepted risk: the build is not code-signed

`package.json` sets no `certificateFile`, `certificateSubjectName` or
`publisherName`, so the installer carries no Authenticode signature. Two
consequences, both deliberate rather than overlooked:

- **Windows SmartScreen warns on every install and every update.** That is
  expected, and the README explains how to verify a download by its SHA256
  instead. The real cost is that it trains people to click through warnings.
- **electron-updater cannot verify the signature of what it downloads.** Its
  Windows signature check returns early when no `publisherName` is configured,
  so the only integrity controls are HTTPS and the sha512 in `latest.yml`, both
  served from the same place. Anyone who could tamper with the release could
  tamper with both.

What keeps this reasonable: `autoDownload` and `autoInstallOnAppQuit` are both
off, so nothing is fetched or installed without two deliberate clicks, and the
stated threat model puts the adversary at this computer rather than at GitHub.

Buying a certificate closes it. Until then this is a known, accepted risk, and
worth re-reading if the project ever gains enough users to be worth attacking.
