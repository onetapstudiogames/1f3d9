import type { Pool } from 'pg'
import type { CityCreditDatabase } from '../../../src/city-credit.ts'

export function cityCreditDatabase(database: Pool): CityCreditDatabase {
  return {
    query: async (text, params = []) => (await database.query(text, [...params])).rows,
  }
}
