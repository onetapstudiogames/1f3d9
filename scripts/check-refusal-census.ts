import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { basename, relative, resolve } from 'node:path'
import * as ts from 'typescript'

export interface RefusalManifestRow {
  key: string
  disposition: 'included' | 'excluded'
  status: string
  finalText: string
  cause: 'Yes' | 'No' | 'n/a'
  next: 'Yes' | 'No' | 'n/a'
  causeEvidence: string
  nextEvidence: string
  producer: string
  adapter: string
  finalBoundary: string
  testProof: string
  exclusionReason: string
}

interface Candidate {
  key: string
  expressionKey: string
  finalText: string
  producer: string
  adapter: string
  status: string
  finalBoundary: string
  disposition: 'included' | 'excluded'
  exclusionReason: string
}

const MANIFEST_OPEN = '<!-- refusal-manifest:begin -->'
const MANIFEST_CLOSE = '<!-- refusal-manifest:end -->'
const UNRESOLVED_OPEN = '<!-- refusal-unresolved:begin -->'
const UNRESOLVED_CLOSE = '<!-- refusal-unresolved:end -->'
const IDENTITY_MODULES = new Set([
  'identity-browser.ts',
  'identity-store.ts',
  'oauth.ts',
  'oauth-store.ts',
  'oauth-recovery.ts',
  'oauth-diagnostics.ts',
  // Decision row 74: the JSON identity doors' own refusal helper (jsonError)
  // lives here and is exercised exhaustively by test/identity-api.test.ts;
  // identity-api.ts stays excluded the same way the other identity modules
  // above are. pair.ts, which calls that same exported jsonError rather than
  // defining its own refusal shape, is deliberately NOT excluded below (a
  // security-review fix) -- its refusals are covered by this census like any
  // other module's, via the jsonError entry in MESSAGE_HELPERS.
  'identity-api.ts',
])
const NON_BOUNDARY_MODULES = new Set([
  'window-client.ts',
  'window-style.ts',
  'credit-buy-page.ts',
  'credit-buy-return.ts',
  'credit-gift-redirect.ts',
])
const INTERNAL_ERROR_MESSAGE_ADAPTERS = new Set([
  'src/city-credit-purchase.ts:Error',
  'src/city-credit-purchase.ts:TypeError',
  'src/city-credit-recovery.ts:TypeError',
  'src/city-credit.ts:Error',
  'src/city-help.ts:Error',
  'src/community-tool-submissions.ts:Error',
  'src/community-tool-submissions.ts:TypeError',
  'src/core.ts:Error',
  'src/drawing-thumbnail.ts:Error',
  'src/db.ts:Error',
  'src/gazette-reading.ts:Error',
  'src/gazette-store.ts:Error',
  'src/gazette.ts:RangeError',
  'src/human-pages.ts:Error',
  'src/index.ts:Error',
  'src/later-holder.ts:Error',
  'src/oauth-config.ts:Error',
  'src/pay.ts:Error',
  'src/pay.ts:TypeError',
  'src/payment-attempts.ts:TypeError',
  'src/payment-recovery.ts:TypeError',
  'src/payment-sale-operations.ts:TypeError',
  'src/payment-treasury-operations.ts:TypeError',
  'src/paypal-credit-dispute.ts:TypeError',
  'src/paypal-credit-store.ts:TypeError',
  'src/paypal-credit.ts:Error',
  'src/place-permission.ts:Error',
  'src/public-changes.ts:Error',
  'src/public-directory.ts:Error',
  'src/public-live-survey.ts:Error',
  'src/public-map.ts:Error',
  'src/public-pagination.ts:Error',
  'src/public-residents.ts:Error',
  'src/public-search.ts:Error',
  'src/public-snapshot-format.ts:Error',
  'src/public-snapshot-format.ts:TypeError',
  'src/reading-cost.ts:Error',
  'src/refusal-text.ts:Error',
  'src/resident-refusal.ts:Error',
  'src/runtime-logs.ts:Error',
  'src/runtime-logs.ts:RangeError',
  'src/runtime-logs.ts:TypeError',
  'src/window-sharing.ts:Error',
  'src/window.ts:Error',
  'src/world-market.ts:Error',
])
const CALLER_ERROR_MESSAGE_ADAPTERS = new Map([
  [
    'src/prepaid-credit.ts:TypeError',
    { status: '400', adapter: 'prepaid-credit-routes conflictResponse TypeError adapter', boundary: 'HTTP 400 JSON; MCP forwarded tool result' },
  ],
  [
    'src/prepaid-credit.ts:PrepaidCreditConflictError',
    { status: '409', adapter: 'prepaid-credit-routes conflictResponse conflict adapter', boundary: 'HTTP 409 JSON; MCP forwarded tool result' },
  ],
  [
    'src/city-credit.ts:TypeError',
    { status: '400', adapter: 'founder city-credit TypeError adapter', boundary: 'HTTP 400 JSON; MCP forwarded tool result' },
  ],
  [
    'src/city-credit.ts:CityCreditConflictError',
    { status: '409', adapter: 'founder city-credit conflict adapter', boundary: 'HTTP 409 JSON; MCP forwarded tool result' },
  ],
])
const INTERNAL_EXPRESSION_REASONS = new Map<string, string>([
  ...[
    'expired city credit spend was not safely leased',
    'matching exact city credit deadline return is unavailable',
    'matching exact city credit spend could not be returned',
  ].map(text => [
    `src/city-credit-recovery.ts::${text}`,
    'Recovery/reconciliation control-flow conflict; its caller translates the condition instead of returning this text.',
  ] as const),
  ...[
    'USDC integer units must be a bigint',
    'city credit account is unavailable',
    'city credit attention is unavailable',
    'city credit attention time is invalid',
    'city credit balance is invalid',
    'city credit gift count is invalid',
    'city credit gift receipt id is invalid',
    'city credit history entry is invalid',
    'city credit history is unavailable',
    'city credit history kind is invalid',
    'city credit preflight balance is invalid',
    'city credit preflight resident is unavailable',
    'city credit preflight time is invalid',
    'city credit purchase receipt kind is invalid',
    'frozen city credit gift count is invalid',
    'pending city credit gift count is invalid',
  ].map(text => [
    `src/city-credit.ts::${text}`,
    'Read, preflight, or invariant failure; the global onError boundary replaces it with the generic 500 refusal.',
  ] as const),
  ['src/engine-effects.ts::invalid stored effect payload', 'Internal effect-resolution record, not a caller response.'],
  ...[
    'place lifecycle completion returned an invalid state',
    'place lifecycle completion returned an invalid status',
    'place lifecycle completion returned no response body',
  ].map(text => [
    `src/place-lifecycle-operation.ts::${text}`,
    'Internal lifecycle completion invariant; the world route replaces it with the caller-safe lifecycle failure.',
  ] as const),
  [
    'src/world.ts::place lifecycle transaction is unavailable',
    'Internal lifecycle transaction failure; the world route replaces it with the caller-safe lifecycle failure.',
  ],
  ...[
    'payment sale attempt is unavailable',
    'payment sale attempt has the wrong operation',
    'world sale payment attempt is unavailable',
    'sale payment target could not enter its terminal state',
    'invalid sale payment attempt is unavailable',
    'invalid sale payment terms do not match their target',
    'invalid sale target could not be synchronized',
    'sale payment could not be atomically invalidated',
  ].map(text => [
    `src/payment-sale-operations.ts::${text}`,
    'Internal sale-operation conflict; the route adapter translates the operation result instead of returning this text.',
  ] as const),
  ...[
    'treasury payment completion result is invalid',
    'treasury payment completion no longer owns this attempt lease',
  ].map(text => [
    `src/payment-treasury-operations.ts::${text}`,
    'Internal treasury completion conflict; the route adapter translates the operation result instead of returning this text.',
  ] as const),
  ...[
    'PayPal dispute evidence conflicts with durable credit history.',
    'PayPal dispute evidence did not produce one durable aggregate result.',
    'PayPal dispute evidence is bound to changed terms.',
    'Founder PayPal dispute review did not produce one durable result.',
    'Founder PayPal dispute review conflicts with durable credit history.',
  ].map(text => [
    `src/paypal-credit-dispute.ts::${text}`,
    'Internal PayPal credit-store conflict; the route adapter replaces it with a caller-safe refusal.',
  ] as const),
  ...['not_found', 'not_reviewable', 'decision_conflict'].map(text => [
    `src/paypal-credit-dispute.ts::${text}`,
    'Internal FounderPayPalDisputeResolutionError kind discriminator, not caller-visible message text.',
  ] as const),
  [
    'src/paypal-credit-dispute.ts::This PayPal dispute is not awaiting founder review. Nothing changed.',
    'The founder route replaces this not-reviewable constructor message with its separate audited caller refusal.',
  ],
  ...['invalid', 'unavailable', 'not_found'].map(text => [
    `src/world-market.ts::${text}`,
    'Internal MarketReadError kind discriminator; the world-market route returns a separate audited refusal.',
  ] as const),
])
const CALLER_EXPRESSION_ADAPTERS = new Map<string, { status: string; adapter: string; boundary: string }>([
  [
    'src/paypal-credit-dispute.ts::stored PayPal dispute ${label} is invalid; re-read the dispute, then ask the city operator to repair its stored record',
    { status: '400', adapter: 'founder PayPal dispute TypeError adapter', boundary: 'HTTP 400 JSON' },
  ],
])
const MESSAGE_HELPERS = new Map<string, number>([
  ['failure', 1],
  ['err', 2],
  ['rpcError', 4],
  ['classifiedErrorText', 0],
  // Decision row 74 security fix: identity-api.ts's exported jsonError(c,
  // status, reason, message, nextStep) is the shared refusal shape pair.ts
  // now calls too; this lets the census reach pair.ts's call sites (the
  // module the definition itself lives in stays excluded, see
  // IDENTITY_MODULES above, so this never doubles up on identity-api.ts).
  ['jsonError', 3],
])
const IDENTITY_PATHS = new Set(['/join', '/rotate', '/recovery', '/api/register'])

