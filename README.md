# Flint

A quiet, private daily journal for Windows. Your words never leave this computer:
they live in ordinary files on your own PC, yours to read and back up, kept as
plain text by default or scrambled behind a PIN if you turn on encryption. No
account, no sync, no tracking. Flint goes online for only two things, both optional
and neither ever carrying a word of your journal: an automatic check for a new
version when it opens (which you can switch off), and any feedback you choose to send.

---

## Install it

Double-click the installer, `Flint-Setup-1.4.5.exe` (in your Downloads if you
downloaded it, or in the `dist` folder if you built it yourself). It installs in a
few seconds with no questions, then Flint opens by itself. From then on you will
find **Flint** in the Start menu and as a desktop shortcut, and you open it like
any other app. No command line, ever.

To uninstall later: Settings → Apps → Flint → Uninstall. **Uninstalling never
deletes your entries**, they stay in the data folder (see "Where your words are
stored", below).

### "Windows protected your PC"

The first time you run the installer, Windows SmartScreen (a built-in safety
feature) will most likely show a blue box saying it "prevented an unrecognised app
from starting". Click **More info**, then **Run anyway**.

That warning is worth understanding rather than just clicking past. It does not
mean Windows found anything wrong with Flint. It means Windows does not *recognise*
it. SmartScreen trusts an app once it has been downloaded by enough people without
incident, or once it is signed with a paid code-signing certificate. Flint is a
personal project with no certificate and almost no downloads, so there is no
reputation for Windows to look up, and an app with no reputation looks the same to
it as one nobody has ever vetted. The warning means *unknown*, not *unsafe*.

Two things follow from that:

- It comes back on **every new version**. Reputation is tied to the exact file, so
  an unsigned app starts from zero each release. (A signed app builds trust that
  carries across releases, which is the only real fix.)
- Some Windows 11 machines run **Smart App Control**, which is stricter and can
  refuse unsigned installers outright with no "Run anyway" option. If that happens,
  you can run Flint straight from the source instead, without installing anything
  (see "Build it yourself", at the end).

If you would rather not take anyone's word that the download is safe, "Check the
download yourself" near the end shows two ways to verify it.

## Getting started

The first time Flint opens it asks how you would like it to look, and offers, only
if you want, to set a PIN so your journal is encrypted. After that you land on
today's page: just start writing. There is nothing to save, Flint keeps your words
as you type. Even one line counts as a day. Come back tomorrow and today is waiting
in the calendar on the left.

## What's in the app

Everything below is optional and editable inside the app. You never need to open a
file.

- **Just write.** Today's page is a plain, open space. Write as much or as little
  as you like.
- **Autosaving.** Flint saves as you write, so keeping your words is never something
  you have to remember. A small dot by the wordmark shows whether everything is
  saved, and hovering it tells you when it last saved; you can set how often it
  saves, from every few seconds up to once an hour, in Settings → Writing. It also
  saves the instant you leave a day, hide the window or close it. Ctrl+S is still
  there if you like to press it, but there is nothing you have to remember to do.
- **Your own prompts.** Settings → Writing lets you rename, add, reorder or remove
  optional guided boxes, to make Flint a health diary, a work log, a gratitude
  journal, whatever you like. Removing a prompt only hides it; anything you already
  wrote under it stays saved and still exports.
- **Templates.** Save reusable layouts and drop one into a day from the Template
  button under your writing.
- **"How was today?"** An optional Good / Mixed / Bad marker on each day, plus a
  separate one-tap "Easier or harder than usual?" so changes from day to day are
  easy to see later.
- **A word for how you felt, and what the day held.** Two optional pickers under
  your writing: name a feeling or two, and tap the everyday things you did.
- **Star a day** to find it again and filter to just your favourites, and write
  `- [ ] something` in a note to get a checkbox you can tick.
- **Reading view.** A button under your writing shows your note as tidy formatted
  text (headings, lists, tickable checkboxes), for when you would rather read a day
  than edit it.
- **Tags.** Label a day (for example "migraine" or "holiday") and click any tag, or
  type it in Search, to pull up every day with it.
- **Quick note** (Ctrl+Shift+N) drops a line into today from wherever you are, and
  **Focus mode** (Ctrl+Shift+F) strips the screen back to just your writing.
- **Search and date filters** for finding past days, and an **On this day** panel
  that shows what you wrote on the same date in earlier months and years.
- **Your patterns.** A quiet panel (the chart icon) shows how many days you have
  written, your streaks, and a heatmap of your days, by month, by year, or across
  the last twelve.
- **A daily streak.** A small flame by the wordmark lights up once you have written
  today and counts the days you have kept going. You can mark days off (Settings →
  Reminders) so a planned gap steps over them instead of breaking the streak.
- **Reminders that can reach you when Flint is closed.** The optional daily nudge
  normally appears only while Flint is open. Turn on "keep Flint running when I
  close the window" in Settings → System and closing the window tucks Flint into
  the notification area instead of quitting, so the nudge still arrives. Flint
  asks you once, the first time you close it, and never again either way.
- **Starting with Windows is a separate choice.** Keeping Flint in the tray no
  longer adds a startup entry on its own. Settings → System has its own switch for
  that, so you can have one without the other.
- **A nudge when the page is blank.** Open a day you have not written on and Flint
  can offer a gentle prompt to start from. Ask for another, use it, or wave it away.
  The prompts are always optional and never time-limited, and on a day you mark Bad
  they lean to the kinder ones.
- **A quiet welcome back.** If it has been a while, or a new week has begun, Flint
  opens with a calm, dismissible line, never a guilt trip, and never a count of what
  you missed.
- **Themes.** Settings → Appearance. Light, dark or system (which follows Windows),
  plus a range of loved palettes (Nord, Everforest, Rosé Pine, Catppuccin, Tokyo
  Night, Gruvbox, Solarized Light, Sepia and more), and a **Custom** theme where you pick
  a light, dark or true-black base and your own two colours and save the
  combinations you like.
- **Take it with you.** Export your whole journal as a plain text file, a tidy PDF,
  Markdown (to reuse in another editor), or JSON (to bring back later), or copy it
  all to paste elsewhere (Settings → Backups & export). There is also a **Daily
  activities summary** (text or PDF) that lays your days out around everyday
  activities, handy to keep or to show someone helping you. **Import** brings a
  Flint JSON file back in, adding only days you do not already have.
- **A daily backup to a folder you choose.** Flint can drop a dated copy of your
  journal into a folder you pick (a USB stick, or a folder you already sync) once a
  day; if your journal is encrypted, the copy is encrypted too (Settings → Backups
  & export).
- **Encryption** with a PIN and a one-time recovery code, an optional **auto-lock**
  after a spell of inactivity, and a **Lock now** button in the top bar (see
  "Locking and encryption").
- **Automatic update checks** (optional, see "Automatic updates").

Flint also draws its own tidy window bar (minimise, maximise, close) instead of the
plain grey Windows frame.

## Where your words are stored

Everything is in one folder. Paste this into the File Explorer address bar (AppData
is a hidden Windows folder that programs use for their own files):

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
| `backups\`      | A dated copy from your recent saves, the newest 30 kept (encrypted too, when encryption is on)      |
| `settings.json` | Your preferences: theme and colours, reminder and backup choices, your update-check choice, streak days off, autosave and auto-lock timings, and the optional legacy window PIN. No writing of yours is in here |
| `content.json`  | Your own words that are not diary entries: prompt titles and hints, entry templates, and activity names. Encrypted along with your journal when encryption is on |
| `media\`        | Only if you attached photos in an older version. New photos can no longer be added, but any you have are kept (encrypted too, when encryption is on) |

This folder is in AppData deliberately: OneDrive and other sync tools don't touch
it, so nothing is ever uploaded anywhere.

Inside the app: open **Settings** (the cog in the top bar) and, under **Where your
words live**, press **Open that folder**. The same path is shown there too.

**If something ever goes wrong with the main file**, Flint notices when it opens,
keeps the damaged file (it never deletes anything), and loads your most recent good
backup automatically.

## Locking and encryption (optional)

By default your entries are plain, readable files on this computer. If you want them
protected, turn on **encryption**: Settings → **Lock & encryption** → *Turn on
encryption*. Choose a PIN, and Flint shows you a **recovery code** once. Write it
down and keep it somewhere safe.

From then on:

- Flint asks for your PIN each time it starts (and again after an auto-lock), and
  decrypts your journal only in memory once you unlock. On disk, `entries.json` and
  its backups are scrambled with AES-256.
- You can set Flint to **lock itself after a spell of inactivity** (Settings → Lock
  & encryption), and lock it on demand with the **Lock now** button in the top bar.
  Your words are always saved before it locks.
- **Pick a PIN that is worth something.** This is the honest part: the encryption is
  only ever as strong as the PIN in front of it. Someone who copied your files could
  guess a 4-digit PIN in seconds and a 6-digit one in minutes, so Flint shows you a
  live estimate as you type. A short word plus a couple of digits is worth years of
  guessing; four digits is worth seconds.
- **Forgotten your PIN?** Enter your recovery code on the lock screen. Flint then
  asks you to choose a new PIN, and re-locks the journal with a brand new key, so the
  forgotten PIN and the code you just used both stop working.
- **Changing your PIN** also re-locks the journal with a new key, so you get a new
  recovery code at the same time (the old one stops working). This is what makes a
  PIN change mean something: otherwise an old backup would still answer to the old
  PIN and hand over the same key.
- **Lose both the PIN and the recovery code** and the journal cannot be opened by
  anyone, including you. That is what makes the encryption real, so keep the recovery
  code safe and separate from this computer.
- You can turn encryption off again (which writes your entries back as readable
  files) from the same Settings section.

There is also an older, lighter **window PIN** that only hides the app window without
encrypting anything. If you have one set (and haven't turned on encryption), a
forgotten one is cleared by closing Flint, deleting `settings.json` in the data
folder, and reopening; this resets preferences like themes and reminders, but never
your entries in `entries.json`, and no longer your prompts, templates or activities
either, which live in `content.json`. Turning on encryption replaces the window PIN.

## Moving to a new computer

1. On the new PC: install Flint (see "Install it"), or copy the
   `Flint-Setup-1.4.5.exe` you already have onto a USB stick and run it there.
2. Open Flint once on the new PC, then close it.
3. Copy the whole `%APPDATA%\Flint\data` folder from the old PC (a USB stick is
   fine) to the same place on the new PC, replacing what's there.
4. Open Flint, everything is back.

Backing up is the same idea: copy that one `data` folder anywhere safe, or let Flint
do it for you with the daily backup above.

## Privacy and the internet

Flint is built so your **notes never leave this computer**. The window you write in
is sealed off from the network entirely: it cannot make an internet connection even
if something tried to. Only two things ever go online, and neither ever
includes your journal entries: an automatic check for a new version when Flint opens
(on by default, and switchable off in Settings → Updates), and feedback you send
yourself. The update check only **downloads** a new version, and feedback makes one
outbound connection to a form service so it can reach the app's maker. No accounts,
no sync, no analytics.

- The write-in window's network access is switched off in code, actively cancelled
  rather than merely avoided. (For the technically curious: `sealSession` /
  `lockDownNetwork` in `main.js`.)
- The update check runs in a separate part of the app and reaches only GitHub. The
  honest caveat: like any download, it reveals your computer's IP address to GitHub,
  but never a word of your journal.
- Feedback is only sent when you fill in the Feedback box and click Send. It carries
  just your note and the name you sign it with (a random one if you leave it blank),
  and no journal content. It is sent from the general part of the app, never from the
  private window you write in.
- Turn update checks off in Settings → Updates and Flint is fully offline again; it
  then behaves identically with Wi-Fi switched off.
- Spellcheck is off (Windows spellcheck would fetch dictionaries); the PDF is made on
  your own machine.

## Automatic updates (how new versions reach you)

Flint checks GitHub for a newer version when it opens (you can switch this off in
Settings → Updates, or press "Check now" any time). If one exists, a calm bar appears
offering **Download**, then **Install and restart**. Nothing downloads or installs
without your click, and if you're offline it simply does nothing.

Each update is an ordinary download from the project's GitHub releases page. Like any
download it reveals your computer's IP address to GitHub, but never a word of your
journal. Turn the checks off in Settings → Updates and Flint never reaches out for
them again.

---

## Check the download yourself (optional)

You should not have to take anyone's word that the installer is safe. Two ways to
check:

**Scan it.** Upload the `.exe` to [virustotal.com](https://www.virustotal.com), which
runs it past around 70 antivirus engines at once and shows you every result. One
caveat, so a surprise does not alarm you: unsigned installers commonly pick up a hit
or two from obscure engines that flag the free tool used to package the installer as
inherently suspicious. That is a guess about the packaging, not a detection of
anything in the app. If the well known engines are clean, it is clean. If several
major engines flag it, do not run it.

**Check it is the file that was published.** This produces a long code that acts like
a fingerprint for the file: if it matches the one on the release page, nothing
altered the file between the release and your PC. Open a terminal in the download
folder and run:

```
certutil -hashfile Flint-Setup-1.4.5.exe SHA256
```

Compare that against the checksum on the release page. (VirusTotal shows the same
code, so it does both jobs at once.)

The most honest answer is that you never have to trust the installer at all: the
source is all here, and you can build the exact same app from it (below).

## Build it yourself (optional, for the technically inclined)

Most people just download the installer and skip this. But because Flint is unsigned,
you never have to trust that download: the whole source is here, and `npm install &&
npm run dist` builds the same app from code you can read.

**One-time setup:** install Node.js from https://nodejs.org (the "LTS" version,
default options). That is the only tool needed.

Then, in this project folder:

1. Click the File Explorer address bar, type `cmd`, press Enter (a black terminal
   window opens here).
2. Type these two commands, pressing Enter after each. The first fetches the build
   tools (this needs internet; the *built app* itself never does), the second builds
   the installer. Each can take a few minutes:

   ```
   npm install
   npm run dist
   ```

3. When it finishes, the installer is at:

   ```
   dist\Flint-Setup-1.4.5.exe
   ```

To run Flint **without building or installing anything at all** (this is also the way
past Smart App Control, since nothing is installed), run `npm start` in place of `npm
run dist`: after `npm install`, `npm start` launches Flint straight from the source.

---

Coded by Claude Opus 4.8.
