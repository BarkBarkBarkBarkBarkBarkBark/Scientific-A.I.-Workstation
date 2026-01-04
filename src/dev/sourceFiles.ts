export type SourceFile = { path: string; content: string }

// Vite-time index of "project files we want visible inside the Dev panel".
// Note: this is NOT runtime filesystem access; it is bundled at build time.
const modules = import.meta.glob(
  [
    '/src/**/*.{ts,tsx,css,md,json}',
    '/README.md',
    '/ENV_SETUP.md',
    '/package.json',
    '/vite.config.ts',
    '/tailwind.config.ts',
    '/postcss.config.cjs',
    '/index.html',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>

export const sourceFiles: SourceFile[] = Object.entries(modules)
  .map(([k, v]) => ({ path: k.startsWith('/') ? k.slice(1) : k, content: v }))
  .sort((a, b) => a.path.localeCompare(b.path))


