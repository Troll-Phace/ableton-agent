---
paths:
  - "src/webview/**/*.ts"
  - "src/webview/**/*.css"
  - "src/webview/**/*.html"
---

# Design System Rules

- Use design tokens (CSS custom properties) — **NEVER hardcode colors, spacing, or font sizes**. All tokens are defined in docs/DESIGN_SYSTEM.md.
- The UI must feel native to Ableton Live: dark theme, the Live accent (warm orange `hsl(31 100% 67%)`), `AbletonSansSmall`/system sans fallback, ~11.5px base, low-contrast secondary text.
- Use the spacing scale tokens (`--space-*`) — no arbitrary pixel values.
- All text must meet WCAG AA contrast (4.5:1 minimum) against its background.
- Visible focus indicators on every interactive element (input, button, confirm card actions).
- Respect `prefers-reduced-motion`: disable the streaming caret animation and transitions when set.
- Prefer `transform`/`opacity` for any animation (GPU-composited); never animate layout.
- The chat is a single fixed-size modal — design for the `showModalDialog(url, w, h)` dimensions (default 420×560); content scrolls, the input bar is pinned.
- Confirm cards (destructive-action approval) and tool-activity chips are first-class components — see docs/DESIGN_SYSTEM.md for their specs. Their behavior differs by Spike R3 outcome (in-chat buttons vs. propose→apply), but their visual spec is shared.
- Reference docs/DESIGN_SYSTEM.md for all token values and component specifications before writing any UI.
