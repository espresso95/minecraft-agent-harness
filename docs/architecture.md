# Architecture

Each agent runs in one Node.js process. Game tools connect a Mineflayer bot to a pi model session.

```
bin/minecraft-agent.js ── src/cli.js ── src/config.js ── src/agent.js
                                                          │
          ┌───────────────────────────────────────────────┼─────────────────────────────────────┐
          ▼                                               ▼                                     ▼
   src/body/bot.js                                 src/tools/*.js                        src/model/session.js
   Mineflayer + pathfinder,                        tool definitions:                     pi createAgentSession,
   collectblock, pvp; tick                         game, workspace,                      scheduler, observation
   pacing, chat guard,                             messaging, shell,                     injection, compaction,
   damage and respawn                              shared machine                        session_history
          │                                               │
          ▼                                               ▼
   src/skills/*.js                                 src/sandbox/shell-sandbox.js
   pathing, digging, building,                     Docker, E2B or local shell with a tool relay
   crafting, line-of-sight perception
```

## The loop

`src/model/session.js` wraps a single `createAgentSession` from `@earendil-works/pi-coding-agent`.

- **Observation before every call.** pi's `transformContext` hook appends a fresh observation (visible blocks and
  entities, inventory, health, hunger, oxygen, unread messages, recent hits, optional image) to the outgoing request.
  It is not saved in the transcript.
- **Tools only.** The model acts only through tools. Assistant text stays private; speaking in game requires
  `post_chat` or `send_dm`.
- **Scheduling.** The runner is continuous. After a natural final answer it idles (10 s by default) and wakes on a
  timer or on an event. Events (chat, DMs, damage, low oxygen, respawn) are queued by key and coalesced; urgent ones
  wake the agent immediately and can interrupt the current body action. Model errors back off exponentially up to five
  minutes.
- **Persistence.** The session lives in `.agent-state/<name>/pi-sessions/` and is resumed with
  `SessionManager.continueRecent`, including the scheduler's next wake time. Provider-native compaction shortens
  the request context; Pi's text compaction is disabled. Opaque checkpoints are stored in the same private session,
  scoped to the exact model and endpoint. `session_history` searches the full transcript, including compacted turns.

## The body

- **Action runner** (`createActionRunner` in `src/tools/game/runtime.js`). One body action at a time. Every body tool
  gets an `AbortSignal`; cancellation stops the pathfinder, clears control states and waits for the action to settle.
  An action that will not settle within 8 s marks the body unsafe and the process exits so it can be restarted
  cleanly. Writes that arrive after an action was cancelled are refused at the packet level.
- **Interruptions.** Damage interrupts most long actions so the model can react; `attack`, `flee`, `go_to` and the
  other keep-moving tools continue and report the hit afterwards. Hit alerts name the attacker, its position and its
  distance.
- **Perception** (`src/skills/perception.js`). Blocks and entities are visible only along an unobstructed line of
  sight within 64 blocks. Placement and digging check reach and face visibility the way a player would.
- **Tick pacing** (`src/body/tickpace.js`). Mineflayer's physics runs on a fixed 50 ms timer. When the server runs a
  slower `/tick rate`, the pacer steps physics at the server's rate so the bot does not move faster than the world.
- **Guards.** Outgoing chat packets that start with `/` are dropped (`src/body/chat-guard.js`), so the agent cannot
  run server commands even if it has operator status.

## Game tools

`src/tools/game-tools.js` is a small index. `createGameTools` builds a shared context (the bot, the action runner, the
`add` registration helper and the options it was given), then runs one builder per domain in `src/tools/game/`. Each
builder registers its tools and returns the helpers later builders need, which are merged into the context:

