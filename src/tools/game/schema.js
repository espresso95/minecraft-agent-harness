export const text = (maxLength = 128, minLength = 1) => ({ type: 'string', minLength, maxLength });

export const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });

export const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });

export const choice = values => ({ type: 'string', enum: values });

export const coords = { x: integer(-29999999, 29999999), y: integer(-64, 319), z: integer(-29999999, 29999999) };
export const position = { x: number(-29999999, 29999999), y: number(-64, 319), z: number(-29999999, 29999999) };

export const count = integer(1, 64);

export const name = { ...text(64), pattern: '^[a-z0-9_]+$' };

export const peer = { ...text(16), pattern: '^[A-Za-z0-9_]+$' };

export const object = (properties, required = Object.keys(properties)) => ({
    type: 'object',
    properties: { ...properties },
    required,
    additionalProperties: false,
});

export function validate(schema, value, path = 'arguments') {
    if (schema.anyOf) {
        const errors = [];
        for (const variant of schema.anyOf) {
            try {
                validate(variant, value, path);
                return;
            } catch (error) {
                errors.push(error.message);
            }
        }
        throw new Error(`${path} does not match an allowed form: ${errors.join('; ')}`);
    }
    if (schema.type === 'object') {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
        for (const key of schema.required) if (!(key in value)) throw new Error(`${path}.${key} is required`);
        for (const [key, v] of Object.entries(value)) {
            if (!Object.hasOwn(schema.properties, key)) throw new Error(`Unknown argument ${path}.${key}`);
            validate(schema.properties[key], v, `${path}.${key}`);
        }
    } else if (schema.type === 'string') {
        if (
            typeof value !== 'string' ||
            value.length < (schema.minLength ?? 0) ||
            value.length > (schema.maxLength ?? Infinity) ||
            (schema.pattern && !new RegExp(schema.pattern).test(value))
        )
            throw new Error(`Invalid ${path}`);
    } else if (schema.type === 'boolean') {
        if (typeof value !== 'boolean') throw new Error(`Invalid ${path}`);
    } else if (schema.type === 'array') {
        if (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems)
            throw new Error(`Invalid ${path}`);
        value.forEach((v, i) => validate(schema.items, v, `${path}[${i}]`));
    } else if (
        !Number.isFinite(value) ||
        value < schema.minimum ||
        value > schema.maximum ||
        (schema.type === 'integer' && !Number.isSafeInteger(value))
    )
        throw new Error(`Invalid ${path}`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error(`Invalid ${path}`);
}

export const result = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data });
