<p align="center">
  <img src="docs/logo.svg" width="96" alt="Polly" />
</p>

<h1 align="center">Polly</h1>

<p align="center">
  A workspace of AI agents that each come with their own tools, memory and computer.<br/>
  Built on NVIDIA Nemotron, served by Nebius Token Factory.
</p>

---

> **Status:** built for the [Nebius × NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/), track *Coding and Agentic Engineering*. The **Coder**, **Researcher**, **Deep Research** and **Reviewer** work end to end, and research runs on its own after every Coder change. The other agents are declared but not built yet.

<p align="center">
  <img src="docs/screenshots/home.png" alt="Polly home: pick an agent and describe a task" width="100%" />
</p>
<p align="center">
  <img src="docs/screenshots/agents.png" alt="Polly agents, grouped into Coding, Research and Everyday divisions" width="100%" />
</p>

## What Polly is

Most AI assistants are one chat box that tries to do everything. Polly is a team: a set of specialist agents, each with a clear job, the right tools for it, a memory of what it has done, and a computer of its own to do the work on.

You hand a task to an agent (or let Polly pick one), and it works the way a person would — it plans, opens files, runs code, uses a browser, asks for approval before anything risky, and comes back with the result.

### Built-in agents

Agents are grouped into divisions. The first set:

| Division | Agent | What it does |
| --- | --- | --- |
| **Coding** | **Coder** | Plans a change, edits the repo, runs the tests, commits. Every change is then researched (below). |
| | **Designer** | Sketches UI and builds working front-end prototypes, checked in a real browser. |
| | **Reviewer** | Paste a GitHub PR link: reads the diff in context, checks CI and dependencies, scores the PR out of 100. |
| **Research** | **Researcher** | Fast, cited answers from the web. |
| | **Deep Research** | Splits a question into threads, researches them in parallel, writes a structured report. |
| **Everyday** | **Inbox** | Triage, replies in your voice, follow-ups. |
| | **Calendar** | Finds time, books meetings, briefs you before each one. |
| | **Operator** | Uses a desktop for you: fills forms, builds decks and spreadsheets, drives web apps. |

### Your own agents

Anyone can create an agent from the app by giving it:

- **Instructions** — a system prompt describing the job and how to do it
- **Skills** — reusable, on-demand playbooks (`SKILL.md` folders)
- **Knowledge** — documents and links the agent can search
- **Tools and integrations** — GitHub, Gmail, Google Calendar, Slack, Notion, Linear, Google Drive, web search, and more
- **Subagents** — specialists it can hand parts of a task to
- **A computer** — whether it needs a full desktop, or just a sandbox to run code
- **A face** — every agent gets its own robot avatar, generated from its id or customised (eyes, antenna, chest, colours)

### Every agent gets a computer

Agents work in their own isolated environments rather than on your machine (the Coder is the exception for now: it works in a folder you pick, under the permission mode you choose):

- a **sandbox** to run code, install packages and work on files, and
- when the job needs it, a **virtual desktop** (Linux, later Windows) with a browser and office apps, so an agent can fill in a form, put together a presentation, or work through a web app the way you would.

