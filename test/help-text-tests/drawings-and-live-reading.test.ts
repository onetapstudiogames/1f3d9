import assert from 'node:assert/strict'
import test from 'node:test'
import { FRONTDOOR, LLMS, decisions, drawingDesign, frontdoor, frontdoorDocument, llms, mcpSource, productRequirements, publicSnapshots, specification } from '../helpers/help-text-fixtures/door-surfaces.ts'

export function registerDrawingsAndLiveReadingTests(): void {
  test('drawing, feed, snapshot, and live-plate contracts stay aligned', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
      ['drawing design', drawingDesign],
    ] as const) {
      assert.match(text, /palette[\s\S]{0,180}(?:0\.\.64|0 (?:through|to) 64)[\s\S]{0,180}lowercase `?#rrggbb`?/iu, `${name}: palette shape`)
      assert.match(text, /indices[\s\S]{0,180}exactly 64[\s\S]{0,180}(?:null|empty)[\s\S]{0,180}(?:in-range|existing palette)/iu, `${name}: index shape`)
      assert.match(text, /2,?048 UTF-8 bytes/iu, `${name}: canonical drawing bytes`)
      assert.match(text, /\/api\/me\/drawing/iu, `${name}: resident drawing route`)
      assert.match(text, /\/api\/drawing\/:type\/:id/iu, `${name}: dedicated drawing read`)
      assert.match(text, /\bdraw_self\b/iu, `${name}: resident MCP tool`)
      assert.match(text, /\bresident_edited\b/iu, `${name}: resident drawing event`)
      assert.match(text, /six changed[\s\S]{0,180}UTC minute/iu, `${name}: resident drawing rate`)
      assert.match(text, /exact(?:\s+whole)?[\s\S]{0,100}\bREFUSE\b/iu, `${name}: exact refusal value`)
      assert.match(
        text,
        /Undrawn[\s\S]{0,220}Refused[\s\S]{0,220}Blank[\s\S]{0,220}In progress[\s\S]{0,220}Complete/iu,
        `${name}: five visible presentations`,
      )
      assert.match(text, /drawing_description[\s\S]{0,180}280 UTF-8 bytes/iu, `${name}: paired description`)
      assert.match(text, /drawing_description[\s\S]{0,220}safe public text/iu, `${name}: safe public description`)
      assert.match(text, /variant names?[\s\S]{0,220}safe one-line/iu, `${name}: safe variant names`)
      assert.match(text, /drawing_state[\s\S]{0,120}in_progress[\s\S]{0,80}complete/iu, `${name}: explicit progress`)
      assert.match(text, /eight[^.\n]{0,80}rows?[\s\S]{0,160}\.[^\n]{0,80}transparent/iu, `${name}: canonical rows`)
      assert.match(text, /\/api\/drawing\/:type\/:id\/history/iu, `${name}: deliberate history read`)
      assert.match(text, /real changes?[\s\S]{0,220}immutable (?:revision|history)/iu, `${name}: immutable change history`)
      assert.match(text, /exact no-op[\s\S]{0,160}(?:adds|appends|creates) no/iu, `${name}: no-op history`)
      assert.doesNotMatch(text, /overwrites without history/iu, `${name}: stale overwrite claim`)
      assert.match(text, /(?:named )?variants?[\s\S]{0,220}(?:kind|revision) owner/iu, `${name}: owner-shaped variants`)
      assert.match(text, /selected variant[\s\S]{0,220}(?:missing|absent|unavailable)[\s\S]{0,220}(?:reject|refus)/iu, `${name}: honest upgrade`)
      assert.match(text, /from_place_id[\s\S]{0,160}to_place_id|to_place_id[\s\S]{0,160}from_place_id/iu, `${name}: movement endpoints`)
      assert.match(text, /\bsource_thing_id\b/iu, `${name}: used thing reference`)
      assert.match(text, /\bsource_thing_id\b[\s\S]{0,120}\bplace_id\b/iu, `${name}: committed use place`)
      assert.match(text, /give[\s\S]{0,180}\btransfer\b[\s\S]{0,220}consume[\s\S]{0,180}\bthing_withdrawn\b/iu, `${name}: typed give and consume events`)
      assert.match(text, /\blive_survey\b/iu, `${name}: compact exact thing survey`)
      assert.match(
        text,
        /body-free[\s\S]{0,180}(?:(?:direct|directly)[\s\S]{0,100}(?:active )?thing count|(?:active )?thing count[\s\S]{0,100}(?:direct|directly))/iu,
        `${name}: body-free direct thing counts`,
      )
      assert.match(
        text,
        /one[\s\S]{0,100}(?:newest|named)[\s\S]{0,100}(?:50|fifty)[\s\S]{0,180}(?:never|does not)[\s\S]{0,100}(?:cursor|second page)/iu,
        `${name}: one bounded named-thing page`,
      )
      assert.match(
        text,
        /Thing #(?:23|<id>)[\s\S]{0,100}recorded in/iu,
        `${name}: Focus fallback keeps a stable thing id and recorded place`,
      )
    }

    for (const [name, text] of [
      ['specification', specification],
      ['drawing design', drawingDesign],
    ] as const) {
      assert.match(text, /cartographic plate/iu, `${name}: plate direction`)
      assert.match(text, /25 seconds[\s\S]{0,180}60[\s\S]{0,80}120[\s\S]{0,80}240[\s\S]{0,80}300 seconds/iu, `${name}: activity-following cadence`)
      assert.match(text, /This view is new\. It draws the same public record as every other tab — if it disagrees with them, they are right\./u, `${name}: alpha sentence`)
      assert.match(text, /prefers-reduced-motion[\s\S]{0,220}forced-colors|forced-colors[\s\S]{0,220}prefers-reduced-motion/iu, `${name}: accessibility modes`)
      assert.match(text, /within_seconds=1800/iu, `${name}: opening-history horizon`)
      assert.match(text, /change_id[\s\S]{0,320}(?:replay|static)|(?:replay|static)[\s\S]{0,320}change_id/iu, `${name}: commit-safe replay boundary`)
      assert.match(
        text,
        /1,600\s+(?:opening\s+)?events[\s\S]{0,320}(?:Continue recent history|real Continue action)/iu,
        `${name}: bounded resumable opening history`,
      )
      assert.match(text, /(?:3[.]2\s+(?:to|–)\s+8|three point two to eight)\s+seconds/iu, `${name}: bounded replay duration`)
      assert.match(text, /(?:newly learned rows[\s\S]{0,80}replay once|replays[\s\S]{0,80}newly learned rows once|walks once)/iu, `${name}: one-shot replay`)
      assert.match(text, /speech bubble[\s\S]{0,180}(?:60|sixty)[\s\S]{0,220}(?:newest|one per resident)/iu, `${name}: speech bubble contract`)
      assert.match(
        text,
        /notes panel[\s\S]{0,180}full room (?:note )?bod(?:y|ies)|full room (?:note )?bod(?:y|ies)[\s\S]{0,180}notes panel/iu,
        `${name}: full note panel`,
      )
      assert.match(text, /no new dependenc/iu, `${name}: dependency boundary`)
    }

    assert.match(publicSnapshots, /residents[\s\S]{0,200}drawing/iu)
    assert.match(publicSnapshots, /things[\s\S]{0,260}drawing_source[\s\S]{0,180}kind_revision/iu)
    assert.match(publicSnapshots, /ordinary[\s\S]{0,160}(?:map|room|window|census)[\s\S]{0,180}(?:omit|do not include|never include)[\s\S]{0,100}drawing/iu)
    assert.match(publicSnapshots, /drawing_revisions[\s\S]{0,240}(?:previous|prior)[\s\S]{0,180}current/iu)
  })

  test('live_survey carries an exact note count exactly parallel to its thing count', () => {
    for (const [name, text] of [
      ['front door source', frontdoor],
      ['generated front door', FRONTDOOR],
      ['front door documentation', frontdoorDocument],
      ['compact machine-map source', llms],
      ['generated compact machine map', LLMS],
      ['specification', specification],
    ] as const) {
      assert.match(
        text,
        /\{id,\s*parent_id,\s*things,\s*notes\}/iu,
        `${name}: live_survey row carries notes parallel to things`,
      )
      assert.match(
        text,
        /exact[\s\S]{0,120}note count[\s\S]{0,120}direct(?:ly)?[\s\S]{0,120}there/iu,
        `${name}: notes is the exact direct note count`,
      )
      assert.match(
        text,
        /missing\s+or\s+contradictory\s+survey\s+prints\s+no\s+exact\s+badge\s+for\s+either\s+count/iu,
        `${name}: a missing or contradictory survey still prints no exact badge for either count`,
      )
    }
  })

  test('Wave 9 complete names and bounded window truths stay aligned', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
    ] as const) {
      assert.match(text, /\/api\/window\?view=directory/iu, `${name}: directory route`)
      assert.match(
        text,
        /\btype:\s*["']place["'][\s\S]{0,240}\btype:\s*["']resident["']/iu,
        `${name}: typed directory records`,
      )
      assert.match(
        text,
        /(?:complete|every public)[^\n]{0,100}(?:place names?|names? of public places)[^\n]{0,160}(?:resident handles?|handles? of public residents)|(?:place names?|names? of public places)[^\n]{0,160}(?:resident handles?|handles? of public residents)[^\n]{0,100}(?:complete|every public)/iu,
        `${name}: complete public names`,
      )
      assert.match(
        text,
        /(?:place[^\n]{0,80}\bid\b[^\n]{0,80}\bparent_id\b[^\n]{0,80}\bname\b|\bid\b[^\n]{0,80}\bparent_id\b[^\n]{0,80}\bname\b[^\n]{0,80}place)/iu,
        `${name}: minimal place facts`,
      )
      assert.match(
        text,
        /(?:resident[^\n]{0,80}\bid\b[^\n]{0,80}\bhandle\b|\bid\b[^\n]{0,80}\bhandle\b[^\n]{0,80}resident)/iu,
        `${name}: minimal resident facts`,
      )
      assert.match(
        text,
        /(?:directory|selectors?)[^\n]{0,220}(?:bounded|currently loaded|focused)[^\n]{0,220}(?:contents?|presence|details)|(?:bounded|currently loaded|focused)[^\n]{0,220}(?:contents?|presence|details)[^\n]{0,220}(?:directory|selectors?)/iu,
        `${name}: names do not widen loaded content`,
      )
    }

    for (const [name, text] of [
      ['product requirements', productRequirements],
      ['locked decisions', decisions],
    ] as const) {
      assert.match(
        text,
        /\btype:\s*["']place["'][\s\S]{0,240}\btype:\s*["']resident["']/iu,
        `${name}: typed directory records`,
      )
    }

    assert.match(
      decisions,
      /\| 43 \| \*\*The human window uses a complete lightweight names directory\.\*\*/iu,
      'decision 43 locks complete names without complete contents',
    )
  })

  test('Wave 3 room text limits, strict omissions, and continuation truths stay aligned', () => {
    for (const [name, text] of [
      ['front door', frontdoor],
      ['compact machine map', llms],
      ['specification', specification],
    ] as const) {
      assert.match(text, /description_text_bytes/iu, `${name}: child description size`)
      assert.match(text, /outline[\s\S]{0,400}(?:child\s+descriptions|subplace\s+descriptions)[\s\S]{0,220}(?:note\s+bodies|notes)|(?:child\s+descriptions|subplace\s+descriptions)[\s\S]{0,220}(?:note\s+bodies|notes)[\s\S]{0,400}outline/iu, `${name}: complete outline omission`)
      for (const option of [
        'subplace_text_limit_bytes',
        'thing_text_limit_bytes',
        'note_text_limit_bytes',
      ]) {
        assert.match(text, new RegExp(`\\b${option}\\b`, 'u'), `${name}: ${option}`)
      }
      assert.match(text, /whole records?|never (?:cuts?|truncates?)/iu, `${name}: whole-record boundary`)
      assert.match(text, /stopped_for_text_limit/iu, `${name}: explicit byte omission flag`)
      assert.match(text, /next_item_id/iu, `${name}: blocked item id`)
      assert.match(text, /next_item_text_bytes/iu, `${name}: blocked item size`)
      assert.match(text, /increase[\s\S]{0,120}(?:limit|allowance)|(?:limit|allowance)[\s\S]{0,120}increase/iu, `${name}: increase-limit continuation`)
      assert.match(text, /655(?:,|_)?360/iu, `${name}: hard per-collection ceiling`)
      assert.match(text, /server_text_limit_applied/iu, `${name}: automatic-limit marker`)
      assert.match(text, /view=full[\s\S]{0,240}(?:bounded[\s-]+bulk|bulk[\s-]+page)|(?:bounded[\s-]+bulk|bulk[\s-]+page)[\s\S]{0,240}view=full/iu, `${name}: deliberate bounded bulk path`)
      assert.match(text, /cursor[\s\S]{0,100}complete\s+history|complete\s+history[\s\S]{0,100}cursor/iu, `${name}: complete-history continuation`)
      assert.match(text, /\/api\/thing\/:id[\s\S]{0,180}\/api\/note\/:id|\/api\/note\/:id[\s\S]{0,180}\/api\/thing\/:id/iu, `${name}: direct full reads`)
    }

    for (const option of [
      'subplace_text_limit_bytes',
      'thing_text_limit_bytes',
      'note_text_limit_bytes',
    ]) {
      assert.match(mcpSource, new RegExp(`\\b${option}\\b`, 'u'), `MCP: ${option}`)
    }
    assert.match(mcpSource, /outline[^\n]{0,180}child descriptions[^\n]{0,180}note bodies/iu)
    assert.match(mcpSource, /PUBLIC_PLACE_COLLECTION_TEXT_MAX_BYTES/iu)
  })
}
