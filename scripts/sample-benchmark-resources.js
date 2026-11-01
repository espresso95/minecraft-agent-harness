import { spawnSync } from 'node:child_process';
import { appendFile, readFile, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const env = {
    ...process.env,
    DOCKER_HOST: process.env.DOCKER_HOST ?? `unix://${homedir()}/.colima/default/docker.sock`,
};
const ids = ['luna-xhigh-20m-v2', 'luna-max-20m-v1'];
const trials = await Promise.all(
    ids.map(async runId => {
        const dir = resolve('.agent-state/measurements', runId);
        return { dir, protocol: JSON.parse(await readFile(dir + '/protocol.json', 'utf8')) };
    }),
);
function docker(args) {
    const p = spawnSync('docker', args, { env, encoding: 'utf8', timeout: 10000 });
    return p.status === 0
        ? { output: p.stdout.trim() }
        : { error: (p.stderr || p.error?.message || 'Docker failed').slice(0, 500) };
}
for (const trial of trials) {
    const names = ['server', 'agent'].map(service => `${trial.protocol.composeProject}-${service}-1`);
    const inspected = docker(['inspect', '--format', '{{json .HostConfig}}', ...names]);
    const configs = inspected.output?.split('\n').map((line, i) => {
        const c = JSON.parse(line);
        return { name: names[i], cpuSet: c.CpusetCpus, memoryBytes: c.Memory };
    });
    await writeFile(
        trial.dir + '/resource-allocation.json',
        JSON.stringify({ capturedAt: new Date().toISOString(), configs, error: inspected.error }, null, 2) + '\n',
        { mode: 0o600 },
    );
}
while (true) {
    const ended = await Promise.all(
        trials.map(t =>
            stat(t.dir + '/process-result.json')
                .then(() => true)
                .catch(() => false),
        ),
    );
    if (ended.every(Boolean)) break;
    const stats = docker(['stats', '--no-stream', '--format', '{{json .}}']);
    const rows = stats.output
        ?.split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    for (let i = 0; i < trials.length; i++) {
        if (ended[i]) continue;
        const trial = trials[i];
        const tps = docker(['exec', `${trial.protocol.composeProject}-server-1`, 'rcon-cli', 'tps']);
        const sample = {
            at: new Date().toISOString(),
            stats: rows?.filter(row => row.Name.startsWith(trial.protocol.composeProject + '-')),
            statsError: stats.error,
            tps: tps.output ?? null,
            tpsError: tps.error,
        };
        await appendFile(trial.dir + '/resources.jsonl', JSON.stringify(sample) + '\n', { mode: 0o600 });
    }
    await delay(30000);
}
console.log('Resource sampling finished.');
