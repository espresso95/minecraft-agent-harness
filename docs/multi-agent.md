# Running a team

```sh
npx minecraft-agent team examples/team.json
```

A team needs at least two agents. A team file has shared defaults at the top level and one entry per agent. Any option from
[configuration.md](configuration.md) can appear at either level; per-agent values win.

```json
{
  "host": "localhost",
  "port": 25565,
  "model": "openai/gpt-6.1-terra",
  "objective": "Build a small village together: at least three houses, a farm and a path between them.",
  "sharedMachine": "local",
  "agents": [
    { "name": "Ada" },
    { "name": "Bram", "model": "openai/gpt-5.5" },
    { "name": "Cleo", "personality": "Careful planner who writes everything down." }
  ]
}
```

What changes in team mode:

- Every agent knows the others' names and gets `directory` and `directory_search`.
- Agents message each other with `send_dm` and `read_dms`. Unread counts show up in every observation.
- `shared_exec` runs commands on one machine shared by the whole team. Its working directory (`/shared` on E2B,
  `<state-dir>/shared-machine` locally) has `plans/`, `notes/` and `tools/`, and every command is appended to `log`
  with its author.
- The noticeboard is turned off. Player chat and whispers remain enabled by default so human players can talk to the team; set `playerChat: false` to disable them. Registered teammates use the internal mailbox for DMs, without duplicate whispers.

For a local two-agent installation with an in-game mailbox and token panel, see [companions.md](companions.md).

`sharedMachine` can be:

| Value   | Machine                                                                              |
| ------- | ------------------------------------------------------------------------------------ |
| `local` | a directory under the state dir on the host, commands run with `bash` (not isolated) |
| `e2b`   | one E2B VM for the team with root and internet access (needs `E2B_API_KEY`)          |
| `none`  | no `shared_exec`                                                                     |

Each agent still gets its own private sandbox according to `sandbox`. Agents start a few seconds apart
(`staggerSeconds`, default 3). `Ctrl+C` stops all of them.
