# selecle

You know that feeling when you and a friend both have an AI open, both ask it to "fix the login
page", and an hour later you're untangling two versions of the same file? selecle is what we
built so that stops happening.

It's one shared room in your terminal. You and your friends sit in it together, and so do the
AI helpers, which we call spirits. You talk to the Crypt, the room's main AI, in plain words. It
sends a spirit off to do the job, every spirit works on its own git branch, and when it's done
its work gets merged in for everyone to see. Nobody's changes vanish, and you can always see
who did what.

We made it for the Kiroween hackathon, in the Frankenstein track, so it's a deliberately strange
mix of parts that shouldn't fit together: a Telnet server written by hand from the 1983 spec,
git used as the database, pixel-art spooky characters drawn in the terminal, and
[Kiro CLI](https://kiro.dev/cli) agents doing the actual work. It's all one Node app with zero
dependencies.

![The selecle workspace: file tree, spirits at work, and the Crypt chat](docs/screenshots/workspace.png)

| | |
|---|---|
| ![The Crypt raising a spirit](docs/screenshots/crypt.png) | ![The quick start guide](docs/screenshots/welcome.png) |
| Ask the Crypt; it raises a spirit, and the work is sealed into git | A built-in guide shows you around |
| ![Two friends in one project](docs/screenshots/multiplayer.png) | ![The time machine](docs/screenshots/replay.png) |
| Friends join one project from any terminal | `/replay`: step through every spirit's deed, branch from any point |
| ![Your ID card](docs/screenshots/settings.png) | |
| `/settings`: pixel avatar ID card, running on Kiro CLI | |

## Quick start

```
npm install -g selecle-cli     # Node 18 or newer
kiro-cli login                 # or: selecle login
selecle init                   # optional: makes it a git project + the Kiro kit for your own Kiro
selecle                        # in any project folder
```

No Kiro CLI yet? selecle's tools page installs it (or: `irm https://cli.kiro.dev/install.ps1 | iex`
on Windows, `curl -fsSL https://cli.kiro.dev/install | bash` on macOS and Linux). To look around
without an account, run `selecle --mock` for free pretend agents.

## Kiro inside

Underneath the ghosts, selecle is really a way for a group of people to work the way Kiro likes
to work, together:

- **We plan before we build.** If you ask for something bigger than a quick fix, like "add a dark
  mode toggle", the Crypt doesn't go straight to writing code. It hands the job to the
  **Scribe**, a Kiro agent that's only allowed to write in `.kiro/specs/`. The Scribe reads your
  project and writes a real Kiro spec: `requirements.md` (user stories, EARS acceptance criteria),
  `design.md` and `tasks.md`. The spec opens right there in the file list, and anyone in the room
  can read it or change it. When you're happy, say "build it" (or `/spec build <name>`). Spirits
  then build it **one task at a time**: each gets its own git branch, each task is merged before
  the next one starts, and each spirit ticks its task off in `tasks.md` when it's done.
- **Every spirit has a job, and only the permissions for that job.** `selecle-builder` writes
  code. `selecle-tester` can only touch tests, `selecle-chronicler` only docs, and
  `selecle-scribe` only specs. The Crypt itself (`selecle-crypt`) can't touch anything at all; it
  just talks. The Crypt picks the right helper for each job, and in a spec a line like
  `_Spirit: tester_` picks it for that task. They're real Kiro custom agents living in
  `~/.kiro/agents/`, so `kiro-cli agent list` shows them and you can chat with any of them yourself.
- **Spirits aren't working blind.** Each spirit works alone in its own copy of the project, but
  through the séance (`selecle mcp`, our MCP server) it can still look around the room. `room`
  shows who's here and what the other spirits are editing right now, `deeds` shows who changed a
  file and why, `spec` lists the project's specs and tasks, and `whisper` lets a spirit ask you a
  question in the team chat. You can plug it into your own Kiro too:
  `kiro-cli mcp add --name selecle --command selecle --args mcp`.
