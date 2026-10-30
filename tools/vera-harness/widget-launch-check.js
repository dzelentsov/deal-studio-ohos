'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = process.env.VERA_TYPESCRIPT_PATH ? require(process.env.VERA_TYPESCRIPT_PATH) : require('typescript');
const { loadVera, sourceRoot } = require('./source-loader');
const navigation = loadVera('AppNavigation');
const file = path.join(sourceRoot, 'entryability/EntryAbility.ets');
const source = fs.readFileSync(file, 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'EntryAbility.ts',
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  reportDiagnostics: true
});
assert.deepEqual((compiled.diagnostics || []).filter(d => d.category === ts.DiagnosticCategory.Error), [],
  'EntryAbility must transpile without syntax errors');
const widget = fs.readFileSync(path.join(sourceRoot, 'widget/pages/WidgetCard.ets'), 'utf8');
assert.match(widget, /'action': 'router'/);
assert.match(widget, /'abilityName': 'EntryAbility'/);
assert.match(widget, /'params':\s*\{\s*'projectId': project\['id'\],\s*'veraRun': '1'\s*\}/);

const project = { id: 'project-1' };
const runnable = { id: 'version-2', vbc2: 'fixture-bytecode' };
const pause = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function params(values = {}) {
  return { projectId: '', versionId: '', vbc2: '', shortcutMode: '', launchError: '',
    baseVersionId: '', chatId: '', ...values };
}
const library = () => ({ name: 'library', param: params() });
const projectPath = (id = project.id) => ({ name: 'project', param: params({ projectId: id }) });
const runnerPath = (id = project.id, version = runnable) => ({ name: 'runner',
  param: params({ projectId: id, versionId: version.id, vbc2: version.vbc2 }) });
const isolatedPath = (values = {}) => ({ name: 'isolatedRunner', param: params({ shortcutMode: 'true', ...values }) });
const snapshot = value => JSON.parse(JSON.stringify(value));

