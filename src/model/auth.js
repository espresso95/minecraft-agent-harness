import { resolve } from 'node:path';

export function modelAuthPath(stateDir = '.agent-state') {
    return resolve(stateDir, 'auth.json');
}

export function subscriptionProblem(runtime, model, apiKey) {
    if (apiKey || model.baseUrl || model.provider !== 'openai' || !runtime.isUsingOAuth('openai'))
        return 'ChatGPT subscription authentication is required. Run npm run login; API-key billing is disabled for this setup.';
    return null;
}
