import { AuthStorage, ModelRegistry, SessionManager, createAgentSession, DefaultResourceLoader, getAgentDir } from '@earendil-works/pi-coding-agent';

const BASE_URL = process.env.WEA_BASE_URL;
const API_KEY = process.env.WEA_API_KEY;
const MODEL_ID = process.env.WEA_MODEL;

const auth = AuthStorage.create('/tmp/wea-spike-auth.json');
auth.setRuntimeApiKey('anthropic', API_KEY);
const reg = ModelRegistry.inMemory(auth);
const base = reg.getAll().find(m => m.provider === 'anthropic' && m.id === 'claude-sonnet-5');
const model = { ...base, id: MODEL_ID, baseUrl: BASE_URL };

const loader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  systemPromptOverride: () => 'You are a terse assistant. Reply with exactly what is asked, nothing more.',
  appendSystemPromptOverride: () => [],
});
await loader.reload();

const { session } = await createAgentSession({
  model,
  authStorage: auth,
  modelRegistry: reg,
  resourceLoader: loader,
  sessionManager: SessionManager.inMemory(),
  noTools: 'all',
});

let finalMsg = null;
session.subscribe((ev) => {
  if (ev.type === 'message_end' && ev.message.role === 'assistant') finalMsg = ev.message;
});

const t0 = Date.now();
await session.prompt('Reply with the single word: PONG');
const dt = Date.now() - t0;

const text = finalMsg?.content?.filter(c => c.type === 'text').map(c => c.text).join('') ?? '(none)';
console.log('reply       :', JSON.stringify(text));
console.log('latency_ms  :', dt);
console.log('stopReason  :', finalMsg?.stopReason);
console.log('model       :', finalMsg?.model, '| provider:', finalMsg?.provider, '| api:', finalMsg?.api);
console.log('usage       :', JSON.stringify(finalMsg?.usage));
session.dispose();
