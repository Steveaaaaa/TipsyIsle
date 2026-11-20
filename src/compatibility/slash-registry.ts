import { SlashClosure, SlashScope } from '../sandbox/slash-scope';
import { takeSlashToken, unquoteSlash } from '../sandbox/slash-syntax';
import { SlashCommandAbortController, SlashCommandAbortSignal, SlashCommandBreakController, SlashCommandClosureResult } from '../sandbox/slash-control';
import type { SlashExecutionOptions } from '../sandbox/slash-core';

type Command = { name: string; aliases?: string[]; callback: (args: any, value: any) => unknown; namedArgumentList?: any[]; splitUnnamedArgument?: boolean; splitUnnamedArgumentCount?: number; [key: string]: any };
const commands = new Map<string, { command: Command; owner: object }>();
class Properties {
    [key: string]: any;
    static fromProps(props: Record<string, any>) { return Object.assign(new this(), props); }
}
export class SlashCommand extends Properties {}
export class SlashCommandArgument extends Properties {}
export class SlashCommandNamedArgument extends Properties {}
export const ARGUMENT_TYPE = Object.fromEntries(['STRING', 'NUMBER', 'BOOLEAN', 'CLOSURE', 'LIST', 'DICTIONARY', 'VARIABLE_NAME', 'RANGE'].map(name => [name, name.toLowerCase()]));

export function slashRegistration(owner: object, execute?: (source: string, options: SlashExecutionOptions) => Promise<string>) {
    class SlashCommandParser {
        static get commands() { return Object.fromEntries([...commands].map(([name, item]) => [name, item.command])); }
        get commands() { return SlashCommandParser.commands; }
        parse(text: string, _verifyCommandNames = true, _flags: unknown = null, abortController?: SlashCommandAbortController): SlashClosure {
            if (!execute) throw new Error('当前宿主未提供 Slash 执行器');
            const closure = new SlashClosure(text); closure.abortController = abortController;
            closure.execute = async () => {
                const result = new SlashCommandClosureResult();
                await execute(closure.source, { scope: closure.scope, abortController: closure.abortController, breakController: closure.breakController, result });
                return result;
            };
            return closure;
        }
        static addCommand(name: string, callback: Command['callback'], aliases: string[] = [], helpString = ''): void {
            this.addCommandObject({ name, callback, aliases, helpString });
        }
        static addCommandObject(command: Command): void {
            if (!command?.name || typeof command.callback !== 'function') throw new Error('Slash 命令需要 name 和 callback');
            const entry = { command, owner };
            for (const name of [command.name, ...(command.aliases ?? [])]) commands.set(name.toLowerCase(), entry);
        }
        static removeCommand(name: string): void {
            const entry = commands.get(name.toLowerCase());
            if (entry?.owner === owner) for (const [key, item] of commands) if (item === entry) commands.delete(key);
        }
    }
    return { SlashCommandParser, SlashCommand, SlashCommandArgument, SlashCommandNamedArgument, SlashCommandScope: SlashScope, SlashCommandClosure: SlashClosure, ARGUMENT_TYPE,
        SlashCommandAbortController, SlashCommandAbortSignal, SlashCommandBreakController, SlashCommandClosureResult,
        registerSlashCommand: (name: string, callback: Command['callback'], aliases: string[] = [], helpString = '') => SlashCommandParser.addCommandObject({ name, callback, aliases, helpString }) };
}
export function disposeSlashCommands(owner: object): void { for (const [name, item] of commands) if (item.owner === owner) commands.delete(name); }
export function hasRegisteredSlashCommand(name: string): boolean { return commands.has(name.toLowerCase()); }
export async function executeRegisteredSlashCommand(name: string, named: Record<string, unknown>, value: unknown, scope: SlashScope): Promise<unknown> {
    const entry = commands.get(name);
    if (!entry) throw new Error(`尚未接入 Slash 命令 /${name}`);
    const { command } = entry;
    const args: Record<string, unknown> = { _scope: scope, _hasUnnamedArgument: value !== undefined && value !== '', ...named };
    for (const arg of command.namedArgumentList ?? []) {
        const actual = [arg.name, ...(arg.aliases ?? [])].find(key => Object.hasOwn(args, key));
        if (actual) args[arg.name] = args[actual];
        else if (arg.defaultValue !== undefined) args[arg.name] = arg.defaultValue;
        else if (arg.isRequired) throw new Error(`/${name} 缺少参数 ${arg.name}`);
    }
    if (command.splitUnnamedArgument && typeof value === 'string') {
        let rest = value; const tokens: string[] = [];
        while (rest) {
            if (command.splitUnnamedArgumentCount && tokens.length === command.splitUnnamedArgumentCount - 1) { tokens.push(unquoteSlash(rest)); break; }
            const next = takeSlashToken(rest); tokens.push(unquoteSlash(next.token)); rest = next.rest;
        }
        value = tokens;
    }
    return command.callback(args, value);
}
