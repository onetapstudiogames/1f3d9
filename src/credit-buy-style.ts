export const CREDIT_BUY_CSS = `
/* Tokens and parts copied from the connect mockup (which copied https://1f3d9.com/window.css and the harvest season sheet). */
:root {
  color-scheme: dark;
  --night: #0b1714; --night-soft: #14241f; --forest: #174d3c; --forest-deep: #092d22;
  --paper: #e9e0c5; --paper-light: #fff9e8; --ink: #15231d; --muted: #555e55;
  --brick: #ad3f25; --brick-deep: #712413; --signal: #f0c95f; --sky: #94c7bc;
  --line: #20382f; --glow: #315447; --edge: #061e17;
  --sign-strip: #315447; --search-panel: #174d3c; --filter-panel: #092d22;
  --panel: #14241f;
  --heading-place: #174d3c; --heading-conversation: #ad3f25; --heading-happening: #315447; --heading-archive: #20382f; --heading-gazette: #ad3f25;
  --focus: #fff19b;
  --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  --narrow: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}

*, *::before, *::after { box-sizing: border-box; }
html { min-width: 18rem; background: var(--night); }
body {
  min-height: 100vh; margin: 0; color: var(--paper);
  background:
    linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px),
    radial-gradient(circle at 50% -8rem, var(--glow) 0, var(--night-soft) 26rem, var(--night) 54rem);
  background-size: 2.2rem 2.2rem, 2.2rem 2.2rem, auto;
}
a { color: inherit; text-underline-offset: 0.22em; }
button, input { font: inherit; }
button { color: inherit; }
[hidden] { display: none !important; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

/* ---------- Page frame ---------- */
.page { width: min(34rem, calc(100% - 1.5rem)); margin: 1rem auto 2.5rem; }
.back-link { display: inline-block; margin: 0 0 0.8rem; color: var(--paper-light); font: 700 0.85rem var(--mono); }
.city-code { color: var(--signal); font: 900 0.85rem var(--mono); letter-spacing: 0.1em; }

/* ---------- The carousel card (the connect pop-up, sitting on the /buy page) ---------- */
.popup {
  display: flex; flex-direction: column; width: 100%; min-width: 0;
  color: var(--ink); background: var(--paper-light); border: 3px solid var(--ink); box-shadow: 8px 8px 0 var(--signal);
}
.popup-head { display: flex; align-items: center; gap: 0.8rem; padding: 0.75rem 0.9rem 0.75rem 1rem; color: #fffdf3; background: var(--forest); border-bottom: 3px solid var(--ink); }
.popup-head h2 { flex: 1 1 auto; margin: 0; font: 900 clamp(1.15rem, 3.5vw, 1.45rem)/1.15 var(--narrow); text-transform: uppercase; }
.dots { display: flex; gap: 6px; }
.dots i { display: block; width: 10px; height: 10px; background: transparent; border: 2px solid var(--paper-light); }
.dots i.on { background: var(--signal); border-color: var(--signal); }
.popup-body { min-height: 17rem; padding: 1rem; font-size: 0.95rem; line-height: 1.5; overflow-wrap: anywhere; overflow-x: clip; }
.popup-body p { margin: 0 0 0.75rem; }
.popup-foot { display: flex; flex-wrap: nowrap; justify-content: space-between; align-items: center; gap: 0.6rem; padding: 0.75rem 1rem; background: var(--paper); border-top: 3px solid var(--ink); }
.popup-foot .grow { flex: 1 1 auto; }
.foot-help { text-align: center; font: 700 0.78rem var(--mono); }
.foot-help a { color: var(--brick-deep); }
.slide { animation: slide-in 260ms ease-out both; }
.slide.from-left { animation-name: slide-in-left; }
@keyframes slide-in { from { opacity: 0; transform: translateX(36px); } to { opacity: 1; transform: none; } }
@keyframes slide-in-left { from { opacity: 0; transform: translateX(-36px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .slide { animation: none; } .btn:hover, .choice:hover { transform: none; } }
.slide h3 { margin: 0 0 0.6rem; font: 900 clamp(1.5rem, 5vw, 2rem)/1 var(--narrow); letter-spacing: -0.02em; text-transform: uppercase; }

/* Buttons */
.btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 0.4rem; min-height: 2.75rem; padding: 0.6rem 1.1rem;
  color: var(--ink); background: var(--signal); border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink);
  cursor: pointer; font: 900 0.95rem/1.1 system-ui, sans-serif; text-decoration: none; text-align: center;
}
.btn:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--ink); }
.btn.plain { background: var(--paper-light); box-shadow: none; }
.btn.plain:hover { transform: none; text-decoration: underline; }
.btn.wide { width: 100%; }
.btn.small { min-height: 2.25rem; padding: 0.35rem 0.8rem; font-size: 0.85rem; }
.btn[disabled] { opacity: 0.55; cursor: not-allowed; transform: none; }
#back { flex: none; white-space: nowrap; padding-inline: 0.8rem; }
#next { padding-inline: 0.8rem; white-space: nowrap; flex: none; }

/* Choice cards */
.choices { display: grid; gap: 0.8rem; }
.choice {
  display: grid; gap: 0.2rem; width: 100%; padding: 0.85rem 1rem; color: var(--ink); background: #fff;
  border: 3px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); cursor: pointer; text-align: left;
}
.choice:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 var(--ink); background: var(--paper-light); }
.choice b { font: 900 1.25rem/1.05 var(--narrow); text-transform: uppercase; }
.choice b::after { content: "  >"; color: var(--brick); }
.lead { font-weight: 700; }
.got-gift { margin: 1rem 0 0 !important; padding-top: 0.6rem; border-top: 2px dashed #c9bd9c; font-size: 0.9rem; }

/* Fields */
label.field { display: block; margin: 0.2rem 0 0.3rem; font: 900 0.95rem var(--narrow); text-transform: uppercase; letter-spacing: 0.02em; }
.row { display: flex; gap: 0.5rem; }
.row .text { flex: 1 1 auto; min-width: 0; }
.row .btn { flex: none; white-space: nowrap; }
input.text { width: 100%; padding: 0.7rem; color: var(--ink); background: #fff; border: 2px solid var(--ink); font: 700 1rem var(--mono); }
input.text:focus { outline: 3px solid var(--signal); outline-offset: 0; }
.err { margin: 0.6rem 0 0.8rem; padding: 0.6rem 0.75rem; background: #fff1d2; border: 2px solid var(--ink); border-inline-start: 0.5rem solid var(--brick-deep); font-weight: 700; font-size: 0.92rem; }
.err .btn { margin-top: 0.5rem; }
.or { display: flex; align-items: center; gap: 0.6rem; margin: 0.9rem 0 0.5rem; color: var(--muted); font: 800 0.75rem var(--mono); text-transform: uppercase; }
.or::before, .or::after { content: ""; flex: 1 1 auto; border-top: 2px solid #9d9276; }
.file-pick { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
.file-state { font: 700 0.85rem var(--mono); color: #1d6b3a; }

/* Name shown back */
.found { display: flex; align-items: center; gap: 0.7rem; margin: 0.9rem 0 0; padding: 0.7rem 0.8rem; color: var(--paper-light); background: var(--forest); border: 3px solid var(--ink); }
.found .who { flex: 1 1 auto; min-width: 0; }
.found .who b { display: block; color: #fffdf3; font: 900 1.35rem/1.05 var(--narrow); }
.found .who span { font: 700 0.78rem var(--mono); color: var(--sky); }
.found a { flex: none; color: var(--signal); font: 700 0.8rem var(--mono); }
.check { flex: none; display: grid; place-items: center; width: 2rem; height: 2rem; color: var(--ink); background: var(--signal); border: 2px solid var(--ink); font: 900 1rem var(--mono); }

/* Amount chips and toggles */
.amounts { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin: 0 0 0.6rem; }
.amt, .often button {
  min-height: 3rem; padding: 0.4rem; color: var(--ink); background: #fff; border: 3px solid var(--ink);
  cursor: pointer; font: 900 1.15rem var(--narrow);
}
.amt[aria-pressed="true"], .often button[aria-pressed="true"] { background: var(--signal); box-shadow: inset 0 0 0 3px var(--paper-light); }
.other-amt { display: flex; align-items: center; gap: 0.4rem; margin: 0 0 0.9rem; }
.other-amt span { font: 900 1.1rem var(--mono); }
.other-amt input { width: 8rem; }
.often { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin: 0.3rem 0 0.6rem; }
.often button { font-size: 1rem; text-transform: uppercase; }
.total { margin: 0.4rem 0 0 !important; font: 900 1.05rem var(--mono); }

/* Copy box */
.copy { display: flex; align-items: stretch; margin: 0.3rem 0 0.7rem; border: 2px solid var(--ink); background: #fff; }
.copy code { flex: 1 1 auto; min-width: 0; padding: 0.6rem 0.7rem; overflow-wrap: anywhere; font: 700 0.85rem/1.35 var(--mono); }
.copy button { flex: none; padding: 0 0.9rem; color: var(--paper-light); background: var(--ink); border: 0; cursor: pointer; font: 900 0.75rem var(--mono); letter-spacing: 0.06em; text-transform: uppercase; }
.key-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; margin: 0 0 0.9rem; }
.tick { display: flex; align-items: center; gap: 0.6rem; margin: 0 0 0.4rem; font-weight: 800; cursor: pointer; }
.tick input { width: 1.3rem; height: 1.3rem; accent-color: var(--forest); }

/* Done */
.big-done { margin: 0 0 0.6rem; font: 900 clamp(2rem, 9vw, 3rem)/0.92 var(--narrow); letter-spacing: -0.03em; text-transform: uppercase; }
.receipt { margin: 0 0 0.9rem; padding: 0.7rem 0.8rem; background: #fff; border: 2px dashed var(--ink); font: 0.85rem/1.6 var(--mono); }
.receipt b { font-weight: 900; }
.status { display: inline-block; padding: 1px 6px; color: var(--ink); background: var(--signal); border: 1px solid var(--ink); font: 900 0.72rem var(--mono); text-transform: uppercase; }
.status.ok { color: #fff; background: #1d6b3a; }

/* Trouble list */
.trouble { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.7rem; }
.trouble li { padding: 0.7rem 0.8rem; background: #fff; border: 2px solid var(--ink); border-inline-start: 0.5rem solid var(--brick); }
.trouble b { display: block; font: 900 1.05rem/1.15 var(--narrow); text-transform: uppercase; }
.trouble a { color: var(--brick-deep); font-weight: 800; }

/* Help page */
.card { color: var(--ink); background: var(--paper-light); border: 3px solid var(--ink); box-shadow: 8px 8px 0 var(--signal); }
.card-head { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0.4rem 0.8rem; padding: 0.8rem 1rem; color: #fffdf3; background: var(--forest); border-bottom: 3px solid var(--ink); }
.card-head h2 { margin: 0; font: 900 clamp(1.4rem, 5vw, 2rem)/1 var(--narrow); letter-spacing: -0.02em; text-transform: uppercase; }
.card-body { padding: 1rem; line-height: 1.5; overflow-wrap: anywhere; }
.help-sec { margin: 0 0 0.6rem; border: 3px solid var(--ink); background: #fff; }
.help-sec > summary { padding: 0.75rem 0.9rem; cursor: pointer; color: #fffdf3; background: var(--forest); font: 900 1.1rem var(--narrow); text-transform: uppercase; list-style: none; }
.help-sec > summary::-webkit-details-marker { display: none; }
.help-sec > summary::before { content: "▸ "; color: var(--signal); }
.help-sec[open] > summary::before { content: "▾ "; }
.help-sec > div { padding: 0.8rem 0.9rem 0.3rem; font-size: 0.92rem; line-height: 1.5; }
.help-sec ul { margin: 0 0 0.7rem; padding-inline-start: 1.2rem; }
.help-sec li + li { margin-top: 0.25rem; }
.help-sec code { font: 700 0.85em var(--mono); }
.got-gift code { font: 700 0.9em var(--mono); }
.buy-footer { margin: 1.6rem 0 0; color: #d9d0bb; font-size: 0.85rem; text-align: center; }
.buy-footer p { margin: 0 0 0.4rem; }
.buy-footer nav { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.3rem 1rem; font: 700 0.8rem var(--mono); }
.toast { position: fixed; z-index: 300; left: 50%; bottom: 1rem; transform: translateX(-50%); max-width: calc(100% - 2rem); padding: 0.6rem 0.9rem; color: #fff; background: #000; border: 2px solid var(--signal); font: 700 0.82rem var(--mono); }
@media (max-width: 400px) {
  .amounts { grid-template-columns: repeat(2, 1fr); }
  .popup-body { padding: 0.9rem; }
}

.popup-head h1 {flex:1;margin:0;font:900 1.45rem/1.15 var(--narrow);text-transform:uppercase}
.popup-head img {flex:none}
.foot-help a,.buy-footer a {display:inline-flex;align-items:center;min-height:2rem}
.file-pick {margin-top:.6rem}
.file-pick input {max-width:100%;font-size:.85rem}
.field-help {font-size:.8rem;color:var(--muted)}
.status-line:empty {display:none}
.skip-link {position:absolute;top:-4rem}.skip-link:focus{top:0}
@media (forced-colors:active) {.popup,.btn,.choice,.found {border:2px solid CanvasText;box-shadow:none}}
`
