import 'dotenv/config';
import { z } from 'zod';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { envStatus, DEFAULT_VOICE } from './config.js';

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
export const errorMessage = (error: unknown) => error instanceof Error ? error.message : 'Unknown server error.';

export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host && new URL(origin).protocol === new URL(request.url).protocol; }
  catch { return false; }
}

export async function body(request: Request) {
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
