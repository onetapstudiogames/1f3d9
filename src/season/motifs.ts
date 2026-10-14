// Decorations for the real skyline icon, adapted from the approved design's
// motifs. Each part is drawn in its own small frame (`src`) and scaled into a
// zone of the icon; every part names a home zone and a second zone. Only plain
// seasonal and festive objects appear here: lights, lanterns, candles, lamps,
// flowers, food, eggs, flags, weather and the sky.

export type ZoneId =
  | 'SKY_L' | 'SKY_C' | 'SKY_R' | 'MAST'
  | 'STRING' | 'LEDGE_LOW' | 'LEDGE_R' | 'FACADE'
  | 'STREET_L' | 'STREET_R' | 'STREET_C'
  | 'ROOFS'

export type Part = Readonly<{
  home: ZoneId
  second: ZoneId | null
  src: readonly [number, number, number, number]
  align: 'top' | 'center' | 'bottom'
  art: string
}>

export type ArtKey =
  | 'spooky' | 'harvest' | 'winter' | 'christmas' | 'hanukkah' | 'kwanzaa' | 'diwali' | 'lny'
  | 'newyear' | 'valentine' | 'holi' | 'nowruz' | 'ramadan' | 'eid' | 'passover' | 'easter'
  | 'oeaster' | 'vesak' | 'rosh' | 'muertos' | 'decsol' | 'junsol' | 'equinox' | 'birthday'

const INK = '#0b1714'
const TILE = '#183a30'

function part(home: ZoneId, second: ZoneId | null, src: Part['src'], align: Part['align'], art: string): Part {
  return Object.freeze({ home, second, src, align, art })
}

type Dot = readonly [number, number, string, number?]

function dots(list: readonly Dot[]): string {
  return list.map(([x, y, fill, r]) => `<circle cx="${x}" cy="${y}" r="${r ?? 1.8}" fill="${fill}" stroke="${INK}" stroke-width=".7"/>`).join('')
}

function flame(x: number, y: number): string {
  return `<ellipse cx="${x}" cy="${y}" rx="1.5" ry="2.6" fill="#ffd34d" stroke="${INK}" stroke-width=".6"/>`
}

function egg(x: number, y: number, fill: string): string {
  return `<ellipse cx="${x}" cy="${y}" rx="3" ry="4" fill="${fill}" stroke="${INK}" stroke-width="1"/>`
}

function heart(x: number, y: number, fill: string): string {
  return `<path d="M${x} ${y + 3}l-4-4a2.3 2.3 0 0 1 4-3a2.3 2.3 0 0 1 4 3z" fill="${fill}" stroke="${INK}" stroke-width="1"/>`
}

function burst(x: number, y: number, color: string, r: number): string {
  let rays = ''
  for (let i = 0; i < 8; i += 1) {
    const angle = (i * Math.PI) / 4
    const point = (radius: number) => `${round(x + Math.cos(angle) * radius)} ${round(y + Math.sin(angle) * radius)}`
    rays += `<path d="M${point(2)}L${point(r)}" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/>`
  }
  return rays
}

