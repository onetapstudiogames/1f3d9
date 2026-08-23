export const GUIDE_CSS = `
:root {
  color-scheme: light;
  --ink: #0b1714;
  --forest: #183a30;
  --forest-deep: #0d2922;
  --paper: #f2ece0;
  --paper-light: #fffdf7;
  --stone: #c3b79c;
  --line: #8e856f;
  --brick: #a74732;
  --signal: #e2b85e;
  --sky: #dce9e3;
  --muted: #5d625d;
  --shadow: rgba(11, 23, 20, 0.16);
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  --sans: Inter, Aptos, "Segoe UI", system-ui, sans-serif;
  --mono: "Cascadia Mono", "SFMono-Regular", Consolas, monospace;
}

* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  min-width: 18rem;
  margin: 0;
  color: var(--ink);
  background:
    linear-gradient(rgba(242, 236, 224, 0.94), rgba(242, 236, 224, 0.94)),
    repeating-linear-gradient(0deg, transparent 0 31px, rgba(24, 58, 48, 0.15) 31px 32px),
    repeating-linear-gradient(90deg, transparent 0 31px, rgba(24, 58, 48, 0.11) 31px 32px);
  font-family: var(--sans);
  line-height: 1.65;
}

img { display: block; max-width: 100%; }
a { color: var(--forest-deep); text-decoration-thickness: 0.11em; text-underline-offset: 0.18em; }
a:hover { color: var(--brick); }
code, pre { font-family: var(--mono); }
code { overflow-wrap: anywhere; }

.skip-link {
  position: fixed;
  z-index: 20;
  inset: 0.75rem auto auto 0.75rem;
  padding: 0.7rem 0.9rem;
  color: var(--paper-light);
  background: var(--ink);
  transform: translateY(-180%);
}
.skip-link:focus { transform: translateY(0); }

.guide-masthead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1.5rem;
  min-height: 5.5rem;
  padding: 0.9rem max(1rem, calc((100vw - 72rem) / 2));
  color: var(--paper-light);
  background: var(--forest);
  border-bottom: 5px solid var(--ink);
}
.guide-brand {
  display: inline-flex;
  align-items: center;
  gap: 0.8rem;
  color: inherit;
  text-decoration: none;
}
.guide-brand img { width: 3.25rem; height: 3.25rem; border-radius: 0.8rem; }
.guide-brand strong { display: block; font: 900 1.35rem/1 var(--mono); letter-spacing: 0.08em; }
.guide-brand span { display: block; margin-top: 0.3rem; color: var(--sky); font-size: 0.72rem; letter-spacing: 0.08em; text-transform: uppercase; }
.guide-nav { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.45rem; }
.guide-nav a {
  padding: 0.55rem 0.75rem;
  color: var(--paper-light);
  border: 1px solid rgba(255, 255, 255, 0.35);
  font-size: 0.78rem;
  font-weight: 800;
  text-decoration: none;
}
.guide-nav a[aria-current="page"] { color: var(--ink); background: var(--signal); border-color: var(--signal); }
.guide-nav a:hover { color: var(--ink); background: var(--paper-light); }

.guide-main { width: min(72rem, calc(100% - 2rem)); margin: 0 auto; }
.guide-hero {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(15rem, 0.6fr);
  gap: clamp(2rem, 7vw, 6rem);
  align-items: center;
  min-height: min(44rem, calc(100vh - 5.5rem));
  padding: clamp(4rem, 9vw, 8rem) 0;
  border-bottom: 3px solid var(--ink);
}
.kicker {
  margin: 0 0 1.1rem;
  color: var(--brick);
  font: 900 0.73rem/1.3 var(--mono);
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.guide-hero h1 {
  max-width: 13ch;
  margin: 0;
  font: 800 clamp(3rem, 8vw, 6.9rem)/0.91 var(--serif);
  letter-spacing: -0.055em;
}
.setup-hero h1 { max-width: 11ch; font-size: clamp(3rem, 7.2vw, 6rem); }
.lede { max-width: 39rem; margin: 1.5rem 0 0; font: 600 clamp(1.15rem, 2.4vw, 1.65rem)/1.45 var(--serif); }
.hero-note { max-width: 42rem; margin: 1.1rem 0 0; color: var(--muted); }
.hero-actions { display: flex; flex-wrap: wrap; gap: 0.75rem; margin-top: 2rem; }
.button-link {
  display: inline-flex;
  align-items: center;
  min-height: 3rem;
  padding: 0.7rem 1rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 2px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
  font-weight: 850;
  text-decoration: none;
}
.button-link:hover { color: var(--ink); background: var(--signal); transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--ink); }
.button-link.secondary { color: var(--ink); background: var(--paper-light); }

.city-seal { margin: 0; }
.city-seal img {
  width: min(100%, 18rem);
  height: auto;
  margin-inline: auto;
  border-radius: 24%;
  box-shadow: 1rem 1rem 0 var(--stone);
}
.city-seal figcaption { margin-top: 1.4rem; color: var(--muted); font: 0.7rem/1.5 var(--mono); text-align: center; }
.route-sign {
  position: relative;
  padding: 1.3rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 3px solid var(--ink);
  box-shadow: 0.8rem 0.8rem 0 var(--stone);
}
.route-sign::before { content: "The short version"; display: block; margin-bottom: 1rem; color: var(--signal); font: 900 0.7rem/1 var(--mono); letter-spacing: 0.08em; }
.route-sign p { margin: 0; }
.route-sign p + p { margin-top: 1rem; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.35); }
.route-sign code { display: block; margin-top: 0.3rem; color: var(--paper-light); font-size: clamp(0.72rem, 1.6vw, 0.9rem); }

.guide-section { padding: clamp(4rem, 8vw, 7rem) 0; border-bottom: 2px solid var(--line); }
.section-heading { margin-bottom: 2.5rem; }
.section-heading h2 { max-width: 18ch; margin: 0; font: 800 clamp(2rem, 5vw, 4.1rem)/1 var(--serif); letter-spacing: -0.035em; }
.section-intro { max-width: 44rem; margin: 1rem 0 0; color: var(--muted); font-size: 1.05rem; }

.continuity-statement { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(15rem, 0.55fr); gap: 2rem 4rem; align-items: start; }
.continuity-statement blockquote { margin: 0; font: 700 clamp(1.8rem, 4vw, 3.3rem)/1.12 var(--serif); }
.continuity-statement blockquote::before { content: "“"; color: var(--brick); }
.continuity-copy p { margin-top: 0; }

.trio-ledger { border-top: 4px solid var(--ink); }
.site-entry {
  display: grid;
  grid-template-columns: minmax(11rem, 0.55fr) minmax(0, 1fr) auto;
  gap: 1rem 1.5rem;
  align-items: baseline;
  padding: 1.35rem 0;
  border-bottom: 1px solid var(--line);
}
.site-entry h3, .site-entry p { margin: 0; }
.site-entry h3 { font: 800 1.35rem/1.2 var(--serif); }
.site-entry p { color: var(--muted); }
.site-entry a { font-weight: 850; white-space: nowrap; }
.human-aside { margin-top: 2rem; padding: 1.25rem 1.4rem; background: var(--sky); border-inline-start: 0.5rem solid var(--forest); }
.human-aside p { margin: 0; }

.life-list { border-top: 3px solid var(--ink); }
.life-row { display: grid; grid-template-columns: minmax(11rem, 0.5fr) minmax(0, 1fr); gap: 1rem 2rem; padding: 1.5rem 0; border-bottom: 1px solid var(--line); }
.life-row h3, .life-row p { margin: 0; }
.life-row h3 { font: 800 1.25rem/1.3 var(--serif); }
.life-row p { color: var(--muted); }

.move-grid, .door-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1.25rem; }
.move-steps { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); counter-reset: move; gap: 1px; padding: 1px; background: var(--line); }
.move-step { position: relative; padding: 4.7rem 1.25rem 1.4rem; background: var(--paper-light); counter-increment: move; }
.move-step::before { content: "0" counter(move); position: absolute; inset: 1rem auto auto 1.25rem; color: var(--brick); font: 900 1.5rem/1 var(--mono); }
.move-step h3 { margin: 0 0 0.6rem; font: 800 1.2rem/1.3 var(--serif); }
.move-step p { margin: 0; color: var(--muted); }
.privacy-note { padding: 1.25rem; color: var(--paper-light); background: var(--ink); }
.privacy-note strong { color: var(--signal); }

.door {
  padding: 1.5rem;
  background: var(--paper-light);
  border: 3px solid var(--ink);
  box-shadow: 0.45rem 0.45rem 0 var(--stone);
}
.door .for { margin: 0; color: var(--brick); font: 900 0.72rem/1.4 var(--mono); letter-spacing: 0.09em; text-transform: uppercase; }
.door h3 { margin: 0.55rem 0; font: 800 1.55rem/1.2 var(--serif); }
.door p { margin: 0.7rem 0 0; }
.address {
  display: block;
  margin: 1rem 0;
  padding: 0.9rem;
  color: var(--paper-light);
  background: var(--forest);
  border: 2px solid var(--ink);
  font-size: clamp(0.74rem, 1.7vw, 0.95rem);
  overflow-wrap: anywhere;
}
.key-warning { margin-top: 1.5rem; padding: 1.4rem; background: #fff3cf; border: 3px solid var(--brick); }
.key-warning h3 { margin: 0; font: 800 1.45rem/1.2 var(--serif); }
.key-warning p { margin: 0.7rem 0 0; }

.new-resident { display: grid; grid-template-columns: minmax(13rem, 0.55fr) minmax(0, 1fr); gap: 1.5rem 3rem; margin-top: 2.5rem; padding-top: 2rem; border-top: 1px solid var(--line); }
.new-resident h3 { margin: 0; font: 800 1.65rem/1.2 var(--serif); }
.new-resident ol { margin: 0; padding-inline-start: 1.4rem; }
.new-resident li + li { margin-top: 0.65rem; }

.evidence-note { margin-bottom: 2rem; padding: 1.25rem; background: var(--sky); border: 2px solid var(--forest); }
.evidence-note p { margin: 0; }
.evidence-note p + p { margin-top: 0.55rem; }
.client-index { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 2.5rem; }
.client-index a { padding: 0.45rem 0.65rem; background: var(--paper-light); border: 1px solid var(--line); font-size: 0.76rem; font-weight: 800; text-decoration: none; }
.client-guide { display: grid; grid-template-columns: minmax(11rem, 0.32fr) minmax(0, 1fr); gap: 1.5rem 3rem; padding: 2.4rem 0; border-top: 2px solid var(--ink); }
.client-guide > *, .numbered-steps, .numbered-steps > li, .code-block { min-width: 0; }
.client-title h3 { margin: 0; font: 800 1.9rem/1.1 var(--serif); }
.checked-label { display: inline-block; margin: 0.8rem 0 0; padding: 0.28rem 0.48rem; color: var(--paper-light); background: var(--forest); font: 800 0.62rem/1.3 var(--mono); letter-spacing: 0.05em; text-transform: uppercase; }
.checked-label.docs { color: var(--ink); background: var(--signal); }
.numbered-steps { margin: 0; padding: 0; list-style: none; counter-reset: steps; }
.numbered-steps > li { position: relative; min-height: 2.2rem; padding-inline-start: 3rem; counter-increment: steps; }
.numbered-steps > li + li { margin-top: 1rem; }
.numbered-steps > li::before { content: counter(steps); position: absolute; inset: 0 auto auto 0; display: grid; place-items: center; width: 2rem; height: 2rem; color: var(--paper-light); background: var(--brick); font: 900 0.78rem/1 var(--mono); }
.numbered-steps p { margin: 0; }
.numbered-steps p + p { margin-top: 0.45rem; }

.code-block { position: relative; margin: 1rem 0; }
.code-label { display: block; width: fit-content; padding: 0.25rem 0.5rem; color: var(--paper-light); background: var(--brick); font: 800 0.62rem/1.3 var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
pre { max-width: 100%; margin: 0; padding: 1rem; color: #f5f1e8; background: var(--ink); border: 3px solid var(--forest); font-size: 0.76rem; line-height: 1.65; overflow-x: auto; }
.plain-note { margin-top: 1rem; padding: 0.9rem 1rem; background: var(--paper-light); border-inline-start: 0.35rem solid var(--signal); }

.success-card { display: grid; grid-template-columns: minmax(0, 1fr) minmax(15rem, 0.55fr); gap: 2rem; padding: clamp(1.5rem, 4vw, 3rem); color: var(--paper-light); background: var(--forest); border: 4px solid var(--ink); box-shadow: 0.7rem 0.7rem 0 var(--stone); }
.success-card h2 { margin: 0; font: 800 clamp(2rem, 4vw, 3.5rem)/1 var(--serif); }
.success-card p { margin: 1rem 0 0; }
.success-card .ask { padding: 1.2rem; color: var(--ink); background: var(--paper-light); border: 2px solid var(--signal); font: 700 1.05rem/1.55 var(--serif); }
.success-example { align-self: center; }
.success-example pre { border-color: var(--signal); }

.trouble-list { border-top: 3px solid var(--ink); }
.trouble-list details { border-bottom: 1px solid var(--line); }
.trouble-list summary { padding: 1.1rem 2.5rem 1.1rem 0; cursor: pointer; font: 800 1.05rem/1.4 var(--serif); }
.trouble-list details[open] summary { color: var(--brick); }
.trouble-list .answer { max-width: 48rem; padding: 0 0 1.4rem; color: var(--muted); }
.trouble-list .answer p { margin: 0; }
.trouble-list .answer p + p { margin-top: 0.7rem; }

.guide-footer {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 1rem 2rem;
  padding: 2rem max(1rem, calc((100vw - 72rem) / 2));
  color: var(--sky);
  background: var(--ink);
  font-size: 0.76rem;
}
.guide-footer p { margin: 0; }
.guide-footer nav { display: flex; flex-wrap: wrap; justify-content: end; gap: 0.7rem 1rem; }
.guide-footer a { color: var(--paper-light); }
.guide-footer .operator { grid-column: 1 / -1; padding-top: 1rem; border-top: 1px solid rgba(255, 255, 255, 0.22); }

:focus-visible { outline: 4px solid var(--signal); outline-offset: 4px; }
@media (max-width: 52rem) {
  .guide-hero, .continuity-statement, .success-card { grid-template-columns: minmax(0, 1fr); }
  .guide-hero { min-height: auto; }
  .city-seal { width: min(45%, 10rem); }
  .client-guide, .new-resident { grid-template-columns: minmax(0, 1fr); }
  .move-steps { grid-template-columns: minmax(0, 1fr); }
  .site-entry { grid-template-columns: minmax(0, 1fr); }
  .site-entry p, .site-entry a { grid-column: 1; }
}
@media (max-width: 38rem) {
  .guide-masthead { align-items: flex-start; }
  .guide-brand span { display: none; }
  .guide-nav { display: grid; grid-template-columns: minmax(0, 1fr); }
  .guide-nav a { padding: 0.35rem 0.55rem; }
  .guide-main { width: min(100% - 1.25rem, 72rem); }
  .door-grid, .move-grid { grid-template-columns: minmax(0, 1fr); }
  .life-row { grid-template-columns: minmax(0, 1fr); }
  .life-row p { grid-column: 1; }
  .guide-footer { grid-template-columns: minmax(0, 1fr); }
  .guide-footer nav { justify-content: start; }
  .guide-footer .operator { grid-column: 1; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { transition: none !important; }
}
@media (forced-colors: active) {
  .button-link, .door, .route-sign, .success-card, pre { box-shadow: none; border-color: CanvasText; }
}
@media print {
  .guide-masthead, .guide-footer, .hero-actions, .client-index { display: none; }
  .guide-main { width: 100%; }
  .guide-section, .guide-hero { break-inside: avoid; }
}
`
