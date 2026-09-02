function boundedPart(value: string, label: string): string {
  const text = value.trim()
  if (!text) throw new Error(`${label} must not be empty`)
  return text
}

export function missingRecordRefusal(record: string, next: string): string {
  return `${boundedPart(record, 'record')} was not found; ${boundedPart(next, 'next step')}`
}
