import { normalizeJsonSchema } from '../../json-schema-normalizer.js';

export function sanitizeToolSchema(schema) {
    const normalized = normalizeJsonSchema(schema || { type: 'object', properties: {} });

    if (typeof normalized.additionalProperties === 'boolean') {
        delete normalized.additionalProperties;
    }

    return normalized;
}

export default {
    sanitizeToolSchema
};
