import * as z from 'zod';

type Schema = z.ZodType<any>;
function kind(schema: any): string { return String(schema?.def?.type ?? schema?._def?.typeName ?? '').replace(/^Zod/, '').toLowerCase(); }
function unwrap(schema: any): { core: any; optional: boolean; nullable: boolean } {
    let optional = false, nullable = false;
    while (schema && typeof schema.unwrap === 'function' && ['optional', 'nullable'].includes(kind(schema))) {
        if (kind(schema) === 'optional') optional = true; else nullable = true;
        schema = schema.unwrap();
    }
    return { core: schema, optional, nullable };
}
/** Later object/array definitions extend earlier structure; leaf constraints use
 * the newer schema. Keep the author's refinements on the overriding object. */
export function mergeTemplateSchemas(previous: Schema, next: Schema): Schema {
    const a = unwrap(previous), b = unwrap(next);
    let merged = b.core;
    if (kind(a.core) === 'object' && kind(b.core) === 'object') {
        const shape = { ...a.core.shape, ...b.core.shape };
        for (const key of Object.keys(b.core.shape)) if (Object.hasOwn(a.core.shape, key)) shape[key] = mergeTemplateSchemas(a.core.shape[key], b.core.shape[key]);
        merged = typeof b.core.safeExtend === 'function' ? b.core.safeExtend(shape) : z.object(shape);
        const unknown = (schema: any) => kind(schema.def?.catchall ?? schema._def?.catchall);
        if (['unknown', 'any'].includes(unknown(a.core)) || ['unknown', 'any'].includes(unknown(b.core))) merged = merged.loose();
    } else if (kind(a.core) === 'array' && kind(b.core) === 'array') {
        // Retain the newer array's checks without parsing/transformation twice.
        const element = mergeTemplateSchemas(a.core.element, b.core.element);
        merged = typeof b.core.clone === 'function' ? b.core.clone({ ...b.core.def, element }) : z.array(element);
    }
    if (b.nullable) merged = merged.nullable();
    if (b.optional) merged = merged.optional();
    return merged;
}
export function templateObjectSchema(value: unknown): Schema {
    if (kind(value) === 'object' && typeof (value as Schema).safeParse === 'function') return value as Schema;
    if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const shape = value as Record<string, Schema>;
        if (Object.values(shape).every(field => field && typeof field.safeParse === 'function')) return z.looseObject(shape);
    }
    throw new Error('模板变量 Schema 根必须是 ZodObject 或 Zod 字段对象');
}
