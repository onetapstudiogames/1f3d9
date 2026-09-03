import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'

export interface WriterSource {
  readonly path: string
  readonly source: string
}

export interface WriterField {
  readonly field: string
  readonly location: string
}

export interface WriterScan {
  readonly fields: readonly WriterField[]
  readonly writerCount: number
}

interface SqlContext {
  readonly path: string
  readonly sourceFile: ts.SourceFile | null
  readonly expressions: readonly ts.Expression[]
  readonly baseLine: number
}

interface Segment {
  readonly text: string
  readonly start: number
}

const INSERT_EVENT_RE = /\bINSERT\s+INTO\s+(ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)(?=\s|\()/giu
const JSON_OBJECT_RE = /\bjsonb_build_object\s*\(/giu
const EXPRESSION_RE = /^__TS_EXPR_(\d+)__$/u

function hasEventWrite(text: string): boolean {
  const sql = maskSqlComments(text)
  return /\bINSERT\s+INTO\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)(?=\s|\()/iu.test(sql)
    || /\b(?:UPDATE\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)|MERGE\s+INTO\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)|COPY\s+(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events))\b/iu.test(sql)
    || /\bNEW\s*\.\s*"?detail"?(?:\s*\[[^\]]+\])*\s*(?::=|=)/iu.test(sql)
    || /\bINTO\s+NEW\s*\.\s*"?detail"?(?:\s*\[[^\]]+\])*/iu.test(sql)
    || eventTrigger(sql) !== null
}

function maskSqlComments(text: string): string {
  let masked = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (character === "'") {
      masked += character
      if (quoted && text[index + 1] === "'") {
        masked += "'"
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (!quoted && text.startsWith('--', index)) {
      while (index < text.length && text[index] !== '\n') {
        masked += ' '
        index += 1
      }
      if (index < text.length) masked += '\n'
      continue
    }
    if (!quoted && text.startsWith('/*', index)) {
      masked += '  '
      index += 2
      while (index < text.length && !text.startsWith('*/', index)) {
        masked += text[index] === '\n' ? '\n' : ' '
        index += 1
      }
      if (index < text.length) {
        masked += '  '
        index += 1
      }
      continue
    }
    masked += character
  }
  return masked
}

function eventTrigger(sql: string): RegExpExecArray | null {
  return /\bCREATE\s+(?:(?:OR\s+REPLACE|CONSTRAINT)\s+)?TRIGGER\b(?:(?!;)[\s\S])*?\b(?:BEFORE|INSTEAD\s+OF)\s+(?:(?:UPDATE|DELETE|TRUNCATE)\s+OR\s+)*INSERT\b(?:(?!;)[\s\S])*?\bON\s+(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)(?=\s|;|$)/iu.exec(sql)
}

function lineAt(text: string, index: number, baseLine: number): number {
  return baseLine + (text.slice(0, index).match(/\n/gu)?.length ?? 0)
}

function failure(context: SqlContext, sql: string, index: number, detail: string): never {
  throw new Error(
    `unknown event-detail writer shape at ${context.path}:${lineAt(sql, index, context.baseLine)}: `
      + `${detail}; classify it or extend the scanner before changing live event detail`,
  )
}

function balanced(text: string, openIndex: number): { contentStart: number; closeIndex: number } {
  let depth = 0
  let quoted = false
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text[index]
    if (character === "'") {
      if (quoted && text[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') {
      depth -= 1
      if (depth === 0) return { contentStart: openIndex + 1, closeIndex: index }
    }
  }
  throw new Error(`unclosed SQL parenthesis at offset ${openIndex}`)
}

function splitTopLevel(text: string): readonly Segment[] {
  const segments: Segment[] = []
  let start = 0
  let depth = 0
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (character === "'") {
      if (quoted && text[index + 1] === "'") {
        index += 1
      } else {
        quoted = !quoted
      }
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (character === ',' && depth === 0) {
      segments.push({ text: text.slice(start, index), start })
      start = index + 1
    }
  }
  segments.push({ text: text.slice(start), start })
  return segments
}

function topLevelWord(text: string, start: number, word: string): number {
  let depth = 0
  let quoted = false
  for (let index = start; index <= text.length - word.length; index += 1) {
    const character = text[index]
    if (character === "'") {
      if (quoted && text[index + 1] === "'") index += 1
      else quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (depth !== 0 || text.slice(index, index + word.length).toUpperCase() !== word) continue
    const before = text[index - 1] ?? ' '
    const after = text[index + word.length] ?? ' '
    if (!/[A-Za-z0-9_]/u.test(before) && !/[A-Za-z0-9_]/u.test(after)) return index
  }
  return -1
}

function topLevelPhrase(text: string, start: number, phrase: RegExp): number {
  let depth = 0
  let quoted = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (character === "'") {
      if (quoted && text[index + 1] === "'") index += 1
      else quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === '(') depth += 1
    if (character === ')') {
      if (depth === 0) return -1
      depth -= 1
      continue
    }
    if (character === ';' && depth === 0) return -1
    if (depth === 0 && phrase.test(text.slice(index))) return index
  }
  return -1
}

function skipSqlTrivia(text: string, start: number): number {
  let index = start
  while (index < text.length) {
    if (/\s/u.test(text[index]!)) {
      index += 1
      continue
    }
    if (text.startsWith('--', index)) {
      const end = text.indexOf('\n', index + 2)
      index = end < 0 ? text.length : end + 1
      continue
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) return text.length
      index = end + 2
      continue
    }
    break
  }
  return index
}

function sqlIdentifier(value: string): string | null {
  const identifier = value.trim()
  const quoted = /^"((?:[^"]|"")+)"$/u.exec(identifier)
  if (quoted) return quoted[1]!.replaceAll('""', '"').toLowerCase()
  return /^[a-z_][a-z0-9_]*$/iu.test(identifier) ? identifier.toLowerCase() : null
}