function sourceFiles(projectRoot: URL): string[] {
  const src = fileURLToPath(new URL('src/', projectRoot))
  return readdirSync(src, { recursive: true })
    .map(entry => String(entry).replaceAll('\\', '/'))
    .filter(entry => entry.endsWith('.ts'))
    .filter(entry => !IDENTITY_MODULES.has(basename(entry)))
    .filter(entry => !NON_BOUNDARY_MODULES.has(basename(entry)))
    .map(entry => resolve(src, entry))
    .sort()
}

function normalizedExpression(node: ts.Expression, source: ts.SourceFile): string {
  const raw = node.getText(source).replace(/\s+/gu, ' ').trim()
  if (
    (raw.startsWith("'") && raw.endsWith("'"))
    || (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith('`') && raw.endsWith('`'))
  ) return raw.slice(1, -1).replaceAll('\\|', '|')
  return raw
}

type Substitutions = ReadonlyMap<string, ts.Expression>

function symbolDeclaration(node: ts.Node, checker: ts.TypeChecker): ts.Declaration | undefined {
  let symbol = checker.getSymbolAtLocation(node)
  if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
  return symbol?.declarations?.[0]
}

function isConstDeclaration(node: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(node.parent)
    && (node.parent.flags & ts.NodeFlags.Const) !== 0
}

