const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { vscode, state, reset, createContext } = require('./helpers/vscode');
const p = require('../aiProviders');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'git-compass-ai-cli-'));
const fakeCli = path.join(tmp, 'fake-cli.js');
fs.writeFileSync(
  fakeCli,
  `const fs = require('fs');
const [mode, ...rest] = process.argv.slice(2);
let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  if (mode === 'echo') process.stdout.write('GOT ' + input.length + ' ' + input.slice(-12));
  else if (mode === 'args') process.stdout.write('ARGS ' + JSON.stringify(rest) + ' STDIN ' + input.length);
  else if (mode === 'outfile') { fs.writeFileSync(rest[0], 'from file'); process.stdout.write('progress noise'); }
  else if (mode === 'ansi') process.stdout.write('\\x1b[32mgreen\\x1b[0m text');
  else if (mode === 'fail') { process.stderr.write('bad things happened'); process.exit(3); }
  else if (mode === 'env') process.stdout.write('EXTRA=' + (process.env.CLAUDE_CODE_EXTRA_BODY || 'none') + ' CC=' + (process.env.CLAUDECODE || 'none'));
  else if (mode === 'sleep') setTimeout(() => process.stdout.write('late'), 60000);
});
`
);

after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function token() {
  const listeners = [];
  return {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      listeners.push(fn);
      return { dispose() {} };
    },
    cancel() {
      this.isCancellationRequested = true;
      listeners.forEach((fn) => fn());
    },
  };
}

function cli(mode, ...extra) {
  return { command: process.execPath, args: [fakeCli, mode, ...extra], promptInput: 'stdin' };
}

function useConfig(values) {
  for (const [k, v] of Object.entries(values)) state.config[`gitCompass.${k}`] = v;
}

let context;
beforeEach(() => {
  reset();
  context = createContext();
  p.init(context);
});

describe('OpenAI-compatible requests', () => {
  test('builds the URL, auth header and messages', () => {
    const r = p.buildOpenAiRequest({ baseUrl: 'https://api.openai.com/v1/', model: 'm1', key: 'sk-test-abcdefgh', system: 'sys', user: 'hello' });
    assert.equal(r.url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(r.init.method, 'POST');
    assert.equal(r.init.headers.Authorization, 'Bearer sk-test-abcdefgh');
    assert.equal(r.init.headers['HTTP-Referer'], undefined);
    assert.deepEqual(JSON.parse(r.init.body), { model: 'm1', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }] });
  });

  test('omits auth without a key and adds OpenRouter headers only for openrouter.ai', () => {
    const local = p.buildOpenAiRequest({ baseUrl: 'http://localhost:11434/v1', model: 'llama', system: '', user: 'u' });
    assert.equal(local.init.headers.Authorization, undefined);
    assert.deepEqual(JSON.parse(local.init.body).messages, [{ role: 'user', content: 'u' }]);
    const router = p.buildOpenAiRequest({ baseUrl: 'https://openrouter.ai/api/v1', model: 'x/y', key: 'k', system: 's', user: 'u' });
    assert.equal(router.init.headers['X-Title'], 'Git Compass');
    assert.match(router.init.headers['HTTP-Referer'], /^https:\/\//);
    const lookalike = p.buildOpenAiRequest({ baseUrl: 'https://openrouter.ai.evil.example/v1', model: 'x', system: 's', user: 'u' });
    assert.equal(lookalike.init.headers['X-Title'], undefined);
  });

  test('requires a model', () => {
    assert.throws(() => p.buildOpenAiRequest({ baseUrl: 'https://api.openai.com/v1', model: '', system: '', user: 'u' }), /openaiCompatible\.model/);
  });

  test('parses string and part-array content', () => {
    assert.equal(p.parseOpenAiResponse({ choices: [{ message: { content: ' hi ' } }] }), 'hi');
    assert.equal(p.parseOpenAiResponse({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] }), 'ab');
    assert.throws(() => p.parseOpenAiResponse({ choices: [] }), /empty answer/);
  });
});

