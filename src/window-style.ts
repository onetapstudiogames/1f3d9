export const WINDOW_CSS = `:root {
  color-scheme: dark;
  --night: #101712;
  --night-soft: #1b2820;
  --paper: #eee7cf;
  --paper-soft: #fff9e7;
  --ink: #18221b;
  --muted: #566159;
  --green: #285f47;
  --green-dark: #123c29;
  --brick: #a64027;
  --yellow: #efc862;
  --line: #26342b;
  --focus: #fff0a6;
  --content: 76rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
*, *::before, *::after { box-sizing: border-box; }
html { min-width: 18rem; background: var(--night); }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--paper);
  background:
    linear-gradient(115deg, transparent 0 55%, rgba(238, 231, 207, 0.035) 55.2% 58%, transparent 58.2%),
    radial-gradient(circle at 50% -10rem, #354b3d 0, var(--night-soft) 23rem, var(--night) 47rem);
}
a { color: inherit; text-underline-offset: 0.2em; }
.skip-link {
  position: fixed;
  z-index: 10;
  inset: 0.5rem auto auto 0.5rem;
  padding: 0.75rem 1rem;
  color: var(--ink);
  background: var(--focus);
  border: 3px solid var(--ink);
  transform: translateY(-150%);
}
.skip-link:focus { transform: translateY(0); }

.city-sign, .window-frame, .window-footer {
  width: min(var(--content), calc(100% - 2rem));
  margin-inline: auto;
}
.city-sign {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(13rem, 18rem);
  margin-block-start: 1.5rem;
  color: #fffdf2;
  background: var(--green);
  border: 4px solid #09291b;
  box-shadow: 12px 12px 0 rgba(0, 0, 0, 0.44);
  animation: lights-on 300ms ease-out both;
}
.city-mark {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: clamp(0.8rem, 2vw, 1.5rem);
  padding: clamp(1rem, 3vw, 1.7rem);
}
.city-code, .eyebrow, .watch-state, .city-counts, .activity-time, .place-facts,
.loading-row, .record-link {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.city-code { color: var(--yellow); font-size: 1rem; font-weight: 850; letter-spacing: 0.08em; }
.city-name, .pane-heading h1, .pane-heading h2 {
  font-family: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  font-weight: 900;
  letter-spacing: -0.03em;
  text-transform: uppercase;
}
.city-name { min-width: 0; font-size: clamp(2rem, 5.5vw, 4.7rem); line-height: 0.86; }
.watch-state {
  display: grid;
  align-content: center;
  gap: 0.55rem;
  padding: 1rem 1.25rem;
  color: var(--ink);
  background: var(--yellow);
  border-inline-start: 4px solid #09291b;
  font-size: 0.76rem;
  line-height: 1.4;
}
.watch-state strong {
  width: fit-content;
  padding: 0.3rem 0.55rem;
  color: #fff;
  background: var(--brick);
  border: 2px solid var(--ink);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.city-promise, .city-counts { grid-column: 1 / -1; margin: 0; }
.city-promise {
  padding: 0.85rem clamp(1rem, 3vw, 1.7rem);
  border-top: 2px solid rgba(255, 255, 255, 0.32);
  font-size: clamp(1rem, 2vw, 1.25rem);
  font-weight: 750;
}
.city-counts {
  padding: 0.7rem clamp(1rem, 3vw, 1.7rem);
  color: var(--ink);
  background: var(--paper-soft);
  border-top: 4px solid #09291b;
  font-size: 0.76rem;
  font-weight: 750;
}

.window-frame {
  display: grid;
  grid-template-columns: minmax(0, 1.35fr) minmax(20rem, 0.85fr);
  margin-block-start: 0.85rem;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--line);
  box-shadow: 12px 12px 0 rgba(0, 0, 0, 0.44);
  animation: lights-on 340ms 70ms ease-out both;
}
.window-frame:focus { outline: none; }
.map-pane { min-width: 0; border-inline-end: 5px solid var(--line); }
.activity-pane { min-width: 0; background: rgba(40, 95, 71, 0.07); }
.pane-heading {
  min-height: 10.5rem;
  padding: clamp(1rem, 3vw, 1.5rem);
  color: var(--paper-soft);
  background: var(--green-dark);
  border-bottom: 3px solid var(--line);
}
.activity-pane .pane-heading { background: var(--brick); }
.eyebrow {
  margin: 0 0 0.5rem;
  font-size: 0.67rem;
  font-weight: 850;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.pane-heading h1, .pane-heading h2 {
  margin: 0;
  font-size: clamp(2rem, 4vw, 3.25rem);
  line-height: 0.95;
}
.pane-heading > p:last-child { max-width: 35rem; margin: 0.9rem 0 0; line-height: 1.5; }

.place-map { min-height: 28rem; padding: 1rem; overflow-wrap: anywhere; }
.place-tree { padding: 0; margin: 0; list-style: none; }
.place-tree .place-tree { margin-inline-start: 1.2rem; border-inline-start: 2px solid #9c9275; }
.place-node { position: relative; padding: 0.7rem 0 0.7rem 1rem; }
.place-tree .place-tree > .place-node::before {
  content: "";
  position: absolute;
  inset: 1.45rem auto auto 0;
  width: 0.7rem;
  border-top: 2px solid #9c9275;
}
.place-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.25rem 0.8rem;
  padding: 0.75rem 0.85rem;
  background: var(--paper-soft);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(38, 52, 43, 0.12);
}
.place-name, .place-owner, .activity-copy { unicode-bidi: plaintext; overflow-wrap: anywhere; }
.place-name { font-size: 1rem; font-weight: 850; }
.place-owner { color: var(--green-dark); font-size: 0.78rem; font-weight: 750; }
.place-facts {
  grid-column: 2;
  grid-row: 1 / 3;
  align-self: center;
  color: var(--muted);
  font-size: 0.67rem;
  line-height: 1.5;
  text-align: end;
}

.activity-list { padding: 0; margin: 0; list-style: none; }
.activity-list > li { padding: 1rem 1.1rem; border-bottom: 1px dashed #887e64; }
.activity-copy { margin: 0; font-weight: 720; line-height: 1.45; }
.activity-actor { color: var(--green-dark); font-weight: 900; }
.activity-time { display: block; margin-block-start: 0.35rem; color: var(--muted); font-size: 0.67rem; }
.loading-row, .empty-row, .error-row { padding: 1rem 1.1rem; color: var(--muted); font-size: 0.74rem; line-height: 1.5; }
.record-link { margin: 0; padding: 1rem 1.1rem; color: var(--green-dark); font-size: 0.72rem; font-weight: 800; }

.window-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.5rem 0 2.5rem;
  font-size: 0.8rem;
  line-height: 1.5;
}
.window-footer p { margin: 0; }
.window-footer nav { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.75rem 1rem; }

:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
@keyframes lights-on {
  from { opacity: 0; transform: translateY(0.5rem); }
  to { opacity: 1; transform: translateY(0); }
}
@media (max-width: 52rem) {
  .window-frame { grid-template-columns: 1fr; }
  .map-pane { border-inline-end: 0; border-bottom: 5px solid var(--line); }
  .window-footer { display: block; }
  .window-footer nav { justify-content: start; margin-block-start: 1rem; }
}
@media (max-width: 36rem) {
  .city-sign { grid-template-columns: 1fr; }
  .watch-state { border-block-start: 3px solid #09291b; border-inline-start: 0; }
  .place-map { padding: 0.55rem; }
  .place-tree .place-tree { margin-inline-start: 0.55rem; }
  .place-card { grid-template-columns: 1fr; }
  .place-facts { grid-column: 1; grid-row: auto; text-align: start; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; }
}
`