function propertyName(name: ts.PropertyName, context: SqlContext): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text
  const sourceFile = context.sourceFile
  const location = sourceFile
    ? `${context.path}:${sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile)).line + 1}`
    : context.path
  throw new Error(
    `unknown event-detail writer shape at ${location}: computed TypeScript property; `
      + 'classify it or extend the scanner before changing live event detail',
  )
}

function tsField(name: ts.PropertyName, context: SqlContext): WriterField {
  const sourceFile = context.sourceFile
  if (!sourceFile) throw new Error('TypeScript field resolution requires a source file')
  return {
    field: propertyName(name, context),
    location: `${context.path}:${sourceFile.getLineAndCharacterOfPosition(name.getStart(sourceFile)).line + 1}`,
  }
}

function findVariables(
  sourceFile: ts.SourceFile,
  name: string,
  before: number,
): readonly ts.VariableDeclaration[] {
  const found: ts.VariableDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (node.getStart(sourceFile) >= before) return
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.name.text === name && node.initializer) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function findFunctions(sourceFile: ts.SourceFile, name: string): readonly ts.FunctionDeclaration[] {
  const found: ts.FunctionDeclaration[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found.push(node)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function objectFields(
  expression: ts.Expression,
  context: SqlContext,
  seen = new Set<ts.Node>(),
): readonly WriterField[] {
  if (seen.has(expression)) failure(context, '', 0, 'cyclic TypeScript event detail')
  seen.add(expression)
  if (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isTypeAssertionExpression(expression)) {
    return objectFields(expression.expression, context, seen)
  }
  if (ts.isConditionalExpression(expression)) {
    return [
      ...objectFields(expression.whenTrue, context, new Set(seen)),
      ...objectFields(expression.whenFalse, context, new Set(seen)),
    ]
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap(property => {
      if (ts.isPropertyAssignment(property)
        || ts.isShorthandPropertyAssignment(property)
        || ts.isMethodDeclaration(property)
        || ts.isGetAccessorDeclaration(property)
        || ts.isSetAccessorDeclaration(property)) return [tsField(property.name, context)]
      if (ts.isSpreadAssignment(property)) {
        return [...objectFields(property.expression, context, new Set(seen))]
      }
      return failure(context, '', 0, 'unsupported TypeScript object member')
    })
  }
  if (ts.isCallExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.expression.getText(context.sourceFile ?? undefined) === 'Object'
      && expression.expression.name.text === 'freeze'
      && expression.arguments.length === 1) {
      return objectFields(expression.arguments[0]!, context, seen)
    }
    if (ts.isIdentifier(expression.expression) && context.sourceFile) {
      const declarations = findFunctions(context.sourceFile, expression.expression.text)
      if (declarations.length > 1) {
        const line = context.sourceFile.getLineAndCharacterOfPosition(expression.getStart(context.sourceFile)).line + 1
        throw new Error(
          `unknown event-detail writer shape at ${context.path}:${line}: ambiguous function ${expression.expression.text}; `
            + 'classify it or extend the scanner before changing live event detail',
        )
      }
      const declaration = declarations[0]
      if (declaration?.body) {
        const returns: WriterField[] = []
        const visit = (node: ts.Node): void => {
          if (ts.isReturnStatement(node) && node.expression) {
            returns.push(...objectFields(node.expression, context, new Set(seen)))
            return
          }
          ts.forEachChild(node, visit)
        }
        visit(declaration.body)
        if (returns.length > 0) return returns
      }
    }
  }
  if (ts.isIdentifier(expression) && context.sourceFile) {
    const declarations = findVariables(
      context.sourceFile,
      expression.text,
      expression.getStart(context.sourceFile),
    )
    if (declarations.length > 1) {
      const line = context.sourceFile.getLineAndCharacterOfPosition(expression.getStart(context.sourceFile)).line + 1
      throw new Error(
        `unknown event-detail writer shape at ${context.path}:${line}: ambiguous variable ${expression.text}; `
          + 'classify it or extend the scanner before changing live event detail',
      )
    }
    const declaration = declarations[0]
    if (declaration?.initializer) {
      const declarationList = declaration.parent
      if (!ts.isVariableDeclarationList(declarationList)
        || (declarationList.flags & ts.NodeFlags.Const) === 0) {
        const line = context.sourceFile.getLineAndCharacterOfPosition(declaration.getStart(context.sourceFile)).line + 1
        throw new Error(
          `unknown event-detail writer shape at ${context.path}:${line}: ${expression.text} is not const; `
            + 'classify it or extend the scanner before changing live event detail',
        )
      }
      let interveningUse: ts.Identifier | null = null
      const visit = (node: ts.Node): void => {
        if (interveningUse) return
        const position = node.getStart(context.sourceFile!)
        if (node.end <= declaration.initializer!.end
          || position >= expression.getStart(context.sourceFile!)) return
        if (ts.isIdentifier(node) && node.text === expression.text) {
          interveningUse = node
          return
        }
        ts.forEachChild(node, visit)
      }
      visit(context.sourceFile)
      if (interveningUse) {
        const line = context.sourceFile.getLineAndCharacterOfPosition(
          (interveningUse as ts.Identifier).getStart(context.sourceFile),
        ).line + 1
        throw new Error(
          `unknown event-detail writer shape at ${context.path}:${line}: ${expression.text} was used or mutated after its declaration; `
            + 'classify it or extend the scanner before changing live event detail',
        )
      }
      return objectFields(declaration.initializer, context, seen)
    }
  }
  const sourceFile = context.sourceFile
  const line = sourceFile
    ? sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile)).line + 1
    : context.baseLine
  throw new Error(
    `unknown event-detail writer shape at ${context.path}:${line}: ${expression.getText(sourceFile ?? undefined)}; `
      + 'classify it or extend the scanner before changing live event detail',
  )
}

