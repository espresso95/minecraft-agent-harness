import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const runs = [];
const all = process.argv.includes('--all');
const followups = process.argv.includes('--luna-followups');
const allTrials = process.argv.includes('--all-trials');
const families = all || allTrials ? ['luna', 'terra'] : [followups ? 'luna' : (process.argv[2] ?? 'luna')];
if (families.some(f => !['luna', 'terra'].includes(f))) throw new Error('Use luna, terra or --all');
for (const family of families) {
    const trials = [
        ['medium', 'v1'],
        ['xhigh', 'v1'],
    ];
    if ((followups || allTrials) && family === 'luna') trials.push(['xhigh', 'v2'], ['max', 'v1']);
    for (const [thinking, revision] of trials) {
        const runId = `${family}-${thinking}-20m-${revision}`;
        const dir = resolve('.agent-state/measurements', runId);
        const read = async name => JSON.parse(await readFile(resolve(dir, name + '.json'), 'utf8'));
        const [protocol, usage, audit, checks] = await Promise.all(
            ['protocol', 'summary', 'world-audit', 'independent-checks'].map(read),
        );
        const resources = protocol.parallel ? await read('resource-summary') : null;
        const containerExitStates = protocol.parallel ? await read('container-exit-states') : null;
        assert.equal(usage.status, 'finished');
        assert.equal(checks.verified, true);
        assert.equal(usage.requests.thinkingLevels[thinking], usage.requests.started);
        assert.equal(usage.timing.lastLifecycle.reason, 'deadline');
        assert.ok(usage.timing.gameSeconds >= 1190 && usage.timing.gameSeconds <= 1210);
        const p = audit.player.position;
        const goals = {
            floor: audit.floor.correct === 25,
            walls: audit.walls.correct === 30,
            roof: audit.roof.correct === 25,
            door: audit.door,
            chest: audit.chest,
            craftingTable: audit.craftingTable,
            interiorClear: audit.interiorClear,
            eightRawOakLogsStored: audit.storedOakLogs >= 8,
            woodenPickaxe: audit.woodenPickaxe,
            goldCheckpoint: audit.goldVisited && audit.observedGoldDwellSeconds >= 5,
            finishedAtTarget: Math.floor(p[0]) === 2 && Math.floor(p[1]) === 66 && Math.floor(p[2]) === 2,
            notesAtRequestedPath: checks.notesAtRequestedPath,
        };
        runs.push({
            runId,
            family,
            thinking,
            revision,
            model: protocol.model,
            parallel: protocol.parallel ?? false,
            parallelResources: protocol.parallelResources ?? null,
            harnessImageId: protocol.harnessImageId ?? null,
            maxConfigChange: protocol.maxConfigChange ?? null,
            resources,
            containerExitStates,
            worldHash: protocol.startingWorldSha256,
            objective: protocol.objective,
            timing: usage.timing,
            tokens: usage.tokens,
            requests: usage.requests,
            tools: checks.tools,
            toolCountScope: checks.toolCountScope,
            nonShellTools: checks.nonShellTools,
            failureCodes: checks.failureCodes,
            failedToolSeconds: checks.failedToolWallSecondsUnion,
            failedToolTimeScope: checks.toolTimingScope,
            requestSeconds: checks.requestSeconds,
            goals,
            fullTaskComplete: Object.values(goals).every(Boolean),
            world: {
                floor: audit.floor,
                walls: audit.walls,
                roof: audit.roof,
                door: audit.door,
                chest: audit.chest,
                craftingTable: audit.craftingTable,
                storedOakLogs: audit.storedOakLogs,
                chestItems: audit.chestItems,
                woodenPickaxe: audit.woodenPickaxe,
                finishedInside: audit.finishedInside,
                outsideBlueprint: audit.outsideBlueprint,
                arenaMaterialCounts: audit.arenaMaterialCounts,
                inventory: audit.inventory,
                player: audit.player,
                goldDwellSeconds: audit.observedGoldDwellSeconds,
            },
            oakLogsGathered: checks.successfulOakLogsGathered,
            oakPlanksCrafted: checks.oakPlanksCrafted,
            subscription: usage.subscription,
            publishedCreditRateEquivalent: usage.publishedCreditRateEquivalent,
            apiStandardEquivalentUSD: Number(checks.apiStandardEquivalentUSD),
            costScope:
                'Standard token-rate equivalents of reported usage; not actual subscription debits or included allowance',
            evidence: {
                protocol: resolve(dir, 'protocol.json'),
                summary: resolve(dir, 'summary.json'),
                worldAudit: resolve(dir, 'world-audit.json'),
                independentChecks: resolve(dir, 'independent-checks.json'),
                ...(protocol.parallel
                    ? {
                          resources: resolve(dir, 'resource-summary.json'),
                          containerExitStates: resolve(dir, 'container-exit-states.json'),
                      }
                    : {}),
            },
        });
    }
}
for (const run of runs) {
    assert.equal(runs[0].worldHash, run.worldHash);
    assert.equal(runs[0].objective, run.objective);
}
const result = {
    createdAt: new Date().toISOString(),
    models: [...new Set(runs.map(r => r.model))],
    displayOrder: runs.map(r => r.runId),
    runOrder: [...runs]
        .sort((a, b) => Date.parse(a.timing.gameReadyAt) - Date.parse(b.timing.gameReadyAt))
        .map(r => r.runId),
    parallelGroups: followups || allTrials ? [['luna-xhigh-20m-v2', 'luna-max-20m-v1']] : [],
    durationMinutesEach: 20,
    startingWorldsIdentical: true,
    runs,
    reportedTokenRatiosWithinModel: Object.fromEntries(
        families.map(f => [
            f,
            runs.find(r => r.family === f && r.thinking === 'xhigh').tokens.totalReported /
                runs.find(r => r.family === f && r.thinking === 'medium').tokens.totalReported,
        ]),
    ),
    limitations: [
        'One trial per model and reasoning setting, except Luna xhigh has two when followups are included. This is a small controlled peaceful navigation, gathering, crafting and building experiment.',
        ...(followups || allTrials
            ? [
                  'The new Luna xhigh repeat and max ran in parallel on separate four-core CPU sets in an eight-core, 12 GiB VM. Earlier trials were sequential. Shared provider quota, caching and background activity may differ.',
              ]
            : []),
        'Does not assess combat, natural terrain exploration, or visual keyboard and mouse control.',
        'Reported tokens exclude any request with no terminal usage; those requests remain unknown.',
        'Subscription counters are account-wide, do not identify Minecraft usage, and cannot establish exact subscription fraction.',
        'Tool success may include partial results; saved-world blocks and inventories control goal completion.',
        'Logged tool counts may include both shell wrappers and nested game calls; they are not a count of model decisions or primitive block actions. Tool wall time uses the union of intervals to avoid overlapping time.',
    ],
};
await mkdir('results', { recursive: true });
const output = allTrials ? 'all-trials' : followups ? 'luna-followup' : all ? 'model' : families[0];
await writeFile(`results/${output}-comparison.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