type StaticFunctionDeclaration = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration

function staticFunctionDeclaration(
  declaration: ts.Declaration | undefined,
): StaticFunctionDeclaration | null {
  if (
    declaration
    && ts.isVariableDeclaration(declaration)
    && declaration.initializer
    && isConstDeclaration(declaration)
    && (ts.isFunctionExpression(declaration.initializer) || ts.isArrowFunction(declaration.initializer))
  ) return declaration.initializer
  if (
    declaration
    && (
      ts.isFunctionDeclaration(declaration)
      || ts.isFunctionExpression(declaration)
      || ts.isArrowFunction(declaration)
      || ts.isMethodDeclaration(declaration)
    )
  ) return declaration
  return null
}

function callableDeclaration(
  node: ts.Expression,
  checker: ts.TypeChecker,
): StaticFunctionDeclaration | null {
  return staticFunctionDeclaration(symbolDeclaration(node, checker))
}

function collectThrownValueBuilders(
  node: ts.Expression,
  checker: ts.TypeChecker,
  builders: Set<StaticFunctionDeclaration>,
  seen: Set<ts.Node>,
): void {
  if (seen.has(node)) return
  seen.add(node)
  if (
    ts.isParenthesizedExpression(node)
    || ts.isAsExpression(node)
    || ts.isSatisfiesExpression(node)
    || ts.isNonNullExpression(node)
  ) {
    collectThrownValueBuilders(node.expression, checker, builders, seen)
    return
  }
  if (ts.isIdentifier(node)) {
    const declaration = symbolDeclaration(node, checker)
    if (
      declaration
      && ts.isVariableDeclaration(declaration)
      && declaration.initializer
      && isConstDeclaration(declaration)
    ) collectThrownValueBuilders(declaration.initializer, checker, builders, seen)
    return
  }
  if (ts.isConditionalExpression(node)) {
    collectThrownValueBuilders(node.whenTrue, checker, builders, seen)
    collectThrownValueBuilders(node.whenFalse, checker, builders, seen)
    return
  }
  if (
    ts.isBinaryExpression(node)
    && (
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      || node.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    )
  ) {
    collectThrownValueBuilders(node.left, checker, builders, seen)
    collectThrownValueBuilders(node.right, checker, builders, seen)
    return
  }
  if (ts.isCallExpression(node)) {
    const declaration = callableDeclaration(node.expression, checker)
    if (declaration) builders.add(declaration)
  }
}

function functionsCalledFromThrowExpressions(
  files: readonly string[],
  program: ts.Program,
  checker: ts.TypeChecker,
): ReadonlySet<StaticFunctionDeclaration> {
  const builders = new Set<StaticFunctionDeclaration>()
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) continue
    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node) && node.expression) {
        collectThrownValueBuilders(node.expression, checker, builders, new Set())
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return builders
}

function returnExpressions(node: StaticFunctionDeclaration): ts.Expression[] {
  if (!node.body) return []
  if (!ts.isBlock(node.body)) return [node.body]
  const expressions: ts.Expression[] = []
  const visit = (child: ts.Node): void => {
    if (child !== node.body && ts.isFunctionLike(child)) return
    if (ts.isReturnStatement(child) && child.expression) expressions.push(child.expression)
    else ts.forEachChild(child, visit)
  }
  visit(node.body)
  return expressions
}

