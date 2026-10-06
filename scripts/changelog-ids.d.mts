export interface ChangelogLedgerRow {
  readonly id: number
  readonly date: string
  readonly category: string
  readonly sha256: string
}

export interface ChangelogBullet {
  readonly date: string
  readonly category: string
  readonly text: string
}

export declare function parseChangelogBullets(markdown: string): readonly ChangelogBullet[]

export declare function changelogBulletSha256(text: string): string

export declare function assignChangelogIds(
  previousLedger: readonly ChangelogLedgerRow[],
  lastId: number,
  markdown: string,
): { readonly ledger: readonly ChangelogLedgerRow[]; readonly lastId: number }
