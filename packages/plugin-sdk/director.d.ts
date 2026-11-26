import type { Json, MessageRef, RouteAddress } from './index.js';
export type MediaRef = { source: 'media'; id: string } | { source: 'character.avatar'; characterId: string } | { source: 'persona.avatar'; route: RouteAddress } | { source: 'story.gallery'; characterId: string; path: string } | { source: 'card.asset'; characterId: string; assetId: string };
export interface CharacterVisualAsset { ref: MediaRef; label?: string; tags?: string[]; confidence: number; origin: 'local-gallery' | 'remote-card' | 'avatar' }
export interface CharacterVisualEntry { name: string; aliases: string[]; traits?: string; references: CharacterVisualAsset[] }
export interface StoryParticipant { role: 'character' | 'persona'; id: string; name: string; description: string; avatar: MediaRef | null }
export interface ReplyCheckpoint { id: string; generationId: string; route: RouteAddress; draft: { messageId: string; swipeId: string; floor: number }; settledText: string; paragraphCount: number; kind: 'normal' | 'regenerate' }
export interface JobScheduleInput { key: string; queue?: 'realtime' | 'maintenance'; route?: RouteAddress; target?: MessageRef; generationId?: string; payload: Json }
export interface JobContext extends Omit<JobScheduleInput, 'queue' | 'route'> { id: string; route: RouteAddress | null }
export type ImageProviderKind = 'openai' | 'moss' | 'gemini' | 'novelai' | 'comfyui' | 'webui';
export type ImageCapability = 'negativePrompt' | 'seed' | 'aspectRatio' | 'characterReference' | 'styleReference' | 'spatialActors' | 'workflowSlots';
export interface ImageReferenceInput { image: MediaRef; role: 'character' | 'style' | 'composition'; weight?: number; subject?: string }
export interface SpatialActorPrompt { name?: string; prompt: string; negativePrompt?: string; center?: { x: number; y: number }; reference?: MediaRef }
export type AspectRatio = '1:1' | '3:2' | '2:3' | '4:3' | '3:4' | '16:9' | '9:16' | '21:9';
export interface ImageModelRequest { kind: 'image'; connection: string; prompt: string; negativePrompt?: string; size?: string; aspectRatio?: AspectRatio; seed?: number; references?: ImageReferenceInput[]; actors?: SpatialActorPrompt[]; workflow?: { profile: string; params?: Record<string, string | number | boolean> } }
export type ProseAnchorSpec = { kind: 'paragraph'; index: number; excerpt?: string } | { kind: 'marker'; token: string } | { kind: 'footer' };
export interface ReplyMediaSurfaceAction { id: string; label: string; title?: string; kind?: 'action' | 'command'; commandId?: string }
export interface ReplyMediaTake { id: string; seed?: number; prompt?: string; createdAt: number }
export interface ReplyMediaItem { slotId: string; status: 'developing' | 'ready' | 'failed'; label: string; subtitle?: string; revision?: string; generationId?: string; aspectRatio?: AspectRatio; palette?: [string,string]; presentation?: 'editorial' | 'bookmark' | 'polaroid'; anchor?: ProseAnchorSpec; commandId?: string; actions?: ReplyMediaSurfaceAction[]; takes?: ReplyMediaTake[]; activeTake?: number }
export interface StageCue { revision: string; backdropMediaId?: string; blurPx?: number; dimming?: number; ambientTint?: string; overrideThemeWallpaper?: boolean }
export interface MediaAction { slotId: string; action: 'reroll' | 'previous' | 'next' | 'bookmark' | 'stage' | 'custom'; customId?: string; target: MessageRef }
