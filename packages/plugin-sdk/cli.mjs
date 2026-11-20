#!/usr/bin/env node
import { runCli } from './packager.mjs';

try { await runCli(process.argv.slice(2)); }
catch (error) { console.error(`插件打包失败：${error.message}`); process.exitCode = 1; }
