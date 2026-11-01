import { spawn, spawnSync } from 'node:child_process';
import { readFile, writeFile, mkdir, rm, readdir, stat, appendFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import mineflayer from 'mineflayer';
import { Vec3 } from 'vec3';
import nbt from 'prismarine-nbt';

const root = resolve('.agent-state');
const action = process.argv[2];
const level = process.argv[3] ?? 'medium';
const family = process.argv[4] ?? 'luna';
const revision = process.argv[5] ?? 'v1';
if (!/^v[1-9][0-9]*$/.test(revision)) throw new Error('Expected a revision such as v1 or v2');
if (!['luna', 'terra'].includes(family)) throw new Error('Expected luna or terra');
const model = family === 'terra' ? 'openai/gpt-6.1-terra' : 'openai/gpt-6-luna';
const suite = resolve(root, `benchmarks/${family}-medium-xhigh`);
if (!['medium', 'xhigh', 'max'].includes(level)) throw new Error('Expected medium, xhigh or max');
const followup = revision !== 'v1' || level === 'max';
const parallel = followup && family === 'luna';
const project = parallel ? `minecraft-${family}-${level}-${revision}` : 'minecraft-luna-benchmark';
const mcPort = parallel ? (level === 'max' ? 25567 : 25566) : 25565;
const cpuSet = level === 'max' ? '4-7' : '0-3';
const agentImage = level === 'max' ? 'minecraft-luna-max-benchmark:local' : 'minecraft-terra-harness:local';
const runId = `${family}-${level}-20m-${revision}`;
const runDir = resolve(root, 'measurements', runId);
const trialDir = followup
    ? resolve(root, `benchmarks/${family}-followups`, `${level}-${revision}`)
    : join(suite, level);
const stateDir = join(trialDir, 'state');
const serverDir = action === 'prepare' ? join(suite, 'baseline/server') : join(trialDir, 'server');
const objective = `You have 20 minutes in survival mode. Complete this oak cabin and resource task in the provided peaceful test world. Start with an empty inventory; gather and craft everything yourself. There are ten oak trees around the grass platform; stay within the glass boundary. First visit the gold floor block at (12,64,12), standing above it at feet (12,65,12) for at least 5 seconds. Build an oak cabin with EXACT outer footprint x=0..4,z=0..4: a full 5x5 oak-plank floor at y=65; perimeter oak-plank walls at y=66 and y=67 except the doorway at x=2,z=0; a full flat 5x5 oak-plank roof at y=68; an oak door with lower half at (2,66,0), upper half at (2,67,0), usable from outside. Keep the interior walkable and free of scaffolding. Place a chest at (1,66,1) and crafting table at (3,66,1). Put at least 8 raw oak logs in that chest, craft and keep a wooden pickaxe (in your inventory or chest), then finish standing inside at (2,66,2). Keep ~/notes/task.md with coordinates and honest progress. Do not claim completion until verified. Work independently without asking for help; if finished early, verify and maintain the completed state until the deadline.`;
const env = {
    ...process.env,
    DOCKER_HOST: `unix://${homedir()}/.colima/default/docker.sock`,
    LOCAL_UID: String(process.getuid()),
    LOCAL_GID: String(process.getgid()),
    DOCKER_SOCKET_GID: '991',
    LOCAL_STATE_DIR: root,
    LOCAL_MC_PORT: String(mcPort),
    BENCH_SERVER_DIR: serverDir,
    BENCH_AGENT_STATE_DIR: stateDir,
    BENCH_THINKING: level,
    BENCH_MODEL: model,
    BENCH_CPUSET: cpuSet,
    BENCH_AGENT_IMAGE: agentImage,
    AGENT_DURATION_MINUTES: '20',
    AGENT_USAGE_FILE: join(runDir, 'provider.jsonl'),
    AGENT_OBJECTIVE: objective,
};
delete env.OPENAI_API_KEY;
const compose = ['compose', '-p', project, '-f', 'compose.local.yaml', '-f', 'compose.benchmark.yaml'];
if (parallel) compose.push('-f', 'compose.benchmark-parallel.yaml');
function command(args, { quiet = false } = {}) {
    const p = spawnSync('docker', args, { env, encoding: 'utf8', maxBuffer: 5e6 });
    if (p.status !== 0) throw new Error(`${args.slice(0, 4).join(' ')}: ${p.stderr || p.stdout}`);
    if (!quiet && p.stdout) console.log(p.stdout.trim());
    return p.stdout.trim();
}
const dc = (...args) => command([...compose, ...args]);
const rcon = cmd => command([...compose, 'exec', '-T', 'server', 'rcon-cli', cmd], { quiet: true });
const save = async (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
async function hashTree(dir) {
    const hash = createHash('sha256');
    async function walk(d) {
        for (const name of (await readdir(d)).sort()) {
            const file = join(d, name);
            if ((await stat(file)).isDirectory()) await walk(file);
            else {
                hash.update(file.slice(dir.length));
                hash.update(await readFile(file));
            }
        }
    }
    await walk(dir);
    return hash.digest('hex');
}
async function startServer() {
    dc('up', '-d', '--no-build', '--wait', 'server');
}
if (action === 'clone') {
    const baseline = resolve(root, 'benchmarks/luna-medium-xhigh/baseline/server');
    const fixture = JSON.parse(await readFile(resolve(root, 'benchmarks/luna-medium-xhigh/fixture.json'), 'utf8'));
    if (fixture.objective !== objective) throw new Error('Objective differs from the frozen Luna task');
    const actualHash = await hashTree(join(baseline, 'world'));
    if (actualHash !== fixture.worldHash) throw new Error('Frozen starting world changed');
    const baseImageId = command(['image', 'inspect', '-f', '{{.Id}}', 'minecraft-terra-harness:local'], {
        quiet: true,
    });
    if (baseImageId !== 'sha256:710290ed5ccc142424922a9736c7e7c2ff1b8fd3c248c3b3c9529759782d7e27')
        throw new Error('Harness image differs from the one used for Luna');
    const imageId = command(['image', 'inspect', '-f', '{{.Id}}', agentImage], { quiet: true });
    let maxConfigChange = null;
    if (level === 'max') {
        const original = command(
            ['run', '--rm', '--entrypoint', 'cat', 'minecraft-terra-harness:local', '/app/src/config.js'],
            { quiet: true },
        );
        const updated = command(['run', '--rm', '--entrypoint', 'cat', agentImage, '/app/src/config.js'], {
            quiet: true,
        });
        if (updated !== original.replace("'high', 'xhigh'];", "'high', 'xhigh', 'max'];"))
            throw new Error('Max image has unexpected configuration changes');
        maxConfigChange = 'Only add max to the accepted THINKING configuration values';
    } else if (imageId !== baseImageId) throw new Error('Repeat must use the original image');
    const codeHashScript =
        "const fs=require('node:fs'),c=require('node:crypto'),p=require('node:path');const h=c.createHash('sha256');function walk(d){for(const n of fs.readdirSync(d).sort()){const f=p.join(d,n);if(fs.statSync(f).isDirectory())walk(f);else if(f!=='/app/src/config.js'){h.update(f);h.update(fs.readFileSync(f));}}}walk('/app/src');walk('/app/bin');console.log(h.digest('hex'));";
    const baseCodeHash = command(
        ['run', '--rm', '--entrypoint', 'node', 'minecraft-terra-harness:local', '-e', codeHashScript],
        { quiet: true },
    );
    const selectedCodeHash = command(['run', '--rm', '--entrypoint', 'node', agentImage, '-e', codeHashScript], {
        quiet: true,
    });
    if (baseCodeHash !== selectedCodeHash) throw new Error('Game or agent code differs from the original harness');
    {
        const trial = trialDir;
        if (await stat(trial).catch(() => null)) throw new Error(`Trial already exists: ${trial}`);
        await mkdir(trial, { recursive: true, mode: 0o700 });
        const copied = spawnSync('cp', ['-cR', baseline, join(trial, 'server')], { encoding: 'utf8' });
        if (copied.status !== 0) throw new Error(copied.stderr);
        if ((await hashTree(join(trial, 'server/world'))) !== actualHash) throw new Error('World copy hash mismatch');
        await mkdir(join(trial, 'state'), { mode: 0o700 });
        const measurement = runDir;
        await mkdir(measurement, { recursive: true, mode: 0o700 });
        const source = JSON.parse(
            await readFile(
                resolve(root, 'measurements', `luna-${level === 'max' ? 'xhigh' : level}-20m-v1/protocol.json`),
                'utf8',
            ),
        );
        await save(join(measurement, 'protocol.json'), {
            ...source,
            runId,
            thinking: level,
            revision,
            createdAt: new Date().toISOString(),
            model,
            agentStateDir: join(trial, 'state'),
            startingWorldSha256: actualHash,
            harnessImageId: imageId,
            baseHarnessImageId: baseImageId,
            gameAndAgentCodeSha256: selectedCodeHash,
            maxConfigChange,
            serverDir,
            composeProject: project,
            mcPort,
            parallel,
            parallelResources: parallel
                ? { vmCpus: 8, vmMemoryGiB: 12, cpuSet, containerMemoryLimitGiB: 4, serverJavaHeap: '2G' }
                : null,
            agentImage,
            agent: 'Luna',
            avatarIdentity: 'Same Minecraft name and prompt identity as the Luna trials, to hold conditions constant',
            launchGroup: parallel ? 'luna-xhigh-repeat-and-max-parallel' : null,
            runOrder: parallel ? ['luna-xhigh-20m-v2', 'luna-max-20m-v1'] : source.runOrder,
            runOrderMeaning: parallel
                ? 'Simultaneous launch group; list order does not indicate sequential execution'
                : null,
            comparisonLimit:
                'Small repeat experiment. New runs are parallel with separate four-core CPU sets; earlier runs were sequential. Shared provider quota and cache effects may differ.',
        });
    }
    console.log(
        JSON.stringify({
            runId,
            family,
            model,
            startingWorldSha256: actualHash,
            harnessImageId: imageId,
            selectedCodeHash,
            parallel,
            project,
            mcPort,
            cpuSet,
        }),
    );
} else if (action === 'prepare') {
    if (family !== 'luna') throw new Error('Use clone to reuse the frozen Luna baseline');
    await mkdir(join(suite, 'baseline'), { recursive: true });
    if (await stat(serverDir).catch(() => null)) throw new Error('Baseline already exists; refusing overwrite');
    const copy = spawnSync('cp', ['-cR', join(root, 'server'), serverDir], { encoding: 'utf8' });
    if (copy.status !== 0) throw new Error(copy.stderr);
    for (const name of ['world', 'world_nether', 'world_the_end'])
        await rm(join(serverDir, name), { recursive: true, force: true });
    await startServer();
    const commands = [
        'gamerule doMobSpawning false',
        'gamerule doDaylightCycle false',
        'gamerule doWeatherCycle false',
        'gamerule randomTickSpeed 0',
        'gamerule spawnRadius 0',
        'difficulty peaceful',
        'time set 1000',
        'weather clear',
        'fill -16 63 -16 16 63 16 minecraft:bedrock',
        'fill -16 64 -16 16 64 16 minecraft:grass_block',
        'fill -16 65 -16 -16 68 16 minecraft:glass',
        'fill 16 65 -16 16 68 16 minecraft:glass',
        'fill -16 65 -16 16 68 -16 minecraft:glass',
        'fill -16 65 16 16 68 16 minecraft:glass',
        'setblock 12 64 12 minecraft:gold_block',
        'setworldspawn 2 65 -6',
    ];
    const trees = [
        [-8, -8],
        [-8, -2],
        [-8, 4],
        [-8, 10],
        [-2, 10],
        [4, 10],
        [10, 10],
        [10, 4],
        [10, -2],
        [10, -8],
    ];
    for (const [x, z] of trees) {
        commands.push(`fill ${x} 65 ${z} ${x} 68 ${z} minecraft:oak_log`);
        commands.push(
            `fill ${x - 2} 68 ${z - 2} ${x + 2} 69 ${z + 2} minecraft:oak_leaves[persistent=true] replace minecraft:air`,
        );
    }
    const replies = commands.map(cmd => ({ command: cmd, reply: rcon(cmd) }));
    await save(join(suite, 'fixture-commands.json'), replies);
    if (replies.some(row => /unknown|incorrect|failed|not loaded/i.test(row.reply)))
        throw new Error('Fixture command failed; inspect fixture-commands.json');
    rcon('save-all flush');
    dc('stop', 'server');
    const worldHash = await hashTree(join(serverDir, 'world'));
    for (const thinking of ['medium', 'xhigh']) {
        const trial = join(suite, thinking);
        await mkdir(trial, { recursive: true });
        const copied = spawnSync('cp', ['-cR', serverDir, join(trial, 'server')], { encoding: 'utf8' });
        if (copied.status !== 0) throw new Error(copied.stderr);
        const copiedHash = await hashTree(join(trial, 'server/world'));
        if (worldHash !== copiedHash) throw new Error('World copy hash mismatch');
        await mkdir(join(trial, 'state'), { recursive: true, mode: 0o700 });
        const measurement = join(root, 'measurements', `luna-${thinking}-20m-v1`);
        await mkdir(measurement, { recursive: true, mode: 0o700 });
        await save(join(measurement, 'protocol.json'), {
            runId: `luna-${thinking}-20m-v1`,
            createdAt: new Date().toISOString(),
            model: 'openai/gpt-6-luna',
            thinking,
            durationMinutes: 20,
            agent: 'Luna',
            agentStateDir: join(trial, 'state'),
            difficulty: 'peaceful',
            world: 'identical controlled oak-gathering and cabin fixture, seed 2024',
            startingWorldSha256: worldHash,
            objective,
            transcriptOffsets: {},
            telemetryOffset: 0,
            subscriptionSource: 'codex-app get_usage_limits; account-wide',
            requestSource: 'Responses terminal usage; reasoning is a subset of output',
            runOrder: ['medium', 'xhigh'],
            comparisonLimit:
                'one paired run; controlled navigation, gather, craft and build task; no combat or natural exploration',
        });
    }
    await save(join(suite, 'fixture.json'), {
        createdAt: new Date().toISOString(),
        worldHash,
        trees,
        objective,
        runOrder: ['medium', 'xhigh'],
    });
    dc('down');
    console.log('Identical fixture copies ready.');
} else if (action === 'run') {
    if (await stat(join(runDir, 'process.json')).catch(() => null))
        throw new Error('Run already launched; refusing reuse');
    const protocol = JSON.parse(await readFile(join(runDir, 'protocol.json'), 'utf8'));
    if (protocol.model !== model || protocol.thinking !== level || protocol.objective !== objective)
        throw new Error('Launch configuration differs from protocol');
    if ((await hashTree(join(serverDir, 'world'))) !== protocol.startingWorldSha256)
        throw new Error('Trial world differs from frozen start');
    const startedAt = new Date().toISOString();
    const child = spawn(
        'docker',
        [...compose, 'up', '--no-build', '--abort-on-container-exit', '--exit-code-from', 'agent'],
        { env, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    await save(join(runDir, 'process.json'), { startedAt, pid: child.pid, requestedDurationMinutes: 20 });
    for (const stream of [child.stdout, child.stderr])
        stream.on('data', chunk => {
            appendFile(join(runDir, 'run.log'), chunk).catch(console.error);
        });
    let lastStatus;
    const interval = setInterval(async () => {
        try {
            const value = JSON.parse(await readFile(join(stateDir, 'Luna/runtime-status.json'), 'utf8'));
            const encoded = JSON.stringify(value);
            if (encoded !== lastStatus) {
                lastStatus = encoded;
                await appendFile(
                    join(runDir, 'positions.jsonl'),
                    JSON.stringify({ capturedAt: new Date().toISOString(), ...value }) + '\n',
                );
            }
        } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) console.error(error.message);
        }
    }, 1000);
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    child.once('error', error => console.error(error));
    const result = await new Promise(resolve =>
        child.once('exit', (exitCode, signal) => resolve({ exitCode, signal })),
    );
    clearInterval(interval);
    await save(join(runDir, 'process-result.json'), { startedAt, finishedAt: new Date().toISOString(), ...result });
    console.log(JSON.stringify({ runId, ...result }));
    process.exitCode = result.exitCode ?? 1;
} else if (action === 'audit') {
    if (!(await stat(join(runDir, 'process-result.json')).catch(() => null))) throw new Error('Run has not ended');
    await startServer();
    const bot = mineflayer.createBot({
        host: '127.0.0.1',
        port: mcPort,
        username: 'WorldAudit',
        version: '1.21.6',
        auth: 'offline',
    });
    bot.on('error', error => console.error(error.message));
    await new Promise((resolve, reject) => {
        bot.once('spawn', resolve);
        bot.once('error', reject);
        setTimeout(() => reject(new Error('Audit spawn timeout')), 30000).unref();
    });
    rcon('gamemode creative WorldAudit');
    rcon('tp WorldAudit 2 70 2');
    await bot.waitForChunksToLoad();
    await delay(2000);
    const blocks = [];
    for (let y = 65; y <= 68; y++)
        for (let x = 0; x <= 4; x++)
            for (let z = 0; z <= 4; z++) {
                const block = bot.blockAt(new Vec3(x, y, z));
                if (!block) throw new Error(`Unloaded audit block ${x},${y},${z}`);
                blocks.push({ x, y, z, name: block.name, properties: block.getProperties() });
            }
    const at = (x, y, z) => blocks.find(b => b.x === x && b.y === y && b.z === z);
    const arenaMaterialCounts = {};
    const outsideBlueprint = [];
    for (let y = 65; y <= 72; y++)
        for (let x = -16; x <= 16; x++)
            for (let z = -16; z <= 16; z++) {
                const b = bot.blockAt(new Vec3(x, y, z));
                if (!b) throw new Error(`Unloaded arena block ${x},${y},${z}`);
                if (b.name === 'air') continue;
                arenaMaterialCounts[b.name] = (arenaMaterialCounts[b.name] ?? 0) + 1;
                if (
                    !(x >= 0 && x <= 4 && z >= 0 && z <= 4 && y <= 68) &&
                    ['oak_planks', 'oak_door', 'chest', 'crafting_table'].includes(b.name)
                )
                    outsideBlueprint.push({ x, y, z, name: b.name });
            }
    const layer = y => blocks.filter(b => b.y === y);
    const walls = blocks.filter(
        b => [66, 67].includes(b.y) && (b.x === 0 || b.x === 4 || b.z === 0 || b.z === 4) && !(b.x === 2 && b.z === 0),
    );
    let chestItems = [];
    if (at(1, 66, 1).name === 'chest') {
        rcon('tp WorldAudit 2 66 2');
        await delay(500);
        const window = await bot.openContainer(bot.blockAt(new Vec3(1, 66, 1)));
        chestItems = window.containerItems().map(i => ({ name: i.name, count: i.count }));
        window.close();
    }
    bot.quit();
    await delay(1000);
    rcon('save-all flush');
    dc('stop', 'server');
    const uuidBytes = createHash('md5').update('OfflinePlayer:Luna').digest();
    uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x30;
    uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80;
    const h = uuidBytes.toString('hex'),
        uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    const { parsed } = await nbt.parse(await readFile(join(serverDir, 'world/playerdata', uuid + '.dat')));
    const player = nbt.simplify(parsed);
    const inventory = (player.Inventory ?? []).map(i => ({ name: i.id, count: i.count ?? i.Count, slot: i.Slot }));
    const positions = (await readFile(join(runDir, 'positions.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(JSON.parse);
    const interior = blocks.filter(
        b =>
            [66, 67].includes(b.y) &&
            b.x >= 1 &&
            b.x <= 3 &&
            b.z >= 1 &&
            b.z <= 3 &&
            !(b.y === 66 && b.z === 1 && [1, 3].includes(b.x)),
    );
    const lower = at(2, 66, 0),
        upper = at(2, 67, 0);
    let visitStart = null;
    let observedGoldDwellSeconds = 0;
    let goldVisited = false;
    for (const sample of positions) {
        const p = sample.position;
        const onGold = p && Math.floor(p.x) === 12 && Math.floor(p.z) === 12 && Math.abs(p.y - 65) < 0.1;
        if (onGold) {
            goldVisited = true;
            visitStart ??= Date.parse(sample.at);
            observedGoldDwellSeconds = Math.max(observedGoldDwellSeconds, (Date.parse(sample.at) - visitStart) / 1000);
        } else visitStart = null;
    }
    const result = {
        auditedAt: new Date().toISOString(),
        blocks,
        arenaMaterialCounts,
        outsideBlueprint,
        chestItems,
        inventory,
        player: { position: player.Pos, health: player.Health, food: player.foodLevel },
        floor: { correct: layer(65).filter(b => b.name === 'oak_planks').length, required: 25 },
        walls: { correct: walls.filter(b => b.name === 'oak_planks').length, required: 30 },
        roof: { correct: layer(68).filter(b => b.name === 'oak_planks').length, required: 25 },
        door:
            lower.name === 'oak_door' &&
            upper.name === 'oak_door' &&
            lower.properties.half === 'lower' &&
            upper.properties.half === 'upper',
        chest: at(1, 66, 1).name === 'chest',
        craftingTable: at(3, 66, 1).name === 'crafting_table',
        interiorClear: interior.every(b => b.name === 'air'),
        storedOakLogs: chestItems.filter(i => i.name === 'oak_log').reduce((n, i) => n + i.count, 0),
        woodenPickaxe: [...inventory, ...chestItems].some(i => i.name.replace('minecraft:', '') === 'wooden_pickaxe'),
        goldVisited,
        observedGoldDwellSeconds,
        finishedInside:
            player.Pos?.[0] >= 1 &&
            player.Pos?.[0] < 4 &&
            player.Pos?.[2] >= 1 &&
            player.Pos?.[2] < 4 &&
            player.Pos?.[1] >= 66 &&
            player.Pos?.[1] < 67,
        positionSample: positions.at(-1),
        positionSamples: positions.length,
    };
    await save(join(runDir, 'world-audit.json'), result);
    dc('down');
    console.log(JSON.stringify({ ...result, blocks: undefined, positionSample: undefined }, null, 2));
} else throw new Error('Use prepare, clone, run or audit');
