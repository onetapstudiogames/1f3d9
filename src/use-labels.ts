/**
 * What using a thing does to you, said before you use it (decision #168): a plain sentence,
 * derived from the use programs of the traits on its effective kind revision, naming how
 * many labels using it puts on you and how long each lasts, with "may" where a step is
 * conditional or delayed. It counts the thing's own traits only; a law of the room can add
 * its own. It never names the labels.
 */
import {
  EMPTY_EFFECTS,
  RESIDENT_ABILITY_LABEL_SECONDS,
  loadTraitRecipe,
  type Effect,
} from './physics.ts'

type LabelOnYou = Readonly<{ seconds: number | null; may: boolean }>

const DURATION_UNITS = Object.freeze([
  { seconds: 86_400, one: 'day', many: 'days' },
  { seconds: 3_600, one: 'hour', many: 'hours' },
  { seconds: 60, one: 'minute', many: 'minutes' },
  { seconds: 1, one: 'second', many: 'seconds' },
] as const)

/** A whole number of seconds in the largest unit that divides it exactly: "1 day", "90 minutes". */
export function durationWords(seconds: number): string {
  const unit = DURATION_UNITS.find(candidate => seconds % candidate.seconds === 0) ?? DURATION_UNITS[3]
  const count = seconds / unit.seconds
  return `${count} ${count === 1 ? unit.one : unit.many}`
}

/**
 * Labels a program puts on the resident who uses the thing: label actor, and label target
 * inside a reach over residents, which reaches you too. Inside a reach a label on a
 * resident ends within a day; anything inside chance, check_label, wait, or reach may not
 * happen, so it is "may".
 */
function labelsOnYou(
  effects: readonly Effect[],
  may: boolean,
  reach: 'none' | 'things' | 'residents',
): readonly LabelOnYou[] {
  return effects.flatMap((effect): readonly LabelOnYou[] => {
    if (effect.effect === 'label') {
      const onYou = effect.target === 'actor' || (effect.target === 'target' && reach === 'residents')
      if (!onYou) return []
      const seconds = reach === 'none'
        ? effect.seconds ?? null
        : Math.min(effect.seconds ?? RESIDENT_ABILITY_LABEL_SECONDS, RESIDENT_ABILITY_LABEL_SECONDS)
      return [{ seconds, may }]
    }
    if (effect.effect === 'reach') return labelsOnYou(effect.then, true, effect.over)
    if (effect.effect === 'wait') return labelsOnYou(effect.then, true, reach)
    if (effect.effect === 'chance' || effect.effect === 'check_label') {
      return [
        ...labelsOnYou(effect.then, true, reach),
        ...labelsOnYou(effect.else ?? EMPTY_EFFECTS, true, reach),
      ]
    }
    return []
  })
}

function groupPhrase(count: number, seconds: number | null, may: boolean): string {
  const verb = may ? 'may put' : 'puts'
  const labels = count === 1 ? 'a label' : `${count} labels`
  if (seconds === null) {
    return `${verb} ${count === 1 ? 'a permanent label' : `${count} permanent labels`} on you`
  }
  return `${verb} ${labels} on you that ${count === 1 ? 'lasts' : 'last'} ${durationWords(seconds)}`
}

/** The sentence a thing read carries as on_use, from its kind traits' stored recipes in kind order. */
export function useLabelStatement(storedRecipes: readonly unknown[]): string {
  const found = storedRecipes.flatMap(recipe => labelsOnYou(loadTraitRecipe(recipe).use ?? EMPTY_EFFECTS, false, 'none'))
  if (found.length === 0) return 'Using it puts no labels on you.'
  const groups = new Map<string, { count: number; seconds: number | null; may: boolean }>()
  for (const label of [...found.filter(entry => !entry.may), ...found.filter(entry => entry.may)]) {
    const key = `${label.may}:${label.seconds}`
    const group = groups.get(key)
    groups.set(key, { count: (group?.count ?? 0) + 1, seconds: label.seconds, may: label.may })
  }
  const phrases = [...groups.values()].map(group => groupPhrase(group.count, group.seconds, group.may))
  const joined = phrases.length === 1
    ? phrases[0]
    : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
  return `Using it ${joined}.`
}
