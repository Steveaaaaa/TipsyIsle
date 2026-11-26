import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

async function loadBundle() {
    const cacheDir = path.resolve('node_modules/.cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const bundleFile = path.join(cacheDir, `html-beautify-compat-${crypto.randomUUID()}.mjs`);
    const result = await build({
        stdin: {
            contents: [
                'export * as z from "zod";',
                'export { isHtmlCodeBlock, messageCodeBlocks } from "./src/pipeline/message-code-blocks.ts";',
                'export { authorDocument } from "./src/compatibility/author-document.ts";',
                'export { formatTemplateMarkdown } from "./src/pipeline/template-formatting.ts";',
                'export { extractHtmlSandboxBlocks } from "./src/pipeline/macro-regex-engine.ts";',
                'export { resolveMvuSchema, applyMvuSchemaCommands } from "./src/compatibility/mvu-schema.ts";',
            ].join('\n'),
            resolveDir: process.cwd(),
            loader: 'ts',
        },
        bundle: true,
        write: false,
        format: 'esm',
        platform: 'node',
        packages: 'external',
        plugins: [
            {
                name: 'stub-raw-imports',
                setup(pluginBuild) {
                    pluginBuild.onResolve({ filter: /\?raw$/ }, args => ({ path: args.path, namespace: 'stub-raw' }));
                    pluginBuild.onLoad({ filter: /.*/, namespace: 'stub-raw' }, () => ({ contents: 'export default "";', loader: 'js' }));
                },
            },
        ],
    });
    await fs.writeFile(bundleFile, result.outputFiles[0].text, 'utf8');
    try {
        const mod = await import(pathToFileURL(bundleFile).href);
        return { mod, cleanup: () => fs.rm(bundleFile, { force: true }) };
    } catch (error) {
        await fs.rm(bundleFile, { force: true });
        throw error;
    }
}

test('HTML beautify code blocks, authorDocument, template extraction, and Zod prefault root work uniformly', async () => {
    const { mod, cleanup } = await loadBundle();
    try {
        const {
            z,
            isHtmlCodeBlock,
            messageCodeBlocks,
            authorDocument,
            formatTemplateMarkdown,
            extractHtmlSandboxBlocks,
            resolveMvuSchema,
            applyMvuSchemaCommands,
        } = mod;

        // 1. isHtmlCodeBlock & messageCodeBlocks
        const styleBodyPanel = '<style>.stat-panel{color:#fff}</style>\n<body class="dark">\n<div class="stat-panel">OK</div>\n</body>';
        assert.equal(isHtmlCodeBlock('', styleBodyPanel), true);
        assert.equal(isHtmlCodeBlock('text', styleBodyPanel), true);
        assert.equal(isHtmlCodeBlock('', '<head><style>.x{}</style></head><body><div>hi</div></body>'), true);
        assert.equal(isHtmlCodeBlock('', '<!-- comment -->\n<style>.card{color:red}</style><div class="card">Status</div>'), true);
        assert.equal(isHtmlCodeBlock('html', '<div>Explicit</div>'), true);
        assert.equal(isHtmlCodeBlock('js', '<style>.a{}</style><body><div>no</div></body>'), false);
        assert.equal(isHtmlCodeBlock('css', '.stat-panel { color: red; }'), false);
        assert.equal(isHtmlCodeBlock('json', '{"a": 1}'), false);
        assert.equal(isHtmlCodeBlock('', 'plain code text'), false);
        assert.equal(isHtmlCodeBlock('', '<UpdateVariable><Analysis>ok</Analysis></UpdateVariable>'), false);

        const blocks = [...messageCodeBlocks(`正文\n\n\`\`\`\n${styleBodyPanel}\n\`\`\``)];
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].isHtml, true);

        // 2. authorDocument handles partial <head>/<body> without double-nesting <body>
        const assembledStyleBody = authorDocument(styleBodyPanel, '<meta name="host">', '<script>/*tail*/</script>');
        assert.equal((assembledStyleBody.match(/<body\b/gi) ?? []).length, 1);
        assert.match(assembledStyleBody, /^<!doctype html><html><head><meta name="host"><style>\.stat-panel\{color:#fff\}<\/style>\s*<\/head><body class="dark">/);
        assert.ok(assembledStyleBody.includes('<script>/*tail*/</script></body></html>'));

        const assembledHeadBody = authorDocument('<head><title>X</title></head><body><p>A</p></body>', '<meta name="h">', '<script>t()</script>');
        assert.equal((assembledHeadBody.match(/<head\b/gi) ?? []).length, 1);
        assert.equal((assembledHeadBody.match(/<body\b/gi) ?? []).length, 1);
        assert.ok(assembledHeadBody.includes('<head><meta name="h"><title>X</title></head>'));
        assert.ok(assembledHeadBody.includes('<script>t()</script></body></html>'));

        const assembledFrag = authorDocument('<div>Frag</div>', '<meta>', '<script>t()</script>');
        assert.equal(assembledFrag, '<!doctype html><html><head><meta></head><body><div>Frag</div><script>t()</script></body></html>');

        // 2b. authorDocument ignores <head>/<body>/</html> inside raw-text tags, comments, <template>, and quoted attrs
        const scriptWithStrings = `<script type="module">if (text.includes('<head>') || text.includes('<body') || text.includes('</body>')) {}</script>`;
        const assembledScript = authorDocument(scriptWithStrings, '<meta name="host">', '');
        assert.equal(assembledScript, `<!doctype html><html><head><meta name="host"></head><body>${scriptWithStrings}</body></html>`);

        const complexHtml = '<!-- <head></head><body> --><html><head><style>/*<body>*/</style><template><body><head></head></body></template></head><body><div data-tpl="<body></body>"><textarea></body></textarea><script>const x="</body>";</script>OK</div></body></html>';
        const assembledComplex = authorDocument(complexHtml, '<meta name="h">', '<script>t()</script>');
        assert.equal((assembledComplex.match(/<meta name="h">/g) ?? []).length, 1);
        assert.equal((assembledComplex.match(/<script>t\(\)<\/script>/g) ?? []).length, 1);
        assert.ok(assembledComplex.includes('<!-- <head></head><body> --><html><head><meta name="h"><style>'));
        assert.ok(assembledComplex.endsWith('OK</div><script>t()</script></body></html>'));

        const visibleBeforeBody = authorDocument('<div>intro</div><body><p>Body</p></body>', '<meta name="h">', '<script>t()</script>');
        assert.equal(visibleBeforeBody, '<!doctype html><html><head><meta name="h"></head><body><div>intro</div><body><p>Body</p></body><script>t()</script></body></html>');

        // 3. extractHtmlSandboxBlocks extracts untagged <style>+<body> both raw and after formatTemplateMarkdown
        const sampleReply = `这是一段完整的剧情正文描述，包含足够的字数。\n\n<div style="width:80%"><details class="thinking-description"><summary>更新</summary><div>log</div></details></div><style>.thinking-description{color:#fff}</style>\n\n\`\`\`\n${styleBodyPanel}\n\`\`\``;
        const rawExtracted = extractHtmlSandboxBlocks(sampleReply);
        assert.deepEqual(rawExtracted.map(b => b.type), ['markdown', 'mixed', 'html']);
        assert.equal(rawExtracted[2].content, styleBodyPanel);

        const templateFormatted = formatTemplateMarkdown(sampleReply);
        const tplExtracted = extractHtmlSandboxBlocks(templateFormatted);
        assert.ok(tplExtracted.some(b => b.type === 'html' && b.content.includes('class="stat-panel"')), 'template-formatted HTML status bar should stay type=html');
        assert.ok(tplExtracted.some(b => b.type === 'mixed' && b.content.includes('thinking-description')));

        // 3b. Keep authored styled prose or cross-widget CSS together in a single mixed block
        const styledProseMsg = `<style>.speaker{color:pink}</style>\n这是一段很长的剧情正文，包含对话。<span class="speaker">艾玛</span>\n<div class="status">OK</div>`;
        const styledProseBlocks = extractHtmlSandboxBlocks(styledProseMsg);
        assert.deepEqual(styledProseBlocks.map(b => b.type), ['mixed']);

        const splitStyleMsg = `<style>.badge{color:cyan}</style>\n\n这里是一段普通的正文叙述文本，字数足够长。\n\n<div class="badge">徽章</div>`;
        const splitStyleBlocks = extractHtmlSandboxBlocks(splitStyleMsg);
        assert.deepEqual(splitStyleBlocks.map(b => b.type), ['mixed']);

        // 4. resolveMvuSchema unwraps root ZodPrefault / ZodDefault wrapping ZodObject while loosening root keys
        const prefaultProvider = () => z.object({
            主角: z.object({ 体力: z.number().prefault(100) }).prefault({ 体力: 100 }),
        }).prefault({ 主角: { 体力: 100 } });
        const loosened = resolveMvuSchema(prefaultProvider);
        const parsed = await loosened.parseAsync({ 主角: { 体力: 80 }, extraKey: 'keep-me' });
        assert.equal(parsed.extraKey, 'keep-me');
        assert.equal(parsed.主角.体力, 80);

        const defaultProvider = () => z.object({ count: z.number().default(1) }).default({ count: 1 });
        const parsedDefault = await resolveMvuSchema(defaultProvider).parseAsync({ count: 2, extra: true });
        assert.equal(parsedDefault.extra, true);

        const vars = { stat_data: { 主角: { 体力: 100 } } };
        await applyMvuSchemaCommands(vars, [{ full_match: '', reason: 'json_patch', type: 'set', args: ['新增顶层', 'hello'] }], prefaultProvider, (_cmd, err) => {
            throw err instanceof Error ? err : new Error(String(err));
        });
        assert.equal(vars.stat_data.新增顶层, 'hello');
    } finally {
        await cleanup();
    }
});
