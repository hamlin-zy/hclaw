import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
    publicDir: path.resolve(__dirname, 'public'),
  build: {
      outDir: path.resolve(__dirname, '.vite/renderer/main_window'),
    emptyOutDir: true,
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
          input: {
              main: path.resolve(__dirname, 'src/renderer/index.html'),
              llmLogs: path.resolve(__dirname, 'src/renderer/llm-logs.html'),
          },
          output: {
              manualChunks: (id) => {
                  if (id.includes('node_modules')) {
                      if (id.includes('react-dom') || id.includes('react/')) {
                          return 'vendor-react'
                      }
                      if (id.includes('framer-motion')) {
                          return 'vendor-animation'
                      }
                      if (id.includes('react-markdown') || id.includes('remark-') || id.includes('unified') || id.includes('mdast') || id.includes('micromark')) {
                          return 'vendor-markdown'
                      }
                      if (id.includes('@monaco-editor') || id.includes('monaco-editor')) {
                          return 'vendor-editor'
                      }
                      if (id.includes('zustand') || id.includes('jotai') || id.includes('valtio')) {
                          return 'vendor-state'
                      }
                      if (id.includes('@radix-ui') || id.includes('radix-')) {
                          return 'vendor-radix'
                      }
                      if (id.includes('@tanstack') || id.includes('tanstack')) {
                          return 'vendor-tanstack'
                      }
                      return 'vendor-misc'
                  }
                  if (id.includes('/stores/')) {
                      return 'stores'
                  }
                  if (id.includes('/components/dialogs/')) {
                      return 'components-dialogs'
                  }
                  if (id.includes('/components/SidePanels')) {
                      return 'components-sidepanels'
                  }
                  if (id.includes('/components/message-list') || id.includes('/components/InputArea') || id.includes('/components/SessionStats')) {
                      return 'components-message'
                  }
                  if (id.includes('/components/ConversationPage')) {
                      return 'components-conversation'
                  }
                  if (id.includes('/components/ConversationSidebar')) {
                      return 'components-sidebar'
                  }
                  if (id.includes('/components/')) {
                      return 'components-ui'
                  }
                  if (id.includes('/lib/')) {
                      return 'lib'
                  }
              },
          },
      },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  css: {
    postcss: path.resolve(__dirname, 'postcss.config.js'),
  },
});
