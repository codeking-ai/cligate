const CONSTRAINT_FIELDS = [
    ['minLength', 'minLen'],
    ['maxLength', 'maxLen'],
    ['pattern', 'pattern'],
    ['minimum', 'min'],
    ['maximum', 'max'],
    ['multipleOf', 'multipleOf'],
    ['exclusiveMinimum', 'exclMin'],
    ['exclusiveMaximum', 'exclMax'],
    ['minItems', 'minItems'],
    ['maxItems', 'maxItems'],
    ['format', 'format']
];

const MAX_RECURSION_DEPTH = 10;
const ALLOWED_SCHEMA_FIELDS = new Set([
    'type',
    'description',
    'properties',
    'required',
    'items',
    'enum',
    'title',
    'additionalProperties'
]);

const SCHEMA_HINT_FIELDS = new Set([
    ...ALLOWED_SCHEMA_FIELDS,
    'const',
    'anyOf',
    'oneOf',
    'allOf',
    '$ref',
    '$defs',
    'definitions',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'minLength',
    'maxLength',
    'pattern',
    'format',
    'minItems',
    'maxItems',
    'additionalProperties'
]);

function isObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function collectAllDefs(value, defs = new Map()) {
    if (isObject(value)) {
        for (const defsKey of ['$defs', 'definitions']) {
            const bucket = value[defsKey];
            if (isObject(bucket)) {
                for (const [key, entry] of Object.entries(bucket)) {
                    if (!defs.has(key)) defs.set(key, deepClone(entry));
                }
            }
        }

        for (const [key, child] of Object.entries(value)) {
            if (key !== '$defs' && key !== 'definitions') collectAllDefs(child, defs);
        }
    } else if (Array.isArray(value)) {
        for (const item of value) collectAllDefs(item, defs);
    }
    return defs;
}

function appendHintToDescription(node, hint) {
    if (!hint || !isObject(node)) return;
    const current = typeof node.description === 'string' ? node.description : '';
    if (!current) {
        node.description = hint;
        return;
    }
    if (!current.includes(hint)) {
        node.description = `${current} ${hint}`;
    }
}

function moveConstraintsToDescription(node) {
    const hints = [];
    for (const [field, label] of CONSTRAINT_FIELDS) {
        if (node[field] !== undefined && node[field] !== null) {
            const value = typeof node[field] === 'string' ? node[field] : JSON.stringify(node[field]);
            hints.push(`${label}: ${value}`);
        }
    }
    if (hints.length > 0) {
        appendHintToDescription(node, `[Constraint: ${hints.join(', ')}]`);
    }
}

function scoreSchemaOption(value) {
    if (!isObject(value)) return 0;
    if (value.properties || value.type === 'object') return 3;
    if (value.items || value.type === 'array') return 2;
    if (typeof value.type === 'string' && value.type !== 'null') return 1;
    return 0;
}

function getSchemaTypeName(schema) {
    if (!isObject(schema)) return null;
    if (typeof schema.type === 'string') return schema.type;
    if (schema.properties) return 'object';
    if (schema.items) return 'array';
    return null;
}

function extractBestSchemaFromUnion(branches) {
    let best = null;
    let bestScore = -1;
    const allTypes = [];

    for (const branch of branches) {
        const score = scoreSchemaOption(branch);
        const typeName = getSchemaTypeName(branch);
        if (typeName && !allTypes.includes(typeName)) allTypes.push(typeName);
        if (score > bestScore) {
            best = branch;
            bestScore = score;
        }
    }

    return best ? { best, allTypes } : null;
}

function mergeAllOf(node) {
    if (!Array.isArray(node.allOf)) return;

    const mergedProperties = {};
    const mergedRequired = new Set();
    const otherFields = {};

    for (const subSchema of node.allOf) {
        if (!isObject(subSchema)) continue;

        if (isObject(subSchema.properties)) {
            for (const [key, value] of Object.entries(subSchema.properties)) {
                if (!(key in mergedProperties)) mergedProperties[key] = deepClone(value);
            }
        }

        if (Array.isArray(subSchema.required)) {
            for (const item of subSchema.required) {
                if (typeof item === 'string') mergedRequired.add(item);
            }
        }

        for (const [key, value] of Object.entries(subSchema)) {
            if (key === 'properties' || key === 'required' || key === 'allOf') continue;
            if (!(key in otherFields)) otherFields[key] = deepClone(value);
        }
    }

    delete node.allOf;

    for (const [key, value] of Object.entries(otherFields)) {
        if (!(key in node)) node[key] = value;
    }

    if (Object.keys(mergedProperties).length > 0) {
        node.properties = isObject(node.properties) ? node.properties : {};
        for (const [key, value] of Object.entries(mergedProperties)) {
            if (!(key in node.properties)) node.properties[key] = value;
        }
    }

    if (mergedRequired.size > 0) {
        const existing = Array.isArray(node.required) ? node.required.filter((item) => typeof item === 'string') : [];
        node.required = [...new Set([...existing, ...mergedRequired])];
    }
}

