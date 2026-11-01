import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const runId = process.argv[2] ?? (await readFile('.agent-state/measurements/current-run', 'utf8')).trim();
const dir = resolve('.agent-state/measurements', runId);
const protocol = JSON.parse(await readFile(dir + '/protocol.json', 'utf8'));
const json = async file => {
    try {
        return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
    }
};
const lines = text =>
    text
        .split('\n')
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
let ledger = [];
try {
    ledger = lines(await readFile(dir + '/provider.jsonl', 'utf8'));
} catch (error) {
    if (error.code !== 'ENOENT') throw error;
}
const starts = ledger.filter(row => row.event === 'request_start');
const terminals = ledger.filter(row => row.event === 'response_usage');
const seen = new Set();
const duplicates = [];
const valid = [];
const invalid = [];
for (const row of terminals) {
    const key = row.responseId ?? row.id;
    if (seen.has(key)) {
        duplicates.push(key);
        continue;
    }
    seen.add(key);
    const u = row.usage;
    if (!u || !['input_tokens', 'output_tokens', 'total_tokens'].every(k => Number.isSafeInteger(u[k]) && u[k] >= 0)) {
        invalid.push(row.id);
        continue;
    }
    valid.push(row);
}
const sum = fn => valid.reduce((total, row) => total + fn(row.usage), 0);
const input = sum(u => u.input_tokens);
const cached = sum(u => u.input_tokens_details?.cached_tokens ?? 0);
const cacheWrite = sum(u => u.input_tokens_details?.cache_write_tokens ?? 0);
const output = sum(u => u.output_tokens);
const reasoning = sum(u => u.output_tokens_details?.reasoning_tokens ?? 0);
const total = sum(u => u.total_tokens);
const countMismatch = valid
    .filter(r => r.usage.total_tokens !== r.usage.input_tokens + r.usage.output_tokens)
    .map(r => r.id);

const transcripts = [];
const agentRoot = resolve(protocol.agentStateDir ?? '.agent-state', protocol.agent ?? 'Terra');
const sessionDir = resolve(agentRoot, 'pi-sessions', protocol.agent ?? 'Terra');
for (const file of await readdir(sessionDir)) {
    if (!file.endsWith('.jsonl')) continue;
    const path = resolve(sessionDir, file),
        offset = protocol.transcriptOffsets[path] ?? 0;
    const buffer = await readFile(path);
    for (const entry of lines(buffer.subarray(offset).toString())) {
        if (entry.type === 'message' && entry.message?.role === 'assistant') transcripts.push(entry.message);
    }
}
const transcriptSeen = new Set();
const assistantUsage = transcripts.filter(message => {
    if (!message.responseId || transcriptSeen.has(message.responseId)) return false;
    transcriptSeen.add(message.responseId);
    return true;
});
const sdkInput = assistantUsage.reduce(
    (n, m) => n + (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0),
    0,
);
const sdkOutput = assistantUsage.reduce((n, m) => n + (m.usage?.output ?? 0), 0);
const telemetry = lines(
    (await readFile(resolve(agentRoot, 'telemetry.jsonl'))).subarray(protocol.telemetryOffset).toString(),
);
const tools = telemetry.filter(row => row.event === 'tool');
const firstReady = telemetry.find(row => row.event === 'ready');
const stopped = telemetry.filter(row => row.event === 'stopping').at(-1);
const launch = await json(dir + '/process.json');
const result = await json(dir + '/process-result.json');
const before = await json(dir + '/subscription-before.json');
const after = await json(dir + '/subscription-after.json');
const beforeBucket = before?.rateLimitsByLimitId?.codex ?? before?.rateLimits;
const afterBucket = after?.rateLimitsByLimitId?.codex ?? after?.rateLimits;
const compatibleWindow =
    beforeBucket?.primary?.resetsAt === afterBucket?.primary?.resetsAt &&
    beforeBucket?.primary?.windowDurationMins === afterBucket?.primary?.windowDurationMins;
const creditBalance = bucket => (bucket?.credits?.balance == null ? null : Number(bucket.credits.balance));
const beforeCredits = creditBalance(beforeBucket),
    afterCredits = creditBalance(afterBucket);
