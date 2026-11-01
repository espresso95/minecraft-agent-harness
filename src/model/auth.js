import { resolve } from 'node:path';

export function modelAuthPath(stateDir = '.agent-state') {
    return resolve(stateDir, 'auth.json');
}

export function subscriptionProblem(runtime, model, apiKey) {
    if (model.provider === 'claude-code')
        return apiKey || model.baseUrl
            ? 'Claude Code requires native subscription sign-in on the Mac; API keys and alternate endpoints are disabled.'
            : null;
    if (apiKey || model.baseUrl || model.provider !== 'openai' || !runtime.isUsingOAuth('openai'))
        return 'ChatGPT subscription authentication is required. Run npm run login; API-key billing is disabled for this setup.';
    return null;
}
