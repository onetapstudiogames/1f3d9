import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertEveryEventDetailFieldClassified,
  scanEventDetailWriters,
} from './helpers/public-event-detail-writer-scan.ts'

test('the writer scanner reports direct event-detail keys with their source location', () => {
  const scan = scanEventDetailWriters([{
    path: 'src/future-writer.ts',
    source: [
      'const rows = await sql`',
      '  INSERT INTO events (kind, actor, detail)',
      "  SELECT 'action', 'resident', jsonb_build_object(",
      "    'action_id', 1, 'new_live_key', true",
      '  )',
      '`',
    ].join('\n'),
  }])

  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(writer => [writer.field, writer.location]), [
    ['action_id', 'src/future-writer.ts:4'],
    ['new_live_key', 'src/future-writer.ts:4'],
  ])
  assert.throws(
    () => assertEveryEventDetailFieldClassified(scan.fields, ['action_id']),
    /new_live_key.*src\/future-writer\.ts:4/iu,
  )
})

test('the writer scanner resolves TypeScript objects serialized into event detail', () => {
  const scan = scanEventDetailWriters([{
    path: 'src/dynamic-writer.ts',
    source: [
      'const publicDetail = Object.freeze({',
      '  effect_id: pendingId,',
      '  ...(failed ? { error: message } : {}),',
      '})',
      'const rows = await sql`',
      '  INSERT INTO events (kind, actor, detail)',
      "  SELECT 'effect_resolved', 'resident', ${json(publicDetail)}::jsonb",
      '`',
    ].join('\n'),
  }])

  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(writer => writer.field), ['effect_id', 'error'])
})

test('the disposition check catches a new migration detail key', () => {
  const scan = scanEventDetailWriters([{
    path: 'db/migrations/20990101_future.sql',
    source: [
      'INSERT INTO events (kind, actor, detail)',
      "SELECT 'action', 'resident', jsonb_build_object(",
      "  'action_id', 1, 'future_signal', true",
      ');',
    ].join('\n'),
  }])

  assert.throws(
    () => assertEveryEventDetailFieldClassified(scan.fields, ['action_id']),
    /future_signal.*db\/migrations\/20990101_future\.sql:3/iu,
  )
})

test('the writer scanner fails closed on an event-detail shape it cannot derive', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'db/migrations/20990101_future.sql',
      source: [
        'INSERT INTO events (kind, actor, detail)',
        "SELECT 'action', 'resident', opaque_event_detail;",
      ].join('\n'),
    }]),
    error => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /unknown event-detail writer shape/iu)
      assert.match(error.message, /db\/migrations\/20990101_future\.sql:2/iu)
      assert.match(error.message, /opaque_event_detail.*classify it or extend the scanner/iu)
      return true
    },
  )
})

test('the writer scanner fails closed on multi-row event VALUES', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'db/migrations/20990102_multi.sql',
      source: [
        'INSERT INTO events (kind, actor, detail) VALUES',
        "  ('action', 'one', jsonb_build_object('action_id', 1)),",
        "  ('action', 'two', jsonb_build_object('silent_second_row_key', 2));",
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*20990102_multi\.sql.*multi-row VALUES/iu,
  )
})

test('the writer scanner fails closed on an event detail upsert', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'db/migrations/20990103_upsert.sql',
      source: [
        'INSERT INTO events (kind, actor, detail)',
        "VALUES ('action', 'one', jsonb_build_object('action_id', 1))",
        "ON CONFLICT (id) DO UPDATE SET detail = jsonb_build_object('silent_upsert_key', 2);",
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*20990103_upsert\.sql.*ON CONFLICT/iu,
  )
})

test('the writer scanner recognizes quoted event table names', () => {
  const scan = scanEventDetailWriters([{
    path: 'db/migrations/20990104_quoted.sql',
    source: [
      'INSERT INTO "public" . "events" (kind, actor, detail)',
      "SELECT 'action', 'one', jsonb_build_object('quoted_writer_key', true);",
    ].join('\n'),
  }])
  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(field => field.field), ['quoted_writer_key'])
})

test('the writer scanner recognizes quoted detail columns', () => {
  const scan = scanEventDetailWriters([{
    path: 'db/migrations/20990105_quoted_column.sql',
    source: [
      'INSERT INTO events ("kind", "actor", "detail")',
      "SELECT 'action', 'one', jsonb_build_object('quoted_column_key', true);",
    ].join('\n'),
  }])
  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(field => field.field), ['quoted_column_key'])
})

