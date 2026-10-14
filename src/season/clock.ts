import { formatDay } from './dates.ts'

// One clock for everyone: the server's UTC time. Only unit tests and the
// browser test server replace it, through setSeasonClockForTests.

let readNow: () => number = () => Date.now()

export function seasonNowMs(): number {
  return readNow()
}

export function seasonDateNow(): string {
  return formatDay(readNow())
}

export function setSeasonClockForTests(now: (() => number) | null): void {
  readNow = now ?? (() => Date.now())
}