function jsonObjectFields(
  expression: string,
  expressionOffset: number,
  sql: string,
  context: SqlContext,
  composed: boolean,
): readonly WriterField[] {
  const calls: Array<{ start: number; end: number; fields: readonly WriterField[] }> = []
  JSON_OBJECT_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = JSON_OBJECT_RE.exec(expression)) !== null) {
    const openIndex = expression.indexOf('(', match.index)
    const call = balanced(expression, openIndex)
    const argumentsText = expression.slice(call.contentStart, call.closeIndex)
    const argumentsList = splitTopLevel(argumentsText)
    if (argumentsList.length % 2 !== 0) {
      failure(context, sql, expressionOffset + match.index, 'jsonb_build_object has an odd argument count')
    }
    const fields: WriterField[] = []
    for (let index = 0; index < argumentsList.length; index += 2) {
      const argument = argumentsList[index]!
      const literal = /^\s*'([a-z][a-z0-9_]*)'\s*$/iu.exec(argument.text)
      if (!literal) {
        failure(context, sql, expressionOffset + call.contentStart + argument.start, 'non-literal jsonb_build_object key')
      }
      const keyOffset = argument.text.indexOf("'") + 1
      fields.push({
        field: literal[1]!,
        location: `${context.path}:${lineAt(
          sql,
          expressionOffset + call.contentStart + argument.start + keyOffset,
          context.baseLine,
        )}`,
      })
    }
    calls.push({ start: match.index, end: call.closeIndex + 1, fields })
    JSON_OBJECT_RE.lastIndex = call.closeIndex + 1
  }
  if (calls.length === 0) return []
  let normalized = ''
  let cursor = 0
  for (const call of calls) {
    normalized += expression.slice(cursor, call.start) + 'JSON_OBJECT'
    cursor = call.end
  }
  normalized = (normalized + expression.slice(cursor)).trim()
  // A bare (non-composed) detail expression may also be a two-way
  // CASE WHEN <cond> THEN <jsonb_build_object> ELSE <jsonb_build_object> END
  // -- e.g. identity-store.ts's register event, which writes a smaller
  // detail object for a browser /join registration and a larger one (with
  // extra keys) only when the caller declares a coding-client JSON-door
  // registration. Both branches' literal keys are already collected above
  // in `calls`, regardless of which branch they came from, so this only
  // needs to recognize the shape and let the flatMap below report the
  // union of every key either branch can write.
  const caseWhenBothBranchesAreJsonObjects = calls.length > 1
    && /^CASE\s+WHEN[\s\S]+?\s+THEN\s+JSON_OBJECT\s+ELSE\s+JSON_OBJECT\s+END$/iu.test(normalized)
  const supported = composed
    ? /^JSON_OBJECT\s*\|\|\s*CASE\s+WHEN[\s\S]+\s+THEN\s+JSON_OBJECT\s+ELSE\s+'\{\}'::jsonb\s+END$/iu.test(normalized)
    : normalized === 'JSON_OBJECT' || caseWhenBothBranchesAreJsonObjects
  if (!supported) failure(context, sql, expressionOffset, normalized)
  return calls.flatMap(call => call.fields)
}

