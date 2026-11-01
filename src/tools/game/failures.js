const codes = new Set([
    'validation',
    'cancellation',
    'timeout',
    'not_visible_or_range',
    'occupied_target',
    'missing_item',
    'missing_support',
    'action_failed',
    'code_error',
    'inner_tool_failed',
    'stuck',
    'drop_ahead',
    'would_fall',
    'too_large',
    'too_far',
    'nothing_broken',
    'unknown',
    'out_of_reach',
    'occluded',
    'no_support',
    'placement_unconfirmed',
    'no_stand_spot',
    'no_path',
    'approach_failed',
    'not_found',
    'no_progress',
    'unchanged_state',
]);

const failures = new WeakMap();

export const failureFacts = new WeakMap();

export function withFailureFacts(value, facts) {
    failureFacts.set(value, facts);
    return value;
}

export const failWith = (code, message, facts) => withFailureFacts(withFailureCode(new Error(message), code), facts);

export function withFailureCode(value, code) {
    failures.set(value, codes.has(code) ? code : 'unknown');
    return value;
}

export function failureCode(value, signal) {
    if (signal?.aborted) return 'cancellation';
    const code = failures.get(value);
    if (codes.has(code)) return code;
    if (value?.name === 'AbortError') return 'cancellation';
    if (value?.name === 'TimeoutError') return 'timeout';
    return 'unknown';
}

export const abortError = message => Object.assign(new Error(message), { name: 'AbortError' });
