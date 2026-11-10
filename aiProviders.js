const vscode = require('vscode');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_URL = 'https://github.com/prashanthviru/git-compass';
const PROVIDERS = ['none', 'cli', 'openaiCompatible', 'anthropic', 'vscodeLm'];
const DEFAULT_SYSTEM = 'You are the assistant inside Git Compass, a Git tool for VS Code. Work only from the input you are given and follow the requested output format exactly.';
const STDIN_HINT = 'Follow the instructions provided on standard input.';
const ARG_LIMIT = process.platform === 'win32' ? 7000 : 100000;

const PRESETS = [
  {
    id: 'claude',
    label: 'Claude Code CLI',
    description: 'local command: claude',
    kind: 'cli',
    cli: { command: 'claude', args: ['-p', '--tools', '', '--no-session-persistence', '--setting-sources', ''], promptInput: 'stdin' },
    modelFlag: '--model',
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    description: 'local command: codex',
    kind: 'cli',
    cli: { command: 'codex', args: ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', '{outputFile}', '-'], promptInput: 'stdin' },
    modelFlag: '-m',
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    description: 'local command: gemini (verify flags for your version)',
    kind: 'cli',
    cli: { command: 'gemini', args: ['-p', '{prompt}'], promptInput: 'argument' },
    modelFlag: '-m',
  },
  { id: 'customCli', label: 'Custom command-line tool', description: 'any agent or script that reads a prompt and prints an answer', kind: 'cli', custom: true },
  { id: 'openai', label: 'OpenAI', description: 'api.openai.com, API key', kind: 'openaiCompatible', baseUrl: 'https://api.openai.com/v1', needsKey: true },
  { id: 'openrouter', label: 'OpenRouter', description: 'openrouter.ai, API key, many models', kind: 'openaiCompatible', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true },
  { id: 'anthropic', label: 'Anthropic API', description: 'api.anthropic.com, API key', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', needsKey: true },
  { id: 'ollama', label: 'Ollama (local)', description: 'localhost:11434, no key', kind: 'openaiCompatible', baseUrl: 'http://localhost:11434/v1', needsKey: false },
  { id: 'lmstudio', label: 'LM Studio (local)', description: 'localhost:1234, no key', kind: 'openaiCompatible', baseUrl: 'http://localhost:1234/v1', needsKey: false },
  { id: 'customOpenai', label: 'Custom OpenAI-compatible endpoint', description: 'any server with /chat/completions', kind: 'openaiCompatible', custom: true, needsKey: true },
  { id: 'vscodeLm', label: 'VS Code language models', description: 'GitHub Copilot or any installed model provider, no key', kind: 'vscodeLm' },
  { id: 'off', label: 'Turn AI off', description: 'disable all AI commands', kind: 'none' },
];

let secrets;
let globalState;
const sessionConsent = new Set();

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
  }
}

class AiNotConfiguredError extends Error {
  constructor() {
    super('AI is not set up. Choose a provider with "Git Compass: Set Up AI Provider".');
  }
}

function init(context) {
  secrets = context.secrets;
  globalState = context.globalState;
}

function settings() {
  const c = vscode.workspace.getConfiguration('gitCompass');
  const provider = c.get('ai.provider', 'none');
  return {
    provider: PROVIDERS.includes(provider) ? provider : 'none',
    cli: {
      command: (c.get('ai.cli.command', '') || '').trim(),
      args: Array.isArray(c.get('ai.cli.args', [])) ? c.get('ai.cli.args', []).map(String) : [],
      promptInput: c.get('ai.cli.promptInput', 'stdin') === 'argument' ? 'argument' : 'stdin',
    },
    openaiCompatible: { baseUrl: (c.get('ai.openaiCompatible.baseUrl', 'https://api.openai.com/v1') || '').trim(), model: (c.get('ai.openaiCompatible.model', '') || '').trim() },
    anthropic: { baseUrl: (c.get('ai.anthropic.baseUrl', 'https://api.anthropic.com') || '').trim(), model: (c.get('ai.anthropic.model', '') || '').trim() },
    vscodeLm: { vendor: (c.get('ai.vscodeLm.vendor', '') || '').trim(), family: (c.get('ai.vscodeLm.family', '') || '').trim() },
    apiKeyEnvVar: (c.get('ai.apiKeyEnvVar', '') || '').trim(),
    maxContextChars: Math.max(1000, Number(c.get('ai.maxContextChars', 120000)) || 120000),
    timeoutMs: Math.max(5, Number(c.get('ai.timeoutSeconds', 180)) || 180) * 1000,
  };
}

