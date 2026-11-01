# Local Minecraft companions

Double-click **Play Companions.command**, or run `npm run play`. This starts your saved Paper world, the controller, the local web gateway and a Fabric development client as `LocalPlayer`. Saved companions join **paused**. Press **K**, choose a companion, then **Resume** to begin model work. Closing the client stops the stack.

The saved roster is authoritative, supports adding/removing companions, and can be empty. New profiles use Luna xhigh through your connected ChatGPT subscription and stay **offline** until you press Start. The launcher does not overwrite the frozen benchmark image.

## Claude Code subscription

Install Claude Code on the host Mac and sign in with `claude auth login --claudeai`. The normal launcher discovers its model and effort metadata and starts an owner-authenticated local host bridge. Choose **Claude Code** models in either client's model picker. Set `CLAUDE_CODE_EXECUTABLE` if the executable is not at `~/.local/bin/claude`.

The official Claude Agent SDK runs on the Mac using its native sign-in. Credentials stay in macOS; API-key and alternate-provider environment overrides are removed from this subscription path. Each decision returns tool intents to the same Pi session, which executes real actions once through the existing guards. Pi owns history and scheduling. The current bridge cannot relay Anthropic's signed server compaction blocks, so the provider-native-only policy prevents starting Claude Code workers. Existing profiles are preserved and may be changed to a supported OpenAI model. No Claude filesystem, shell or other built-in tools are enabled. Both clients refresh their choices when the catalog changes.

Signed-in SDK requests use the Claude plan's usage limits ([Anthropic documentation](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)). Provider tokens are reported; an exact subscription-credit conversion is unavailable. CLI process startup adds some latency; this integration does not establish which Claude model performs best in Minecraft.

## Shared controls

