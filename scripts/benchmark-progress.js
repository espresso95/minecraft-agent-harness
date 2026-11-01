import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const level = process.argv[2] ?? 'medium';
const family = process.argv[3] ?? 'luna';
const revision = process.argv[4] ?? 'v1';
if (!/^v[1-9][0-9]*$/.test(revision)) throw new Error('Invalid revision');
if (!['luna', 'terra'].includes(family)) throw new Error('Expected luna or terra');
if (!['medium', 'xhigh', 'max'].includes(level)) throw new Error('Expected medium, xhigh or max');
const dir = resolve('.agent-state/measurements', `${family}-${level}-20m-${revision}`);
const protocol = JSON.parse(await readFile(dir + '/protocol.json', 'utf8'));
const lines = async file => {
    try {
        return (await readFile(file, 'utf8'))
            .split('\n')
            .filter(Boolean)
            .flatMap(line => {
                try {
                    return [JSON.parse(line)];
                } catch {
                    return [];
                }
            });
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
};
const ledger = await lines(dir + '/provider.jsonl');
const telemetry = await lines(resolve(protocol.agentStateDir, 'Luna/telemetry.jsonl'));
const samples = await lines(dir + '/positions.jsonl');
const ready = telemetry.find(t => t.event === 'ready');
const tools = telemetry.filter(t => t.event === 'tool');
const usages = ledger.filter(t => t.event === 'response_usage');
console.log(
    JSON.stringify(
        {
            level,
            family,
            revision,
            gameSeconds: ready ? (Date.now() - Date.parse(ready.time)) / 1000 : null,
            requests: ledger.filter(t => t.event === 'request_start').length,
            completed: usages.length,
            totalTokens: usages.reduce((n, t) => n + t.usage.total_tokens, 0),
            output: usages.reduce((n, t) => n + t.usage.output_tokens, 0),
            reasoning: usages.reduce((n, t) => n + (t.usage.output_tokens_details?.reasoning_tokens ?? 0), 0),
            tools: {
                total: tools.length,
                success: tools.filter(t => t.success).length,
                failed: tools.filter(t => !t.success).length,
            },
            recentTools: tools.slice(-2).map(t => ({
                tool: t.tool,
                success: t.success,
                args: t.args?.slice(0, 180),
                result: t.result?.slice(0, 220),
                failureCode: t.failureCode,
                ms: t.ms,
            })),
            status: samples.at(-1),
            errors: telemetry.filter(t => t.event === 'model_error' || t.event === 'stopping'),
        },
        null,
        2,
    ),
);