function hostOf(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function secretKeyFor(provider, baseUrl) {
  if (provider === 'openaiCompatible') return `gitCompass.ai.key.openaiCompatible:${hostOf(baseUrl)}`;
  if (provider === 'anthropic') return 'gitCompass.ai.key.anthropic';
  return undefined;
}

async function apiKey(s, provider = s.provider) {
  const key = secretKeyFor(provider, provider === 'anthropic' ? s.anthropic.baseUrl : s.openaiCompatible.baseUrl);
  const stored = key && secrets ? await secrets.get(key) : undefined;
  if (stored) return stored;
  return s.apiKeyEnvVar ? process.env[s.apiKeyEnvVar] || undefined : undefined;
}

function describeDestination(s) {
  switch (s.provider) {
    case 'cli':
      return `local command \`${s.cli.command || '(not set)'}\``;
    case 'openaiCompatible':
      return hostOf(s.openaiCompatible.baseUrl);
    case 'anthropic':
      return hostOf(s.anthropic.baseUrl);
    case 'vscodeLm':
      return `VS Code language model${s.vscodeLm.vendor ? ` (${s.vscodeLm.vendor})` : ''}`;
    default:
      return 'nowhere';
  }
}

function scrubEnv(env) {
  const out = { ...env };
  delete out.CLAUDE_CODE_EXTRA_BODY;
  delete out.CLAUDECODE;
  return out;
}

function truncateContext(text, max = 120000) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n\n[Input truncated: ${text.length - max} more characters were left out.]`, truncated: true };
}

function stripAnsi(text) {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}

function redact(text, values = []) {
  let out = String(text ?? '');
  for (const v of values) if (v && v.length >= 6) out = out.split(v).join('***');
  return out.replace(/\b(sk|sk-ant|sk-or|rk)-[A-Za-z0-9_-]{8,}/g, '$1-***').replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{8,}/gi, '$1***');
}

function needsShell(command, platform = process.platform) {
  return platform === 'win32' && !/\.(exe|com)$/i.test(command);
}

function quoteWinArg(arg) {
  const s = String(arg);
  if (s && !/[\s"&|<>^%!()]/.test(s)) return s;
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1').replace(/%/g, '%%')}"`;
}

function composePrompt(system, user) {
  return system ? `${system}\n\n${user}` : user;
}

function planCli({ command, args, promptInput }, fullPrompt, { platform = process.platform, outputFile } = {}) {
  if (!command) throw new Error('Set "gitCompass.ai.cli.command" to the command-line tool you want to use.');
  const shell = needsShell(command, platform);
  const inArgument = promptInput === 'argument' && !shell && fullPrompt.length <= ARG_LIMIT;
  const expanded = args.map((a) => a.replace(/\{outputFile\}/g, outputFile || '').replace(/\{prompt\}/g, inArgument ? fullPrompt : STDIN_HINT));
  const stdin = inArgument ? '' : fullPrompt;
  return { command, args: expanded, shell, stdin, readsOutputFile: args.some((a) => a.includes('{outputFile}')) };
}