function aliasExpressionStart(sql: string, aliasIndex: number): number {
  let depth = 0
  let quoted = false
  for (let index = aliasIndex - 1; index >= 0; index -= 1) {
    const character = sql[index]
    if (character === "'") {
      if (quoted && sql[index - 1] === "'") index -= 1
      else quoted = !quoted
      continue
    }
    if (quoted) continue
    if (character === ')') depth += 1
    if (character === '(') depth -= 1
    if (character === ',' && depth === 0) return index + 1
  }
  return 0
}

function aliasFields(sql: string, context: SqlContext): readonly WriterField[] {
  const fields: WriterField[] = []
  for (const match of sql.matchAll(/\bAS\s+event_detail\b/giu)) {
    const aliasIndex = match.index!
    const start = aliasExpressionStart(sql, aliasIndex)
    fields.push(...jsonObjectFields(sql.slice(start, aliasIndex), start, sql, context, true))
  }
  return fields
}

function classifyDetail(
  detail: Segment,
  detailOffset: number,
  sql: string,
  context: SqlContext,
): readonly WriterField[] {
  const expression = detail.text.trim()
  const leading = detail.text.indexOf(expression)
  const offset = detailOffset + Math.max(leading, 0)
  if (/^'\{\}'::jsonb$/iu.test(expression)) return []
  const marker = /^(?:\(?\s*)?__TS_EXPR_(\d+)__(?:\s*\)?\s*::jsonb)?$/u.exec(expression)
  if (marker) {
    const sourceExpression = context.expressions[Number(marker[1])]
    if (!sourceExpression || !ts.isCallExpression(sourceExpression)
      || sourceExpression.expression.getText(context.sourceFile ?? undefined) !== 'json'
      || sourceExpression.arguments.length !== 1) failure(context, sql, offset, expression)
    return objectFields(sourceExpression.arguments[0]!, context)
  }
  if (/^[a-z_][a-z0-9_]*\.event_detail$/iu.test(expression)) {
    const fields = aliasFields(sql, context)
    if (fields.length === 0) failure(context, sql, offset, expression)
    return fields
  }
  const fields = jsonObjectFields(expression, offset, sql, context, false)
  if (fields.length > 0) return fields
  return failure(context, sql, offset, expression)
}

