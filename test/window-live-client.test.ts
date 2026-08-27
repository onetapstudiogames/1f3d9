import test from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeWindowDrawing,
  windowLivePlateChildren,
  windowLivePollDelay,
  windowLiveReplayDuration,
  windowLiveReplayOrder,
  windowLiveSpeechLine,
  windowLiveTraceOpacity,
} from '../src/window-client.ts'

test('drawing normalization preserves exact colours and distinguishes blank from undrawn', () => {
  const drawing = normalizeWindowDrawing({
    palette: ['#102030', '#102031'],
    indices: Array.from({ length: 64 }, (_, index) => index % 3 === 0 ? null : index % 2),
  })
  assert.deepEqual(drawing?.palette, ['#102030', '#102031'])
  assert.equal(drawing?.indices.length, 64)
  assert.equal(normalizeWindowDrawing(null), null)

  const blank = normalizeWindowDrawing({ palette: [], indices: Array(64).fill(null) })
  assert.ok(blank)
  assert.ok(blank.indices.every(index => index === null))
})

test('drawing normalization refuses unsafe colours, bad square counts, and missing palette entries', () => {
  assert.equal(normalizeWindowDrawing({ palette: ['red'], indices: Array(64).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456;display:none'], indices: Array(64).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456'], indices: Array(63).fill(0) }), null)
  assert.equal(normalizeWindowDrawing({ palette: ['#123456'], indices: Array(64).fill(1) }), null)
  assert.equal(normalizeWindowDrawing({ palette: Array(65).fill('#123456'), indices: Array(64).fill(0) }), null)
})

test('live plate placement is stable by public id and never mutates the directory', () => {
  const directory = Object.freeze([
    Object.freeze({ id: 9, parent_id: 1, name: 'later' }),
    Object.freeze({ id: 4, parent_id: 1, name: 'first' }),
    Object.freeze({ id: 7, parent_id: 4, name: 'inside' }),
  ])
  assert.deepEqual(windowLivePlateChildren(directory, 1).map(place => place.id), [4, 9])
  assert.deepEqual(directory.map(place => place.id), [9, 4, 7])
})

test('live polling follows activity and backs off through quiet without exceeding five minutes', () => {
  assert.equal(windowLivePollDelay(true, 99), 25_000)
  assert.equal(windowLivePollDelay(false, 0), 60_000)
  assert.equal(windowLivePollDelay(false, 1), 120_000)
  assert.equal(windowLivePollDelay(false, 2), 240_000)
  assert.equal(windowLivePollDelay(false, 3), 300_000)
  assert.equal(windowLivePollDelay(false, 20), 300_000)
})

test('trace opacity ages honestly and expires at its stated lifetime', () => {
  assert.equal(windowLiveTraceOpacity(1_000, 1_000, 10_000), 1)
  assert.equal(windowLiveTraceOpacity(1_000, 6_000, 10_000), 0.5)
  assert.equal(windowLiveTraceOpacity(1_000, 11_000, 10_000), 0)
  assert.equal(windowLiveTraceOpacity(2_000, 1_000, 10_000), 1)
})

test('recorded movement replay lasts one to three seconds and scales with trail length', () => {
  assert.equal(windowLiveReplayDuration(0), 1_000)
  assert.equal(windowLiveReplayDuration(50), 1_700)
  assert.equal(windowLiveReplayDuration(10_000), 3_000)
  assert.equal(windowLiveReplayDuration(Number.NaN), 1_000)
  assert.equal(windowLiveReplayDuration(100, 1_250), 1_250)
  assert.equal(windowLiveReplayDuration(100, 999), 0)
})

test('replay keeps recorded order and refuses records beyond the trace edge', () => {
  const records = Object.freeze([
    Object.freeze({ change_id: '13', at: new Date(13_000), label: 'use' }),
    Object.freeze({ change_id: '11', at: new Date(11_000), label: 'move' }),
    Object.freeze({ change_id: '12', at: new Date(12_000), label: 'note' }),
    Object.freeze({ change_id: '10', at: new Date(9_999), label: 'outside' }),
  ])

  assert.deepEqual(
    windowLiveReplayOrder(records, 10_000).map(record => record.label),
    ['move', 'note', 'use'],
  )
  assert.deepEqual(records.map(record => record.label), ['use', 'move', 'note', 'outside'])

  const openingRows = Object.freeze([
    Object.freeze({ id: 103, at: new Date(12_000), label: 'later event id' }),
    Object.freeze({ id: 101, at: new Date(12_000), label: 'earlier event id' }),
  ])
  assert.deepEqual(
    windowLiveReplayOrder(openingRows, 10_000).map(record => record.label),
    ['earlier event id', 'later event id'],
  )

  const mixedRows = Object.freeze([
    Object.freeze({ change_id: '12', at: new Date(10_500), label: 'second change' }),
    Object.freeze({ id: 102, at: new Date(12_000), label: 'second opening event' }),
    Object.freeze({ change_id: '11', at: new Date(13_000), label: 'first change' }),
    Object.freeze({ id: 101, at: new Date(11_000), label: 'first opening event' }),
  ])
  const expected = ['first opening event', 'second opening event', 'first change', 'second change']
  for (const permutation of [mixedRows, [...mixedRows].reverse(), [
    mixedRows[1]!, mixedRows[3]!, mixedRows[0]!, mixedRows[2]!,
  ]]) {
    assert.deepEqual(windowLiveReplayOrder(permutation, 10_000).map(record => record.label), expected)
  }
})

test('speech bubbles keep only the first line and use an honest 60-character ellipsis cap', () => {
  assert.equal(windowLiveSpeechLine('first line\nsecond line'), 'first line')
  assert.equal(windowLiveSpeechLine('first line\r\nsecond line'), 'first line')
  assert.equal(windowLiveSpeechLine('short line'), 'short line')

  const exactLine = 'x'.repeat(60)
  assert.equal(windowLiveSpeechLine(exactLine), exactLine)
  assert.equal(windowLiveSpeechLine(exactLine + 'x'), 'x'.repeat(59) + '…')

  const longLine = '🙂'.repeat(60) + 'tail that is not shown'
  const bubble = windowLiveSpeechLine(longLine)
  assert.equal(Array.from(bubble).length, 60)
  assert.equal(bubble, '🙂'.repeat(59) + '…')
})
