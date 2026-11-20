/** MVU declarations live in `schema`; author Zod schemas only receive business data. */
export const mvuProjectionKeys = ['stat_data', 'schema', 'mvu_schema', 'initialized_lorebooks', 'display_data', 'delta_data'] as const;

export interface MvuDataSchema {
    type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'any';
    properties?: Record<string, MvuDataSchema>;
    elementType?: MvuDataSchema;
    extensible?: boolean;
    recursiveExtensible?: boolean;
    required?: boolean;
    template?: unknown;
    strictTemplate?: unknown;
    strictSet?: unknown;
    concatTemplateArray?: unknown;
    [key: string]: unknown;
}

const EXTENSIBLE_MARKER = '$__META_EXTENSIBLE__$';
const hasOwn = (value: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, any> =>
    !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
const isArrayDeclaration = (value: unknown): value is Record<string, any> =>
    isObject(value) && value.$arrayMeta === true && hasOwn(value, '$meta');
const previousSchema = (value: unknown): MvuDataSchema | undefined =>
    isObject(value) && typeof value.type === 'string' ? value as MvuDataSchema : undefined;

function containsDeclarations(value: unknown, ancestors = new Set<object>()): boolean {
    if (!value || typeof value !== 'object' || value instanceof Date) return false;
    if (ancestors.has(value)) throw new Error('MVU 变量包含循环引用，无法保存为 JSON');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) return value.some(item => item === EXTENSIBLE_MARKER || isArrayDeclaration(item) || containsDeclarations(item, ancestors));
        return hasOwn(value, '$meta') || Object.values(value).some(item => containsDeclarations(item, ancestors));
    } finally { ancestors.delete(value); }
}

function extract(value: any, previous?: MvuDataSchema, inheritedExtensible = false, ancestors = new Set<object>()): { data: any; schema: MvuDataSchema } {
    if (!value || typeof value !== 'object' || value instanceof Date) {
        const primitive = typeof value;
        const type = primitive === 'string' || primitive === 'number' || primitive === 'boolean' ? primitive : 'any';
        return { data: value, schema: { ...previous, type } };
    }
    if (ancestors.has(value)) throw new Error('MVU 变量包含循环引用，无法保存为 JSON');
    ancestors.add(value);
    try {
        if (Array.isArray(value)) {
            const declaration = value.find(isArrayDeclaration);
            const meta = isObject(declaration?.$meta) ? declaration.$meta : {};
            const previousArray = previous?.type === 'array' ? previous : undefined;
            const extensible = inheritedExtensible || value.includes(EXTENSIBLE_MARKER) || (hasOwn(meta, 'extensible') ? meta.extensible === true : previousArray?.extensible === true);
            const recursiveExtensible = inheritedExtensible || previousArray?.recursiveExtensible === true;
            const data: any[] = [];
            let elementType: MvuDataSchema = previousArray?.elementType ?? { type: 'any' };
            for (const item of value) {
                if (item === EXTENSIBLE_MARKER || isArrayDeclaration(item)) continue;
                const child = extract(item, previousArray?.elementType, recursiveExtensible, ancestors);
                if (!data.length) elementType = child.schema;
                data.push(child.data);
            }
            const schema: MvuDataSchema = { ...previousArray, type: 'array', extensible, recursiveExtensible, elementType };
            if (hasOwn(meta, 'template')) schema.template = structuredClone(meta.template);
            // Retain unknown declaration fields without passing them to the author's business schema.
            if (Object.keys(meta).length) schema.metadata = { ...(isObject(schema.metadata) ? schema.metadata : {}), ...structuredClone(meta) };
            return { data, schema };
        }
        const meta = isObject(value.$meta) ? value.$meta : {};
        const previousObject = previous?.type === 'object' ? previous : undefined;
        const recursiveExtensible = inheritedExtensible || previousObject?.recursiveExtensible === true || meta.recursiveExtensible === true;
        const extensible = inheritedExtensible || previousObject?.extensible === true || meta.extensible === true || meta.recursiveExtensible === true;
        const properties: Record<string, MvuDataSchema> = {};
        const data: Record<string, any> = {};
        for (const [key, item] of Object.entries(value)) {
            if (key === '$meta') continue;
            const oldChild = previousObject?.properties && hasOwn(previousObject.properties, key) ? previousObject.properties[key] : undefined;
            const child = extract(item, oldChild, extensible && recursiveExtensible, ancestors);
            let required = !extensible || Array.isArray(meta.required) && meta.required.includes(key);
            if (oldChild?.required !== undefined) required = oldChild.required;
            Object.defineProperty(data, key, { value: child.data, writable: true, enumerable: true, configurable: true });
            Object.defineProperty(properties, key, { value: { ...child.schema, required }, writable: true, enumerable: true, configurable: true });
        }
        const schema: MvuDataSchema = { ...previousObject, type: 'object', properties, extensible, recursiveExtensible };
        if (hasOwn(meta, 'template')) schema.template = structuredClone(meta.template);
        for (const key of ['strictTemplate', 'strictSet', 'concatTemplateArray']) if (hasOwn(meta, key)) schema[key] = structuredClone(meta[key]);
        if (Object.keys(meta).length) schema.metadata = { ...(isObject(schema.metadata) ? schema.metadata : {}), ...structuredClone(meta) };
        return { data, schema };
    } finally { ancestors.delete(value); }
}

