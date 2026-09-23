import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { ClientMessageSchema, CommandsSchema, DecisionSchema, type Command, type Decision } from '../shared/contracts.js';
import { envStatus, liveAgentRunner, liveAutonomyAgentRunner } from './index.js';

const DEFAULT_VOICE = 'EXAVITQu4vr4xnSDxMaL';
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown server error.';

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host && new URL(origin).protocol === new URL(request.url).protocol; }
  catch { return false; }
}

async function body(request: Request) {
  const text = await request.text();
  if (text.length > 64 * 1024) throw new Error('Request body is too large.');
  return JSON.parse(text);
}

export async function status(request: Request): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
  return json(envStatus());
}

export async function scribeToken(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!sameOrigin(request)) return json({ error: 'Same origin required.' }, 403);
  if (!envStatus().speech) return json({ error: 'Speech input is unavailable.' }, 503);
  try {
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });
    const result = await client.tokens.singleUse.create('realtime_scribe');
    return json({ token: result.token });
  } catch (error) { return json({ error: `Could not start speech input: ${errorMessage(error)}` }, 502); }
}

export async function tts(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!sameOrigin(request)) return json({ error: 'Same origin required.' }, 403);
  if (!envStatus().tts) return json({ error: 'Speech output is unavailable.' }, 503);
  try {
    const input = z.object({ text: z.string().trim().min(1).max(500) }).parse(await body(request));
    const client = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY! });
    const audio = await client.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE, {
      text: input.text, modelId: process.env.ELEVENLABS_TTS_MODEL || 'eleven_flash_v2_5', outputFormat: 'mp3_44100_128',
    }, { abortSignal: request.signal });
    return new Response(audio as ReadableStream<Uint8Array>, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
  } catch (error) { return json({ error: errorMessage(error) }, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 502); }
}

export async function agent(request: Request): Promise<Response> {
  if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
  if (!sameOrigin(request)) return json({ error: 'Same origin required.' }, 403);
  if (!envStatus().agent) return json({ error: 'DJ agent is unavailable.' }, 503);
  try {
    const input = ClientMessageSchema.parse(await body(request));
    if (input.type !== 'request' && input.type !== 'autonomy_request') return json({ error: 'Invalid request type.' }, 400);
    const limit = input.type === 'autonomy_request' ? 10_000 : 30_000;
    const timeout = AbortSignal.timeout(limit);
    const signal = AbortSignal.any([request.signal, timeout]);
    if (input.type === 'autonomy_request') {
      let chosen: Decision | undefined;
      const answer = await liveAutonomyAgentRunner({
        trigger: input.trigger, sessionId: input.sessionId, controlRevision: input.controlRevision,
        sourcePlaybackId: input.sourcePlaybackId, desiredInSeconds: input.desiredInSeconds,
        hardDeadlineInSeconds: input.hardDeadlineInSeconds, context: input.context,
      }, async candidate => {
        if (signal.aborted) throw new Error('Request timed out.');
        if (chosen) throw new Error('Only one autonomous decision is allowed.');
        const decision = DecisionSchema.parse(candidate);
        if (decision.type === 'start' && input.sourcePlaybackId !== null) throw new Error('Start requires an idle source.');
        if (decision.type !== 'start' && input.sourcePlaybackId === null) throw new Error('A playing source is required.');
        if ('track_id' in decision && !input.context.tracks.some(track => track.id === decision.track_id)) throw new Error('Selected track is unavailable.');
        chosen = decision;
        return 'The browser will validate the proposed move.';
      }, signal);
      if (!chosen) throw new Error(answer || 'The model did not submit a valid DJ decision.');
      return json({ type: 'dj_decision', requestId: input.requestId, decisionId: randomUUID(), sessionId: input.sessionId,
        controlRevision: input.controlRevision, sourcePlaybackId: input.sourcePlaybackId, decision: chosen });
    }
    let commands: Command[] | undefined;
    const answer = await liveAgentRunner({ text: input.text, state: input.state, tracks: input.tracks, context: input.context }, async candidate => {
      if (signal.aborted) throw new Error('Request timed out.');
      if (commands) throw new Error('Only one apply_mix batch is allowed.');
      const validated = CommandsSchema.parse(candidate);
      for (const command of validated) if ('track_id' in command && !input.tracks.some(track => track.id === command.track_id)) throw new Error('Selected track is unavailable.');
      commands = validated;
      return 'The browser will execute the validated commands.';
    }, signal);
    return commands ? json({ type: 'tool_call', requestId: input.requestId, batchId: randomUUID(), commands })
      : json({ type: 'assistant_message', requestId: input.requestId, text: answer || 'No DJ action was needed.' });
  } catch (error) {
    return json({ error: errorMessage(error) }, error instanceof z.ZodError || error instanceof SyntaxError ? 400 : 502);
  }
}