function returnedTypedErrorCreations(
  node: StaticFunctionDeclaration,
  checker: ts.TypeChecker,
): ts.NewExpression[] {
  const creations: ts.NewExpression[] = []
  const seen = new Set<ts.Node>()
  const visit = (expression: ts.Expression): void => {
    if (seen.has(expression)) return
    seen.add(expression)
    if (ts.isNewExpression(expression)) {
      const className = expression.expression.getText(expression.getSourceFile())
      if (className === 'EngineError' || className === 'RouteFailure') creations.push(expression)
      return
    }
    if (
      ts.isParenthesizedExpression(expression)
      || ts.isAsExpression(expression)
      || ts.isSatisfiesExpression(expression)
      || ts.isNonNullExpression(expression)
    ) {
      visit(expression.expression)
      return
    }
    if (ts.isIdentifier(expression)) {
      const declaration = symbolDeclaration(expression, checker)
      if (
        declaration
        && ts.isVariableDeclaration(declaration)
        && declaration.initializer
        && isConstDeclaration(declaration)
      ) visit(declaration.initializer)
      return
    }
    if (ts.isConditionalExpression(expression)) {
      visit(expression.whenTrue)
      visit(expression.whenFalse)
      return
    }
    if (
      ts.isBinaryExpression(expression)
      && (
        expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      )
    ) {
      visit(expression.left)
      visit(expression.right)
    }
  }
  for (const expression of returnExpressions(node)) visit(expression)
  return creations
}

function resolveStaticTexts(
  node: ts.Expression,
  checker: ts.TypeChecker,
  substitutions: Substitutions = new Map(),
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const source = node.getSourceFile()
  const seenKey = `${source.fileName}:${node.pos}:${node.end}`
  if (seen.has(seenKey)) return []
  const nextSeen = new Set(seen).add(seenKey)
  const unique = (values: string[]): string[] => [...new Set(values)]

  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text]
  if (ts.isNumericLiteral(node)) return [node.text]
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return resolveStaticTexts(node.expression, checker, substitutions, nextSeen)
  }
  if (ts.isIdentifier(node)) {
    const substituted = substitutions.get(node.text)
    if (substituted) return resolveStaticTexts(substituted, checker, substitutions, nextSeen)
    const declaration = symbolDeclaration(node, checker)
    if (declaration && ts.isVariableDeclaration(declaration) && declaration.initializer && isConstDeclaration(declaration)) {
      return resolveStaticTexts(declaration.initializer, checker, substitutions, nextSeen)
    }
    if (declaration && ts.isPropertyAssignment(declaration)) {
      return resolveStaticTexts(declaration.initializer, checker, substitutions, nextSeen)
    }
    return []
  }
  if (ts.isPropertyAccessExpression(node)) {
    const declaration = symbolDeclaration(node.name, checker)
    if (declaration && ts.isPropertyAssignment(declaration)) {
      return resolveStaticTexts(declaration.initializer, checker, substitutions, nextSeen)
    }
    return []
  }
  if (ts.isConditionalExpression(node)) {
    const whenTrue = resolveStaticTexts(node.whenTrue, checker, substitutions, nextSeen)
    const whenFalse = resolveStaticTexts(node.whenFalse, checker, substitutions, nextSeen)
    if (node.whenTrue.kind === ts.SyntaxKind.NullKeyword || node.whenTrue.kind === ts.SyntaxKind.UndefinedKeyword) return whenFalse
    if (node.whenFalse.kind === ts.SyntaxKind.NullKeyword || node.whenFalse.kind === ts.SyntaxKind.UndefinedKeyword) return whenTrue
    return whenTrue.length > 0 && whenFalse.length > 0 ? unique([...whenTrue, ...whenFalse]) : []
  }
  if (ts.isBinaryExpression(node)) {
    const left = resolveStaticTexts(node.left, checker, substitutions, nextSeen)
    const right = resolveStaticTexts(node.right, checker, substitutions, nextSeen)
    const operator = node.operatorToken.kind
    if (operator === ts.SyntaxKind.PlusToken) {
      const numeric = (checker.getTypeAtLocation(node).flags & ts.TypeFlags.NumberLike) !== 0
      if (numeric && (left.length === 0 || right.length === 0)) return []
      const leftValues = left.length === 1
        ? left
        : [`\${${normalizedExpression(node.left, node.left.getSourceFile())}}`]
      const rightValues = right.length === 1
        ? right
        : [`\${${normalizedExpression(node.right, node.right.getSourceFile())}}`]
      return unique(leftValues.flatMap(prefix => rightValues.map(suffix => (
        numeric ? String(Number(prefix) + Number(suffix)) : `${prefix}${suffix}`
      ))))
    }
    const operation = operator === ts.SyntaxKind.AsteriskToken
      ? (a: number, b: number) => a * b
      : operator === ts.SyntaxKind.SlashToken
        ? (a: number, b: number) => a / b
        : operator === ts.SyntaxKind.MinusToken
          ? (a: number, b: number) => a - b
          : null
    if (operation) {
      return unique(left.flatMap(a => right.map(b => String(operation(Number(a), Number(b))))))
    }
    return []
  }
  if (ts.isTemplateExpression(node)) {
    let rendered = [node.head.text]
    for (const span of node.templateSpans) {
      const resolved = resolveStaticTexts(span.expression, checker, substitutions, nextSeen)
      const values = resolved.length === 1
        ? resolved
        : [`\${${normalizedExpression(span.expression, span.expression.getSourceFile())}}`]
      rendered = rendered.flatMap(prefix => values.map(value => `${prefix}${value}${span.literal.text}`))
    }
    return unique(rendered)
  }
  if (ts.isCallExpression(node)) {
    const replacePattern = node.arguments[0]
    const replaceValue = node.arguments[1]
    if (
      ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'replace'
      && replacePattern
      && replaceValue
      && ts.isRegularExpressionLiteral(replacePattern)
      && ts.isStringLiteralLike(replaceValue)
    ) {
      const match = /^\/(.*)\/([a-z]*)$/u.exec(replacePattern.text)
      const patternSource = match?.[1]
      const patternFlags = match?.[2]
      if (patternSource !== undefined && patternFlags !== undefined) {
        const pattern = new RegExp(patternSource, patternFlags)
        return resolveStaticTexts(node.expression.expression, checker, substitutions, nextSeen)
          .map(value => value.replace(pattern, replaceValue.text))
      }
    }
    const callable = callableDeclaration(node.expression, checker)
    if (callable) {
      const callSubstitutions = new Map(substitutions)
      callable.parameters.forEach((parameter, index) => {
        if (ts.isIdentifier(parameter.name) && node.arguments[index]) {
          callSubstitutions.set(parameter.name.text, node.arguments[index])
        } else if (ts.isIdentifier(parameter.name) && parameter.initializer) {
          callSubstitutions.set(parameter.name.text, parameter.initializer)
        }
      })
      const rendered: string[] = []
      for (const expression of returnExpressions(callable)) {
        if (expression.kind === ts.SyntaxKind.NullKeyword || expression.kind === ts.SyntaxKind.UndefinedKeyword) continue
        const values = resolveStaticTexts(expression, checker, callSubstitutions, nextSeen)
        if (values.length === 0) return []
        rendered.push(...values)
      }
      return unique(rendered)
    }
  }
  return []
}

