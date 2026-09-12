import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';

test('retired OpenAI credentials cannot authorize the Groq runtime', () => {
  assert.throws(() => loadConfig({ OPENAI_API_KEY: 'retired-provider-key' }, []));
});
