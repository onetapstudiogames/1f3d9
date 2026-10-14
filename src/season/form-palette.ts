// The dark form pages' colors as tokens: /join, /rotate, /recovery
// (src/identity-browser.ts) and the hosted sign-in and consent pages
// (src/oauth.ts). A season day appends its own :root block after these
// (src/season/palettes.ts formTokens), so every rule below reads var(...).
export const FORM_TOKENS_CSS = ':root{color-scheme:dark;--bg:#0d1117;--panel:#161b22;--border:#30363d;--text:#e6edf3;--accent:#f4a261;--field-border:#59636e}'

// The rules both page families share, in the same order they had before.
export const FORM_BASE_CSS = 'body{max-width:42rem;margin:3rem auto;padding:0 1.2rem;background:var(--bg);color:var(--text);font:17px/1.55 system-ui,sans-serif}'
  + 'main{background:var(--panel);border:1px solid var(--border);border-radius:14px;padding:1.4rem}h1{line-height:1.15}'
