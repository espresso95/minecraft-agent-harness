import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { findModel, extraModelIds } from '../model/extra-models.js';
import { defaultProfile } from './profiles.js';
import { subscriptionProblem } from '../model/auth.js';

export function modelCatalog(models) {
    const choices = models.map(model => ({
        id: model.provider + '/' + model.id,
        name: model.name,
        efforts: getSupportedThinkingLevels(model),
    }));
    return {
        snapshot: () => ({ models: choices, defaults: defaultProfile }),
        validate(config) {
            const model = choices.find(m => m.id === config.model.provider + '/' + config.model.id);
            if (!model) throw new Error('Choose a model from the connected provider catalog');
            if (!model.efforts.includes(config.thinking))
                throw new Error('This model does not support that thinking level');
        },
    };
}

export async function connectedModelCatalog(authFile) {
    const runtime = await ModelRuntime.create({ authPath: authFile, modelsPath: null, allowModelNetwork: false });
    // This installation is subscription-only. Model metadata supplies the UI and validation together.
    const problem = subscriptionProblem(runtime, { provider: 'openai' });
    if (problem) throw new Error(problem);
    const models = [
        ...runtime.getModels('openai'),
        ...extraModelIds(runtime, 'openai').map(id => findModel(runtime, 'openai', id)),
    ];
    return modelCatalog(models);
}
