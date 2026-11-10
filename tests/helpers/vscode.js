const path = require('path');
const Module = require('module');

class Uri {
  constructor(o) {
    Object.assign(this, { query: '', fragment: '', authority: '' }, o);
    this.fsPath = this.scheme === 'file' ? this.path : undefined;
  }
  static file(p) {
    return new Uri({ scheme: 'file', path: p });
  }
  static from(o) {
    return new Uri(o);
  }
  static parse(s) {
    const i = s.indexOf(':');
    return new Uri({ scheme: s.slice(0, i), path: s.slice(i + 1) });
  }
  with(change) {
    return new Uri({ ...this, ...change });
  }
  toString() {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
}

class EventEmitter {
  constructor() {
    this.listeners = [];
    this.event = (fn) => {
      this.listeners.push(fn);
      return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
    };
  }
  fire(value) {
    for (const l of this.listeners) l(value);
  }
  dispose() {}
}

class TreeItem {
  constructor(label, collapsibleState) {
    if (label instanceof Uri) {
      this.resourceUri = label;
      this.label = path.basename(label.path);
    } else this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
  appendCodeblock(s) {
    this.value += `\n\`\`\`\n${s}\n\`\`\`\n`;
    return this;
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(a, b, c, d) {
    this.start = a instanceof Position ? a : new Position(a, b);
    this.end = a instanceof Position ? b : new Position(c, d);
  }
}

class Disposable {
  constructor(fn) {
    this.dispose = fn || (() => {});
  }
  static from(...items) {
    return new Disposable(() => items.forEach((i) => i?.dispose?.()));
  }
}

const noop = { dispose() {} };
const event = () => noop;
const state = {
  config: {},
  secrets: new Map(),
  commands: new Map(),
  executed: [],
  trees: new Map(),
  answers: [],
  messages: [],
  clipboard: '',
  repos: [],
  activeEditor: undefined,
};

function configuration(section) {
  return {
    get: (key, def) => {
      const full = section ? `${section}.${key}` : key;
      return full in state.config ? state.config[full] : def;
    },
    update: async (key, value) => {
      state.config[section ? `${section}.${key}` : key] = value;
    },
    has: (key) => `${section}.${key}` in state.config,
    inspect: () => undefined,
  };
}

function nextAnswer(items) {
  const a = state.answers.shift();
  if (typeof a === 'function') return a(items);
  if (a !== undefined) return a;
  return Array.isArray(items) ? items.find((i) => i.kind !== -1) : undefined;
}

function makeRepo(root, branch = 'main') {
  return {
    rootUri: Uri.file(root),
    inputBox: { value: '' },
    state: {
      HEAD: { name: branch, commit: '0000000' },
      workingTreeChanges: [],
      indexChanges: [],
      mergeChanges: [],
      untrackedChanges: [],
      onDidChange: event,
    },
  };
}

const gitApi = {
  get repositories() {
    return state.repos;
  },
  getRepository: (uri) => state.repos.find((r) => uri?.fsPath && (uri.fsPath === r.rootUri.fsPath || uri.fsPath.startsWith(r.rootUri.fsPath + path.sep))),
  onDidOpenRepository: event,
};

const vscode = {
  Uri,
  EventEmitter,
  TreeItem,
  ThemeIcon,
  ThemeColor,
  MarkdownString,
  Position,
  Range,
  Selection: Range,
  Disposable,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  DecorationRangeBehavior: { OpenOpen: 0, ClosedClosed: 1, OpenClosed: 2, ClosedOpen: 3 },
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  CancellationTokenSource: class {
    constructor() {
      this.token = { isCancellationRequested: false, onCancellationRequested: event };
    }
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  },
  LanguageModelChatMessage: { User: (content) => ({ role: 'user', content }), Assistant: (content) => ({ role: 'assistant', content }) },
  lm: { selectChatModels: async () => [] },
  window: {
    get activeTextEditor() {
      return state.activeEditor;
    },
    visibleTextEditors: [],
    createTreeView: (id, options) => {
      const tree = { id, provider: options.treeDataProvider, visible: true, onDidChangeVisibility: event, dispose() {} };
      state.trees.set(id, tree);
      return tree;
    },
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { html: '', onDidReceiveMessage: event, postMessage: async () => true, asWebviewUri: (u) => u, cspSource: 'vscode' }, onDidDispose: event, reveal() {}, dispose() {} }),
    showErrorMessage: async (m) => void state.messages.push(['error', m]),
    showWarningMessage: async (m) => (state.messages.push(['warning', m]), nextAnswer()),
    showInformationMessage: async (m) => (state.messages.push(['info', m]), nextAnswer()),
    showQuickPick: async (items) => nextAnswer(await items),
    showInputBox: async () => nextAnswer(),
    showTextDocument: async (doc) => ({ document: doc }),
    withProgress: (options, task) => task({ report() {} }, new vscode.CancellationTokenSource().token),
    setStatusBarMessage: () => noop,
    registerFileDecorationProvider: () => noop,
    registerCustomEditorProvider: () => noop,
    registerWebviewPanelSerializer: () => noop,
    onDidChangeActiveTextEditor: event,
    onDidChangeTextEditorSelection: event,
    onDidChangeWindowState: event,
    onDidChangeVisibleTextEditors: event,
  },
  commands: {
    registerCommand: (id, fn) => {
      state.commands.set(id, fn);
      return noop;
    },
    executeCommand: async (id, ...args) => {
      if (state.commands.has(id)) return state.commands.get(id)(...args);
      state.executed.push([id, args]);
      return undefined;
    },
  },
  workspace: {
    getConfiguration: configuration,
    registerTextDocumentContentProvider: () => noop,
    openTextDocument: async (arg) => ({ uri: arg instanceof Uri ? arg : Uri.parse('untitled:doc'), getText: () => (arg && arg.content) || '', ...arg }),
    onDidChangeConfiguration: event,
    onDidSaveTextDocument: event,
    onDidCloseTextDocument: event,
    onDidChangeTextDocument: event,
    applyEdit: async () => true,
    isTrusted: true,
    workspaceFolders: [],
    fs: { writeFile: async () => {}, readFile: async () => new Uint8Array() },
  },
  languages: { registerCodeLensProvider: () => noop, registerHoverProvider: () => noop },
  extensions: { getExtension: () => ({ isActive: true, exports: { getAPI: () => gitApi } }) },
  env: { clipboard: { writeText: async (t) => void (state.clipboard = t), readText: async () => state.clipboard }, openExternal: async () => true, appName: 'Test', uriScheme: 'vscode' },
};

function createContext() {
  const memento = () => {
    const m = new Map();
    return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: async (k, v) => void m.set(k, v), keys: () => [...m.keys()] };
  };
  return {
    subscriptions: [],
    workspaceState: memento(),
    globalState: Object.assign(memento(), { setKeysForSync() {} }),
    secrets: {
      get: async (k) => state.secrets.get(k),
      store: async (k, v) => void state.secrets.set(k, v),
      delete: async (k) => void state.secrets.delete(k),
      onDidChange: event,
    },
    extensionUri: Uri.file(path.resolve(__dirname, '..', '..')),
    extensionPath: path.resolve(__dirname, '..', '..'),
  };
}

function reset() {
  state.config = {};
  state.secrets.clear();
  state.commands.clear();
  state.executed = [];
  state.trees.clear();
  state.answers = [];
  state.messages = [];
  state.clipboard = '';
  state.repos = [];
  state.activeEditor = undefined;
}

const original = Module._load;
Module._load = function load(request, ...rest) {
  if (request === 'vscode') return vscode;
  return original.call(this, request, ...rest);
};

module.exports = { vscode, state, reset, makeRepo, createContext, Uri };
