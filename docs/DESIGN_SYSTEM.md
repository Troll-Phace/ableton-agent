# Ableton Claude Agent — Design System

## Design Philosophy

The chat UI lives inside an Ableton Live modal, so it must feel like part of Live: a flat dark surface, low-contrast secondary text, the single warm Live accent reserved for the active/primary action, and the compact `AbletonSans` type scale. Visual hierarchy signals importance — the conversation is the focal point; controls recede until needed. Tokens are derived from Live's own control palette (matching the SDK's `modal-dialog` example) so the window reads as native rather than as an embedded web page.

---

## Color System

### Base Palette
| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Window background | `--bg-primary` | `hsl(0 0% 21%)` | Modal/page background |
| Surface / control bg | `--bg-surface` | `hsl(0 0% 16%)` | Message bubbles, chips, buttons |
| Input / sunken bg | `--bg-input` | `hsl(0 0% 12%)` | Text input, code blocks |
| Control border | `--border` | `hsl(0 0% 7%)` | Hairline borders, dividers |
| Text primary | `--text-primary` | `hsl(0 0% 71%)` | Body text, agent + user messages |
| Text secondary | `--text-secondary` | `hsl(0 0% 41%)` | Timestamps, hints, placeholders, tool chips |

### Accent / Semantic Colors
| Role | Token | Value | Usage |
|------|-------|-------|-------|
| Primary accent (Live orange) | `--accent` | `hsl(31 100% 67%)` | Active primary button, send, streaming caret, focus where appropriate |
| Accent foreground | `--accent-fg` | `hsl(0 0% 7%)` | Text/icon on the accent fill |
| Success | `--success` | `hsl(140 45% 55%)` | Tool-activity "ok" chip |
| Warning | `--warning` | `hsl(43 90% 60%)` | Caution notices, limitation replies |
| Error / destructive | `--error` | `hsl(5 75% 60%)` | Tool "error" chip, destructive confirm card accent |

> Contrast: primary text `hsl(0 0% 71%)` on surface `hsl(0 0% 16%)` exceeds 4.5:1. Never place secondary text (`41%`) on `bg-primary` for essential content — it is for non-essential hints only.

---

## Typography

Font stack: `"AbletonSansSmall", "Inter", system-ui, sans-serif`. Base 11.5px / weight 500, antialiased — matching Live's UI density.

| Role | Token | Weight | Size | Line Height |
|------|-------|--------|------|-------------|
| Window title | `--type-title` | 600 | 13px | 1.3 |
| Message body | `--type-body` | 500 | 11.5px | 1.5 |
| Label / button | `--type-label` | 500 | 11.5px | 1.2 |
| Hint / timestamp | `--type-hint` | 500 | 10.5px | 1.3 |
| Code / mono | `--type-mono` | 500 | 11px | 1.5 (`"JetBrains Mono", ui-monospace, monospace`) |

---

## Spacing Scale
| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Icon gaps, chip padding |
| `--space-2` | 8px | Intra-component padding |
| `--space-3` | 12px | Message bubble padding |
| `--space-4` | 16px | Section gaps, input bar padding |
| `--space-5` | 24px | Window margins |

## Border Radius Scale
| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | 3px | Inputs, chips |
| `--radius-md` | 6px | Message bubbles, cards |
| `--radius-pill` | 999px | Buttons (Live uses pill buttons), streaming dot |

---

## Component Specifications

### Message bubble (user)
- Background: `--bg-input`; text `--text-primary`; radius `--radius-md`; padding `--space-3`.
- Aligned right; max-width 85%; subtle right margin.

### Message bubble (agent)
- Background: `--bg-surface`; text `--text-primary`; radius `--radius-md`; padding `--space-3`.
- Aligned left; max-width 90%. Streaming caret: a 2px-wide `--accent` block that blinks (disabled under reduced-motion).

### Input bar
- Pinned to bottom; background `--bg-primary`; top hairline `--border`.
- Text field: `--bg-input`, 1px `--border`, radius `--radius-sm`, padding `0 var(--space-2)`, height 22px; placeholder `--text-secondary`.
- Send button: pill, `--bg-surface` default → `--accent` fill with `--accent-fg` text on hover/active; focus ring `2px --text-secondary`.

### Tool-activity chip
- Inline pill: `--bg-surface`, `--text-secondary`, radius `--radius-sm`, padding `--space-1 --space-2`, `--type-hint`.
- Leading status dot: started = `--text-secondary` (pulsing), ok = `--success`, error = `--error`. Label = the tool's human summary (e.g. "Renaming 4 clips…").

### Confirm card (destructive approval)
- Background `--bg-surface`; left border 2px `--error`; radius `--radius-md`; padding `--space-3`.
- Title in `--text-primary`; itemized action list in `--type-hint`/`--text-secondary`.
- Two pill buttons: "Cancel" (`--bg-surface`) and a destructive primary whose label states the action explicitly (e.g. "Delete 3 tracks") filled `--error` with `--accent-fg`. Never a bare "OK".

### Settings modal (first-run key)
- Single sunken input (`--bg-input`) for the API key, masked; model `select`; Save pill (accent on active).
- Helper text in `--text-secondary`: key is stored locally and never leaves your machine.

---

## Animation Rules
- Streaming caret blink: 1s steps; **disabled** under `prefers-reduced-motion`.
- Hover/active transitions: 120ms ease-out on `background-color`/`opacity` only.
- New-message entrance: 100ms opacity fade (no layout animation).
- Respect `prefers-reduced-motion: reduce` — disable caret blink, message fades, and chip pulse.
- Use only `transform`/`opacity` for motion (GPU-composited).

---

## Machine-Readable Tokens

```css
:root {
  /* Colors */
  --bg-primary: hsl(0 0% 21%);
  --bg-surface: hsl(0 0% 16%);
  --bg-input: hsl(0 0% 12%);
  --border: hsl(0 0% 7%);
  --text-primary: hsl(0 0% 71%);
  --text-secondary: hsl(0 0% 41%);
  --accent: hsl(31 100% 67%);
  --accent-fg: hsl(0 0% 7%);
  --success: hsl(140 45% 55%);
  --warning: hsl(43 90% 60%);
  --error: hsl(5 75% 60%);

  /* Typography */
  --font-sans: "AbletonSansSmall", "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --type-title: 600 13px/1.3 var(--font-sans);
  --type-body: 500 11.5px/1.5 var(--font-sans);
  --type-label: 500 11.5px/1.2 var(--font-sans);
  --type-hint: 500 10.5px/1.3 var(--font-sans);
  --type-mono: 500 11px/1.5 var(--font-mono);

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;

  /* Radii */
  --radius-sm: 3px;
  --radius-md: 6px;
  --radius-pill: 999px;
}

@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

---

## Accessibility

- WCAG AA: 4.5:1 minimum contrast for all essential text (primary text on surface/input passes; secondary text is non-essential only).
- Visible focus ring (`2px --text-secondary`) on input, send, confirm-card actions, and settings controls.
- Never convey meaning by color alone — tool-chip status uses dot color **and** text; destructive buttons use color **and** explicit labels.
- Full keyboard support: Enter sends, Shift+Enter newline, Esc cancels a confirm card / closes the chat, Tab cycles controls.
- Minimum interactive target 24px tall (matching Live's compact controls) with adequate hit padding.

---

*This design system evolves with implementation.*