function scanSql(sql: string, context: SqlContext): WriterScan {
  const searchableSql = maskSqlComments(sql)
  const mutation = /\b(?:UPDATE\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)|MERGE\s+INTO\s+(?:ONLY\s+)?(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events)|COPY\s+(?:(?:"?public"?)\s*\.\s*)?(?:"events"|events))\b|\bNEW\s*\.\s*"?detail"?(?:\s*\[[^\]]+\])*\s*(?::=|=)|\bINTO\s+NEW\s*\.\s*"?detail"?(?:\s*\[[^\]]+\])*/iu.exec(searchableSql)
  if (mutation) failure(context, sql, mutation.index, mutation[0])
  const trigger = eventTrigger(searchableSql)
  if (trigger) failure(context, sql, trigger.index, 'trigger targeting events is unsupported')
  const fields: WriterField[] = []
  let writerCount = 0
  INSERT_EVENT_RE.lastIndex = 0
  let insert: RegExpExecArray | null
  while ((insert = INSERT_EVENT_RE.exec(searchableSql)) !== null) {
    writerCount += 1
    if (insert[1]) failure(context, sql, insert.index, 'INSERT INTO ONLY events is unsupported')
    const openIndex = skipSqlTrivia(sql, insert.index + insert[0].length)
    if (sql[openIndex] !== '(') {
      failure(context, sql, insert.index, 'event INSERT requires an explicit column list')
    }
    const columns = balanced(searchableSql, openIndex)
    const columnNames = splitTopLevel(searchableSql.slice(columns.contentStart, columns.closeIndex))
      .map(column => sqlIdentifier(column.text))
    const detailIndex = columnNames.indexOf('detail')
    if (detailIndex < 0) continue
    const remainder = searchableSql.slice(columns.closeIndex + 1)
    const keyword = /^\s*(SELECT|VALUES)\b/iu.exec(remainder)
    if (!keyword) failure(context, sql, insert.index, 'INSERT does not use explicit SELECT or VALUES')
    const dataStart = columns.closeIndex + 1 + keyword.index + keyword[0].length
    let valuesText: string
    let valuesOffset: number
    if (keyword[1]!.toUpperCase() === 'VALUES') {
      const valueOpen = sql.indexOf('(', dataStart)
      const values = balanced(searchableSql, valueOpen)
      valuesText = sql.slice(values.contentStart, values.closeIndex)
      valuesOffset = values.contentStart
      const continuation = skipSqlTrivia(sql, values.closeIndex + 1)
      if (sql[continuation] === ',') {
        failure(context, sql, continuation, 'multi-row VALUES event INSERT is unsupported')
      }
      if (/^ON\s+CONFLICT\b/iu.test(sql.slice(continuation))) {
        failure(context, sql, continuation, 'ON CONFLICT event detail is unsupported')
      }
    } else {
      const unionIndex = topLevelPhrase(searchableSql, dataStart, /^UNION\b/iu)
      if (unionIndex >= 0) failure(context, sql, unionIndex, 'multi-branch UNION event INSERT is unsupported')
      const conflictIndex = topLevelPhrase(searchableSql, dataStart, /^ON\s+CONFLICT\b/iu)
      if (conflictIndex >= 0) failure(context, sql, conflictIndex, 'ON CONFLICT event detail is unsupported')
      const fromIndex = topLevelWord(searchableSql, dataStart, 'FROM')
      const statementEnd = fromIndex >= 0 ? fromIndex : searchableSql.indexOf(';', dataStart)
      valuesText = sql.slice(dataStart, statementEnd >= 0 ? statementEnd : sql.length)
      valuesOffset = dataStart
    }
    const values = splitTopLevel(valuesText)
    const detail = values[detailIndex]
    if (!detail) failure(context, sql, insert.index, 'detail column has no matching expression')
    fields.push(...classifyDetail(detail, valuesOffset + detail.start, sql, context))
    INSERT_EVENT_RE.lastIndex = Math.max(INSERT_EVENT_RE.lastIndex, columns.closeIndex + 1)
  }
  return { fields, writerCount }
}