| File               | Contents                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------- |
| `helpers.js`       | shared helpers: pathfinder loading, deadlines, stall watch, drop pickup, block lookups       |
| `core.js`          | `add` (validation, action runner, alerts), `call`, `blockAt`                                 |
| `perception.js`    | `observe_world`, `look`, `inspect_block`                                                     |
| `movement.js`      | `stop_action`, `go_to`, `fly_to`, `move`, `return_to_surface`, `door`, `go_through_door`     |
| `gathering.js`     | `gather`, `break_block`, `break_area`                                                        |
| `placement.js`     | placement planning, scaffolding and bridging used by `place`                                 |
| `building.js`      | `place`, `place_line`                                                                        |
| `items.js`         | `inventory`, `equip`, `eat`, `use_item`, `select_hotbar`, `drop_item`, `interact_*`, `sleep` |
| `combat.js`        | `attack`, `flee`                                                                             |
| `crafting.js`      | `craft`, `smelt`, `furnace`                                                                  |
| `containers.js`    | `view_window`, `click_slot`, `close_window`, `open_container`, `deposit`, `withdraw`         |
| `communication.js` | chat, DMs and the shared plan                                                                |

Below those sit `runtime.js` (action runner, skill compatibility, body stop), `guards.js` (edge, swim and built-block
guards), `observation.js`, `schema.js` (argument schemas and validation) and `failures.js` (failure codes). The index
keeps the tools in a fixed order, and `test/tools/tool-definitions.test.js` checks every tool name, description and
schema against a committed snapshot, so moving code between files cannot change what the model sees.

## The sandbox

`run_shell` executes commands in a per-agent persistent machine (`src/sandbox/shell-sandbox.js`, `src/sandbox/docker.js`):

- `docker`: a persistent container per agent with the agent's state directory mounted as home.
- `e2b`: a cloud VM per agent, paused when idle and resumed on demand.
- `local`: `bash` in a directory under the agent's state.

All of them start a small HTTP relay (`src/sandbox/assets/relay.cjs`) and install a `tool` command. A script in the sandbox
can call `tool go_to '{"x":0,"y":64,"z":0}'`; the agent process long-polls the relay, runs the call through the same
session wrapper as a model tool call (validation, budgets, telemetry) and returns the JSON result.

## Messaging

`src/comms/mailbox-store.js` is a SQLite mailbox shared by all agents that use the same state directory. It stores
private DMs and the public chat each agent heard, with per-reader cursors. Unread counts appear in every observation.
In single-agent mode a shared `plan.md` noticeboard is available through `read_plan` and `append_plan`.

Shared objectives, personal activity reports and observed stockpiles are projected from that same mailbox event log. `shared_goal` and `work_status` provide optional context; they do not claim work, enforce dependencies or gate game actions. `verify` checks actual blocks, inventory and container contents independently. The controller supplies one Work view to the mod and web UI.

## Team mode

With `minecraft-agent team`, agents share a state directory (so the mailbox is common), get each other's names, and
share one machine through `shared_exec` (`src/shared-machine/`). Public chat tools and the noticeboard are removed;
coordination happens over DMs and the shared machine. See [multi-agent.md](multi-agent.md).

## Patches

`patches/` holds fixes to Mineflayer and its plugins, applied by `patch-package` on `npm install`: digging tool
materials, inventory and block placement handling, entity velocity updates, collectblock pickup cancellation,
pathfinder lava avoidance and stop behaviour, pvp updates on physics ticks, and suppression of protodef packet dumps.
Dig-time calculations omit the water penalty because the bot's water-state calculation is unreliable.
`src/vision/patches/` holds the renderer patch used by `npm run vision:install`.

## Process model and reconnects

`minecraft-agent run` starts a small supervisor that checks the model and key, then runs the agent in a child process.
When the child exits because the server kicked it or the connection dropped, the supervisor starts a new child after a
backoff (5s, 10s, 20s, 40s, then 60s; at most 8 tries in a row). The new child resumes the same pi session, sandbox and
mailbox, and keeps the original `--duration` deadline. Bans, whitelist kicks and duplicate logins exit for good, as do
startup errors on the first attempt. Errors print as one line on stderr and the process exits non-zero.

## Movement packets

Mineflayer sends a position packet every physics tick. The harness throttles these to one per 50 ms but always
delivers the newest state of each packet kind, including mid-jump positions.
