// ui.Surface and std/gfx on the host: the module compiles from its table, literal colours and the surface's three
// functions are checked, shapes decode within their limits, colours resolve through the theme, the fit and the
// finger mapping invert each other, the smoke run draws surfaces, and the sample game (examples/surface-catch.vera)
// plays -- a finger that follows the stars scores, one that does not loses its lives -- and paints with the phone's
// own painter.
'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require(process.env.VERA_TYPESCRIPT_PATH || 'typescript')
const {createHash} = require('node:crypto')

function retainedSources() {
  const root = path.resolve(__dirname, '../../entry/src/main/ets')
  assert.equal(require('./source-loader').sourceRoot, root, 'P3 canonical source root required')
  assert.equal(fs.realpathSync(root), root, 'P3 source root must not be a symlink')
  const sources = new Map()
  let bytes = 0, directories = 0
  const walk = dir => {
    assert(++directories <= 128, 'P3 source directory bound')
    for (const entry of fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      assert(!entry.isSymbolicLink(), 'P3 source symlink: ' + file)
      if (entry.isDirectory()) walk(file)
      else if (/\.(ets|ts|tsx)$/.test(entry.name)) {
        const size = fs.statSync(file).size
        bytes += size
        assert(size <= 1024 * 1024 && bytes <= 16 * 1024 * 1024 && sources.size < 512, 'P3 source size bound')
        sources.set(path.relative(root, file).split(path.sep).join('/'), fs.readFileSync(file, 'utf8'))
      }
    }
  }
  walk(root)
  return sources
}

const retainedPrinter = ts.createPrinter({removeComments: true})
const retainedParse = (file, text) => ts.createSourceFile(file, text.replace(/\bstruct\s+(?=\w)/g, 'class '), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const retainedPrint = node => retainedPrinter.printNode(ts.EmitHint.Unspecified, node, node.getSourceFile()).trim()
const retainedDigest = sites => createHash('sha256').update(JSON.stringify(sites)).digest('hex')

function retainedInventory(sources, config) {
  const parsed = new Map([...sources].map(([file, text]) => [file, retainedParse(file, text)]))
  const types = new Set(config.types)
  const modules = new Set(config.modules)
  const keys = new Set(config.keys)
  const protectedBinding = node => ts.isBindingElement(node) && keys.has((node.propertyName || node.name).text)
  const consumers = []
  const discovery = {}
  for (const [file, source] of parsed) {
    const hits = []
    const scan = node => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier && modules.has(path.posix.basename(node.moduleSpecifier.text))) hits.push(retainedPrint(node))
      }
      if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) && node.name && types.has(node.name.text)) {
        hits.push(retainedPrint(node).split('{')[0].trim())
      }
      if (ts.isIdentifier(node) && types.has(node.text)) hits.push('type ' + node.text)
      if (protectedBinding(node)) hits.push('binding ' + retainedPrint(node))
      if (ts.isPropertyAccessExpression(node) && config.payloadKeys.includes(node.name.text)) hits.push('payload .' + node.name.text)
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && config.payloadKeys.includes(node.argumentExpression.text)) hits.push('payload [' + node.argumentExpression.text + ']')
      ts.forEachChild(node, scan)
    }
    scan(source)
    if (hits.length || config.files.includes(file)) {
      consumers.push(file)
      discovery[file] = [...new Set(hits)].sort()
    }
  }
  parsed.set('p3-types.ts', retainedParse('p3-types.ts', `
    interface Array<T> { [n: number]: T; length: number; }
    interface ReadonlyArray<T> { readonly [n: number]: T; readonly length: number; }
    interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; }
    interface Promise<T> { then<U>(fn: (value: T) => U): Promise<U>; }
  `))
  const host = {
    getSourceFile: file => parsed.get(file), getDefaultLibFileName: () => '', writeFile() {},
    getCurrentDirectory: () => '', getDirectories: () => [], fileExists: file => parsed.has(file),
    readFile: file => sources.get(file), getCanonicalFileName: file => file, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    resolveModuleNames: (names, containing) => names.map(name => {
      if (!name.startsWith('.')) return undefined
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(containing), name))
      const file = ['.ets', '.ts', '.tsx'].map(ext => base + ext).find(candidate => parsed.has(candidate))
      return file ? {resolvedFileName: file, extension: ts.Extension.Ts} : undefined
    })
  }
  const program = ts.createProgram([...parsed.keys()], {noLib: true, noResolve: false, target: ts.ScriptTarget.Latest,
    experimentalDecorators: true, allowNonTsExtensions: true}, host)
  const checker = program.getTypeChecker()
  const sensitiveType = (type, seen = new Set()) => {
    if (!type || seen.has(type)) return false
    seen.add(type)
    if ([type.aliasSymbol, type.symbol].some(symbol => symbol && types.has(symbol.name))) return true
    return (type.types || []).some(t => sensitiveType(t, seen)) ||
      [...(type.aliasTypeArguments || []), ...(type.typeArguments || [])].some(t => sensitiveType(t, seen))
  }
  for (const [file, source] of parsed) {
    if (file === 'p3-types.ts' || consumers.includes(file)) continue
    let resolved = false
    const scan = node => {
      if ((ts.isIdentifier(node) || node.type) && sensitiveType(checker.getTypeAtLocation(node))) resolved = true
      if (!resolved) ts.forEachChild(node, scan)
    }
    scan(source)
    if (resolved) {
      consumers.push(file)
      discovery[file] = ['resolved retained payload alias']
    }
  }
  const inventory = {}
  const bodies = {}
  for (const file of consumers) {
    const source = parsed.get(file)
    const aliases = new Set()
    const symbolOf = node => checker.getSymbolAtLocation(node)
    const origin = node => {
      if (!node) return false
      if (ts.isIdentifier(node) && (types.has(node.text) || aliases.has(symbolOf(node)))) return true
      if (ts.isPropertyAccessExpression(node) && config.payloadKeys.includes(node.name.text)) return true
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && config.payloadKeys.includes(node.argumentExpression.text)) return true
      if (sensitiveType(checker.getTypeAtLocation(node))) return true
      if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node) || ts.isAsExpression(node) ||
          ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node) || ts.isParenthesizedExpression(node)) return origin(node.expression)
      return false
    }
    const contains = node => {
      if (protectedBinding(node) || origin(node)) return true
      let found = false
      ts.forEachChild(node, child => { if (contains(child)) found = true })
      return found
    }
    const bind = node => {
      let changed = false
      const add = name => {
        if (ts.isIdentifier(name)) {
          const symbol = symbolOf(name)
          if (symbol && !aliases.has(symbol)) { aliases.add(symbol); changed = true }
        } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
          for (const item of name.elements) if (ts.isBindingElement(item)) add(item.name)
        }
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isPropertyDeclaration(node)) &&
          ((node.type && contains(node.type)) || (node.initializer && contains(node.initializer)) || contains(node.name))) add(node.name)
      if (protectedBinding(node)) add(node.name)
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && contains(node.right)) add(node.left)
      if (ts.isForOfStatement(node) && contains(node.expression) && ts.isVariableDeclarationList(node.initializer)) {
        for (const decl of node.initializer.declarations) add(decl.name)
      }
      ts.forEachChild(node, child => { if (bind(child)) changed = true })
      return changed
    }
    let rounds = 0
    while (bind(source)) assert(++rounds <= 64, 'P3 alias convergence bound: ' + file)
    const nameOf = node => node.name ? retainedPrint(node.name) : ts.isConstructorDeclaration(node) ? 'constructor' : '<lambda>'
    const ownerOf = node => {
      const owners = []
      for (let at = node; at && at !== source; at = at.parent) {
        if (ts.isClassDeclaration(at) || ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at) || ts.isConstructorDeclaration(at)) owners.unshift(nameOf(at))
      }
      return file + ':' + (owners.join('.') || '<module>')
    }
    const controls = node => {
      const out = []
      for (let at = node.parent; at && at !== source; at = at.parent) {
        if (ts.isIfStatement(at)) out.unshift('if ' + retainedPrint(at.expression) + (at.elseStatement && node.pos >= at.elseStatement.pos ? ' else' : ' then'))
        else if (ts.isForStatement(at) || ts.isForOfStatement(at) || ts.isForInStatement(at) || ts.isWhileStatement(at) || ts.isDoStatement(at) ||
          ts.isSwitchStatement(at) || ts.isCaseClause(at) || ts.isConditionalExpression(at) || ts.isTryStatement(at) ||
          ts.isArrowFunction(at) || ts.isFunctionExpression(at)) {
          out.unshift(retainedPrint(at).split('{')[0].trim())
        }
      }
      return out
    }
    const visit = node => {
      const owner = ownerOf(node)
      if ((node.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))) ||
          (ts.isClassDeclaration(node) && node.name && types.has(node.name.text))) bodies[owner] = retainedPrint(node)
      const site = ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isReturnStatement(node) ||
        ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
        ts.isDeleteExpression(node) || ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node) ||
        (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment)
      if (site && contains(node)) {
        if (!inventory[owner]) inventory[owner] = []
        inventory[owner].push([controls(node), retainedPrint(node)])
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return {discovery, inventory, bodies}
}

function retainedSummary(inventory) {
  const files = {}
  for (const [owner, sites] of Object.entries(inventory)) {
    const file = owner.split(':')[0]
    if (!files[file]) files[file] = []
    files[file].push([owner, sites])
  }
  return Object.fromEntries(Object.entries(files).map(([file, owners]) =>
    [file, [owners.length, owners.reduce((sum, [, sites]) => sum + sites.length, 0), retainedDigest(owners)]]))
}