describe('Anthropic requests', () => {
  test('builds the messages request', () => {
    const r = p.buildAnthropicRequest({ baseUrl: 'https://api.anthropic.com', model: 'm', key: 'sk-ant-xyz12345', system: 'sys', user: 'u' });
    assert.equal(r.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(r.init.headers['x-api-key'], 'sk-ant-xyz12345');
    assert.equal(r.init.headers['anthropic-version'], '2023-06-01');
    assert.deepEqual(JSON.parse(r.init.body), { model: 'm', max_tokens: 4096, messages: [{ role: 'user', content: 'u' }], system: 'sys' });
    assert.equal(p.buildAnthropicRequest({ baseUrl: 'https://proxy.example/v1/', model: 'm', key: 'k', system: '', user: 'u' }).url, 'https://proxy.example/v1/messages');
  });

  test('requires a key and a model, and joins text blocks', () => {
    assert.throws(() => p.buildAnthropicRequest({ baseUrl: 'https://api.anthropic.com', model: 'm', key: '', system: '', user: 'u' }), /API key/);
    assert.throws(() => p.buildAnthropicRequest({ baseUrl: 'https://api.anthropic.com', model: '', key: 'k', system: '', user: 'u' }), /anthropic\.model/);
    assert.equal(p.parseAnthropicResponse({ content: [{ type: 'text', text: 'A' }, { type: 'tool_use' }, { type: 'text', text: 'B' }] }), 'AB');
  });
});

describe('HTTP transport', () => {
  const req = { url: 'https://api.example.com/v1/chat/completions', init: { method: 'POST', headers: {}, body: '{}' } };
  const ok = (body) => async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(body) });

  test('returns the parsed answer', async () => {
    const answer = await p.httpComplete(req, p.parseOpenAiResponse, { timeoutMs: 1000, fetchImpl: ok({ choices: [{ message: { content: 'yes' } }] }) });
    assert.equal(answer, 'yes');
  });

  test('redacts the key from error responses', async () => {
    const key = 'sk-secret-1234567890';
    const fetchImpl = async () => ({ ok: false, status: 401, statusText: 'Unauthorized', text: async () => JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }) });
    await assert.rejects(p.httpComplete(req, p.parseOpenAiResponse, { timeoutMs: 1000, key, fetchImpl }), (e) => {
      assert.match(e.message, /api\.example\.com returned 401/);
      assert.ok(!e.message.includes(key));
      return true;
    });
  });

  test('reports network failures with the host', async () => {
    const fetchImpl = async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    };
    await assert.rejects(p.httpComplete(req, p.parseOpenAiResponse, { timeoutMs: 1000, fetchImpl }), /Could not reach api\.example\.com \(ECONNREFUSED\)/);
  });

  const hanging = async (_url, init) =>
    new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));

  test('times out', async () => {
    await assert.rejects(p.httpComplete(req, p.parseOpenAiResponse, { timeoutMs: 30, fetchImpl: hanging }), /did not answer within/);
  });

  test('cancels', async () => {
    const t = token();
    setTimeout(() => t.cancel(), 20);
    await assert.rejects(p.httpComplete(req, p.parseOpenAiResponse, { timeoutMs: 5000, token: t, fetchImpl: hanging }), p.CancelledError);
  });
});

describe('secrets and settings', () => {
  test('keys are separate per provider and per OpenAI-compatible host', () => {
    assert.equal(p.secretKeyFor('openaiCompatible', 'https://api.openai.com/v1'), 'gitCompass.ai.key.openaiCompatible:api.openai.com');
    assert.equal(p.secretKeyFor('openaiCompatible', 'https://openrouter.ai/api/v1'), 'gitCompass.ai.key.openaiCompatible:openrouter.ai');
    assert.equal(p.secretKeyFor('anthropic', 'https://api.anthropic.com'), 'gitCompass.ai.key.anthropic');
    assert.equal(p.secretKeyFor('anthropic', 'https://proxy.example.com'), 'gitCompass.ai.key.anthropic:proxy.example.com');
    assert.equal(p.secretKeyFor('cli'), undefined);
  });

  test('stored key wins over the environment variable', async () => {
    useConfig({ 'ai.provider': 'anthropic', 'ai.apiKeyEnvVar': 'GC_TEST_KEY' });
    process.env.GC_TEST_KEY = 'from-env';
    assert.equal(await p.apiKey(p.settings()), 'from-env');
    await context.secrets.store('gitCompass.ai.key.anthropic', 'from-secrets');
    assert.equal(await p.apiKey(p.settings()), 'from-secrets');
    delete process.env.GC_TEST_KEY;
  });

  test('defaults keep AI off', () => {
    const s = p.settings();
    assert.equal(s.provider, 'none');
    assert.equal(s.maxContextChars, 120000);
    assert.equal(s.timeoutMs, 180000);
    assert.equal(s.cli.promptInput, 'stdin');
  });

  test('describes where data goes', () => {
    useConfig({ 'ai.provider': 'openaiCompatible', 'ai.openaiCompatible.baseUrl': 'https://openrouter.ai/api/v1' });
    assert.equal(p.describeDestination(p.settings()), 'openrouter.ai');
    useConfig({ 'ai.provider': 'cli', 'ai.cli.command': 'codex' });
    assert.equal(p.describeDestination(p.settings()), 'local command `codex`');
  });
});

