import { choice, integer, text } from './schema.js';
import { workChecks, verifyWork } from '../../work/checks.js';

export function createWork(ctx) {
    const { add, bot, mailbox, peers, perception } = ctx;
    if (mailbox) {
        add(
            'shared_goal',
            'Optionally record or revise the shared objective and agreed facts such as fixed build bounds, materials and interfaces. Any teammate can edit within the human instruction. Use id to change an existing goal. Creating requires title and scope; sourceMessageId or sourceChatId deduplicates a human broadcast. This is shared context, not a permission or action prerequisite.',
            {
                id: integer(1, Number.MAX_SAFE_INTEGER),
                title: text(2000),
                scope: text(2000),
                state: choice(['active', 'completed', 'cancelled']),
                sourceMessageId: integer(1, Number.MAX_SAFE_INTEGER),
                sourceChatId: integer(1, Number.MAX_SAFE_INTEGER),
            },
            args => {
                const source = args.sourceMessageId
                    ? mailbox.messageSource(args.sourceMessageId)
                    : args.sourceChatId
                      ? mailbox.chatSource(args.sourceChatId)
                      : null;
                if (source && [bot.username, ...peers].some(n => n.toLowerCase() === source.sender.toLowerCase()))
                    throw new Error('Use the human instruction as the goal source');
                return mailbox.setGoal(args);
            },
            { required: [] },
        );
        add(
            'work_status',
            "Without arguments, read the full shared goals, teammates' latest activity and observed stockpiles. With status and activity, replace only your own progress report; goalId, blocker and evidence are optional. Report meaningful progress, a handoff or an actual blocker, not every action. Reports do not claim work, assign peers or gate tools; coordinate through DMs. Completion is a report, not independent verification.",
            {
                status: choice(['working', 'blocked', 'idle', 'completed']),
                activity: text(1000),
                goalId: integer(1, Number.MAX_SAFE_INTEGER),
                blocker: text(1000),
                evidence: text(2000),
            },
            args => (Object.keys(args).length ? mailbox.reportWork(args) : mailbox.work()),
            { required: [], idle: true, allowDuringYield: args => Boolean(args.status && args.activity) },
        );
    }
    add(
        'verify',
        'Check actual inventory, shared container contents or blocks/regions in the visible world. Use container checks for shared deliveries and inventory checks for what you personally carry. Spatial checks may walk to safe viewpoints; unobserved is distinct from missing. This tool verifies facts without changing a goal or activity report.',
        { checks: { ...workChecks, minItems: 1 } },
        (args, { bot: active, signal, deadline }) =>
            verifyWork(active, perception, args.checks, {
                signal,
                deadline,
                shouldYield: ctx.shouldYield,
                inspectBlock: (check, signal) => ctx.inspectBlock(active, check, signal),
                inspectContainer: check => ctx.inspectStore(active, check, signal),
            }),
        {
            required: ['checks'],
            body: args => args.checks.some(c => c.kind !== 'inventory'),
            complete: value => value.passed === true,
        },
    );
}
