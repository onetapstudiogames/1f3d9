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
  endProgramOf,
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

/** The longest end_program_summary a read carries. */
export const END_PROGRAM_SUMMARY_MAX_CHARACTERS = 300

const NO_END_PROGRAM = 'When this ends it becomes a remnant.'

/** One fixed phrase per brick an end program uses: the certain form, then the "may" form. */
type EndPhrase = Readonly<{ key: string; plain: string; may: string }>

function endPhrase(key: string, plain: string, may: string): EndPhrase {
  return Object.freeze({ key, plain, may })
}

const MAY_DO_MORE = endPhrase('more', 'may do more', 'may do more')

const END_PHRASES = Object.freeze({
  write: endPhrase('write', 'writes its own state box', 'may write its own state box'),
  copy: endPhrase('copy', 'makes a copy of itself', 'may make a copy of itself'),
  labelThings: endPhrase('label_things', 'puts a label on things in its room', 'may put a label on things in its room'),
  labelResidents: endPhrase('label_residents', 'puts a label on residents in its room', 'may put a label on residents in its room'),
  labelRoom: endPhrase('label_room', 'puts a label on its room', 'may put a label on its room'),
  reachThings: endPhrase('reach_things', 'reaches things in its room', 'may reach things in its room'),
  reachResidents: endPhrase('reach_residents', 'reaches residents in its room', 'may reach residents in its room'),
  convert: endPhrase('convert', 'turns things it reaches into its kind', 'may turn things it reaches into its kind'),
  move: endPhrase('move', 'moves things it reaches', 'may move things it reaches'),
  destroy: endPhrase('destroy', 'destroys things it reaches', 'may destroy things it reaches'),
  block: endPhrase('block', 'blocks residents it reaches', 'may block residents it reaches'),
})

type EndReach = 'none' | 'things' | 'residents'

function phraseOf(effect: Effect, reach: EndReach): EndPhrase | null {
  if (effect.effect === 'write') return END_PHRASES.write
  if (effect.effect === 'copy') return END_PHRASES.copy
  if (effect.effect === 'label') {
    if (effect.target === 'place' || effect.target === 'law_place') return END_PHRASES.labelRoom
    return reach === 'residents' ? END_PHRASES.labelResidents : END_PHRASES.labelThings
  }
  if (effect.effect === 'check_label' || effect.effect === 'chance') return MAY_DO_MORE
  if (effect.effect === 'reach') return effect.over === 'residents' ? END_PHRASES.reachResidents : END_PHRASES.reachThings
  if (effect.effect === 'convert') return END_PHRASES.convert
  if (effect.effect === 'move') return END_PHRASES.move
  if (effect.effect === 'destroy') return END_PHRASES.destroy
  if (effect.effect === 'block') return END_PHRASES.block
  // An end program never waits or hands anything over, so those bricks have no phrase.
  return null
}

type UsedPhrase = Readonly<{ phrase: EndPhrase; may: boolean }>

/** Every phrase a program uses, depth first in step order; inside chance, check_label, or reach it is "may". */
function usedPhrases(effects: readonly Effect[], may: boolean, reach: EndReach): readonly UsedPhrase[] {
  return effects.flatMap((effect): readonly UsedPhrase[] => {
    const phrase = phraseOf(effect, reach)
    const own: readonly UsedPhrase[] = phrase ? [{ phrase, may }] : []
    if (effect.effect === 'reach') return [...own, ...usedPhrases(effect.then, true, effect.over)]
    if (effect.effect === 'chance' || effect.effect === 'check_label') {
      return [
        ...own,
        ...usedPhrases(effect.then, true, reach),
        ...usedPhrases(effect.else ?? EMPTY_EFFECTS, true, reach),
      ]
    }
    return own
  })
}

/** Each phrase once, at its first place, certain when any of its uses is certain. */
function phraseWords(effects: readonly Effect[]): readonly string[] {
  const order: string[] = []
  const found = new Map<string, UsedPhrase>()
  for (const used of usedPhrases(effects, false, 'none')) {
    const seen = found.get(used.phrase.key)
    if (!seen) order.push(used.phrase.key)
    found.set(used.phrase.key, { phrase: used.phrase, may: (seen?.may ?? true) && used.may })
  }
  return order.map(key => {
    const used = found.get(key)!
    return used.may ? used.phrase.may : used.phrase.plain
  })
}

function joinPhrases(phrases: readonly string[]): string {
  return phrases.length === 1
    ? phrases[0]!
    : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

/**
 * The sentence a thing read carries as end_program_summary, from its kind traits in kind
 * order: what happens when it ends, and what the first trait with an end key does then,
 * one fixed phrase per brick used. A stored end key that breaks the rules is inert, so it
 * reads as none. At most 300 characters; phrases that do not fit become "and more".
 */
export function endProgramStatement(traits: readonly Readonly<{ name: string; recipe: unknown }>[]): string {
  const trait = traits.find(candidate => endProgramOf(candidate.recipe) !== null)
  if (!trait) return NO_END_PROGRAM
  const head = `When this ends it becomes a remnant, then, if waking is on for it and its room lets it wake, the next time a resident is in its room it runs ${trait.name}'s end steps once`
  const phrases = phraseWords(endProgramOf(trait.recipe)!.then)
  if (phrases.length === 0) return `${head}.`
  const whole = `${head}: ${joinPhrases(phrases)}.`
  if (whole.length <= END_PROGRAM_SUMMARY_MAX_CHARACTERS) return whole
  for (let kept = phrases.length - 1; kept >= 1; kept -= 1) {
    const cut = `${head}: ${phrases.slice(0, kept).join(', ')} and more.`
    if (cut.length <= END_PROGRAM_SUMMARY_MAX_CHARACTERS) return cut
  }
  return `${head}.`
}
