import assert from 'node:assert/strict'
import { SMALL_ROOM_RECORDS } from '../../helpers/public-pagination-fixtures/seed-city.ts'
import type { TestContext } from 'node:test'
import type { PostgresInstance } from '../../helpers/public-pagination-fixtures/postgres.ts'
import type { SeededCity } from '../../helpers/public-pagination-fixtures/seed-city.ts'

export async function registerOutlineRoomsTests(
  t: TestContext,
  postgres: PostgresInstance,
  city: SeededCity,
): Promise<void> {
  await t.test('outline stays small for note-only, child-only, and ordinary small rooms', async testContext => {
    const { default: cityApp } = await import('../../../src/index.ts')
    const readOutline = async (placeId: number) => {
      const response = await cityApp.request(`http://city.test/api/place/${placeId}?view=outline`)
      const text = await response.text()
      assert.equal(response.status, 200, text)
      return { text, body: JSON.parse(text) as {
        subplaces: Array<{ description?: string; description_text_bytes: number }>
        things: Array<{ body?: string; body_text_bytes: number }>
        notes: Array<{ body?: string; body_text_bytes: number }>
        subplaces_page: { returned_text_bytes: number; has_more: boolean }
        things_page: { returned_text_bytes: number; has_more: boolean }
        notes_page: { returned_text_bytes: number; has_more: boolean }
      } }
    }

    const noteHeavy = await readOutline(city.noteHeavyPlaceId)
    assert.deepEqual([noteHeavy.body.subplaces.length, noteHeavy.body.things.length], [0, 0])
    assert.equal(noteHeavy.body.notes.length, 10)
    assert.equal(noteHeavy.body.notes.every(note => !Object.hasOwn(note, 'body')), true)
    assert.equal(noteHeavy.body.notes.every(note => note.body_text_bytes > 5_000), true)
    assert.equal(noteHeavy.body.notes_page.returned_text_bytes, 0)
    assert.equal(noteHeavy.body.notes_page.has_more, true)
    assert.ok(Buffer.byteLength(noteHeavy.text, 'utf8') < 5_000)

    const childHeavy = await readOutline(city.childHeavyPlaceId)
    assert.deepEqual([childHeavy.body.things.length, childHeavy.body.notes.length], [0, 0])
    assert.equal(childHeavy.body.subplaces.length, 10)
    assert.equal(childHeavy.body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
    assert.equal(childHeavy.body.subplaces.every(place => place.description_text_bytes > 4_000), true)
    assert.equal(childHeavy.body.subplaces_page.returned_text_bytes, 0)
    assert.equal(childHeavy.body.subplaces_page.has_more, true)
    assert.ok(Buffer.byteLength(childHeavy.text, 'utf8') < 8_000)

    const small = await readOutline(city.smallPlaceId)
    assert.deepEqual(
      [small.body.subplaces.length, small.body.things.length, small.body.notes.length],
      [1, 1, 1],
    )
    assert.equal(small.body.subplaces.every(place => !Object.hasOwn(place, 'description')), true)
    assert.equal(small.body.things.every(thing => !Object.hasOwn(thing, 'body')), true)
    assert.equal(small.body.notes.every(note => !Object.hasOwn(note, 'body')), true)
    const smallRecordBytes = Object.freeze([
      Buffer.byteLength(SMALL_ROOM_RECORDS.childDescription, 'utf8'),
      Buffer.byteLength(SMALL_ROOM_RECORDS.thingBody, 'utf8'),
      Buffer.byteLength(SMALL_ROOM_RECORDS.noteBody, 'utf8'),
    ])
    assert.deepEqual(
      [
        small.body.subplaces[0]!.description_text_bytes,
        small.body.things[0]!.body_text_bytes,
        small.body.notes[0]!.body_text_bytes,
      ],
      smallRecordBytes,
    )
    assert.equal(smallRecordBytes.every(bytes => bytes < 100), true)
    assert.deepEqual(
      [
        small.body.subplaces_page.has_more,
        small.body.things_page.has_more,
        small.body.notes_page.has_more,
      ],
      [false, false, false],
    )
    assert.deepEqual(
      [
        small.body.subplaces_page.returned_text_bytes,
        small.body.things_page.returned_text_bytes,
        small.body.notes_page.returned_text_bytes,
      ],
      [0, 0, 0],
    )

    const smallFullResponse = await cityApp.request(
      `http://city.test/api/place/${city.smallPlaceId}?view=full`,
    )
    const smallFullText = await smallFullResponse.text()
    assert.equal(smallFullResponse.status, 200, smallFullText)
    const smallFull = JSON.parse(smallFullText) as {
      subplaces: Array<{ description: string }>
      things: Array<{ body: string }>
      notes: Array<{ body: string }>
      subplaces_page: { returned_text_bytes: number; has_more: boolean }
      things_page: { returned_text_bytes: number; has_more: boolean }
      notes_page: { returned_text_bytes: number; has_more: boolean }
    }
    assert.deepEqual(
      smallFull.subplaces.map(place => place.description),
      [SMALL_ROOM_RECORDS.childDescription],
    )
    assert.deepEqual(smallFull.things.map(thing => thing.body), [SMALL_ROOM_RECORDS.thingBody])
    assert.deepEqual(smallFull.notes.map(note => note.body), [SMALL_ROOM_RECORDS.noteBody])
    assert.deepEqual(
      [
        smallFull.subplaces_page.returned_text_bytes,
        smallFull.things_page.returned_text_bytes,
        smallFull.notes_page.returned_text_bytes,
      ],
      smallRecordBytes,
    )
    assert.deepEqual(
      [
        smallFull.subplaces_page.has_more,
        smallFull.things_page.has_more,
        smallFull.notes_page.has_more,
      ],
      [false, false, false],
    )
    testContext.diagnostic(
      `representative outline bytes: note-only=${Buffer.byteLength(noteHeavy.text, 'utf8')}, ` +
        `child-only=${Buffer.byteLength(childHeavy.text, 'utf8')}, ` +
        `small=${Buffer.byteLength(small.text, 'utf8')}; ` +
        `small full=${Buffer.byteLength(smallFullText, 'utf8')}`,
    )
  })

}
