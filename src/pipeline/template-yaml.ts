import _ from 'lodash';
import { isMap, isSeq, isScalar, parseDocument, stringify } from 'yaml';

/** Update the YAML node tree rather than reparsing stringified variables, keeping
 * the author's key order, scalar styles and comments wherever the type survives. */
export function annotateTemplateVariables(value: unknown, schema = ''): string {
    if (!schema) return stringify(value);
    const document = parseDocument(schema);
    if (document.errors.length) throw new Error(`变量 YAML 模板无效：${document.errors.map(error => error.message).join('；')}`);
    const update = (node: any, next: any): any => {
        if (isMap(node) && _.isPlainObject(next)) {
            for (const [key, item] of Object.entries(next)) node.set(key, update(node.get(key, true), item));
            return node;
        }
        if (isSeq(node) && Array.isArray(next)) {
            const previous = [...node.items];
            node.items = next.map((item, index) => update(previous[index], item));
            return node;
        }
        if (isScalar(node) && (next === null || typeof next !== 'object')) { node.value = next; return node; }
        const created = document.createNode(next);
        if (node && created && typeof node === 'object') {
            created.comment = node.comment;
            created.commentBefore = node.commentBefore;
            created.spaceBefore = node.spaceBefore;
        }
        return created;
    };
    document.contents = update(document.contents, value);
    return document.toString();
}
