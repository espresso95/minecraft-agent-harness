import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { modelAuthPath } from '../src/model/auth.js';
import { findModel } from '../src/model/extra-models.js';

delete process.env.OPENAI_API_KEY;
const { values, positionals } = parseArgs({
    options: { 'state-dir': { type: 'string', default: '.agent-state' } },
    allowPositionals: true,
});
const authPath = modelAuthPath(values['state-dir']);
await mkdir(dirname(authPath), { recursive: true, mode: 0o700 });
const runtime = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false });
const action = positionals[0] ?? 'login';

if (action === 'login') {
    const devicePath = join(dirname(authPath), 'device-id');
    await writeFile(devicePath, randomUUID(), { mode: 0o600, flag: 'wx' }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
    });
    const deviceId = (await readFile(devicePath, 'utf8')).trim();
    const controller = new AbortController();
    process.once('SIGINT', () => controller.abort());
    const input = createInterface({ input: process.stdin, output: process.stdout });
    try {
        await runtime.login(
            'openai',
            'oauth',
            {
                signal: controller.signal,
                prompt: prompt => input.question(`${prompt.message}: `, { signal: prompt.signal }),
                notify: event => {
                    if (event.type === 'auth_url') {
                        console.log('Complete Sign in with ChatGPT in the browser window.');
                        const browser = spawn('open', [event.url], { stdio: 'ignore' });
                        browser.on('error', () => console.log(`Open this sign-in link: ${event.url}`));
                    } else if (event.message) console.log(event.message);
                },
            },
            { agentName: 'Minecraft Agent Harness', getDeviceId: () => deviceId },
        );
        await chmod(authPath, 0o600);
        console.log('ChatGPT subscription connected.');
    } finally {
        input.close();
    }
} else if (action !== 'check' && action !== 'status') {
    throw new Error('Use login, status or check.');
}

if (!runtime.isUsingOAuth('openai')) throw new Error('Run npm run login to connect your ChatGPT subscription.');
console.log('Authentication: ChatGPT subscription (OAuth).');
if (action !== 'status') {
    const model = findModel(runtime, 'openai', 'gpt-6.1-terra');
    if (!model) throw new Error('Terra is missing from the model catalog.');
    const result = await runtime.completeSimple(
        model,
        { messages: [{ role: 'user', content: 'Reply with exactly TERRA_READY', timestamp: Date.now() }] },
        { reasoning: 'low', signal: AbortSignal.timeout(60000) },
    );
    const response = result.content
        .filter(part => part.type === 'text')
        .map(part => part.text)
        .join('');
    if (result.stopReason === 'error' || result.stopReason === 'aborted' || response.trim() !== 'TERRA_READY')
        throw new Error(result.errorMessage || `Terra verification failed (${result.stopReason}).`);
    console.log('Verified: GPT-6.1 Terra completed a request using your subscription.');
}
