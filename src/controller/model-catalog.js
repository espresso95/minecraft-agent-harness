import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { claudeModels } from '../model/claude-code.js';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { findModel, extraModelIds } from '../model/extra-models.js';
import { defaultProfile } from './profiles.js';
import { subscriptionProblem } from '../model/auth.js';

export function modelCatalog(models) {
    let choices;
    const update = () =>
        (choices = models.map(model => ({
            id: model.provider + '/' + model.id,
            name: model.name,
            efforts: getSupportedThinkingLevels(model),
        })));
    update();
    return {
        setClaude(entries) {
            models = [...models.filter(m => m.provider !== 'claude-code'), ...claudeModels(entries)];
            update();
        },
        snapshot: () => ({
            models: choices,
            defaults: defaultProfile,
            version: createHash('sha256').update(JSON.stringify(choices)).digest('hex'),
        }),
        validate(config) {
            const model = choices.find(m => m.id === config.model.provider + '/' + config.model.id);
            if (!model) throw new Error('Choose a model from the connected provider catalog');
            if (!model.efforts.includes(config.thinking))
                throw new Error('This model does not support that thinking level');
        },
    };
}

export async function connectedModelCatalog(authFile, claudeFile) {
    const runtime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, allowModelNetwork: false });
    // This installation is subscription-only. Model metadata supplies the UI and validation together.
    const problem = subscriptionProblem(runtime, { provider: 'openai' });
    if (problem) throw new Error(problem);
    const models = [
        ...runtime.getModels('openai'),
        ...extraModelIds(runtime, 'openai').map(id => findModel(runtime, 'openai', id)),
    ];
    const catalog = modelCatalog(models);
    if (claudeFile) {
        try {
            catalog.setClaude(JSON.parse(await readFile(claudeFile, 'utf8')));
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
    }
    return catalog;
}
