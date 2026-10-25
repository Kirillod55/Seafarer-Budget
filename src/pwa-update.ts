// A new service-worker version is applied only while the app is hidden (or on its next cold open),
// and never while a record form is open — a reload would wipe what the user is typing.
export function createUpdateGate(opts: { isEditing(): boolean; apply(): void; doc: Document }): { onNeedRefresh(): void } {
  const { isEditing, apply, doc } = opts
  let pending = false

  const tryApply = () => {
    if (!pending || doc.visibilityState !== 'hidden' || isEditing()) return
    pending = false
    apply()
  }

  doc.addEventListener('visibilitychange', tryApply)

  return {
    onNeedRefresh() {
      pending = true
      tryApply()
    },
  }
}
