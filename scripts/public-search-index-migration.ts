export const PUBLIC_SEARCH_INDEX_NAMES = Object.freeze([
  'notes_public_search_words',
  'notes_public_search_phrase',
  'things_public_search_words_active',
  'things_public_search_phrase_active',
] as const)

type PublicSearchIndexName = typeof PUBLIC_SEARCH_INDEX_NAMES[number]

type ReviewedPublicSearchIndex = Readonly<{
  name: PublicSearchIndexName
  table: 'notes' | 'things'
  expression: string
  operatorClass: 'tsvector_ops' | 'gin_trgm_ops'
  predicate: string | null
}>

const REVIEWED_PUBLIC_SEARCH_INDEXES: readonly ReviewedPublicSearchIndex[] = Object.freeze([
  Object.freeze({
    name: 'notes_public_search_words',
    table: 'notes',
    expression: "to_tsvector('simple'::regconfig,body)",
    operatorClass: 'tsvector_ops',
    predicate: null,
  }),
  Object.freeze({
    name: 'notes_public_search_phrase',
    table: 'notes',
    expression: 'lower(body)',
    operatorClass: 'gin_trgm_ops',
    predicate: null,
  }),
  Object.freeze({
    name: 'things_public_search_words_active',
    table: 'things',
    expression: "to_tsvector('simple'::regconfig,(name||' '::text)||body)",
    operatorClass: 'tsvector_ops',
    predicate: 'withdrawn_atisnull',
  }),
  Object.freeze({
    name: 'things_public_search_phrase_active',
    table: 'things',
    expression: "lower((name||' '::text)||body)",
    operatorClass: 'gin_trgm_ops',
    predicate: 'withdrawn_atisnull',
  }),
])

export const PUBLIC_SEARCH_EXTENSION_STATE_QUERY = `
  SELECT namespace.nspname AS extension_schema
  FROM pg_extension extension
  JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pg_trgm'
`

export const PUBLIC_SEARCH_INDEX_STATE_QUERY = `
  SELECT index_namespace.nspname AS index_schema,
    index_relation.relname AS index_name,
    table_namespace.nspname AS table_schema,
    table_relation.relname AS table_name,
    index_catalog.indisvalid AS valid,
    index_catalog.indisready AS ready,
    index_catalog.indisunique AS unique_index,
    access_method.amname AS access_method,
    index_catalog.indnkeyatts::integer AS key_column_count,
    index_catalog.indnatts::integer AS total_column_count,
    index_catalog.indpred IS NULL AS unfiltered,
    pg_get_expr(
      index_catalog.indpred,
      index_catalog.indrelid,
      true
    ) AS predicate,
    ARRAY(
      SELECT pg_get_indexdef(index_relation.oid, position, true)
      FROM generate_series(1, index_catalog.indnatts) AS position
      ORDER BY position
    ) AS columns,
    ARRAY(
      SELECT operator_class.opcname
      FROM unnest(index_catalog.indclass::oid[]) WITH ORDINALITY
        AS selected(operator_class_oid, position)
      JOIN pg_opclass operator_class
        ON operator_class.oid = selected.operator_class_oid
      ORDER BY selected.position
    )::text[] AS operator_classes
  FROM pg_class AS index_relation
  JOIN pg_namespace AS index_namespace
    ON index_namespace.oid = index_relation.relnamespace
  JOIN pg_index AS index_catalog
    ON index_catalog.indexrelid = index_relation.oid
  JOIN pg_am AS access_method
    ON access_method.oid = index_relation.relam
  JOIN pg_class AS table_relation
    ON table_relation.oid = index_catalog.indrelid
  JOIN pg_namespace AS table_namespace
    ON table_namespace.oid = table_relation.relnamespace
  WHERE index_namespace.nspname = 'public'
    AND index_relation.relname = ANY($1::text[])
`

function normalizedCatalogSql(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let normalized = ''
  let quoted = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!
    if (character === "'") {
      normalized += character
      if (quoted && value[index + 1] === "'") {
        normalized += value[index + 1]
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && /\s/u.test(character)) continue
    normalized += quoted ? character : character.toLowerCase()
  }
  return normalized
}

function exactPublicSearchIndex(
  row: Readonly<Record<string, unknown>>,
  expected: ReviewedPublicSearchIndex,
): boolean {
  const columns = row.columns
  const operatorClasses = row.operator_classes
  const expectedUnfiltered = expected.predicate === null
  return row.index_schema === 'public' &&
    row.index_name === expected.name &&
    row.table_schema === 'public' &&
    row.table_name === expected.table &&
    row.unique_index === false &&
    row.access_method === 'gin' &&
    row.key_column_count === 1 &&
    row.total_column_count === 1 &&
    row.unfiltered === expectedUnfiltered &&
    Array.isArray(columns) &&
    columns.length === 1 &&
    normalizedCatalogSql(columns[0]) === expected.expression &&
    Array.isArray(operatorClasses) &&
    operatorClasses.length === 1 &&
    operatorClasses[0] === expected.operatorClass &&
    normalizedCatalogSql(row.predicate) === expected.predicate &&
    typeof row.valid === 'boolean' &&
    typeof row.ready === 'boolean'
}

function indexedCreateStatements(
  createStatements: readonly string[],
): ReadonlyMap<PublicSearchIndexName, string> {
  const statements = new Map<PublicSearchIndexName, string>()
  for (const expected of REVIEWED_PUBLIC_SEARCH_INDEXES) {
    const matching = createStatements.filter(statement => new RegExp(
      `\\bCREATE\\s+INDEX\\s+CONCURRENTLY\\s+IF\\s+NOT\\s+EXISTS\\s+${expected.name}\\b`,
      'iu',
    ).test(statement))
    if (matching.length !== 1) {
      throw new Error(`${expected.name} does not have one reviewed create statement`)
    }
    statements.set(expected.name, matching[0]!)
  }
  if (createStatements.length !== statements.size) {
    throw new Error('public search index migration contains an unexpected index statement')
  }
  return statements
}

/**
 * Keep exact valid search indexes untouched. Failed concurrent builds are safe
 * to remove and retry; a same-named relation with another definition fails closed.
 */
export function publicSearchIndexRecoveryStatements(
  rows: readonly Readonly<Record<string, unknown>>[],
  createStatements: readonly string[],
): readonly string[] {
  const reviewedCreates = indexedCreateStatements(createStatements)
  const rowsByName = new Map<string, Readonly<Record<string, unknown>>>()
  for (const row of rows) {
    const name = String(row.index_name ?? '')
    if (rowsByName.has(name)) throw new Error(`${name || 'search index'} is ambiguous`)
    rowsByName.set(name, row)
  }

  const recovery: string[] = []
  for (const expected of REVIEWED_PUBLIC_SEARCH_INDEXES) {
    const createStatement = reviewedCreates.get(expected.name)!
    const row = rowsByName.get(expected.name)
    if (!row) {
      recovery.push(createStatement)
      continue
    }
    if (!exactPublicSearchIndex(row, expected)) {
      throw new Error(`${expected.name} conflicts with the reviewed definition`)
    }
    if (row.valid === true && row.ready === true) continue
    recovery.push(
      `DROP INDEX CONCURRENTLY IF EXISTS public.${expected.name}`,
      createStatement,
    )
  }
  return Object.freeze(recovery)
}