const summary = {
    runId,
    updatedAt: new Date().toISOString(),
    status: result ? 'finished' : 'running',
    configuration: {
        model: protocol.model,
        thinking: protocol.thinking,
        durationMinutes: protocol.durationMinutes,
        difficulty: protocol.difficulty,
        world: protocol.world,
        objective: protocol.objective,
    },
    timing: {
        launcherStartedAt: launch?.startedAt,
        gameReadyAt: firstReady?.time,
        gameStoppedAt: stopped?.time,
        gameSeconds: stopped && firstReady ? (Date.parse(stopped.time) - Date.parse(firstReady.time)) / 1000 : null,
        processFinishedAt: result?.finishedAt,
        elapsedSeconds: launch
            ? (Date.parse(result?.finishedAt ?? new Date().toISOString()) - Date.parse(launch.startedAt)) / 1000
            : null,
        processExitCode: result?.exitCode,
        lastLifecycle: stopped,
    },
    tokens: {
        inputIncludingCached: input,
        uncachedInput: input - cached - cacheWrite,
        cachedInput: cached,
        cacheWriteInput: cacheWrite,
        outputIncludingReasoning: output,
        reasoningSubsetOfOutput: reasoning,
        nonReasoningOutput: output - reasoning,
        totalReported: total,
    },
    requests: {
        started: starts.length,
        terminalResponses: terminals.length,
        withValidUsage: valid.length,
        withoutReportedUsage: starts.filter(s => !valid.some(v => v.id === s.id)).length,
        failedBeforeResponse: ledger.filter(e => e.event === 'request_error').length,
        thinkingLevels: Object.fromEntries(
            [...new Set(starts.map(s => s.thinking ?? 'unspecified'))].map(level => [
                level,
                starts.filter(s => (s.thinking ?? 'unspecified') === level).length,
            ]),
        ),
        terminalTypes: Object.fromEntries(
            [...new Set(terminals.map(t => t.terminal))].map(type => [
                type,
                terminals.filter(t => t.terminal === type).length,
            ]),
        ),
    },
    checks: {
        duplicateResponseIds: duplicates,
        invalidUsageIds: invalid,
        arithmeticMismatchIds: countMismatch,
        sdkInputIncludingCached: sdkInput,
        sdkOutput,
        rawMinusSdkInput: input - sdkInput,
        rawMinusSdkOutput: output - sdkOutput,
        missingCachedDetails: valid.filter(v => !v.usage.input_tokens_details).length,
        missingReasoningDetails: valid.filter(v => !v.usage.output_tokens_details).length,
    },
    gameplay: {
        toolCalls: tools.length,
        succeeded: tools.filter(t => t.success).length,
        failed: tools.filter(t => !t.success).length,
        byTool: Object.fromEntries(
            [...new Set(tools.map(t => t.tool))].map(name => [name, tools.filter(t => t.tool === name).length]),
        ),
        modelErrors: telemetry.filter(t => t.event === 'model_error').length,
    },
    subscription: {
        scope: protocol.parallel
            ? 'Account-wide shared before/after snapshots for both parallel Minecraft trials and other account activity; no per-run subscription-meter attribution'
            : 'account-wide; not exclusive to Minecraft',
        before: before
            ? { capturedAt: before.capturedAt, credits: beforeCredits, primary: beforeBucket?.primary }
            : null,
        after: after ? { capturedAt: after.capturedAt, credits: afterCredits, primary: afterBucket?.primary } : null,
        creditBalanceDecrease:
            beforeCredits != null && afterCredits != null ? Number((beforeCredits - afterCredits).toFixed(10)) : null,
        usedPercentPointChange:
            compatibleWindow && afterBucket ? afterBucket.primary.usedPercent - beforeBucket.primary.usedPercent : null,
        sameQuotaWindow: after ? compatibleWindow : null,
        responseQuotaHeadersExposed: ledger
            .filter(l => l.event === 'response_headers')
            .some(l => Object.keys(l.headers).length > 0),
    },
    publishedCreditRateEquivalent: {
        credits:
            protocol.model === 'openai/gpt-6-luna'
                ? ((input - cached) * 2.5 + cached * 0.25 + output * 12.5) / 1e6
                : ((input - cached) * 25 + cached * 1.25 + output * 125) / 1e6,
        scope: 'Rate-card equivalent of reported tokens; not a measurement of included subscription allowance or actual debit',
        ratesPerMillion:
            protocol.model === 'openai/gpt-6-luna'
                ? { uncachedInput: 2.5, cachedInput: 0.25, output: 12.5 }
                : { uncachedInput: 25, cachedInput: 1.25, output: 125 },
        source: 'https://learn.chatgpt.com/docs/pricing',
    },
};
await writeFile(dir + '/summary.json', JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
const requestRows = [
    'request_id,response_id,completed_at,terminal,input_tokens,cached_input_tokens,output_tokens,reasoning_tokens,total_tokens',
];
for (const row of valid)
    requestRows.push(
        [
            row.id,
            row.responseId,
            row.at,
            row.terminal,
            row.usage.input_tokens,
            row.usage.input_tokens_details?.cached_tokens ?? '',
            row.usage.output_tokens,
            row.usage.output_tokens_details?.reasoning_tokens ?? '',
            row.usage.total_tokens,
        ].join(','),
    );
await writeFile(dir + '/requests.csv', requestRows.join('\n') + '\n', { mode: 0o600 });
console.log(
    JSON.stringify(
        {
            status: summary.status,
            elapsedSeconds: summary.timing.elapsedSeconds,
            requests: summary.requests,
            tokens: summary.tokens,
            checks: summary.checks,
            gameplay: summary.gameplay,
            subscription: summary.subscription,
            creditRateEquivalent: summary.publishedCreditRateEquivalent.credits,
        },
        null,
        2,
    ),
);
