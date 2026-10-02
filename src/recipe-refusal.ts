import {
  BRICK_BRANCHES,
  MAX_APPLICATIONS_PER_PROGRAM,
  MAX_BLOCK_SECONDS,
  MAX_EFFECT_COUNT,
  MAX_EFFECT_DEPTH,
  MAX_EFFECT_GENERATIONS,
  MAX_RECIPE_BYTES,
  MAX_TIMER_SECONDS,
  MIN_TIMER_SECONDS,
  REACH_MAX_CEILING,
  WAKE_EVENTS,
  WAKE_MAX_EVERY_SECONDS,
  WAKE_MIN_EVERY_SECONDS,
  traitRecipeGrammarFault,
  type RecipeGrammarFault,
} from './physics.ts'

const TOP_RULE = 'a recipe is a list of steps, or an object whose only keys are talk, move, use, give, consume, make, go_home, and wake'

function grammarRule(fault: RecipeGrammarFault): string {
  if (fault.code === 'shape') {
    const branches = BRICK_BRANCHES[fault.brick]
    if (branches === 'none' && (fault.hasThen || fault.hasElse)) {
      return `${fault.brick} takes no then or else`
    }
    if (branches === 'then' && fault.hasElse) return `${fault.brick} takes then but no else`
    if (branches !== 'none' && !fault.hasThen) return `${fault.brick} needs then, a list of steps`

    if (fault.brick === 'destroy') return 'destroy takes target (source or target)'
    if (fault.brick === 'move') return 'move takes target (actor, source, or target) and to (destination or home)'
    if (fault.brick === 'transfer') return 'transfer takes target (source or target) and to (recipient or actor)'
    if (fault.brick === 'label') return 'label takes target (actor, source, target, or place) and label (a world name)'
    if (fault.brick === 'block') return `block takes target (actor or target), action (talk, move, use, give, consume, or make), and seconds (1 to ${MAX_BLOCK_SECONDS})`
    if (fault.brick === 'wait') return `wait takes seconds (${MIN_TIMER_SECONDS} to ${MAX_TIMER_SECONDS}), then, and an optional repeat (1 to ${MAX_EFFECT_GENERATIONS})`
    if (fault.brick === 'check_label') return 'check_label takes target (actor, source, target, or place), label (a world name), then, and an optional else'
    if (fault.brick === 'chance') return 'chance takes percent (1 to 99), then, and an optional else'
    if (fault.brick === 'write') return 'write takes key (a world name), an optional op (set, add, or append), and value, which set and append need'
    if (fault.brick === 'copy') return `copy takes optional generations (1 to ${MAX_EFFECT_GENERATIONS}), copies (1 to 10000 or unlimited), to (here or adjacent), and inherit (a list of body and state)`
    if (fault.brick === 'reach') return `reach takes then and optional over (things or residents), max (1 to ${REACH_MAX_CEILING}), and kind (a world name, only with over things)`
    return 'convert takes target (which must be target) and an optional into_kind (a world name)'
  }

  if (fault.code === 'top') return TOP_RULE
  if (fault.code === 'list') return 'steps must be a list'
  if (fault.code === 'count') return `a recipe holds at most ${MAX_EFFECT_COUNT.toLocaleString('en-US')} steps in all`
  if (fault.code === 'depth') return `steps nest at most ${MAX_EFFECT_DEPTH.toLocaleString('en-US')} levels deep`
  if (fault.code === 'weight') return `one program may weigh at most ${MAX_APPLICATIONS_PER_PROGRAM.toLocaleString('en-US')} effect applications, a reach counting its max times its steps`
  if (fault.code === 'bytes') return `a recipe may be at most ${MAX_RECIPE_BYTES.toLocaleString('en-US')} bytes as JSON`
  if (fault.code === 'step') return 'each step is an object whose effect is destroy, move, transfer, label, block, wait, check_label, chance, write, copy, reach, or convert'
  if (fault.code === 'reach_steps') return 'a reach never holds block, copy, or another reach, and never moves actor; over residents it holds only label, check_label, chance, and write'
  return `wake takes then and optional on (a list of ${WAKE_EVENTS[0]}, ${WAKE_EVENTS[1]}, and ${WAKE_EVENTS[2]}) and every_seconds (${WAKE_MIN_EVERY_SECONDS} to ${WAKE_MAX_EVERY_SECONDS})`
}

export function recipeGrammarWords(fault: RecipeGrammarFault): Readonly<{ where: string; rule: string }> {
  return Object.freeze({ where: fault.where, rule: grammarRule(fault) })
}

export function recipeRefusalWords(value: unknown): Readonly<{ where: string; rule: string }> {
  const grammar = traitRecipeGrammarFault(value)
  return grammar
    ? recipeGrammarWords(grammar)
    : Object.freeze({ where: 'the top level', rule: TOP_RULE })
}
