import { choice, integer, object, result, text, validate } from './game/schema.js';
import { verifyWork, workChecks } from '../work/checks.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function parameterSchema(schema, depth = 0) {
    if (!schema || depth > 6 || !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(schema.type))
        throw new Error('Use a simple typed JSON parameter schema');
    if (schema.pattern || schema.oneOf || schema.anyOf || schema.$ref)
        throw new Error('Parameter schemas support primitive types, objects, arrays, bounds and enums');
    if (schema.type === 'object')
        return {
            ...schema,
            additionalProperties: false,
            required: schema.required ?? [],
            properties: Object.fromEntries(
                Object.entries(schema.properties ?? {}).map(([k, v]) => [k, parameterSchema(v, depth + 1)]),
            ),
        };
    if (schema.type === 'array')
        return {
            ...schema,
            minItems: schema.minItems ?? 0,
            maxItems: schema.maxItems ?? 1000,
            items: parameterSchema(schema.items, depth + 1),
        };
    return schema;
}
const quote = s => `'${String(s).replaceAll("'", "'\\''")}'`;

export function createSkillTools({
    store,
    workspaceRead,
    runShell,
    bot,
    perception,
    inspectContainer,
    inspectBlock,
    toolList = () => [],
}) {
    let contractHash;
    const contract = () =>
        (contractHash ??= createHash('sha256')
            .update(
                JSON.stringify(
                    toolList()
                        .map(({ name, parameters }) => ({ name, parameters }))
                        .sort((a, b) => a.name.localeCompare(b.name)),
                ),
            )
            .update(readFileSync(new URL('../sandbox/assets/agent_tools.py', import.meta.url)))
            .digest('hex'));
    const tool = (name, description, properties, required, run, idle = false) => ({
        name,
        label: name,
        description,
        parameters: object(properties, required),
        idle,
        async execute(_id, args, signal) {
            try {
                validate(this.parameters, args);
                signal?.throwIfAborted();
                return await run(args, signal);
            } catch (error) {
                return { ...result({ error: error.message }), isError: true };
            }
        },
    });
    const readSource = async (path, signal) => {
        let offset = 0,
            source = '';
        for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
            const response = await workspaceRead.execute('skill-source', { scope: 'shared', path, offset }, signal);
            if (response.isError) throw new Error('Read the program from an accessible shared workspace path');
            const page = JSON.parse(response.content[0].text);
            if (page.totalBytes > 32768) throw new Error('Skill programs are limited to 32 KiB');
            source += page.text;
            if (!page.truncated) return source;
            if (page.nextOffset <= offset) throw new Error('Program changed during registration');
            offset = page.nextOffset;
        }
        throw new Error('Program changed during registration');
    };
    return [
        tool(
            'skill_library',
            'Search/read shared learned Python programs, or register a candidate from an existing shared workspace file. Save parameters as a JSON object schema. Versions are immutable; registration alone does not verify a skill. Retire superseded versions explicitly.',
            {
                action: choice(['search', 'read', 'save', 'retire']),
                query: text(200, 0),
                includeCandidates: { type: 'boolean' },
                id: text(64),
                name: text(48),
                path: text(240),
                description: text(2000),
                parameters: text(8000),
                assumptions: text(2000, 0),
            },
            ['action'],
            async (a, signal) => {
                if (a.action === 'search')
                    return result({ skills: store.search(a.query, a.includeCandidates, contract()) });
                if (a.action === 'read') return result(store.get(a.id, contract()));
                if (a.action === 'retire') return result(store.retire(a.id));
                if (![a.name, a.path, a.description, a.parameters].every(v => typeof v === 'string' && v.trim()))
                    throw new Error('Saving needs name, path, description and parameters');
                if (!a.path.endsWith('.py')) throw new Error('Save a Python program');
                const parameters = parameterSchema(JSON.parse(a.parameters));
                if (parameters.type !== 'object') throw new Error('Program parameters must be an object');
                const source = await readSource(a.path, signal);
                if (source !== (await readSource(a.path, signal)))
                    throw new Error('Program changed during registration');
                const skill = store.save({
                    name: a.name,
                    path: a.path,
                    description: a.description,
                    parameters,
                    assumptions: a.assumptions ?? '',
                    gameVersion: bot.version,
                    source,
                });
                const { source: _source, ...metadata } = store.get(skill.id, contract());
                return result(metadata);
            },
            true,
        ),
        tool(
            'run_skill',
            'Run an exact saved Python version in your existing sandbox through your own tool relay. args is a JSON object string, received by agent_tools.parameters(). Inspect assumptions before reuse. Supply fresh block/inventory checks for this invocation to establish a verified outcome; exit status alone is not proof.',
            { id: text(64), args: text(8000), checks: workChecks, timeoutSec: integer(1, 600) },
            ['id', 'args'],
            async (a, signal) => {
                const skill = store.get(a.id, contract());
                if (skill.retired || skill.gameVersion !== bot.version)
                    throw new Error('Skill is retired or was recorded for a different Minecraft version');
                const args = JSON.parse(a.args);
                validate(skill.parameters, args);
                const bootstrap =
                    'import base64,sys; code=base64.b64decode(sys.argv[1]); path=sys.argv[3]; sys.argv=[path,sys.argv[2]]; exec(compile(code,path,"exec"),{"__name__":"__main__","__file__":path})';
                const cmd = [
                    'python3',
                    '-c',
                    quote(bootstrap),
                    quote(Buffer.from(skill.source).toString('base64')),
                    quote(JSON.stringify(args)),
                    quote(skill.path),
                ].join(' ');
                const execution = await runShell.execute(
                    'skill',
                    { cmd, ...(a.timeoutSec ? { timeoutSec: a.timeoutSec } : {}) },
                    signal,
                );
                const success = !execution.isError && !signal?.aborted;
                const verification = success
                    ? await verifyWork(bot, perception, a.checks ?? [], { inspectContainer, inspectBlock, signal })
                    : {
                          at: new Date().toISOString(),
                          passed: false,
                          checks: [],
                          reason: 'Program did not finish; completion checks were not run',
                      };
                verification.contract = contract();
                const { source: _source, ...metadata } = store.record(skill.id, success, verification, contract());
                return {
                    ...result({ skill: metadata, execution: execution.content, verification }),
                    ...(!success || verification.passed === false ? { isError: true } : {}),
                };
            },
        ),
    ];
}
