import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

function readLocalApiToken(configuredToken?: string) {
  if (configuredToken) return configuredToken.trim()
  if (process.env.TRACE_DEV_READ_TOKEN) return process.env.TRACE_DEV_READ_TOKEN.trim()
  try {
    const envPath = resolve(process.cwd(), '../api/.env')
    return execFileSync('/bin/zsh', ['-c', `set -a && source "$1" && printf %s "$TRACE_DEV_READ_TOKEN"`, 'trace-vite', envPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return undefined
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const token = mode === 'development' ? readLocalApiToken(env.TRACE_DEV_READ_TOKEN) : undefined
  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': {
          target: process.env.TRACE_API_URL ?? env.TRACE_API_URL,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        },
        '/roblox-games': {
          target: 'https://games.roblox.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/roblox-games/, ''),
        },
        '/roblox-thumbnails': {
          target: 'https://thumbnails.roblox.com',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/roblox-thumbnails/, ''),
        },
      },
    },
  }
})
