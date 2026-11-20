import Ajv, { type ValidateFunction } from 'ajv';
import type { JsonMap } from '../../../packages/plugin-sdk/index.js';

const ajv = new Ajv({ strict: false, ownProperties: true, addUsedSchema: false, inlineRefs: false });
const validators = new Map<string, ValidateFunction>();
self.onmessage = (event: MessageEvent<{ id: number; schema: JsonMap; value?: JsonMap }>) => {
    const { id, schema, value } = event.data;
    try {
        const key = JSON.stringify(schema);
        let validate = validators.get(key);
        if (!validate) {
            if (schema.type !== 'object') throw new Error('工具参数的 JSON Schema 顶层必须是 object');
            validate = ajv.compile(schema);
            if (validators.size === 64) validators.delete(validators.keys().next().value!);
            validators.set(key, validate);
        }
        if (value !== undefined && !validate(value)) throw new Error(`${validate.errors?.[0]?.instancePath || '/'} ${validate.errors?.[0]?.message ?? '参数不符合工具定义'}`);
        self.postMessage({ id });
    } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
};