Sandboxes are provisioned on Nebius ([ConTree](https://docs.tokenfactory.nebius.com/sandboxes/overview)) and started on demand.

### Memory and approvals

Agents keep long-term memory per agent and per user (preferences, past decisions, project context), and short-term working files per task. Anything with side effects — sending an email, merging a PR, booking a meeting — is paused for your approval.

## The Coder

The first agent that works end to end. Open a project folder and Coder reads it, plans the change, edits files and runs your tests, streaming every step.

- **Permission modes.** *Supervised* asks before every edit and command. *Trusted* edits freely and asks before commands and deletes. *Autonomous* never asks. *Plan* is read-only and produces a plan. Switch with the chip under the composer or `Shift+Tab`.
- **Approvals inline.** A paused action shows its diff or command. Approve (`Y`), reject with a reason (`N`), or "Always allow" this file, folder or command prefix for the project. A project's blocked-command list applies in every mode, and a command that reaches outside the project folder always asks.
- **Changes panel.** Every file the Coder creates, edits or deletes in a session, with a diff against how it was before. Keep or undo each one. In git repositories, changes made by shell commands show up too.
- **Plan and subagents.** Multi-step work gets a live checklist. The *explorer* and *tester* subagents run on the faster Nemotron Nano and appear as nested cards.
- **Memory.** `POLLY.md` in the project root is read at the start of every session (one click generates it). The Coder keeps a private per-project notebook of what it learns. Long sessions are summarised at 85% of the model's context window, and the context meter shows how full it is.
- **Sessions.** Every conversation is checkpointed. Reopen it, resume a paused approval, or reload the window mid-run and pick the stream back up.
- **Models.** Pick per session: Nemotron 3 Super (default), Ultra, Nano and 3.5 Lightning, GLM 5.3 and 5.3 Flash, DeepSeek V4 Pro and Kimi K2.7 Code, all on Nebius Token Factory. Reasoning streams into a collapsible "Thought process".

In this version the Coder works in a folder on your machine. Cloud sessions in sandboxes come next.

### Research after every change

When a Coder run finishes with file changes, Polly starts a **change research** run on its own. It reads the request, the Coder's summary and the diff, then checks the libraries and APIs the change uses against the web: current docs, deprecations, breaking changes and security advisories. It returns:

- a **verification report** with a verdict (*Looks good*, *Needs attention*, *Risky*) and findings by severity, each tied to a file and to numbered sources, and
- a **pull request title and description**, ready to copy.

It shows up in the Coder's *Research* tab while it runs. Turn it off per project with *Research every change*, or run it by hand with *Research this change*. It runs on Super, with Nano scouts for the separate lookups.

## Research and Deep Research

- **Researcher** (quick) answers in a single pass: it searches, reads the pages that matter and replies with inline citations `[1]`, `[2]` linked to a numbered source list.
- **Deep Research** plans the question as separate threads, sends **scouts** (Nemotron Nano) to research them in parallel, writes a draft, has a **critic** (Nemotron Ultra) check it for unsupported claims, gaps and contradictions, then writes the final cited report.

Search and page extraction use Tavily. Every page an agent reads gets a stable number for the session, so citations in the answer, the sources panel and later reports all agree. Links open only if they are `http(s)`. Remote favicons are not loaded, so reading results never contacts those sites.

## The Reviewer: score a pull request

Paste `https://github.com/owner/repo/pull/123` into Home or the *Review* page. The Reviewer (Nemotron Ultra) reads the PR's overview, files and CI checks, opens files at the head commit when it needs context, and asks its **researcher** subagent (Nemotron Nano) to check dependencies and APIs on the web. It then submits a scorecard.

**The model judges and Polly does the maths.** Each category gets a 0–10 score with a rationale and evidence (`path:line` or `[n]`). Polly applies fixed weights and caps, so the same review always gives the same number and every adjustment is shown.

| Category | Weight |
| --- | --- |
| Correctness | 25 |
| Tests & CI | 20 |
| Security | 15 |
| Maintainability | 15 |
| Performance | 10 |
| Scope & hygiene | 10 |
| Docs | 5 |

Caps:

- If CI is failing, the total is capped at 60 and *Tests & CI* at 3/10.
- A critical finding caps the total at 40.
- A high-severity finding caps the total at 79.
- If code changed but no tests did, *Tests & CI* is capped at 5/10.

Grades are A ≥ 90, B ≥ 80, C ≥ 70, D ≥ 60 and F below that. The verdict is *Request changes* if there is any critical or high finding or the total is under 60, *Approve* at 80 or more, and *Comment* otherwise.

**Posting is always yours.** *Post as PR comment* opens a preview of exactly what will be posted, and nothing reaches GitHub until you click *Post comment*. The agent itself has read-only GitHub tools. *Copy as Markdown* works without signing in.

### Connecting GitHub

Public PRs work without signing in, within GitHub's anonymous rate limit. To review private repos and to post comments, open **Integrations → GitHub** and either:

1. **Sign in with GitHub (Device Flow).** Create an [OAuth App](https://github.com/settings/developers), tick **Enable Device Flow**, and set `GITHUB_CLIENT_ID` in `.env`. No client secret and no callback server are needed. The app shows a code; enter it on GitHub and Polly finishes the sign-in. It requests the `repo read:user` scopes.
2. **Use a token.** Paste a fine-grained personal access token with *Pull requests: read* (add *write* to post comments), or set `GITHUB_TOKEN` in `.env`.

The token stays on the server, in `.polly/secrets/github.json` with mode `0600`. It is never sent to the app.

## Models per role

All models are NVIDIA Nemotron, served by **Nebius Token Factory**. Heavy reasoning goes to Ultra, and fast or numerous calls go to Nano.

| Role | Model |
| --- | --- |
| Coder | Nemotron 3 Super (selectable per session) |
| Coder subagents: explorer, tester | Nemotron 3 Nano |
| Researcher | Nemotron 3 Super |
| Deep Research lead | Nemotron 3 Super |
| Deep Research scouts | Nemotron 3 Nano |
| Deep Research critic | **Nemotron 3 Ultra** |
| Reviewer (scoring) | **Nemotron 3 Ultra** |
| Reviewer's researcher | Nemotron 3 Nano |
| Change research | Nemotron 3 Super, with Nano scouts |

Override the tiers with `POLLY_MODEL`, `POLLY_FAST_MODEL` and `POLLY_STRONG_MODEL`.

## How it is built

```
┌──────────────────────────┐        HTTP / SSE        ┌──────────────────────────────────┐
│  Desktop app (macOS)     │ ───────────────────────► │  Agent server (Python, FastAPI)  │
│  Electron + React + TS   │                          │  Deep Agents · LangChain · Graph │
│  apps/desktop            │ ◄─────────────────────── │  server/                         │
└──────────────────────────┘                          └───────┬───────────┬──────────┬───┘
                                                              │           │          │
                                              Nebius Token Factory   Nebius ConTree   Tavily, GitHub,
                                              (NVIDIA Nemotron)      (sandboxes and   Gmail, Calendar,
                                                                      computers)       Slack, Notion…
```

| Layer | Choice |
| --- | --- |
| Models | NVIDIA Nemotron (Nemotron 3 Super by default, Nano for fast subagents) via **Nebius Token Factory** |
| Agent runtimes | [Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview) for long-running work, [LangChain agents](https://docs.langchain.com/oss/python/langchain/agents) for quick tasks, [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview) for fixed flows — see below |
| Sandboxes | **Nebius ConTree**, plugged in as a Deep Agents sandbox backend |
| Search | Tavily |
| Server | Python 3.11+, FastAPI, uv |
| Desktop | Electron, React 19, TypeScript, Vite (macOS first; the renderer also runs in a browser, which becomes the web app) |

### Agent runtimes

Each agent declares how it runs, and Polly uses the lightest runtime that can do the job well. All three compile to LangGraph graphs, so they share the same streaming, checkpointing and approval mechanism, and the app treats them the same way.

| Runtime | Built with | Use it for | Agents |
| --- | --- | --- | --- |
| `deep` | LangChain **Deep Agents** | Long-running, multi-step work that needs planning, a file system, subagents, skills, long-term memory and a sandbox | Coder, Designer, Reviewer, Deep Research, Operator |
| `agent` | LangChain **`create_agent`** | Quick, bounded tasks: a model calling tools in a loop | Researcher, Inbox, Calendar, most custom agents |
| `graph` | Hand-written **LangGraph** graphs | Flows whose steps are fixed in code: routing a task to the right agent, approval flows, scheduled routines | Internal flows |

Custom agents start on `agent`. Turning on "long-running" (or giving the agent subagents or a computer) moves it to `deep`. The dispatch lives in [`server/polly_server/agents/runtime.py`](server/polly_server/agents/runtime.py).

### Repository layout

```
apps/desktop/          Electron app
  src/main/            main process: window, IPC
  src/preload/         the bridge exposed to the renderer as window.polly
  src/renderer/        React UI (also runs standalone in a browser)
  src/shared/          types shared by all three, mirroring the server's schemas
server/
  polly_server/
    agents/            agent specs, the built-in catalog, and the runtime that builds them
    coder/             the Coder: prompt, permissions, change tracking, event stream, runs
    research/          Tavily client, numbered sources, prompts, research after the Coder
    reviewer/          the Reviewer's prompt and the scoring rubric
    integrations/      GitHub: Device Flow sign-in, token storage, PR API calls
    tools/             tools agents pick by name (research, GitHub, git, reports)
    api/               FastAPI app, routers and wire schemas
    artifacts.py       sources, reports and scorecards saved per session
    projects.py        project folders the Coder may work in
    sessions.py        conversations, their model, mode and usage
    model_registry.py  the Token Factory models on offer
    config.py          settings from .env
    models.py          Token Factory chat models
    check.py           `npm run check`: verify keys, list Nemotron models
  tests/
docs/                  logo and other assets
```

## Getting started

### Prerequisites

- macOS (Apple silicon or Intel)
- Node.js 20+ and npm
- Python 3.11+ and [uv](https://docs.astral.sh/uv/)
- A [Nebius Token Factory](https://tokenfactory.nebius.com) API key
- A [Tavily](https://tavily.com) API key, for Research, Deep Research and research after the Coder
- Optional: a GitHub OAuth App client ID or a personal access token (see [Connecting GitHub](#connecting-github))

### Setup

```bash
git clone <this repo> polly-ai && cd polly-ai
cp .env.example .env        # then add NEBIUS_API_KEY (and TAVILY_API_KEY)
npm run setup               # installs the desktop app and the server
npm run check               # confirms the key and lists the Nemotron models you can use
```

### Run

```bash
npm run dev                 # agent server on :8787 + the desktop app
```

Or one at a time:

```bash
npm run dev:server          # agent server only
npm run dev:desktop         # Electron app only
npm run dev:web             # the UI in a browser at http://localhost:5173
```

### Checks

```bash
npm test                    # server tests
npm run lint                # ruff
npm run typecheck           # TypeScript
```

## Roadmap

- [x] Project scaffolding: desktop shell, agent server, agent catalog
- [x] Chat with an agent: streaming runs, tool calls and subagents shown live
- [x] Coder: permission modes, approvals, tracked changes, memory, sessions, model choice
- [x] Approvals for coding actions
- [x] Research and Deep Research with Tavily, with numbered citations
- [x] Research after every Coder change: verification report and PR description
- [x] Reviewer: score a GitHub PR, post the score as a comment after a preview
- [x] GitHub sign-in (Device Flow) or a personal access token
- [ ] Coder cloud sessions in sandboxes, with GitHub (push and pull requests)
- [ ] Agent builder: instructions, skills, knowledge, tools
- [ ] Integrations: Gmail, Calendar, Slack, Notion, Linear
- [ ] Virtual desktops for computer-use agents
- [ ] Approvals for every agent's actions with side effects
- [ ] Web app

## Hackathon notes

### Demo script

1. **Coder, then research.** Open a project and ask the Coder to make a change that touches a dependency. When it finishes, the *Research* tab opens by itself. Show the verdict, a cited finding and *Copy PR description*.
2. **Reviewer.** On Home, paste a GitHub PR link and press Enter. Show the live tool steps, the PR panel (CI and size) and the scorecard: grade, category bars, any cap that was applied, and findings with suggestions.
3. **Post the score.** Click *Post as PR comment*, show the preview, connect GitHub with the Device Flow if needed, then post and open the comment.
4. **Deep Research.** Ask a comparison question in *Deep*. Show scouts running in parallel, the critic pass, and citations that link to the sources panel.

### What changed during the submission period

- New agents: Researcher, Deep Research and Reviewer, plus change research after the Coder.
- Tavily search and extraction, with session-wide numbered sources and citations in the UI.
- GitHub integration: Device Flow sign-in, token storage, PR reading tools and preview-then-post comments.
- A deterministic PR scoring rubric with caps, grades and verdicts.
- Model tiers: Ultra for scoring and critique, Nano for scouts and helpers.
- Desktop: Research and Review pages, the Coder's Research tab, and a live Integrations page.

### Feedback on Nebius Token Factory and Nemotron

<!-- Fill in before submitting: what worked, what was hard, what you would want next. -->

- **What worked:**
- **What was hard:**
- **Wishes:**

## License

[MIT](LICENSE)

Agent avatars use the [Voxel Bot](https://www.dicebear.com/styles/voxel-bot/) style by DiceBear, licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
