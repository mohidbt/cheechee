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
export type ReviewedCue = { fileSeconds: number; endSeconds: number; kind: 'loop_exit' | 'post_break_exit'; provenance: 'manual'; reviewed: true; label: string };
export type TrackCueSet = { cueInSeconds: number; cueInLabel: string; reviewedPulseGrid?: { bpm: number; firstPulseSeconds: number; provenance: 'manual'; reviewed: true }; exits: ReviewedCue[] };
export const TrackAnalysisSchema = z.object({
  contentKey: z.string().min(1), analysisVersion: z.number().int().min(1),
  durationSeconds: z.object({ value: finite().min(0), provenance: z.literal('measured') }),
  rms: z.object({ windowSeconds: finite().positive(), values: z.array(finite().min(0)).max(20000), provenance: z.literal('measured') }),
  estimatedTempo: z.object({ bpm: finite().positive(), firstBeatOffsetSeconds: finite().min(0), sourceStartSeconds: finite().min(0), sourceDurationSeconds: finite().positive(), provenance: z.literal('estimated'), reviewed: z.literal(false) }).nullable(),
});
export type TrackAnalysis = z.infer<typeof TrackAnalysisSchema>;
export const CommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('get_dj_state') }),
  z.object({ type: z.literal('load_track'), deck: DeckIdSchema, track_id: z.string().min(1) }),
  z.object({ type: z.literal('play'), deck: DeckIdSchema }),
  z.object({ type: z.literal('stop'), deck: DeckIdSchema }),
  z.object({ type: z.literal('set_eq'), deck: DeckIdSchema, low_db: finite().min(-24).max(6), mid_db: finite().min(-24).max(6), high_db: finite().min(-24).max(6) }),
  z.object({ type: z.literal('set_filter'), deck: DeckIdSchema, mode: z.enum(['off','lowpass','highpass']), frequency_hz: finite().min(40).max(16000), duration_seconds: finite().min(0).max(10) }),
  z.object({ type: z.literal('transition'), track_id: z.string().min(1), style: z.enum(['crossfade','filter','echo']), duration_seconds: finite().min(1).max(12), timing: z.enum(['immediate','next_cue']).optional() }),
]);
export type Command = z.infer<typeof CommandSchema>;
export const CommandsSchema = z.array(CommandSchema).min(1).max(4).refine(
  commands => commands.filter(c => c.type === 'transition').length <= 1 && commands.every((c,i) => c.type !== 'transition' || i === commands.length-1),
  'A transition must be the final command and appear at most once.',
);
export const DeckStateSchema = z.object({
  trackId: z.string().nullable(), status: z.enum(['empty','loading','ready','playing','stopped']),
  playbackId: z.string().nullable(), playedSeconds: finite().min(0),
  position: finite().min(0), duration: finite().min(0), loop: z.boolean(), volume: finite().min(0).max(1),
  eq: z.object({low: finite(), mid: finite(), high: finite()}),
  filter: z.object({mode: z.enum(['off','lowpass','highpass']), frequency: finite()}),
});
export type DeckState = z.infer<typeof DeckStateSchema>;
export const DJStateSchema = z.object({
  unlocked: z.boolean(), audioTime: finite().min(0), decks: z.object({A: DeckStateSchema, B: DeckStateSchema}),
  crossfader: finite().min(0).max(1), masterVolume: finite().min(0).max(1),
  transition: z.object({id: z.string(), from: DeckIdSchema, to: DeckIdSchema, style: z.enum(['crossfade','filter','echo']), progress: finite().min(0).max(1)}).nullable(),
});
export type DJState = z.infer<typeof DJStateSchema>;
export const CommandResultSchema = z.object({ ok: z.boolean(), message: z.string(), code: z.string().optional(), scheduled: z.boolean().optional() });
export type CommandResult = z.infer<typeof CommandResultSchema>;
export const BatchResultSchema = z.object({ok: z.boolean(), message: z.string(), results: z.array(CommandResultSchema), state: DJStateSchema});
export type BatchResult = z.infer<typeof BatchResultSchema>;
export const DecisionSchema = z.discriminatedUnion('type', [
  z.object({type:z.literal('start'), track_id:z.string().min(1), explanation:z.string().trim().min(1).max(200)}),
  z.object({type:z.literal('transition'), track_id:z.string().min(1), style:z.enum(['crossfade','filter','echo']), duration_seconds:finite().min(1).max(12), explanation:z.string().trim().min(1).max(200)}),
  z.object({type:z.literal('wait'), defer_seconds:finite().min(1).max(15), explanation:z.string().trim().min(1).max(200)}),
]);
export type Decision = z.infer<typeof DecisionSchema>;
export const PlayedTrackSchema = z.object({trackId:z.string().min(1), playbackId:z.string().min(1), playedSeconds:finite().min(0)});
export type PlayedTrack = z.infer<typeof PlayedTrackSchema>;
export const MusicalContextSchema = z.object({
  state: DJStateSchema,
  objective: z.string().max(500),
  requestedChangeIntervalSeconds: finite().min(20).max(120).optional(),
  history: z.array(PlayedTrackSchema).max(10),
  tracks: z.array(TrackSchema).max(20),
  analysis: z.array(z.object({ trackId: z.string(), bpm: finite().positive().nullable(), firstBeatOffsetSeconds: finite().min(0).nullable(), provenance: z.literal('estimated'), reviewed: z.literal(false) })).max(20).optional(),
  now: z.object({deck:DeckIdSchema, trackId:z.string(), playbackId:z.string(), positionSeconds:finite().min(0), playedSeconds:finite().min(0), durationSeconds:finite().min(0), loop:z.boolean(), section:z.string().max(100).optional()}).nullable(),
  upcoming: z.array(z.object({kind:z.string().max(60), fileSeconds:finite().min(0), secondsUntil:finite().min(0).max(60), provenance:z.enum(['measured','estimated','derived','manual']), reviewed:z.boolean(), label:z.string().max(100).optional(), alignment:z.enum(['estimated_beat_grid','reviewed_pulse_grid','window_center']).optional()})).max(8),
  remainder: z.object({naturalSeconds:finite().min(0).nullable(), residenceSeconds:finite().min(0).nullable(), laterExits:z.array(z.object({fileSeconds:finite().min(0), secondsUntil:finite().min(0), provenance:z.enum(['measured','estimated','derived','manual']).optional(), reviewed:z.boolean().optional()})).max(3)}).nullable(),
  pending: z.object({trackId:z.string(), prepared:z.boolean(), committed:z.boolean(), cancellable:z.boolean(), secondsUntilStart:finite().min(0).optional()}).nullable(),
});
export type MusicalContext = z.infer<typeof MusicalContextSchema>;
export const DecisionAckSchema = z.object({accepted:z.boolean(), message:z.string().max(500), code:z.string().max(80).optional()});
export type DecisionAck = z.infer<typeof DecisionAckSchema>;
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('request'), requestId: z.string(), text: z.string().trim().min(1).max(2000), state: DJStateSchema, tracks: z.array(TrackSchema).max(20), context:MusicalContextSchema.optional()}),
  z.object({type:z.literal('autonomy_request'), requestId:z.string().min(1), sessionId:z.string().min(1), controlRevision:z.number().int().min(0), sourcePlaybackId:z.string().nullable(), trigger:z.enum(['cold_start','planning','recovery']), desiredInSeconds:finite().min(0).nullable(), hardDeadlineInSeconds:finite().min(0).nullable(), context:MusicalContextSchema}),
  z.object({type: z.literal('tool_result'), requestId: z.string(), batchId: z.string(), result: BatchResultSchema}),
  z.object({type:z.literal('decision_result'), requestId:z.string(), decisionId:z.string(), result:DecisionAckSchema}),
  z.object({type: z.literal('cancel'), requestId: z.string()}),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export const ServerMessageSchema = z.discriminatedUnion('type', [
  z.object({type: z.literal('tool_call'), requestId: z.string(), batchId: z.string(), commands: CommandsSchema}),
  z.object({type:z.literal('dj_decision'), requestId:z.string(), decisionId:z.string(), sessionId:z.string(), controlRevision:z.number().int(), sourcePlaybackId:z.string().nullable(), decision:DecisionSchema}),
  z.object({type: z.literal('agent_status'), requestId: z.string(), status: z.enum(['thinking','applying','idle'])}),
  z.object({type: z.literal('assistant_message'), requestId: z.string(), text: z.string()}),
  z.object({type: z.literal('error'), requestId: z.string(), message: z.string()}),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServiceStatus = { agent: boolean; speech: boolean; tts: boolean; model: string | null };
export type AudioLifecycleEvent =
  | {type:'started'; deck:DeckId; trackId:string; playbackId:string; audioTime:number}
  | {type:'ended'; deck:DeckId; trackId:string; playbackId:string; audioTime:number; reason:'natural'|'stopped'|'transition'|'stop_all'}
  | {type:'transition_started'|'transition_completed'; transitionId:string; from:DeckId; to:DeckId; fromPlaybackId:string; toPlaybackId:string; audioTime:number}
  | {type:'audio_suspended'; audioTime:number};
export interface AudioEngine {
  unlock(): Promise<void>;
  execute(command: Command): Promise<CommandResult>;
  getState(): DJState;
  getAudioTime(): number;
  analyzeTrack(trackId: string): Promise<TrackAnalysis>;
  getTrackAnalysis(trackId: string): TrackAnalysis | null;
  subscribe(listener: () => void): () => void;
  subscribeLifecycle(listener: (event: AudioLifecycleEvent) => void): () => void;
  prepareTrack(trackId: string): Promise<CommandResult>;
  commitStart(trackId: string, incomingOffsetSeconds?: number): Promise<CommandResult>;
  commitTransition(command: Extract<Command, {type:'transition'}>, atAudioTime?: number, incomingOffsetSeconds?: number): CommandResult;
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
  const deck = (): DeckState => ({trackId:null,status:'empty',playbackId:null,playedSeconds:0,position:0,duration:0,loop:false,volume:0.8,eq:{low:0,mid:0,high:0},filter:{mode:'off',frequency:16000}});
  return {unlocked:false,audioTime:0,decks:{A:deck(),B:deck()},crossfader:0,masterVolume:0.65,transition:null};
}