function synchronousPathChecks(sources, decisions) {
  assert(decisions.length > 0 && decisions.length <= 64, 'P3 synchronous decision count bound')
  let probes = 0
  const owners = new Set()
  const printer = ts.createPrinter({removeComments: true})
  const bodies = new Map()
  for (const file of new Set(decisions.map(d => d.file))) {
    const text = sources.get(file)
    assert(typeof text === 'string' && text.length <= 1024 * 1024, 'P3 synchronous source bound: ' + file)
    const source = retainedParse(file, text)
    const visit = (node, owner = '') => {
      if (ts.isClassDeclaration(node)) owner = node.name.text
      if (ts.isFunctionDeclaration(node)) owner = node.name.text
      if (ts.isMethodDeclaration(node)) owner += '.' + node.name.getText(source)
      if (ts.isConstructorDeclaration(node)) owner += '.constructor'
      if (node.body && (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node))) {
        bodies.set(file + ':' + owner, printer.printNode(ts.EmitHint.Unspecified, node, source))
      }
      ts.forEachChild(node, child => visit(child, owner))
    }
    visit(source)
  }
  const normalize = (text, method = false) => {
    const source = retainedParse('evidence.ts', method ? 'class Evidence { ' + text + ' }' : text)
    const tokens = []
    const visit = node => {
      const children = node.getChildren(source)
      if (children.length) children.forEach(visit)
      else if (node.kind !== ts.SyntaxKind.SemicolonToken && node.kind !== ts.SyntaxKind.EndOfFileToken &&
          node.kind !== ts.SyntaxKind.SyntaxList) tokens.push(node.getText(source))
    }
    visit(source)
    return tokens.join('\u0000')
  }
  const check = (body, decision, normalized = false) => {
    assert(body && body.length <= 128 * 1024, 'P3 synchronous owner bound: ' + decision.owner)
    const actual = normalized ? body : normalize(body, decision.owner.includes('.'))
    for (const fragment of decision.evidence) assert(actual.includes(normalize(fragment)),
      'P3 synchronous evidence changed: ' + decision.owner + ': ' + fragment)
  }
  for (const decision of decisions) {
    const key = decision.file + ':' + decision.owner
    assert(!owners.has(key), 'P3 synchronous owner repeated: ' + key)
    owners.add(key)
    assert(['VM synchronous', 'outside VM'].includes(decision.reachability))
    assert(decision.cost && decision.budget && decision.evidence.length > 0 && decision.evidence.length <= 16)
    const body = bodies.get(key)
    check(body, decision)
    for (const evidence of decision.evidence) {
      const fragment = normalize(evidence)
      assert(fragment.length > 0 && fragment.length <= 16 * 1024, 'P3 synchronous fragment bound: ' + key)
      assert.throws(() => check(normalize(body, decision.owner.includes('.')).split(fragment).join(''), decision, true), /P3 synchronous evidence changed:/)
      probes++
    }
  }
  console.log('P3 synchronous paths: ' + decisions.length + ' bounded owner reviews, ' + probes + ' evidence-removal probes; ' +
    'input cost is not a runtime size cap; no hard preemption or whole-path closure claimed')
}

function retainedPayloadChecks(config) {
  const sources = retainedSources()
  const actual = retainedInventory(sources, config)
  const check = result => {
    assert.deepEqual(Object.fromEntries(Object.entries(result.discovery).map(([file, sites]) => [file, retainedDigest(sites)])), config.discovery,
      'P3 payload types/imports/consumers changed; review finite native inventory')
    assert.deepEqual(retainedSummary(result.inventory), config.inventory,
      'P3 normalized payload owner/sites/control flow changed; review construction, mutation and escapes')
    for (const [owner, [digest, review]] of Object.entries(config.bodies)) {
      assert(review.length > 0 && result.bodies[owner], 'P3 critical owner present: ' + owner)
      assert.equal(retainedDigest(result.bodies[owner]), digest, 'P3 construction/copy/control body changed: ' + owner)
    }
  }
  check(actual)
  for (const [name, file, before, after, tracked, extraSources, bodyOnly] of config.probes) {
    assert(sources.has(file) ? sources.get(file).includes(before) : before === '', 'P3 probe anchor: ' + name)
    const changed = new Map(sources)
    changed.set(file, sources.has(file) ? sources.get(file).replace(before, after) : after)
    for (const [extraFile, text] of extraSources || []) {
      assert(!changed.has(extraFile), 'P3 synthetic source must be new: ' + extraFile)
      changed.set(extraFile, text)
    }
    const result = retainedInventory(changed, config)
    if (tracked) assert(Object.values(result.inventory).flat().some(([, expression]) => expression === tracked),
      'P3 alias use independently tracked: ' + name)
    if (bodyOnly) {
      assert.deepEqual(result.discovery, actual.discovery, 'P3 body-only probe preserves discovery: ' + name)
      assert.deepEqual(retainedSummary(result.inventory), config.inventory, 'P3 body pin independently necessary: ' + name)
      assert.throws(() => check(result), /P3 construction\/copy\/control body changed:/, 'P3 critical body rejects ' + name)
    } else {
      assert.notDeepEqual(retainedSummary(result.inventory), config.inventory, 'P3 site/context rejects independently of body pins: ' + name)
      assert.throws(() => check(result), /P3 /, 'P3 rejects ' + name)
    }
  }
  const whitespace = new Map(sources)
  for (const file of config.files) whitespace.set(file, '\n  ' + sources.get(file) + '\n')
  check(retainedInventory(whitespace, config))
  assert.deepEqual(Object.keys(config.ownership), ['A', 'B', 'C', 'D'])
  assert.equal(config.ownership.B.root, 'authoritative root is a replaceable B slot, not a D payload')
  assert(config.ownership.B.restoration.includes('originalRoot') && config.ownership.B.cells.includes('escaped'))
  assert(config.ownership.C.scope.includes('publication'))
  assert(config.ownership.D.retained && config.ownership.D.construction && config.ownership.D.renderer)
  if (config.synchronous) synchronousPathChecks(sources, config.synchronous)
  assert(config.limits.includes('not native pointer proof'))
  console.log('P3 ' + config.name + ': ' + Object.keys(actual.discovery).length + ' consumers, ' + Object.keys(actual.inventory).length +
    ' owner inventories; ' + config.probes.length + ' rejection probes; ' + config.limits)
}

const retainedOwnership = {
  A: {meaning: 'VM reachable graph storage: wrappers, fields/maps and elements',
    scope: 'Existing state-carry inventory covers wrapper graph storage, not these native payload fields'},
  B: {meaning: 'VM slots including Cells, captures and authoritative root replacement',
    root: 'authoritative root is a replaceable B slot, not a D payload',
    restoration: 'StateManager captures originalRoot at beginTurn and restores it after guard rollback across all handlers, not only the final call',
    cells: 'Pre-existing escaped closure Cells use the common reverse-order slot journal; fresh frame-local Cells are scratch until escape'},
  C: {meaning: 'Deferred host effects and post-accept publication, not root-slot restoration',
    scope: 'Acceptance/publication and deferred effect rollback remain separate from B originalRoot restoration; coordinated production activation is not claimed'},
  D: {meaning: 'No VM write: native retained payloads and renderer-owned derived storage',
    retained: 'Published GfxOp children/points and SceneThing nested metadata are immutable by ownership policy, not runtime freeze',
    construction: 'Freshness is an additional attribute: D constructors/wrappers may initialize fresh parents, never mutate borrowed descendants',
    renderer: 'D renderer caches/nodes/poses are mutable renderer-owned data; borrowed payloads must not become writable aliases'}
}
const retainedLimits = 'bounded review inventory, not ArkTS typechecking or semantic alias/freshness proof; struct-to-class AST adapter; ' +
  'synthetic Array/Map/Promise types; opaque any/reflection/computed keys and interprocedural erased flows without visible origin may escape; ' +
  'structural-only type flows without a recognized retained origin may escape; traversal/control inventories are incomplete outside fully body-pinned owners, including intervening break/continue/early-return statements; ' +
  'not native pointer proof: C++/NAPI retention and asynchronous callbacks require separate audit if they retain JS payload pointers; ' +
  'no allocation epochs, journal, pure-mode enforcement, rollback or publication closure'

