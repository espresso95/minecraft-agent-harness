import { spawnSync } from 'node:child_process';
import { appendFile, stat, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
const level = process.argv[2];
const family = process.argv[3] ?? 'luna';
const revision = process.argv[4] ?? 'v1';
if (!/^v[1-9][0-9]*$/.test(revision)) throw new Error('Invalid revision');
if (!['luna', 'terra'].includes(family)) throw new Error('Expected luna or terra');
if (!['medium', 'xhigh', 'max'].includes(level)) throw new Error('Expected medium, xhigh or max');
const dir = resolve('.agent-state/measurements', `${family}-${level}-20m-${revision}`);
const protocol = JSON.parse(await readFile(dir + '/protocol.json', 'utf8'));
const project = protocol.composeProject ?? 'minecraft-luna-benchmark';
const serverDir = protocol.serverDir ?? resolve(`.agent-state/benchmarks/${family}-medium-xhigh`, level, 'server');
const env = {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${homedir()}/.colima/default/docker.sock`,
};
const properties = await readFile(resolve(serverDir, 'server.properties'), 'utf8');
const password = properties.match(/^rcon.password=(.*)$/m)[1];
const inspect = spawnSync(
    'docker',
    ['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', project + '-server-1'],
    { env, encoding: 'utf8' },
);
if (inspect.status !== 0) throw new Error('Server unavailable');
const host = inspect.stdout.trim();
const reader = `import {Rcon} from '/app/examples/bedwars/rcon.mjs';
let raw='';for await(const chunk of process.stdin)raw+=chunk;
const {host,password,commands}=JSON.parse(raw);const client=new Rcon({host,password});
const replies={};try {for(const [key,command]of Object.entries(commands))replies[key]=await client.send(command);console.log(JSON.stringify(replies));}finally{client.close();}`;
const conditions = { floor: [], walls: [], roof: [], fittings: [] };
for (let x = 0; x <= 4; x++)
    for (let z = 0; z <= 4; z++) {
        conditions.floor.push([x, 65, z, 'oak_planks']);
        conditions.roof.push([x, 68, z, 'oak_planks']);
        if ((x === 0 || x === 4 || z === 0 || z === 4) && !(x === 2 && z === 0))
            for (const y of [66, 67]) conditions.walls.push([x, y, z, 'oak_planks']);
    }
conditions.fittings.push(
    [2, 66, 0, 'oak_door[half=lower]'],
    [2, 67, 0, 'oak_door[half=upper]'],
    [1, 66, 1, 'chest'],
    [3, 66, 1, 'crafting_table'],
);
while (!(await stat(dir + '/process-result.json').catch(() => null))) {
    const sample = { at: new Date().toISOString() };
    const commands = Object.fromEntries(
        Object.entries(conditions).map(([group, cells]) => [
            group,
            'execute ' + cells.map(([x, y, z, block]) => `if block ${x} ${y} ${z} minecraft:${block}`).join(' '),
        ]),
    );
    const result = spawnSync(
        'docker',
        ['exec', '-i', project + '-agent-1', 'node', '--input-type=module', '-e', reader],
        { env, encoding: 'utf8', input: JSON.stringify({ host, password, commands }), timeout: 15000 },
    );
    if (result.status === 0) {
        const replies = JSON.parse(result.stdout.trim());
        for (const group of Object.keys(conditions)) sample[group] = replies[group].includes('Test passed');
    } else {
        sample.error = (result.stderr || result.error?.message || 'Reader failed').slice(0, 200);
    }
    await appendFile(dir + '/world-samples.jsonl', JSON.stringify(sample) + '\n', { mode: 0o600 });
    await delay(15000);
}
console.log('World sampling finished.');
