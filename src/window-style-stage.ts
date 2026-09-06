export const WINDOW_STAGE_CSS = `
/* The stage ground is a fixed room lattice. Geometry comes from stage-ground.ts;
   CSS paints it and never participates in placement. */
[data-stage-node-kind="resident"] .live-portrait > .drawing-grid,
[data-stage-node-kind="resident"] .live-portrait > .entity-portrait,
[data-stage-node-kind="thing"] > .drawing-grid,
[data-stage-node-kind="thing"] > .entity-portrait {
  transform: scaleX(var(--facing, 1));
  transform-origin: center;
}
.live-plot {
  background: color-mix(in srgb, var(--forest) 84%, var(--night));
  box-shadow: inset 0 0 0 4px rgba(9, 45, 34, 0.7), 6px 6px 0 rgba(0, 0, 0, 0.3);
  pointer-events: none;
}
.live-plot::after {
  content: "";
  position: absolute;
  inset: 0.5rem;
  border: 1px dashed color-mix(in srgb, var(--sky) 26%, transparent);
  pointer-events: none;
}
.live-plot > .live-portrait-grid, .live-plot > .live-thing-shelf,
.live-plot > .quiet-room-notice { z-index: 2; }
.live-plot > .live-plot-open,
.live-plot > .live-place-notes,
.live-plot > .live-plot-drawing-detail,
.live-plot > .quiet-room-notice { pointer-events: auto; }
.live-plot > .live-place-notes {
  inset: 286px auto auto 112px;
  width: 100px;
  min-height: 44px;
}
.live-plot > .live-portrait-grid:not([data-live-expanded="true"]) > .live-resident-more {
  inset: 286px auto auto 218px;
  width: 100px;
}
.live-plot > .live-thing-shelf:not([data-live-expanded="true"]) > .live-thing-more,
.live-plot:has(.live-resident-more)
  > .live-thing-shelf:not([data-live-expanded="true"]) > .live-thing-more {
  inset: 286px auto auto 324px;
  width: 100px;
}
.live-plot-terrain { pointer-events: none; }
.live-world-ground, .live-world-ground-tiles { pointer-events: none; }
[data-stage-cell-key] {
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  transform-origin: center;
}
.live-replay-portrait { animation-name: live-recorded-route; }
[data-stage-cell-key] > .live-portrait,
[data-stage-cell-key] > .live-entity-portrait {
  width: 32px;
  height: 32px;
}
.live-thing-specimen[data-stage-cell-key] {
  display: block;
  padding: 0;
}
.live-thing-specimen[data-stage-cell-key] > .live-thing-name {
  position: absolute;
  top: 35px;
  left: 50%;
  width: max-content;
  max-width: 8rem;
  transform: translateX(-50%);
  text-align: center;
}
`