const gfxRetained = {
  name: 'gfx retained payload',
  types: ['GfxOp', 'GfxShapeValue'], keys: ['op', 'points', 'children'], payloadKeys: ['op'],
  modules: ['VeraGfx', 'GfxPaint', 'VeraMovingPart'],
  files: ['vera/VeraGfx.ets', 'vera/GfxPaint.ets', 'vera/VeraMovingPart.ets'],
  ownership: retainedOwnership, limits: retainedLimits,
  synchronous: [
    {file: 'vera/VeraGfx.ets', owner: 'asNumbers', reachability: 'VM synchronous',
      cost: 'At most MAX_GFX_POINTS=2000 primitive extraction iterations; fresh native output',
      budget: 'Inside host boundary; elapsed duration sampled on return, no inner deadline check',
      evidence: ['let items = (v as VeraArrayValue).elements', "if (items.length > MAX_GFX_POINTS) { throw new RuntimeTrap('R0028', 'a polyline or polygon holds at most ' + (MAX_GFX_POINTS / 2).toString() + ' points; got ' + Math.floor(items.length / 2).toString()) }"]},
    {file: 'vera/VeraGfx.ets', owner: 'asStrings', reachability: 'VM synchronous',
      cost: 'Gradient stop extraction is input-proportional without an explicit stop-count cap',
      budget: 'Host pre/post samples only; allocation and string-size risk remains',
      evidence: ['let out: string[] = []', 'for (let item of (v as VeraArrayValue).elements) { if (item instanceof VeraStringValue) { out.push((item as VeraStringValue).value) } }']},
    {file: 'vera/VeraGfx.ets', owner: 'shapesIn', reachability: 'VM synchronous',
      cost: 'Scans every supplied array element before holding checks rendered shape/depth totals',
      budget: 'MAX_GFX_SHAPES does not cap ignored inputs or the initial scan; host pre/post only',
      evidence: ['let out: GfxOp[] = []', 'for (let item of (value as VeraArrayValue).elements) { if (item instanceof GfxShapeValue) { out.push((item as GfxShapeValue).op) } }']},
    {file: 'vera/VeraGfx.ets', owner: 'decodeGfx', reachability: 'outside VM',
      cost: 'Post-draw shapesIn scans all input elements and copies retained op references before checking total drawn shapes',
      budget: 'Caller wall time outside VM sampling; MAX_GFX_SHAPES bounds rendered output, not skipped input processing',
      evidence: ['let ops = shapesIn(value)', 'for (let o of ops) { count += o.drawn }']},
    {file: 'vera/VeraGfx.ets', owner: 'holding', reachability: 'VM synchronous',
      cost: 'Child-count traversal precedes MAX_GFX_DEPTH=12 and MAX_GFX_SHAPES=4000 rejection',
      budget: 'Bounded retained result is not a bound on all synchronous input processing',
      evidence: ['o.children = children', "if (depth > MAX_GFX_DEPTH) { throw new RuntimeTrap('R0028', 'groups nest at most ' + MAX_GFX_DEPTH.toString() + ' deep') }"]}
  ],
  review: {
    benchmark: 'D p2Validate reads decoded ops and discards the fresh outer list; p2Fingerprint serializes VM fields and queued effect metadata, not retained op fields. Synthetic pointer inputs are fresh local VM allocations; no borrowed payload writes, native effect dispatch, effect callback execution or native lifetime changes'
  },
  discovery: {
    'components/VeraPreview.ets': 'aa261fc71c4bf362006f4f86acf13a940da91bf78d9fe62bf6dc285a9e4690e8',
    'runtime/AppActor.ets': '493a11298735c81823d729a7791788274732ec53f97946f89746b7fe48ee8dc3',
    'runtime/InProcessHost.ets': 'ca74bd07a578fe62f05ae8a3c506a1b440a5dfb67205a547007c56d04242079f',
    'vera/GfxPaint.ets': 'f9c697b9f74b0e4feab21291138c372355f1586414194abcb11b6ca8387d63fc',
    'vera/VeraCompiler.ets': 'f38f16a67164204b49cf03b8116a30b3caaf2c8999c9ac3601df0e71b5225779',
    'vera/VeraCompose.ets': '76e59ed9333f4cd11e4d1b44e7d659f1ee868b364f43354a2c89d5eb6443916d',
    'vera/VeraComposition.ets': '76e59ed9333f4cd11e4d1b44e7d659f1ee868b364f43354a2c89d5eb6443916d',
    'vera/VeraGfx.ets': '54938169d8b30cc18424224429b8091f2669c137ac8590b329d6f0d42a8ec175',
    'vera/VeraInterpreter.ets': '76e59ed9333f4cd11e4d1b44e7d659f1ee868b364f43354a2c89d5eb6443916d',
    'vera/VeraLiveWidget.ets': 'c19c080855ab7ae67f729999b945dce7ed255e1de717db5dc02ea3bf66060bef',
    'vera/VeraLook3D.ets': 'd23f585db49f69dbff43faadceb9b52376623a5284c1efd7812aa31733e174c7',
    'vera/VeraMovingPart.ets': '3b29c1dcf6e520e37f7a97b8f670bd084a6454b5a247c2fdd46331ba06f0a6ce',
    'vera/VeraScene.ets': '73f44d5fa1bea1e0beaf7049c95f55a1d62ec274da353bd6b68e0d58bb28ae41',
    'vera/VeraSearchBenchmark.ets': '7ff4f1176638ac10ed6cdd3cb69d793788cb9dd0f30b6b456aa6ddec8c774bc9',
    'vera/VeraSmoke.ets': '1b70d3ccb19e4a0eb077f75d5d86fd5f580bc9c48584e78dff1d1040a9115bf4',
    'vera/VeraSurfacePlay.ets': 'acba5569a8ca3305589fd03a2f64282f065227b9c7a58aad494d2f9d7db3f45d',
    'vera/VeraUi.ets': '268fd6aef1bb2b55e08663ba4dd50c21f85d66ad541a18751412aa06208a2e26',
    'vera/VeraUiCatalog.ets': '98148ad19d13898ee56b4ea8f51ff0d500d441cc412d0824603ee0cf675275e5',
    'vera/VeraWidgetRefine.ets': '86e598c94ca8f364bd2f5b58750169c6a98a07070805966bf2f5d71d99d92ed5',
    'widget/CardView.ets': 'b30572f2098106e152b3b4736dab6df301739fcc5e0a6fe8e7114679cff8cedf'
  },
  inventory: {
    'components/VeraPreview.ets': [3, 15, '2d20b6c9b6c38109f5ad60d9948967fade431cfeaa71420a2a1c2c0246a53acb'],
    'runtime/AppActor.ets': [1, 2, '042951ddc09800a9261a3bb64b951a7ffead278089674fa719bc9bc30d4db684'],
    'runtime/InProcessHost.ets': [1, 17, '0666c8d6fc96df58356d54b7da505332e3c9a0d84902b1ca4a09b7df97366185'],
    'vera/GfxPaint.ets': [11, 175, 'f6e6ff552ed462cb94f2b8c4fd21c7d0158adde6d9e1d72277694737170be346'],
    'vera/VeraCompiler.ets': [1, 32, '3d6491a196a7c186a4fed829b000f2dea8f5f555ef444db5469aa6881116cc6d'],
    'vera/VeraCompose.ets': [5, 54, '160d55796dc1936396bfeced71fb52b728a49c28b30263184d0738fe724bde94'],
    'vera/VeraComposition.ets': [1, 1, '846a331726589eacb8fac53829a43ff473145f99972d2731bde898c9f87b305a'],
    'vera/VeraGfx.ets': [8, 174, '9a8b7207f8ef42eb4c314e48cc11b58e2cc1d343352e065b8bbb6d49193ef7f7'],
    'vera/VeraInterpreter.ets': [3, 3, '7783b4022979ebd4b16bf077ce14501d0d89147993716d93af12e02ae87d0965'],
    'vera/VeraLiveWidget.ets': [2, 109, '826f48ce97ffe76aa16dada8c6e3341ca328a8ad866e6430357b8cb722c3a4f1'],
    'vera/VeraMovingPart.ets': [7, 112, '73a9eb20459b8ea6c1635db9d6428cac1e635b7f22fdb592680397edbfde5cf8'],
    'vera/VeraSearchBenchmark.ets': [1, 1, '9f687e6b8f612c67a8f14c3afc49e7172d71dcc62c25d71e7abcfa46bf7976f9'],
    'vera/VeraSmoke.ets': [1, 1, '0f172a3226f3452b8f950f120e7afd326ca6a5bf698764338e8706fe99c6cf11'],
    'vera/VeraSurfacePlay.ets': [3, 41, 'e06e15036126627df2150eb82a1377762707f90c4e22f71e0905b510e2edfb16'],
    'vera/VeraWidgetRefine.ets': [4, 39, '9f0f871e19e6ba1c55980f61b703654acd32abd9f6ede426f77352fa6beef612'],
    'widget/CardView.ets': [2, 4, '11f1b8225192cbfbd8e4245704199ec4cc4502754a58c4d05fbfe8a5d3d45513']
  },
  bodies: {
    'vera/GfxPaint.ets:GfxOp': ['ec4a66072912518e39c55f590eb0507cb27c79463d9f0acb6f442f60ac8a7341', 'D fresh per-instance points/children defaults'],
    'vera/GfxPaint.ets:unpackGfxOp': ['042c2ecb29b42bacb7ea6c88e0b025970aefdf5ea416f6657a8208e914f6b6ad', 'D wire decode allocates recursively detached arrays and ops'],
    'vera/VeraGfx.ets:GfxShapeValue': ['ee372ac1a2ff68437eba67efc8b5628bf03f36bc430d37789e9c1ad08b0d2745', 'A fresh empty wrapper map via freshObjectValue provenance, D retained op alias'],
    'vera/VeraGfx.ets:asNumbers': ['d299b0dd4321a27f7c52ff10bb39844d4433bdc7f413717ae4ae28fd1dde279c', 'A borrowed VM primitives extracted into D per-call fresh output; no module-shared reused array; hash is a bounded review gate, not semantic freshness proof'],
    'vera/VeraGfx.ets:holding': ['2e0a29ab8b82ca2d61dc6d3bf6e95c0c865c15040b95458c4d2bf539391c8327', 'D fresh parent accounting; borrowed child ops read-only'],
    'vera/VeraGfx.ets:shapesIn': ['9a08da990374e806b9aed8b30dfe8a44a6ba4c3253b8be45ef3b1ddf23cf621c', 'D fresh outer list retains immutable op aliases'],
    'vera/VeraGfx.ets:op': ['86f7cd7637e4ea7218bee3ef1ee15b3f90f5e38f8e155ff075ea8b7fc315dc17', 'D fresh op before publication'],
    'vera/VeraGfx.ets:invokeStdGfx': ['98f9297c8e1e8908aba961bd67b922251ea04f283f70a4ad101da152efaf4119', 'D constructors and functional wrappers only write fresh parents']
  },
  probes: [
    ['gfx primitive extraction reuses module-shared output', 'vera/VeraGfx.ets',
      `function asNumbers(args: RuntimeValue[], i: number): number[] {
  if (i >= args.length) { return [] }
  let v = args[i]
  if (!(v instanceof VeraArrayValue)) { throw new RuntimeTrap('R0020', 'expected array argument') }
  let items = (v as VeraArrayValue).elements
  if (items.length > MAX_GFX_POINTS) {
    throw new RuntimeTrap('R0028', 'a polyline or polygon holds at most ' + (MAX_GFX_POINTS / 2).toString() +
      ' points; got ' + Math.floor(items.length / 2).toString())
  }
  let out: number[] = []`,
      `const sharedNumericOutput: number[] = []
function asNumbers(args: RuntimeValue[], i: number): number[] {
  if (i >= args.length) { return [] }
  let v = args[i]
  if (!(v instanceof VeraArrayValue)) { throw new RuntimeTrap('R0020', 'expected array argument') }
  let items = (v as VeraArrayValue).elements
  if (items.length > MAX_GFX_POINTS) {
    throw new RuntimeTrap('R0028', 'a polyline or polygon holds at most ' + (MAX_GFX_POINTS / 2).toString() +
      ' points; got ' + Math.floor(items.length / 2).toString())
  }
  let out: number[] = sharedNumericOutput
  out.length = 0`, null, null, true],
    ['constructor array defaults weakened', 'vera/GfxPaint.ets', 'points: number[] = []', 'points: number[] = sharedPoints', null, null, true],
    ['numeric copy helper weakened', 'vera/VeraGfx.ets', 'out.push((item as VeraNumberValue).value)', 'out.push(99)', null, null, true],
    ['shared op.points mutation', 'vera/VeraGfx.ets', 'this.op = op', 'this.op = op; op.points.push(99)'],
    ['shared child-op mutation', 'vera/VeraGfx.ets', 'count += c.count', 'c.points[0] = 99; count += c.count'],
    ['erased consumer alias', 'vera/VeraMovingPart.ets', 'export function pointsOf(o: GfxOp, m: number[], out: number[]): void {',
      'export function pointsOf(o: GfxOp, m: number[], out: number[]): void { const hidden = o as Object; consume(hidden);', 'consume(hidden)'],
    ['destructured unknown receiver', 'vera/GfxPaint.ets', 'function finite(o: GfxOp): boolean {',
      'function finite(o: GfxOp): boolean { const {points: queue} = input; queue.push(99);', 'queue.push(99)'],
    ['erased destructured op alias', 'vera/VeraGfx.ets', 'this.op = op',
      'this.op = op; const erased = op as Object; const {children: kids} = erased; consume(kids);', 'consume(kids)'],
    ['approved write repeated by loop', 'vera/VeraGfx.ets', 'o.count = count', 'for (let repeat = 0; repeat < 2; repeat++) { o.count = count }'],
    ['approved write conditional bypass', 'vera/VeraGfx.ets', 'o.count = count', 'if (false) { o.count = count }'],
    ['new import consumer', 'runtime/P3GfxProbe.ets', '', "import {GfxOp as Op} from '../vera/GfxPaint'; export function steal(op: Op): Object { const hidden = op as Object; return consume(hidden); }"],
    ['transitive reexport and type-alias consumer', 'runtime/P3GfxProbe.ets', '',
      "import {Carry} from './P3AliasBridge'; export function steal(input: Carry): void { const hidden = input as Object; consume(hidden); }", 'consume(hidden)',
      [['runtime/P3PayloadAlias.ets', "import {GfxOp as Native} from '../vera/GfxPaint'; export type Payload = Native;"],
        ['runtime/P3AliasBridge.ets', "export {Payload as Carry} from './P3PayloadAlias';"]]],
    ['fresh points copy weakened', 'vera/VeraGfx.ets', 'o.points = asNumbers(args, 0)', 'o.points = (args[0] as VeraArrayValue).elements as number[]'],
    ['new unknown destructuring consumer', 'runtime/P3GfxProbe.ets', '', 'export function steal(input: Object): void { const {op: hidden} = input; hidden.points.push(1); }', 'hidden.points.push(1)']
  ]
}

