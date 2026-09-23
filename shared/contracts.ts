import { z } from 'zod';
export const DeckIdSchema = z.enum(['A', 'B']);
export type DeckId = z.infer<typeof DeckIdSchema>;
const finite = () => z.number().finite();
export const TrackSchema = z.object({
  id: z.string().min(1).max(100), title: z.string().max(150), artist: z.string().max(100),
  tags: z.array(z.string().max(30)).max(10), energy: z.enum(['low', 'medium', 'high', 'unknown']),
  source: z.enum(['bundled', 'local']), loop: z.boolean(),
});
export type Track = z.infer<typeof TrackSchema>;
export type AudioTrack = Track & { url: string };
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('get_dj_state') }),
  z.object({ type: z.literal('load_track'), deck: DeckIdSchema, track_id: z.string().min(1) }),
  z.object({ type: z.literal('play'), deck: DeckIdSchema }),
  z.object({ type: z.literal('stop'), deck: DeckIdSchema }),
  z.object({ type: z.literal('set_eq'), deck: DeckIdSchema, low_db: finite().min(-24).max(6), mid_db: finite().min(-24).max(6), high_db: finite().min(-24).max(6) }),
  z.object({ type: z.literal('set_filter'), deck: DeckIdSchema, mode: z.enum(['off','lowpass','highpass']), frequency_hz: finite().min(40).max(16000), duration_seconds: finite().min(0).max(10) }),
  z.object({ type: z.literal('transition'), track_id: z.string().min(1), style: z.enum(['crossfade','filter','echo']), duration_seconds: finite().min(1).max(12) }),
]);
export type Command = z.infer<typeof CommandSchema>;
export const CommandsSchema = z.array(CommandSchema).min(1).max(4).refine(
  commands => commands.filter(c => c.type === 'transition').length <= 1 && commands.every((c,i) => c.type !== 'transition' || i === commands.length-1),
  'A transition must be the final command and appear at most once.',
);
export const DeckStateSchema = z.object({
  trackId: z.string().nullable(), status: z.enum(['empty','loading','ready','playing','stopped']),
  position: finite().min(0), duration: finite().min(0), loop: z.boolean(), volume: finite().min(0).max(1),
  eq: z.object({low: finite(), mid: finite(), high: finite()}),
  filter: z.object({mode: z.enum(['off','lowpass','highpass']), frequency: finite()}),
});
export type DeckState = z.infer<typeof DeckStateSchema>;
export const DJStateSchema = z.object({
  unlocked: z.boolean(), decks: z.object({A: DeckStateSchema, B: DeckStateSchema}),
  crossfader: finite().min(0).max(1), masterVolume: finite().min(0).max(1),
  transition: z.object({id: z.string(), from: DeckIdSchema, to: DeckIdSchema, style: z.enum(['crossfade','filter','echo']), progress: finite().min(0).max(1)}).nullable(),
});
export type DJState = z.infer<typeof DJStateSchema>;
export const CommandResultSchema = z.object({ ok: z.boolean(), message: z.string(), code: z.string().optional(), scheduled: z.boolean().optional() });
export type CommandResult = z.infer<typeof CommandResultSchema>;
export const BatchResultSchema = z.object({ok: z.boolean(), message: z.string(), results: z.array(CommandResultSchema), state: DJStateSchema});
export type BatchResult = z.infer<typeof BatchResultSchema>;
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('request'), requestId: z.string(), text: z.string().trim().min(1).max(2000), state: DJStateSchema, tracks: z.array(TrackSchema).max(20)}),
  z.object({type: z.literal('tool_result'), requestId: z.string(), batchId: z.string(), result: BatchResultSchema}),
  z.object({type: z.literal('cancel'), requestId: z.string()}),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('tool_call'), requestId: z.string(), batchId: z.string(), commands: CommandsSchema}),
  z.object({type: z.literal('agent_status'), requestId: z.string(), status: z.enum(['thinking','applying','idle'])}),
  z.object({type: z.literal('assistant_message'), requestId: z.string(), text: z.string()}),
  z.object({type: z.literal('error'), requestId: z.string(), message: z.string()}),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServiceStatus = { agent: boolean; speech: boolean; tts: boolean; model: string | null };
export interface AudioEngine {
  unlock(): Promise<void>;
  execute(command: Command): Promise<CommandResult>;
  getState(): DJState;
  subscribe(listener: () => void): () => void;
  setTracks(tracks: AudioTrack[]): void;
  setCrossfader(value: number): void;
  setMasterVolume(value: number): void;
  setDeckVolume(deck: DeckId, value: number): void;
  setDucking(active: boolean): void;
  getWaveform(deck: DeckId): Float32Array;
  getLevel(deck?: DeckId): number;
  stopAll(): void;
  dispose(): void;
}
export function emptyState(): DJState {
  const deck = (): DeckState => ({trackId:null,status:'empty',position:0,duration:0,loop:false,volume:0.8,eq:{low:0,mid:0,high:0},filter:{mode:'off',frequency:16000}});
  return {unlocked:false,decks:{A:deck(),B:deck()},crossfader:0,masterVolume:0.65,transition:null};
}
