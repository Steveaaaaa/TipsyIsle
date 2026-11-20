import type { SchemaFieldDescriptor } from '../types';
const field = (id: string, title: string, type: SchemaFieldDescriptor['type'], defaultValue: unknown, description = ''): SchemaFieldDescriptor =>
    ({ id: `vectors.${id}`, title, type, defaultValue, description, group: '世界书向量检索', mobileWeight: 'advanced' });
export const vectorFields = [
    field('enabled', '启用世界书向量检索', 'boolean', false, '会将向量条目和最近消息发送给所选嵌入服务；首次建立索引后只计算变化内容。'),
    field('all', '检索所有启用条目', 'boolean', false, '关闭时只检索角色作者标记为向量模式的条目。'),
    field('url', '嵌入 API 地址', 'string', 'https://api.openai.com/v1'),
    field('key', '嵌入 API Key', 'secret', ''),
    field('model', '嵌入模型', 'string', 'text-embedding-3-small'),
    field('query', '查询最近消息数', 'number', 2),
    field('max_entries', '每本书最多激活条数', 'number', 5),
    field('threshold', '相似度阈值', 'number', 0.25),
    field('chunk_size', '条目分块字符数', 'number', 4000),
];