describe('complete()', () => {
  test('refuses when no provider is set', async () => {
    await assert.rejects(p.complete({ prompt: 'x' }), p.AiNotConfiguredError);
  });

  test('asks for consent once per session, honours Cancel and Don\'t Ask Again', async () => {
    useConfig({ 'ai.provider': 'openaiCompatible', 'ai.openaiCompatible.baseUrl': 'https://consent.example/v1', 'ai.openaiCompatible.model': 'm' });
    const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'fine' } }] }) });
    state.answers.push('Cancel');
    await assert.rejects(p.complete({ prompt: 'x', fetchImpl }), p.CancelledError);
    state.answers.push('Continue');
    assert.equal(await p.complete({ prompt: 'x', fetchImpl }), 'fine');
    const asked = state.messages.length;
    assert.equal(await p.complete({ prompt: 'x', fetchImpl }), 'fine');
    assert.equal(state.messages.length, asked);
    useConfig({ 'ai.openaiCompatible.baseUrl': 'https://other.example/v1' });
    state.answers.push("Don't Ask Again for This Provider");
    await p.complete({ prompt: 'x', fetchImpl });
    assert.equal(context.globalState.get('gitCompass.ai.consent:openaiCompatible:other.example'), true);
    assert.match(state.messages.at(-1)[1], /other\.example/);
  });

  test('sends the stored key and wraps context in the user message', async () => {
    useConfig({ 'ai.provider': 'openaiCompatible', 'ai.openaiCompatible.baseUrl': 'https://api.openai.com/v1', 'ai.openaiCompatible.model': 'm', 'ai.maxContextChars': 1000 });
    await context.secrets.store('gitCompass.ai.key.openaiCompatible:api.openai.com', 'sk-stored-12345678');
    let seen;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    };
    await p.complete({ prompt: 'Do it.', context: 'x'.repeat(1500), skipConsent: true, fetchImpl });
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-stored-12345678');
    const user = JSON.parse(seen.init.body).messages[1].content;
    assert.match(user, /^Do it\. The input was cut short/);
    assert.match(user, /<input>\n/);
    assert.match(user, /Input truncated: 500 more characters/);
  });
});

