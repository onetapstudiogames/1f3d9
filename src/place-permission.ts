const PLACE_ALIASES = Object.freeze({
  destination: 'destination',
  parent: 'parent',
  place: 'place',
} as const)

const PLACE_PERMISSIONS = Object.freeze({
  open_to_building: 'open_to_building',
  open_to_notes: 'open_to_notes',
  open_to_things: 'open_to_things',
} as const)

type PlaceSqlAlias = keyof typeof PLACE_ALIASES
type PlacePermissionColumn = keyof typeof PLACE_PERMISSIONS

const PLACE_PERMISSION_FRAGMENT = Symbol('place-permission-fragment')

interface PlacePermissionFragment {
  readonly [PLACE_PERMISSION_FRAGMENT]: true
  readonly actorId: number
  readonly alias: string
  readonly permission: string
}

type TaggedDatabase<Result> = (
  strings: TemplateStringsArray,
  ...values: unknown[]
) => Promise<Result>

export function placePermission(
  alias: PlaceSqlAlias,
  permission: PlacePermissionColumn,
  actorId: number,
): PlacePermissionFragment {
  if (!Object.hasOwn(PLACE_ALIASES, alias)) throw new Error('unsupported place SQL alias')
  const safeAlias = PLACE_ALIASES[alias]
  if (!Object.hasOwn(PLACE_PERMISSIONS, permission)) throw new Error('unsupported place permission')
  const safePermission = PLACE_PERMISSIONS[permission]
  return Object.freeze({
    [PLACE_PERMISSION_FRAGMENT]: true as const,
    actorId,
    alias: safeAlias,
    permission: safePermission,
  })
}

function isPlacePermissionFragment(value: unknown): value is PlacePermissionFragment {
  return typeof value === 'object'
    && value !== null
    && (value as Partial<PlacePermissionFragment>)[PLACE_PERMISSION_FRAGMENT] === true
}

function templateStrings(strings: readonly string[]): TemplateStringsArray {
  return Object.freeze(Object.assign([...strings], {
    raw: Object.freeze([...strings]),
  })) as unknown as TemplateStringsArray
}

/** Expand only closed-set place-permission fragments into a tagged SQL call. */
export function withPlacePermission<Result>(
  database: TaggedDatabase<Result>,
): TaggedDatabase<Result> {
  return (strings: TemplateStringsArray, ...values: unknown[]) => {
    const compiled = values.reduce<Readonly<{
      strings: readonly string[]
      values: readonly unknown[]
    }>>((state, value, index) => {
      const suffix = strings[index + 1] ?? ''
      if (!isPlacePermissionFragment(value)) {
        return Object.freeze({
          strings: Object.freeze([...state.strings, suffix]),
          values: Object.freeze([...state.values, value]),
        })
      }
      const prefix = state.strings[state.strings.length - 1] ?? ''
      return Object.freeze({
        strings: Object.freeze([
          ...state.strings.slice(0, -1),
          `${prefix}(${value.alias}.owner_id = `,
          ` OR ${value.alias}.${value.permission})${suffix}`,
        ]),
        values: Object.freeze([...state.values, value.actorId]),
      })
    }, Object.freeze({
      strings: Object.freeze([strings[0] ?? '']),
      values: Object.freeze([]),
    }))

    return database(templateStrings(compiled.strings), ...compiled.values)
  }
}
