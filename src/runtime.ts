/** True when the app runs inside the Tauri desktop shell (it injects __TAURI_INTERNALS__). */
export function isTauri(w: object = window): boolean {
  return '__TAURI_INTERNALS__' in w
}