function flattenRefs(node, defs, depth = 0) {
    if (!isObject(node) || depth > MAX_RECURSION_DEPTH) return;

    if (typeof node.$ref === 'string') {
        const refPath = node.$ref;
        delete node.$ref;
        const refName = refPath.split('/').pop() || refPath;
        if (defs.has(refName) && isObject(defs.get(refName))) {
            const defSchema = deepClone(defs.get(refName));
            for (const [key, value] of Object.entries(defSchema)) {
                if (!(key in node)) node[key] = value;
            }
            flattenRefs(node, defs, depth + 1);
        } else {
            node.type = 'string';
            appendHintToDescription(node, `(Unresolved $ref: ${refPath})`);
        }
    }

    for (const value of Object.values(node)) {
        if (isObject(value)) flattenRefs(value, defs, depth + 1);
        else if (Array.isArray(value)) {
            for (const item of value) {
                if (isObject(item)) flattenRefs(item, defs, depth + 1);
            }
        }
    }
}

function cleanJsonSchemaRecursive(value, isSchemaNode = true, depth = 0) {
    if (depth > MAX_RECURSION_DEPTH) return false;

    let isEffectivelyNullable = false;

    if (Array.isArray(value)) {
        for (const item of value) {
            cleanJsonSchemaRecursive(item, isSchemaNode, depth + 1);
        }
        return false;
    }

    if (!isObject(value)) return false;

    mergeAllOf(value);

    if (value.type === 'object' || value.properties) {
        if (isObject(value.items)) {
            const items = value.items;
            delete value.items;
            value.properties = isObject(value.properties) ? value.properties : {};
            for (const [key, child] of Object.entries(items)) {
                if (!(key in value.properties)) value.properties[key] = child;
            }
        }
    }

    if (isObject(value.properties)) {
        const nullableKeys = new Set();
        for (const [key, child] of Object.entries(value.properties)) {
            if (cleanJsonSchemaRecursive(child, true, depth + 1)) nullableKeys.add(key);
        }

        if (nullableKeys.size > 0 && Array.isArray(value.required)) {
            value.required = value.required.filter((item) => typeof item === 'string' && !nullableKeys.has(item));
            if (value.required.length === 0) delete value.required;
        }

        if (!('type' in value)) value.type = 'object';
    }

    if (value.items !== undefined) {
        cleanJsonSchemaRecursive(value.items, true, depth + 1);
        if (!('type' in value)) value.type = 'array';
    }

    if (isObject(value.additionalProperties)) {
        cleanJsonSchemaRecursive(value.additionalProperties, true, depth + 1);
    }

    if (!value.properties && value.items === undefined) {
        for (const [key, child] of Object.entries(value)) {
            if (!['anyOf', 'oneOf', 'allOf', 'enum', 'type'].includes(key)) {
                cleanJsonSchemaRecursive(child, false, depth + 1);
            }
        }
    }

    if (Array.isArray(value.anyOf)) {
        for (const branch of value.anyOf) cleanJsonSchemaRecursive(branch, true, depth + 1);
    }
    if (Array.isArray(value.oneOf)) {
        for (const branch of value.oneOf) cleanJsonSchemaRecursive(branch, true, depth + 1);
    }

    const unionArray = Array.isArray(value.anyOf) ? value.anyOf : Array.isArray(value.oneOf) ? value.oneOf : null;
    if (unionArray) {
        const extracted = extractBestSchemaFromUnion(unionArray);
        if (extracted && isObject(extracted.best)) {
            for (const [key, child] of Object.entries(extracted.best)) {
                if (key === 'properties' && isObject(child)) {
                    value.properties = isObject(value.properties) ? value.properties : {};
                    for (const [propKey, propValue] of Object.entries(child)) {
                        if (!(propKey in value.properties)) value.properties[propKey] = propValue;
                    }
                } else if (key === 'required' && Array.isArray(child)) {
                    const current = Array.isArray(value.required) ? value.required.filter((item) => typeof item === 'string') : [];
                    value.required = [...new Set([...current, ...child.filter((item) => typeof item === 'string')])];
                } else if (!(key in value)) {
                    value[key] = child;
                }
            }
            if (extracted.allTypes.length > 1) {
                appendHintToDescription(value, `Accepts: ${extracted.allTypes.join(' | ')}`);
            }
        }
        delete value.anyOf;
        delete value.oneOf;
    }

    const hasStandardKeyword = Object.keys(value).some((key) => SCHEMA_HINT_FIELDS.has(key));
    const isNotSchemaPayload = 'functionCall' in value || 'functionResponse' in value;
    if (isSchemaNode && !hasStandardKeyword && Object.keys(value).length > 0 && !isNotSchemaPayload) {
        const properties = {};
        for (const [key, child] of Object.entries(value)) {
            properties[key] = child;
            delete value[key];
        }
        value.type = 'object';
        value.properties = properties;
        for (const child of Object.values(value.properties)) {
            cleanJsonSchemaRecursive(child, true, depth + 1);
        }
    }

    const looksLikeSchema = (isSchemaNode || hasStandardKeyword) && !isNotSchemaPayload;
    if (!looksLikeSchema) return false;

    moveConstraintsToDescription(value);

    if ('const' in value) {
        value.enum = [value.const];
        if (!('type' in value)) {
            const sample = value.const;
            value.type = sample === null ? 'string' : Array.isArray(sample) ? 'array' : typeof sample;
        }
    }

    const keysToRemove = Object.keys(value).filter((key) => {
        if (key === 'enum' || key === 'type' || key === 'properties' || key === 'required' || key === 'items' || key === 'description' || key === 'title' || key === 'additionalProperties') {
            return false;
        }
        return true;
    });
    for (const key of keysToRemove) delete value[key];

    if (value.type === 'object' && !value.properties) {
        value.properties = {};
    }

    const validPropKeys = isObject(value.properties) ? new Set(Object.keys(value.properties)) : null;
    if (Array.isArray(value.required)) {
        if (validPropKeys) {
            value.required = value.required.filter((item) => typeof item === 'string' && validPropKeys.has(item));
        } else {
            value.required = [];
        }
        if (value.required.length === 0) delete value.required;
    }

    if (!('type' in value)) {
        if (Array.isArray(value.enum)) value.type = 'string';
        else if (value.properties) value.type = 'object';
        else if (value.items !== undefined) value.type = 'array';
    }

    const fallbackType = value.properties ? 'object' : value.items !== undefined ? 'array' : 'string';
    if (typeof value.type === 'string') {
        const lower = value.type.toLowerCase();
        if (lower === 'null') {
            isEffectivelyNullable = true;
            value.type = fallbackType;
        } else {
            value.type = lower;
        }
    } else if (Array.isArray(value.type)) {
        let selectedType = null;
        for (const item of value.type) {
            if (typeof item !== 'string') continue;
            const lower = item.toLowerCase();
            if (lower === 'null') {
                isEffectivelyNullable = true;
            } else if (!selectedType) {
                selectedType = lower;
            }
        }
        value.type = selectedType || fallbackType;
    } else if (!value.type) {
        value.type = fallbackType;
    }

    if (isEffectivelyNullable) {
        appendHintToDescription(value, '(nullable)');
    }

    if (Array.isArray(value.enum)) {
        value.enum = value.enum.map((item) => {
            if (typeof item === 'string') return item;
            if (item === null) return 'null';
            return String(item);
        });
    }

    return isEffectivelyNullable;
}

export function normalizeJsonSchema(schema) {
    if (!isObject(schema)) return { type: 'object', properties: {} };

    const clone = deepClone(schema);
    const defs = collectAllDefs(clone);

    if (isObject(clone)) {
        delete clone.$defs;
        delete clone.definitions;
        flattenRefs(clone, defs, 0);
    }

    cleanJsonSchemaRecursive(clone, true, 0);

    if (!clone.type) clone.type = clone.properties ? 'object' : clone.items !== undefined ? 'array' : 'object';
    if (clone.type === 'object' && !clone.properties) clone.properties = {};
    return clone;
}

export const _testExports = {
    collectAllDefs,
    flattenRefs,
    cleanJsonSchemaRecursive
};