function runCli(cli, fullPrompt, { cwd, token, timeoutMs = 180000, env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve, reject) => {
    const usesFile = cli.args.some((a) => a.includes('{outputFile}'));
    const dir = usesFile ? fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-ai-')) : undefined;
    const outputFile = dir ? path.join(dir, 'answer.txt') : undefined;
    let plan;
    try {
      plan = planCli(cli, fullPrompt, { platform, outputFile });
    } catch (e) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      reject(e);
      return;
    }
    const cleanup = () => dir && fs.rmSync(dir, { recursive: true, force: true });
    let child;
    try {
      child = plan.shell
        ? spawn([quoteWinArg(plan.command), ...plan.args.map(quoteWinArg)].join(' '), { cwd, env: scrubEnv(env), shell: true, windowsHide: true })
        : spawn(plan.command, plan.args, { cwd, env: scrubEnv(env), windowsHide: true });
    } catch (e) {
      cleanup();
      reject(e);
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      cleanup();
      fn(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      finish(reject, new Error(`\`${cli.command}\` did not answer within ${Math.round(timeoutMs / 1000)}s.`));
    }, timeoutMs);
    token?.onCancellationRequested(() => {
      child.kill('SIGTERM');
      finish(reject, new CancelledError());
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) =>
      finish(reject, e.code === 'ENOENT' ? new Error(`\`${cli.command}\` was not found. Install it or change "gitCompass.ai.cli.command".`) : e)
    );
    child.on('close', (code) => {
      let answer = stripAnsi(out).trim();
      if (plan.readsOutputFile) {
        try {
          answer = stripAnsi(fs.readFileSync(outputFile, 'utf8')).trim();
        } catch {
          answer = '';
        }
      }
      if (code === 0 && answer && !/^API Error/.test(answer)) finish(resolve, answer);
      else finish(reject, new Error(stripAnsi(err.trim() || answer || `\`${cli.command}\` exited with code ${code}`).split('\n').slice(-6).join('\n')));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(plan.stdin);
  });
}

function buildOpenAiRequest({ baseUrl, model, key, system, user }) {
  if (!model) throw new Error('Set "gitCompass.ai.openaiCompatible.model" to a model ID from your provider.');
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  if (/(^|\.)openrouter\.ai$/i.test(hostOf(baseUrl).split(':')[0])) {
    headers['HTTP-Referer'] = PROJECT_URL;
    headers['X-Title'] = 'Git Compass';
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });
  return { url: `${baseUrl.replace(/\/+$/, '')}/chat/completions`, init: { method: 'POST', headers, body: JSON.stringify({ model, messages }) } };
}

function parseOpenAiResponse(json) {
  const content = json?.choices?.[0]?.message?.content;
  const text = Array.isArray(content) ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('') : content;
  if (typeof text !== 'string' || !text.trim()) throw new Error('The model returned an empty answer.');
  return text.trim();
}

