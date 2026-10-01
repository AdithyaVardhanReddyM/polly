<p align="center">
  <img src="docs/logo.svg" width="96" alt="Polly" />
</p>

<h1 align="center">Polly</h1>

<p align="center">
  A workspace of AI agents that each come with their own tools, memory and computer.<br/>
  Built on NVIDIA Nemotron, served by Nebius Token Factory.
</p>

---

> **Status:** early scaffolding for the [Nebius × NVIDIA Global AI Hackathon](https://nebiusglobalaihackathon.devpost.com/). The app shell and agent server run; the agents themselves are declared but not built yet.

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
| **Coding** | **Coder** | Plans a change, edits the repo in its sandbox, runs the tests, opens a pull request. |
| | **Designer** | Sketches UI and builds working front-end prototypes, checked in a real browser. |
| | **Reviewer** | Reviews pull requests in context, reproduces bugs in a sandbox, suggests fixes. |
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

Each agent works in its own isolated environment, never on your machine:

- a **sandbox** to run code, install packages and work on files, and
- when the job needs it, a **virtual desktop** (Linux, later Windows) with a browser and office apps, so an agent can fill in a form, put together a presentation, or work through a web app the way you would.

Sandboxes are provisioned on Nebius ([ConTree](https://docs.tokenfactory.nebius.com/sandboxes/overview)) and started on demand.

### Memory and approvals

Agents keep long-term memory per agent and per user (preferences, past decisions, project context), and short-term working files per task. Anything with side effects — sending an email, merging a PR, booking a meeting — is paused for your approval.

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
    api/               FastAPI app and wire schemas
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
- Optional: a [Tavily](https://tavily.com) API key

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
- [ ] Chat with an agent: streaming runs, tool calls and subagents shown live
- [ ] Coder agent with a ConTree sandbox and GitHub
- [ ] Research and Deep Research with Tavily
- [ ] Agent builder: instructions, skills, knowledge, tools
- [ ] Integrations: Gmail, Calendar, Slack, Notion, Linear
- [ ] Virtual desktops for computer-use agents
- [ ] Approvals for actions with side effects
- [ ] Web app

## License

[MIT](LICENSE)

Agent avatars use the [Voxel Bot](https://www.dicebear.com/styles/voxel-bot/) style by DiceBear, licensed [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/).