describe('command-line provider', () => {
  test('pipes the prompt on stdin', async () => {
    const answer = await p.runCli(cli('echo'), 'hello prompt', { timeoutMs: 10000 });
    assert.equal(answer, 'GOT 12 hello prompt');
  });

  test('argument mode substitutes {prompt}', async () => {
    const answer = await p.runCli({ command: process.execPath, args: [fakeCli, 'args', '-p', '{prompt}'], promptInput: 'argument' }, 'short prompt', { timeoutMs: 10000 });
    assert.equal(answer, 'ARGS ["-p","short prompt"] STDIN 0');
  });

  test('stdin mode replaces {prompt} with a pointer to stdin', async () => {
    const answer = await p.runCli({ command: process.execPath, args: [fakeCli, 'args', '{prompt}'], promptInput: 'stdin' }, 'abc', { timeoutMs: 10000 });
    assert.match(answer, /^ARGS \["Follow the instructions provided on standard input\."\] STDIN 3$/);
  });

  test('reads the answer from {outputFile} and removes it', async () => {
    let seenPath;
    const original = fs.mkdtempSync;
    fs.mkdtempSync = (prefix) => (seenPath = original(prefix));
    try {
      const answer = await p.runCli({ command: process.execPath, args: [fakeCli, 'outfile', '{outputFile}'], promptInput: 'stdin' }, 'x', { timeoutMs: 10000 });
      assert.equal(answer, 'from file');
    } finally {
      fs.mkdtempSync = original;
    }
    assert.equal(fs.existsSync(seenPath), false);
  });

  test('strips ANSI colour codes', async () => {
    assert.equal(await p.runCli(cli('ansi'), '', { timeoutMs: 10000 }), 'green text');
  });

  test('reports a non-zero exit with stderr', async () => {
    await assert.rejects(p.runCli(cli('fail'), 'x', { timeoutMs: 10000 }), /bad things happened/);
  });

  test('reports a missing command', async () => {
    await assert.rejects(p.runCli({ command: 'definitely-not-a-real-command-gc', args: [], promptInput: 'stdin' }, 'x', { timeoutMs: 10000 }), /was not found/);
  });

  test('times out', async () => {
    await assert.rejects(p.runCli(cli('sleep'), 'x', { timeoutMs: 300 }), /did not answer within/);
  });

  test('cancels', async () => {
    const t = token();
    setTimeout(() => t.cancel(), 100);
    await assert.rejects(p.runCli(cli('sleep'), 'x', { timeoutMs: 10000, token: t }), p.CancelledError);
  });

  test('scrubs variables that break nested agent CLIs', async () => {
    const answer = await p.runCli(cli('env'), '', { timeoutMs: 10000, env: { ...process.env, CLAUDE_CODE_EXTRA_BODY: '{"x":1}', CLAUDECODE: '1' } });
    assert.equal(answer, 'EXTRA=none CC=none');
  });

  test('requires a command', () => {
    assert.throws(() => p.planCli({ command: '', args: [], promptInput: 'stdin' }, 'x'), /ai\.cli\.command/);
  });

  test('on Windows, shims go through the shell with the prompt on stdin', () => {
    const plan = p.planCli({ command: 'gemini', args: ['-p', '{prompt}'], promptInput: 'argument' }, 'diff with "quotes" & pipes |', { platform: 'win32' });
    assert.equal(plan.shell, true);
    assert.deepEqual(plan.args, ['-p', 'Follow the instructions provided on standard input.']);
    assert.equal(plan.stdin, 'diff with "quotes" & pipes |');
    assert.equal(p.planCli({ command: 'C:\\tools\\agent.exe', args: [], promptInput: 'stdin' }, 'x', { platform: 'win32' }).shell, false);
  });

  test('on Windows, arguments cmd.exe cannot quote safely are refused', () => {
    for (const bad of ['a"b', '100%', 'wow!', 'two\nlines']) {
      assert.throws(() => p.planCli({ command: 'agent', args: [bad], promptInput: 'stdin' }, 'x', { platform: 'win32' }), /cmd\.exe/);
    }
    assert.doesNotThrow(() => p.planCli({ command: 'agent', args: ['a"b'], promptInput: 'stdin' }, 'x', { platform: 'linux' }));
  });

  test('very long prompts fall back to stdin in argument mode', () => {
    const plan = p.planCli({ command: 'tool', args: ['{prompt}'], promptInput: 'argument' }, 'y'.repeat(200000), { platform: 'linux' });
    assert.equal(plan.stdin.length, 200000);
    assert.notEqual(plan.args[0], plan.stdin);
  });

  test('quotes Windows arguments', () => {
    assert.equal(p.quoteWinArg('plain'), 'plain');
    assert.equal(p.quoteWinArg(''), '""');
    assert.equal(p.quoteWinArg('a b'), '"a b"');
    assert.equal(p.quoteWinArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(p.quoteWinArg('50%'), '"50%%"');
  });

  test('complete() routes through the configured command', async () => {
    useConfig({ 'ai.provider': 'cli', 'ai.cli.command': process.execPath, 'ai.cli.args': [fakeCli, 'echo'], 'ai.cli.promptInput': 'stdin' });
    const answer = await p.complete({ system: 'S', prompt: 'P', context: 'C', skipConsent: true });
    const full = 'S\n\nP\n\n<input>\nC\n</input>';
    assert.equal(answer, `GOT ${full.length} ${full.slice(-12)}`);
  });
});

describe('VS Code language models', () => {
  test('uses the first matching model and collects the stream', async () => {
    let selector;
    let messages;
    vscode.lm.selectChatModels = async (s) => {
      selector = s;
      return [
        {
          sendRequest: async (m) => {
            messages = m;
            return {
              text: (async function* () {
                yield 'Hel';
                yield 'lo';
              })(),
            };
          },
        },
      ];
    };
    useConfig({ 'ai.provider': 'vscodeLm', 'ai.vscodeLm.vendor': 'copilot' });
    assert.equal(await p.complete({ system: 'S', prompt: 'P', skipConsent: true }), 'Hello');
    assert.deepEqual(selector, { vendor: 'copilot' });
    assert.equal(messages[0].content, 'S\n\nP');
  });

  test('explains when no model is available', async () => {
    vscode.lm.selectChatModels = async () => [];
    useConfig({ 'ai.provider': 'vscodeLm' });
    await assert.rejects(p.complete({ prompt: 'P', skipConsent: true }), /No VS Code language model is available/);
  });

  test('explains when the editor has no language model API', async () => {
    const saved = vscode.lm;
    vscode.lm = undefined;
    try {
      await assert.rejects(p.vscodeLmComplete({}, 's', 'u', { timeoutMs: 1000 }), /does not offer VS Code language models/);
    } finally {
      vscode.lm = saved;
    }
  });
});

describe('setup wizard', () => {
  const pick = (label) => (items) => items.find((i) => i.label === label);

  test('Codex CLI preset uses the tool default model when left empty', async () => {
    state.answers.push(pick('Codex CLI'), '', undefined);
    await p.configure();
    assert.equal(state.config['gitCompass.ai.provider'], 'cli');
    assert.equal(state.config['gitCompass.ai.cli.command'], 'codex');
    assert.deepEqual(state.config['gitCompass.ai.cli.args'], ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '-o', '{outputFile}', '-']);
    assert.equal(state.config['gitCompass.ai.cli.promptInput'], 'stdin');
  });

  test('CLI presets add the model flag when a model is given', async () => {
    state.answers.push(pick('Codex CLI'), 'my-model', undefined);
    await p.configure();
    assert.deepEqual(state.config['gitCompass.ai.cli.args'].slice(0, 3), ['exec', '-m', 'my-model']);
    state.answers.push(pick('Claude Code CLI'), 'some-model', undefined);
    await p.configure();
    assert.deepEqual(state.config['gitCompass.ai.cli.args'].slice(0, 2), ['--model', 'some-model']);
  });

  test('OpenRouter preset stores model and key', async () => {
    state.answers.push(pick('OpenRouter'), 'vendor/model-x', 'sk-or-test-123456', undefined);
    await p.configure();
    assert.equal(state.config['gitCompass.ai.provider'], 'openaiCompatible');
    assert.equal(state.config['gitCompass.ai.openaiCompatible.baseUrl'], 'https://openrouter.ai/api/v1');
    assert.equal(state.config['gitCompass.ai.openaiCompatible.model'], 'vendor/model-x');
    assert.equal(state.secrets.get('gitCompass.ai.key.openaiCompatible:openrouter.ai'), 'sk-or-test-123456');
  });

  test('Ollama preset never asks for a key', async () => {
    state.answers.push(pick('Ollama (local)'), 'llama-local', undefined);
    await p.configure();
    assert.equal(state.config['gitCompass.ai.openaiCompatible.baseUrl'], 'http://localhost:11434/v1');
    assert.equal(state.config['gitCompass.ai.openaiCompatible.model'], 'llama-local');
    assert.equal(state.secrets.size, 0);
  });

  test('custom command-line tool', async () => {
    state.answers.push(pick('Custom command-line tool'), 'my-agent', '--quiet "two words" {prompt}', (items) => items.find((i) => i.value === 'argument'), undefined);
    await p.configure();
    assert.equal(state.config['gitCompass.ai.cli.command'], 'my-agent');
    assert.deepEqual(state.config['gitCompass.ai.cli.args'], ['--quiet', 'two words', '{prompt}']);
    assert.equal(state.config['gitCompass.ai.cli.promptInput'], 'argument');
  });

  test('Turn AI off', async () => {
    state.config['gitCompass.ai.provider'] = 'cli';
    state.answers.push(pick('Turn AI off'), undefined);
    await p.configure();
    assert.equal(state.config['gitCompass.ai.provider'], 'none');
  });
});