function buildAnthropicRequest({ baseUrl, model, key, system, user }) {
  if (!model) throw new Error('Set "gitCompass.ai.anthropic.model" to a model ID from Anthropic.');
  if (!key) throw new Error('No Anthropic API key is stored. Run "Git Compass: Set AI API Key".');
  const base = baseUrl.replace(/\/+$/, '');
  const url = /\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`;
  const body = { model, max_tokens: 4096, messages: [{ role: 'user', content: user }] };
  if (system) body.system = system;
  return { url, init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) } };
}

function parseAnthropicResponse(json) {
  const text = (json?.content || [])
    .filter((b) => b?.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text.trim()) throw new Error('The model returned an empty answer.');
  return text.trim();
}

async function httpComplete(request, parse, { token, timeoutMs, key, fetchImpl = globalThis.fetch }) {
  if (typeof fetchImpl !== 'function') throw new Error('This VS Code build has no fetch support; use a newer VS Code.');
  const controller = new AbortController();
  let cancelled = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const sub = token?.onCancellationRequested(() => {
    cancelled = true;
    controller.abort();
  });
  const host = hostOf(request.url);
  try {
    const res = await fetchImpl(request.url, { ...request.init, signal: controller.signal });
    const raw = await res.text();
    let json;
    try {
      json = raw ? JSON.parse(raw) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const detail = json?.error?.message || json?.message || (typeof json?.error === 'string' ? json.error : '') || raw.slice(0, 300) || res.statusText;
      throw new Error(redact(`${host} returned ${res.status}: ${detail}`, [key]));
    }
    if (!json) throw new Error(`${host} returned a response that is not JSON.`);
    return parse(json);
  } catch (e) {
    if (cancelled) throw new CancelledError();
    if (timedOut) throw new Error(`${host} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    if (e instanceof CancelledError) throw e;
    if (e.name === 'AbortError') throw new CancelledError();
    const cause = e.cause?.code ? ` (${e.cause.code})` : '';
    throw new Error(redact(/returned \d{3}/.test(e.message) || /not JSON|empty answer|Set "gitCompass/.test(e.message) ? e.message : `Could not reach ${host}${cause}: ${e.message}`, [key]));
  } finally {
    clearTimeout(timer);
    sub?.dispose?.();
  }
}

async function vscodeLmComplete({ vendor, family }, system, user, { token, timeoutMs }) {
  if (!vscode.lm?.selectChatModels) throw new Error('This editor does not offer VS Code language models. Choose another AI provider.');
  const selector = {};
  if (vendor) selector.vendor = vendor;
  if (family) selector.family = family;
  const models = await vscode.lm.selectChatModels(selector);
  if (!models?.length) throw new Error('No VS Code language model is available. Install and sign in to a model provider such as GitHub Copilot, or adjust "gitCompass.ai.vscodeLm.vendor" and "family".');
  const cts = new vscode.CancellationTokenSource();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    cts.cancel();
  }, timeoutMs);
  const sub = token?.onCancellationRequested(() => cts.cancel());
  try {
    const response = await models[0].sendRequest([vscode.LanguageModelChatMessage.User(composePrompt(system, user))], { justification: 'Git Compass sends the input of the AI command you ran.' }, cts.token);
    let text = '';
    for await (const part of response.text) {
      if (cts.token.isCancellationRequested) break;
      text += part;
    }
    if (timedOut) throw new Error(`The language model did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    if (token?.isCancellationRequested || cts.token.isCancellationRequested) throw new CancelledError();
    if (!text.trim()) throw new Error('The model returned an empty answer.');
    return text.trim();
  } catch (e) {
    if (e instanceof CancelledError) throw e;
    if (timedOut) throw new Error(`The language model did not answer within ${Math.round(timeoutMs / 1000)}s.`);
    if (token?.isCancellationRequested) throw new CancelledError();
    throw e;
  } finally {
    clearTimeout(timer);
    sub?.dispose?.();
    cts.dispose();
  }
}

async function ensureConsent(s) {
  const destination = describeDestination(s);
  const id = `gitCompass.ai.consent:${s.provider}:${destination}`;
  if (sessionConsent.has(id) || globalState?.get(id)) return;
  const choice = await vscode.window.showInformationMessage(
    `Git Compass will send the input of this AI command (diffs, commit messages, file names) to ${destination}.`,
    'Continue',
    'Cancel',
    "Don't Ask Again for This Provider"
  );
  if (choice === 'Continue') sessionConsent.add(id);
  else if (choice === "Don't Ask Again for This Provider") await globalState?.update(id, true);
  else throw new CancelledError();
}

function buildUserMessage(prompt, context, max) {
  const { text, truncated } = truncateContext(context || '', max);
  const instruction = truncated ? `${prompt} The input was cut short to fit; say so if that limits your answer.` : prompt;
  return text ? `${instruction}\n\n<input>\n${text}\n</input>` : instruction;
}

async function complete({ system = DEFAULT_SYSTEM, prompt, context = '', token, cwd, skipConsent = false, fetchImpl } = {}) {
  const s = settings();
  if (s.provider === 'none') throw new AiNotConfiguredError();
  if (!skipConsent) await ensureConsent(s);
  const user = buildUserMessage(prompt, context, s.maxContextChars);
  switch (s.provider) {
    case 'cli':
      return runCli(s.cli, composePrompt(system, user), { cwd, token, timeoutMs: s.timeoutMs });
    case 'openaiCompatible': {
      const key = await apiKey(s);
      return httpComplete(buildOpenAiRequest({ ...s.openaiCompatible, key, system, user }), parseOpenAiResponse, { token, timeoutMs: s.timeoutMs, key, fetchImpl });
    }
    case 'anthropic': {
      const key = await apiKey(s);
      return httpComplete(buildAnthropicRequest({ ...s.anthropic, key, system, user }), parseAnthropicResponse, { token, timeoutMs: s.timeoutMs, key, fetchImpl });
    }
    case 'vscodeLm':
      return vscodeLmComplete(s.vscodeLm, system, user, { token, timeoutMs: s.timeoutMs });
    default:
      throw new AiNotConfiguredError();
  }
}

function splitArgs(text) {
  const out = [];
  let cur = '';
  let quote = '';
  let has = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

async function update(key, value) {
  await vscode.workspace.getConfiguration('gitCompass').update(key, value, vscode.ConfigurationTarget.Global);
}

async function askKey(provider, baseUrl, label) {
  const value = await vscode.window.showInputBox({
    title: `${label} API Key`,
    prompt: 'Stored in VS Code secret storage on this machine. Leave empty to skip.',
    password: true,
    ignoreFocusOut: true,
  });
  if (!value?.trim()) return false;
  await secrets.store(secretKeyFor(provider, baseUrl), value.trim());
  return true;
}

async function configure() {
  const preset = await vscode.window.showQuickPick(
    PRESETS.map((p) => ({ label: p.label, description: p.description, preset: p })),
    { title: 'Git Compass: Set Up AI Provider', placeHolder: 'Where should AI requests go?', matchOnDescription: true, ignoreFocusOut: true }
  );
  if (!preset) return;
  const p = preset.preset;
  if (p.kind === 'none') {
    await update('ai.provider', 'none');
    vscode.window.showInformationMessage('Git Compass AI is turned off.');
    return;
  }
  if (p.kind === 'cli') {
    let cli = p.cli;
    if (p.custom) {
      const command = (await vscode.window.showInputBox({ title: 'Custom AI command', prompt: 'Executable name or full path', placeHolder: 'my-agent', ignoreFocusOut: true, validateInput: (v) => (v.trim() ? undefined : 'Enter a command') }))?.trim();
      if (!command) return;
      const argText = await vscode.window.showInputBox({
        title: 'Custom AI command arguments',
        prompt: 'Arguments separated by spaces; quote values with spaces. Use {prompt} for the prompt text and {outputFile} if the tool writes its answer to a file.',
        placeHolder: '--quiet {prompt}',
        ignoreFocusOut: true,
      });
      if (argText === undefined) return;
      const mode = await vscode.window.showQuickPick(
        [
          { label: 'Standard input', description: 'the prompt is piped to the command', value: 'stdin' },
          { label: 'Argument', description: 'the prompt replaces {prompt} in the arguments', value: 'argument' },
        ],
        { title: 'How does the tool receive the prompt?', ignoreFocusOut: true }
      );
      if (!mode) return;
      cli = { command, args: splitArgs(argText), promptInput: mode.value };
    } else if (p.modelFlag) {
      const model = await vscode.window.showInputBox({
        title: `${p.label}: model (optional)`,
        prompt: `Leave empty to use ${p.cli.command}'s own default model, or enter a model your account can use.`,
        placeHolder: 'tool default',
        ignoreFocusOut: true,
      });
      if (model === undefined) return;
      const args = [...p.cli.args];
      if (model.trim()) args.splice(p.cli.command === 'codex' ? 1 : 0, 0, p.modelFlag, model.trim());
      cli = { ...p.cli, args };
    }
    await update('ai.cli.command', cli.command);
    await update('ai.cli.args', cli.args);
    await update('ai.cli.promptInput', cli.promptInput);
    await update('ai.provider', 'cli');
  } else if (p.kind === 'openaiCompatible' || p.kind === 'anthropic') {
    let baseUrl = p.baseUrl;
    if (p.custom) {
      baseUrl = (
        await vscode.window.showInputBox({
          title: 'Custom endpoint',
          prompt: 'Base URL of an OpenAI-compatible API (the part before /chat/completions)',
          placeHolder: 'https://my-gateway.example.com/v1',
          ignoreFocusOut: true,
          validateInput: (v) => (/^https?:\/\/\S+$/.test(v.trim()) ? undefined : 'Enter an http(s) URL'),
        })
      )?.trim();
      if (!baseUrl) return;
    }
    const model = (
      await vscode.window.showInputBox({
        title: `${p.label}: model`,
        prompt: 'Model ID exactly as your provider lists it',
        placeHolder: p.id === 'ollama' ? 'a model you have pulled with ollama pull' : p.id === 'lmstudio' ? 'the model identifier shown in LM Studio' : 'model ID from the provider’s model list',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'Enter a model ID'),
      })
    )?.trim();
    if (!model) return;
    await update(`ai.${p.kind}.baseUrl`, baseUrl);
    await update(`ai.${p.kind}.model`, model);
    await update('ai.provider', p.kind);
    if (p.needsKey !== false) {
      const has = await secrets.get(secretKeyFor(p.kind, baseUrl));
      if (!has && !(await askKey(p.kind, baseUrl, p.label))) {
        vscode.window.showWarningMessage(`No API key stored for ${hostOf(baseUrl)}. Run "Git Compass: Set AI API Key" when you have one.`);
      }
    }
  } else if (p.kind === 'vscodeLm') {
    let vendor = '';
    let family = '';
    const models = vscode.lm?.selectChatModels ? await vscode.lm.selectChatModels({}).catch(() => []) : [];
    if (models?.length) {
      const pick = await vscode.window.showQuickPick(
        [{ label: 'Any available model', value: undefined }, ...models.map((m) => ({ label: m.name || m.family, description: `${m.vendor} · ${m.family}`, value: m }))],
        { title: 'Which language model?', ignoreFocusOut: true }
      );
      if (!pick) return;
      vendor = pick.value?.vendor || '';
      family = pick.value?.family || '';
    }
    await update('ai.vscodeLm.vendor', vendor);
    await update('ai.vscodeLm.family', family);
    await update('ai.provider', 'vscodeLm');
  }
  const choice = await vscode.window.showInformationMessage(`Git Compass AI now uses ${p.label}.`, 'Test Connection');
  if (choice === 'Test Connection') await testConnection();
}

