declare module 'ejs' {
    export function compile(source: string, options?: Record<string, unknown>): (data: Record<string, unknown>) => string | Promise<string>;
    const ejs: { compile: typeof compile }; export default ejs;
}
declare module 'lodash' { const lodash: any; export default lodash; }
declare module 'jquery' { const jquery: any; export default jquery; }
declare module 'jquery/factory' { export function jQueryFactory(window: Window): any; }
declare module 'showdown' {
    const showdown: {
        Converter: new (options?: Record<string, unknown>) => { makeHtml(source: string): string };
        helper: {
            replaceRecursiveRegExp(source: string, replacement: string | ((whole: string, inner: string, left: string, right: string) => string), left: string, right: string, flags: string): string;
        };
    };
    export default showdown;
}
declare module '*?raw' { const text: string; export default text; }
declare module '*?url' { const url: string; export default url; }
declare module 'seedrandom' { const seedrandom: (seed?: string | number) => () => number; export default seedrandom; }
declare module 'droll' { const droll: { roll(formula: string): false | { total: number }; validate(formula: string): boolean }; export default droll; }
