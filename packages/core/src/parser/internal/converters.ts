/*
*                      Copyright 2020 Salto Labs Ltd.
*
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with
* the License.  You may obtain a copy of the License at
*
*     http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*/
import _ from 'lodash'
import { ParsedHclBlock, HclAttribute, HclExpression, SourceRange } from './types'


let currentFilename: string
let allowWildcard = false

type HCLToken = ParsedHclBlock | HclAttribute | HclExpression

interface LexerToken {
  type: string
  value: string
  text: string
  line: number
  lineBreaks: number
  col: number
  offset: number
}

type Token = HCLToken | LexerToken

type NearleyErrorToken = Partial<HclExpression & LexerToken>

export class NearleyError extends Error {
  constructor(
    public token: NearleyErrorToken,
    public offset: number,
    message: string
  ) {
    super(message)
  }
}


const isLexerToken = (token: Token): token is LexerToken => 'value' in token
    && 'text' in token
    && 'line' in token
    && 'col' in token
    && 'offset' in token

export const startParse = (filename: string): void => {
  currentFilename = filename
  allowWildcard = false
}

export const setErrorRecoveryMode = (): void => {
  allowWildcard = true
}

const createSourceRange = (st: Token, et: Token): SourceRange => {
  const start = isLexerToken(st)
    ? { line: st.line, col: st.col, byte: st.offset }
    : (st as HCLToken).source.start
  const end = isLexerToken(et)
    ? {
      line: et.line + et.lineBreaks,
      col: et.lineBreaks === 0 ? et.col + et.text.length : et.text.length - et.text.lastIndexOf('\n'),
      byte: et.offset + et.text.length,
    }
    : (et as HCLToken).source.end
  return { filename: currentFilename, start, end }
}

const convertBlockItems = (
  blockItems: HclExpression[]
): Pick<ParsedHclBlock, 'attrs' | 'blocks'> => {
  const attrs: Record<string, HclAttribute> = {}
  const blocks: ParsedHclBlock[] = []
  blockItems.forEach(item => {
    if ('type' in item && item.type === 'map') {
      const key = item.expressions[0]
      const value = item.expressions[1]
      if (attrs[key.value]) {
        throw new NearleyError(key, key.source.start.byte, 'Attribute redefined')
      }
      attrs[key.value] = {
        expressions: [value],
        source: item.source,
      }
    }
    if ('blocks' in item) {
      blocks.push(item)
    }
  })
  return { attrs, blocks }
}

export const convertMain = (
  blockItems: HclExpression[]
): Pick<ParsedHclBlock, 'attrs' | 'blocks'> => ({
  ...convertBlockItems(blockItems),
})

export const convertBlock = (
  words: Token[],
  blockItems: HclExpression[],
  cb: LexerToken
): ParsedHclBlock => {
  const [type, ...labels] = words.map(l => {
    if (isLexerToken(l)) return l.text
    const exp = l as HclExpression
    if (exp.type === 'template' && exp.expressions.length === 1) {
      return exp.expressions[0].value
    }
    throw new Error('invalid block definition')
  })
  return {
    ...convertBlockItems(blockItems),
    type,
    labels,
    source: createSourceRange(words[0], cb),
  }
}

export const convertArray = (
  ob: LexerToken, arrayItems:
    HclExpression[], cb: LexerToken
): HclExpression => ({
  type: 'list',
  expressions: arrayItems,
  source: createSourceRange(ob, cb),
})

export const convertObject = (
  ob: LexerToken,
  attrs: HclExpression[],
  cb: LexerToken
): HclExpression => {
  const res: Record<string, HclExpression[]> = {}
  attrs.forEach(attr => {
    const expAttr = attr as HclExpression
    const key = expAttr.expressions[0]
    if (res[key.value] !== undefined) {
      throw new NearleyError(key, key.source.start.byte, 'Attribute redefined')
    }
    res[key.value] = expAttr.expressions
  })
  return {
    type: 'map',
    expressions: _(res).values().flatten().value(), // TODO Is this correct?
    source: createSourceRange(ob, cb),
  }
}

export const convertReference = (reference: LexerToken): HclExpression => ({
  type: 'reference',
  value: reference.value.split('.'),
  expressions: [],
  source: createSourceRange(reference, reference),
})

export const convertString = (
  oq: LexerToken,
  contentTokens: LexerToken[],
  cq: LexerToken
): HclExpression => ({
  type: 'template',
  expressions: contentTokens.map(t => (t.type === 'reference'
    ? convertReference(t)
    : {
      type: 'literal',
      value: t && t.text ? JSON.parse(`"${t.text}"`) : '',
      expressions: [],
      source: createSourceRange(t, t),
    })),
  source: createSourceRange(oq, cq),
})

export const convertMultilineString = (
  mlStart: LexerToken,
  contentTokens: LexerToken[],
  mlEnd: LexerToken
): HclExpression => ({
  type: 'template',
  expressions: contentTokens.map((t, index) => {
    const value = index === contentTokens.length - 1
      ? t.text.slice(0, t.text.length - 1) // Remove the last \n
      : t.text
    return t.type === 'reference'
      ? convertReference(t)
      : {
        type: 'literal',
        value,
        expressions: [],
        source: createSourceRange(t, t),
      } as HclExpression
  }),
  source: createSourceRange(mlStart, mlEnd),
})

export const convertBoolean = (bool: LexerToken): HclExpression => ({
  type: 'literal',
  value: bool.text === 'true',
  expressions: [],
  source: createSourceRange(bool, bool), // LOL. This was unindented. Honest.
})

export const convertNumber = (num: LexerToken): HclExpression => ({
  type: 'literal',
  value: parseFloat(num.text),
  expressions: [],
  source: createSourceRange(num, num),
})

const convertAttrKey = (key: LexerToken): HclExpression => ({
  type: 'literal',
  value: key.type === 'string' ? JSON.parse(key.text) : key.text,
  expressions: [],
  source: createSourceRange(key, key),
})

export const convertAttr = (key: LexerToken, value: HclExpression): HclExpression => ({
  type: 'map',
  expressions: [convertAttrKey(key), value],
  value,
  source: createSourceRange(key, value),
})

export const convertWildcard = (wildcard: LexerToken): HclExpression => {
  const exp = {
    type: 'dynamic',
    expressions: [],
    source: createSourceRange(wildcard, wildcard),
  } as HclExpression
  if (allowWildcard) return exp
  throw new NearleyError(exp, wildcard.offset, 'Invalid wildcard token')
}

export const convertFunction = (
  funcStart: LexerToken,
  parameters: HclExpression[],
  funcEnd: LexerToken
): HclExpression => ({
  type: 'func',
  expressions: [],
  value: {
    funcName: funcStart.value,
    parameters,
  },
  source: createSourceRange(funcStart, funcEnd),
})