/**
 * Idempotent, non-mutating normalization for imports, old snapshots and runtime input.
 * The source card/YAML is untouched. Existing data returns unchanged when already normalized.
 */
export function normalizeMvuVariables<T extends Record<string, any>>(variables: T): { variables: T; changed: boolean } {
    if (!isObject(variables) || !isObject(variables.stat_data) || !containsDeclarations(variables.stat_data)) return { variables, changed: false };
    const extracted = extract(variables.stat_data, previousSchema(variables.schema) ?? previousSchema(variables.mvu_schema));
    const next = { ...variables, stat_data: extracted.data };
    if (typeof variables.schema === 'string') {
        // Zod MVU uses a sentinel to disable its legacy type checker. Do not re-enable it.
        Object.assign(next, { mvu_schema: extracted.schema });
    } else Object.assign(next, { schema: extracted.schema });
    return { variables: next, changed: true };
}

/** Rebuild legacy rules after insert/delete while keeping declarations out of business data. */
export function reconcileMvuVariables<T extends Record<string, any>>(variables: T): T {
    if (!isObject(variables.stat_data)) throw new Error('MVU stat_data 必须为对象');
    const { $internal: internal, ...businessData } = variables.stat_data;
    const extracted = extract(businessData, previousSchema(variables.schema) ?? previousSchema(variables.mvu_schema));
    return { ...variables, stat_data: { ...extracted.data, ...(internal === undefined ? {} : { $internal: internal }) },
        ...(typeof variables.schema === 'string' ? { mvu_schema: extracted.schema } : { schema: extracted.schema }) };
}

export function normalizeMvuNode(value: any, previous?: MvuDataSchema): { data: any; schema: MvuDataSchema } {
    return extract(value, previous, previous?.recursiveExtensible === true);
}

/** Normalize persisted scope/swipe buckets without changing unrelated values or the source map. */
export function normalizeMvuVariableMap<T extends Record<string, Record<string, unknown>>>(buckets: T): { variables: T; changed: boolean } {
    if (!isObject(buckets)) return { variables: buckets, changed: false };
    let variables = buckets;
    for (const [key, value] of Object.entries(buckets)) {
        const normalized = normalizeMvuVariables(value);
        if (!normalized.changed) continue;
        if (variables === buckets) variables = { ...buckets };
        Object.defineProperty(variables, key, { value: normalized.variables, writable: true, enumerable: true, configurable: true });
    }
    return { variables, changed: variables !== buckets };
}
