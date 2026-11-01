/** True when the app runs inside the Tauri desktop shell (it injects __TAURI_INTERNALS__). */
export function isTauri(w: object = window): boolean {
  return '__TAURI_INTERNALS__' in w
}

/** Calls a command of the Windows program (src-tauri/src/main.rs). */
export function tauriInvoke<T = void>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const t = (window as unknown as { __TAURI_INTERNALS__: { invoke(c: string, a?: unknown): Promise<T> } }).__TAURI_INTERNALS__
  return t.invoke(cmd, args)
}
