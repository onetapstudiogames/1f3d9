export const WINDOW_CSS = `:root {
  color-scheme: dark;
  --night: #0b1714;
  --night-soft: #14241f;
  --forest: #174d3c;
  --forest-deep: #092d22;
  --paper: #e9e0c5;
  --paper-light: #fff9e8;
  --ink: #15231d;
  --muted: #5f695f;
  --brick: #ad3f25;
  --brick-deep: #712413;
  --signal: #f0c95f;
  --sky: #94c7bc;
  --line: #20382f;
  --paper-line: #9d9276;
  --focus: #fff19b;
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
button, select { font: inherit; }
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
.watch-state [data-tone="live"]::before { content: "● "; color: var(--forest); }
.watch-state [data-tone="stale"]::before,
.watch-state [data-tone="working"]::before { content: "● "; color: var(--brick); }
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
  grid-template-columns: minmax(0, 1fr) auto;
  margin-block-start: 0.85rem;
  color: var(--paper-light);
  background: var(--forest-deep);
  border: 4px solid var(--line);
  box-shadow: 11px 11px 0 rgba(0, 0, 0, 0.46);
}
.view-tabs { display: flex; min-width: 0; overflow-x: auto; }
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
.view-filters {
  display: flex;
  align-items: stretch;
  background: #102c23;
  border-inline-start: 3px solid var(--line);
}
.view-filters label { display: grid; align-content: center; gap: 0.2rem; padding: 0.42rem 0.65rem; }
.view-filters label > span {
  color: var(--sky);
  font-size: 0.58rem;
  font-weight: 800;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.view-filters select {
  width: min(11rem, 20vw);
  padding: 0.3rem 1.6rem 0.3rem 0.4rem;
  color: #fff;
  background: var(--night-soft);
  border: 1px solid #6e9689;
  border-radius: 0;
  font-size: 0.72rem;
}
.share-view {
  display: grid;
  place-items: center;
  padding: 0.65rem 0.85rem;
  color: var(--ink);
  background: var(--paper);
  border-inline-start: 2px solid var(--line);
  font-size: 0.67rem;
  font-weight: 850;
  text-align: center;
}
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
.window-frame:focus { outline: none; }
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
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.35rem 0.85rem;
  padding: 0.78rem 0.85rem;
  background: var(--paper-light);
  border: 2px solid var(--line);
  box-shadow: 4px 4px 0 rgba(32, 56, 47, 0.13);
}
.place-card[data-watched="true"] { border-color: var(--brick); box-shadow: 5px 5px 0 rgba(173, 63, 37, 0.23); }
.place-name, .place-owner, .activity-copy, .note-body, .thing-body, .agreement-body {
  unicode-bidi: plaintext;
  overflow-wrap: anywhere;
}
.place-watch, .resident-follow {
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
.place-disclosure:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
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
  outline: 3px solid var(--signal);
  outline-offset: 2px;
}
.place-owner { color: var(--forest); font-size: 0.75rem; font-weight: 750; }
.place-facts {
  grid-column: 2;
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
.sleeper-toggle:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }

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
.resident-row { display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; padding: 0.3rem 0; }
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
.place-purpose-text { max-width: 54rem; margin: 0; font-size: 0.92rem; line-height: 1.55; }
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
.person-card { display: flex; justify-content: space-between; gap: 1rem; }
.person-card strong { color: var(--forest-deep); }
.thing-card { display: grid; gap: 0.55rem; }
.thing-card h4 { margin: 0; font-size: 1rem; }
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
.body-disclosure:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
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
.resident-follow-inline:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }
.trait-list { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.trait-chip { color: var(--paper-light); background: var(--brick-deep); }
.trait-chip[data-moderated="true"] { color: var(--ink); background: var(--signal); }

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
.history-page button:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }

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

:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }
@keyframes instrument-on {
  from { opacity: 0; transform: translateY(0.45rem); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes panel-in {
  from { opacity: 0; transform: translateX(0.25rem); }
  to { opacity: 1; transform: translateX(0); }
}

@media (max-width: 72rem) {
  .view-console { grid-template-columns: 1fr; }
  .view-filters { border-block-start: 3px solid var(--line); border-inline-start: 0; }
  .view-filters label { flex: 1; }
  .view-filters select { width: 100%; }
}
@media (max-width: 54rem) {
  .map-layout { grid-template-columns: 1fr; }
  .roster-board { border-block-start: 4px solid var(--line); border-inline-start: 0; }
  .conversation-group { grid-template-columns: 1fr; }
  .agreement-card { grid-template-columns: 1fr; }
  .agreement-side { padding-block-start: 1rem; padding-inline-start: 0; border-block-start: 2px solid var(--paper-line); border-inline-start: 0; }
  .window-footer { display: block; }
  .window-footer nav { justify-content: start; margin-block-start: 1rem; }
  .archive-form { grid-template-columns: 1fr 1fr; }
  .archive-query-field { grid-column: 1 / -1; }
}
@media (max-width: 40rem) {
  .city-sign { grid-template-columns: 1fr; }
  .watch-state { border-block-start: 3px solid #061e17; border-inline-start: 0; }
  .view-filters { display: grid; grid-template-columns: 1fr 1fr; }
  .share-view { grid-column: 1 / -1; border-block-start: 2px solid var(--line); border-inline-start: 0; }
  .place-orientation { grid-template-columns: 1fr; }
  .orientation-block + .orientation-block { border-block-start: 2px solid var(--line); border-inline-start: 0; }
  .place-observation { grid-template-columns: 1fr; }
  .observation-block, .observation-block:nth-child(2) { border-inline-end: 0; border-bottom: 3px solid var(--line); }
  .wide-block { grid-column: auto; border-top: 0; border-bottom: 0; }
  .activity-row { grid-template-columns: 1fr; }
  .activity-time, .activity-context { grid-column: 1; }
  .place-map { padding: 0.55rem; }
  .place-tree .place-tree { margin-inline-start: 0.55rem; }
  .place-card { grid-template-columns: 1fr; }
  .place-facts { grid-column: 1; grid-row: auto; text-align: start; }
  .archive-form { grid-template-columns: 1fr; }
  .archive-query-field { grid-column: auto; }
  .archive-card { grid-template-columns: 1fr; }
  .archive-open { grid-column: 1; grid-row: auto; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: 0.01ms !important; }
}
@media (forced-colors: active) {
  .city-sign, .view-console, .window-frame, .place-card, .person-card, .thing-card,
  .note-card, .agreement-card { border-color: CanvasText; box-shadow: none; }
}
`