- **Your rules are everyone's rules.** Whatever you've written in `.kiro/steering/`, the Crypt plans
  with it and every spirit follows it, even the parts you haven't committed yet. Don't have any
  steering yet? `/steering` asks a spirit to write `product.md`, `tech.md` and `structure.md` by
  reading your code.
- **Your own Kiro joins the room too.** `selecle init` (or `/init`) adds `.kiro/settings/mcp.json`
  (the séance), `.kiro/steering/selecle.md` and two hooks. When you open the project in Kiro, it
  starts out knowing who's here and what the spirits are up to. And if your Kiro is about to write
  a file a spirit is in the middle of changing, that write is **paused once** with a warning, so
  you can wait or go ahead knowing what you're doing. Commit `.kiro/` and everyone who opens the
  project in Kiro gets the same thing.

`/spec` lists the specs and their progress, `/kiro` (or `selecle kiro`) shows the agents,
steering, specs and kit. **Full guide: [docs/kiro.md](docs/kiro.md).** In `--mock` mode the whole spec flow is acted out for free: try
`feature: a dark mode toggle`, then `build dark-mode-toggle`.

## Start

```
selecle
```

The first time you open selecle, it walks you through making your ID card: a name, one of 24
little animated avatars, a colour, a title, a status and a line about yourself. It also shows
which AI it runs on, **[Kiro CLI](https://kiro.dev/cli)**. Everything runs on your own Kiro
account through `kiro-cli chat --no-interactive` (we've tested it with Kiro CLI 3.2.1). Sign in
with `selecle login` (which just runs `kiro-cli login`), or set `KIRO_API_KEY` if you're running
it somewhere without a browser. Spirits only ever get Kiro's file tools (`read`, `write`, `glob`,
`grep`) and the séance: they can't run commands, browse the web or touch AWS. While a spirit
works, selecle follows along through Kiro's `--output-format stream-json` events, so you see what
it's doing as it happens. You can change your ID card any time with `/settings`, and
`selecle onboard` brings the welcome page back.

If you'd rather use Claude Code or Antigravity CLI, they still work, they're just tucked away.
`--agent claude` or `--agent antigravity` uses one for a single run, and `SELECLE_AGENTS=all`
brings them back into the welcome page, `/settings` and `--help`. If your saved profile used one
of them, selecle switches it to Kiro on the next start and tells you once.

Next comes a **tools page**. It checks for the things selecle likes to have around (git, your
agent CLI, cloudflared for `/invite public`, a code editor, ssh) and installs anything missing
with one key: winget on Windows, Homebrew on a Mac, a download or apt on Linux. It comes back
whenever something's missing, unless you tell it "don't ask again". `/tools` or `selecle tools`
opens it whenever you like.

Then selecle makes sure you can actually use it (you're signed in, or you've picked the free
pretend agents) and that the folder is safe to work in as a git project. If it isn't, it offers
to make you a small practice project instead. Then the app opens with a short guide that shows
you around. The guide pops up by itself the first time; `/guide` brings it back, and
`selecle guide` prints it as plain text.

Install it from npm (Node 18 or newer):

```
npm install -g selecle-cli
```

Or from a copy of this repo:

```
npm install
npm link          # puts the selecle command on your PATH (undo: npm unlink -g selecle)
```

## Things to type in the app

| Type | What it does |
|---|---|
| anything | talk to the Crypt |
| `/` | every command and ready-made prompt, pick with arrows, Tab, Enter or click |
| `@` | pick a project file to mention |
| `/summon <task>` | raise a spirit (separate several tasks with `;`) |
| `/feed` | every spirit: who, how it ended, time, cost, files |
| `/replay` | time machine: scrub, play, branch from a sealed moment |
| `/me` | your ID card, 24 animated avatars, title, status |
| `/invite` | open the door for friends: shows the room code (`/invite stop`, `who`, `allow <name>`, `kick <name>`) |
| `/open <file>` | open a project file in a small editor (ctrl+s saves); a new name makes a new file |
| `/open <folder>` | open that folder as the project (made a git project if it is not one) |
| `/run <command>` | run a command in the project and watch its output (`npm test`, `node app.js`) |
| `/code` | open the project in VS Code on your computer (host only) |
| `/pair <join code>` | join a friend's crypt (the code their `/invite` showed) |
| `/pair` | show a code that links another device of yours; `/pair selecle1.<code>` uses one |
| `/sync` | sync the Crypt's memory with your other devices now |
| `/guide` | the quick start |

## Friends

The whole point is doing this together, so letting friends in is easy, even when they're
nowhere near your Wi-Fi. Type `/invite public` and selecle opens a tunnel and gives you a public
`https://` address. It goes through Cloudflare if you have `cloudflared`, and otherwise through
localhost.run using the `ssh` you already have. Your friend runs
`selecle join https://that-address/ROOMCODE` and that's it, nothing else to set up. Anyone with
the address and the room code can come in, but the address changes every time, `/invite private`
closes it, and too many wrong room codes lock the door for a minute.

**Friends can work in their own code editor.** Once you trust a friend (`/invite trust <name>`),
they can type `/code`. Their selecle makes a copy of the project on their own computer
(`~/selecle-work/<project>`), opens their editor on it and keeps it in step with yours. Every
file they save comes over to you, and whatever changes on your side goes over to them. If you
both changed the same file, yours wins and theirs is kept safe in `.selecle-conflicts/`. They
need the app for this (`selecle join`), not a plain Telnet window.

**Everyone can bring their own AI.** By default, friends' spirits run on your account. Turn on
`/invite diffai on` and each friend's spirits run on their own computer, with their own agent CLI
and their own subscription, while the Crypt keeps answering on yours (they need your trust and
the app for this). `/invite diffai off` switches back. If you trust the whole group,
`/invite trust everyone` gives everyone in the room, and everyone who joins later, every
permission at once; `/invite untrust everyone` takes it all back.

**The prompt line** behaves the way you'd expect: arrows move inside it, Home and End jump,
Ctrl+arrows jump by word, Delete and Backspace work on either side, and Up and Down bring back
lines you've already sent. To let friends raise spirits on your account, use `/invite allow <name>`
for one person or `/invite summon on` for everyone.

Inside selecle, type `/invite`. It opens the door and shows you the join command in a box, and
it copies it to your clipboard too (`/copy` copies it again). If you're on a GitHub Codespace, or
you've set `SELECLE_PUBLIC_URL` to an ngrok, Cloudflare or dev-tunnel address, that command is a
web address your friend can use from anywhere, with nothing to install:

```
selecle join https://your-codespace-6666.app.github.dev/ROOMCODE
```

(In a Codespace, set the port to Public once: Ports tab, right-click the port, Port Visibility, Public.) On a local network it is a join code like `selecle://192.168.1.9:6666/BATS42`. A friend already in selecle types `/pair selecle://192.168.1.9:6666/BATS42` and lands in your crypt. From a terminal:

```
selecle join selecle://192.168.1.9:6666/BATS42     # or: selecle join, then the room code; any Telnet client works too
```

(`selecle host` still does the same from a terminal, when you want a server with no screen of its own.)
Guests start with chat-only. `/invite allow <name>` lets one raise spirits on your account. `/invite trust <name>` lets one open, edit and run things in the project on your computer; `/invite untrust <name>` takes it back at once. Only trust people you would hand your keyboard to.

You trust the person's computer, not just their name. Every computer running selecle has its
own id, backed by a key that never leaves it, and the host checks it when someone joins. So if
someone else turns up later calling themselves "Eve", they don't get Eve's permissions, and the
real Eve keeps hers even if she changes her name. (`selecle whoami` shows your computer's id.
People joining from a plain Telnet window don't have one, so they're known by name.)

## Another device

Working from your laptop today and your desktop tomorrow? The Crypt's memory comes with you. It
travels through your git remote, locked with a key that never goes into git. You only set it up
once per new device:

```
/pair                        # in the app on the old device: shows a pairing code
/pair <code>                 # in the app on the new device, inside a clone of the project
```

(`selecle pair` and `selecle pair <code>` do the same from a terminal.)

## Useful flags

`--mock` free pretend agents · `--real` real agents · `--name <name>` · `selecle --help` for all.

## Tests

```
npm test
```