test('the writer scanner rejects multi-branch event SELECTs', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'db/migrations/20990106_union.sql',
      source: [
        'INSERT INTO events (kind, actor, detail)',
        "SELECT 'action', 'one', jsonb_build_object('action_id', 1) FROM first",
        'UNION ALL',
        "SELECT 'action', 'two', jsonb_build_object('silent_union_key', 2) FROM second;",
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*UNION/iu,
  )
})

test('detail-first SELECTs cannot hide no-FROM UNION or upsert branches', () => {
  for (const tail of [
    "UNION ALL SELECT jsonb_build_object('silent_union_key', 2), 'action', 'two'",
    "ON CONFLICT (id) DO UPDATE SET detail = jsonb_build_object('silent_upsert_key', 2)",
  ]) {
    assert.throws(
      () => scanEventDetailWriters([{
        path: 'db/migrations/20990109_detail_first.sql',
        source: [
          'INSERT INTO events (detail, kind, actor)',
          "SELECT jsonb_build_object('action_id', 1), 'action', 'one'",
          `${tail};`,
        ].join('\n'),
      }]),
      /unknown event-detail writer shape/iu,
    )
  }
})

test('UPDATE ONLY events is rejected as an unsupported detail mutation', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'db/migrations/20990110_update_only.sql',
      source: "UPDATE ONLY events SET detail = jsonb_build_object('silent_update_key', 1);",
    }]),
    /unknown event-detail writer shape.*UPDATE ONLY events/iu,
  )
})

test('the writer scanner detects unsupported ONLY and target-alias forms', () => {
  for (const source of [
    "INSERT INTO ONLY events (kind, actor, detail) SELECT 'action', 'one', jsonb_build_object('only_key', true);",
    "INSERT INTO public.events AS inserted (kind, actor, detail) SELECT 'action', 'one', jsonb_build_object('alias_key', true);",
  ]) {
    assert.throws(
      () => scanEventDetailWriters([{ path: 'db/migrations/20990107_target.sql', source }]),
      /unknown event-detail writer shape/iu,
    )
  }
})

test('SQL comments cannot hide an event writer from the scanner', () => {
  const scan = scanEventDetailWriters([{
    path: 'db/migrations/20990108_comments.sql',
    source: [
      'INSERT /* writer */ INTO public /* schema */ . events /* target */ (kind, actor, detail)',
      "SELECT 'action', 'one', jsonb_build_object('commented_writer_key', true);",
    ].join('\n'),
  }])
  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(field => field.field), ['commented_writer_key'])
})

test('the writer scanner rejects an event INSERT without an explicit column list', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'src/implicit-writer.ts',
      source: [
        'const query = sql`',
        "  INSERT INTO events SELECT 1, 'action', 'one', jsonb_build_object('future_implicit', true)",
        '`',
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*explicit column list/iu,
  )
})

test('the writer scanner reads SQL held in a normal TypeScript string', () => {
  const scan = scanEventDetailWriters([{
    path: 'src/string-writer.ts',
    source: "const query = \"INSERT INTO events (kind, actor, detail) SELECT 'action', 'one', jsonb_build_object('future_string', true);\"",
  }])
  assert.equal(scan.writerCount, 1)
  assert.deepEqual(scan.fields.map(field => field.field), ['future_string'])
})

test('the writer scanner rejects a serialized object used after its declaration', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'src/mutated-detail.ts',
      source: [
        'const detail = { action_id: 1 }',
        'detail.future_mutation = true',
        'const query = sql`',
        "  INSERT INTO events (kind, actor, detail) SELECT 'action', 'one', ${json(detail)}::jsonb",
        '`',
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*detail.*used or mutated after its declaration/iu,
  )
})

test('the writer scanner rejects ambiguous TypeScript detail symbols', () => {
  assert.throws(
    () => scanEventDetailWriters([{
      path: 'src/shadowed-detail.ts',
      source: [
        "const detail = { action_id: 1, future_outer: true }",
        'function nested() { const detail = { action_id: 2 }; return detail }',
        'const query = sql`',
        "  INSERT INTO events (kind, actor, detail) SELECT 'action', 'one', ${json(detail)}::jsonb",
        '`',
      ].join('\n'),
    }]),
    /unknown event-detail writer shape.*ambiguous variable detail/iu,
  )
})

test('event trigger detail mutations fail closed', () => {
  for (const source of [
    "NEW.detail['future_subscript'] := to_jsonb(true);",
    "SELECT jsonb_build_object('future_select_into', true) INTO NEW.detail;",
    'CREATE TRIGGER alter_event_detail BEFORE INSERT ON events FOR EACH ROW EXECUTE FUNCTION alter_detail();',
  ]) {
    assert.throws(
      () => scanEventDetailWriters([{
        path: 'db/migrations/20990111_trigger.sql',
        source,
      }]),
      /unknown event-detail writer shape/iu,
    )
  }
})
