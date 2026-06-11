import {defineConfig} from 'vite';
import path from 'path';

export default defineConfig({
  build: {
      ssr: true,
    outDir: '.vite/preload',
      rolldownOptions: {
          input: path.resolve(__dirname, 'src/preload/index.ts'),
          output: {
              format: 'cjs',
              entryFileNames: 'index.js',
          },
      },
  },
    ssr: {
        external: ['electron'],
        noExternal: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
});
