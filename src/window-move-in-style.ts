export const WINDOW_MOVE_IN_CSS = `
.move-in-button {
  display: inline-flex; align-items: center; justify-content: center; min-height: 2.6rem; padding: 8px 16px;
  color: #fff; background: var(--brick); border: 2px solid var(--signal); box-shadow: 4px 4px 0 #000;
  cursor: pointer; font: 900 15px/1 Consolas, ui-monospace, monospace; letter-spacing: .04em; text-transform: uppercase;
}
.move-in-button:hover { transform: translate(2px, 2px); box-shadow: 2px 2px 0 #000; }
.move-in-dialog {
  --mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
  --narrow: "Arial Narrow", "Aptos Narrow", "Roboto Condensed", system-ui, sans-serif;
  padding: 0; width: min(calc(100% - 2rem), 34rem); max-width: none; max-height: min(88dvh, 44rem);
  color: var(--ink); background: var(--paper-light); border: 3px solid var(--ink); box-shadow: 8px 8px 0 var(--signal);
}
.move-in-dialog[open] { display: flex; flex-direction: column; }
.move-in-dialog::backdrop { background: rgba(6,18,15,.72); }
.move-in-dialog [hidden] { display: none !important; }
.move-in-dialog :focus-visible { outline: 3px solid var(--brick-deep); outline-offset: 2px; }
.move-head { display: flex; flex: none; align-items: center; gap: .8rem; padding: .75rem .9rem .75rem 1rem; color: #fffdf3; background: var(--forest); border-bottom: 3px solid var(--ink); }
.move-head h2 { flex: 1; margin: 0; font: 900 clamp(1.15rem,3.5vw,1.45rem)/1.15 var(--narrow); text-transform: uppercase; }
.move-close { flex: none; width: 2.2rem; height: 2.2rem; color: var(--ink); background: var(--paper-light); border: 2px solid var(--ink); cursor: pointer; font: 900 1rem var(--mono); }
.move-dots { display: flex; gap: 6px; }
.move-dots i { display: block; width: 10px; height: 10px; border: 2px solid var(--paper-light); }
.move-dots i.on { background: var(--signal); border-color: var(--signal); }
.move-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 1rem; font-size: .95rem; line-height: 1.5; }
.move-body p { margin: 0 0 .75rem; }
.move-slide { animation: move-slide-in 260ms ease-out both; }
.move-slide h3 { margin: 0 0 .6rem; font: 900 clamp(1.5rem,5vw,2rem)/1 var(--narrow); letter-spacing: -.02em; text-transform: uppercase; }
.move-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 2.75rem; padding: .6rem 1.1rem; color: var(--ink); background: var(--signal); border: 2px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); cursor: pointer; font: 900 .95rem/1.1 system-ui,sans-serif; text-decoration: none; text-align: center; }
.move-btn:hover, .move-choice:hover { transform: translate(2px,2px); box-shadow: 2px 2px 0 var(--ink); }
.move-plain { background: var(--paper-light); box-shadow: none; }
.move-wide { width: 100%; }
.move-choices { display: grid; gap: .8rem; padding-right: 4px; padding-bottom: 4px; }
.move-choice { display: grid; gap: .2rem; width: 100%; padding: .85rem 1rem; color: var(--ink); background: #fff; border: 3px solid var(--ink); box-shadow: 4px 4px 0 var(--ink); cursor: pointer; text-align: left; text-decoration: none; }
.move-choice b { font: 900 1.25rem/1.05 var(--narrow); text-transform: uppercase; }
.move-choice b::after { content: '  >'; color: var(--brick); }
.move-choice span { color: #3b463f; font-size: .88rem; }
.move-apps { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem; margin: .4rem 0 .9rem; }
.move-apps button { min-height: 3.2rem; padding: .6rem; color: var(--ink); background: #fff; border: 3px solid var(--ink); cursor: pointer; font: 900 1.05rem var(--narrow); text-transform: uppercase; }
.move-apps button[aria-pressed=true] { background: var(--signal); box-shadow: inset 0 0 0 3px var(--paper-light); }
.move-four { display: grid; grid-template-columns: repeat(4,1fr); gap: 4px; margin: .2rem 0 .9rem; padding: 0; list-style: none; }
.move-four li { padding: .45rem .4rem; color: var(--paper-light); background: var(--forest); border: 2px solid var(--ink); font: 700 .7rem/1.25 var(--mono); }
.move-four li b { display: block; color: var(--signal); font-size: .95rem; }
.move-steps { padding: 0; margin: 0 0 .9rem; list-style: none; }
.move-steps li { position: relative; padding-left: 2.1rem; margin: 0 0 .55rem; }
.move-steps li::before { content: counter(list-item); position: absolute; left: 0; top: .05rem; display: grid; place-items: center; width: 1.5rem; height: 1.5rem; color: var(--paper-light); background: var(--forest); border: 2px solid var(--ink); font: 900 .75rem var(--mono); }
.move-ask { padding: .65rem .8rem; background: var(--paper); border: 2px solid var(--ink); border-left: .5rem solid var(--brick); font-weight: 700; }
.move-copy { display: flex; align-items: stretch; margin: .3rem 0 .9rem; border: 2px solid var(--ink); background: #fff; }
.move-copy code { flex: 1; min-width: 0; padding: .6rem .7rem; overflow-wrap: anywhere; font: 700 .85rem/1.35 var(--mono); }
.move-copy button { flex: none; padding: 0 .9rem; color: var(--paper-light); background: var(--ink); border: 0; border-left: 2px solid var(--ink); cursor: pointer; font: 900 .75rem var(--mono); text-transform: uppercase; }
.move-more { margin: .2rem 0 .9rem; border: 2px solid var(--ink); background: #fff; }
.move-more summary { padding: .6rem .8rem; cursor: pointer; font: 800 .9rem var(--mono); }
.move-more > div { padding: 0 .8rem .6rem; }
.move-more pre { margin: 0; max-height: 15rem; padding: .7rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-top: 2px solid var(--ink); font: .78rem/1.45 var(--mono); }
.move-body .move-copy-status { margin: 0; font-size: .85rem; }
.move-foot { display: flex; flex: none; align-items: center; justify-content: space-between; gap: .6rem; padding: .75rem 1rem; background: var(--paper); border-top: 3px solid var(--ink); }
.move-foot a { margin-left: auto; }
@keyframes move-slide-in { from { opacity: 0; transform: translateX(36px); } to { opacity: 1; transform: none; } }
@media (max-width: 480px) { .move-in-button { flex-basis: 100%; } }
@media (max-width: 420px) { .move-four { grid-template-columns: 1fr 1fr; } }
@media (prefers-reduced-motion: reduce) { .move-slide { animation: none; } .move-in-button:hover, .move-btn:hover, .move-choice:hover { transform: none; } }
`
