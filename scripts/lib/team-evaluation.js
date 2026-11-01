import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import nbt from 'prismarine-nbt';
import { Vec3 } from 'vec3';
import { createGameTools } from '../../src/tools/game-tools.js';

export function assertEvaluationHealthy(state, elapsedMs, expectedNames) {
    for (const name of expectedNames) {
        const agent = state.agents.find(a => a.name === name);
        if (!agent) throw Error(`Evaluation agent disappeared: ${name}`);
        if (['stopped', 'dead', 'failed'].includes(agent.state))
            throw Error(`Evaluation agent stopped: ${name}: ${agent.error ?? agent.state}`);
        const usage = agent.usage ?? {};
        if (elapsedMs >= 120000 && !(usage.reported || usage.pending || usage.unknown))
            throw Error(`No model request activity after two minutes: ${name}`);
        if (elapsedMs >= 180000 && !usage.reported)
            throw Error(`No completed model response after three minutes: ${name}`);
    }
}

export function positions(group) {
    const cells = new Map((group.positions ?? []).map(p => [p.join(','), p]));
    for (const box of group.boxes ?? []) {
        if (
            !box.from ||
            !box.to ||
            box.from.length !== 3 ||
            box.to.length !== 3 ||
            [...box.from, ...box.to].some(n => !Number.isSafeInteger(n)) ||
            box.from.some((v, i) => v > box.to[i]) ||
            box.to.reduce((n, v, i) => n * (v - box.from[i] + 1), 1) > 10000
        )
            throw Error('Invalid or oversized audit box');
        for (let x = box.from[0]; x <= box.to[0]; x++)
            for (let y = box.from[1]; y <= box.to[1]; y++)
                for (let z = box.from[2]; z <= box.to[2]; z++) cells.set([x, y, z].join(','), [x, y, z]);
    }
    for (const p of group.exclude ?? []) cells.delete(p.join(','));
    if (cells.size > 10000) throw Error('Limit an audit group to 10000 cells');
    return [...cells.values()];
}
export function scoreBlocks(groups, blocks) {
    const byPosition = new Map(blocks.map(b => [[b.x, b.y, b.z].join(','), b]));
    return groups.map(group => {
        const cells = positions(group),
            failures = [];
        for (const p of cells) {
            const b = byPosition.get(p.join(','));
            if (
                !b ||
                b.name !== group.name ||
                Object.entries(group.properties ?? {}).some(([k, v]) => b.properties?.[k] !== v)
            )
                failures.push({ position: p, observed: b?.name ?? null, properties: b?.properties ?? null });
        }
        return {
            label: group.label,
            correct: cells.length - failures.length,
            required: cells.length,
            passed: !failures.length,
            failures,
        };
    });
}
export async function playerInventories(serverDir, profiles) {
    const result = [];
    for (const profile of profiles) {
        const bytes = createHash('md5')
            .update('OfflinePlayer:' + profile.name)
            .digest();
        bytes[6] = (bytes[6] & 0x0f) | 0x30;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const h = bytes.toString('hex'),
            uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
        const { parsed } = await nbt.parse(await readFile(join(serverDir, 'world/playerdata', uuid + '.dat'))),
            data = nbt.simplify(parsed);
        result.push({
            name: profile.name,
            position: data.Pos,
            health: data.Health,
            inventory: (data.Inventory ?? []).map(i => ({
                name: i.id.replace(/^minecraft:/, ''),
                count: i.count ?? i.Count,
            })),
        });
    }
    return result;
}
// /data pretty-prints long lists with an ellipsis. Read only the scalar fields
// required by the audit, so component data and output limits cannot hide stock.
export async function readContainerItems(command, at) {
    const items = [];
    const value = reply => {
        const separator = reply.indexOf(': ');
        if (separator < 0) throw Error('Container audit did not return a value');
        try {
            return JSON.parse(reply.slice(separator + 2));
        } catch {
            throw Error('Container audit returned an invalid or truncated value');
        }
    };
    for (let index = 0; index < 256; index++) {
        const base = `data get block ${at.join(' ')} Items[${index}]`;
        const reply = await command(base + '.id');
        if (/^Found no elements matching/.test(reply)) return items;
        const id = value(reply),
            count = value(await command(base + '.count'));
        if (typeof id !== 'string' || !Number.isSafeInteger(count) || count < 1)
            throw Error('Container audit returned an invalid item');
        items.push({ name: id.replace(/^minecraft:/, ''), count });
    }
    throw Error('Container audit exceeded the item limit');
}
export async function auditWorld({ bot, scenario, command, profiles, serverDir }) {
    const cells = new Map();
    for (const g of scenario.blockChecks) for (const p of positions(g)) cells.set(p.join(','), p);
    const blocks = [];
    for (const p of cells.values()) {
        let b = bot.blockAt(new Vec3(...p));
        if (!b) {
            await command(`tp ${bot.username} ${p[0] + 0.5} ${p[1] + 3} ${p[2] + 0.5}`);
            await bot.waitForChunksToLoad();
            b = bot.blockAt(new Vec3(...p));
        }
        if (!b) throw Error('Unloaded audit block at ' + p.join(','));
        blocks.push({ x: p[0], y: p[1], z: p[2], name: b.name, properties: b.getProperties() });
    }
    const containers = [];
    for (const c of scenario.containers ?? []) {
        await command(`tp ${bot.username} ${c.at[0] + 0.5} ${c.at[1]} ${c.at[2] + 1.5}`);
        await bot.waitForChunksToLoad();
        await bot.waitForTicks(2);
        const b = bot.blockAt(new Vec3(...c.at));
        let items = [];
        if (b?.name === c.name) {
            // The independent inspector reads server data. A blocked lid must not
            // prevent auditing contents or require changing the agents' world.
            items = await readContainerItems(command, c.at);
        }
        containers.push({
            ...c,
            items,
            passed: c.items.every(
                want => items.filter(i => i.name === want.name).reduce((n, i) => n + i.count, 0) >= want.minimum,
            ),
        });
    }
    await command('save-all flush');
    const players = await playerInventories(serverDir, profiles);
    return {
        auditedAt: new Date().toISOString(),
        blocks,
        blockChecks: scoreBlocks(scenario.blockChecks, blocks),
        containers,
        players,
    };
}
export function distribution(values) {
    const v = values.filter(Number.isFinite).sort((a, b) => a - b);
    const at = p => (v.length ? v[Math.max(0, Math.ceil(v.length * p) - 1)] : null);
    const middle = Math.floor(v.length / 2);
    const median = v.length ? (v.length % 2 ? v[middle] : (v[middle - 1] + v[middle]) / 2) : null;
    return { n: v.length, median, p90: at(0.9), max: at(1) };
}
const lines = text =>
    text
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l));
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const bodyNames = () => {
    const position = new Vec3(0, 65, 0),
        bot = {
            username: 'Metadata',
            entity: { position },
            game: { gameMode: 'survival' },
            inventory: { items: () => [], slots: [] },
            pathfinder: {},
            clearControlStates() {},
        };
    return new Set(
        createGameTools({ bot })
            .filter(t => t.body === true)
            .map(t => t.name),
    );
};
export async function summarizeTeamEvaluation(root, scenarioOverride) {
    const [protocol, timing, state, audit] = await Promise.all(
        ['protocol', 'timing', 'final-state', 'world-audit'].map(n => json(join(root, n + '.json'))),
    );
    const scenario = scenarioOverride ?? protocol.scenario;
    const start = Date.parse(timing.startedAt),
        end = start + protocol.durationSeconds * 1000,
        samples = lines(await readFile(join(root, 'samples.jsonl'), 'utf8'));
    const names = bodyNames(),
        agents = [];
    for (const profile of protocol.profiles) {
        const name = profile.name,
            dir = join(root, 'companions/controller', name),
            requests = new Map();
        for (const file of (await readdir(dir)).filter(f => /^usage-.*\.jsonl$/.test(f)))
            for (const e of lines(await readFile(join(dir, file), 'utf8'))) {
                const r = requests.get(e.id) ?? {};
                if (e.event === 'request_start') r.start = Date.parse(e.at);
                if (e.event === 'response_headers') r.headers = Date.parse(e.at);
                if (e.event === 'response_usage') r.end = Date.parse(e.at);
                requests.set(e.id, r);
            }
        const telemetry = lines(await readFile(join(root, 'companions', name, 'telemetry.jsonl'), 'utf8')),
            tools = telemetry.filter(e => e.event === 'tool');
        const shells = tools
            .filter(t => ['run_shell', 'run_skill'].includes(t.tool))
            .map(t => ({ from: Date.parse(t.time) - t.timeMs, to: Date.parse(t.time) }));
        let thinkingMs = 0;
        for (const r of requests.values())
            if (Number.isFinite(r.start))
                thinkingMs += Math.max(0, Math.min(r.end ?? end, end) - Math.max(start, r.start));
        let idleMs = 0;
        for (let i = 0; i < samples.length; i++) {
            const at = Date.parse(samples[i].capturedAt),
                next = Date.parse(samples[i + 1]?.capturedAt ?? new Date(end).toISOString()),
                ms = Math.max(0, Math.min(next, end) - Math.max(at, start));
            const a = samples[i].agents.find(a => a.name === name);
            if (!a) continue;
            if (a.status.phase === 'waiting' && !a.runtime?.action) {
                idleMs += ms;
            }
        }
        const programActions = tools.filter(
            t =>
                names.has(t.tool) &&
                (t.source === 'program' ||
                    (!t.source && shells.some(s => Date.parse(t.time) >= s.from && Date.parse(t.time) <= s.to))),
        );
        agents.push({
            name,
            model: profile.model,
            thinking: profile.thinking,
            usage: state.agents.find(a => a.name === name).usage,
            responseSeconds: distribution(
                [...requests.values()]
                    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
                    .map(r => (r.end - r.start) / 1000),
            ),
            headersSeconds: distribution(
                [...requests.values()]
                    .filter(r => Number.isFinite(r.start) && Number.isFinite(r.headers))
                    .map(r => (r.headers - r.start) / 1000),
            ),
            modelPendingSeconds: thinkingMs / 1000,
            scheduledIdleSeconds: idleMs / 1000,
            bodyToolCalls: tools.filter(t => t.body ?? names.has(t.tool)).length,
            programBodyToolCalls: programActions.length,
            shellCalls: shells.length,
            toolFailures: tools
                .filter(t => !t.success)
                .map(t => ({ tool: t.tool, failureCode: t.failureCode, result: t.result })),
            digEvents: telemetry.filter(e => e.event === 'dig').length,
            placeEvents: telemetry.filter(e => e.event === 'place').length,
            waitingReasons: [
                ...new Set(samples.map(s => s.agents.find(a => a.name === name)?.runtime?.waitReason).filter(Boolean)),
            ],
        });
    }
    let players = audit.players;
    if (!players) players = await playerInventories(join(root, 'server'), protocol.profiles);
    const items = [
        ...players.flatMap(p => p.inventory),
        ...(audit.containers ?? []).flatMap(c => c.items),
        ...(audit.chestItems ?? []),
    ];
    const checks = scenario ? scoreBlocks(scenario.blockChecks, audit.blocks) : audit.blockChecks;
    const inventoryChecks = (scenario?.inventoryChecks ?? [])
        .map(c => ({ ...c, observed: items.filter(i => i.name === c.name).reduce((n, i) => n + i.count, 0) }))
        .map(c => ({ ...c, passed: c.observed >= c.minimum }));
    const containerChecks =
        scenario?.containers?.map(c => {
            const observed =
                audit.containers?.find(a => a.at.join(',') === c.at.join(','))?.items ?? audit.chestItems ?? [];
            return {
                label: c.label,
                passed: c.items.every(
                    w => observed.filter(i => i.name === w.name).reduce((n, i) => n + i.count, 0) >= w.minimum,
                ),
                items: observed,
            };
        }) ??
        audit.containers ??
        [];
    const result = {
        protocol: {
            imageId: protocol.imageId,
            startingWorldHash: protocol.startingWorldHash,
            durationSeconds: protocol.durationSeconds,
            profiles: protocol.profiles.map(({ name, model, thinking }) => ({ name, model, thinking })),
        },
        timing,
        usage: state.usage,
        agents,
        world: {
            blockChecks: checks,
            containerChecks,
            inventoryChecks,
            players,
            completed: [...(checks ?? []), ...containerChecks, ...inventoryChecks].every(c => c.passed),
        },
        limits: [
            'Single pilot per revision; not statistical qualification.',
            'Timing phases can overlap with background actions. Idle is sampled at five-second intervals.',
            'Reported tokens exclude unknown interrupted requests. Cached input is part of input; reasoning is part of output.',
            'Account-wide quota snapshots cannot isolate this experiment or establish a token-to-credit conversion.',
        ],
    };
    await writeFile(join(root, 'evaluation.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
}