describe('helpers', () => {
  test('splitArgs keeps quoted values and empty strings', () => {
    assert.deepEqual(p.splitArgs('-p --tools "" --x \'a b\''), ['-p', '--tools', '', '--x', 'a b']);
  });

  test('redact hides keys and bearer tokens', () => {
    assert.equal(p.redact('key sk-abcdefghijkl here'), 'key sk-*** here');
    assert.equal(p.redact('Authorization: Bearer abc.def-ghi_jkl'), 'Authorization: Bearer ***');
    assert.equal(p.redact('my token 0123456789', ['0123456789']), 'my token ***');
  });

  test('stripAnsi and truncateContext', () => {
    assert.equal(p.stripAnsi('\x1b[1;31mred\x1b[0m'), 'red');
    assert.deepEqual(p.truncateContext('abc', 10), { text: 'abc', truncated: false });
    assert.equal(p.truncateContext('abcdef', 3).truncated, true);
  });

  test('every preset is well formed', () => {
    for (const preset of p.PRESETS) {
      assert.ok(preset.label && preset.kind);
      if (preset.kind === 'cli' && !preset.custom) assert.ok(preset.cli.command && Array.isArray(preset.cli.args));
      if (preset.kind === 'openaiCompatible' && !preset.custom) assert.match(preset.baseUrl, /^https?:\/\//);
    }
  });
});
