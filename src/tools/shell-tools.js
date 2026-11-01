const DEFAULTS = { timeoutMs: 120000, maxTimeoutMs: 600000, outputBytes: 32768 };

export function createShellTools({
    backend,
    invoke,
    toolList,
    stopActions = async () => {},
    limits: overrides = {},
    log = () => {},
}) {
    if (!backend || typeof invoke !== 'function' || typeof toolList !== 'function')
        throw new Error('backend, invoke and toolList required');
    const limits = { ...DEFAULTS, ...overrides };
    let starting = null,
        started = false,
        failures = 0;
    const blocked = new Set(['run_shell', 'run_skill', 'run_code', 'run_tool', 'session_history']);
    const guardedInvoke = (name, args) =>
        blocked.has(name)
            ? Promise.reject(new Error(`Tool ${name} cannot be called from the shell.`))
            : invoke(name, args);
    async function ensure() {
        if (started) return;
        starting ??= backend
            .start({
                invoke: guardedInvoke,
                log,
                tools: toolList()
                    .filter(t => !blocked.has(t.name))
                    .map(t => ({ name: t.name, description: t.description, parameters: t.parameters })),
            })
            .then(() => {
                started = true;
                failures = 0;
            })
            .catch(e => {
                starting = null;
                throw e;
            });
        await starting;
    }
    const description = `Run a bash command in YOUR persistent Linux sandbox (${backend.kind}; python3, node, curl, git available; files persist across calls). \`tool <name> '<json args>'\` prints JSON; discover schemas with \`tool --list\` and \`tool --help <name>\`. In Python: \`from agent_tools import call, checkpoint, parameters\`. \`call("inventory")\` returns data; \`call("place_line", **args)\` runs an action. \`checkpoint(task_id, note)\` takes exactly two arguments, fetches the current revision and saves progress on your claimed task; do not pass a revision. \`parameters()\` reads run_skill JSON inputs. Stop on errors or yielded results and verify partial progress before resuming. Save scripts to ~/bin (private) or $SHARED_TOOLS (shared). Each inner call counts toward your tool budget. Output capped at ${limits.outputBytes} bytes; default timeout ${limits.timeoutMs / 1000}s (timeoutSec up to ${limits.maxTimeoutMs / 1000}).`;
    return [
        {
            name: 'run_shell',
            label: 'run_shell',
            description,
            parameters: {
                type: 'object',
                properties: {
                    cmd: { type: 'string', maxLength: 32768 },
                    timeoutSec: { type: 'integer', minimum: 1, maximum: limits.maxTimeoutMs / 1000 },
                },
                required: ['cmd'],
                additionalProperties: false,
            },
            async execute(_id, args, signal) {
                let executing = false;
                const cmd = args?.cmd;
                if (typeof cmd !== 'string' || !cmd.trim())
                    return {
                        content: [{ type: 'text', text: 'cmd required.' }],
                        details: { ok: false },
                        isError: true,
                    };
                const timeoutMs = Math.min(
                    limits.maxTimeoutMs,
                    Math.max(1000, (Number(args?.timeoutSec) || limits.timeoutMs / 1000) * 1000),
                );
                try {
                    let r;
                    try {
                        await ensure();
                    } catch (error) {
                        if (signal?.aborted) throw error;
                        log(
                            `run_shell: rebuilding sandbox after error: ${String(error?.message ?? error).slice(0, 300)}`,
                        );
                        started = false;
                        starting = null;
                        try {
                            await backend.close();
                        } catch {}
                        await ensure();
                    }
                    // Once execution starts, a lost response must not replay game mutations.
                    executing = true;
                    r = await backend.run(cmd, { timeoutMs, signal, outputBytes: limits.outputBytes });
                    if (r.timedOut || signal?.aborted) await stopActions();
                    executing = false;
                    const text =
                        [
                            r.stdout,
                            r.stderr ? `[stderr]\n${r.stderr}` : '',
                            r.exitCode !== 0 ? `[exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}]` : '',
                        ]
                            .filter(Boolean)
                            .join('\n') || '[exit 0, no output]';
                    return {
                        content: [{ type: 'text', text }],
                        details: { ok: r.exitCode === 0, result: r },
                        isError: r.exitCode !== 0,
                    };
                } catch (error) {
                    if (executing) await stopActions();
                    failures++;
                    log(`run_shell failure ${failures}: ${String(error?.message ?? error)}`);
                    started = false;
                    starting = null;
                    try {
                        await backend.close();
                    } catch {}
                    return {
                        content: [
                            {
                                type: 'text',
                                text: `Shell unavailable: ${String(error?.message ?? error).slice(0, 1000)}`,
                            },
                        ],
                        details: { ok: false },
                        isError: true,
                    };
                }
            },
            async close() {
                started = false;
                starting = null;
                await backend.close();
            },
        },
    ];
}