interface LocalBoundaryHelper {
  messageArgument: number
  statusArgument: number
}

function localBoundaryHelpers(source: ts.SourceFile): Map<string, LocalBoundaryHelper> {
  const helpers = new Map<string, LocalBoundaryHelper>()
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const parameters = node.parameters.map(parameter => (
        ts.isIdentifier(parameter.name) ? parameter.name.text : ''
      ))
      const inspect = (child: ts.Node): void => {
        const message = ts.isCallExpression(child) ? child.arguments[0] : undefined
        const status = ts.isCallExpression(child) ? child.arguments[1] : undefined
        if (
          ts.isCallExpression(child)
          && ts.isPropertyAccessExpression(child.expression)
          && child.expression.name.text === 'text'
          && message
          && status
          && ts.isIdentifier(message)
          && ts.isIdentifier(status)
        ) {
          const messageArgument = parameters.indexOf(message.text)
          const statusArgument = parameters.indexOf(status.text)
          if (messageArgument >= 0 && statusArgument >= 0) {
            helpers.set(node.name!.text, { messageArgument, statusArgument })
          }
        }
        if (child !== node.body && ts.isFunctionLike(child)) return
        ts.forEachChild(child, inspect)
      }
      inspect(node.body)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return helpers
}

function mayResolveToString(node: ts.Expression, checker: ts.TypeChecker): boolean {
  const type = checker.getTypeAtLocation(node)
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike)) !== 0) return true
  return type.isUnion() && type.types.some(member => (
    (member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.StringLike)) !== 0
  ))
}

function exactStatus(node: ts.Node | undefined, source: ts.SourceFile): string {
  if (node && ts.isNumericLiteral(node)) return node.text
  return node && ts.isExpression(node)
    ? `expression:${normalizedExpression(node, source)}`
    : 'expression:adapter default'
}

function propertyName(node: ts.ObjectLiteralElementLike): string | null {
  if (!('name' in node) || !node.name) return null
  if (ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)) return node.name.text
  return null
}

function enclosingObjectStatus(node: ts.Node, source: ts.SourceFile): string {
  const object = node.parent && ts.isObjectLiteralExpression(node.parent) ? node.parent : null
  if (object) {
    const status = object.properties.find(property => propertyName(property) === 'status')
    if (status && ts.isPropertyAssignment(status)) return exactStatus(status.initializer, source)
  }
  let current: ts.Node | undefined = node.parent
  while (current && !ts.isFunctionLike(current)) {
    if (
      ts.isCallExpression(current)
      && ts.isPropertyAccessExpression(current.expression)
      && current.expression.name.text === 'json'
      && current.arguments[0]
      && node.pos >= current.arguments[0].pos
      && node.end <= current.arguments[0].end
    ) return current.arguments[1] ? exactStatus(current.arguments[1], source) : '200'
    current = current.parent
  }
  return 'expression:typed adapter status'
}

function templateSegments(text: string): string[] {
  return text.split(/\$\{[^}]+\}/gu).map(value => value.trim()).filter(value => value.length >= 8)
}

function assertedCallTexts(testFile: string): string[] {
  const source = ts.createSourceFile(testFile, readFileSync(testFile, 'utf8'), ts.ScriptTarget.Latest, true)
  const calls: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source)
      if (/^(?:assert|assert\.)/u.test(expression)) calls.push(node.getText(source))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return calls
}