async function setApiKey() {
  const s = settings();
  let provider = s.provider;
  let baseUrl = provider === 'anthropic' ? s.anthropic.baseUrl : s.openaiCompatible.baseUrl;
  if (provider !== 'openaiCompatible' && provider !== 'anthropic') {
    const pick = await vscode.window.showQuickPick(
      [
        { label: `OpenAI-compatible (${hostOf(s.openaiCompatible.baseUrl)})`, provider: 'openaiCompatible', baseUrl: s.openaiCompatible.baseUrl },
        { label: `Anthropic (${hostOf(s.anthropic.baseUrl)})`, provider: 'anthropic', baseUrl: s.anthropic.baseUrl },
      ],
      { title: 'Store an API key for…' }
    );
    if (!pick) return;
    provider = pick.provider;
    baseUrl = pick.baseUrl;
  }
  if (await askKey(provider, baseUrl, provider === 'anthropic' ? 'Anthropic' : hostOf(baseUrl))) {
    vscode.window.showInformationMessage(`API key stored for ${hostOf(baseUrl)}.`);
  }
}

async function clearApiKey() {
  const s = settings();
  const targets = [
    { label: `OpenAI-compatible (${hostOf(s.openaiCompatible.baseUrl)})`, key: secretKeyFor('openaiCompatible', s.openaiCompatible.baseUrl) },
    { label: `Anthropic (${hostOf(s.anthropic.baseUrl)})`, key: secretKeyFor('anthropic', s.anthropic.baseUrl) },
  ];
  const pick = await vscode.window.showQuickPick(targets, { title: 'Remove the stored API key for…' });
  if (!pick) return;
  await secrets.delete(pick.key);
  vscode.window.showInformationMessage(`Removed the stored key for ${pick.label}.`);
}

async function testConnection() {
  const s = settings();
  if (s.provider === 'none') throw new AiNotConfiguredError();
  const answer = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Testing ${describeDestination(s)}…`, cancellable: true },
    (_progress, token) => complete({ system: 'Answer in as few words as possible.', prompt: 'Reply with the word OK.', token })
  );
  vscode.window.showInformationMessage(`Connected to ${describeDestination(s)}. It replied: ${answer.split('\n')[0].slice(0, 80)}`);
}

module.exports = {
  init,
  complete,
  configure,
  setApiKey,
  clearApiKey,
  testConnection,
  settings,
  secretKeyFor,
  apiKey,
  describeDestination,
  ensureConsent,
  buildUserMessage,
  buildOpenAiRequest,
  parseOpenAiResponse,
  buildAnthropicRequest,
  parseAnthropicResponse,
  httpComplete,
  vscodeLmComplete,
  runCli,
  planCli,
  splitArgs,
  stripAnsi,
  scrubEnv,
  redact,
  needsShell,
  quoteWinArg,
  truncateContext,
  hostOf,
  PRESETS,
  PROVIDERS,
  DEFAULT_SYSTEM,
  CancelledError,
  AiNotConfiguredError,
};
