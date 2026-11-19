import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const r = (p: string) => resolve(__dirname, p)
const alias = { '@shared': r('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: r('out/main'),
      lib: { entry: r('src/main/index.ts') }
    }
  },
  preload: {
    resolve: { alias },
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: r('out/preload'),
      lib: { entry: r('src/preload/index.ts') }
    }
  },
  renderer: {
    root: r('src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': r('src/shared'),
        '@renderer': r('src/renderer/src')
      }
    },
    build: {
      outDir: r('out/renderer'),
      emptyOutDir: true
    }
  }
})
