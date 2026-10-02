# starter-apps/portfolio-analyst

An AgentBox custom application: **TypeScript** + **`@openai/agents`**, running
the **Portfolio Analyst** concept -- a front-office agent that explains what
moved in a client portfolio against its benchmark, names two contributors and
one risk, and drafts the client note in wording compliance would sign. It is
wired so that every AgentBox control has something in it to actually exercise:
two bundled house rules, a bundled MCP server, an agent with real tools, a
governed `npm install` and outbound calls that policy decides on.

## Open the page

The application serves its own page on its own port. Once the app reaches
*running*, open:

    http://127.0.0.1:8081/

One **Play** button, eight steps, one plain sentence per result, and at the
end a card that sums up what AgentBox did. Each step is a canned message sent
through the ordinary chat; the chat box at the bottom is the same pipe. The
page is byte-identical with the other starters' (`ui/index.html`, held by a
test); only `concept/` differs, and `GET /concept` is where the page reads it.

**Every sentence is derived from a real signal** -- the gateway's 403 code,
the bridge's approval id, the proxy's status line, Package Guard's verdict --
and **the status pill is derived too**, from `GET /runtime-info`. There is no
flag. Run this image outside AgentBox and the pill goes red because the
variables are absent.

## The step this concept leads with: going online

Step 3 asks for today's exchange rates from a public rate service (`api.frankfurter.dev`, no key
needed). `agentbox-config.yaml` ships `network_destination_list: []`, so the
first press is **Stopped**: the agent may only go to the sites on your list,
and the list starts empty. Add `api.frankfurter.dev` under the application's Access
settings and press again: **Checked**, with no rebuild -- egress policy applies
on save. Step 6 posts the client note to a "portal" and is stopped the same
way. The demo script says so; ship the list empty.

## The concept

What this agent *is* lives in `concept/`, beside `src/`, and nothing under
`src/` knows which concept it runs:

- `concept/prompt.md` -- the job, one page. `buildSystemInstructions` puts
  it first, then any standing instructions the environment supplies; the
  backend appends what only it knows.
- `concept/concept.json` -- what the page renders: the eight steps with their
  literal prompts, the sentence for each outcome on the protected and the
  unprotected side, plain labels for tool calls, the scorecard lines.
- `concept/samples/` -- twelve holdings with weights and period returns, the
  benchmark, the note template, and the portfolio system's seed (`book.json`,
  held byte-identical with `mcp/portfolio-book/book.json`).

## What the agent can do

`src/agentTools.ts` builds the toolkit at each request: the company's systems
the bridge grants this application (read from `GET /tools`, called through
`POST /call` -- `src/bridge.ts`), plus `post_to_site`, `read_web_page`,
`install_package` and `keep_note`. Every attempt ends in a signal derived
from what came back, never from what was asked. `src/backends/openai.ts`
hands those to the SDK as function tools whose parameters are the schemas the
bridge published, and streams `token`, `tool`, `tool_result` and `result`.

## The house rules

`skills/market-commentary/` (the move against the benchmark, two
contributors, one risk, no forecasts, a fixed closing line) and
`skills/compliance-wording/` (no buy or sell language, past performance
labelled, any position above 20% named). Each carries a verification token so
a live test can tell "never delivered" from "delivered and ignored" from
"applied". They describe behaviour and quote no attack, and the shipped
scanner passes them.

## The portfolio system

`mcp/portfolio-book/` is a real MCP server built and run as its own
container, reachable only through MCP Bridge, seeded with seven invented
accounts. Its three operations take three paths: `get_positions` declares
itself read-only, `save_watchlist_note` writes, `purge_closed_accounts` is
classified destructive and held for a manager. Bundled servers are never
auto-bound: enable, validate, approve the tools, assign the server to this
application and rebuild, once per install.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Liveness. AgentBox polls this to mark the app running. |
| GET | `/concept` | The concept this app runs (`concept/concept.json`). |
| GET | `/runtime-info` | What this app can observe about its own confinement. |
| POST | `/process` | One message to the agent: `{"input": ..., "question": ...}`. Answers `{answer, backend, tool_calls}`. |
| POST | `/process/stream` | The same, as server-sent events. |
| POST | `/process/upload` | The same, with the message as a UTF-8 text file. |
| POST | `/mcp/get-positions` | Read the portfolio system through MCP Bridge (declared read-only). |
| POST | `/mcp/save-watchlist-note` | Write a watchlist note through the bridge. |
| POST | `/mcp/purge-closed-accounts` | The destructive operation: held by the bridge, answered 502 with the approval id. |
| POST | `/demo/install-package` | `npm install` a package and report Package Guard's verdict. |
| POST | `/demo/fetch-url` | Attempt egress and report SecureProxy's verdict. |
| POST | `/demo/touch-agent-file` | Write a flagged file, so the file guard has something to find. |
| GET | `/` | The page. A static mount, not a route -- it is not in the API document. |

The app listens on **8081** and declares it in `agentbox-config.yaml`. The
image keeps `npm` on purpose, so Package Guard's npm policy is exercisable
end to end; `openapi.json` is hand-written (no framework emits one here) and
`tests/unit/tools/test_starter_app_api_doc.py` fails if it drifts from the
routes in `src/server.ts`.

> **The "Delete old account records" step waits for a manager because AgentBox enforces sensitive-call approvals by default.** If an admin has switched **Automation › Approvals** to *Monitor*, the call is still classified and written to the audit log but it runs; switch back to **Enforce** before the tour and the destructive call is held with an approval id.
