/*
 * The app mark inside a lime logo tile: the anchor with the bitcoin badge (Kirill's pick 2026-10-26, variant 1) — the
 * same drawing as the app icons (scripts/make-icons.mjs) in 100-unit coordinates, filling the whole tile. The tile
 * (lime background, corners) is the container's job: .side .logo, .au-logo, .login-logo.
 */
export function AppLogo() {
  return (
    <svg className="applogo" viewBox="0 0 100 100" aria-hidden="true">
      <g
        transform="translate(14 16) scale(3)"
        fill="none"
        stroke="var(--on-accent)"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="12" cy="5" r="2" />
        <path d="M12 7v14M5 12H3a9 9 0 0 0 18 0h-2" />
      </g>
      <circle cx="73" cy="27" r="16" fill="var(--accent)" />
      <circle cx="73" cy="27" r="13" fill="var(--on-accent)" />
      <g
        transform="translate(64.88 19.01) scale(0.67708)"
        fill="none"
        stroke="var(--accent)"
        strokeWidth={2.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M8 5.5h5.2a3 3 0 0 1 0 6H8zM8 11.5h6a3.2 3.2 0 0 1 0 6.4H8zM8 4v15.4" />
        <path d="M10 3.2v2.3M13 3.2v2.3M10 17.9v2.4M13 17.9v2.4" />
      </g>
    </svg>
  )
}