module.exports = {retainedSources, retainedInventory, retainedDigest, retainedSummary, retainedPayloadChecks, retainedOwnership, retainedLimits, synchronousPathChecks, gfxRetained}

if (require.main === module) {
retainedPayloadChecks(gfxRetained)
const {loadVera} = require('./source-loader')
const {createRecorder} = require('./gfx-svg')
const {play} = require('./gfx-run')
const {compileVeraSource} = loadVera('VeraCompiler')
const {VirtualMachine, deserializeVbc2, VeraNumberValue, VeraArrayValue} = loadVera('VeraInterpreter')
const {UiHostEnvironment, decodeVeraUi} = loadVera('VeraUi')
const G = loadVera('VeraGfx')
const {resolveTheme} = loadVera('VeraTheme')
const {smokeRun} = loadVera('VeraSmoke')
const {playSurface} = loadVera('VeraSurfacePlay')
const {describeCatalogForPrompt, describeComponents, selectUiComponents, catalogKinds} = loadVera('VeraUiCatalog')

const sample = fs.readFileSync(path.join(__dirname, 'examples/surface-catch.vera'), 'utf8')

const codes = src => {
  try { compileVeraSource(src); return [] } catch (e) { return (e.diagnostics || []).map(d => d.code + ' ' + d.message) }
}
const program = (drawBody, extra = '', surface = 'ui.Surface("default", 100, 100, "draw", "", "")') => `
@jsonable class AppState { n: number; }
function init(): AppState { return {n: 0}; }
${extra}
function draw(state: AppState): gfx.Shape[] {
  let shapes: gfx.Shape[] = [];
  ${drawBody}
  return shapes;
}
function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [${surface}]); }
`

// The module is its table: every function compiles with its arity, and needs no import.
const calls = G.GFX_FUNCTIONS.map(f => {
  const args = f.params.filter(p => !p.optional).map(p =>
    p.kind === 'number' ? '1' : p.kind === 'number[]' ? '[0, 0, 10, 10]' : p.kind === 'shapes' ? '[gfx.rect(0, 0, 1, 1, "ink")]'
      : p.kind === 'color' ? '"accent"' : p.kind === 'colors' ? '["white", "accent"]' : p.kind === 'boolean' ? 'true'
      : p.name === 'align' ? '"center"' : p.name === 'mode' ? '"add"' : p.name === 'motion' ? '"swing"' : p.name === 'direction' ? '"left"' : p.name === 'speed' ? '"slow"' : '"M0 0 L10 10 Z"')
  const call = 'gfx.' + f.name + '(' + args.join(', ') + ')'
  return f.result === 'shape' ? `shapes.push(${call});` : f.result === 'string' ? `let s${f.name}: string = ${call};`
    : f.result === 'number' ? `let n${f.name}: number = ${call};` : `let b${f.name}: boolean = ${call};`
})
assert.deepEqual(codes(program(calls.join('\n  '))), [], 'every std/gfx function compiles from the table')
assert.deepEqual(codes('import * as gfx from "std/gfx"\n' + program('shapes.push(gfx.circle(5, 5, 5, "ink"));')), [],
  'an explicit import still works')

// Literal colours and aligns are held to their sets.
for (const good of ['ink', 'accent', 'clear', '#abc', '#a1b2c3', '#a1b2c380']) {
  assert.deepEqual(codes(program(`shapes.push(gfx.rect(0, 0, 1, 1, "${good}"));`)), [], good + ' is a colour')
}
for (const bad of ['red', '#12', '#ggggggg', 'Accent', '']) {
  const found = codes(program(`shapes.push(gfx.rect(0, 0, 1, 1, "${bad}"));`))
  assert.ok(found.some(c => c.startsWith('E2112') && c.includes('unknown colour')), JSON.stringify(bad) + ' is refused: ' + found)
}
assert.ok(codes(program('shapes.push(gfx.text(0, 0, 10, "middle", "ink", "x"));')).some(c => c.startsWith('E2112')),
  'an align outside left/center/right is refused')
assert.deepEqual(codes(program('let c: string = "nonsense"; shapes.push(gfx.rect(0, 0, 1, 1, c));')), [],
  'a computed colour is not checked at compile time')

// The surface's three functions.
const surfaceCodes = (surface, extra) => codes(program('', extra, surface))
assert.deepEqual(surfaceCodes('ui.Surface("fill", 360, 640, "draw", "tick", "touch")',
  'function tick(state: AppState, ms: number): AppState { return state; }\nfunction touch(state: AppState, p: gfx.Pointer): AppState { return {n: p.x + p.y + p.id}; }'), [],
  'draw, a frame handler and a pointer handler with the right signatures compile')
const e2106 = (surface, extra, why) => assert.ok(surfaceCodes(surface, extra).some(c => c.startsWith('E2106')), why)
e2106('ui.Surface("default", 1, 1, "", "", "")', '', 'a surface needs a draw function')
e2106('ui.Surface("default", 1, 1, "missing", "", "")', '', 'a draw function that does not exist is refused')
e2106('ui.Surface("default", 1, 1, "bad", "", "")', 'function bad(state: AppState): ui.View { return ui.Text("body", "x"); }',
  'draw must return gfx.Shape[]')
e2106('ui.Surface("default", 1, 1, "draw", "tick", "")', 'function tick(state: AppState, v: string): AppState { return state; }',
  'a frame handler takes a number')
e2106('ui.Surface("default", 1, 1, "draw", "", "touch")', 'function touch(state: AppState, v: number): AppState { return state; }',
  'a pointer handler takes a gfx.Pointer')

// Colours resolve through the theme, light and dark.
const light = resolveTheme('clean', '', false), dark = resolveTheme('clean', '', true)
assert.equal(G.gfxColor(light, 'accent'), light.primary)
assert.equal(G.gfxColor(dark, 'surface'), dark.surface)
assert.notEqual(G.gfxColor(light, 'background'), G.gfxColor(dark, 'background'), 'a role follows dark mode')
assert.equal(G.gfxColor(light, '#abc'), '#aabbcc')
assert.equal(G.gfxColor(light, '#FF000080'), 'rgba(255,0,0,0.502)')
assert.equal(G.gfxColor(light, 'nonsense'), light.ink, 'an unknown colour is drawn in ink')
const ev = (name, ...args) => G.invokeStdGfx(name, args.map(a => typeof a === 'number' ? new VeraNumberValue(a) : a))
assert.equal(ev('rgb', 255, 128, 0).value, '#ff8000')
assert.equal(ev('rgb', 300, -4, 0, 0.5).value, '#ff000080', 'channels are clamped and alpha appended')
assert.equal(ev('distance', 0, 0, 3, 4).value, 5)
assert.equal(ev('inside', 5, 5, 0, 0, 10, 10).value, true)
assert.equal(ev('inside', 11, 5, 0, 0, 10, 10).value, false)

// Fit, the finger mapping and the natural height.
const fit = G.gfxFit(360, 740, 360, 640)
assert.deepEqual([fit.scale, fit.offsetX, fit.offsetY], [1, 0, 50], 'a tall box letterboxes top and bottom')
const wide = G.gfxFit(800, 400, 100, 100)
assert.deepEqual([wide.scale, wide.offsetX, wide.offsetY], [4, 200, 0], 'a wide box letterboxes left and right')
assert.deepEqual(G.gfxToSurface(wide, 200 + 4 * 25, 4 * 75), [25, 75], 'a finger maps back to surface units')
assert.equal(G.gfxNaturalHeight(360, 360, 640), 640)
assert.equal(G.gfxFit(0, 100, 10, 10).scale, 1, 'an unmeasured box does not divide by zero')

// Shapes decode within their limits.
const rect = G.invokeStdGfx('rect', [0, 0, 1, 1].map(n => new VeraNumberValue(n)).concat([new (loadVera('VeraInterpreter').VeraStringValue)('ink')]))
const group = shapes => G.invokeStdGfx('group', [0, 0, 0, 1, 1].map(n => new VeraNumberValue(n)).concat([new VeraArrayValue(shapes)]))
assert.equal(G.decodeGfx(new VeraArrayValue([rect, group([rect, rect])])).length, 2)
assert.equal(group([rect, group([rect])]).op.count, 4, 'a group counts itself and everything in it')
assert.throws(() => G.decodeGfx(new VeraArrayValue(Array(G.MAX_GFX_SHAPES + 1).fill(rect))), e => e.trapCode === 'R0028', 'too many shapes traps')
let deep = rect
for (let i = 0; i <= G.MAX_GFX_DEPTH; i++) {
  if (i === G.MAX_GFX_DEPTH) { assert.throws(() => group([deep]), e => e.trapCode === 'R0028', 'groups too deep trap'); break }
  deep = group([deep])
}

// The renderer and the catalogue agree, and the prompt describes std/gfx whenever it describes a Surface.
assert.ok(catalogKinds().includes('surface'))
const prompt = describeCatalogForPrompt(selectUiComponents(['Surface']))
assert.ok(prompt.includes('ui.Surface(style, width, height, draw, frame, pointer)') && prompt.includes('gfx.polygon(points, color)') &&
  prompt.includes('class gfx.Pointer'), 'the prompt carries the surface and std/gfx')
assert.ok(!describeCatalogForPrompt(selectUiComponents([])).includes('gfx.rect'), 'and leaves std/gfx out when there is no surface')
assert.ok(describeComponents(['Surface']).includes('gfx.text('), 'find_ui_component for Surface answers with std/gfx too')

// The smoke run draws surfaces and hands the pointer handler a finger.
const compiled = compileVeraSource(sample)
assert.equal(compiled.handlers.get('onPointer'), 'pointer')
assert.equal(compiled.handlers.get('onFrame'), 'number')
assert.equal(smokeRun(compiled), '', 'the sample passes the smoke run')
const trapping = compileVeraSource(program('let empty: number[] = []; shapes.push(gfx.circle(empty[3], 0, 1, "ink"));'))
assert.ok(/stopped when the program starts/.test(smokeRun(trapping)), 'a draw() that traps is caught before it is served')

// The sample game. Untouched, the stars fall past and the round ends; a finger kept under the lowest star scores.
const untouched = play(sample, {frames: 60 * 40, dt: 16, events: [[1, 'down', 0, 180, 600], [2, 'up', 0, 180, 600]]})
assert.equal(untouched.summary.trap, '')
const lost = untouched.summary.state.fields
assert.equal(lost.get('phase').value, 'over', 'left alone, the round ends')
assert.equal(lost.get('lives').value, 0)
assert.equal(lost.get('best').value, lost.get('score').value, 'the best score is kept')

const vm = new VirtualMachine(deserializeVbc2(compiled.vbc2), new UiHostEnvironment())
let state = vm.execute('onPointer', [vm.execute('init'), G.pointerValue('down', 0, 180, 590)])
for (let i = 0; i < 60 * 30; i++) {
  let target = null
  for (const star of state.fields.get('stars').elements) {
    if (target === null || star.fields.get('y').value > target.fields.get('y').value) target = star
  }
  if (target !== null) state = vm.execute('onPointer', [state, G.pointerValue('move', 0, target.fields.get('x').value, 590)])
  state = vm.execute('onFrame', [state, new VeraNumberValue(16)])
}
const played = state.fields
assert.ok(played.get('score').value >= 20, 'a finger that follows the stars scores: ' + played.get('score').value)
assert.ok(played.get('basketX').value >= 50 && played.get('basketX').value <= 310, 'the basket stays on the surface')

// It paints with the phone's own painter: the title on the first frame, the stars and the score later.
const drawn = play(sample, {frames: 120, dt: 16, every: 60, box: [360, 740],
  events: [[1, 'down', 0, 180, 600], [2, 'up', 0, 180, 600]]})
assert.equal(drawn.drawn.length, 3)
assert.ok(drawn.drawn[0].svg.includes('>Star Catch<'), 'the first frame shows the title')
assert.ok(drawn.drawn[2].svg.includes('>Score 0<') && !drawn.drawn[2].svg.includes('Star Catch'), 'playing, the title is gone')
assert.ok(drawn.drawn.every(d => d.svg.includes('clip-path')), 'every frame is clipped to the surface')
const rec = createRecorder(100, 100)
G.paintGfx(rec.ctx, [rect.op], light, 100, 100, 10, 10)
assert.ok(rec.svg().includes('fill="' + light.ink.toLowerCase()) || rec.svg().includes('fill="' + light.ink), 'a shape is painted in its colour')
const nan = G.invokeStdGfx('circle', [NaN, 0, 5].map(n => new VeraNumberValue(n)).concat([new (loadVera('VeraInterpreter').VeraStringValue)('ink')]))
const blank = createRecorder(100, 100)
G.paintGfx(blank.ctx, [nan.op], light, 100, 100, 10, 10)
assert.equal((blank.svg().match(/<path [^>]*fill="#/g) || []).length, 1, 'a shape with a NaN is skipped: only the background is painted')

// A frame handler may ask the phone for something, as a ticker's handler may (a vibration on each breath): on the phone it
// is run as a handler, and the play check runs it the same way. Only draw() is refused.
const buzzing = `
@jsonable class AppState { n: number; buzzes: number; }
function init(): AppState { return {n: 0, buzzes: 0}; }
function onBuzzed(state: AppState, answer: string): AppState { return {n: state.n, buzzes: state.buzzes + 1}; }
function onFrame(state: AppState, ms: number): AppState {
  if (state.n === 30) { sdk.call("com.example.buzz/entry/EntryAbility/Buzz", [], "onBuzzed"); }
  return {n: state.n + 1, buzzes: state.buzzes};
}
function draw(state: AppState): gfx.Shape[] { return [gfx.circle(10 + state.n % 60, 50, 10, "accent")]; }
function view(state: AppState): ui.View { return ui.AppTheme("clean", "", [ui.Surface("default", 100, 100, "draw", "onFrame", "")]); }
`
assert.equal(playSurface(compileVeraSource(buzzing)), '', 'a frame handler that asks the phone for something plays')
const drawBuzz = buzzing.replace('function draw(state: AppState): gfx.Shape[] {', 'function draw(state: AppState): gfx.Shape[] {\n  if (state.n === 30) { sdk.call("com.example.buzz/entry/EntryAbility/Buzz", [], "onBuzzed"); }')
assert.match(playSurface(compileVeraSource(drawBuzz)), /sdk\.call may only be called from a handler/, 'draw() still may not')
// A circle that only grows and shrinks is a scene that moves (a breathing guide), not one that never changes.
const breathing = buzzing.replace('if (state.n === 30) { sdk.call("com.example.buzz/entry/EntryAbility/Buzz", [], "onBuzzed"); }', '')
  .replace('return [gfx.circle(10 + state.n % 60, 50, 10, "accent")];', 'return [gfx.circle(50, 50, 10 + state.n % 30, "accent")];')
assert.equal(playSurface(compileVeraSource(breathing)), '', 'a circle that only changes its size counts as moving')

// Gradients are colours: gfx.linear / gfx.radial write a short string a shape takes in place of a colour, and the painter
// turns it into a canvas gradient in the units the shape is drawn in.
const {VeraStringValue} = loadVera('VeraInterpreter')
const str = s => new VeraStringValue(s)
const nums = list => list.map(v => new VeraNumberValue(v))
const colours = list => new VeraArrayValue(list.map(str))
const sky = G.invokeStdGfx('linear', nums([0, 0, 0, 100]).concat([colours(['white', '#0f172a'])])).value
assert.equal(sky, 'lin:0,0,0,100:white|#0f172a', 'gfx.linear writes its points and colours')
assert.equal(G.invokeStdGfx('radial', nums([40.004, 40, 30]).concat([colours(['white', 'accent'])])).value, 'rad:40,40,30:white|accent',
  'gfx.radial rounds its numbers so a card frame stays short')
for (const [body, why] of [
  ['shapes.push(gfx.circle(5, 5, 5, gfx.linear(0, 0, 1, 1, ["white", "red"])));', 'an unknown colour in a gradient'],
  ['shapes.push(gfx.circle(5, 5, 5, gfx.radial(0, 0, 1, ["white"])));', 'a gradient of one colour'],
  ['shapes.push(gfx.blend("lighten", [gfx.circle(5, 5, 5, "ink")]));', 'a blend mode outside the set'],
]) {
  assert.ok(codes(program(body)).some(c => c.startsWith('E2112')), why + ' is refused')
}
const ball = G.invokeStdGfx('circle', nums([50, 50, 20]).concat([str(G.invokeStdGfx('radial', nums([44, 44, 26]).concat([colours(['white', 'accent'])])).value)]))
const ballRec = createRecorder(100, 100)
G.paintGfx(ballRec.ctx, [ball.op], light, 100, 100, 100, 100)
assert.match(ballRec.svg(), /<radialGradient id="g\d+" gradientUnits="userSpaceOnUse"[^>]* cx="44" cy="44" r="26">/, 'a radial colour is a radial gradient')
assert.match(ballRec.svg(), /fill="url\(#g\d+\)"/, 'the shape is filled with it')
const broken = G.invokeStdGfx('circle', nums([50, 50, 20]).concat([str('lin:1,2:white|accent')]))
const brokenRec = createRecorder(100, 100)
G.paintGfx(brokenRec.ctx, [broken.op], light, 100, 100, 100, 100)
assert.ok(brokenRec.svg().includes('fill="#ffffff"') && !brokenRec.svg().includes('Gradient'), 'a gradient that does not read is drawn in its first colour')

// Effects hold shapes like a group: a glow or shadow is a drop shadow, a blur a gaussian blur, a blend the element's mix mode.
// Their sizes are in surface units, so a glow inside a group scaled twice is twice as wide.
const disc = () => G.invokeStdGfx('circle', nums([10, 10, 5]).concat([str('accent')]))
const fx = (name, args) => G.invokeStdGfx(name, args)
const svgOf = (ops, scale = 1) => { const r = createRecorder(100 * scale, 100 * scale); G.paintGfx(r.ctx, ops, light, 100 * scale, 100 * scale, 100, 100); return r.svg() }
const glow = fx('glow', nums([4]).concat([str('#22d3ee'), new VeraArrayValue([disc()])]))
assert.match(svgOf([glow.op]), /stdDeviation="2"\/><feOffset dx="0" dy="0" result="moved"\/><feFlood flood-color="#22d3ee"/, 'a glow is a soft shadow with no offset')
assert.match(svgOf([glow.op], 2), /stdDeviation="4"/, 'and is as wide relative to the picture on a box twice the size')
const grouped = G.invokeStdGfx('group', nums([0, 0, 0, 2, 1]).concat([new VeraArrayValue([glow])]))
assert.match(svgOf([grouped.op]), /stdDeviation="4"/, 'a glow in a group scaled by 2 is twice as wide')
const shadow = fx('shadow', nums([1, 3, 2]).concat([str('#00000066'), new VeraArrayValue([disc()])]))
assert.match(svgOf([shadow.op]), /stdDeviation="1"\/><feOffset dx="1" dy="3" result="moved"\/><feFlood flood-color="#000000" flood-opacity="0.4"/, 'a shadow is moved and soft')
assert.match(svgOf([fx('blur', nums([3]).concat([new VeraArrayValue([disc()])])).op]), /<feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="shape"\/>/, 'a blur blurs')
assert.match(svgOf([fx('blend', [str('add'), new VeraArrayValue([disc()])]).op]), /mix-blend-mode:plus-lighter/, 'add is a lighter blend')
const plain = svgOf([fx('blend', [str('nonsense'), new VeraArrayValue([disc()])]).op])
assert.ok(!plain.includes('mix-blend-mode') && plain.includes('fill="#'), 'an unknown mode draws its shapes plain')
const back = G.decodeGfxOps(G.encodeGfxOps([shadow.op]))
assert.equal(back[0].kind, 'fx'); assert.equal(back[0].fx, 'shadow'); assert.equal(back[0].children.length, 1)
assert.equal(back[0].w, 1); assert.equal(back[0].h, 3); assert.equal(back[0].lineWidth, 2)
assert.equal(shadow.op.count, 2, 'an effect counts itself and its shapes against the frame limit')

// The example of all of them (examples/widget-rich.vera) compiles and paints them, in under a card's shape limit.
const rich = compileVeraSource(fs.readFileSync(path.join(__dirname, 'examples/widget-rich.vera'), 'utf8'))
const richVm = new VirtualMachine(deserializeVbc2(rich.vbc2), new UiHostEnvironment())
const richOps = G.decodeGfx(richVm.execute('scene', [richVm.execute('init')]))
const richSvg = svgOf(richOps)
for (const part of ['<linearGradient', '<radialGradient', '<feOffset', '<feGaussianBlur', 'mix-blend-mode:plus-lighter']) {
  assert.ok(richSvg.includes(part), 'the rich example draws ' + part)
}
assert.ok(richOps.reduce((sum, o) => sum + o.count, 0) <= 60, 'within a card picture\'s 60 shapes')
fs.mkdirSync(path.join(__dirname, 'proofs'), {recursive: true})
fs.writeFileSync(path.join(__dirname, 'proofs/widget-rich.svg'), svgOf(richOps, 3))

// A moving part (gfx.moving) is drawn at rest as its shapes are, and in a pose of its preset about its own pivot: a ball hanging 60 below
// a pivot at 50, 20, turned a quarter clockwise, is 60 to the left of it.
{
  const {MotionPose} = loadVera('VeraMotion')
  assert.ok(codes(program('shapes.push(gfx.moving("wiggle", 0, 50, 20, [gfx.circle(50, 80, 5, "ink")]));')).some(c => c.startsWith('E2112') && c.includes('ui.Motion style')),
    'a moving part takes a Motion preset')
  const ballOnRod = G.invokeStdGfx('circle', nums([50, 80, 5]).concat([str('accent')]))
  const part = G.invokeStdGfx('moving', [str('swing'), new VeraNumberValue(0), new VeraNumberValue(50), new VeraNumberValue(20), new VeraArrayValue([ballOnRod])])
  assert.equal(part.op.kind, 'moving'); assert.equal(part.op.fx, 'swing'); assert.equal(part.op.x, 50); assert.equal(part.op.y, 20); assert.equal(part.op.count, 2)
  const atRest = createRecorder(100, 100); G.paintGfx(atRest.ctx, [part.op], light, 100, 100, 100, 100)
  assert.ok(atRest.svg().includes('M55 80'), 'at rest the part is where it was drawn')
  const turned = new MotionPose(); turned.angle = 90
  const posed = createRecorder(100, 100); G.paintGfx(posed.ctx, [part.op], light, 100, 100, 100, 100, 1, false, false, [turned])
  assert.ok(posed.svg().includes('M-10 25'), 'turned a quarter about its pivot: ' + posed.svg().slice(0, 400))
  const moved = new MotionPose(); moved.dy = -10; moved.opacity = 0.5
  const lifted = createRecorder(100, 100); G.paintGfx(lifted.ctx, [part.op], light, 200, 200, 100, 100, 1, false, false, [moved])
  assert.ok(lifted.svg().includes('M110 150') && lifted.svg().includes('fill-opacity="0.5"'), 'a lift of 10 points on a box twice the size is 5 units, and it fades')
  const back = G.decodeGfxOps(G.encodeGfxOps([part.op]))[0]
  assert.deepEqual([back.kind, back.fx, back.x, back.y, back.children.length], ['moving', 'swing', 50, 20, 1], 'a part survives the card frame')
  // A trigger that is not a number keeps the part still; it does not take it out of the picture, at rest, inside a group or in a pose.
  const nanPart = G.invokeStdGfx('moving', [str('swing'), new VeraNumberValue(NaN), new VeraNumberValue(50), new VeraNumberValue(20), new VeraArrayValue([ballOnRod])])
  const nanRest = createRecorder(100, 100); G.paintGfx(nanRest.ctx, [nanPart.op], light, 100, 100, 100, 100)
  assert.ok(nanRest.svg().includes('M55 80'), 'a part whose trigger is NaN is drawn at rest')
  const grouped = G.invokeStdGfx('group', nums([0, 0, 0, 1, 1]).concat([new VeraArrayValue([nanPart])]))
  const nanGroup = createRecorder(100, 100); G.paintGfx(nanGroup.ctx, [grouped.op], light, 100, 100, 100, 100)
  assert.ok(nanGroup.svg().includes('M55 80'), 'and inside a group')
  const nanPosed = createRecorder(100, 100); G.paintGfx(nanPosed.ctx, [nanPart.op], light, 100, 100, 100, 100, 1, false, false, [turned])
  assert.ok(nanPosed.svg().includes('M-10 25'), 'and in a pose')
}

// A drift (gfx.drift) is a tile the size of the surface that slides on and on: drawn at rest, and one tile either side so it joins up; with a
// clock it has moved by the share of its period that has passed (slow is 8 pages of 1.05 s for the whole width).
{
  for (const [body, why] of [['shapes.push(gfx.drift("sideways", "slow", [gfx.circle(5, 5, 5, "ink")]));', 'a direction outside the set'],
      ['shapes.push(gfx.drift("left", "zippy", [gfx.circle(5, 5, 5, "ink")]));', 'a speed outside the set']]) {
    assert.ok(codes(program(body)).some(c => c.startsWith('E2112') && c.includes('gfx.drift')), why + ' is refused')
  }
  const dot = G.invokeStdGfx('circle', nums([10, 50, 5]).concat([str('accent')]))
  const strip = G.invokeStdGfx('drift', [str('left'), str('slow'), new VeraArrayValue([dot])])
  assert.deepEqual([strip.op.kind, strip.op.fx, strip.op.text, strip.op.count], ['drift', 'left', 'slow', 2])
  const still = createRecorder(100, 100); G.paintGfx(still.ctx, [strip.op], light, 100, 100, 100, 100)
  for (const start of ['M-85 50', 'M15 50', 'M115 50']) assert.ok(still.svg().includes(start), 'the tile and its copies either side: ' + start)
  const quarter = 8 * 1050 / 4
  const moved = createRecorder(100, 100); G.paintGfx(moved.ctx, [strip.op], light, 100, 100, 100, 100, 1, false, false, [], quarter)
  assert.ok(moved.svg().includes('M-10 50'), 'a quarter of its period on, a slow drift left has gone a quarter of the width')
  const down = G.invokeStdGfx('drift', [str('down'), str('fast'), new VeraArrayValue([dot])])
  const fallen = createRecorder(100, 100); G.paintGfx(fallen.ctx, [down.op], light, 100, 100, 100, 100, 1, false, false, [], 2 * 1050 / 2)
  assert.ok(fallen.svg().includes('M15 0') || fallen.svg().includes('M15 100'), 'half its period on, a fast drift down has gone half the height')
  assert.equal(G.decodeGfxOps(G.encodeGfxOps([strip.op]))[0].text, 'slow', 'a drift survives the card frame')
}

// A sector (gfx.sector) is a filled wedge: from the centre out along its start, round its rim clockwise, and closed. Start 90 is three
// o'clock, so a quarter from there ends at six; a whole turn is a disc.
{
  const wedge = G.invokeStdGfx('sector', nums([50, 50, 40, 90, 90]).concat([str('accent')]))
  assert.deepEqual([wedge.op.kind, wedge.op.r, wedge.op.start, wedge.op.sweep, wedge.op.count], ['sector', 40, 90, 90, 1])
  const svg = svgOf([wedge.op])
  assert.match(svg, /d="M50 50 L90 50 A40 40 0 0 1 50 90 Z" fill="#/, 'a quarter from three o\'clock is a closed wedge to six: ' + svg.slice(0, 500))
  const back = G.decodeGfxOps(G.encodeGfxOps([wedge.op]))[0]
  assert.deepEqual([back.kind, back.x, back.y, back.r, back.start, back.sweep, back.color], ['sector', 50, 50, 40, 90, 90, 'accent'], 'a sector survives the card frame')
  const whole = svgOf([G.invokeStdGfx('sector', nums([50, 50, 40, 0, 360]).concat([str('accent')])).op])
  assert.match(whole, /d="M50 50 L50 10 A40 40 0 0 1 50 90 A40 40 0 0 1 50 10 Z"/, 'a whole turn is a disc, drawn in two halves')
  const back2 = svgOf([G.invokeStdGfx('sector', nums([50, 50, 40, 0, -90]).concat([str('accent')])).op])
  assert.match(back2, /d="M50 50 L50 10 A40 40 0 0 0 10 50 Z"/, 'a negative sweep runs anticlockwise')
  assert.ok(!svgOf([G.invokeStdGfx('sector', nums([50, 50, 0, 0, 90]).concat([str('accent')])).op]).includes('M50 50 L'), 'a sector of no radius is not drawn')
  // The wheel of the Make widget prompt's example: six slices that meet, turned about the centre by gfx.moving.
  const slices = []
  for (let i = 0; i < 6; i++) slices.push(G.invokeStdGfx('sector', nums([50, 52, 40, i * 60, 60]).concat([str('accent')])))
  const wheelSvg = svgOf(slices.map(v => v.op))
  assert.equal((wheelSvg.match(/d="M50 52 L[^"]* Z"/g) || []).length, 6, 'six slices, each a closed wedge')
  assert.ok(wheelSvg.includes('L50 12 A40 40 0 0 1 84.64 32 Z') && wheelSvg.includes('L84.64 32 A40 40 0 0 1 84.64 72 Z'), 'each starting where the last ended')
}

// A repeat (gfx.repeat) draws its shapes once for every copy, each moved by its column and row; it is written once (a card counts its
// shapes once), painted every time (the app's frame limit counts the copies), and makes at most 400 copies.
{
  const dot = () => G.invokeStdGfx('circle', nums([5, 5, 2]).concat([str('accent')]))
  const grid = G.invokeStdGfx('repeat', nums([3, 2, 10, 20]).concat([new VeraArrayValue([dot(), dot()])]))
  assert.deepEqual([grid.op.kind, grid.op.w, grid.op.h, grid.op.x, grid.op.y, grid.op.count, grid.op.drawn], ['repeat', 3, 2, 10, 20, 3, 13],
    'three columns, two rows: written as three shapes, painted as thirteen')
  const svg = svgOf([grid.op])
  for (const at of ['M7 5', 'M17 5', 'M27 5', 'M7 25', 'M17 25', 'M27 25']) assert.ok(svg.includes(at), 'a copy at ' + at)
  assert.equal((svg.match(/<path d="M\d+ \d+ A2 2/g) || []).length, 12, 'two shapes in each of six copies')
  const back = G.decodeGfxOps(G.encodeGfxOps([grid.op]))[0]
  assert.deepEqual([back.kind, back.w, back.h, back.x, back.y, back.children.length], ['repeat', 3, 2, 10, 20, 2], 'a repeat survives the card frame')
  assert.equal(G.invokeStdGfx('repeat', nums([2.7, -1, 1, 1]).concat([new VeraArrayValue([dot()])])).op.drawn, 1, 'columns and rows are whole, none below zero')
  assert.throws(() => G.invokeStdGfx('repeat', nums([21, 20, 1, 1]).concat([new VeraArrayValue([dot()])])), e => e.trapCode === 'R0028' && /at most 400 copies/.test(e.message),
    'more than 400 copies trap')
  // Ten shapes in each of 400 copies is past what one frame of the app draws.
  const ten = Array.from({length: 10}, dot)
  assert.throws(() => G.invokeStdGfx('repeat', nums([20, 20, 1, 1]).concat([new VeraArrayValue(ten)])), e => e.trapCode === 'R0028', 'the app counts the copies')
  const tooMany = createRecorder(100, 100)
  const forged = G.decodeGfxOps(JSON.stringify([{k: 'repeat', w: 1000, h: 1000, x: 1, y: 1, o: [{k: 'circle', x: 1, y: 1, r: 1}]}]))
  G.paintGfx(tooMany.ctx, forged, light, 100, 100, 100, 100)
  assert.ok(!tooMany.svg().includes('A1 1'), 'a frame from elsewhere past the cap is not painted')
  // The bubble wrap example: a 12 x 12 sheet within a card picture's 60 shapes, painted in full.
  const bubbles = compileVeraSource(fs.readFileSync(path.join(__dirname, 'examples/widget-bubbles.vera'), 'utf8'))
  const bvm = new VirtualMachine(deserializeVbc2(bubbles.vbc2), new UiHostEnvironment())
  const bops = G.decodeGfx(bvm.execute('sheet', [bvm.execute('init')]))
  assert.equal(bops.reduce((sum, o) => sum + o.count, 0), 9, 'the repeat of two shapes and six popped bubbles')
  assert.equal(bops.reduce((sum, o) => sum + o.drawn, 0), 1 + 144 * 2 + 6)
  const sheet = createRecorder(360, 360)
  G.paintGfx(sheet.ctx, bops, light, 360, 360, 120, 120)
  assert.equal((sheet.svg().match(/<radialGradient/g) || []).length, 144, 'every bubble lit')
  fs.writeFileSync(path.join(__dirname, 'proofs/widget-bubbles.svg'), sheet.svg())
}

{
  const freezePayload = value => {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value)) freezePayload(child)
      Object.freeze(value)
    }
    return value
  }
  const retained = []
  const retain = shape => {
    freezePayload(shape.op)
    Object.freeze(shape)
    const nodes = []
    const visit = op => {
      assert.ok(Object.isFrozen(op) && Object.isFrozen(op.children) && Object.isFrozen(op.points))
      nodes.push({op, children: op.children, points: op.points, members: op.children.slice()})
      for (const child of op.children) visit(child)
    }
    visit(shape.op)
    retained.push({shape, op: shape.op, json: JSON.stringify(shape.op), nodes})
    return shape
  }
  const unchanged = () => {
    for (const saved of retained) {
      assert.equal(saved.shape.op, saved.op, 'retained shape keeps its op')
      assert.equal(JSON.stringify(saved.op), saved.json, 'retained payload including metadata is unchanged')
      for (const node of saved.nodes) {
        assert.equal(node.op.children, node.children, 'retained children array keeps its identity')
        assert.equal(node.op.points, node.points, 'retained points array keeps its identity')
        assert.equal(node.children.length, node.members.length)
        node.members.forEach((child, i) => assert.equal(node.children[i], child, 'retained child keeps its identity'))
      }
    }
  }
  const coordinates = freezePayload(new VeraArrayValue(nums([2, 3, 8, 3, 8, 9])))
  const coordinatesBefore = JSON.stringify(coordinates)
  const polygon = retain(fx('polygon', [coordinates, str('accent')]))
  const otherCoordinates = freezePayload(new VeraArrayValue(nums([-4, 1, 6, 1, 0, 5])))
  const otherPolygon = retain(fx('polygon', [otherCoordinates, str('ink')]))
  assert.notEqual(otherPolygon.op.points, polygon.op.points, 'successive retained polygons own per-call extracted arrays')
  assert.notEqual(otherPolygon.op.points, otherCoordinates.elements, 'second polygon does not borrow VM storage')
  assert.deepEqual(polygon.op.points, [2, 3, 8, 3, 8, 9], 'second extraction leaves first retained polygon unchanged')
  assert.deepEqual(otherPolygon.op.points, [-4, 1, 6, 1, 0, 5])
  assert.ok(otherPolygon.op.points.every(n => typeof n === 'number'), 'polygon extraction stores primitives, not VM wrappers')
  unchanged()
  const polyline = retain(fx('polyline', [coordinates, new VeraNumberValue(2), str('ink')]))
  assert.deepEqual(polygon.op.points, [2, 3, 8, 3, 8, 9])
  assert.deepEqual(polyline.op.points, [2, 3, 8, 3, 8, 9])
  assert.equal(polyline.op.lineWidth, 2)
  assert.notEqual(polygon.op.points, coordinates.elements, 'numeric points are copied out of VM values')
  assert.notEqual(polyline.op.points, polygon.op.points, 'each point constructor owns its numeric array')
  const children = Object.freeze(new VeraArrayValue(Object.freeze([polygon, polyline, polygon])))
  const nested = retain(fx('group', nums([10, 20, 0, 2, 0.5]).concat([children])))
  assert.deepEqual([nested.op.count, nested.op.drawn, nested.op.depth], [4, 4, 1])
  assert.notEqual(nested.op.children, children.elements)
  assert.equal(nested.op.children[0], polygon.op)
  assert.equal(nested.op.children[1], polyline.op)
  assert.equal(nested.op.children[2], polygon.op, 'repeated children retain the same op, not clones')
  const input = Object.freeze(new VeraArrayValue(Object.freeze([nested, polygon])))
  const cases = [
    ['group', nums([3, 4, 90, 2, 0.25]), {kind: 'group', x: 3, y: 4, start: 90, r: 2, size: 0.25}, /d="M-49 32 L-49 56 L-73 56 Z"/],
    ['glow', [new VeraNumberValue(4), str('#22d3ee')], {kind: 'fx', fx: 'glow', lineWidth: 4, color: '#22d3ee'}, /stdDeviation="2"/],
    ['shadow', nums([1, 3, 2]).concat([str('#00000066')]), {kind: 'fx', fx: 'shadow', w: 1, h: 3, lineWidth: 2, color: '#00000066'}, /<feOffset dx="1" dy="3"/],
    ['blur', nums([3]), {kind: 'fx', fx: 'blur', lineWidth: 3}, /stdDeviation="1.5"/],
    ['blend', [str('add')], {kind: 'fx', fx: 'add'}, /mix-blend-mode:plus-lighter/],
    ['moving', [str('swing')].concat(nums([7, 50, 20])), {kind: 'moving', fx: 'swing', sweep: 7, x: 50, y: 20}, /d="M14 26 L26 26 L26 38 Z"/],
    ['drift', [str('left'), str('slow')], {kind: 'drift', fx: 'left', text: 'slow'}, /d="M-86 26 L-74 26 L-74 38 Z"/],
    ['repeat', nums([2, 3, 10, 20]), {kind: 'repeat', w: 2, h: 3, x: 10, y: 20}, /d="M24 66 L36 66 L36 78 Z"/],
  ]
  const outputs = cases.map(([name, args, expected, painted]) => {
    const result = retain(fx(name, args.concat([input])))
    assert.notEqual(result, nested, name + ' returns a new shape')
    assert.notEqual(result.op, nested.op, name + ' returns a new parent op')
    assert.notEqual(result.op.children, input.elements, name + ' makes a new children list')
    assert.notEqual(result.op.children, nested.op.children)
    assert.equal(result.op.children.length, 2)
    assert.equal(result.op.children[0], nested.op, name + ' retains the nested op')
    assert.equal(result.op.children[1], polygon.op, name + ' retains the leaf op')
    for (const [key, value] of Object.entries(expected)) assert.equal(result.op[key], value, name + '.' + key)
    assert.deepEqual([result.op.count, result.op.drawn, result.op.depth], [6, name === 'repeat' ? 31 : 6, 2])
    const svg = svgOf(Object.freeze([result.op]))
    assert.match(svg, painted, name + ' paints the expected geometry or effect from frozen retained children')
    assert.ok(svg.includes('stroke="' + G.gfxColor(light, 'ink') + '"'), name + ' also paints the nested polyline')
    if (name === 'group') assert.ok(svg.includes('fill-opacity="0.13"'), 'group alpha composes with retained alpha, rounded by the recorder')
    if (name === 'repeat') assert.equal(svg.split(' Z" fill="' + G.gfxColor(light, 'accent') + '"').length - 1, 18, 'six copies each paint three polygons')
    const encoded = G.encodeGfxOps(Object.freeze([result.op]))
    const back = freezePayload(G.decodeGfxOps(encoded))
    assert.equal(back.length, 1, name + ' survives wire decoding')
    assert.equal(G.encodeGfxOps(back), encoded, name + ' round trips its packed semantics')
    assert.equal(svgOf(back), svg, name + ' round trips its painted semantics')
    unchanged()
    return result
  })
  assert.equal(new Set(outputs.map(shape => shape.op.children)).size, cases.length, 'functional wrappers do not share parent arrays')
  const frame = Object.freeze(new VeraArrayValue(Object.freeze([nested, new VeraNumberValue(99), polygon])))
  const decoded = G.decodeGfx(frame)
  assert.equal(decoded.length, 2, 'decode filters non-shapes without discarding valid retained shapes')
  assert.equal(decoded[0], nested.op, 'decode aliases the retained group op')
  assert.equal(decoded[1], polygon.op, 'decode aliases the retained points op')
  assert.notEqual(decoded, frame.elements)
  const decodedAgain = G.decodeGfx(frame)
  assert.notEqual(decodedAgain, decoded, 'each decode allocates its outer list')
  decodedAgain.pop()
  assert.equal(frame.elements.length, 3)
  assert.equal(decoded.length, 2)
  Object.freeze(decoded)
  unchanged()
  const packedPolygon = {k: 'polygon', c: 'accent', p: [2, 3, 8, 3, 8, 9]}
  const expectedPacked = [{k: 'group', x: 10, y: 20, r: 2, z: 0.5, o: [packedPolygon,
    {k: 'polyline', l: 2, c: 'ink', p: [2, 3, 8, 3, 8, 9]}, packedPolygon]}, packedPolygon]
  const encoded = G.encodeGfxOps(decoded)
  assert.deepEqual(JSON.parse(encoded), expectedPacked, 'serialization carries actual nested geometry, order, style and duplicate children')
  assert.equal(G.encodeGfxOps(decoded), encoded, 'serialization is deterministic on the retained frame')
  const back = freezePayload(G.decodeGfxOps(encoded))
  assert.equal(back.length, 2)
  const detached = (copy, original) => {
    assert.notEqual(copy, original, 'wire decoding allocates a new op')
    assert.notEqual(copy.children, original.children, 'wire decoding allocates children')
    assert.notEqual(copy.points, original.points, 'wire decoding allocates points')
    assert.deepEqual(copy.points, original.points)
    assert.equal(copy.children.length, original.children.length)
    copy.children.forEach((child, i) => detached(child, original.children[i]))
  }
  back.forEach((op, i) => detached(op, decoded[i]))
  assert.equal(G.encodeGfxOps(back), encoded, 'wire round trip preserves packed drawing semantics')
  assert.deepEqual([back[0].count, back[0].drawn, back[0].depth], [1, 1, 0], 'wire format does not preserve runtime accounting metadata')
  assert.equal(svgOf(back), svgOf(decoded), 'wire round trip paints the same frozen nested frame')
  assert.match(svgOf(back), /d="M14 26 L26 26 L26 38 Z"/, 'round trip is not an empty drawing')
  const mutableBack = G.decodeGfxOps(encoded)
  mutableBack[0].children[0].points[0] = 77
  mutableBack[0].children.pop()
  assert.equal(mutableBack[0].children[2], undefined)
  assert.equal(mutableBack[1].points[0], 2, 'wire duplicates are detached from each other')
  assert.equal(polygon.op.points[0], 2, 'editing wire-decoded points cannot change retained input')
  assert.equal(nested.op.children.length, 3, 'editing wire-decoded children cannot change retained input')
  const {pointsOf, coloursOf} = loadVera('VeraMovingPart')
  const matrix = Object.freeze([0, 1, -1, 0, 100, 5])
  const transformed = [-1, -2]
  pointsOf(nested.op, matrix, transformed)
  assert.deepEqual(transformed, [-1, -2, 80, 15, 74, 19, 74, 31, 62, 31,
    74, 19, 74, 31, 62, 31, 74, 19, 74, 31, 62, 31], 'pointsOf appends transformed group origin and all retained vertices')
  assert.deepEqual(matrix, [0, 1, -1, 0, 100, 5], 'pointsOf does not modify its input matrix')
  const palette = ['surface']
  assert.equal(coloursOf(decoded, palette), palette, 'coloursOf writes the supplied output accumulator')
  assert.deepEqual(palette, ['surface', 'accent', 'ink'], 'coloursOf visits nested children and deduplicates colours')
  const {MotionPose} = loadVera('VeraMotion')
  const pose = freezePayload(Object.assign(new MotionPose(), {dx: 5, dy: -3, opacity: 0.5}))
  const posed = createRecorder(100, 100)
  G.paintGfx(posed.ctx, Object.freeze([outputs[5].op]), light, 100, 100, 100, 100, 1, false, false, Object.freeze([pose]))
  assert.match(posed.svg(), /d="M19 23 L31 23 L31 35 Z"/, 'a frozen moving payload paints translated retained vertices')
  assert.ok(posed.svg().includes('fill-opacity="0.25"'), 'moving opacity composes with group alpha')
  const drifting = createRecorder(100, 100)
  G.paintGfx(drifting.ctx, Object.freeze([outputs[6].op]), light, 100, 100, 100, 100, 1, false, false, [], 2100)
  assert.match(drifting.svg(), /d="M-11 26 L1 26 L1 38 Z"/, 'clocked drift paints retained points a quarter tile left')
  assert.equal(JSON.stringify(coordinates), coordinatesBefore, 'point construction and consumers leave VM coordinate inputs unchanged')
  unchanged()
}

console.log('gfx-check ok')
}
