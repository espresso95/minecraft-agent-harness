import { registerClaudeCode } from './model/claude-code.js';
import { compactResult } from './model/session.js';
import { findModel } from './model/extra-models.js';
import { subscriptionProblem } from './model/auth.js';

export const EXIT = Object.freeze({ ok: 0, error: 1, usage: 2, fatalKick: 3, reconnect: 75 });

export const MAX_RECONNECTS = 8;
export function reconnectDelay(attempt) {
    return Math.min(60000, 5000 * 2 ** Math.max(0, attempt - 1));
}

const KEY_ENV = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GEMINI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    xai: 'XAI_API_KEY',
    groq: 'GROQ_API_KEY',
    mistral: 'MISTRAL_API_KEY',
    deepseek: 'DEEPSEEK_API_KEY',
};

export function keyEnvFor(provider) {
    return (
        KEY_ENV[provider] ??
        `${String(provider)
            .toUpperCase()
            .replace(/[^A-Z0-9]/g, '_')}_API_KEY`
    );
}

export async function checkModel(config, { sdk, modelRequest } = {}) {
    if (config.model.baseUrl && !config.subscriptionOnly && config.model.provider !== 'claude-code') {
        if (!config.apiKey && !process.env.MODEL_API_KEY)
            return `--base-url needs a key: set MODEL_API_KEY in .env or the environment.`;
        return null;
    }
    const { ModelRuntime } = sdk ?? (await import('@earendil-works/pi-coding-agent'));
    const runtime = await ModelRuntime.create({
        authPath: config.authPath,
        modelsPath: config.modelsPath ?? null,
        allowModelNetwork: false,
    });
    const { provider, id } = config.model;
    if (config.subscriptionOnly || provider === 'claude-code') {
        const problem = subscriptionProblem(runtime, config.model, config.apiKey);
        if (problem) return problem;
    }
    if (provider === 'claude-code') {
        try {
            await registerClaudeCode(runtime, modelRequest);
        } catch (error) {
            return error.message;
        }
    }
    if (!runtime.getProviders().some(p => p.id === provider))
        return `Unknown provider "${provider}". Run "minecraft-agent models" to see providers with keys set, or "minecraft-agent models --all".`;
    if (!findModel(runtime, provider, id))
        return `Unknown model ${provider}/${id}. Run "minecraft-agent models ${provider}" to list its models.`;
    if (!config.apiKey && !runtime.hasConfiguredAuth(provider))
        return `No API key for ${provider}. Set ${keyEnvFor(provider)} in .env (copy .env.example) or export it.`;
    return null;
}

function flatten(component) {
    if (component == null) return '';
    if (typeof component === 'string') return component;
    if (Array.isArray(component)) return component.map(flatten).join('');
    const own =
        component.text ?? (component.translate ? (TRANSLATIONS[component.translate] ?? component.translate) : '');
    return `${own}${(component.extra ?? []).map(flatten).join('')}${component.with && !component.text && !TRANSLATIONS[component.translate] ? ` ${component.with.map(flatten).join(' ')}` : ''}`;
}

const TRANSLATIONS = {
    'multiplayer.disconnect.flying': 'Flying is not enabled on this server',
    'multiplayer.disconnect.kicked': 'Kicked by an operator',
    'multiplayer.disconnect.banned': 'You are banned from this server',
    'multiplayer.disconnect.not_whitelisted': 'You are not white-listed on this server',
    'multiplayer.disconnect.duplicate_login': 'You logged in from another location',
    'multiplayer.disconnect.server_shutdown': 'Server closed',
    'multiplayer.disconnect.idling': 'You have been idle for too long',
    'disconnect.timeout': 'Timed out',
};

export function kickText(reason) {
    if (reason == null) return 'no reason given';
    let value = reason;
    if (typeof reason === 'string') {
        try {
            value = JSON.parse(reason);
        } catch {
            return reason;
        }
    }
    if (value && typeof value === 'object' && 'type' in value && 'value' in value) value = simplifyNbt(value);
    const text = flatten(value).trim();
    if (text) return text;
    const raw = typeof reason === 'string' ? reason : JSON.stringify(reason);
    return raw && raw !== '{}' && raw !== '""' ? raw.slice(0, 200) : 'no reason given';
}

function simplifyNbt(node) {
    if (node == null || typeof node !== 'object') return node;
    if ('type' in node && 'value' in node) {
        if (node.type === 'compound')
            return Object.fromEntries(Object.entries(node.value).map(([k, v]) => [k, simplifyNbt(v)]));
        if (node.type === 'list')
            return (node.value?.value ?? []).map(v => simplifyNbt({ type: node.value.type, value: v }));
        return node.value;
    }
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, simplifyNbt(v)]));
}

const FATAL_KICK =
    /\bban(ned)?\b|white-?list|not authenticated|invalid session|failed to verify username|outdated (client|server)|incompatible|another location|duplicate.?login|game over/i;

export function isFatalKick(text) {
    return FATAL_KICK.test(String(text));
}

export function connectionMessage(error, host, port) {
    const code = error?.code;
    if (code === 'ECONNREFUSED')
        return `Cannot connect to ${host}:${port} (connection refused). Is the server running? For a local test server run "npm run server".`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Cannot resolve host "${host}" (${code}). Check --host.`;
    if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH')
        return `Cannot reach ${host}:${port} (${code}). Check the address and any firewall.`;
    if (code === 'ECONNRESET') return `Connection to ${host}:${port} was reset.`;
    return `Connection to ${host}:${port} failed: ${String(error?.message ?? error).split('\n')[0]}`;
}

export function shortJson(value, max = 120) {
    let s;
    try {
        s = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
        s = String(value);
    }
    s = String(s ?? '').replace(/\s+/g, ' ');
    return s.length > max ? `${s.slice(0, max - 3)}...` : s;
}

export function summarizeResult(text, max = 140) {
    return shortJson(compactResult(text, Infinity), max);
}

export function activityLine(event) {
    const mark = event.success ? '>' : 'x';
    const secs = `${(Number(event.timeMs ?? 0) / 1000).toFixed(1)}s`;
    const args = event.args && event.args !== '{}' ? ` ${shortJson(event.args, 90)}` : '';
    const outcome = event.success ? 'ok' : `failed${event.failureCode ? ` (${event.failureCode})` : ''}`;
    const result = event.result ? `: ${summarizeResult(event.result, event.success ? 120 : 200)}` : '';
    return `${mark} ${event.tool}${args} ${outcome} ${secs}${result}`;
}
