import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createDJServer, type AgentRunner } from '../server/index.js';
import { emptyState, type BatchResult, type ServerMessage } from '../shared/contracts.js';

const servers: ReturnType<typeof createDJServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect(runner: AgentRunner, ackTimeoutMs = 1000) {
  const server = createDJServer({ agentRunner: runner, ackTimeoutMs, requestTimeoutMs: 2000 });
  servers.push(server);
  server.http.listen(0, '127.0.0.1');
  await once(server.http, 'listening');
  const address = server.http.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP address');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws`);
  sockets.push(socket);
  await once(socket, 'open');
  return { server, socket, port: address.port };
}

function receive(socket: WebSocket, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('message', listener); reject(new Error('No matching socket message')); }, 1500);
    const listener = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (predicate(message)) { clearTimeout(timeout); socket.off('message', listener); resolve(message); }
    };
    socket.on('message', listener);
  });
}

const request = { type: 'request', requestId: 'r1', text: 'Start music', state: emptyState(), tracks: [] };

describe('DJ server bridge', () => {
  it('returns the actual browser acknowledgement and allows only one batch', async () => {
    let secondBatchError = '';
    const { socket } = await connect(async (_, applyMix) => {
      const result = await applyMix([{ type: 'play', deck: 'A' }]);
      try { await applyMix([{ type: 'stop', deck: 'A' }]); }
      catch (error) { secondBatchError = (error as Error).message; }
      return result;
    });
    const toolCall = receive(socket, message => message.type === 'tool_call');
    const answer = receive(socket, message => message.type === 'assistant_message');
    const idle = receive(socket, message => message.type === 'agent_status' && message.status === 'idle');
    socket.send(JSON.stringify(request));
    const call = await toolCall;
    expect(call.type).toBe('tool_call');
    if (call.type !== 'tool_call') return;
    const result: BatchResult = { ok: true, message: 'Deck A is playing.', results: [{ ok: true, message: 'Playing.' }], state: emptyState() };
    socket.send(JSON.stringify({ type: 'tool_result', requestId: 'wrong', batchId: call.batchId, result }));
    socket.send(JSON.stringify({ type: 'tool_result', requestId: 'r1', batchId: 'wrong', result }));
    socket.send(JSON.stringify({ type: 'tool_result', requestId: 'r1', batchId: call.batchId, result }));
    expect(await answer).toMatchObject({ type: 'assistant_message', text: 'Deck A is playing.' });
    await idle;
    expect(secondBatchError).toMatch(/one apply_mix batch/);
  });

  it('fails a batch when the browser does not acknowledge it', async () => {
    const { socket } = await connect(async (_, applyMix) => applyMix([{ type: 'play', deck: 'A' }]), 30);
    const error = receive(socket, message => message.type === 'error');
    socket.send(JSON.stringify(request));
    expect(await error).toMatchObject({ type: 'error', requestId: 'r1', message: expect.stringMatching(/did not acknowledge/) });
  });

  it('keeps health and voice availability explicit when credentials are absent', async () => {
    const prior = [process.env.NEBIUS_API_KEY, process.env.NEBIUS_MODEL, process.env.ELEVENLABS_API_KEY];
    process.env.NEBIUS_API_KEY = '';
    process.env.NEBIUS_MODEL = '';
    process.env.ELEVENLABS_API_KEY = '';
    try {
      const { port } = await connect(async () => 'unused');
      const status = await fetch(`http://127.0.0.1:${port}/api/status`).then(response => response.json());
      expect(status).toMatchObject({ agent: false, speech: false, tts: false, model: null });
      const token = await fetch(`http://127.0.0.1:${port}/api/scribe-token`, { method: 'POST' });
      expect(token.status).toBe(503);
      const tts = await fetch(`http://127.0.0.1:${port}/api/tts`, { method: 'POST', body: JSON.stringify({ text: 'hello' }) });
      expect(tts.status).toBe(503);
    } finally {
      [process.env.NEBIUS_API_KEY, process.env.NEBIUS_MODEL, process.env.ELEVENLABS_API_KEY] = prior;
    }
  });
});