function crescent(cx: number, cy: number, fill: string): string {
  return `<circle cx="${cx}" cy="${cy}" r="8" fill="${fill}"/><circle cx="${cx + 4}" cy="${cy - 3}" r="7.2" fill="${TILE}"/>`
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

// A string hung between two buildings: from (-1, 2.2) to (25, 6.9), sagging.
const STRING_FRAME = [-1.5, 0, 25.5, 13] as const
const STRING_PATH = `<path d="M-1 2.2Q12 13.6 25 6.9" fill="none" stroke="${INK}" stroke-width="1"/>`

function onString(t: number): readonly [number, number] {
  const u = 1 - t
  return [round(u * u * -1 + 2 * u * t * 12 + t * t * 25), round(u * u * 2.2 + 2 * u * t * 13.6 + t * t * 6.9)]
}

const SEVENTHS = [1, 2, 3, 4, 5, 6].map(i => i / 7)

function stringLights(colors: readonly string[]): string {
  return STRING_PATH + dots(SEVENTHS.map((t, i) => [...onString(t), colors[i % colors.length]!] as const))
}

function bunting(colors: readonly string[]): string {
  return STRING_PATH + SEVENTHS.map((t, i) => {
    const [x, y] = onString(t)
    return `<path d="M${round(x - 3)} ${y}h6l-3 5z" fill="${colors[i % colors.length]}" stroke="${INK}" stroke-width=".7"/>`
  }).join('')
}

function lanterns(fill: string, at: readonly number[]): string {
  return STRING_PATH + at.map(t => {
    const [x, y] = onString(t)
    const top = y + 2
    return `<path d="M${x} ${y}V${top}" stroke="${INK}" stroke-width="1"/>`
      + `<ellipse cx="${x}" cy="${round(top + 4)}" rx="3.4" ry="4" fill="${fill}" stroke="${INK}" stroke-width="1"/>`
      + `<rect x="${round(x - 2)}" y="${round(top + 7.4)}" width="4" height="1.6" fill="#f3c74f"/>`
  }).join('')
}

function fanous(x: number, top: number, length: number, fill: string): string {
  const y = top + length
  const edge = `" stroke="${INK}" stroke-width=".9"/>`
  return `<path d="M${x} ${top}V${y}" stroke="${INK}" stroke-width=".8"/>`
    + `<circle cx="${x}" cy="${y + 1}" r="1.1" fill="none" stroke="${INK}" stroke-width=".8"/>`
    + `<path d="M${x - 3.4} ${y + 5.5}L${x} ${y + 2}L${x + 3.4} ${y + 5.5}z" fill="${fill}${edge}`
    + `<rect x="${x - 3.8}" y="${y + 5.5}" width="7.6" height="8.5" fill="${fill}${edge}`
    + `<rect x="${x - 2.2}" y="${y + 7}" width="4.4" height="5.5" fill="#fff2b0" stroke="${INK}" stroke-width=".5"/>`
    + `<path d="M${x} ${y + 7}V${y + 12.5}" stroke="${INK}" stroke-width=".5"/>`
    + `<path d="M${x - 3.8} ${y + 14}L${x + 3.8} ${y + 14}L${x} ${y + 17.5}z" fill="${fill}${edge}`
}

function threeFanous(outer: string, middle: string): string {
  return `<path d="M34 5H70" stroke="${INK}" stroke-width="1"/>` + fanous(42, 5, 14, outer) + fanous(54, 5, 24, middle) + fanous(66, 5, 10, outer)
}

function pumpkin(x: number, y: number, rx: number, ry: number, fill: string): string {
  return `<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" stroke="${INK}" stroke-width="1.5"/>`
    + `<rect x="${x - 1}" y="${round(y - ry - 2)}" width="2" height="3" fill="#2f6b3a" stroke="${INK}" stroke-width="1"/>`
}

const BLOSSOMS = part('SKY_R', 'SKY_L', [-3, -3, 11, 6], 'center',
  dots([[0, 2, '#f7c6d9', 1.8], [4, 0, '#f7c6d9', 1.5], [8, 3, '#f7c6d9', 1.6], [3, 4.5, '#f7c6d9', 1.2]]))
const STARS = part('SKY_C', 'SKY_L', [1, 0, 40, 14], 'center',
  dots([[4, 6, '#fff6d6', 1.3], [14, 2, '#fff6d6', 1.1], [30, 4, '#fff6d6', 1.5], [22, 12, '#fff6d6', 1], [38, 10, '#fff6d6', 1.2]]))
const LIGHTS = part('STRING', 'LEDGE_LOW', STRING_FRAME, 'top',
  stringLights(['#c62828', '#f3c74f', '#2e7d32', '#2b5aa8', '#f3c74f', '#c62828']))
// Snow on the five visible roof lines, drawn straight in icon coordinates.
const SNOW = part('ROOFS', null, [0, 0, 512, 512], 'top',
  `<g fill="#ffffff" stroke="${INK}" stroke-width="5">`
  + '<rect x="82" y="118" width="74" height="15" rx="7"/><rect x="239" y="144" width="93" height="15" rx="7"/>'
  + '<rect x="350" y="170" width="113" height="15" rx="7"/><rect x="50" y="229" width="40" height="14" rx="7"/>'
  + '<rect x="148" y="229" width="98" height="14" rx="7"/></g>')

function eidParts(): readonly Part[] {
  return [
    part('SKY_R', 'SKY_L', [1, -1, 29, 25], 'center', crescent(10, 10, '#f3e3a3') + dots([[24, 3, '#f3e3a3', 1.3], [26, 18, '#f3e3a3', 1], [3, 22, '#f3e3a3', 1]])),
    part('SKY_C', 'SKY_L', [33, 4, 71, 47], 'top', threeFanous('#1f7a4d', '#e8b84f')),
  ]
}

function hanukkahArt(nights: number): string {
  const xs = [34, 40, 46, 52, 68, 74, 80, 86]
  const lit = [86, 80, 74, 68, 52, 46, 40, 34].slice(0, nights)
  let art = `<rect x="30" y="99" width="60" height="2.6" fill="#c9d3e6" stroke="${INK}" stroke-width="1"/>`
  for (const x of xs) {
    art += `<rect x="${x - 1.5}" y="90" width="3" height="9" fill="#2b5aa8" stroke="${INK}" stroke-width=".8"/>`
    if (lit.includes(x)) art += flame(x, 87)
  }
  return `${art}<rect x="58.5" y="84" width="3" height="15" fill="#2b5aa8" stroke="${INK}" stroke-width=".8"/>${flame(60, 81)}`
}

function kwanzaaArt(days: number): string {
  const xs = [38, 45, 52, 60, 68, 75, 82]
  const colors = ['#c62828', '#c62828', '#c62828', '#1b1b1b', '#2e7d32', '#2e7d32', '#2e7d32']
  const lit = [3, 0, 6, 1, 5, 2, 4].slice(0, days)
  let art = `<rect x="34" y="99" width="52" height="2.6" fill="#6d4c2f" stroke="${INK}" stroke-width="1"/>`
  xs.forEach((x, index) => {
    art += `<rect x="${x - 1.6}" y="88" width="3.2" height="11" fill="${colors[index]}" stroke="${INK}" stroke-width=".8"/>`
    if (lit.includes(index)) art += flame(x, 85)
  })
  return art
}

function diya(x: number): string {
  return `<path d="M${x - 4} 6a4 2.4 0 0 0 8 0z" fill="#d35400" stroke="${INK}" stroke-width="1"/>${flame(x, 3)}`
}

function lotus(x: number): string {
  return `<g stroke="${INK}" stroke-width=".8"><ellipse cx="${x - 3}" cy="6" rx="2" ry="4" fill="#f4a6c1" transform="rotate(-30 ${x - 3} 6)"/>`
    + `<ellipse cx="${x + 3}" cy="6" rx="2" ry="4" fill="#f4a6c1" transform="rotate(30 ${x + 3} 6)"/>`
    + `<ellipse cx="${x}" cy="5" rx="2.2" ry="4.5" fill="#f9c7d8"/></g>`
}

const HARVEST: readonly Part[] = [
  part('SKY_C', 'SKY_L', [0, -1, 41, 18], 'center', `<g stroke="${INK}" stroke-width="1">`
    + '<ellipse cx="5" cy="5" rx="4" ry="2" fill="#c8621e" transform="rotate(-30 5 5)"/>'
    + '<ellipse cx="16" cy="11" rx="4" ry="2" fill="#d9a13b" transform="rotate(25 16 11)"/>'
    + '<ellipse cx="29" cy="4" rx="4" ry="2" fill="#8a3b12" transform="rotate(-10 29 4)"/>'
    + '<ellipse cx="36" cy="14" rx="3.5" ry="1.8" fill="#d9a13b" transform="rotate(40 36 14)"/></g>'),
  part('LEDGE_LOW', 'LEDGE_R', [-1.5, 0, 26.5, 6.5], 'bottom', `<path d="M-1 2.5Q12.5 5 26 2.5" fill="none" stroke="${INK}" stroke-width="1"/><g stroke="${INK}" stroke-width="1">`
    + ['#c8621e', '#d9a13b', '#8a3b12', '#d9a13b', '#c8621e'].map((fill, i) => `<ellipse cx="${2.5 + i * 5}" cy="3.8" rx="3" ry="1.6" fill="${fill}"/>`).join('') + '</g>'),
  part('STREET_L', 'STREET_R', [0, 0.5, 14, 13.5], 'bottom', pumpkin(7, 8, 6, 4.5, '#d9822b')),
]

const WINTER: readonly Part[] = [STARS, SNOW, LIGHTS]

export function motifParts(art: ArtKey, count: number): readonly Part[] {
  switch (art) {
    case 'spooky': return [
      part('SKY_R', 'SKY_C', [0, 0, 20, 20], 'center', '<circle cx="10" cy="10" r="9" fill="#f6e7b0"/>'),
      part('SKY_L', 'SKY_C', [23, 19, 41, 28], 'center', `<path d="M24 24c3-4 6-4 8-1c2-3 5-3 8 1c-2 0-3 1-4 3c-1-1-3-1-4 0c-1-2-2-3-4-3c-1 0-2 0-4 0z" fill="${INK}" stroke="#c4b0d6" stroke-width=".7"/>`),
      part('STREET_L', 'STREET_R', [1, 0.5, 25.5, 14.5], 'bottom', pumpkin(8, 9, 6, 4.5, '#f28c28') + pumpkin(20, 10, 4.5, 3.5, '#f28c28')),
      part('STREET_R', 'STREET_L', [1, 0.5, 13, 12.5], 'bottom', pumpkin(7, 7.5, 5, 4, '#f28c28')),
    ]
    case 'harvest': return HARVEST
    case 'winter': return WINTER
    case 'christmas': return [...WINTER, part('STREET_R', 'STREET_L', [36.5, 68, 74, 97.5], 'bottom',
      `<polygon points="55,74 45,96 65,96" fill="#2f7a4a" stroke="${INK}" stroke-width="1.5"/>`
      + `<path d="M55 69l1.4 3.2 3.4.3-2.6 2.2.8 3.3-3-1.8-3 1.8.8-3.3-2.6-2.2 3.4-.3z" fill="#f3c74f" stroke="${INK}" stroke-width=".8"/>`
      + `<rect x="66" y="90" width="7" height="6" fill="#b3262c" stroke="${INK}" stroke-width="1.2"/>`
      + `<rect x="38" y="91" width="6" height="5" fill="#f3c74f" stroke="${INK}" stroke-width="1.2"/>`)]
    case 'hanukkah': return [part('STREET_C', null, [29, 77.8, 91, 102.2], 'bottom', hanukkahArt(count))]
    case 'kwanzaa': return [part('STREET_C', null, [33, 81.8, 87, 102.2], 'bottom', kwanzaaArt(count))]
    case 'diwali': return [
      part('STRING', 'LEDGE_R', STRING_FRAME, 'top', stringLights(['#b0306a', '#f39c12'])),
      part('LEDGE_LOW', 'STREET_L', [0.5, -0.5, 31.5, 9], 'bottom', diya(5) + diya(16) + diya(27)),
    ]
    case 'lny': return [
      part('STRING', 'SKY_C', [-1.5, 0, 25.5, 21], 'top', lanterns('#c8202f', [0.25, 0.5, 0.75])),
      part('SKY_R', 'SKY_L', [-2, -2, 14, 12], 'center', dots([[4, 4, '#f4a6c1', 1.6], [8, 8, '#f4a6c1', 1.3], [0, 9, '#f4a6c1', 1.2], [11, 2, '#f4a6c1', 1.2]])),
    ]
    case 'newyear': return [part('SKY_C', 'SKY_L', [-1, -1, 46, 22], 'center',
      burst(8, 9, '#f3c74f', 8) + burst(26, 7, '#dfe7ef', 7) + burst(40, 12, '#f4a6c1', 5))]
    case 'valentine': return [part('SKY_L', 'SKY_R', [0, 0, 27, 16], 'center',
      heart(5, 6, '#e75480') + heart(15, 12, '#ffc2d4') + heart(22, 4, '#e75480'))]
    case 'holi': return [
      part('FACADE', null, [60, 248, 455, 366], 'center', `<g opacity=".88" stroke="${INK}" stroke-width="3">`
        + '<circle cx="110" cy="300" r="22" fill="#e84393"/><circle cx="128" cy="334" r="8" fill="#e84393"/>'
        + '<circle cx="205" cy="292" r="26" fill="#fdd835"/><circle cx="300" cy="278" r="18" fill="#43a047"/>'
        + '<circle cx="400" cy="300" r="24" fill="#1e88e5"/><circle cx="180" cy="348" r="12" fill="#43a047"/>'
        + '<circle cx="430" cy="350" r="10" fill="#fdd835"/></g>'),
      part('SKY_R', 'SKY_L', [-1, -2, 27, 13], 'center', dots([[4, 6, '#e84393', 4], [14, 3, '#fdd835', 3.5], [22, 8, '#1e88e5', 4]])),
    ]
    case 'nowruz': {
      let sprouts = ''
      for (let i = 0; i < 6; i += 1) {
        sprouts += `<path d="M${round(12 + i * 1.8)} 98L${11 + i * 2} ${89 + (i % 2) * 2}" stroke="#3fa34d" stroke-width="1.6" stroke-linecap="round"/>`
      }
      return [
        part('STREET_L', 'STREET_R', [9, 87.5, 23, 102], 'bottom', `<path d="M10 98h12l-1.5 3h-9z" fill="#c3b79c" stroke="${INK}" stroke-width="1"/>${sprouts}`),
        part('STREET_R', 'STREET_L', [94.5, 94, 107.5, 103], 'bottom', egg(98, 98.5, '#64b5f6') + egg(104, 98.5, '#e57373')),
        BLOSSOMS,
      ]
    }
    case 'ramadan': return [
      part('SKY_R', 'SKY_L', [1, -1, 29, 25], 'center', crescent(10, 10, '#f3e3a3') + dots([[24, 3, '#f3e3a3', 1.1], [26, 18, '#f3e3a3', 1], [3, 22, '#f3e3a3', 1]])),
      part('SKY_C', 'SKY_L', [33, 4, 71, 47], 'top', threeFanous('#e8b84f', '#c98a2b')),
    ]
    case 'eid': return eidParts()
    case 'passover': return [
      part('STRING', 'LEDGE_R', [-1.5, 0, 25.5, 14], 'top', bunting(['#2b5aa8', '#ffffff'])),
      part('STREET_L', 'STREET_R', [0, 3, 16, 14.5], 'bottom', '<path d="M3 8v6M8 9v5M13 8v6" stroke="#3fa34d" stroke-width="1.4"/>'
        + dots([[3, 6, '#ffffff', 2.2], [8, 7, '#bfe3f2', 2], [13, 6, '#ffffff', 2.2], [3, 6, '#f6c453', 0.8], [13, 6, '#f6c453', 0.8]])),
    ]
    case 'easter': return [
      part('STREET_L', 'STREET_R', [0.5, 0.5, 28.5, 9.5], 'bottom', egg(4, 5, '#f7c6d9') + egg(11, 5, '#bfe3f2') + egg(18, 5, '#fff1a8') + egg(25, 5, '#c8e6c9')),
      BLOSSOMS,
    ]
    case 'oeaster': return [
      part('STREET_R', 'STREET_L', [0.5, 0.5, 21.5, 9.5], 'bottom', egg(4, 5, '#c62828') + egg(11, 5, '#c62828') + egg(18, 5, '#c62828')),
      BLOSSOMS,
    ]
    case 'vesak': return [
      part('STRING', 'SKY_C', [-1.5, 0, 25.5, 21], 'top', lanterns('#f5c26b', [0.33, 0.67])),
      part('STREET_L', 'STREET_R', [-0.5, -0.5, 22.5, 11], 'bottom', lotus(5) + lotus(17)),
    ]
    case 'rosh': return [part('STREET_L', 'STREET_R', [-0.5, 2, 26, 14], 'bottom', `<g stroke="${INK}" stroke-width="1">`
      + '<circle cx="4" cy="9.5" r="3.6" fill="#d32f2f"/><circle cx="11" cy="10" r="3.4" fill="#d32f2f"/>'
      + '<ellipse cx="5" cy="4.5" rx="1.6" ry=".9" fill="#2e7d32"/><circle cx="21" cy="9" r="4.4" fill="#8e1b2b"/>'
      + '<path d="M19 4.5l1-2 1 1.4 1-1.4 1 2z" fill="#8e1b2b"/></g>')]
    case 'muertos': return [
      part('STRING', 'SKY_C', [-1.5, 0, 25.5, 16], 'top', STRING_PATH + SEVENTHS.slice(0, 5).map((t, i) => {
        const [x, y] = onString(t + 0.07)
        return `<rect x="${round(x - 2)}" y="${y}" width="4" height="4.4" fill="${['#e84393', '#f39c12', '#8e44ad', '#27ae60', '#2980b9'][i]}" stroke="${INK}" stroke-width=".6"/>`
          + `<circle cx="${x}" cy="${round(y + 2.2)}" r=".7" fill="${TILE}"/>`
      }).join('')),
      part('STREET_R', 'STREET_L', [0, 2.5, 22, 11], 'bottom', dots([[3, 6, '#f39c12', 2.2], [7, 8, '#f39c12', 2], [11, 6, '#f7b733', 2], [15, 8, '#f39c12', 2.2], [19, 6, '#f7b733', 2]])),
    ]
    case 'decsol': return [part('SKY_R', 'SKY_L', [-6, 0, 26, 21], 'center',
      `<path d="M10 0l2.4 7.6 7.6 2.4-7.6 2.4-2.4 7.6-2.4-7.6-7.6-2.4 7.6-2.4z" fill="#f3c74f" stroke="${INK}" stroke-width="1"/>`
      + dots([[-4, 4, '#fff6d6', 1.2], [24, 2, '#fff6d6', 1]]))]
    case 'junsol': {
      let rays = ''
      for (let i = 0; i < 8; i += 1) {
        const angle = (i * Math.PI) / 4
        const point = (r: number) => `${round(14 + Math.cos(angle) * r)} ${round(14 + Math.sin(angle) * r)}`
        rays += `<path d="M${point(10)}L${point(14)}" stroke="#f6c945" stroke-width="2" stroke-linecap="round"/>`
      }
      return [part('SKY_R', 'SKY_L', [-1, -1, 29, 29], 'center', `<circle cx="14" cy="14" r="8" fill="#f6c945" stroke="${INK}" stroke-width="1"/>${rays}`)]
    }
    case 'equinox': return [
      part('SKY_L', 'SKY_C', [0, 0, 14, 14], 'center', `<circle cx="7" cy="7" r="6" fill="#f6c945" stroke="${INK}" stroke-width="1"/>`),
      part('SKY_R', 'SKY_C', [1, -1, 22, 19], 'center', crescent(10, 10, '#f3e3a3')),
    ]
    case 'birthday': return [
      part('STRING', 'LEDGE_R', [-1.5, 0, 25.5, 14], 'top', bunting(['#e2b85e', '#a74732', '#dce9e3'])),
      part('SKY_C', 'SKY_L', [-1, -2, 35, 18], 'center', ([[2, 10, '#a74732'], [12, 2, '#e2b85e'], [30, 10, '#dce9e3'], [18, 6, '#a74732'], [24, 0, '#e2b85e'], [8, 14, '#dce9e3']] as const)
        .map(([x, y, fill]) => `<rect x="${x}" y="${y}" width="3" height="2" fill="${fill}" transform="rotate(25 ${x} ${y})"/>`).join('')),
      part('MAST', null, [0.5, 0, 10, 16.5], 'bottom', `<path d="M2 16.5V0" stroke="${INK}" stroke-width="1.2"/><path d="M2 .5l7 2.5-7 2.5z" fill="#e2b85e" stroke="${INK}" stroke-width=".8"/>`),
    ]
  }
}
