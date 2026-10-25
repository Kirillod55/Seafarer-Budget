// Dev-only demo switch (`npx vite` → http://localhost:5173/#demo). Kept apart from demo.ts so main.tsx can check it
// without statically importing the module that holds seedDemo; the demo itself is loaded dynamically.
export function isDemo(): boolean {
  return import.meta.env.DEV && location.hash === '#demo'
}