function fixture(options = {}) {
  const errors = [], reads = [], events = [], stages = [];
  const store = {
    init(dir) { reads.push(['init', dir]); },
    getProject(id) { reads.push(['project', id]); return options.missingProject ? null : { ...project, id }; },
    getLatestRunnableVersion(id) { reads.push(['version', id]); return options.noBytecode ? null : runnable; }
  };
  class LocalStorage {
    constructor() { this.values = new Map(); }
    setOrCreate(key, value) { this.values.set(key, value); }
    get(key) { return this.values.get(key); }
  }
  const dependencies = {
    '@kit.AbilityKit': { UIAbility: class {} },
    '@kit.ArkTS': {},
    '@kit.PerformanceAnalysisKit': { hilog: { info() {}, error(...args) { errors.push(args); } } },
    '../vera/AppNavigation': navigation,
    '../vera/ProjectStore': { store },
    '../vera/VeraPermissions': {
      requestCalendarPermissions: async () => {}, requestMicrophonePermission: async () => {}
    }
  };
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', 'LocalStorage', compiled.outputText)(name => {
    if (Object.hasOwn(dependencies, name)) { return dependencies[name]; }
    if (name === '@kit.ArkUI' || name.startsWith('../vera/')) { return {}; }
    throw Error('Unexpected ability dependency: ' + name);
  }, mod, mod.exports, LocalStorage);
  const ability = new mod.exports.default();
  ability.context = { filesDir: '/fixture/files' };

  function createStage(normalFullScreen = false) {
    const calls = [], windowCalls = [], toasts = [], gates = {};
    const stack = {
      paths: [{ name: 'previous', param: { stale: true } }],
      setPathStack() {
        assert.fail('Fresh destinations must use pushPath to initialise native indices');
      },
      clear(animated) {
        this.paths = [];
        const call = { paths: [], animated };
        calls.push(call);
        events.push(['paths', stages.indexOf(stage), call]);
      },
      pushPath(info, animated) {
        const call = calls[calls.length - 1];
        assert(call, 'replacement must clear the previous stack before pushing');
        assert.equal(animated, false, 'external launches must not animate');
        assert.equal(call.animated, false);
        info.index = -1;
        const { index, ...route } = info;
        assert.equal(index, -1);
        this.paths.push(snapshot(route));
        call.paths = snapshot(this.paths);
      }
    };
    async function apply(type, value) {
      windowCalls.push([type, snapshot(value)]);
      events.push([type, stages.indexOf(stage), snapshot(value)]);
      const gate = gates[type];
      delete gates[type];
      if (gate) { await gate.promise; }
      if (type === 'layout') { mainWindow.fullScreen = value; }
      else { mainWindow.bars = value.slice(); }
    }
    const mainWindow = {
      fullScreen: normalFullScreen,
      bars: ['status', 'navigation'],
      getWindowProperties: () => ({ isLayoutFullScreen: mainWindow.fullScreen }),
      getUIContext: () => ({ getPromptAction: () => ({ showToast(value) {
        toasts.push(value);
        events.push(['toast', stages.indexOf(stage), value]);
      } }) }),
      setWindowLayoutFullScreen: value => apply('layout', value),
      setWindowSystemBarEnable: value => apply('bars', value)
    };
    const stage = {
      calls, windowCalls, toasts, stack, mainWindow,
      getMainWindowSync: () => mainWindow,
      loadContent(page, storage, callback) {
        assert.equal(page, 'pages/AppShell');
        this.session = storage.get('navigationSession');
        assert(this.session instanceof navigation.AppNavigationSession);
        this.loaded = callback;
      },
      holdNext(type) { assert.equal(gates[type], undefined); return (gates[type] = deferred()); }
    };
    stages.push(stage);
    ability.onWindowStageCreate(stage);
    return stage;
  }
  async function idle() {
    for (let i = 0; i < 30; i++) {
      await pause();
      assert.deepEqual(errors, [], 'ability must not log errors');
      if (ability.routeDrainGeneration === -1) { return; }
    }
    assert.fail('route drain did not become idle');
  }
  async function launch(want) {
    ability.onNewWant(want, {});
    const request = ability.pendingRoute;
    assert(request, 'launch must queue a route');
    await idle();
    assert.equal(ability.pendingRoute, null, 'the current route must be cleared');
    assert.equal(ability.lastDestination, request, 'the committed destination must be the current request');
    return request;
  }
  return { ability, createStage, idle, launch, reads, errors, events, stages };
}
async function ready(options = {}) {
  const f = fixture(options);
  f.stage = f.createStage(options.normalFullScreen || false);
  f.stage.loaded({});
  f.stage.session.attach(f.stage.stack);
  await f.idle();
  assert.deepEqual(f.stage.calls, [{ paths: [library()], animated: false }]);
  f.stage.calls.length = 0;
  f.stage.windowCalls.length = 0;
  f.events.length = 0;
  return f;
}
function assertCommit(f, stage, paths, isolated, normalFullScreen = false) {
  assert.deepEqual(stage.calls, [{ paths, animated: false }]);
  assert.deepEqual(stage.stack.paths, paths, 'the complete previous stack must be replaced');
  assert.deepEqual(stage.windowCalls, [
    ['layout', isolated || normalFullScreen], ['bars', isolated ? [] : ['status', 'navigation']]
  ]);
  assert.equal(stage.mainWindow.fullScreen, isolated || normalFullScreen);
  assert.deepEqual(stage.mainWindow.bars, isolated ? [] : ['status', 'navigation']);
  assert.equal(f.ability.pendingRoute, null);
  assert.deepEqual(f.errors, []);
}
let passed = 0;
async function test(name, run) {
  await run();
  passed++;
  console.log('PASS ' + name);
}