const proofIndexCache = new Map<string, Array<{ file: string; calls: string[] }>>()

function proofIndex(projectRoot: URL): Array<{ file: string; calls: string[] }> {
  const cacheKey = projectRoot.href
  const cached = proofIndexCache.get(cacheKey)
  if (cached) return cached
  const testRoot = fileURLToPath(new URL('test/', projectRoot))
  const indexed = readdirSync(testRoot, { recursive: true })
    .map(entry => resolve(testRoot, String(entry)))
    .filter(file => file.endsWith('.test.ts'))
    .map(file => ({ file, calls: assertedCallTexts(file) }))
  proofIndexCache.set(cacheKey, indexed)
  return indexed
}

function scanCandidates(projectRoot: URL): { candidates: Candidate[]; unresolved: string[] } {
  const provisional: Omit<Candidate, 'key'>[] = []
  const unresolvedExpressions: string[] = []
  const files = sourceFiles(projectRoot)
  const program = ts.createProgram({
    rootNames: files,
    options: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    },
  })
  const checker = program.getTypeChecker()
  const thrownBuilders = functionsCalledFromThrowExpressions(files, program, checker)
  for (const file of files) {
    const source = program.getSourceFile(file)
    if (!source) throw new Error(`refusal census could not parse ${file}`)
    const relativeFile = relative(fileURLToPath(projectRoot), file).replaceAll('\\', '/')
    const localHelpers = localBoundaryHelpers(source)

    const add = (
      message: ts.Expression,
      adapter: string,
      status = 'dynamic',
      disposition: Candidate['disposition'] = 'included',
      finalBoundary = 'HTTP JSON; MCP forwarded tool result',
      exclusionReason = '',
    ) => {
      const resolvedTexts = resolveStaticTexts(message, checker)
      if (resolvedTexts.length === 0 && mayResolveToString(message, checker)) {
        unresolvedExpressions.push(`${relativeFile}::${normalizedExpression(message, source)}`)
      }
      for (const finalText of resolvedTexts) {
        const expressionOverrideKey = `${relativeFile}::${finalText}`
        const internalReason = INTERNAL_EXPRESSION_REASONS.get(expressionOverrideKey)
        const callerOverride = CALLER_EXPRESSION_ADAPTERS.get(expressionOverrideKey)
        provisional.push({
          expressionKey: finalText,
          finalText,
          producer: relativeFile,
          adapter: callerOverride?.adapter ?? (internalReason ? 'internal control-flow/storage adapter' : adapter),
          status: callerOverride?.status ?? (internalReason ? 'n/a' : status),
          finalBoundary: callerOverride?.boundary ?? (internalReason ? 'not returned at a caller boundary' : finalBoundary),
          disposition: callerOverride ? 'included' : internalReason ? 'excluded' : disposition,
          exclusionReason: callerOverride ? '' : internalReason ?? exclusionReason,
        })
      }
    }

    for (const builder of thrownBuilders) {
      if (builder.getSourceFile() !== source) continue
      for (const creation of returnedTypedErrorCreations(builder, checker)) {
        const className = creation.expression.getText(source)
        const message = creation.arguments?.[1]
        if (message) {
          add(
            message,
            `${className} returned builder adapter`,
            exactStatus(creation.arguments?.[0], source),
          )
        }
      }
    }

    const visit = (node: ts.Node): void => {
      if (ts.isThrowStatement(node) && node.expression && ts.isNewExpression(node.expression)) {
        const creation = node.expression
        const className = creation.expression.getText(source)
        const statusFirst = className === 'EngineError'
          || className === 'RouteFailure'
          || className === 'PayPalWebhookApplicationError'
        const message = creation.arguments?.[statusFirst ? 1 : 0]
        if (message) {
          const callerAdapter = CALLER_ERROR_MESSAGE_ADAPTERS.get(`${relativeFile}:${className}`)
          const internal = INTERNAL_ERROR_MESSAGE_ADAPTERS.has(`${relativeFile}:${className}`)
          add(
            message,
            callerAdapter?.adapter ?? (internal ? 'generic HTTP error adapter' : `${className} typed adapter`),
            callerAdapter?.status ?? (statusFirst ? exactStatus(creation.arguments?.[0], source) : 'expression:typed adapter status'),
            internal ? 'excluded' : 'included',
            callerAdapter?.boundary ?? (internal ? 'HTTP onError -> 500 JSON' : 'HTTP JSON; MCP forwarded tool result'),
            internal
              ? 'Internal parser, storage, or invariant throw; if uncaught, onError replaces it with the generic 500 refusal.'
              : '',
          )
        }
        if (className === 'FounderPayPalDisputeResolutionError') {
          const callerMessage = creation.arguments?.[1]
          if (callerMessage) {
            add(
              callerMessage,
              'founder PayPal dispute resolution adapter',
              'expression:kind-specific status',
              'included',
              'HTTP JSON',
            )
          }
        }
      }

      if (ts.isPropertyAssignment(node) && propertyName(node) === 'error') {
        add(node.initializer, 'typed result/JSON error adapter', enclosingObjectStatus(node, source))
      }

      if (ts.isCallExpression(node)) {
        const callName = ts.isIdentifier(node.expression)
          ? node.expression.text
          : ts.isPropertyAccessExpression(node.expression)
            ? node.expression.name.text
            : ''
        const helperArgument = MESSAGE_HELPERS.get(callName)
        if (helperArgument !== undefined) {
          const message = node.arguments[helperArgument]
          if (message) {
            const status = callName === 'err' || callName === 'jsonError'
              ? exactStatus(node.arguments[1], source)
              : callName === 'failure'
                ? exactStatus(node.arguments[0], source)
                : callName === 'rpcError' || callName === 'classifiedErrorText'
                  ? '200'
                  : 'expression:helper adapter status'
            const boundary = callName === 'rpcError' || callName === 'classifiedErrorText'
              ? 'MCP JSON-RPC/tool result'
              : 'HTTP JSON; MCP forwarded tool result'
            add(message, `${callName} helper adapter`, status, 'included', boundary)
          }
        }
        const localHelper = localHelpers.get(callName)
        if (localHelper) {
          const message = node.arguments[localHelper.messageArgument]
          const statusNode = node.arguments[localHelper.statusArgument]
          if (message) {
            add(
              message,
              `${callName} local HTTP text adapter`,
              exactStatus(statusNode, source),
              'included',
              'HTTP text',
            )
          }
        }
        if (callName === 'text' && node.arguments[1]) {
          const status = exactStatus(node.arguments[1], source)
          const message = node.arguments[0]
          if (message && /^\d{3}$/u.test(status) && Number(status) >= 400) {
            add(message, 'direct HTTP text adapter', status, 'included', 'HTTP text')
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }

  const seen = new Map<string, number>()
  const candidates = provisional.map(candidate => {
    const expressionKey = `${candidate.producer}::${candidate.expressionKey}`
    const ordinal = (seen.get(expressionKey) ?? 0) + 1
    seen.set(expressionKey, ordinal)
    return { ...candidate, key: `${expressionKey}::${ordinal}` }
  })
  const unresolvedSeen = new Map<string, number>()
  const unresolved = unresolvedExpressions.map(expression => {
    const ordinal = (unresolvedSeen.get(expression) ?? 0) + 1
    unresolvedSeen.set(expression, ordinal)
    return `${expression}::${ordinal}`
  })
  return { candidates, unresolved }
}

export function discoverCandidates(projectRoot: URL): Candidate[] {
  return scanCandidates(projectRoot).candidates
}

export function discoverUnresolvedProducers(projectRoot: URL): string[] {
  return scanCandidates(projectRoot).unresolved
}

export function discoverHttpBoundaries(projectRoot: URL): {
  registrations: string[]
  globals: string[]
} {
  const registrations: string[] = []
  for (const file of sourceFiles(projectRoot)) {
    const text = readFileSync(file, 'utf8')
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
    const relativeFile = relative(fileURLToPath(projectRoot), file).replaceAll('\\', '/')
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const receiver = node.expression.expression
        if (
          ts.isIdentifier(receiver)
          && (receiver.text === 'app' || receiver.text === 'router')
          && ['get', 'post', 'put', 'patch', 'delete', 'all'].includes(method)
        ) {
          const path = node.arguments[0]
          const pathText = path && ts.isStringLiteralLike(path)
            ? path.text
            : path?.getText(source) ?? '<missing>'
          if (!(relativeFile === 'src/index.ts' && IDENTITY_PATHS.has(pathText))) {
            registrations.push(`${method.toUpperCase()} ${pathText} (${relativeFile})`)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return { registrations: registrations.sort(), globals: ['onError', 'notFound'] }
}

export function discoverMcpBoundaries(projectRoot: URL): {
  tools: string[]
  protocol: string[]
} {
  const file = fileURLToPath(new URL('src/mcp.ts', projectRoot))
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const tools: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node)
      && propertyName(node) === 'name'
      && ts.isStringLiteralLike(node.initializer)
    ) {
      let current: ts.Node | undefined = node.parent
      while (current && !ts.isVariableDeclaration(current)) current = current.parent
      if (current && ts.isIdentifier(current.name) && current.name.text === 'TOOLS') {
        tools.push(node.initializer.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return {
    tools,
    protocol: [
      'invalid-json',
      'invalid-message',
      'initialize',
      'ping',
      'tools/list',
      'method-not-found',
      'tool-not-found',
      'tool-arguments',
      'tool-forwarded-response',
    ],
  }
}

export function parseRefusalManifest(auditText: string): RefusalManifestRow[] {
  const start = auditText.indexOf(MANIFEST_OPEN)
  const end = auditText.indexOf(MANIFEST_CLOSE)
  if (start < 0 || end < start) return []
  return auditText
    .slice(start + MANIFEST_OPEN.length, end)
    .split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as RefusalManifestRow)
}

export function parseUnresolvedProducers(auditText: string): string[] {
  const start = auditText.indexOf(UNRESOLVED_OPEN)
  const end = auditText.indexOf(UNRESOLVED_CLOSE)
  if (start < 0 || end < start) return []
  return auditText
    .slice(start + UNRESOLVED_OPEN.length, end)
    .split(/\r?\n/u)
    .map(line => /^- `(.+)`$/u.exec(line.trim())?.[1])
    .filter((value): value is string => value !== undefined)
}

export function auditRefusalCensus(projectRoot: URL, auditText: string): {
  errors: string[]
  candidateKeys: Set<string>
  manifestKeys: Set<string>
} {
  const scan = scanCandidates(projectRoot)
  const candidates = scan.candidates
  const manifest = parseRefusalManifest(auditText)
  const candidateKeys = new Set(candidates.map(row => row.key))
  const manifestKeys = new Set(manifest.map(row => row.key))
  const errors: string[] = []
  const candidateByKey = new Map(candidates.map(row => [row.key, row]))
  for (const key of candidateKeys) if (!manifestKeys.has(key)) errors.push(`missing manifest row: ${key}`)
  for (const key of manifestKeys) if (!candidateKeys.has(key)) errors.push(`stale manifest row: ${key}`)
  if (manifestKeys.size !== manifest.length) errors.push('duplicate manifest key')
  const documentedUnresolved = parseUnresolvedProducers(auditText)
  const actualUnresolvedKeys = new Set(scan.unresolved)
  const documentedUnresolvedKeys = new Set(documentedUnresolved)
  for (const key of actualUnresolvedKeys) {
    if (!documentedUnresolvedKeys.has(key)) errors.push(`missing unresolved producer: ${key}`)
  }
  for (const key of documentedUnresolvedKeys) {
    if (!actualUnresolvedKeys.has(key)) errors.push(`stale unresolved producer: ${key}`)
  }
  if (documentedUnresolvedKeys.size !== documentedUnresolved.length) errors.push('duplicate unresolved producer')
  const proofFiles = new Map(proofIndex(projectRoot).map(entry => [
    relative(fileURLToPath(projectRoot), entry.file).replaceAll('\\', '/'),
    entry.calls,
  ]))
  for (const row of manifest) {
    const candidate = candidateByKey.get(row.key)
    if (!candidate) continue
    const expected = {
      disposition: candidate.disposition,
      status: candidate.status,
      finalText: candidate.finalText,
      producer: candidate.producer,
      adapter: candidate.adapter,
      finalBoundary: candidate.finalBoundary,
      exclusionReason: candidate.exclusionReason,
    }
    for (const [field, value] of Object.entries(expected)) {
      if (row[field as keyof RefusalManifestRow] !== value) {
        errors.push(`${row.key}: stale ${field}`)
      }
    }
    if (row.disposition === 'included') {
      if (row.cause !== 'Yes' && row.cause !== 'No') errors.push(`${row.key}: cause is not reviewed`)
      if (row.next !== 'Yes' && row.next !== 'No') errors.push(`${row.key}: next is not reviewed`)
      for (const [name, evidence] of [
        ['cause', row.causeEvidence],
        ['next', row.nextEvidence],
      ] as const) {
        if (row[name] === 'Yes') {
          if (!evidence || !row.finalText.includes(evidence)) errors.push(`${row.key}: ${name} evidence is not literal`)
          if (evidence === row.finalText) errors.push(`${row.key}: ${name} evidence repeats the full text`)
        } else if (evidence !== '') {
          errors.push(`${row.key}: ${name} evidence must be empty when classified No`)
        }
      }
      if (row.cause === 'Yes' && row.next === 'Yes' && row.causeEvidence === row.nextEvidence) {
        errors.push(`${row.key}: cause and next evidence are identical`)
      }
      if (row.testProof.startsWith('assertion:')) {
        const testFile = row.testProof.slice('assertion:'.length)
        const calls = proofFiles.get(testFile)
        if (!calls) {
          errors.push(`${row.key}: claimed assertion file does not exist: ${testFile}`)
        } else {
          const segments = templateSegments(row.finalText)
          const required = segments.length > 0 ? segments : [row.finalText]
          if (!required.every(segment => calls.some(call => call.includes(segment)))) {
            errors.push(`${row.key}: final text is not present in a real assertion in ${testFile}`)
          }
        }
      } else if (!row.testProof.startsWith('structural:')) {
        errors.push(`${row.key}: test proof must be assertion: or structural:`)
      }
    } else if (!row.testProof.startsWith('structural:')) {
      errors.push(`${row.key}: internal exclusion needs structural proof`)
    }
  }
  return { errors, candidateKeys, manifestKeys }
}

function main(): void {
  const projectRoot = pathToFileURL(`${resolve(fileURLToPath(new URL('../', import.meta.url)))}\\`)
  const auditUrl = new URL('docs/audits/2026-09-refusal-census.md', projectRoot)
  const result = auditRefusalCensus(projectRoot, readFileSync(auditUrl, 'utf8'))
  if (result.errors.length > 0) {
    console.error(result.errors.join('\n'))
    process.exitCode = 1
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main()
