export const WINDOW_CSS = `:root {
  color-scheme: dark;
  --night: #0b1714;
  --night-soft: #14241f;
  --forest: #174d3c;
  --forest-deep: #092d22;
  --paper: #e9e0c5;
  --paper-light: #fff9e8;
  --ink: #15231d;
  --muted: #555e55;
  --brick: #ad3f25;
  --brick-deep: #712413;
  --signal: #f0c95f;
  --sky: #94c7bc;
  --line: #20382f;
  --paper-line: #9d9276;
  --focus: #fff19b;
  --focus-dark: #092d22;
  --cursor-tint: #d7e5dc;
  --content: 82rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

*, *::before, *::after { box-sizing: border-box; }
html { min-width: 18rem; background: var(--night); scroll-behavior: smooth; }
body {
  min-height: 100vh;
  margin: 0;
  color: var(--paper);
  background:
    linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px),
    radial-gradient(circle at 50% -8rem, #315447 0, var(--night-soft) 26rem, var(--night) 54rem);
  background-size: 2.2rem 2.2rem, 2.2rem 2.2rem, auto;
}
a { color: inherit; text-underline-offset: 0.22em; }
button, input, select { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }

.skip-link {
  position: fixed;
  z-index: 100;
  inset: 0.5rem auto auto 0.5rem;
  padding: 0.75rem 1rem;
  color: var(--ink);
  background: var(--focus);
  border: 3px solid var(--ink);
  transform: translateY(-150%);
}
.skip-link:focus { transform: translateY(0); }

.city-sign, .view-console, .window-frame, .window-footer {
  width: min(var(--content), calc(100% - 2rem));
  margin-inline: auto;
}
.city-sign {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(14rem, 19rem);
  margin-block-start: 1.35rem;
  color: #fffdf3;
  background: var(--forest);
  border: 4px solid #061e17;
  box-shadow: 11px 11px 0 rgba(0, 0, 0, 0.46);
  animation: instrument-on 280ms ease-out both;
}
.city-mark {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: clamp(0.8rem, 2vw, 1.5rem);
  padding: clamp(1rem, 3vw, 1.65rem);
}
.city-code, .eyebrow, .watch-state, .city-counts, .view-tab, .view-filters,
.board-label, .block-number, .place-facts, .activity-time, .note-meta,
.thing-meta, .agreement-meta, .badge, .loading-row, .empty-row, .error-row {
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.city-code {
  color: var(--signal);
  font-size: 0.95rem;
  font-weight: 900;
  letter-spacing: 0.1em;
}
.city-name, .panel-heading h1, .panel-heading h2, .roster-board h2,
.orientation-block h3, .observation-block h3, .conversation-group h3 {
  font-family: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  font-weight: 900;
  letter-spacing: -0.035em;
  text-transform: uppercase;
}
.city-name {
  min-width: 0;
  font-size: clamp(1.9rem, 5vw, 4.55rem);
  line-height: 0.86;
}
.watch-state {
  display: grid;
  align-content: center;
  gap: 0.55rem;
  padding: 1rem 1.25rem;
  color: var(--ink);
  background: var(--signal);
  border-inline-start: 4px solid #061e17;
  font-size: 0.75rem;
  line-height: 1.45;
}
.watch-state strong {
  width: fit-content;
  padding: 0.3rem 0.55rem;
  color: #fff;
  background: var(--brick);
  border: 2px solid var(--ink);
  letter-spacing: 0.1em;
  text-transform: uppercase;
}
.watch-badges { display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: center; }
.watch-badges strong { margin: 0; }
.alpha-chip {
  width: fit-content;
  padding: 0.3rem 0.55rem;
  color: var(--ink);
  background: var(--signal);
  border: 2px solid var(--ink);
  font-weight: 900;
  letter-spacing: 0.1em;
}
.alpha-note { display: block; font-size: 0.67rem; line-height: 1.45; }
.watch-state [data-tone="live"]::before { content: "● "; color: var(--forest); }
.watch-state [data-tone="stale"]::before,
.watch-state [data-tone="working"]::before { content: "● "; color: var(--brick); }
.watch-state [data-tone="error"]::before { content: "● "; color: var(--brick-deep); }
.global-read-retry {
  padding: 0;
  color: var(--brick-deep);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 850;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.global-read-retry:hover { color: var(--forest-deep); }
.global-read-retry:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.window-guide-links {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem;
  padding: 0.75rem clamp(1rem, 3vw, 1.65rem);
  background: var(--night);
  border-top: 4px solid #061e17;
}
.window-guide-links a {
  padding: 0.48rem 0.7rem;
  color: var(--ink);
  background: var(--paper-light);
  border: 2px solid var(--signal);
  font: 850 0.74rem/1.3 ui-monospace, "Cascadia Mono", Consolas, monospace;
  text-decoration: none;
}
.window-guide-links a:hover { background: var(--signal); }
.city-promise, .city-counts { grid-column: 1 / -1; margin: 0; }
.city-promise {
  padding: 0.82rem clamp(1rem, 3vw, 1.65rem);
  border-top: 2px solid rgba(255, 255, 255, 0.28);
  font-size: clamp(1rem, 2vw, 1.2rem);
  font-weight: 760;
}
.city-counts {
  padding: 0.68rem clamp(1rem, 3vw, 1.65rem);
  color: var(--ink);
  background: var(--paper-light);
  border-top: 4px solid #061e17;
  font-size: 0.72rem;
  font-weight: 800;
}

.view-console {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  grid-template-rows: auto auto auto;
  margin-block-start: 0.85rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border: 4px solid var(--line);
  box-shadow: 11px 11px 0 rgba(0, 0, 0, 0.46);
}
.view-tabs {
  grid-row: 1;
  display: flex;
  min-width: 0;
  padding-inline-end: 1px;
  overflow-x: auto;
}
.view-tab {
  min-width: max-content;
  padding: 0.9rem 1rem;
  color: var(--sky);
  background: transparent;
  border: 0;
  border-inline-end: 1px solid rgba(255, 255, 255, 0.2);
  cursor: pointer;
  font-size: 0.7rem;
  font-weight: 850;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.view-tab:hover { color: #fff; background: rgba(255, 255, 255, 0.07); }
.view-tab[aria-selected="true"] { color: var(--ink); background: var(--signal); }
.directory-search-field {
  grid-row: 2;
  display: grid;
  gap: 0.24rem;
  padding: 0.62rem 0.68rem 0.7rem;
  background: #183a30;
  border-block-start: 3px solid var(--line);
}
.directory-search-field > label, .view-filters label > span {
  color: var(--sky);
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.directory-search-shell { position: relative; width: min(100%, 40rem); }
.directory-search-field input {
  width: 100%;
  min-width: 0;
  padding: 0.42rem 0.5rem;
  color: #fff;
  background: var(--night-soft);
  border: 1px solid #84aa9d;
  border-radius: 0;
  font-size: 0.78rem;
}
.directory-search-field input::placeholder { color: #b7cbc4; opacity: 1; }
.directory-search-results {
  position: absolute;
  z-index: 6;
  inset-block-start: calc(100% + 0.2rem);
  inset-inline: 0;
  max-height: min(22rem, 55vh);
  overflow-y: auto;
  color: var(--ink);
  background: #fffef8;
  border: 2px solid var(--line);
  box-shadow: 6px 6px 0 rgba(0, 0, 0, 0.36);
}
.directory-search-option {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  gap: 0.12rem;
  align-items: center;
  width: 100%;
  padding: 0.58rem 0.65rem;
  border-block-end: 1px solid var(--paper-line);
  cursor: pointer;
}
.directory-search-option-copy { display: grid; gap: 0.12rem; min-width: 0; }
.directory-search-option:last-child { border-block-end: 0; }
.directory-search-option[aria-selected="true"] {
  color: var(--ink);
  background: var(--cursor-tint);
  box-shadow: inset 4px 0 0 var(--forest);
}
.directory-search-option strong { font-size: 0.78rem; }
.directory-search-option small { color: currentColor; font-size: 0.64rem; }
.directory-search-empty { padding: 0.65rem; color: var(--muted); font-size: 0.72rem; }
.input-contract {
  display: block;
  color: var(--muted);
  font-size: 0.58rem;
  line-height: 1.35;
}
.directory-search-field .input-contract { color: #b7cbc4; }
.directory-search-status {
  min-height: 1em;
  color: var(--sky);
  font-size: 0.58rem;
  line-height: 1.2;
}
.view-filters {
  grid-row: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: stretch;
  background: #102c23;
  border-block-start: 3px solid var(--line);
}
.view-filters > label {
  display: grid;
  flex: 1 1 14rem;
  align-content: center;
  gap: 0.2rem;
  min-width: 0;
  padding: 0.42rem 0.65rem;
}
.view-filters select {
  width: 100%;
  min-width: 0;
  padding: 0.3rem 0.4rem;
  color: #fff;
  background: var(--night-soft);
  border: 1px solid #6e9689;
  border-radius: 0;
  font-size: 0.72rem;
}
.view-filters select { padding-inline-end: 1.6rem; }
.directory-status {
  align-self: center;
  max-width: 22rem;
  padding: 0.55rem 0.7rem;
  color: var(--sky);
  font-size: 0.67rem;
  line-height: 1.35;
}
.directory-retry, .selection-retry {
  padding: 0;
  color: var(--signal);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 850;
  text-decoration: underline;
  text-underline-offset: 0.2em;
}
.selection-error { padding: 0.75rem; color: var(--brick-deep); background: #fff2df; }
.share-button {
  align-self: center;
  justify-self: end;
  min-height: 2.35rem;
  padding: 0.42rem 0.72rem;
  color: var(--paper-light);
  background: var(--night);
  border: 2px solid var(--line);
  font-size: 0.67rem;
  font-weight: 850;
  text-align: center;
  cursor: pointer;
}
.share-button:hover { color: var(--night); background: var(--signal); }
.panel-heading > .share-button {
  position: absolute;
  z-index: 2;
  inset: auto clamp(1rem, 3vw, 1.6rem) clamp(1rem, 3vw, 1.6rem) auto;
}
.share-status {
  min-height: 1.5rem;
  margin: 0;
  padding: 0.28rem 0.75rem;
  color: var(--ink);
  background: var(--sky);
  border-top: 2px solid var(--line);
  font: 0.64rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.record-detail-share-status { border-top: 0; border-bottom: 2px solid var(--line); }
.record-detail {
  width: min(42rem, calc(100vw - 2rem));
  max-height: calc(100vh - 2rem);
  padding: 0;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--line);
  box-shadow: 11px 11px 0 rgba(0, 0, 0, 0.46);
}
.record-detail::backdrop { background: rgba(3, 20, 15, 0.78); }
.record-detail-heading {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 0.65rem;
  align-items: center;
  padding: 0.75rem;
  color: var(--paper-light);
  background: var(--night);
  border-bottom: 3px solid var(--line);
}
.record-detail-heading h2 { margin: 0; font-size: clamp(1rem, 3vw, 1.35rem); }
.record-detail-kind { margin: 0 0 0.2rem; color: var(--signal); font-size: 0.66rem; font-weight: 850; }
.record-detail-actions { display: flex; flex-wrap: wrap; gap: 0.55rem; }
.detail-close {
  min-height: 2.35rem;
  padding: 0.42rem 0.72rem;
  color: var(--night);
  background: var(--paper-light);
  border: 2px solid var(--line);
  cursor: pointer;
  font: inherit;
  font-weight: 850;
}
.record-detail-body {
  max-height: min(65vh, 42rem);
  overflow: auto;
  margin: 0;
  padding: 1rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.drawing-detail {
  display: grid;
  gap: 0.75rem;
  margin-block-start: 1rem;
  padding-block-start: 1rem;
  border-top: 3px solid var(--line);
}
.drawing-detail > h3, .drawing-detail h4, .drawing-detail h5 { margin: 0; }
.drawing-snapshot {
  display: grid;
  grid-template-columns: minmax(8rem, 12rem) minmax(0, 1fr);
  gap: 0.55rem 0.8rem;
  align-items: start;
  padding: 0.75rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
}
.drawing-snapshot > h4,
.drawing-snapshot > .drawing-state-label,
.drawing-snapshot > .drawing-provenance,
.drawing-snapshot > .drawing-owner-description,
.drawing-snapshot > .drawing-no-pixels { grid-column: 1 / -1; }
.drawing-state-label {
  margin: 0;
  font: 900 0.72rem/1.25 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.drawing-provenance {
  margin: 0;
  color: var(--brick-deep);
  font: 800 0.67rem/1.35 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.drawing-owner-description {
  margin: 0;
  padding: 0.55rem;
  background: var(--paper);
  border-inline-start: 4px solid var(--signal);
  white-space: pre-wrap;
}
.drawing-detail-canvas {
  width: min(12rem, 100%);
  height: auto;
  aspect-ratio: 1;
  image-rendering: pixelated;
  border: 2px solid var(--line);
}
.drawing-exact-readback {
  min-width: 0;
  padding: 0.65rem;
  background: var(--paper);
  border: 1px solid var(--paper-line);
}
.drawing-exact-readback > h4 { margin-block-end: 0.45rem; }
.drawing-exact-line { margin: 0.35rem 0; }
.drawing-exact-line code, .drawing-canonical-rows code {
  overflow-wrap: anywhere;
  font: 0.68rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.drawing-canonical-rows {
  margin: 0.35rem 0 0;
  padding-inline-start: 2.25rem;
  white-space: nowrap;
}
.drawing-history-control {
  min-height: 2.75rem;
  width: fit-content;
  max-width: 100%;
  padding: 0.5rem 0.72rem;
  color: var(--ink);
  background: var(--sky);
  border: 2px solid var(--line);
  cursor: pointer;
  font: inherit;
  font-weight: 850;
}
.drawing-history {
  display: grid;
  gap: 0.75rem;
  padding: 0.75rem;
  background: rgba(148, 199, 188, 0.35);
  border: 2px solid var(--line);
}
.drawing-history-revision {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.65rem;
  padding: 0.75rem;
  background: var(--paper);
  border: 2px solid var(--paper-line);
}
.drawing-history-revision > h5,
.drawing-history-revision > .drawing-history-meta { grid-column: 1 / -1; }
.drawing-history-meta { margin: 0; color: var(--muted); font-size: 0.72rem; }
.drawing-snapshot-compact { grid-template-columns: 1fr; padding: 0.55rem; }
.drawing-snapshot-compact > * { grid-column: 1; }
.drawing-unavailable { margin: 0; padding: 0.75rem; background: var(--sky); border: 2px solid var(--line); }
.view-scope {
  grid-column: 1 / -1;
  margin: 0;
  padding: 0.55rem 0.75rem;
  color: var(--ink);
  background: var(--sky);
  border-top: 3px solid var(--line);
  font: 0.66rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-weight: 750;
}

.window-frame {
  min-height: 38rem;
  margin-block-start: 0.85rem;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--line);
  box-shadow: 11px 11px 0 rgba(0, 0, 0, 0.46);
  animation: instrument-on 340ms 60ms ease-out both;
}
.window-title {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
.view-panel { animation: panel-in 170ms ease-out both; }
.panel-heading {
  position: relative;
  min-height: 10rem;
  padding: clamp(1rem, 3vw, 1.6rem);
  overflow: hidden;
  color: var(--paper-light);
  background: var(--forest-deep);
  border-bottom: 4px solid var(--line);
}
.panel-heading::after {
  content: "";
  position: absolute;
  inset: 0 0 0 auto;
  width: min(34%, 24rem);
  opacity: 0.16;
  background: repeating-linear-gradient(-45deg, transparent 0 8px, currentColor 8px 10px);
}
.place-heading { background: #184b46; }
.conversation-heading { background: var(--brick-deep); }
.happening-heading { background: #263f32; }
.agreement-heading { color: var(--ink); background: var(--signal); }
.archive-heading { background: #172d3a; }
.gazette-heading { background: var(--brick-deep); }
.eyebrow {
  position: relative;
  z-index: 1;
  margin: 0 0 0.5rem;
  font-size: 0.66rem;
  font-weight: 850;
  letter-spacing: 0.11em;
  text-transform: uppercase;
}
.panel-heading h1, .panel-heading h2 {
  position: relative;
  z-index: 1;
  max-width: 50rem;
  margin: 0;
  overflow-wrap: anywhere;
  font-size: clamp(2.15rem, 5vw, 4.6rem);
  line-height: 0.9;
}
.panel-heading > p:last-child {
  position: relative;
  z-index: 1;
  max-width: 42rem;
  margin: 0.9rem 0 0;
  line-height: 1.5;
}

.live-heading { background: #183a30; }
.live-instrument-strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1.25rem;
  padding: 0.7rem clamp(0.8rem, 2.5vw, 1.25rem);
  color: var(--paper-light);
  background: var(--night-soft);
  border-bottom: 3px solid var(--line);
  font: 750 0.68rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-breadcrumbs {
  display: flex;
  flex: 1 1 18rem;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}
.live-breadcrumb {
  min-width: 24px;
  min-height: 24px;
  padding: 0.15rem 0.25rem;
  color: var(--sky);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 850;
  text-decoration: underline;
  text-underline-offset: 0.18em;
}
.live-breadcrumb[aria-current="location"] { color: var(--signal); text-decoration: none; }
.live-breadcrumb-separator { color: var(--paper-line); }
.live-camera-controls { display: flex; flex: 0 0 auto; gap: 0.45rem; align-items: center; }
.live-control-button {
  min-height: 2.75rem;
  padding: 0.42rem 0.7rem;
  color: var(--ink);
  background: var(--signal);
  border: 2px solid var(--line);
  border-radius: 0;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.42);
  cursor: pointer;
  font: 900 0.64rem/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.live-control-button:hover { background: var(--paper-light); }
.live-control-button:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 rgba(0, 0, 0, 0.42); }
.live-control-button[aria-pressed="true"] { color: var(--paper-light); background: var(--brick); }
.live-proof { background: var(--sky); }
.live-clock { flex: 0 1 24rem; margin: 0; color: var(--paper-light); text-align: end; }
.live-history-status {
  min-height: 2.5rem;
  margin: 0;
  padding: 0.62rem clamp(0.8rem, 2.5vw, 1.25rem);
  color: var(--ink);
  background: var(--sky);
  border-bottom: 3px solid var(--line);
  font: 750 0.66rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-history-retry {
  min-height: 24px;
  padding: 0;
  color: var(--brick-deep);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 900;
  text-decoration: underline;
  text-underline-offset: 0.18em;
}
.live-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); }
.live-stage-shell {
  min-width: 0;
  padding: 0.65rem;
  color: var(--ink);
  background: var(--paper);
  border: 4px solid var(--line);
  box-shadow: 10px 10px 0 rgba(0, 0, 0, 0.42);
}
.live-viewport {
  position: relative;
  height: min(72vh, 42.5rem);
  min-height: 30rem;
  overflow: clip;
  color: var(--paper-light);
  background: var(--night);
  border: 3px solid var(--line);
  cursor: grab;
  touch-action: none;
  overscroll-behavior: contain;
  user-select: none;
}
.live-viewport[data-live-dragging="true"] { cursor: grabbing; }
.live-stage {
  position: absolute;
  inset: 0 auto auto 0;
  width: var(--live-stage-width, 87.5rem);
  height: var(--live-stage-height, 61.25rem);
  min-width: 0;
  overflow: visible;
  background: var(--night);
  transform-origin: 0 0;
  will-change: transform;
  isolation: isolate;
}
.live-label-layer {
  position: absolute;
  z-index: 50;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.live-resident-tag {
  position: absolute;
  z-index: 1;
  width: max-content;
  max-width: none;
  padding: 0.2rem 0.3rem;
  overflow: visible;
  color: var(--ink);
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.38);
  font: 800 0.72rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  text-overflow: clip;
  white-space: nowrap;
}
.live-resident-tag[data-live-packed="false"] { visibility: hidden; }
.live-resident-tag[data-live-focus-resident] {
  z-index: 2;
  background: var(--signal);
  box-shadow: 0 0 0 2px var(--line), 3px 3px 0 rgba(0, 0, 0, 0.46);
}
.live-resident-tag[data-live-intent="true"] { z-index: 4; }
.live-resident-tag[data-live-raised="true"] {
  z-index: 6;
  background: var(--signal);
  box-shadow: 0 0 0 2px var(--line), 4px 4px 0 rgba(0, 0, 0, 0.5);
}
.live-world-ground {
  position: absolute;
  z-index: 0;
  inset: 0;
  display: block;
  overflow: hidden;
  background-color: var(--night);
  background-image:
    linear-gradient(rgba(148, 199, 188, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 199, 188, 0.08) 1px, transparent 1px);
  background-size: var(--live-world-tile, 3.5rem) var(--live-world-tile, 3.5rem);
  image-rendering: pixelated;
}
.live-world-ground > .drawing-grid {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
}
.live-plates {
  position: absolute;
  z-index: 1;
  inset: 0;
  min-height: 0;
  padding: 0;
  pointer-events: none;
}
.live-plates > .loading-row,
.live-plates > .error-row,
.live-plates > .empty-row {
  position: absolute;
  z-index: 80;
  inset: 1rem auto auto 1rem;
  max-width: 24rem;
  margin: 0;
  padding: 0.45rem 0.6rem;
  color: var(--ink);
  background: var(--signal);
  border: 2px solid var(--line);
  pointer-events: auto;
}
.live-map-caption {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  gap: 0.25rem;
  padding: 0.65rem 0.8rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border: 3px solid var(--line);
  border-bottom: 0;
  pointer-events: none;
}
.live-map-caption .block-number,
.live-map-caption .live-plate-title,
.live-map-caption .live-plate-legend { margin: 0; }
.live-map-caption .live-plate-title { font-size: 1.35rem; }
.live-map-caption .live-plate-legend { color: var(--sky); }
.live-map-caption .drawing-detail-open {
  justify-self: start;
  margin-top: 0.15rem;
  pointer-events: auto;
}
.live-stage-readout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(15rem, 0.85fr);
  gap: 0.65rem 1rem;
  align-items: center;
  min-height: 3.2rem;
  padding: 0.55rem 0.65rem 0;
  pointer-events: none;
  font: 750 0.62rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-camera-help, .live-focus-status { margin: 0; }
.live-camera-help { color: var(--muted); }
.live-focus-status {
  justify-self: end;
  color: var(--forest-deep);
  font-weight: 850;
  text-align: end;
}
.live-focus-status[data-focused="true"]::before { content: "FOCUS / "; color: var(--brick); }
.live-focus-clear {
  min-width: 44px;
  min-height: 44px;
  margin-inline-start: 0.4rem;
  padding: 0.2rem;
  color: var(--brick-deep);
  background: transparent;
  border: 0;
  cursor: pointer;
  font: inherit;
  font-weight: 900;
  pointer-events: auto;
  text-decoration: underline;
  text-underline-offset: 0.18em;
}
body:has(#live-panel[data-live-fullscreen="true"]) { overflow: hidden; }
.window-frame:has(> #live-panel[data-live-fullscreen="true"]) {
  animation: none;
  transform: none;
}
#live-panel[data-live-fullscreen="true"] {
  position: fixed;
  z-index: 1000;
  inset: 0;
  display: flex !important;
  flex-direction: column;
  width: 100vw;
  height: 100dvh;
  overflow: auto;
  color: var(--ink);
  background: var(--paper);
  animation: none;
  transform: none;
}
#live-panel[data-live-fullscreen="true"] > .live-heading { display: none; }
#live-panel[data-live-fullscreen="true"] > .live-instrument-strip {
  position: sticky;
  z-index: 80;
  top: 0;
  flex: 0 0 auto;
}
#live-panel[data-live-fullscreen="true"] > .live-history-status { flex: 0 0 auto; }
#live-panel[data-live-fullscreen="true"] > .live-layout {
  display: block;
  width: 100%;
  min-height: 0;
  flex: 1 1 auto;
}
#live-panel[data-live-fullscreen="true"] .live-stage-shell {
  display: flex;
  min-height: 100%;
  flex-direction: column;
}
#live-panel[data-live-fullscreen="true"] .live-viewport {
  flex: 1 1 auto;
  height: calc(100dvh - 12rem);
  min-height: 18rem;
}
#live-panel[data-live-fullscreen="true"] .live-roster-board { display: none; }
.live-plate-title {
  margin: 0;
  overflow-wrap: anywhere;
  font: 900 clamp(1.4rem, 3vw, 2.2rem)/0.95 "Arial Narrow", "Aptos Narrow", system-ui, sans-serif;
  text-transform: uppercase;
}
.live-plate-legend {
  align-self: end;
  margin: 0;
  color: var(--sky);
  font: 0.62rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.entity-portrait {
  position: relative;
  display: inline-grid;
  flex: 0 0 2rem;
  width: 2rem;
  height: 2rem;
  overflow: hidden;
  vertical-align: middle;
  background: transparent;
  border: 0;
  image-rendering: pixelated;
}
.entity-portrait-placeholder,
.entity-portrait-image {
  grid-area: 1 / 1;
  display: block;
  width: 100%;
  height: 100%;
}
.entity-portrait-placeholder {
  background: transparent;
}
.entity-portrait-image { object-fit: contain; image-rendering: pixelated; }
.resident-reference,
.front-matter-title {
  display: inline-flex;
  gap: 0.35rem;
  align-items: center;
  vertical-align: middle;
}
.drawing-grid {
  position: relative;
  display: block;
  width: 100%;
  aspect-ratio: 1;
  overflow: hidden;
  image-rendering: pixelated;
  border-radius: 0;
}
.drawing-authored-shell > canvas.drawing-authored {
  display: block;
  width: 100%;
  height: 100%;
  image-rendering: pixelated;
}
.drawing-grid > .drawing-live-label,
.drawing-grid > .drawing-undrawn-label {
  position: absolute;
  z-index: 2;
  inset-inline: 0.12rem auto;
  max-width: calc(100% - 0.24rem);
  padding: 0.1rem 0.18rem;
  overflow: hidden;
  color: var(--ink);
  background: rgba(255, 249, 232, 0.92);
  font: 900 0.42rem/1.15 ui-monospace, "Cascadia Mono", Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.drawing-grid > .drawing-state-label { inset-block: 0.12rem auto; }
.drawing-grid > .drawing-provenance { inset-block: auto 0.12rem; }
.drawing-refused { background: repeating-linear-gradient(45deg,
  rgba(217, 92, 70, 0.13) 0 6px, rgba(255, 249, 232, 0.84) 6px 12px); }
.drawing-in_progress { box-shadow: inset 0 0 0 2px var(--signal); }
.drawing-blank { background: var(--paper-light); }
.drawing-undrawn {
  position: relative;
  display: grid;
  place-items: center;
  min-width: 0;
  background: repeating-linear-gradient(-45deg,
    transparent 0 7px, rgba(157, 146, 118, 0.55) 7px 8px);
  border: 1px dashed var(--paper-line);
}
.drawing-undrawn-label {
  max-width: 100%;
  padding: 0.12rem;
  overflow: hidden;
  color: var(--muted);
  background: rgba(255, 249, 232, 0.88);
  font: 800 0.45rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.04em;
  text-align: center;
  text-overflow: ellipsis;
  text-transform: uppercase;
}
.drawing-loading { opacity: 0.72; }
.drawing-unavailable { border-style: solid; }
.live-portrait-grid { display: flex; flex-wrap: wrap; gap: 0.38rem; align-items: start; }
.live-portrait-wrap {
  position: relative;
  display: grid;
  flex: 0 0 3.1rem;
  width: 3.1rem;
}
.live-portrait {
  position: relative;
  display: grid;
  width: 100%;
  aspect-ratio: 1;
  min-height: 24px;
  padding: 0.2rem;
  color: var(--ink);
  background: transparent;
  border: 0;
  cursor: pointer;
}
.live-portrait > .drawing-grid { height: 100%; aspect-ratio: auto; }
.live-portrait > .entity-portrait { width: 100%; height: 100%; }
.live-portrait.asleep { opacity: 0.48; }
.live-speech-bubble {
  position: absolute;
  z-index: 20;
  inset-block-end: calc(100% + 0.38rem);
  inset-inline-start: 50%;
  width: max-content;
  min-width: 6rem;
  max-width: min(12rem, 46vw);
  padding: 0.38rem 0.45rem;
  transform: translateX(-50%);
  color: var(--ink);
  background: var(--paper-light);
  border: 2px solid var(--line);
  border-radius: 0;
  box-shadow: 3px 3px 0 rgba(32, 56, 47, 0.22);
  pointer-events: none;
  font: 750 0.58rem/1.35 ui-monospace, "Cascadia Mono", Consolas, monospace;
  overflow-wrap: anywhere;
  text-align: start;
}
.live-room-empty {
  margin: 0;
  padding: 0.75rem;
  color: var(--muted);
  border: 1px dashed var(--paper-line);
  font: 750 0.65rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-thing-shelf {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  margin-top: 1rem;
  padding-top: 0.75rem;
  border-top: 2px solid var(--paper-line);
}
.live-thing-specimen {
  display: grid;
  grid-template-columns: 2.5rem minmax(0, 6rem);
  gap: 0.4rem;
  align-items: center;
  min-height: 3.5rem;
  padding: 0.3rem;
  color: var(--ink);
  background: var(--paper-light);
  border: 2px solid var(--line);
  font-size: 0.6rem;
  font-weight: 800;
  text-decoration: none;
}
.live-thing-name { overflow-wrap: anywhere; }
.live-thing-specimen > .entity-portrait { width: 2.5rem; height: 2.5rem; }
.live-trace-arrowhead { fill: var(--brick); }
.live-footnote-mark, .live-action-mark {
  position: absolute;
  z-index: 3;
  display: grid;
  place-items: center;
  min-width: 24px;
  min-height: 24px;
  padding: 0.12rem;
  transform: translate(-50%, -50%);
  color: var(--ink);
  background: var(--signal);
  border: 2px solid var(--line);
  border-radius: 0;
  pointer-events: auto;
  font: 900 0.62rem/1 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-footnote-mark { cursor: pointer; }
.live-action-mark { color: #fff; background: var(--brick); }
[data-live-key][data-highlighted="true"] { outline: 4px solid var(--signal); outline-offset: 2px; }
.live-trail[data-highlighted="true"] { stroke: var(--signal); stroke-width: 2; }
.live-pulse { animation: live-print-pulse 600ms steps(2, end) 1; }
.live-ledger-panel {
  padding: 1rem clamp(0.8rem, 2.5vw, 1.25rem) 1.25rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border-top: 4px solid var(--line);
}
.live-ledger-panel h3 {
  margin: 0.35rem 0 0.75rem;
  font-family: "Arial Narrow", "Aptos Narrow", system-ui, sans-serif;
  font-size: 1.45rem;
  text-transform: uppercase;
}
.live-ledger { display: grid; gap: 0; padding: 0; margin: 0; list-style: none; }
.live-ledger-row {
  display: grid;
  grid-template-columns: 2.3rem minmax(0, 1fr) auto;
  gap: 0.65rem;
  align-items: baseline;
  min-height: 44px;
  padding: 0.65rem 0;
  border-top: 1px solid rgba(255, 255, 255, 0.25);
  cursor: default;
}
.live-ledger-number { color: var(--signal); font: 900 0.68rem ui-monospace, monospace; }
.live-ledger-copy { margin: 0; unicode-bidi: plaintext; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 0.72rem; line-height: 1.5; }
.live-ledger-time { color: var(--sky); font: 0.58rem ui-monospace, monospace; white-space: nowrap; }
.live-roster-board .drawing-grid { flex: 0 0 2.4rem; width: 2.4rem; border: 1px solid var(--paper-line); }
.live-roster-list .resident-row { display: grid; grid-template-columns: 2rem minmax(0, 1fr); justify-content: normal; align-items: center; }
.live-roster-list .resident-number { grid-column: 2; }
.live-roster-list .resident-drawing-detail { grid-column: 2; justify-self: start; }
.live-focus-interactions {
  margin: 0 0 1rem;
  padding: 0.7rem;
  color: var(--ink);
  background: var(--signal);
  border: 3px solid var(--line);
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.38);
}
.live-focus-interactions h3 { margin: 0.2rem 0; font-size: 1.1rem; text-transform: uppercase; }
.live-focus-interactions-copy { margin: 0 0 0.55rem; font: 750 0.62rem/1.45 ui-monospace, monospace; }
.live-focus-resident-card {
  display: grid;
  grid-template-columns: 2.4rem minmax(0, 1fr);
  gap: 0.45rem;
  align-items: center;
  margin: 0 0 0.55rem;
  padding: 0.38rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border: 2px solid var(--line);
}
.live-focus-resident-card .drawing-grid { width: 2.4rem; border: 1px solid var(--paper-line); }
.live-focus-resident-card > .entity-portrait { width: 2.4rem; height: 2.4rem; }
.live-focus-resident-card-copy { display: grid; min-width: 0; gap: 0.12rem; }
.live-focus-resident-card .resident-drawing-detail { grid-column: 2; justify-self: start; }
.live-focus-resident-card-name {
  overflow: hidden;
  font: 900 0.68rem ui-monospace, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-focus-resident-card-location { font: 750 0.58rem/1.35 ui-monospace, monospace; }
.live-focus-thing-list { display: grid; gap: 0.3rem; }
.live-focus-thing-card {
  min-height: 24px;
  padding: 0.28rem 0.38rem;
  overflow-wrap: anywhere;
  color: var(--paper-light);
  background: var(--forest-deep);
  border: 2px solid var(--line);
  font: 850 0.62rem/1.35 ui-monospace, monospace;
  text-decoration: none;
}
.live-focus-thing-card:focus-visible { outline: 4px solid var(--focus); outline-offset: 2px; }
.live-roster-list [data-live-focus-resident] { outline: 4px solid var(--signal); outline-offset: 2px; }
.live-roster-list [data-live-focus-partner] { outline: 3px solid var(--sky); outline-offset: 1px; }
[data-live-focus-thing] { outline: 3px solid var(--sky); outline-offset: 1px; }

/* The live plate is a surveyed map: plots stay put and every moving mark sits above them. */
.live-plot {
  position: absolute;
  z-index: 2;
  min-width: 8rem;
  min-height: 6rem;
  overflow: visible;
  color: var(--ink);
  background: #20423a;
  border: 3px solid var(--line);
  box-shadow: 5px 5px 0 rgba(0, 0, 0, 0.48);
  pointer-events: auto;
  image-rendering: pixelated;
}
.live-plot:has(.live-walker:hover),
.live-plot:has(.live-walker:focus-within),
.live-plot:has(.live-thing-specimen:hover),
.live-plot:has(.live-thing-specimen:focus-visible),
.live-plot:has([data-live-raised="true"]),
.live-plot:hover,
.live-plot:focus-within { z-index: 60; }
.live-plot[data-live-focus-plot="true"] { z-index: 4; }
.live-plot[data-live-raised="true"] { z-index: 42; }
.live-plot[data-live-detail="false"] {
  width: 3.5rem !important;
  height: 3.5rem !important;
  min-width: 3.5rem;
  min-height: 3.5rem;
  background: var(--forest);
  border-style: solid;
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.48);
}
.live-plot[data-live-detail="false"] > :not(.live-plot-open) { display: none; }
.live-plot[data-live-detail="false"] > .live-plot-open {
  inset: 0;
  justify-content: center;
  width: 100%;
  max-width: none;
  min-height: 100%;
  padding: 0.2rem;
  overflow: hidden;
  text-align: center;
}
.live-plot[data-live-detail="false"] .live-plot-name {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.live-plot[data-place-kind="continent"] {
  border-width: 4px;
  box-shadow: 8px 8px 0 rgba(0, 0, 0, 0.5);
}
.live-plot[data-undrawn="true"] { background: transparent; border-style: dashed; box-shadow: none; }
.live-plot-terrain {
  position: absolute;
  z-index: 0;
  inset: 0;
  display: block;
  overflow: hidden;
  background-color: #20423a;
  image-rendering: pixelated;
}
.live-plot-terrain > .drawing-grid {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  aspect-ratio: auto;
}
.live-plot-terrain > canvas.drawing-grid { height: auto; }
.live-plot-terrain .drawing-undrawn-label { display: none; }
.live-plot-terrain > .drawing-grid .drawing-undrawn-label { display: block; }
.drawing-detail-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  min-height: 44px;
  padding: 0.35rem 0.7rem;
  color: var(--ink);
  background: rgba(255, 249, 232, 0.94);
  border: 2px solid var(--line);
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.42);
  cursor: pointer;
  font: 900 0.62rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  text-align: start;
}
.drawing-detail-open:hover { background: var(--signal); }
.live-plot-drawing-detail {
  position: absolute;
  z-index: 9;
  max-width: none;
}
.live-plot-open {
  position: absolute;
  z-index: 8;
  inset: -0.8rem auto auto 0.55rem;
  display: flex;
  gap: 0.45rem;
  align-items: center;
  max-width: calc(100% - 1.1rem);
  min-height: 1.75rem;
  padding: 0.18rem 0.5rem;
  overflow: hidden;
  color: var(--ink);
  background: var(--paper-light);
  border: 2px solid var(--line);
  border-radius: 0;
  box-shadow: 3px 3px 0 rgba(0, 0, 0, 0.42);
  cursor: pointer;
  font: 900 0.62rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  text-align: start;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-plot-open::after { content: "→"; flex: 0 0 auto; color: var(--brick); }
.live-plot-open:hover { background: var(--signal); }
.live-plot-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-plot-owner {
  position: absolute;
  z-index: 7;
  inset: 1.1rem auto auto 0.45rem;
  max-width: calc(100% - 0.9rem);
  margin: 0;
  padding: 0.1rem 0.28rem;
  overflow: hidden;
  color: var(--ink);
  background: rgba(255, 249, 232, 0.88);
  font: 800 0.5rem/1.25 ui-monospace, "Cascadia Mono", Consolas, monospace;
  pointer-events: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-plot > .live-portrait-grid {
  position: absolute;
  z-index: 7;
  inset: 0;
  padding: 0;
  pointer-events: none;
}
.live-plot > .live-thing-shelf {
  position: absolute;
  z-index: 6;
  inset: 0;
  display: block;
  max-height: none;
  margin: 0;
  padding: 0;
  overflow: visible;
  border: 0;
  pointer-events: none;
}
.live-plot > .live-thing-shelf:has(.live-thing-specimen:hover),
.live-plot > .live-thing-shelf:has(.live-thing-specimen:focus-visible),
.live-plot > .live-thing-shelf:has(.live-thing-specimen[data-live-raised="true"]) {
  z-index: 64;
}
.live-plot .live-thing-specimen {
  position: absolute;
  width: 5.8rem;
  grid-template-columns: 1.55rem minmax(0, 1fr);
  min-width: 0;
  padding: 0.12rem;
  transform: translate(-50%, -50%);
  background: rgba(255, 249, 232, 0.94);
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.3);
  pointer-events: auto;
}
.live-plot .live-thing-name {
  overflow: hidden;
  font-size: 0.44rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.live-thing-specimen:hover,
.live-thing-specimen:focus-visible,
.live-thing-specimen[data-live-raised="true"] {
  z-index: 45;
  min-width: max-content;
  max-width: 20rem;
}
.live-thing-specimen:hover .live-thing-name,
.live-thing-specimen:focus-visible .live-thing-name,
.live-thing-specimen[data-live-raised="true"] .live-thing-name {
  overflow: visible;
  text-overflow: clip;
  white-space: normal;
}
.live-thing-shelf[data-live-expanded="true"] {
  z-index: 28;
  max-height: none;
  overflow: visible;
  background: transparent;
  border: 0;
}
.live-walker-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.live-walker-layer { z-index: 12; }
.live-plot > .live-walker-layer[data-live-expanded="true"] {
  z-index: 29;
  inset: auto;
  max-width: none;
  max-height: none;
  overflow: visible;
  background: transparent;
  border: 0;
  pointer-events: none;
}
.live-walker, .live-replay-portrait {
  position: absolute;
  z-index: 12;
  display: grid;
  width: 3.5rem;
  height: 3.5rem;
  margin: 0;
  transform: translate(-50%, -100%);
  pointer-events: auto;
}
.live-walker:hover, .live-walker:focus-within,
.live-replay-portrait:hover, .live-replay-portrait:focus-within { z-index: 30; }
.live-walker[data-live-focus-resident],
.live-replay-portrait[data-live-focus-resident] { z-index: 40; }
.live-walker[data-live-raised="true"],
.live-replay-portrait[data-live-raised="true"] { z-index: 44; }
.live-plot .live-walker { width: 3.5rem; height: 3.5rem; }
.live-replay-portrait {
  z-index: 18;
  will-change: transform;
  animation-name: live-recorded-glide;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
.live-root-walkers .live-resident-more { pointer-events: auto; }
.live-root-walkers:has(.live-walker:hover),
.live-root-walkers:has(.live-walker:focus-within),
.live-root-walkers:has(.live-walker[data-live-raised="true"]) { z-index: 64; }
.live-focus-thing-shelf {
  position: absolute;
  z-index: 9;
  inset: 1rem 1rem auto auto;
  width: 32rem;
  max-width: calc(100% - 2rem);
  margin: 0;
  padding: 0.45rem;
  background: rgba(13, 37, 31, 0.72);
  border: 2px solid var(--line);
  pointer-events: auto;
}
.live-root-thing-shelf {
  inset: 0;
  width: 100%;
  max-width: none;
  height: 100%;
  padding: 0;
  background: transparent;
  border: 0;
  pointer-events: none;
}
.live-focus-thing-shelf.live-root-thing-shelf[data-live-expanded="true"] {
  max-height: none !important;
  padding: 0 !important;
  overflow: visible !important;
  background: transparent;
  border: 0 !important;
}
.live-root-thing-shelf:has(.live-thing-specimen:hover),
.live-root-thing-shelf:has(.live-thing-specimen:focus-visible),
.live-root-thing-shelf:has(.live-thing-specimen[data-live-raised="true"]) { z-index: 64; }
.live-root-thing-shelf > .live-thing-specimen {
  position: absolute;
  width: 9rem;
  transform: translate(-50%, -50%);
  pointer-events: auto;
}
.live-focus-thing-shelf.live-root-thing-shelf > .live-thing-more {
  position: absolute;
  pointer-events: auto;
}
.live-stage-empty {
  position: absolute;
  z-index: 8;
  inset: 8rem auto auto 1rem;
  max-width: 24rem;
  color: var(--paper-light);
  background: rgba(13, 37, 31, 0.78);
  pointer-events: none;
}
.live-proof-load {
  position: absolute;
  z-index: 72;
  display: grid;
  width: min(18rem, calc(100vw - 4rem));
  gap: 0.35rem;
  padding: 0.65rem;
  color: var(--ink);
  background: var(--paper-light);
  border: 3px solid var(--line);
  box-shadow: 5px 5px 0 rgba(0, 0, 0, 0.48);
  pointer-events: auto;
  font: 750 0.62rem/1.4 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.live-proof-load-failed { background: var(--signal); }
.live-proof-load-ready { background: var(--sky); }
.live-proof-load .selection-retry { min-height: 2.75rem; }
.live-walker[data-live-focus-resident] .live-portrait,
.live-replay-portrait[data-live-focus-resident] .live-portrait {
  outline: 4px solid var(--signal);
  outline-offset: 3px;
  box-shadow: none;
}
.live-walker.asleep, .live-replay-portrait.asleep { opacity: 0.56; }
.live-resident-more, .live-thing-more {
  position: absolute;
  z-index: 14;
  min-width: max-content;
  min-height: 3.5rem;
  padding: 0.2rem 0.42rem;
  color: var(--ink);
  background: var(--signal);
  border: 2px solid var(--line);
  box-shadow: 2px 2px 0 rgba(0, 0, 0, 0.42);
  font: 900 0.58rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  cursor: pointer;
  pointer-events: auto;
}
.live-resident-more::before, .live-thing-more::before {
  content: "";
  position: absolute;
  width: 0.72rem;
  height: 0.72rem;
  inset: -0.36rem auto auto -0.36rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 0.28rem 0.2rem 0 var(--forest);
}
.live-resident-more { inset: auto 0.38rem 0.38rem auto; }
.live-thing-more { background: var(--sky); }
.live-thing-shelf > .live-thing-more {
  position: static;
  align-self: center;
  justify-self: end;
}
.live-plot > .live-thing-shelf > .live-thing-more {
  position: absolute;
  inset: auto 0.38rem 0.38rem auto;
}
.live-plot:has(.live-resident-more) > .live-thing-shelf > .live-thing-more {
  inset: auto 0.38rem -4rem auto;
}
.live-plot > .live-portrait-grid:not([data-live-expanded="true"]) > .live-resident-more,
.live-plot > .live-thing-shelf:not([data-live-expanded="true"]) > .live-thing-more {
  width: 128px;
  min-width: 0;
  min-height: 44px;
  height: 44px;
}
.live-plot > .live-portrait-grid:not([data-live-expanded="true"]) > .live-resident-more {
  inset: 286px auto auto 146px;
}
.live-plot > .live-thing-shelf:not([data-live-expanded="true"]) > .live-thing-more,
.live-plot:has(.live-resident-more)
  > .live-thing-shelf:not([data-live-expanded="true"]) > .live-thing-more {
  inset: 286px auto auto 286px;
}
.live-overflow-absorbing { animation: live-overflow-absorb 480ms steps(4, end) both; }
.live-trace-layer {
  position: absolute;
  z-index: 10;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.live-traces {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
  pointer-events: none;
}
.live-trail {
  stroke: var(--brick);
  stroke-width: 2.5;
  stroke-dasharray: 7 6;
  stroke-linecap: square;
  vector-effect: non-scaling-stroke;
  pointer-events: stroke;
  cursor: pointer;
  transition: opacity 420ms linear;
}
.live-trail-inking, .live-trail[data-replaying="true"] {
  animation: live-trail-ink var(--live-trail-duration, 3.2s) linear both;
}
.live-speech-bubble::after {
  content: "";
  position: absolute;
  inset: 100% auto auto 0.7rem;
  border: 0.32rem solid transparent;
  border-top-color: var(--line);
}

@keyframes live-print-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--brick); }
  50% { box-shadow: 0 0 0 10px transparent; }
}

@keyframes live-recorded-glide {
  to {
    transform: translate(
      calc(-50% + var(--live-replay-delta-x, 0px)),
      calc(-100% + var(--live-replay-delta-y, 0px))
    );
  }
}

@keyframes live-overflow-absorb {
  0% { opacity: 1; transform: scale(0.84); background: var(--brick); color: #fff; }
  55% { opacity: 1; transform: scale(1.16); background: var(--signal); color: var(--ink); }
  100% { opacity: 1; transform: scale(1); background: var(--signal); color: var(--ink); }
}

@keyframes live-trail-ink {
  from { stroke-dashoffset: 36; opacity: 0; }
  16% { opacity: 1; }
  to { stroke-dashoffset: 0; opacity: 1; }
}

.map-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(17rem, 22rem); }
.place-map { min-height: 28rem; padding: 1.15rem; overflow-wrap: anywhere; }
.place-tree { padding: 0; margin: 0; list-style: none; }
.place-tree[hidden] { display: none; }
.place-tree .place-tree { margin-inline-start: 1.35rem; border-inline-start: 2px solid var(--paper-line); }
.place-node { position: relative; padding: 0.55rem 0 0.55rem 0.95rem; }
.place-tree .place-tree > .place-node::before {
  content: "";
  position: absolute;
  inset: 1.55rem auto auto 0;
  width: 0.68rem;
  border-top: 2px solid var(--paper-line);
}
.place-card {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  gap: 0.35rem 0.85rem;
  padding: 0.78rem 0.85rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(32, 56, 47, 0.13);
}
.place-card > .place-portrait { grid-column: 1; grid-row: 1 / 3; }
.place-card > .place-watch { grid-column: 2; grid-row: 1; }
.place-card > .place-owner { grid-column: 2; grid-row: 2; }
.place-card[data-watched="true"] { border-color: var(--brick); box-shadow: 5px 5px 0 rgba(173, 63, 37, 0.23); }
.place-name, .place-owner, .activity-copy, .note-body, .thing-body, .agreement-body {
  unicode-bidi: plaintext;
  overflow-wrap: anywhere;
}
.place-watch, .resident-follow {
  display: inline-flex;
  align-items: center;
  min-width: 24px;
  min-height: 24px;
  width: fit-content;
  padding: 0;
  color: var(--forest-deep);
  background: transparent;
  border: 0;
  cursor: pointer;
  font-weight: 900;
  text-align: start;
  text-decoration: underline;
  text-decoration-thickness: 0.1em;
  text-underline-offset: 0.18em;
}
.place-name { font-size: 1rem; }
.place-disclosure {
  grid-column: 1 / -1;
  width: fit-content;
  padding: 0.22rem 0.45rem;
  color: var(--forest-deep);
  background: transparent;
  border: 1px solid var(--paper-line);
  cursor: pointer;
  font-size: 0.65rem;
  font-weight: 850;
}
.place-disclosure:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.branch-page {
  display: grid;
  justify-items: start;
  gap: 0.45rem;
  padding: 0.45rem 0 0.65rem 0.95rem;
  list-style: none;
}
.branch-page p { margin: 0; color: var(--muted); font-size: 0.68rem; line-height: 1.45; }
.branch-page button, .navigation-page button {
  min-height: 2.35rem;
  width: fit-content;
  padding: 0.5rem 0.7rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 2px solid var(--line);
  cursor: pointer;
  font: inherit;
  font-size: 0.68rem;
  font-weight: 850;
}
.branch-page button[aria-busy="true"], .navigation-page button[aria-busy="true"] {
  cursor: wait;
  opacity: 0.72;
}
.branch-page button:focus-visible, .navigation-page button:focus-visible {
  outline: 3px solid var(--focus);
  outline-offset: 2px;
}
.place-owner { color: var(--forest); font-size: 0.75rem; font-weight: 750; }
.place-facts {
  grid-column: 3;
  grid-row: 1 / 3;
  align-self: center;
  color: var(--muted);
  font-size: 0.64rem;
  line-height: 1.55;
  text-align: end;
}
.occupant-line {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding-block-start: 0.35rem;
  border-top: 1px dashed var(--paper-line);
}
.occupant-chip, .trait-chip, .signature-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  width: fit-content;
  padding: 0.2rem 0.4rem;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.63rem;
  font-weight: 780;
}
.occupant-chip { color: #fff; background: var(--forest); }
.occupant-chip .entity-portrait,
.signature-chip .entity-portrait { width: 1.5rem; height: 1.5rem; flex-basis: 1.5rem; }
.occupant-chip::before { content: "●"; color: var(--signal); }
.occupant-chip.asleep { opacity: 0.45; }
.occupant-chip.asleep::before { content: "○"; }
.resident-row.asleep, .person-card.asleep { opacity: 0.5; }

.sleeper-toggle {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 0.2rem 0.4rem;
  font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
  font-size: 0.63rem;
  font-weight: 780;
  color: var(--forest);
  background: transparent;
  border: 1px dashed var(--forest);
  cursor: pointer;
}
.sleeper-toggle:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.roster-board {
  min-width: 0;
  padding: 1.15rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border-inline-start: 4px solid var(--line);
}
.board-label, .block-number {
  color: var(--signal);
  font-size: 0.62rem;
  font-weight: 900;
  letter-spacing: 0.1em;
}
.roster-board h2 { margin: 0.45rem 0 1rem; font-size: 1.65rem; line-height: 0.95; }
.navigation-page { display: grid; justify-items: start; gap: 0.45rem; margin-top: 0.85rem; }
.navigation-page[hidden] { display: none; }
.navigation-page p { margin: 0; color: var(--sky); font-size: 0.68rem; line-height: 1.45; }
.roster-group { padding: 0.75rem 0; border-top: 1px solid rgba(255, 255, 255, 0.22); }
.roster-place { margin: 0 0 0.5rem; color: var(--sky); font-size: 0.72rem; font-weight: 850; }
.resident-row {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0;
}
.resident-row .resident-follow { color: #fff; font-size: 0.78rem; }
.resident-number { color: var(--signal); font: 0.63rem ui-monospace, monospace; }

.place-orientation {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  background: #f4ecd5;
  border-bottom: 4px solid var(--line);
}
.orientation-block { min-width: 0; padding: clamp(1rem, 3vw, 1.5rem); }
.orientation-block + .orientation-block { border-inline-start: 2px solid var(--line); }
.orientation-block h3 { margin: 0.35rem 0 0.8rem; font-size: 1.25rem; }
.place-description { background: #f4ecd5; border-bottom: 2px solid var(--line); }
.place-description-text, .place-purpose-text { max-width: 54rem; margin: 0; font-size: 0.92rem; line-height: 1.55; }
.place-description-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.front-matter-list {
  display: grid;
  gap: 0.65rem;
  margin: 0;
  padding-inline-start: 1.6rem;
}
.front-matter-heading {
  padding: 0.72rem 0.8rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
}
.front-matter-title { display: flex; }
.front-matter-link { color: var(--forest-deep); font-weight: 900; overflow-wrap: anywhere; }
.front-matter-meta { margin-block-start: 0.4rem; }

.place-observation {
  display: grid;
  grid-template-columns: minmax(0, 0.72fr) minmax(0, 1.28fr);
}
.observation-block { min-width: 0; padding: clamp(1rem, 3vw, 1.5rem); border-inline-end: 2px solid var(--line); }
.observation-block:nth-child(2) { border-inline-end: 0; }
.wide-block { grid-column: 1 / -1; border-top: 4px solid var(--line); border-inline-end: 0; }
.observation-block h3 { margin: 0.35rem 0 1rem; font-size: 1.65rem; }
.person-list, .thing-list, .note-list { display: grid; gap: 0.7rem; padding: 0; margin: 0; list-style: none; }
.person-card, .thing-card, .note-card, .agreement-card {
  padding: 0.82rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
}
.person-card {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
}
.person-card strong { color: var(--forest-deep); }
.thing-card { display: grid; gap: 0.55rem; }
.thing-card h4 { display: flex; gap: 0.5rem; align-items: center; margin: 0; font-size: 1rem; }
.thing-meta, .note-meta, .agreement-meta { margin: 0; color: var(--muted); font-size: 0.64rem; line-height: 1.45; }
.thing-body, .note-body, .agreement-body { white-space: pre-wrap; }
.thing-body { margin: 0; color: #344039; font-size: 0.84rem; line-height: 1.55; }
.body-block { display: grid; justify-items: start; gap: 0.42rem; min-width: 0; }
.public-body[data-expanded="false"] {
  display: -webkit-box;
  max-height: 8.25em;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
}
.body-disclosure {
  width: fit-content;
  padding: 0.35rem 0.58rem;
  color: var(--forest-deep);
  background: var(--paper-light);
  border: 1px solid var(--line);
  cursor: pointer;
  font-size: 0.68rem;
  font-weight: 850;
}
.body-disclosure:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.body-availability { margin: 0; color: var(--muted); font-size: 0.66rem; line-height: 1.45; }
.body-full-link { color: var(--forest-deep); font-weight: 850; }
/* A followable handle wherever one is printed, not only in the roster. */
.resident-follow-inline {
  padding: 0;
  background: transparent;
  border: 0;
  color: var(--forest-deep);
  font-family: inherit;
  font-size: inherit;
  font-weight: 900;
  text-decoration: underline;
  text-underline-offset: 0.15em;
  cursor: pointer;
}
.resident-follow-inline:hover { color: var(--brick-deep); }
.resident-follow-inline:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.trait-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.trait-chip { color: var(--paper-light); background: var(--brick-deep); }
.trait-chip[data-moderated="true"] { color: var(--ink); background: var(--signal); }

.conversation-mode {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem 1rem;
  padding: 0.8rem clamp(0.8rem, 2.5vw, 1.4rem);
  color: var(--ink);
  background: var(--paper-light);
  border-bottom: 3px solid var(--line);
}
.conversation-mode[hidden] { display: none; }
.conversation-question {
  flex: 1 1 14rem;
  margin: 0;
  color: var(--forest-deep);
  font: 800 0.7rem/1.45 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.conversation-choices { display: flex; flex: 0 1 auto; flex-wrap: wrap; gap: 0.45rem; }
.conversation-mode-button {
  min-height: 2.6rem;
  padding: 0.55rem 0.75rem;
  color: var(--forest-deep);
  background: #fffef8;
  border: 2px solid var(--line);
  cursor: pointer;
  font: inherit;
  font-size: 0.7rem;
  font-weight: 850;
}
.conversation-mode-button:hover { background: var(--sky); }
.conversation-mode-button[aria-pressed="true"] {
  color: var(--paper-light);
  background: var(--forest);
  box-shadow: inset 0 -3px 0 var(--forest-deep);
}
.conversation-mode-button:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
.conversation-mode-button[aria-pressed="true"]:focus-visible {
  box-shadow: inset 0 -3px 0 var(--forest-deep), 0 0 0 3px var(--focus-dark);
}
.conversation-stream { padding: clamp(0.8rem, 2.5vw, 1.4rem); }
.conversation-group { display: grid; grid-template-columns: minmax(11rem, 0.3fr) minmax(0, 1fr); gap: 1rem; padding: 1.15rem 0; border-bottom: 3px solid var(--line); }
.conversation-group:first-child { padding-block-start: 0; }
.conversation-group h3 { margin: 0; color: var(--forest-deep); font-size: 1.55rem; }
.conversation-group .place-facts { display: block; margin-top: 0.4rem; text-align: start; }
.note-card { position: relative; padding-inline-start: 1rem; }
.note-card::before { content: ""; position: absolute; inset: 0 auto 0 0; width: 0.35rem; background: var(--brick); }
.note-body { margin: 0.45rem 0 0; line-height: 1.6; }
.note-author { color: var(--forest-deep); font-weight: 900; }
.context-note { opacity: 0.82; margin-inline-start: 1.1rem; }
.context-note::before { width: 0.2rem; background: var(--line); }
.context-mark {
  display: inline-block; margin-top: 0.35rem; padding: 0.1rem 0.45rem;
  border: 1px solid var(--line); border-radius: 999px;
  color: var(--muted); font-size: 0.58rem; letter-spacing: 0.08em;
  text-transform: uppercase;
}

.activity-list { padding: 0; margin: 0; list-style: none; }
.activity-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.7rem 1rem;
  padding: 1rem clamp(1rem, 3vw, 1.5rem);
  border-bottom: 1px dashed var(--paper-line);
}
.activity-row:nth-child(even) { background: rgba(23, 77, 60, 0.055); }
.activity-copy { margin: 0; font-weight: 720; line-height: 1.45; }
.activity-actor { color: var(--forest-deep); font-weight: 900; }
.activity-count {
  color: var(--brick-deep);
  font: 850 0.65rem/1.2 ui-monospace, "Cascadia Mono", Consolas, monospace;
  white-space: nowrap;
}
.activity-context { grid-column: 1 / -1; color: var(--muted); font-size: 0.72rem; }
.activity-time { color: var(--muted); font-size: 0.65rem; white-space: nowrap; }

.agreement-list { display: grid; gap: 1rem; padding: clamp(0.8rem, 2.5vw, 1.4rem); }
.agreement-card { display: grid; grid-template-columns: minmax(0, 1fr) minmax(13rem, 0.34fr); gap: 1rem 1.3rem; }
.agreement-body { margin: 0; font-family: Georgia, "Times New Roman", serif; font-size: 1.05rem; line-height: 1.65; }
.agreement-side { padding-inline-start: 1rem; border-inline-start: 2px solid var(--paper-line); }
.agreement-side h3 { margin: 0 0 0.6rem; font-size: 0.78rem; text-transform: uppercase; }
.signature-list { display: flex; flex-wrap: wrap; gap: 0.38rem; }
.signature-chip { color: var(--paper-light); background: var(--forest); }
.signature-chip[data-signed="false"] { color: var(--muted); background: #ddd4bc; border: 1px dashed var(--paper-line); }
.badge { display: inline-block; margin-block-start: 0.7rem; padding: 0.25rem 0.42rem; font-size: 0.61rem; font-weight: 850; text-transform: uppercase; }
.badge-open { color: #fff; background: var(--brick); }
.badge-complete { color: #fff; background: var(--forest); }

.archive-form {
  display: grid;
  grid-template-columns: minmax(14rem, 1fr) minmax(9rem, 0.24fr) minmax(10rem, 0.28fr) auto;
  gap: 0.8rem;
  align-items: end;
  padding: clamp(1rem, 3vw, 1.5rem);
  background: var(--paper-light);
  border-bottom: 3px solid var(--line);
}
.archive-form label { display: grid; gap: 0.35rem; min-width: 0; }
.archive-form label > span {
  color: var(--forest-deep);
  font: 800 0.66rem/1.35 ui-monospace, "Cascadia Mono", Consolas, monospace;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.archive-form input, .archive-form select, .archive-form button,
.archive-page button, .archive-retry {
  min-height: 2.8rem;
  padding: 0.65rem 0.75rem;
  border: 2px solid var(--line);
  border-radius: 0;
  font: inherit;
}
.archive-form input, .archive-form select { width: 100%; color: var(--ink); background: #fffef8; }
.archive-form button, .archive-page button, .archive-retry {
  color: var(--paper-light);
  background: var(--forest);
  cursor: pointer;
  font-weight: 850;
}
.archive-form button:hover, .archive-page button:hover, .archive-retry:hover { background: var(--ink); }
.archive-form button:disabled { cursor: wait; opacity: 0.7; }
.archive-results { padding: clamp(0.8rem, 2.5vw, 1.4rem); }
.archive-summary {
  margin: 0 0 0.9rem;
  color: var(--muted);
  font: 750 0.7rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
}
.archive-list { display: grid; gap: 0.75rem; padding: 0; margin: 0; list-style: none; }
.archive-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.45rem 1rem;
  padding: 0.9rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(32, 56, 47, 0.13);
}
.archive-result-title { margin: 0; overflow-wrap: anywhere; font-size: 1rem; }
.archive-result-meta {
  grid-column: 1;
  margin: 0;
  color: var(--muted);
  font: 0.65rem/1.5 ui-monospace, "Cascadia Mono", Consolas, monospace;
  unicode-bidi: plaintext;
  overflow-wrap: anywhere;
}
.archive-open { grid-column: 2; grid-row: 1 / 3; align-self: center; font-weight: 850; }
.archive-page { display: flex; align-items: center; gap: 0.75rem; padding: 0 clamp(0.8rem, 2.5vw, 1.4rem) 1.4rem; }
.archive-page[hidden] { display: none; }
.archive-page .loading-row, .archive-page .error-row { margin: 0; padding: 0; }

.gazette-heading > p {
  position: relative;
  z-index: 1;
  max-width: 44rem;
  margin: 0.75rem 0 0;
  line-height: 1.5;
}
.gazette-heading .eyebrow { margin-block-start: 0; }
.gazette-heading a { font-weight: 850; }
.gazette-mechanic { font-size: 0.78rem; }
.gazette-actions {
  position: relative;
  z-index: 2;
  display: flex;
  justify-content: flex-end;
  gap: 0.65rem;
  width: 100%;
  margin-block-start: 0.8rem;
}
.gazette-actions .share-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: inherit;
  line-height: 1.2;
  text-decoration: none;
}
.gazette-actions .share-button[hidden] { display: none; }
.gazette-share-button {
  min-width: 10.5rem;
  color: var(--ink);
  background: var(--signal);
  border-color: var(--paper-light);
  box-shadow: 4px 4px 0 rgba(0, 0, 0, 0.38);
}
.gazette-share-button:hover { color: var(--paper-light); background: var(--forest-deep); }
.gazette-layout {
  display: grid;
  grid-template-columns: minmax(15rem, 20rem) minmax(0, 1fr);
  align-items: start;
  min-width: 0;
}
.gazette-archive {
  min-width: 0;
  padding: clamp(0.8rem, 2.5vw, 1.25rem);
  background: #ddd4bc;
  border-inline-end: 3px solid var(--line);
}
.gazette-archive h3, .gazette-issue-title {
  margin: 0 0 0.8rem;
  overflow-wrap: anywhere;
  font-family: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  font-weight: 900;
  text-transform: uppercase;
}
.gazette-issue-list-items, .gazette-entries {
  display: grid;
  gap: 0.75rem;
  padding: 0;
  margin: 0;
  list-style: none;
}
.gazette-issue-summary {
  min-width: 0;
  padding: 0.75rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
}
.gazette-issue-link {
  display: inline-block;
  font-weight: 900;
}
.gazette-issue-link[aria-current="page"] { color: var(--brick-deep); }
.gazette-issue-summary-meta, .gazette-print-time, .gazette-entry-attribution {
  margin: 0.35rem 0 0;
  color: var(--muted);
  font: 0.66rem/1.55 ui-monospace, "Cascadia Mono", Consolas, monospace;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.gazette-entry-attribution {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  align-items: center;
}
.gazette-issue {
  min-width: 0;
  padding: clamp(1rem, 3vw, 1.6rem);
}
.gazette-provenance {
  margin: 1rem 0;
  padding: 0.8rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border-inline-start: 5px solid var(--signal);
  font: 0.72rem/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
}
.gazette-entry {
  min-width: 0;
  padding: clamp(0.8rem, 2.5vw, 1.15rem);
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(32, 56, 47, 0.13);
}
.gazette-entry-body {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  unicode-bidi: plaintext;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 1.02rem;
  line-height: 1.65;
}
.gazette-page {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
  padding-block-start: 0.85rem;
}
.gazette-page[hidden] { display: none; }
.gazette-entries-page {
  grid-column: 2;
  padding: 0 clamp(1rem, 3vw, 1.6rem) clamp(1rem, 3vw, 1.6rem);
}
.gazette-page .loading-row, .gazette-page .error-row { margin: 0; padding: 0; }
.gazette-load, .gazette-retry {
  min-height: 2.75rem;
  padding: 0.65rem 0.85rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 2px solid var(--line);
  cursor: pointer;
  font-weight: 850;
}
.gazette-load:hover, .gazette-retry:hover { background: var(--ink); }

.history-page {
  display: grid;
  justify-items: start;
  gap: 0.5rem;
  margin-top: 0.9rem;
}
.history-page button {
  width: fit-content;
  padding: 0.4rem 0.7rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 1px solid var(--forest-deep);
  cursor: pointer;
  font-size: 0.69rem;
  font-weight: 850;
}
.history-page button[disabled] {
  opacity: 0.65;
  cursor: wait;
}
.history-page button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.loading-row, .empty-row, .error-row { padding: 1rem; color: var(--muted); font-size: 0.72rem; line-height: 1.55; }
.history-page { padding: 0.2rem clamp(0.8rem, 2.5vw, 1.4rem) 1.25rem; }
.history-page[hidden] { display: none; }
.history-page button {
  min-height: 2.6rem;
  padding: 0.65rem 0.85rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 2px solid var(--line);
  font: inherit;
  font-weight: 850;
  cursor: pointer;
}
.history-page button:hover { background: var(--ink); }
.history-page button:disabled { cursor: wait; opacity: 0.72; }
.history-page button:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
.roster-board .loading-row, .roster-board .empty-row, .roster-board .error-row { color: var(--sky); padding-inline: 0; }
.moderated-mark { color: var(--brick); font-size: 0.68rem; font-weight: 850; }

.window-footer {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1.5rem;
  padding: 1.5rem 0 2.7rem;
  font-size: 0.78rem;
  line-height: 1.5;
}
.window-footer p { margin: 0; }
.window-footer nav { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.75rem 1rem; }

:focus-visible {
  outline: 4px solid var(--focus);
  outline-offset: 3px;
  box-shadow: 0 0 0 3px var(--focus-dark);
}
@keyframes instrument-on {
  from { opacity: 0; transform: translateY(0.45rem); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes panel-in {
  from { opacity: 0; transform: translateX(0.25rem); }
  to { opacity: 1; transform: translateX(0); }
}

@media (max-width: 72rem) {
  .directory-status { flex: 1 1 18rem; max-width: none; }
  .share-button { min-width: 8rem; }
}
@media (max-width: 54rem) {
  .map-layout { grid-template-columns: 1fr; }
  .live-layout { display: block; }
  .live-stage-shell { padding: 0.5rem; }
  .live-viewport { height: min(68vh, 38rem); min-height: 26rem; }
  .live-plates { padding: 0; }
  .live-stage-readout { grid-template-columns: 1fr; }
  .live-focus-status { justify-self: start; text-align: start; }
  .live-plate-legend { align-self: auto; }
  .live-roster-board { border-block-start: 4px solid var(--line); border-inline-start: 0; }
  .roster-board { border-block-start: 4px solid var(--line); border-inline-start: 0; }
  .conversation-group { grid-template-columns: 1fr; }
  .agreement-card { grid-template-columns: 1fr; }
  .agreement-side { padding-block-start: 1rem; padding-inline-start: 0; border-block-start: 2px solid var(--paper-line); border-inline-start: 0; }
  .window-footer { display: block; }
  .window-footer nav { justify-content: start; margin-block-start: 1rem; }
  .archive-form { grid-template-columns: 1fr 1fr; }
  .archive-query-field { grid-column: 1 / -1; }
  .gazette-layout { grid-template-columns: minmax(0, 1fr); }
  .gazette-archive { border-block-end: 3px solid var(--line); border-inline-end: 0; }
  .gazette-entries-page { grid-column: 1; }
}
@media (max-width: 40rem) {
  .city-sign { grid-template-columns: 1fr; }
  .watch-state { border-block-start: 3px solid #061e17; border-inline-start: 0; }
  .view-filters { display: grid; grid-template-columns: 1fr; }
  .directory-status { grid-column: 1 / -1; max-width: none; border-block-start: 2px solid var(--line); }
  .record-detail-heading { grid-template-columns: 1fr; }
  .record-detail-actions { display: grid; }
  .record-detail-heading .share-button, .detail-close { justify-self: stretch; }
  .drawing-snapshot, .drawing-history-revision { grid-template-columns: 1fr; }
  .drawing-snapshot > *, .drawing-history-revision > * { grid-column: 1; }
  .drawing-history-control { width: 100%; }
  .drawing-canonical-rows { overflow-x: auto; }
  .panel-heading > .share-button { position: relative; inset: auto; justify-self: start; margin-block-start: 0.8rem; }
  .place-orientation { grid-template-columns: 1fr; }
  .orientation-block + .orientation-block { border-block-start: 2px solid var(--line); border-inline-start: 0; }
  .place-observation { grid-template-columns: 1fr; }
  .observation-block, .observation-block:nth-child(2) { border-inline-end: 0; border-bottom: 3px solid var(--line); }
  .wide-block { grid-column: auto; border-top: 0; border-bottom: 0; }
  .activity-row { grid-template-columns: 1fr; }
  .activity-time, .activity-context { grid-column: 1; }
  .place-map { padding: 0.55rem; }
  .live-instrument-strip { align-items: flex-start; }
  .live-breadcrumbs { flex-basis: 100%; }
  .live-camera-controls { flex: 1 1 auto; }
  .live-control-button { flex: 1 1 8rem; }
  .live-clock { flex-basis: 100%; text-align: start; }
  .live-stage-shell { padding: 0.38rem; }
  .live-viewport { height: min(64vh, 32rem); min-height: 22rem; }
  .live-stage-readout { padding-inline: 0.25rem; }
  .live-ledger-row { grid-template-columns: 2rem minmax(0, 1fr); }
  .live-ledger-time { grid-column: 2; }
  .conversation-mode { align-items: stretch; }
  .conversation-choices { width: 100%; }
  .conversation-mode-button { flex: 1 1 12rem; }
  .place-tree .place-tree { margin-inline-start: 0.55rem; }
  .place-card { grid-template-columns: 2rem minmax(0, 1fr); }
  .place-card > .place-portrait { grid-column: 1; grid-row: 1 / 3; }
  .place-card > .place-watch { grid-column: 2; }
  .place-card > .place-owner { grid-column: 2; }
  .place-facts { grid-column: 1 / -1; grid-row: auto; text-align: start; }
  .archive-form { grid-template-columns: 1fr; }
  .archive-query-field { grid-column: auto; }
  .archive-card { grid-template-columns: 1fr; }
  .archive-open { grid-column: 1; grid-row: auto; }
  .gazette-actions {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .gazette-actions #gazette-read[hidden] + .gazette-share-button { grid-column: 1 / -1; }
  .gazette-share-button { width: 100%; min-height: 2.75rem; }
  .gazette-page { align-items: stretch; flex-direction: column; }
  .gazette-load, .gazette-retry { width: 100%; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; }
  .live-action-mark.live-pulse { display: none !important; animation: none !important; }
  .live-thing-specimen.live-pulse { animation: none !important; }
  .live-walker, .live-replay-portrait, .live-overflow-absorbing,
  .live-speech-bubble { animation: none !important; transition: none !important; }
  .live-trail, .live-trail-inking { animation: none !important; transition: none !important; }
}
@media (forced-colors: active) {
  .city-sign, .view-console, .window-frame, .place-card, .person-card, .thing-card,
  .note-card, .agreement-card, .gazette-entry, .gazette-issue-summary, .live-stage-shell,
  .live-viewport, .live-plot, .live-portrait, .live-speech-bubble,
  .live-resident-more, .live-thing-more, .live-control-button,
  .drawing-grid, .live-resident-tag { border-color: CanvasText; box-shadow: none; }
  .live-world-ground, .live-plot-terrain { forced-color-adjust: none; }
  .live-plot-open, .live-focus-clear { color: LinkText; }
  .live-trail { stroke: LinkText; }
  .live-footnote-mark, .live-action-mark, .live-resident-more,
  .live-thing-more, .live-control-button { color: ButtonText; background: ButtonFace; }
  .live-speech-bubble { color: CanvasText; background: Canvas; }
}
`
