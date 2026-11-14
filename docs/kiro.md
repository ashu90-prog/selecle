# selecle + Kiro

selecle is a shared terminal room where friends and AI spirits build one project together. Every
spirit is a [Kiro CLI](https://kiro.dev/cli) agent, every bigger feature starts as a Kiro spec, and
the people's own Kiro can see the room too.

Tested with Kiro CLI 3.2.1.

- [Getting started](#getting-started)
- [Specs: plan first, then build](#specs-plan-first-then-build)
- [Spirits are Kiro agents](#spirits-are-kiro-agents)
- [The séance (MCP server)](#the-séance-mcp-server)
- [The Kiro kit for your project](#the-kiro-kit-for-your-project)
- [Steering](#steering)
- [Command reference](#command-reference)
- [Troubleshooting](#troubleshooting)

---

## Getting started

```
npm install -g selecle-cli
kiro-cli login
cd your-project
selecle init        # the Kiro kit: your own Kiro gets the room (optional, recommended)
selecle             # open the room
```

No Kiro account? `selecle --mock` acts everything out with pretend agents, for free.

---

## Specs: plan first, then build

Ask the Crypt (selecle's common agent) for something bigger than a quick fix:

```
add a dark mode toggle to the settings page
```

1. **The Scribe writes a spec.** The Crypt raises the Scribe, a Kiro agent that may only write in
   `.kiro/specs/`. It reads your project, then writes:
   - `requirements.md`: user stories with EARS acceptance criteria (`WHEN … THEN … SHALL …`)
   - `design.md`: overview, architecture, components, data, errors, testing
   - `tasks.md`: 3 to 8 tasks in build order
2. **You review it.** The file list opens the spec. Anyone in the room can read and edit it.
3. **You approve it.** Say "build it", or type `/spec build dark-mode-toggle`.
4. **Spirits build it, one task at a time.** Each task gets its own spirit and its own git branch,
   and is merged before the next task starts. Each spirit ticks its task (`- [x] 2.`) when done.

If a task fails or its merge clashes, the build pauses: `/spec build <name>` carries on from the
first unticked task.

**Picking the spirit for a task.** Add a line under a task in `tasks.md`:

```markdown
- [ ] 3. Test the toggle
  - _Spirit: tester_
```

Tasks titled plainly as tests ("Write tests for …") or docs ("Update the README") get a tester or
chronicler on their own.

| Command | What it does |
|---|---|
| `/spec` | every spec, its requirements, and how many tasks are done |
| `/spec <feature>` | the Scribe writes a spec (name taken from the first words) |
| `/spec <name>: <feature>` | the same, with your own name |
| `/spec build <name>` | build its unticked tasks, in order |

---

## Spirits are Kiro agents

selecle installs these [custom agents](https://kiro.dev/docs/custom-agents/) into `~/.kiro/agents/`.
`kiro-cli agent list` shows them, and you can chat with any of them yourself
(`kiro-cli chat --agent selecle-tester`).

| Agent | Job | May write |
|---|---|---|
| `selecle-builder` | writes and edits code | anything in its worktree |
| `selecle-tester` | writes tests | test files, and ticking its spec task |
| `selecle-chronicler` | writes docs | Markdown and text files, `docs/` |
| `selecle-scribe` | writes Kiro specs | `.kiro/specs/**` only |
| `selecle-crypt` | the Crypt: plans and talks | nothing (no tools) |

No spirit can run shell commands, browse the web or use AWS. Each one:

- works in its own git worktree on a `spirit/*` branch, so your files are never half-edited;
- loads your `.kiro/steering/**/*.md` and `AGENTS.md`;
- has the séance MCP server, to see the rest of the room.

The Crypt chooses the role for each job. Agents are rewritten only when selecle's own version of
them changes. Set `SELECLE_KIRO_AGENTS=0` to run spirits as plain Kiro with file tools instead.

---

## The séance (MCP server)

`selecle mcp` is a Model Context Protocol server (stdio). Every spirit has it, and the
[Kiro kit](#the-kiro-kit-for-your-project) gives it to your own Kiro too.

| Tool | Returns |
|---|---|
| `room` | who has the room open, which spirits are working (task, action, file, role), the latest team chat |
| `deeds` | finished spirit work: who, which task, how it ended, files, commit. `file` narrows it to one file |
| `spec` | every spec with progress; `name` gives one spec's task list |
| `whisper` | says one line in the team chat as the spirit (at most twice per task) |

Private talk with the Crypt is never exposed. The server finds the room from `SELECLE_PROJECT`, or
from the git worktree it starts in.

---

## The Kiro kit for your project

`selecle init` (or `/init` in the room) adds three files, so anyone who opens the project in Kiro
(IDE or CLI) works *with* the room:

| File | What it does |
|---|---|
| `.kiro/settings/mcp.json` | registers the séance as server `selecle` (`room`, `deeds`, `spec` auto-approved) |
| `.kiro/steering/selecle.md` | tells Kiro how to work next to spirits (`inclusion: always`) |
| `.kiro/hooks/selecle.json` | two hooks: the room at session start, and the clash guard |

**Hooks**

| Hook | Trigger | Runs | Effect |
|---|---|---|---|
| who is in the room | `SessionStart` | `selecle room` | Kiro starts the session knowing who is here and what the spirits are doing |
| clash guard | `PreToolUse`, matcher `write` | `selecle room --guard` | if a spirit is working on that file, the write is **paused once** with a warning; Kiro tells you and asks. Trying again goes through |

Commit `.kiro/` so your friends get it. Running `selecle init` again changes nothing; your own MCP
servers are kept, and your own `selecle.md` or `selecle.json` are kept unless you pass `--force`.
`selecle` must be on the PATH (`npm install -g selecle-cli`).

Why "paused once": in Kiro CLI, a pre-tool hook's message reaches Kiro only when the hook blocks the
call. A one-time pause is the gentlest way to make sure Kiro (and you) hear about the clash.

---

## Steering

[Steering](https://kiro.dev/docs/steering/) files in `.kiro/steering/` are your project's rules.

- **The Crypt plans with them.** Files with `inclusion: always` or `fileMatch` are in its prompt.
- **Every spirit loads them**, through its agent config.
- **Uncommitted steering counts too.** A spirit works in a worktree with only committed files, so
  selecle copies new or changed steering into its instructions.

`/steering` raises a chronicler to write the foundation files from your code: `product.md`,
`tech.md` and `structure.md`. It keeps what your team already wrote.

---

## Command reference

| In the room | |
|---|---|
| `/spec`, `/spec <feature>`, `/spec build <name>` | Kiro specs |
| `/kiro` | agents, steering, specs and the kit, for this project |
| `/init [--force]` | add the Kiro kit (host only) |
| `/steering` | a spirit writes the foundation steering |
| `/summon <task>` | raise a spirit directly |

| In a terminal | |
|---|---|
| `selecle init [folder] [--force]` | add the Kiro kit and install the spirit agents |
| `selecle kiro [folder]` | install the agents; show steering, specs and the kit |
| `selecle mcp` | the séance MCP server (stdio) |
| `selecle room [--guard]` | the room as text; what the kit's hooks run |

---

## Troubleshooting

**`kiro-cli agent list` shows no selecle agents.** Run `selecle kiro`. If `~/.kiro/agents` can't be
written, spirits fall back to plain Kiro with file tools.

**My Kiro does not see the room.** Check that `selecle mcp` runs in a terminal (it waits for input;
press Ctrl+C) and that `.kiro/settings/mcp.json` has the `selecle` server. Hooks need Kiro CLI V3
or the Kiro IDE.

**A spirit says a write was refused.** That's its role's limit: a tester writing source, or a
chronicler writing code. Ask the Crypt for a builder for that part.

**A spec build paused.** Read the spirit's last message, fix or edit `tasks.md`, then
`/spec build <name>`.
