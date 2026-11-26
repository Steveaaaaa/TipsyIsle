import { extensionModule } from './server/extension-modules.mjs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react(), {
    name: 'bundle-author-host-modules',
    generateBundle() {
      const paths = ['script.js', 'scripts/extensions.js', 'scripts/world-info.js', 'scripts/openai.js', 'scripts/user.js',
        'scripts/slash-commands.js', 'scripts/popup.js', 'scripts/extensions/quick-reply/index.js',
        'scripts/extensions/regex/engine.js', 'scripts/preset-manager.js', 'scripts/showdown-underscore.js', 'scripts/showdown-exclusion.js', 'scripts/power-user.js',
        ...['SlashCommand','SlashCommandArgument','SlashCommandScope','SlashCommandClosure','SlashCommandParser',
          'SlashCommandAbortController','SlashCommandBreakController','SlashCommandClosureResult']
          .map(name => 'scripts/slash-commands/' + name + '.js')];
      for (const fileName of paths) this.emitFile({ type: 'asset', fileName, source: extensionModule('/' + fileName)! });
    },
  }],
  worker: { format: 'es' },
  optimizeDeps: { entries: ['index.html', 'compat.html'] },
  preview: {
    host: '127.0.0.1',
    port: 5179,
    strictPort: true,
    proxy: { '/api/tipsy-isle': { target: 'http://127.0.0.1:5180', changeOrigin: true } },
  },
  server: {
    host: '0.0.0.0',
    port: 5179,
    proxy: {
      '/api/tipsy-isle': {
        target: 'http://127.0.0.1:5180',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    rollupOptions: { input: { main: 'index.html', compatibility: 'compat.html' } },
  },
});
