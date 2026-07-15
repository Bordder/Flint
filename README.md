# Flint

A quiet, private daily journal for Windows. Your notes never leave this
computer — everything lives in plain files on your PC. The only thing it ever
does online is check for a new version (optional, and it only downloads — it
never sends your entries anywhere). See sections 7–8.

---

## 1. How to build and package it

You only need to do this when you want to (re)create the installer.

**One-time setup:** install Node.js from https://nodejs.org (the "LTS"
version, default options). That's the only tool required.

Then, in this project folder:

1. Open the folder in File Explorer.
2. Click the address bar, type `cmd`, press Enter (a black window opens here).
3. Type these two commands, pressing Enter after each. The first fetches the
   build tools (needs internet — the *built app* itself never does), the
   second builds the installer. Each can take a few minutes:

   ```
   npm install
   npm run dist
   ```

4. When it finishes, the installer is at:

   ```
   dist\Flint Setup 1.0.0.exe
   ```

(Optional: `npm test` runs the saving/backup self-checks. `npm start` runs
the app directly without installing.)

## 2. How to install it

Double-click `dist\Flint Setup 1.0.0.exe`. It installs in a few seconds
with no questions, then Flint opens by itself. From then on you'll find
**Flint** in the Start menu and as a desktop shortcut. No command line ever
again — just open it like any other app.

To uninstall: Settings → Apps → Flint → Uninstall. **Uninstalling never
deletes your entries** — they stay in the data folder below.

## 3. Where your words are stored

Everything is in one folder (paste this into the File Explorer address bar):

```
%APPDATA%\Flint\data
```

which is normally:

```
C:\Users\G\AppData\Roaming\Flint\data
```

| File / folder   | What it is                                                        |
| --------------- | ----------------------------------------------------------------- |
| `entries.json`  | Your whole journal — every day, plain readable text               |
| `backups\`      | A dated copy from each of your last 30 saves                      |
| `settings.json` | Your prompts, chosen theme, and PIN (created when you change any) |

This folder is in AppData deliberately: OneDrive and other sync tools don't
touch it, so nothing is ever uploaded anywhere.

**Renamed from "Journal".** This app used to be called Journal. The first time
Flint opens, if it finds entries from the old name (in `%APPDATA%\Journal\data`)
and doesn't have its own yet, it copies them across automatically — so nothing
is lost. The old `Journal` folder is left untouched as an extra safety copy; you
can delete it once you've confirmed everything is in Flint.

Inside the app: **Help → Where is my data?** opens this folder, and the
Settings section at the bottom of the page shows the same path.

**If something ever goes wrong with the main file**, Flint notices when it
opens, keeps the damaged file (it never deletes anything), and loads your most
recent good backup automatically.

## 4. About the PIN (if you set one)

The PIN just hides the app window from casual eyes — your entries on disk are
**not** encrypted, so a forgotten PIN can never lock you out of your own
words. To remove a forgotten PIN: close Flint, open the data folder above,
delete `settings.json`, reopen Flint. Everything you wrote is still there.
(The same instructions appear on the PIN screen under "Forgotten your PIN?".)

Deleting `settings.json` also resets your custom prompts and theme back to the
defaults — but it never touches a single word in `entries.json`.

## 5. Moving to a new computer

1. On the new PC: build and install Flint (sections 1–2), or copy the
   `dist\Flint Setup 1.0.0.exe` you already built onto a USB stick and run
   it there.
2. Open Flint once on the new PC, then close it.
3. Copy the whole folder `C:\Users\G\AppData\Roaming\Flint\data` from the
   old PC (USB stick is fine) to the same place on the new PC, replacing
   what's there.
4. Open Flint — everything is back.

Backing up is the same idea: copy that one `data` folder anywhere safe.

## 6. What's in the app

- **Your own prompts.** Settings → "Your daily prompts" lets you rename, add,
  reorder or remove the daily boxes — make it a health diary, a work log, a
  gratitude journal, whatever you like. Removing a prompt only hides it;
  anything you already wrote under it stays saved and still shows and exports.
- **"How was today?"** an optional Good / Mixed / Hard marker on each day.
- **Tags.** Label a day (e.g. "migraine", "holiday") and click any tag, or
  type it in Search, to pull up every day with it.
- **Export** every day as a plain **text file**, a tidy **PDF**, or copy it all
  to paste elsewhere (File menu, or the "Take your journal with you" card).
- **Dark mode.** Settings → Appearance, remembered between sessions.
- **Search and date filters** for finding past days.
- **A PIN lock** (optional — see section 4).
- **Automatic update checks** (optional — see section 8).

The starting prompts and the day-marker wording live in one file,
`shared/questions.js`, if you'd rather change the built-in defaults in code and
rebuild — but you never need to: everything above is editable inside the app.

## 7. Privacy and the internet

Flint is built so your **notes never leave this computer**. The window you
write in is sealed off from the network entirely — it cannot make an internet
connection even if something tried to. The *only* thing the whole app ever does
online is the optional update check (section 8), and even that only **downloads**
a new version; it has no way to send your entries anywhere. No accounts, no
sync, no analytics.

- The write-in window's network access is hard-blocked (`main.js`,
  `lockDownNetwork`) — actively cancelled, not just avoided.
- The update check runs in a separate part of the app and reaches only GitHub.
  The honest caveat: like any download, it reveals your computer's IP address to
  GitHub — but never a word of your journal.
- Turn update checks off in Settings → Updates and Flint is fully offline
  again; it then behaves identically with Wi-Fi switched off.
- Spellcheck is off (Windows spellcheck would fetch dictionaries); the PDF is
  made on your own machine.

## 8. Automatic updates (how new versions reach you)

Flint checks GitHub for a newer version when it opens (you can switch this off
in Settings → Updates, or press "Check now" any time). If one exists, a calm bar
appears offering **Download**, then **Install and restart** — nothing downloads
or installs without your click, and if you're offline it simply does nothing.

For this to find anything, each new version has to be **published** to a GitHub
release. The app is already configured to look at **`bordder/Notably`** (set in
`package.json` under `build` → `publish`). One-time setup: create that **public**
repo at https://github.com if it doesn't exist yet.

Then, to release a new version:

1. Bump `"version"` in `package.json` (e.g. `1.0.0` → `1.0.1`).
2. Run `npm run dist`.
3. Go to `https://github.com/bordder/Notably/releases/new`, set the tag to `v`
   plus that version (e.g. `v1.0.1`), and **drag these three files** from your
   `dist\` folder onto the release, then Publish:
   - `Flint-Setup-1.0.1.exe`
   - `Flint-Setup-1.0.1.exe.blockmap`
   - `latest.yml`

The filenames have no spaces on purpose, so GitHub keeps them exactly as-is and
the update check matches them. Every installed copy will offer that update the
next time it opens.

**Faster alternative (uploads everything for you):** create a GitHub
"personal access token" with `repo` permission, then run:

```
set GH_TOKEN=your_token_here
npm run publish
```

That builds and uploads all three files in one go. Keep the token private —
never commit it or share it. (If you'd rather not use GitHub at all, the same
works from any web host; ask and I'll switch the config to a plain URL.)