function renderTemplate(
  template: ts.TemplateLiteral,
  sourceFile: ts.SourceFile,
): { text: string; expressions: readonly ts.Expression[]; baseLine: number } {
  const baseLine = sourceFile.getLineAndCharacterOfPosition(template.getStart(sourceFile)).line + 1
  if (ts.isNoSubstitutionTemplateLiteral(template)) {
    return { text: template.text, expressions: [], baseLine }
  }
  const expressions: ts.Expression[] = []
  let text = template.head.text
  for (const span of template.templateSpans) {
    const index = expressions.push(span.expression) - 1
    const sourceText = span.expression.getText(sourceFile)
    text += `__TS_EXPR_${index}__${'\n'.repeat(sourceText.match(/\n/gu)?.length ?? 0)}`
    text += span.literal.text
  }
  return { text, expressions, baseLine }
}

export function scanEventDetailWriters(sources: readonly WriterSource[]): WriterScan {
  const fields: WriterField[] = []
  let writerCount = 0
  for (const source of sources) {
    if (source.path.endsWith('.sql')) {
      const scan = scanSql(source.source, {
        path: source.path, sourceFile: null, expressions: [], baseLine: 1,
      })
      fields.push(...scan.fields)
      writerCount += scan.writerCount
      continue
    }
    const sourceFile = ts.createSourceFile(
      source.path,
      source.source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    )
    const scanTemplate = (template: ts.TemplateLiteral): void => {
      const rendered = renderTemplate(template, sourceFile)
      if (hasEventWrite(rendered.text)) {
        INSERT_EVENT_RE.lastIndex = 0
        const scan = scanSql(rendered.text, {
          path: source.path,
          sourceFile,
          expressions: rendered.expressions,
          baseLine: rendered.baseLine,
        })
        fields.push(...scan.fields)
        writerCount += scan.writerCount
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node)) {
        scanTemplate(node.template)
      } else if ((ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
        && !ts.isTaggedTemplateExpression(node.parent)) {
        scanTemplate(node)
      } else if (ts.isStringLiteral(node) && hasEventWrite(node.text)) {
        const scan = scanSql(node.text, {
          path: source.path,
          sourceFile,
          expressions: [],
          baseLine: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1,
        })
        fields.push(...scan.fields)
        writerCount += scan.writerCount
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return { fields, writerCount }
}

export function assertEveryEventDetailFieldClassified(
  fields: readonly WriterField[],
  classifiedFields: readonly string[],
): void {
  const classified = new Set(classifiedFields)
  const missing = fields.filter(({ field }) => !classified.has(field))
  assertNoMissingFields(missing)
}

function assertNoMissingFields(missing: readonly WriterField[]): void {
  if (missing.length === 0) return
  const details = [...new Map(missing.map(item => [`${item.field}\0${item.location}`, item])).values()]
    .map(item => `${item.field} at ${item.location}`)
    .join(', ')
  throw new Error(
    `live event-detail fields lack a snapshot disposition: ${details}; `
      + 'add each field to the export allowlist or deliberately omitted disclosure',
  )
}

async function filesUnder(directory: string, extension: string): Promise<readonly string[]> {
  const names = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(names.map(async entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return filesUnder(path, extension)
    return entry.isFile() && entry.name.endsWith(extension) ? [path] : []
  }))
  return files.flat().sort()
}

export async function readRepositoryEventWriterSources(
  repositoryRoot: URL,
): Promise<readonly WriterSource[]> {
  const root = fileURLToPath(repositoryRoot)
  const paths = [
    ...await filesUnder(join(root, 'src'), '.ts'),
    ...await filesUnder(join(root, 'scripts'), '.ts'),
    ...await filesUnder(join(root, 'db', 'migrations'), '.sql'),
    join(root, 'db', 'schema.sql'),
  ]
  return Promise.all(paths.map(async path => ({
    path: relative(root, path).replaceAll('\\', '/'),
    source: await readFile(path, 'utf8'),
  })))
}
