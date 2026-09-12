import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { format } from 'node:util';

const require = createRequire(import.meta.url);
interface Session { indexInfo: { closed: number }; currentRatchet: { rootKey: Buffer } }
const SessionRecord: new () => {
  closeSession(session: Session): void;
  openSession(session: Session): void;
  isClosed(session: Session): boolean;
} = require('libsignal/src/session_record.js');

test('Signal lifecycle logs never expose cryptographic session material', t => {
  const output: string[] = [];
  const capture = (...args: unknown[]) => { output.push(format(...args)); };
  t.mock.method(console, 'info', capture);
  t.mock.method(console, 'warn', capture);
  const secret = Buffer.from('1f8a4392b07e531622cbe9a4', 'hex');
  const session: Session = { indexInfo: { closed: -1 }, currentRatchet: { rootKey: secret } };
  const record = new SessionRecord();
  record.closeSession(session);
  assert.equal(record.isClosed(session), true);
  record.closeSession(session);
  record.openSession(session);
  assert.equal(record.isClosed(session), false);
  const hexBytes = secret.toString('hex').match(/../g)!.join(' ');
  assert.equal(output.join('\n').includes(hexBytes), false, 'secret key bytes were written to the terminal');
});
