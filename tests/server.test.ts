import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createDJServer, normalizeManualCommands, type AgentRunner, type AutonomyAgentRunner } from '../server/index.js';
import { emptyState, type BatchResult, type MusicalContext, type ServerMessage } from '../shared/contracts.js';

const servers: ReturnType<typeof createDJServer>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function connect(runner: AgentRunner, ackTimeoutMs = 1000, autonomyRunner?:AutonomyAgentRunner, autonomyTimeoutMs = 2000) {
  const server = createDJServer({ agentRunner: runner, autonomyAgentRunner:autonomyRunner, ackTimeoutMs, requestTimeoutMs: 2000, autonomyTimeoutMs });
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
const track = {id:'one',title:'One',artist:'Demo',tags:[] as string[],energy:'unknown' as const,source:'bundled' as const,loop:true};
const context:MusicalContext = {state:emptyState(),objective:'Keep playing',history:[],tracks:[track],now:null,upcoming:[],remainder:null,pending:null};
const autonomyRequest = {type:'autonomy_request',requestId:'auto-1',sessionId:'set-1',controlRevision:0,sourcePlaybackId:null,trigger:'cold_start',desiredInSeconds:null,hardDeadlineInSeconds:null,context};

describe('manual song-change guard', () => {
  it('turns a model load/play sequence into one transition while audio is playing', () => {
    const state = emptyState(); state.decks.A.status = 'playing'; state.decks.A.trackId = 'one'; state.decks.A.playbackId = 'play-one';
    expect(normalizeManualCommands({ text: 'Play the next track', state, tracks: [track] }, [
      { type: 'stop', deck: 'A' }, { type: 'load_track', deck: 'A', track_id: 'two' }, { type: 'play', deck: 'A' },
    ])).toEqual([{ type: 'transition', track_id: 'two', style: 'crossfade', duration_seconds: 4 }]);
    expect(normalizeManualCommands({ text: 'Stop the music', state, tracks: [track] }, [{ type: 'stop', deck: 'A' }])).toEqual([{ type: 'stop', deck: 'A' }]);
    const mixed = [{ type: 'load_track' as const, deck: 'A' as const, track_id: 'two' }, { type: 'play' as const, deck: 'A' as const }, { type: 'set_eq' as const, deck: 'A' as const, low_db: -6, mid_db: 0, high_db: 0 }];
    expect(normalizeManualCommands({ text: 'Play Loopy with less bass', state, tracks: [track] }, mixed)).toEqual(mixed);
  });
});

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

describe('autonomous decision bridge', () => {
  it('forwards one correlated decision and waits for browser acceptance', async () => {
    let secondError = '';
    const runner:AutonomyAgentRunner = async (_,submit) => {
      await submit({type:'start',track_id:'one',explanation:'Begin with the available loop.'});
      try { await submit({type:'start',track_id:'one',explanation:'Again.'}); }
      catch (error) { secondError = (error as Error).message; }
    };
    const {socket} = await connect(async () => 'unused',1000,runner);
    const decisionPromise = receive(socket,message => message.type === 'dj_decision');
    const idlePromise = receive(socket,message => message.type === 'agent_status' && message.status === 'idle');
    socket.send(JSON.stringify(autonomyRequest));
    const decision = await decisionPromise;
    expect(decision).toMatchObject({type:'dj_decision',requestId:'auto-1',sessionId:'set-1',controlRevision:0,sourcePlaybackId:null,decision:{type:'start',track_id:'one'}});
    if (decision.type !== 'dj_decision') return;
    socket.send(JSON.stringify({type:'decision_result',requestId:'wrong',decisionId:decision.decisionId,result:{accepted:true,message:'Wrong request'}}));
    socket.send(JSON.stringify({type:'decision_result',requestId:'auto-1',decisionId:'wrong',result:{accepted:true,message:'Wrong decision'}}));
    socket.send(JSON.stringify({type:'decision_result',requestId:'auto-1',decisionId:decision.decisionId,result:{accepted:true,message:'Accepted for preparation.'}}));
    await idlePromise;
    expect(secondError).toMatch(/Only one autonomous decision/);
  });

  it('rejects absent or invalid decisions without forwarding them', async () => {
    const absent = await connect(async () => 'unused',1000,async () => 'I would start a track.');
    const error = receive(absent.socket,message => message.type === 'error');
    absent.socket.send(JSON.stringify(autonomyRequest));
    expect(await error).toMatchObject({type:'error',requestId:'auto-1',message:expect.stringMatching(/did not submit/)});

    const invalid = await connect(async () => 'unused',1000,async (_,submit) => submit({type:'start',track_id:'missing',explanation:'Unavailable.'}));
    const invalidError = receive(invalid.socket,message => message.type === 'error');
    invalid.socket.send(JSON.stringify({...autonomyRequest,requestId:'auto-2'}));
    expect(await invalidError).toMatchObject({type:'error',requestId:'auto-2',message:expect.stringMatching(/unavailable/)});
  });

  it('aborts an overdue autonomous request and ignores a late decision', async () => {
    let submitLate:((decision:{type:'start';track_id:string;explanation:string})=>Promise<string>)|undefined;
    const runner:AutonomyAgentRunner = async (_,submit) => { submitLate = submit; await new Promise(resolve => setTimeout(resolve,50)); };
    const {socket} = await connect(async () => 'unused',1000,runner,20);
    const error = receive(socket,message => message.type === 'error');
    socket.send(JSON.stringify(autonomyRequest));
    expect(await error).toMatchObject({type:'error',requestId:'auto-1',message:'Agent request timed out.'});
    await new Promise(resolve => setTimeout(resolve,60));
    await expect(submitLate!({type:'start',track_id:'one',explanation:'Too late.'})).rejects.toThrow(/cancelled/);
  });
});
