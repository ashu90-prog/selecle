# selecle: the whole story

> One document with everything about selecle: what it is, how it is built, every feature and
> command, the decisions behind it, how it was built day by day, what is published, what is
> known to be weak, and what is next. Written 2026-11-06, after the third build day.
> The day-to-day detail lives in `Memory/` (Changelog, Decisions, conversations, Active_Context),
> which is kept on the author's machine and not published;
> this file is the map.

---

## Contents

1. [What selecle is](#1-what-selecle-is)
2. [Why it exists: the hackathon](#2-why-it-exists-the-hackathon)
3. [The Frankenstein case](#3-the-frankenstein-case)
4. [How to install and start](#4-how-to-install-and-start)
5. [Everything you can do: features and commands](#5-everything-you-can-do-features-and-commands)
6. [How it works: architecture](#6-how-it-works-architecture)
7. [Source map: every file](#7-source-map-every-file)
8. [Security and safety](#8-security-and-safety)
9. [Decisions (ADR-001 to ADR-025)](#9-decisions-adr-001-to-adr-025)
10. [How it was built: the conversation, day by day](#10-how-it-was-built-the-conversation-day-by-day)
11. [Publishing to npm](#11-publishing-to-npm)
12. [Testing](#12-testing)
13. [Known limits and honest gaps](#13-known-limits-and-honest-gaps)
14. [Open items and next steps](#14-open-items-and-next-steps)
15. [Working rules for this project](#15-working-rules-for-this-project)
16. [Glossary](#16-glossary)

---

## 1. What selecle is

**selecle** ("select and execute", said like a spooky "sell-eck-ul") is a haunted, shared, multiplayer
coding workspace that lives entirely in a terminal.

- You open a project folder in selecle. The screen shows the **file tree**, **the Crypt** (a common
  AI agent you talk to), the **coven** (chat with friends) and **the restless** (the spirits at work).
- You talk to the Crypt in plain words. It answers, and when there is work it raises **spirits**:
  headless AI coding agents that each do one small task.
- Each spirit works in its own **git worktree** (a "grave") on its own branch, and its work is
  merged back through a queue. Git is the database of the whole thing.
- Friends join your crypt over **Telnet** (any Telnet client works) or through a **web address**
  (`selecle join https://...`). They chat, watch spirits work, raise their own spirits, edit files,
  and can even bring **their own AI subscription**.
- The Crypt remembers everything in an **append-only event log**, which you can scroll back
  through with a **time machine** and which follows you to your other devices, **encrypted**.
- It looks like a game: pixel-art avatars and portraits, animations, mouse support, overlay windows.

It is a Node.js program with **no dependencies**, published on npm as **`selecle-cli`** (the command
is `selecle`).

---

## 2. Why it exists: the hackathon

- **Event:** Kiroween (Devpost). Deadline believed to be 2026-12-04; **the official 2026 rules
  have not been read yet** (open item).
- **Track:** **Frankenstein**: "Stitch together a chimera of technologies into one app. Bring
  together seemingly incompatible elements to build something unexpectedly powerful."
- **Kiro:** the hackathon is run around Kiro (AWS's AI IDE / CLI). Judges score Kiro use. So far
  Kiro is supported as an *agent* inside selecle, but the project has **not** been built with Kiro
  yet. Fabricated Kiro evidence was requested twice and declined twice (ADR-021): it would mislead
  the judges and risk disqualification. Real Kiro use is an open item.
- The project was started 2026-11-02 after a strategy session that chose "Idea #1: Telnet +
  Git-as-database + multi-agent terminal" (ADR-006).

---

## 3. The Frankenstein case

On 2026-11-06 the user worried that selecle is "just a multiplayer coding environment". The answer
recorded here: *what it does* is multiplayer coding; *what it is made of* is the chimera, and the
pitch has to say so.

| Stitched together | Why it does not belong together |
|---|---|
| **Telnet (RFC 854, 1969)** + **AI coding agents (2026)** | Friends direct modern AI agents through a protocol older than the internet. |
| **Telnet inside WebSocket inside HTTPS tunnels** | The same door speaks a 1969 byte stream and a modern web socket, through Cloudflare or GitHub Codespaces. |
| **Kiro CLI as the engine of a Telnet MUD** | Every spirit and the Crypt itself are headless Kiro CLI runs (`kiro-cli chat --no-interactive`) on their owner's Kiro account. Claude Code and Antigravity CLI remain as hidden alternates (`--agent`, `SELECLE_AGENTS=all`), so rival vendors can still share one room when asked for. |
| **Git as a database, message log, time machine and encrypted sync** | Worktrees as graves, custom refs as memory, sealed commits as a sync channel. |
| **A terminal pretending to be a game** | Half-block pixel art, animated portraits, mouse, overlay windows, all in text. |

**Pitch line drafted:** *"selecle drags three rival AI companies' agents into one haunted room,
reached through a protocol from 1969, with git as its graveyard."*

**Ideas to make it unmistakable** (not built): a 90-second demo video; a visible spirit "species"
per AI vendor; real Kiro use (specs, steering, hooks) done in Kiro itself.

---

## 4. How to install and start

```
npm install -g selecle-cli      # Node 18 or newer
selecle                         # in a project folder
```

- **First run:** a **welcome page** asks for your ID card (name, avatar, colour, title, status,
  about, card style) and shows the agent CLI it runs on: **Kiro CLI** (primary; Claude Code and
  Antigravity CLI are hidden, see ADR-026). `selecle onboard` shows it again.
- **Launch assistant:** checks you are signed in to your agent (or offers free pretend agents with
  `--mock`) and that the folder is a safe git project (it will not quietly turn your home folder or
  a drive root into a git repo; it offers a practice project instead).
- **Quick start guide:** opens by itself the first time; `/guide` brings it back; `selecle guide`
  prints it.

Command line:

| Command | What it does |
|---|---|
| `selecle [folder]` | open a folder (the normal way) |
| `selecle host [folder]` | run a headless server for friends |
| `selecle join <address>` | join a crypt (`selecle://ip:port/ROOM`, `https://.../ROOM`, or a host) |
| `selecle login / logout / whoami` | sign in to your chosen agent CLI / see your profile |
| `selecle onboard` | the welcome page again |
| `selecle pair [code]` | link another device of yours (sealed history sync) |
| `selecle sync`, `selecle autosync on/off/status` | history sync between devices |
| `selecle soul [id]` | show or adopt your soul id |
| `selecle guide` | print the quick start |
| flags | `--mock` pretend agents · `--real` · `--name` · `--port` · `--code` · `--no-guest-summon` · hidden: `--agent kiro|claude|antigravity` (listed in `--help` with `SELECLE_AGENTS=all`) |

---

## 5. Everything you can do: features and commands

### Kiro inside (ADR-027)
- Ask for a feature and the **Scribe** (a Kiro agent limited to `.kiro/specs/`) writes a Kiro spec:
  requirements (EARS), design, tasks. Review it, say "build it" (or `/spec build <name>`), and spirits
  build it one task at a time, each merged before the next, each ticking its task. `/spec` lists specs.
- Spirits are **Kiro custom agents** with roles: builder, tester (tests only), chronicler (docs only),
  scribe (specs only); the Crypt is `selecle-crypt` with no tools. Installed into `~/.kiro/agents/`.
- **The séance** (`selecle mcp`): an MCP server every spirit gets: `room`, `deeds`, `spec`, `whisper`.
- The project's **steering** guides the Crypt and every spirit. `/kiro` / `selecle kiro` show it all.

### Talking and spirits
- Type anything: talk to **the Crypt**. Replies come in **clean short paragraphs** and are written
  out word by word in the live app; while it thinks, a line cycles phrases ("consults the bones...").
- `/summon <task>` raises a spirit directly (`;` separates several). `/banish <name|all>`.
- Spirits show as **pixel cards** in "the restless" panel (newest keep their cards when space is
  short, older ones shrink to one line).
- `/feed` (or `/activity`): every spirit ever raised: who, how it ended, time, cost, files.
- `/replay`: the **time machine**: scrub through the session, play it, and branch git from a
  sealed moment.
- `/history`: latest commits.

### The prompt line
- Arrows move inside it, Home/End (Ctrl+A/Ctrl+E) jump, Ctrl+arrows jump words, Backspace/Delete
  on either side, Up/Down bring back lines you sent. `/` opens the command list, `@` the file picker.

### You
- `/settings` or `/me`: your **ID card** and settings window (Account and Preferences tabs).
  24 animated pixel avatars with a picker, colours, titles, statuses, card styles, an about line,
  and the **Agent** row (change it, then a green **Restart selecle** button appears).
- `/name`, `/avatar`, `/color`, `/title`, `/status`, `/about` change single fields.
- Preferences: animations, Crypt reply style (brief/balanced/detailed), bell.

### Files and editors
- File tree: Enter on a folder goes in, **Enter again** opens it in your **code editor**; Enter on a
  file opens it; **double-tap empty space** opens the whole project in your editor as a workspace.
- `/code`: open the whole project in VS Code / Cursor / Windsurf / Kiro / Sublime (first found);
  a `.code-workspace` file is written inside `.selecle/`.
- `/open <file>`: in your real editor. `/edit <file>`: in selecle's own small editor (Ctrl+S saves).
- `/open <folder path>`: opens that folder as the project (absolute, `~/...`, relative, quotes allowed); a file outside the project opens its git project. A folder that is not a git project is made one (git init + first commit). Home folders and drive roots are refused. Host only.
- Whatever folder selecle is started in opens directly as a git project, without a question; only a big or personal folder (home, a drive, 300+ items) is still asked about.
- `/run <command>`: run something in the project and watch the output (Ctrl+C stops it).
- `/folder`: a folder browser to switch to another project (files listed too).
- The file tree follows changes made outside selecle (editor saves, builds, friends).

### Friends (multiplayer)
- `/invite` (also `/host`, `/server`): opens the door and shows the join command **on one line in
  an "Invite a friend" window** (c copies; also copied to the clipboard). In a GitHub Codespace the
  command uses the Codespace's own web address.
- `/invite public`: opens a **public https address** through a tunnel (Cloudflare `cloudflared`
  first, else localhost.run over `ssh`). `/invite private` closes only that; `/invite stop` closes all.
- `/pair <join code>` from inside selecle joins a friend's crypt. `/copy` shows the command again.
- Host controls (`/invite ...` or typed in a `selecle host` window):
  - `who` · `kick <name>`
  - `allow <name>` / `deny <name>` / `summon on|off`: who may raise spirits on the host's account
  - `trust <name>` / `untrust <name>`: who may open, edit and run things on the host's computer
  - `trust everyone` / `untrust everyone`: everyone, now and later, every permission
  - `diffai on|off`: **own-AI mode**: friends' spirits run on *their own* AI subscription and
    computer; the Crypt keeps running on the host's account
- **Friends arrive as themselves**: name and ID card from their own profile (not asked again).
- **Friends in their own code editor**: a trusted friend types `/code`; their selecle makes a copy
  of the project at `~/selecle-work/<project>`, opens their editor, and keeps it in step both ways
  (their saves go to the host, host changes come down; on a double edit the host wins and the
  friend's version is kept in `.selecle-conflicts/`).
- In own-AI mode a friend's `/settings` has an Agent row that switches their agent live.

### Devices
- The Crypt's memory (the event log) follows you between your devices **automatically and
  encrypted** through your git remote. `/pair` (or `selecle pair`) once per new device.
- `/sync` syncs now. Footer shows the sync state.

---

## 6. How it works: architecture

```
              ┌───────────────────────── one terminal ─────────────────────────┐
  keys ──▶ app.js (state, keys, commands) ──▶ render.js ──▶ ANSI frame ──▶ screen
              │        │          │                 overlays: dialog, feed, replay,
              │        │          │                 guide, bench, folders, share
              │        │          └─ crypt.js  (the Crypt: prompt → plan {reply, summon, banish})
              │        └─ npc/roster.js + npc/engines.js (spirits: one CLI process each)
              │                     └─ git.js: worktree "grave" per spirit → merge queue
              └─ context.js: append-only event log .selecle/crypt.jsonl (+ refs/crypt/context)
                              └─ sync.js + vault.js: sealed copy on refs/crypt/sync ⇄ git remote

  friends ──▶ telnet.js door (one port) ──┬─ Telnet (RFC 854: echo, SGA, NAWS)
                                         └─ HTTP → WebSocket (ws.js) ← https tunnels (tunnel.js)
              each friend = their own app.js session rendered to their screen
              + mirror.js / remote.js messages (OSC 7777) inside the same byte stream:
                  their editor copy, their own-AI spirits
```

Key ideas:

- **Event log as the shared brain.** Every whisper, friend message, spirit, deed and profile change
  is one JSON line in `.selecle/crypt.jsonl`. All sessions on a project (local windows and friends
  on the door) read and append the same file, which is mirrored to the git ref
  `refs/crypt/context` so it survives deletion.
- **Git as database.** Spirits get worktrees on `spirit/*` branches; finished work is committed and
  merged one at a time; clashes stay on their branch and are reported. Deeds record sha and files.
- **Sealed sync.** Each event is encrypted with AES-256-GCM (deterministic nonce from key + event
  id), stored on `refs/crypt/sync`, merged by event id, pushed after changes and polled every ~10 s.
  The key never enters git; a pairing code (`selecle1.` + base64url) carries it to a new device.
- **The Crypt** is a prompt with the whole picture (people, spirits, ledger, memory, private chat,
  coordination hints) and returns a JSON plan. On Claude it uses structured output; on Antigravity
  and Kiro it is asked for JSON and the answer is searched for it (and told it has no tools).
- **Kiro CLI first, two hidden alternates.** `auth.js` holds one provider entry each (status, login,
  logout, binary); Kiro is `DEFAULT_PROVIDER` and the only one in `shownProviders()` unless
  `SELECLE_AGENTS=all`. Kiro: `whoami --format json` (plain `whoami` on older builds, `KIRO_API_KEY`
  accepted), spirits run `chat --no-interactive --wrap never --trust-tools=read,write,glob,grep`, the
  Crypt gets its prompt on stdin with no tools trusted. Antigravity's real stream-json output was
  captured and parsed; Kiro's is from documentation plus a stand-in kiro-cli (see the spec in
  `.kiro/specs/kiro-cli-primary-agent/`).
- **One door, two protocols.** The door waits 0.2 s: a request that starts with letters is HTTP
  (WebSocket upgrade or a landing page); control bytes or silence is Telnet.
- **Messages inside the screen stream.** `mirror.js` wraps control messages as invisible OSC 7777
  escape sequences, so file sync and own-AI work travel over Telnet and WebSocket unchanged.

---

## 7. Source map: every file

**bin/selecle.js**: the command line: parses commands and flags, the welcome page, launch assistant,
sign-in, and starts the app, host, join, pair, sync and so on.

**src/** (about 8,200 lines in total):

| File | Role |
|---|---|
| `app.js` | the heart: state, keys and mouse, commands, sessions (`startSession`, `run`), the Crypt loop |
| `render.js` | draws the whole screen; panels, chat, input line, spirit cards, overlays, reply reveal |
| `crypt.js` | the Crypt's prompt and voices (Claude, Antigravity, Kiro, mock) |
| `npc/engines.js`, `npc/roster.js` | spirit engines per CLI (and mock); the roster of spirits |
| `context.js` | the event log store, identities, presence |
| `git.js` | repo setup, graves (worktrees), merge queue, context and sync refs, git error help |
| `sync.js`, `vault.js` | sealed history sync, keys, pairing codes |
| `auth.js` | the three providers, sign-in status, current provider |
| `profile.js` | the profile file, ID card fields, editing, onboarding check |
| `onboard.js` | the first-run welcome page |
| `start.js` | the launch assistant (safe folder, practice project) |
| `telnet.js` | the door: Telnet server and client, WebSocket routing, host controls, guard, ID cards |
| `ws.js` | WebSocket (RFC 6455): frames, handshake, server and client, landing page |
| `invite.js` | /invite in the app: start/stop the door, join codes, public address |
| `tunnel.js` | public address through Cloudflare or localhost.run |
| `mirror.js` | control envelope, project scan, friend's synced copy (host and friend sides) |
| `remote.js` | host and friend sides of copy sync and own-AI spirits |
| `access.js`, `bench.js` | safe file access and command runner; the built-in editor/runner window |
| `editor.js` | opens a real code editor (and the workspace file) |
| `folders.js` | the folder browser |
| `share.js` | the "Invite a friend" one-line command window |
| `dialog.js`, `portraits.js`, `avatars.js` | settings window and avatar picker; portraits; spirit sprites |
| `feed.js`, `ledger.js`, `replay.js`, `timemachine.js` | activity feed, deeds, time machine |
| `guide.js` | the quick start tour |
| `palette.js`, `toolkit.js` | the `/` and `@` suggestion lists, ready-made prompts |
| `format.js` | chat formatting: paragraphs, bullets, code boxes |
| `tree.js`, `vines.js` | file tree, pixel vines |
| `banner.js`, `theme.js`, `ansi.js` | banner art, colours, ANSI helpers |

**test/**: 24 files, 333 tests (`npm test`).

**Memory/**: `Active_Context.md` (state), `Changelog.md` (every change), `Decisions.md` (ADRs),
`conversations.md` (session logs), `Build_Plan.md`, `Ideas.md`.

---

## 8. Security and safety

- **Credentials:** selecle never reads or stores agent credentials; it asks the CLI who is signed
  in. The profile keeps only a hash of the email.
- **Secrets stay local:** room codes, pairing codes, join codes and `/run`, `/open`, `/pair` command
  lines are never written to the shared history.
- **The door:** room code (word + 3 digits, cryptographic random); 3 tries per connection; 8 wrong
  codes per minute across all connections lock the door for a minute. Public addresses are only
  opened when asked (`/invite public`).
- **Friends' permissions** default to chat only. Summoning on the host's account needs `allow`;
  files, running things, the editor copy and own-AI spirits need `trust`; checked on every message,
  so taking trust back stops everything at once.
- **File access** (`access.js`): paths stay inside the project (no `..`, absolute paths, drive
  letters, symlink escapes); `.git` and `.selecle` are off limits (including Windows tricks);
  size limits; friends' commands do not inherit the host's tokens and keys.
- **Honest risk:** a trusted friend can run any command as the host's user. There is no sandbox.
  Trust only people you would hand your keyboard to.
- **Safe launch:** selecle will not quietly `git init` a home folder, drive root or huge folder.

---

## 9. Decisions (ADR-001 to ADR-025)

Full text in `Memory/Decisions.md`.

| ADR | Decision |
|---|---|
| 001 | Kiroween hackathon, Frankenstein track |
| 002 | A fresh project, not a fork of an older codebase |
| 003 | A custom agentic core stitched with incompatible technologies |
| 004 | Persistent multi-agent memory in `Memory/` |
| 005 | Multi-tool workflow (Antigravity + Kiro + Claude Code) |
| 006 | Idea #1: Telnet + git-as-database + multi-agent terminal |
| 007 | Shared context as an event log |
| 008 | Telnet joining model |
| 009 | Sign-in means the agent CLI is signed in |
| 010 | Account settings and the Crypt's ledger of deeds |
| 011 | Settings overlay window and prompt toolkit |
| 012 | Pixel avatars, home theme, suggestion popups |
| 013 | One prompt toolkit and pixel vines |
| 014 | Activity feed and time machine over the event log |
| 015 | History between devices through git (partly superseded) |
| 016 | Automatic, sealed history sync |
| 017 | Global command, safe first launch, in-app quick start |
| 018 | /invite and /pair inside the app |
| 019 | Hands-on project access for trusted guests |
| 020 | Opening things in a real code editor |
| 021 | No fabricated Kiro evidence |
| 022 | Three agent CLIs, chosen on a first-run welcome page |
| 023 | Web-address joining over WebSocket |
| 024 | Public address by tunnel, on demand |
| 025 | Friends edit in their own editor on a synced copy, and may bring their own AI |
| 026 | Kiro CLI is the primary agent; Claude Code and Antigravity are hidden |
| 027 | Kiro-native spirits: specs first, agents with roles, the séance MCP server, steering |

Later refinements recorded in the changelog: the restart button (ADR-022), the Crypt staying on
the host in own-AI mode (ADR-025), `trust everyone`.

---

## 10. How it was built: the conversation, day by day

### 2026-11-02: strategy
Kiroween chosen, Frankenstein track, multi-tool plan, Idea #1 picked. Memory structure set up.

### 2026-11-03 to 11-04: from research to a working selecle
- TUI (tree, spirits, Crypt chat, coven chat, banner, splash, pixel avatars, mouse).
- Spirits as headless Claude Code; the Crypt as a common agent with structured output.
- Shared event log; git as database (graves, merge queue); Telnet host and join with room codes.
- Bugs fixed while the user tested: PowerShell-only commands, a leftover mock setting, broken join
  screen lines, old chat reappearing, a phantom "ana" window.
- First request for fake Kiro evidence: declined; real use proposed.

### 2026-11-04 (later): polish day
Claude CLI sign-in and profiles; account settings and the Crypt's ledger; settings overlay with ID
card; 24 animated avatars and picker; home theme; `/` and `@` popups; pixel vines (then trimmed);
activity feed; time machine with git branch; automatic encrypted cross-device memory sync with a
pairing code; the global `selecle` command; a safe launch assistant; a 9-step quick start.
Incident: an interrupted first run left an empty repo with a stale `index.lock` in the home folder:
fixed so empty repos in big folders get the same safety questions, and lock errors explain the fix.

### 2026-11-05: invite, pair, workbench, folders, editors
- `/invite`, `/host`, `/server`, `/pair` in the app; join codes `selecle://ip:port/ROOM` with
  name and code answered automatically.
- The Frankenstein question asked; the answer: strong chimera, story and Kiro use are the gaps.
- Trusted guests get hands-on access: built-in editor (`/edit`), runner (`/run`), `/code`.
- Spirits keep their avatars when several are summoned (they used to collapse into a list).
- Folder browser; then files listed; then a real code editor for the whole project (workspace
  file) and single files; then simpler tap gestures in the file tree.
- How five friends with their own subscriptions would work: explained (later built, see 11-06).
- Fake Kiro evidence asked for again: declined again (ADR-021).

### 2026-11-06: agents, the internet, friends' editors and own AI
- **Three agent CLIs** and the **welcome page**; Agent row in settings; restart button.
- **npm:** first publish attempts blocked by the account's one-time password and a staged-only
  token; the name `selecle` refused as too similar to `select2`, so the package is `selecle-cli`.
  0.1.0 needed an approval step; later versions published directly.
- **GitHub Codespaces testing:** private addresses (10.0.1.100) do not work across networks;
  `gh codespace ports forward` explained; Tailscale explained; then a better way built:
  **web-address joining over WebSocket**, the Codespace address detected by itself, and the
  **copy box**. Errors found by the user and fixed: a wrapped join command copied in half
  (fixed with the one-line "Invite a friend" window), typos accepted as addresses, and the Crypt
  on Antigravity refusing to answer because it reached for a tool.
- **`/invite public`** through Cloudflare or localhost.run, stronger room codes and a lock-out;
  the first real run picked `admin.localhost.run` (the account page) and was fixed; localhost.run
  then dropped the connection from a Codespace ("tunnel activity timeout"), so installing
  `cloudflared` was recommended there.
- **Friends' own code editor** (synced copy) and **own-AI mode** (`/invite diffai`), then fixes:
  `diffai` was not passed through by `/invite`; friends were asked their name every time and
  arrived with a default look; friends could not change their agent while inside.
- **UX day-end:** the editable prompt line, replies in clean paragraphs written out word by word,
  a livelier thinking line, `trust everyone`, the Crypt kept on the host in own-AI mode, and a fix
  for big files cutting web connections.
- The user felt the project was "just a multiplayer coding environment" and not Frankenstein
  enough: the reframing in section 3 was written.
- End of day: 333 tests passing, `selecle-cli@0.1.6` published (download was still processing).

---

## 11. Publishing to npm

- Package: **`selecle-cli`** (MIT, licence holder written as "selecle contributors"). Command:
  `selecle`. Files shipped: `bin`, `src`, `assets/banner.json`, `README.md`, `LICENSE`
  (about 150 kB). Without that list it would have shipped the `Memory/` notes and chat logs.
- Versions: 0.1.0 (first), 0.1.1 (web joining, copy box), 0.1.2 (`/invite public`), 0.1.3 (one-line
  share window, relay address fix), 0.1.4 (friends' editor copy, own AI), 0.1.5 (`diffai` pass-through),
  0.1.6 (friends' ID cards, live agent switch, prompt editing, paragraphs, trust everyone,
  large-file fix).
- After publishing, npm sometimes needs minutes (once longer) before the download works;
  `npm cache clean --force` and retrying helps.
- Tokens were pasted into the chat; they should all be **revoked** on npmjs.com. Publishing only
  happens when the user asks in that message (the permission system blocks it otherwise).
- To publish yourself: bump `version` in `package.json`, `npm test`, then
  `npm publish --access public` (with `--otp=<code>` if your account asks).

---

## 12. Testing

- `npm test` runs 333 tests in 24 files (about 4 to 7 minutes).
- Real things are tested with real processes where possible: git repos, Telnet and WebSocket doors
  on localhost, the join client, CLI engines driven by stand-in processes, a real Antigravity
  spirit once (manually).
- Not reachable from the build machine: real public tunnels (blocked as external ingress), real
  Kiro CLI (not installed), friends' real editors and agents, real Codespaces from outside.

---

## 13. Known limits and honest gaps

- **Kiro CLI** is verified against a real 3.2.1 install (spec flow, roles, séance, steering). The
  stream-json event shapes and agent behaviour may change in later Kiro versions.
- **Spec tasks run one at a time**, so a long spec is slow; a task that merges nothing pauses the build.
- **The séance on a guest's machine** (own-AI mode) sees only the guest's copy, not the room's log.
- **Antigravity** has no sign-in check (installed means go ahead).
- **Public tunnels** were never run from the build machine; localhost.run dropped a Codespace
  connection; Cloudflare's path is untested for real.
- **Own-AI spirits** write straight into the host's project through the sync, without their own
  git branch or the merge queue.
- **Editor copy sync** polls every second; very large projects are capped (2,000 files, 10 MB,
  1 MB per file).
- **No sandbox** for trusted friends.
- **Cost** is not reported for Antigravity or Kiro spirits.
- **Interactive flows** (welcome page, restart, folder switching) were tested with stand-ins, not
  driven in a real terminal by the builder.
- **The official 2026 hackathon rules** have not been read.
- **Kiro use while building selecle** is still thin: selecle uses Kiro deeply, but this repo's own specs
  are hand-written by Claude Code (ADR-021). Next: build a selecle feature through its own Scribe.

---

## 14. Open items and next steps

For the user:
- Revoke the npm tokens pasted in chat. Delete the stray empty `.git` in the home folder if still there.
- Try 0.1.6 end to end: `/invite public` (install `cloudflared` in the Codespace), a friend joining
  by web address, `/code` on the friend's side, `/invite diffai on`.
- Read the official Kiroween 2026 rules and judging criteria.
- Do real work in Kiro (specs, steering, hooks) so Kiro use is genuine.

Ideas already discussed (not built):
- A spirit "species" per AI vendor (visible Frankenstein).
- A 90-second demo video; a Devpost write-up around "rival AIs stitched together".
- The host's model serving everyone (the user's later idea).
- Each friend fully on their own machine with git carrying changes (beyond the synced copy).
- Browser terminal for guests; TLS of our own; hardening (orphaned worktrees); diff viewer in the feed.
- User plans "countless new features" on 2026-11-07.

---

## 15. Working rules for this project

- Read `Memory/Active_Context.md` before work; respect `Memory/Decisions.md`.
- Every change gets an entry in `Memory/Changelog.md` (newest first under `[Unreleased]`).
- Kiro files in `.kiro/` must come from real Kiro use (ADR-021).
- Files are CRLF on Windows; patch scripts keep line endings.
- Use PowerShell or Windows Terminal for the app (Git Bash has no real terminal for Node).

---

## 16. Glossary

| Word | Meaning |
|---|---|
| **Crypt** | the common AI agent everyone talks to; also a project opened in selecle |
| **spirit** | a headless AI coding agent doing one task |
| **grave** | a spirit's git worktree on a `spirit/*` branch |
| **deed** | a ledger record of a spirit being raised and how it ended |
| **coven** | the friends' chat |
| **the restless** | the panel showing spirits at work |
| **door** | the host's server that friends join |
| **room code** | the word + digits a friend needs to enter |
| **join code** | the address + room code in one (`selecle://...` or `https://.../ROOM`) |
| **soul id** | your identity in the shared history across devices |
| **pairing code** | `selecle1....`: carries the sync key to another of your devices |
| **trust / allow** | permission for files and running things / for summoning on the host's account |
| **own-AI mode** | `/invite diffai on`: friends' spirits on their own subscription |
