function cleanGeminiSchemaValue(schema) {
    if (!schema || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => cleanGeminiSchemaValue(item));
    }

    const cleaned = {};
    for (const [key, value] of Object.entries(schema)) {
        if (key === 'const') {
            cleaned.enum = [value];
            continue;
        }

        if (key === 'type') {
            if (Array.isArray(value)) {
                const nonNullTypes = value.filter(item => item !== 'null');
                cleaned.type = nonNullTypes[0] || 'string';
            } else {
                cleaned.type = value;
            }
            continue;
        }

        if (key === 'properties' && value && typeof value === 'object' && !Array.isArray(value)) {
            cleaned.properties = {};
            for (const [propKey, propValue] of Object.entries(value)) {
                cleaned.properties[propKey] = cleanGeminiSchemaValue(propValue);
            }
            continue;
        }

        if (key === 'items') {
            cleaned.items = Array.isArray(value)
                ? value.map(item => cleanGeminiSchemaValue(item))
                : cleanGeminiSchemaValue(value);
            continue;
        }

        if (key === 'required' && Array.isArray(value)) {
            cleaned.required = value;
            continue;
        }

        if (key === 'enum' && Array.isArray(value)) {
            cleaned.enum = value;
            continue;
        }

        if (['description', 'title', 'format', 'nullable'].includes(key)) {
            cleaned[key] = value;
        }
    }

    if (!cleaned.type) {
        cleaned.type = 'object';
    }
    if (cleaned.type === 'object' && !cleaned.properties) {
        cleaned.properties = {};
    }

    return cleaned;
}

export function sanitizeGeminiToolSchema(schema) {
    return cleanGeminiSchemaValue(schema || { type: 'object', properties: {} });
}

export default {
    sanitizeGeminiToolSchema
};
