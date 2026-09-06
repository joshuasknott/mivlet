import { build } from 'vite';
import { resolve } from 'node:path';

await build({
  configFile: false,
  base: './',
  resolve: { alias: [
    { find: '../app/ui.js', replacement: resolve('ui-state.mjs') },
    { find: './output/printer.js', replacement: resolve('no-relay.mjs') },
    { find: './output/smartcard.js', replacement: resolve('no-relay.mjs') },
  ] },
  build: {
    outDir: '/viewer-output',
    lib: { entry: resolve('entry.mjs'), formats: ['es'], fileName: () => 'fable-rfb.js' },
    minify: true,
    sourcemap: false,
    rolldownOptions: { output: { inlineDynamicImports: true } },
  },
});