The in-game panel and [local web UI](http://127.0.0.1:8767) use the same controller, saved profiles, model catalog, mailbox, server rules and token ledger. Each interface refreshes changes made by the other. They provide the same controls and counters with layouts suited to the screen.

| Control                | Behavior                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Roster / Add agent     | Select any companion, add a profile, or select Team                                   |
| Chat                   | Send a task to the selected companion, or broadcast to the current roster             |
| Team From / To filters | Inspect anyone's internal messages, including archived participants                   |
| Settings               | Choose model, supported thinking effort, skin account, personality and standing task  |
| Usage                  | View this session or all saved sessions, for one agent or the team                    |
| Start / Pause / Resume | Start model work, cancel model work and movement while remaining connected, or resume |
| More → Stop / Remove   | Disconnect a companion, or remove its profile while preserving memory and history     |
| Host settings → Rules  | Set Minecraft difficulty and permanent death for everyone                             |
| Host settings → Access | Enable optional Wi-Fi sharing, obtain the pairing code, or revoke paired devices      |

Model and instruction changes reconnect only the selected active agent and retain its memory and paused state. Skin changes, roster changes and server-rule changes update connected agents without restarting their model sessions. Peers are recalculated from the roster. Names are persistent identities and cannot be renamed; removing and re-adding the same name restores its saved history and does not bypass permanent death.

Opening a chat never consumes agents' unread receipts. An outgoing **read** receipt means the recipient called `read_dms`; it does not prove the requested task is complete. Agent-to-agent DMs use the internal mailbox. Agents can also whisper humans or use public game chat. `/tell <agent-name> <task>` works from the normal chat box.

## Agent conversations in Minecraft chat

The mod shows new agent-to-agent mailbox messages in normal Minecraft chat as `[AI] Sender → Recipient: message`. Open **K → Chat → Game chat: On/Off** to toggle this on your own client. It starts on and is saved in that client's `config/companion-chat.json`. Other players choose their own setting.

This is a local HUD display of the existing message. It sends no public chat packet, consumes no unread receipt, and makes no model request. Joining a server starts at the latest message; toggling the mirror back on does not replay a backlog. A cursor catches bursts across multiple pages without duplicate delivery. Full history stays in the panel.

In **K → Team → Chat**, enable **Agents only** to show conversations between companions in the current roster. The web chat has the same filter. From/To filters can narrow it further. Removing an agent leaves its messages in full history; the Agents only view follows the current roster.

Client mods load at Minecraft startup. After an update, restart the game through **Play Companions.command** to load the new client and matching controller together.

## Skins

Enter the Minecraft account name whose skin you want in the profile's skin field. The controller fetches the signed public texture from Mojang, caches it, and the Paper plugin applies it live. The agent keeps its own name, UUID, inventory, memory and usage. Clear the field for its default skin. This version selects existing Minecraft account skins; it does not upload PNG files or alter anyone's Minecraft account. Fetching an uncached skin requires internet access. The web roster shows the selected face.

## Local Wi-Fi multiplayer

Sharing is **off by default**. With the stack running, use **K → Host settings → Access → LAN sharing: On**, or enable sharing in the web UI's Host settings. The panel lists the Mac's private Minecraft addresses and web URLs. There is no public hosting, router configuration or port forwarding.

The Mac mini can run without a Minecraft client: use `npm run companions`, then open **http://127.0.0.1:8767** on the mini and pair using the code printed in its terminal. Enable LAN sharing from that web panel before connecting the laptop.

Other players on the same reachable local network can join the listed Minecraft address with **Minecraft Java 1.21.6**. They can use ordinary game chat without a mod. To use the panel, they need Fabric Loader **0.20.1**, Fabric API **0.128.2+1.21.6**, and the client JAR from the [mod releases](https://github.com/espresso95/minecraft-companions-mod/releases/latest), or from `mods/companion-mailbox/build/libs/companion-mailbox-0.1.1+1.21.6.jar` after building. After joining, press **K**; the control URL is filled from the server address using port **8767**. Enter the pairing code and pair the device. In a browser, open that web address and pair with a player name and the same code. The host's browser also needs the code.

For a **Mac mini host and laptop client**, run this repository only on the Mac mini. Install the Fabric client mod on the laptop; it sends controls to the Mac mini and renders the same mailbox, Work and usage data. No model login, Docker or agent process is needed on the laptop. Keep each computer's simultaneous Minecraft player name distinct. Replace the laptop's old companion JAR with a new release when updating, then restart Minecraft. The companion-rules JAR is a Paper server plugin and stays on the Mac mini.

Paired devices have full shared management access, including models, messages, server settings and token information. Give the code only to trusted people. Each device's actions are bound to its paired player name; the host's Minecraft panel has a private owner credential. **Revoke devices** rotates the code and invalidates every paired device. The host's local owner pairing remains valid.

Turning sharing off closes the LAN web listeners and disconnects LAN Minecraft connections. Localhost remains available. The gateway binds only loopback and private IPv4 interface addresses. Your firewall and Wi-Fi client-isolation settings can still block other devices. Connections use HTTP on the trusted local network. Minecraft uses offline player identities; this is a private-server setup rather than Mojang account authentication.

## Difficulty and permanent death

Difficulty is Minecraft's own server setting. It is saved only in `server.properties`; native console difficulty commands are reflected in both interfaces and survive restarts. The custom plugin saves only its permanent-death flag and recorded deaths.

Permanent death works at any difficulty: dead human players become spectators and dead companions retire. Disabling the flag affects future deaths and does not revive recorded deaths. An ordinary death/respawn keeps a paused companion paused. Native Hardcore worlds are recognized and retain Minecraft's Hard/permanent-death rules. There is no duplicate custom Hardcore preset.

Your normal world remains **Peaceful, with permanent death off**. These settings apply across loaded dimensions. Agents read current difficulty and death rules in their observations, and receive live policy updates.

## Token accounting

| Counter            | Meaning                                                                   |
| ------------------ | ------------------------------------------------------------------------- |
| Input / cached     | Total input; cached tokens are a subset of input                          |
| Output / reasoning | Total output; reasoning tokens are a subset of output                     |
| Total              | Input + output, without counting subsets twice                            |
| Reported responses | Responses with provider-reported usage                                    |
| Pending / unknown  | Unfinished requests / requests that ended without a complete usage report |
| Last minute        | Tokens reported by responses completed in the last minute                 |

The same SQLite ledger supplies both interfaces. Per-run logs recover usage after restarts and prevent double counting. Interrupted requests are unknown, not free. OpenAI Responses and Claude Code both feed these counters. Claude input includes ordinary input plus cache creation and cache reads; cache reads are the cached subset. Claude does not expose a separate reasoning count here, so that breakdown remains unknown. **Exact ChatGPT and Claude subscription deductions are not exposed**, so neither interface invents a token-to-credit conversion.

## Commands and files

| Command                                                | Purpose                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `npm run play`                                         | Launch the server, companions, gateway and Fabric development client                             |
| `npm run companions`                                   | Start the backend for your own Minecraft client                                                  |
| `npm run companions:logs`                              | Follow backend logs                                                                              |
| `npm run companions:stop`                              | Stop the backend stack                                                                           |
| `npm run mod:build`                                    | Build both the client mod and Paper plugin                                                       |
| `npm run companions:pair -- "/path/to/Minecraft/game"` | Install the client JAR and owner credential on this Mac                                          |
| `npm run test:companions`                              | Test a copy of the world, real paused workers, native UI, skins, deaths, restart and LAN proxies |

For your own Minecraft installation, install the matching Fabric Loader and Fabric API, start the backend, run the pair command, then join **localhost:25565**. Pairing does not install Loader or Fabric API. The development-client launcher handles its own first-run accessibility screen.

The world is `.agent-state/server/`. Profiles, private agent memories, shared mailbox and usage are under `.agent-state/companions/`. OAuth remains in private `.agent-state/auth.json`; model workers require subscription OAuth and reject API-key billing. Keep this state folder, pairing credentials and codes private. Public signed skin textures contain no model credentials.

The controller runs in Colima alongside the agents so macOS and Linux never open the same live SQLite database. The Mac gateway forwards HTTP and Minecraft traffic; it owns no model or profile logic. The underlying API stays on VM loopback. Each agent's shell runs in its own isolated container. The launcher starts the default Colima profile at six CPUs/8 GiB when needed without changing its saved allocation or your Docker context. `colima stop default` releases that memory after stopping the stack.

## Development

The mod source is maintained in [minecraft-companions-mod](https://github.com/espresso95/minecraft-companions-mod) and pinned here as a submodule. Clone with `--recurse-submodules`, or run `git submodule update --init --recursive` after pulling. Mod releases provide the laptop-installable client JAR; the controller and web UI remain in this repository.

`npm run check` exercises the Linux sandbox and runs in Linux CI. On macOS, run those checks inside the runtime image; build and test the Java client natively with Java 21:

```sh
docker build -f Dockerfile.local -t minecraft-companions:local .
docker run --rm --entrypoint npm minecraft-companions:local run check
npm run mod:build
```

Companions use the same autonomous game loop and tools. Their objectives and personalities remain individual. DMs carry targeted coordination; the optional local chat mirror displays those messages without rebroadcasting them to agents. Human public chat wakes an idle companion; other agents' public chatter does not.

The **Work** tab in both interfaces shows shared goals, each agent's latest activity and blocker, and timestamped stockpile observations. The backend supplies identical display fields to the mod and web UI. Reports describe what an agent said it was doing; the separate live status indicates whether it is currently thinking, acting or waiting.

`shared_goal` optionally records the agreed objective and fixed coordinates, dimensions, materials and interfaces. Any teammate may update it within the human's instruction. Copies of a human mailbox broadcast or public chat resolve to one goal through `sourceMessageId` or `sourceChatId`. Updates patch only the supplied fields in a SQLite transaction. Existing goal records stay in the same mailbox event log.

`work_status` reads the full shared context with no arguments, or replaces the caller's activity report using `status` and `activity`. Optional `goalId`, `blocker` and `evidence` describe meaningful progress or a handoff. Replacing a report clears its previous blocker. Reports do not assign agents, claim work, enforce dependencies or grant permission to use game tools. There is no task queue or author-only project editing. Agents choose useful actions from the objective, world observations and DMs, and can act without creating a work record. Goal closure is reported completion, not independent proof.

`verify` independently checks actual inventory, shared container contents, a single block or every cell in a `blocks` region. Use container checks for shared deliveries and inventory checks for personally carried supplies. Regions use integer corners `x1,y1,z1` and `x2,y2,z2` plus the expected `name`, with at most 4096 cells per bounded pass. Verification uses ordinary guarded movement when another viewpoint is needed, invalidates blocks that change during the pass, and distinguishes missing (`passed:false`) from unobserved (`passed:null`). Multiple checks of one container share a fresh inspection within the pass. Verification does not mutate a goal or activity report.

Goal changes wake idle peers without interrupting physical work. Activity reports stay outside conversation and do not wake peers. Human private instructions and explicitly urgent peer messages can interrupt a batch; background following continues. Pausing dominates wake events. Stopping a working agent records a blocker while retaining its last progress, without rescheduling or replaying actions.

`recipes` reads alternatives and material totals from the active Minecraft registry. Generated Python programs can use `from agent_tools import call, parameters`. The command-line `tool` uses that same relay client. Game actions expose identical flat `outcome` and data to models and scripts. `call(...)` raises `BatchIncomplete` with the full result on partial progress. Physical actions retain the caller's action runner, budgets, safety guards and cancellation; lost or timed-out execution is never automatically replayed. Movement preserves exact fractional waypoints and avoids repeating a failed destination until the relevant facts change.

The shared skill library stores immutable Python versions, parameter schemas, assumptions, author, Minecraft version and observed outcomes in the existing shared SQLite database. `skill_library` registers a candidate from an existing shared workspace file; `run_skill` executes the saved bytes through the caller's own sandbox/relay. A successful exit alone does not verify a skill. Verification requires fresh visible-block, inventory or container-content checks, and is scoped to the current tool schemas and relay helper. After an interface change, an existing program can be tested again without replacing its saved source. Use private notes for personal discoveries and shared goals for agreed project facts.

Mailbox commits push wake hints through the existing controller/worker IPC. The controller's existing one-second scan retries hints for unread recipients; workers read the full messages directly from the mailbox by ID. There is no copied preview queue, and a large unread backlog cannot hide newer notifications. One structured inbox callback delivers batches of up to 20 full messages through Pi’s native custom-message API, at cycle start or a supported boundary after a tool. Sender, source kind and original source ID appear in both text and metadata. Inbox text is not appended to tool results or duplicated in turn headlines. Only IDs actually included in a successful decision response are acknowledged; summary requests never acknowledge mail. Failed requests leave those messages unread. Explicit `read_dms` reads still acknowledge only the returned incoming records. The web and Minecraft history viewers never consume an agent's inbox.

Tell a companion **“Stand by until I need you”** to allow `standby`. It suspends periodic model calls until instructions or danger arrive, while local listeners and background following continue. Standby survives reconnects and appears in both interfaces. Otherwise use `wait` with a brief reason and a bounded `seconds` deadline. Optional `until.checks` watches observed block/inventory facts or timestamped stockpile receipts; receipts are wake hints, so fresh verification is still needed for delivery claims. Goal edits and incoming messages can also wake a waiting agent. No task records gate waiting or standby.

Automatic observations retain every fact in each fresh visible survey, with the same ranges, limits and numeric precision. Repeated records can use a self-describing column table to avoid repeating field names. Mixed shapes and small collections stay ordinary JSON. Scripts and `observe_world` still receive ordinary objects. There are no cross-turn deltas, message suppression or reduced reasoning settings.

`run_shell` can execute Python or shell scripts using `tool --list`, `tool --help <name>` and `tool <name> '<JSON arguments>'`. Prefer existing batch tools, then short resumable scripts for repeated work. Check results and partial counts, and stop on failure. A shell command that loses its response is never automatically replayed. Each inner tool call still counts toward usage limits.

Private shell notes and `workspace_*` private files use the same directory, `<agent>/workspace/shell-home/`. Shared artifacts use `shared/workspace/`; `$SHARED_TOOLS` points to its `tools/` directory in every companion's sandbox. Shared scripts execute through the calling companion's own tool relay. Mailbox databases and credentials are outside the shared artifact mount.

`follow_player` starts continuous tracking of a nearby loaded player without waiting for further model calls. It remains active during idle waits and messaging. `stop_action`, Pause, shutdown or another physical action replaces it. Losing the target or a blocked route stops following and alerts the agent. Following never teleports, digs or pillars. Observations include the current action. Navigation accepts a ground-block coordinate by routing to clear standing space above it only within the existing acceptance radius, and reports the actual endpoint. Delivery follows a moving recipient and checks reach before dropping anything.

Script tool calls return only their data. Incoming instructions and damage alerts are attached once to the outer, model-facing result, so scripts retain valid JSON and automatic receipts cannot acknowledge hidden instructions. Human instructions and urgent peer messages pause the next script tool call; routine peer discussion waits for the batch boundary. `gather` checks between blocks and returns `yielded: true` with actual mined and inventory counts; scripts must save that partial progress and return to the model before resuming. Activity reports remain passive. Existing human interruptions and movement/search budgets remain intact.

After navigation failures, the existing pathfinder can supply a local walking waypoint. Recovery searches are bounded, never execute the proposed path, never mine or place blocks, and do not claim a complete route to an unreachable target. Walking and block interaction share this recovery helper.

The controller derives `agents[].status` (`phase` and `label`) from lifecycle state, pending model requests and the current action. The web panel, Minecraft panel and client-only player-name suffix all display that same label: Thinking, Working, Waiting, Standby or Paused. Existing polling supplies updates without model requests or game-chat packets. Vanilla name-tag visibility still applies, and human names are unchanged.

`src/controller/roster.js` owns profiles, `model-catalog.js` supplies model/effort options and validation, and `usage-ledger.js` owns counters. `src/web/` is a plain web frontend without a framework or build step. The Java client shares native roster/choice/form/chat components. The client and server plugin build together under `mods/companion-mailbox/` with Java 21 and Gradle 8.14.3.

The canonical API is `GET /v1/state`, `/v1/models`, `/v1/messages`; `POST /v1/agents`, `/v1/messages`, `/v1/control`, `/v1/pair`; `PATCH /v1/agents/:name`, `/v1/server`, `/v1/access`; and `DELETE /v1/agents/:name`. Settings, roster mutations and controls are serialized. Mailbox broadcasts are transactional and submission IDs make retries idempotent. The Paper bridge uses fixed RCON arguments; its port is never published.

Automated tests use a cloned world and paused workers with zero model requests. A successful local private-IP test proves the Mac's listeners and forwarding; a physical second-device Wi-Fi test still depends on your network and client installation.

### Controlled evaluations

Run `npm run eval:team -- --help` for the isolated evaluation runner. Supply a stopped, frozen server fixture, a scenario with an objective and independent block/container/inventory checks, a harness image and a new output directory. `test/evaluations/cabin.json` is one scenario; the geometry scorer is independent of its layout and materials. Use `--reference previous/protocol.json` to hold the initial world hash, profiles, instruction and duration constant while changing the harness image. Distinct ports/output directories support separate trials. The runner shares the canonical OAuth credential directory so refreshed login tokens cannot diverge between copied stores. It rejects failed agents or missing model activity, stops workers at the deadline, audits the world, records provider usage and response times, and shuts down its own containers. Ctrl+C also performs cleanup.

Each output directory contains the frozen protocol, sampled states, raw per-agent telemetry/provider events, final messages/shared-work records, independent world audit and `evaluation.json`. Tool telemetry distinguishes direct model calls, program calls and physical actions. Compare verified outcomes, time and reported tokens together. Pending/interrupted usage is unknown, not zero. Account-wide quota snapshots do not establish per-run subscription deductions. A single matched pair is a pilot; repeat on different seeds and hold-out goals before changing default models or effort levels.

### Verification and context bounds

The `verify` and conditional-wait tools share one check registry for schemas and execution validation. Positive quantities use `comparison: "at_least"` by default; exact counts, including zero, use `comparison: "equal"`. Container inspections and transfers publish timestamped contents in the mailbox event log. Agents and both Work panels read the same latest observations, while fresh completion verification remains mandatory. Each decision includes one compact shared objective/activity view without duplicated current, ready and blocked lists. Full conversation and world inspection remain available.

Compaction is provider-native only. Pi's automatic text summarizer is disabled, with no text fallback. Supported OpenAI Responses connections receive `context_management` with a trigger of the smaller of 64,000 tokens or 75% of the model's context window. The provider owns token measurement and compaction; this trigger is an initial policy, not a proven optimum. Capacity metadata and output headroom are validated. The ChatGPT OAuth connection supports this server-side feature, although its standalone `/responses/compact` endpoint is not authorized.

The native checkpoint and canonical response tail are stored unchanged in the private Pi session. Later requests replay that prefix and only newer conversation items, while preserving the current system instructions, tools and fresh observations. Instructions and the full tool catalog are declared outside the compacted history, without incremental tool-loading items. Background cache-warming requests are disabled so they cannot race or replace checkpoints; ordinary prompt caching remains available. Checkpoints are scoped to the exact model and endpoint; switching models uses the saved conversational history and obtains a new checkpoint from that provider connection. Full history remains searchable through `session_history`; tools execute once through the existing guards.

Diagnostics identify provider-native checkpoints and report the whole request duration, not an invented compaction-only latency or estimated token reduction. The ordinary response usage ledger counts each request once; separate compaction usage is marked unavailable when the provider does not expose it. Failed or cancelled requests cannot replace saved checkpoints. Pause and shutdown use the existing abort path. The earlier text-compaction qualification does not qualify native compaction or prove a quality/cost improvement.
