# Flint

A quiet, private daily journal for Windows. Your notes never leave this
computer, everything lives in plain files on your PC. The only thing it ever
does online is check for a new version (optional, and it only downloads, it
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
   build tools (needs internet, the *built app* itself never does), the
   second builds the installer. Each can take a few minutes:

   ```
   npm install
   npm run dist
   ```

4. When it finishes, the installer is at:

   ```
   dist\Flint-Setup-1.1.0.exe
   ```

(Optional: `npm test` runs the saving/backup self-checks. `npm start` runs
the app directly without installing.)

**A note for whoever builds this next.** The `electronFuses` block in
`package.json` hardens the built `Flint.exe` so it cannot be misused as a
general-purpose Node interpreter (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`,
`--inspect`) and will only load the app from a verified `app.asar`. One fuse is
deliberately **left alone**: `grantFileProtocolExtraPrivileges`. Flint's own
window is a `file://` page loaded out of `app.asar`, and turning that fuse off
stops the page loading at all, so the app opens as a blank window. What it would
have guarded against (a `file://` page reaching other `file://` resources) is
already covered by the page's Content-Security-Policy and by `lockDownNetwork`
in `main.js`, which cancels every request that is not one of the app's own files.
If you ever build and get a blank window, that fuse is the first thing to check.

## 2. How to install it

Double-click `dist\Flint-Setup-1.1.0.exe`. It installs in a few seconds
with no questions, then Flint opens by itself. From then on you'll find
**Flint** in the Start menu and as a desktop shortcut. No command line ever
again, just open it like any other app.

To uninstall: Settings → Apps → Flint → Uninstall. **Uninstalling never
deletes your entries**, they stay in the data folder below.

### "Windows protected your PC"

The first time you run the installer, Windows SmartScreen will most likely show
a blue box saying it "prevented an unrecognised app from starting". Click
**More info**, then **Run anyway**.

That warning is worth understanding rather than just clicking past. It does not
mean Windows found anything wrong with Flint. It means Windows does not
recognise it. SmartScreen trusts an app once it has been downloaded by enough
people without incident, or once it is signed with a paid code-signing
certificate. Flint is a personal project with no certificate and almost no
downloads, so there is no reputation for Windows to look up, and an app with no
reputation looks the same to it as an app nobody has ever vetted. The warning
means *unknown*, not *unsafe*.

Two things follow from that:

- It comes back on **every new version**. Reputation is tied to the exact file,
  so an unsigned app starts from zero each release. (A signed app builds trust
  that carries across releases, which is the only real fix, see section 8.)
- Some Windows 11 machines run **Smart App Control**, which is stricter and can
  refuse unsigned apps outright with no "Run anyway" option. If that happens,
  build Flint yourself instead (section 1).

### Checking it yourself

You should not have to take anyone's word for it. Two ways to check:

**Scan it.** Upload the `.exe` to [virustotal.com](https://www.virustotal.com),
which runs it past around 70 antivirus engines at once and shows you every
result. One caveat, so a surprise does not alarm you: unsigned installers
commonly pick up a hit or two from obscure engines that flag "unsigned NSIS
installer" as inherently suspicious. That is a guess about the packaging, not a
detection of anything in the app. If the well known engines are clean, it is
clean. If several major engines flag it, do not run it.

**Check it is the file that was published.** Open a terminal in the download
folder and run:

```
certutil -hashfile Flint-Setup-1.1.0.exe SHA256
```

Compare that against the checksum on the release page. If they match, nothing
altered the file between the release and your PC. (VirusTotal shows the same
hash, so it does both jobs at once.)

The most honest answer is that you never have to trust the installer at all. The
source is all here, and `npm install && npm run dist` (section 1) builds the same
app from code you can read.

## 3. Where your words are stored

Everything is in one folder (paste this into the File Explorer address bar):

```
%APPDATA%\Flint\data
```

which is normally:

```
C:\Users\<your Windows username>\AppData\Roaming\Flint\data
```

| File / folder   | What it is                                                        |
| --------------- | ----------------------------------------------------------------- |
| `entries.json`  | Your whole journal, every day. Plain readable text, or an encrypted vault if you turn encryption on |
| `backups\`      | A dated copy from each of your last 30 saves (encrypted too, when encryption is on)                 |
| `settings.json` | Your prompts, chosen theme, update choice, and the optional legacy window PIN                        |

This folder is in AppData deliberately: OneDrive and other sync tools don't
touch it, so nothing is ever uploaded anywhere.

Inside the app: open **Settings** (the cog in the top bar) and, under **Where
your words live**, press **Open that folder**. The same path is shown there too.

**If something ever goes wrong with the main file**, Flint notices when it
opens, keeps the damaged file (it never deletes anything), and loads your most
recent good backup automatically.

## 4. Locking and encryption (optional)

By default your entries are plain, readable files on this computer. If you want
them protected, turn on **encryption**: Settings → **Lock & encryption** →
*Turn on encryption*. Choose a PIN, and Flint shows you a **recovery code** once.
Write it down and keep it somewhere safe.

From then on:

- Flint asks for your PIN each time it opens, and decrypts your journal only in
  memory once you unlock. On disk, `entries.json`, its backups and your photos
  are all scrambled with AES-256.
- **Pick a PIN that is worth something.** This is the honest part: the encryption
  is only ever as strong as the PIN in front of it. Someone who copied your files
  could guess a 4-digit PIN in seconds and a 6-digit one in minutes, so Flint
  shows you a live estimate as you type. A short word plus a couple of digits is
  worth years of guessing; four digits is worth seconds.
- **Forgotten your PIN?** Enter your recovery code on the lock screen. Flint then
  asks you to choose a new PIN, and re-locks the journal with a brand new key, so
  the forgotten PIN and the code you just used both stop working.
- **Changing your PIN** also re-locks the journal with a new key, so you get a new
  recovery code at the same time (the old one stops working). This is what makes a
  PIN change mean something: otherwise an old backup would still answer to the old
  PIN and hand over the same key.
- **Lose both the PIN and the recovery code** and the journal cannot be opened
  by anyone, including you. That is what makes the encryption real, so keep the
  recovery code safe and separate from this computer.
- You can turn encryption off again (which writes your entries and photos back as
  readable files) from the same Settings section.

There is also an older, lighter **window PIN** that only hides the app window
without encrypting anything. If you have one set (and haven't turned on
encryption), a forgotten one is cleared by closing Flint, deleting
`settings.json` in the data folder, and reopening, your words in `entries.json`
are untouched. Turning on encryption replaces the window PIN.

## 5. Moving to a new computer

1. On the new PC: build and install Flint (sections 1–2), or copy the
   `dist\Flint-Setup-1.1.0.exe` you already built onto a USB stick and run
   it there.
2. Open Flint once on the new PC, then close it.
3. Copy the whole `%APPDATA%\Flint\data` folder from the old PC (USB stick is
   fine) to the same place on the new PC, replacing what's there.
4. Open Flint, everything is back.

Backing up is the same idea: copy that one `data` folder anywhere safe.

## 6. What's in the app

- **Your own prompts.** Settings → "Your daily prompts" lets you rename, add, reorder or remove the daily boxes, make it a health diary, a work log, a
  gratitude journal, whatever you like. Removing a prompt only hides it;
  anything you already wrote under it stays saved and still shows and exports.
- **"How was today?"** an optional Good / Mixed / Hard marker on each day.
- **Tags.** Label a day (e.g. "migraine", "holiday") and click any tag, or
  type it in Search, to pull up every day with it.
- **Export** every day as a plain **text file**, a tidy **PDF**, or copy it all
  to paste elsewhere (Settings → "Take your journal with you").
- **Light, dark, or system theme.** Settings → Appearance. System follows your
  Windows setting; your choice is remembered.
- **A daily streak.** A small flame by the wordmark lights up once you have
  written today, and counts the days you have kept going.
- **Search and date filters** for finding past days.
- **Encryption** with a PIN and one-time recovery code (optional, see section 4).
- **A gentle first-run setup.** The first time Flint opens it asks your theme
  and, if you want, helps you set a PIN there and then.
- **Automatic update checks** (optional, see section 8).

The starting prompts and the day-marker wording live in one file,
`shared/questions.js`, if you'd rather change the built-in defaults in code and
rebuild, but you never need to: everything above is editable inside the app.

## 7. Privacy and the internet

Flint is built so your **notes never leave this computer**. The window you
write in is sealed off from the network entirely, it cannot make an internet
connection even if something tried to. The *only* thing the whole app ever does
online is the optional update check (section 8), and even that only **downloads**
a new version; it has no way to send your entries anywhere. No accounts, no
sync, no analytics.

- The write-in window's network access is hard-blocked (`main.js`, `lockDownNetwork`), actively cancelled, not just avoided.
- The update check runs in a separate part of the app and reaches only GitHub.
  The honest caveat: like any download, it reveals your computer's IP address to
  GitHub, but never a word of your journal.
- Turn update checks off in Settings → Updates and Flint is fully offline
  again; it then behaves identically with Wi-Fi switched off.
- Spellcheck is off (Windows spellcheck would fetch dictionaries); the PDF is
  made on your own machine.

## 8. Automatic updates (how new versions reach you)

Flint checks GitHub for a newer version when it opens (you can switch this off
in Settings → Updates, or press "Check now" any time). If one exists, a calm bar
appears offering **Download**, then **Install and restart**, nothing downloads
or installs without your click, and if you're offline it simply does nothing.

For this to find anything, each new version has to be **published** to a GitHub
release. The app is already configured to look at **`Bordder/Flint`** (set in
`package.json` under `build` → `publish`). One-time setup: create that **public**
repo at https://github.com if it doesn't exist yet.

Then, to release a new version:

1. Bump `"version"` in `package.json` (e.g. `1.1.0` → `1.1.1`).
2. Run `npm run dist`.
3. Go to `https://github.com/Bordder/Flint/releases/new`, set the tag to `v`
   plus that version (e.g. `v1.1.1`), and **drag these three files** from your
   `dist\` folder onto the release, then Publish:
   - `Flint-Setup-1.1.1.exe`
   - `Flint-Setup-1.1.1.exe.blockmap`
   - `latest.yml`
4. Paste the installer's checksum into the release notes, so anyone downloading
   it can confirm they got the file you actually built (see "Checking it
   yourself" in section 2). Get it with:

   ```
   certutil -hashfile dist\Flint-Setup-1.1.1.exe SHA256
   ```

The filenames have no spaces on purpose, so GitHub keeps them exactly as-is and
the update check matches them. Every installed copy will offer that update the
next time it opens.

**Faster alternative (uploads everything for you):** create a GitHub
"personal access token" with `repo` permission, then run:

```
set GH_TOKEN=your_token_here
npm run publish
```

That builds and uploads all three files in one go. Keep the token private, never commit it or share it. (If you'd rather not use GitHub at all, the same
works from any web host; ask and I'll switch the config to a plain URL.)

---

Coded by Claude Opus 4.8.
