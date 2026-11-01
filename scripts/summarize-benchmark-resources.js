import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const runId = process.argv[2];
if (!/^(luna|terra)-(medium|xhigh|max)-20m-v[1-9][0-9]*$/.test(runId ?? '')) throw new Error('Expected run ID');
const dir = resolve('.agent-state/measurements', runId);
const rows = (await readFile(dir + '/resources.jsonl', 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
const memoryBytes = usage => {
    const match = usage.match(/^([\d.]+)([KMGT]?i?B)/);
    if (!match) throw new Error(`Unknown memory unit: ${usage}`);
    const units = {
        B: 1,
        kB: 1e3,
        MB: 1e6,
        GB: 1e9,
        TB: 1e12,
        KiB: 1024,
        MiB: 1024 ** 2,
        GiB: 1024 ** 3,
        TiB: 1024 ** 4,
    };
    return Number(match[1]) * units[match[2]];
};
const names = [...new Set(rows.flatMap(r => r.stats ?? []).map(r => r.Name))];
const containers = Object.fromEntries(
    names.map(name => {
        const samples = rows.flatMap(r => r.stats ?? []).filter(r => r.Name === name);
        return [
            name,
            {
                samples: samples.length,
                peakObservedCpuPercent: Math.max(...samples.map(r => Number.parseFloat(r.CPUPerc))),
                peakObservedMemoryBytes: Math.max(...samples.map(r => memoryBytes(r.MemUsage))),
                peakObservedMemoryPercentOfContainerLimit: Math.max(...samples.map(r => Number.parseFloat(r.MemPerc))),
            },
        ];
    }),
);
const stripAnsi = text => text.replace(/\u001b\[[0-9;]*m/g, '');
const tps = rows
    .filter(r => r.tps)
    .map(r => {
        const match = stripAnsi(r.tps).match(/15m:\s*\*?([\d.]+),\s*\*?([\d.]+),\s*\*?([\d.]+)/);
        if (!match) throw new Error('Unknown TPS reply');
        return match.slice(1).map(Number);
    });
const summary = {
    runId,
    firstSampleAt: rows[0]?.at,
    lastSampleAt: rows.at(-1)?.at,
    sampleCount: rows.length,
    errorSamples: rows.filter(r => r.statsError || r.tpsError).length,
    minimumObservedOneMinuteTPS: tps.length ? Math.min(...tps.map(r => r[0])) : null,
    containers,
    scope: 'Periodic observations after startup; CPU percentages are per virtual CPU, so the four-CPU set can reach 400%. TPS is the server-reported rolling average. Samples do not prove absence of every transient slowdown.',
};
await writeFile(dir + '/resource-summary.json', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(summary));
