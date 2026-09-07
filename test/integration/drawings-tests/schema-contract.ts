import assert from 'node:assert/strict'
import type { Client } from 'pg'

export async function registerSchemaContractTests(
  client: Client,
  drawingFunctionDdl: (name: string) => string,
): Promise<void> {
  await client.query('BEGIN')
  try {
    await client.query('CREATE SCHEMA drawing_contract_probe')
    await client.query('SET LOCAL search_path TO drawing_contract_probe, public')
    for (const name of [
      'valid_city_drawing',
      'valid_city_drawing_public_text',
      'valid_city_drawing_variant_name',
      'valid_city_drawing_state',
      'valid_city_drawing_variants',
      'city_drawing_rows',
      'city_drawing_presentation_state',
      'valid_city_drawing_revision_value',
      'city_drawing_public_value',
    ]) await client.query(drawingFunctionDdl(name))

    await client.query('SET LOCAL search_path TO pg_catalog')
    const customSchemaContract = (await client.query<{
      safe_state: boolean
      unsafe_state: boolean
      trimmed_variant: boolean
      public_state: string
    }>(`
      SELECT
        drawing_contract_probe.valid_city_drawing_state(
          'refused', 'Owner chose not to draw this.', NULL
        ) AS safe_state,
        drawing_contract_probe.valid_city_drawing_state(
          'refused', $1, NULL
        ) AS unsafe_state,
        drawing_contract_probe.valid_city_drawing_variant_name(
          ' padded variant '
        ) AS trimmed_variant,
        drawing_contract_probe.city_drawing_public_value(
          'refused', 'Owner chose not to draw this.', NULL,
          'thing', NULL, NULL, NULL, NULL
        )->>'presentation_state' AS public_state
    `, ['hidden\u202Elabel'])).rows[0]
    assert.deepEqual(customSchemaContract, {
      safe_state: true,
      unsafe_state: false,
      trimmed_variant: false,
      public_state: 'refused',
    })
  } finally {
    await client.query('ROLLBACK')
  }
}