(async () => {
  await test('Navigation receives the raw stack without notifying observed state during render', async () => {
    const shell = fs.readFileSync(path.join(sourceRoot, 'pages/AppShell.ets'), 'utf8');
    assert.match(shell, /import\s*\{[^}]*\bUIUtils\b[^}]*\}\s*from\s*'@kit\.ArkUI'/);
    const boundary = shell.match(/^\s*Navigation\((.+)\)\s*\{/m);
    assert(boundary, 'AppShell must construct Navigation with its stack');
    let rendering = true;
    let notifications = 0;
    const raw = { setNativeStack(value) { this.nativeStack = value; } };
    const observed = new Proxy(raw, { set(target, key, value) {
      notifications++;
      assert.equal(rendering, false, 'observed stack must not change during Navigation creation');
      return Reflect.set(target, key, value);
    } });
    const UIUtils = { getTarget(value) { return value === observed ? raw : value; } };
    const argument = new Function('UIUtils', 'return (' + boundary[1] + ');')
      .call({ pathStack: observed }, UIUtils);
    assert.equal(argument, raw, 'the native boundary must not receive the observed proxy');
    const nativeStack = {};
    argument.setNativeStack(nativeStack);
    rendering = false;
    assert.equal(raw.nativeStack, nativeStack);
    assert.equal(notifications, 0);
  });
  await test('Project Code and Metrics panels share the destination content stack', async () => {
    const source = fs.readFileSync(path.join(sourceRoot, 'pages/ProjectPage.ets'), 'utf8');
    assert.match(source, /NavDestination\(\)\s*\{\s*Stack\(\)\s*\{\s*this\.pageContent\(\)\s*this\.pageOverlays\(\)\s*\}/);
    assert.doesNotMatch(source, /\.overlay\(/);
    const state = { viewedSource: '', viewedPrompt: '', viewedVersionNumber: 0,
      viewedMetricsVersion: null, viewedMetricsNumber: 0 };
    const version = { source: 'app source', prompt: 'version request', metrics: null };
    for (const [handler, panel] of [['viewSource', 'sourceOverlay'], ['viewMetrics', 'metricsOverlay']]) {
      const body = source.match(new RegExp('private ' + handler + '\\([^)]*\\): void \\{([^}]+)\\}'));
      assert(body, handler + ' must exist');
      const condition = source.match(new RegExp('if \\(([^\\n]+)\\) \\{\\s*this\\.' + panel + '\\(\\)'));
      assert(condition, panel + ' must be rendered conditionally');
      const visible = new Function('return (' + condition[1] + ');');
      assert.equal(visible.call(state), false);
      new Function('v', 'versionNumber', body[1]).call(state, version, 3);
      assert.equal(visible.call(state), true, handler + ' must reveal its panel');
    }
    assert.equal(state.viewedSource, version.source);
    assert.equal(state.viewedPrompt, version.prompt);
    assert.equal(state.viewedVersionNumber, 3);
    assert.equal(state.viewedMetricsVersion, version, 'metrics without saved data must still open');
    assert.equal(state.viewedMetricsNumber, 3);
  });
  await test('Library overlays and context menus receive deferred builders', async () => {
    const bindings = [
      ['Index', 'overlay', 'createOverlay'],
      ['Index', 'bindContextMenu', 'rowMenu']
    ];
    for (const [page, attribute, builder] of bindings) {
      const source = fs.readFileSync(path.join(sourceRoot, 'pages/' + page + '.ets'), 'utf8');
      const line = source.split('\n').find(line => line.trim().startsWith('.' + attribute + '('));
      assert(line, page + ' must retain ' + attribute);
      const calls = [];
      const component = { [builder](...args) { calls.push(args); } };
      let callback;
      const receiver = { [attribute](value) { callback = value; } };
      new Function('receiver', 'row', 'ResponseType', 'receiver' + line.trim() + ';')
        .call(component, receiver, { project: { id: 'project-1' } }, { LongPress: 1 });
      assert.deepEqual(calls, [], page + ' must not build overlay or menu children on the destination stack');
      assert.equal(typeof callback, 'function', page + ' must pass a builder callback');
      callback();
      assert.deepEqual(calls, [builder === 'rowMenu' ? ['project-1'] : []]);
    }
  });
  await test('Returning to a missing library uses pushPath for the fresh root', async () => {
    const operations = [];
    const stack = {
      getAllPathName: () => ['project'],
      size: () => 1,
      setPathStack() { assert.fail('Fresh library must not use setPathStack'); },
      clear(animated) { operations.push(['clear', animated]); },
      pushPath(info, animated) { operations.push(['push', snapshot(info), animated]); }
    };
    navigation.returnToLibrary(stack);
    assert.deepEqual(operations, [['clear', false], ['push', library(), false]]);
  });
  const cases = [
    ['A widget row with a runnable version opens the runner over its project', {},
      { projectId: ' project-1 ', veraRun: '1' }, 'run', [library(), projectPath(), runnerPath()], false],
    ['A widget row with no runnable version opens the project', { noBytecode: true },
      { projectId: project.id, veraRun: '1' }, 'run', [library(), projectPath()], false],
    ['A widget row for a deleted project goes home and says so', { missingProject: true },
      { projectId: project.id, veraRun: '1' }, 'run', [library()], false],
    ['An ordinary project launch does not run', {},
      { projectId: project.id }, 'project', [library(), projectPath()], false],
    ['A home-screen shortcut runs on its own', {},
      { projectId: project.id, launchMode: 'runLatest', veraRun: '1' }, 'shortcut',
      [isolatedPath({ projectId: project.id, versionId: runnable.id, vbc2: runnable.vbc2 })], true],
    ['An isolated shortcut for a deleted project shows its launch error without a toast', { missingProject: true },
      { projectId: project.id, launchMode: 'runLatest' }, 'shortcut',
      [isolatedPath({ launchError: 'Mini-app no longer exists.' })], true],
    ['An isolated shortcut without bytecode shows its launch error without a toast', { noBytecode: true },
      { projectId: project.id, launchMode: 'runLatest' }, 'shortcut',
      [isolatedPath({ projectId: project.id, launchError: 'Run is unavailable: no version has compiled code.' })], true]
  ];
  for (const [name, options, parameters, kind, paths, isolated] of cases) {
    await test(name, async () => {
      const f = await ready(options);
      const request = await f.launch({ parameters });
      assert.equal(request.kind, kind);
      assert.equal(request.projectId, project.id);
      assert.equal(request.revision, f.ability.launchRevision);
      assertCommit(f, f.stage, paths, isolated);
      assert.deepEqual(f.reads, [
        ['init', '/fixture/files'], ['project', project.id],
        ...(!options.missingProject && kind !== 'project' ? [['version', project.id]] : [])
      ]);
      assert.deepEqual(f.stage.toasts, options.missingProject && !isolated ? [{ message: 'Mini-app no longer exists.' }] : []);
      assert.deepEqual(f.events.map(event => event[0]), options.missingProject && !isolated ?
        ['layout', 'bars', 'paths', 'toast'] : ['layout', 'bars', 'paths']);
    });
  }

  for (const normalFullScreen of [false, true]) {
    await test('Home replaces the isolated stack and restores normal fullscreen=' + normalFullScreen + ' and bars', async () => {
      const f = await ready({ normalFullScreen });
      await f.launch({ parameters: { projectId: project.id, launchMode: 'runLatest' } });
      assert.equal(f.stage.mainWindow.fullScreen, true);
      assert.deepEqual(f.stage.mainWindow.bars, []);
      const wants = [{ action: 'action.system.home' }, { entities: ['entity.system.home'] }, {}];
      for (const want of wants) {
        f.stage.calls.length = 0;
        f.stage.windowCalls.length = 0;
        f.reads.length = 0;
        const request = await f.launch(want);
        assert.equal(request.kind, 'home');
        assert.equal(request.projectId, '');
        assertCommit(f, f.stage, [library()], false, normalFullScreen);
        assert.deepEqual(f.stage.toasts, []);
        assert.deepEqual(f.reads, []);
      }
    });
  }

  for (const phase of ['layout', 'bars']) {
    await test('Latest launch wins while async window ' + phase + ' is pending', async () => {
      const f = await ready();
      const gate = f.stage.holdNext(phase);
      f.ability.onNewWant({ parameters: { projectId: project.id, launchMode: 'runLatest' } }, {});
      const stale = f.ability.pendingRoute;
      await pause();
      assert.deepEqual(f.stage.windowCalls, [['layout', true], ...(phase === 'bars' ? [['bars', []]] : [])]);
      assert.equal(f.ability.routeDrainGeneration, f.ability.windowStageGeneration);
      assert.deepEqual(f.stage.calls, []);
      f.ability.onNewWant({ parameters: { projectId: 'project-2', veraRun: '1' } }, {});
      const latest = f.ability.pendingRoute;
      assert(latest.revision > stale.revision);
      assert.equal(f.ability.routeIsCurrent(f.ability.windowStageGeneration, stale.revision), false);
      assert.equal(f.ability.lastDestination.kind, 'home');
      assert.deepEqual(f.stage.calls, []);
      gate.resolve();
      await f.idle();
      const paths = [library(), projectPath('project-2'), runnerPath('project-2')];
      assert.deepEqual(f.stage.calls, [{ paths, animated: false }]);
      assert.deepEqual(f.stage.stack.paths, paths);
      assert.deepEqual(f.stage.windowCalls, [
        ['layout', true], ...(phase === 'bars' ? [['bars', []]] : []),
        ['layout', false], ['bars', ['status', 'navigation']]
      ]);
      assert.equal(f.stage.mainWindow.fullScreen, false);
      assert.deepEqual(f.stage.mainWindow.bars, ['status', 'navigation']);
      assert.equal(f.ability.pendingRoute, null);
      assert.equal(f.ability.lastDestination, latest);
      assert.deepEqual(f.stage.toasts, []);
    });
  }

  for (const first of ['content', 'stack']) {
    await test('Launch waits for both content and NavPathStack readiness (' + first + ' first)', async () => {
      const f = fixture();
      f.ability.onNewWant({ parameters: { projectId: project.id, veraRun: '1' } }, {});
      const request = f.ability.pendingRoute;
      assert.equal(f.ability.routeDrainGeneration, -1);
      const stage = f.createStage();
      const generation = f.ability.windowStageGeneration;
      assert.equal(f.ability.routeIsCurrent(generation, request.revision), false);
      if (first === 'content') { stage.loaded({}); }
      else { stage.session.attach(stage.stack); }
      await f.idle();
      assert.deepEqual(stage.calls, []);
      assert.deepEqual(stage.windowCalls, []);
      assert.equal(f.ability.pendingRoute, request);
      if (first === 'content') { stage.session.attach(stage.stack); }
      else { stage.loaded({}); }
      await f.idle();
      assertCommit(f, stage, [library(), projectPath(), runnerPath()], false);
      assert.equal(f.ability.lastDestination, request);
      assert.equal(f.ability.routeIsCurrent(generation, request.revision), true);
      stage.session.detach(stage.stack);
      assert.equal(f.ability.routeIsCurrent(generation, request.revision), false);
    });
  }

  await test('Stage invalidation rejects stale readiness and an old async drain cannot clear the replacement drain', async () => {
    const f = await ready();
    const old = f.stage;
    const oldGeneration = f.ability.windowStageGeneration;
    const oldReady = old.session.onReady;
    const oldGate = old.holdNext('layout');
    f.ability.onNewWant({ parameters: { projectId: project.id, launchMode: 'runLatest' } }, {});
    const request = f.ability.pendingRoute;
    f.ability.onWindowStageDestroy();
    assert.equal(f.ability.windowStageGeneration, oldGeneration + 1);
    assert.equal(f.ability.contentReady, false);
    assert.equal(f.ability.activeWindowStage, null);
    assert.equal(f.ability.navigationSession, null);
    assert.equal(old.session.pathStack, null);
    assert.equal(f.ability.routeDrainGeneration, -1);
    assert.equal(f.ability.pendingRoute, request);
    assert.equal(f.ability.routeIsCurrent(oldGeneration, request.revision), false);
    old.loaded({});
    oldReady();
    old.session.attach(old.stack);
    assert.equal(old.session.pathStack, null);
    assert.equal(f.ability.contentReady, false);
    const replacement = f.createStage();
    const newGate = replacement.holdNext('layout');
    old.loaded({});
    oldReady();
    assert.equal(f.ability.contentReady, false);
    replacement.loaded({});
    replacement.session.attach(replacement.stack);
    await Promise.resolve();
    const generation = f.ability.windowStageGeneration;
    assert.equal(f.ability.routeDrainGeneration, generation);
    oldGate.resolve();
    await pause();
    assert.equal(f.ability.routeDrainGeneration, generation);
    assert.equal(f.ability.pendingRoute, request);
    assert.deepEqual(old.calls, []);
    assert.deepEqual(old.windowCalls, [['layout', true]]);
    assert.deepEqual(replacement.calls, []);
    newGate.resolve();
    await f.idle();
    assertCommit(f, replacement,
      [isolatedPath({ projectId: project.id, versionId: runnable.id, vbc2: runnable.vbc2 })], true);
    assert.equal(f.ability.lastDestination, request);
    assert.deepEqual(old.calls, []);
  });

  await test('A recreated stage requeues the last committed destination with a fresh revision', async () => {
    const f = await ready();
    const committed = await f.launch({ parameters: { projectId: project.id, veraRun: '1' } });
    const old = f.stage;
    f.ability.onWindowStageDestroy();
    const replay = f.ability.pendingRoute;
    assert.notEqual(replay, committed);
    assert.equal(replay.kind, committed.kind);
    assert.equal(replay.projectId, committed.projectId);
    assert.equal(replay.revision, committed.revision + 1);
    const replacement = f.createStage(true);
    replacement.session.attach(replacement.stack);
    assert.deepEqual(replacement.calls, []);
    replacement.loaded({});
    await f.idle();
    assertCommit(f, replacement, [library(), projectPath(), runnerPath()], false, true);
    assert.equal(f.ability.lastDestination, replay);
    assert.equal(old.calls.length, 1);
    assert.equal(old.session.pathStack, null);
  });

  await test('Unrelated Wants preserve both a pending launch and the committed route', async () => {
    const f = await ready();
    const gate = f.stage.holdNext('layout');
    f.ability.onNewWant({ parameters: { projectId: project.id, veraRun: '1' } }, {});
    const request = f.ability.pendingRoute;
    const revision = f.ability.launchRevision;
    f.ability.onNewWant({ parameters: { unrelated: 'value' } }, {});
    assert.equal(f.ability.pendingRoute, request);
    assert.equal(f.ability.launchRevision, revision);
    gate.resolve();
    await f.idle();
    assertCommit(f, f.stage, [library(), projectPath(), runnerPath()], false);
    const paths = f.stage.stack.paths;
    for (const want of [{ action: 'custom.action' }, { entities: ['custom.entity'] }, { parameters: { unrelated: 'value' } }]) {
      f.ability.onNewWant(want, {});
      await f.idle();
      assert.equal(f.ability.pendingRoute, null);
      assert.equal(f.ability.launchRevision, revision);
      assert.equal(f.ability.lastDestination, request);
      assert.equal(f.stage.stack.paths, paths);
      assert.equal(f.stage.calls.length, 1);
      assert.equal(f.stage.windowCalls.length, 2);
    }
  });

  await test('Ability destruction clears pending and committed routes and invalidates its session', async () => {
    const f = await ready();
    const gate = f.stage.holdNext('layout');
    f.ability.onNewWant({ parameters: { projectId: project.id, launchMode: 'runLatest' } }, {});
    const revision = f.ability.launchRevision;
    f.ability.onDestroy();
    assert.equal(f.ability.pendingRoute, null);
    assert.equal(f.ability.lastDestination, null);
    assert.equal(f.ability.launchRevision, revision + 1);
    assert.equal(f.ability.contentReady, false);
    assert.equal(f.ability.activeWindowStage, null);
    assert.equal(f.ability.navigationSession, null);
    f.stage.loaded({});
    f.stage.session.attach(f.stage.stack);
    gate.resolve();
    await f.idle();
    assert.equal(f.stage.session.pathStack, null);
    assert.deepEqual(f.stage.calls, []);
    assert.deepEqual(f.stage.windowCalls, [['layout', true]]);
    assert.equal(f.ability.pendingRoute, null);
    assert.equal(f.ability.lastDestination, null);
  });
  console.log('PASS ' + passed + ' widget launch checks');
})().catch(error => { console.error(error); process.exitCode = 1; });
