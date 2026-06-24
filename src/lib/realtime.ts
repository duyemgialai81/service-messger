import { Client, type StompSubscription } from "@stomp/stompjs";
import api from "./api";
import { localStorage_service } from "./localStorage";

export const REALTIME_NOTIFICATION_EVENT = "ksp:realtime-notification";
export const INCOMING_CALL_EVENT = "ksp:incoming-call";
export const PENDING_CALL_STORAGE_KEY = "ksp_pending_call";

type RealtimeNotificationType = "message" | "call" | "mention" | "system" | "like" | "comment" | "follow" | "badge" | "report";

export interface RealtimeNotificationDetail {
  id?: string;
  type: RealtimeNotificationType;
  title: string;
  description?: string;
  createdAt?: string;
  link?: string;
  payload?: unknown;
}

export type PostRealtimeEventType = "likes" | "new-comment" | "update-comment" | "delete-comment" | "views";

export interface PostRealtimeEvent {
  type: PostRealtimeEventType;
  body: string;
}

type PostRealtimeListener = (event: PostRealtimeEvent) => void;

const POST_REALTIME_TOPICS: PostRealtimeEventType[] = ["likes", "new-comment", "update-comment", "delete-comment", "views"];
const postRealtimeListeners = new Map<string, Set<PostRealtimeListener>>();
const postRealtimeSubscriptions = new Map<string, StompSubscription[]>();
let postRealtimeClient: Client | null = null;
let postRealtimeIdleTimer: ReturnType<typeof setTimeout> | null = null;

export function createRealtimeConnection() {
  return new WebSocket(api.getNativeWebSocketUrl());
}

function subscribePostTopics(postId: string) {
  const client = postRealtimeClient;
  if (!client?.connected || postRealtimeSubscriptions.has(postId)) return;
  const subscriptions = POST_REALTIME_TOPICS.map((type) =>
    client.subscribe(`/topic/post/${postId}/${type}`, (message) => {
      postRealtimeListeners.get(postId)?.forEach((listener) => {
        try { listener({ type, body: message.body }); } catch (e) { console.error(`[Post realtime] Invalid ${type} payload`, e); }
      });
    }),
  );
  postRealtimeSubscriptions.set(postId, subscriptions);
}

function ensurePostRealtimeClient() {
  if (postRealtimeIdleTimer) { clearTimeout(postRealtimeIdleTimer); postRealtimeIdleTimer = null; }
  if (postRealtimeClient?.active) return;
  const token = localStorage_service.getAuthToken();
  if (!token) return;
  const client = new Client({
    webSocketFactory: () => createRealtimeConnection(),
    connectHeaders: { Authorization: `Bearer ${token}` },
    reconnectDelay: 5000, heartbeatIncoming: 10000, heartbeatOutgoing: 10000,
    debug: () => {},
    onConnect: () => {
      if (postRealtimeClient !== client) return;
      postRealtimeSubscriptions.clear();
      postRealtimeListeners.forEach((_l, postId) => subscribePostTopics(postId));
    },
    onWebSocketClose: () => { if (postRealtimeClient === client) postRealtimeSubscriptions.clear(); },
    onStompError: (frame) => { console.error("[Post realtime]", frame.headers.message || frame.body); },
  });
  postRealtimeClient = client;
  client.activate();
}

export function subscribePostRealtime(postId: string, listener: PostRealtimeListener) {
  const normalizedPostId = String(postId || "").trim();
  if (!normalizedPostId) return () => {};
  const listeners = postRealtimeListeners.get(normalizedPostId) || new Set<PostRealtimeListener>();
  listeners.add(listener);
  postRealtimeListeners.set(normalizedPostId, listeners);
  ensurePostRealtimeClient();
  subscribePostTopics(normalizedPostId);
  return () => {
    const active = postRealtimeListeners.get(normalizedPostId);
    active?.delete(listener);
    if (active?.size) return;
    postRealtimeListeners.delete(normalizedPostId);
    postRealtimeSubscriptions.get(normalizedPostId)?.forEach((s) => { try { s.unsubscribe(); } catch {} });
    postRealtimeSubscriptions.delete(normalizedPostId);
    if (postRealtimeListeners.size === 0 && postRealtimeClient?.active) {
      postRealtimeIdleTimer = setTimeout(() => {
        if (postRealtimeListeners.size > 0) return;
        const c = postRealtimeClient;
        postRealtimeClient = null;
        postRealtimeSubscriptions.clear();
        if (c?.active) void c.deactivate();
      }, 5000);
    }
  };
}

export function emitRealtimeNotification(detail: RealtimeNotificationDetail) {
  window.dispatchEvent(new CustomEvent<RealtimeNotificationDetail>(REALTIME_NOTIFICATION_EVENT, { detail: { createdAt: new Date().toISOString(), ...detail } }));
}

export function emitIncomingCall(detail: unknown) {
  window.dispatchEvent(new CustomEvent(INCOMING_CALL_EVENT, { detail }));
}

export function savePendingCall(call: unknown) {
  try { sessionStorage.setItem(PENDING_CALL_STORAGE_KEY, JSON.stringify({ savedAt: Date.now(), call })); } catch {}
}

export function readPendingCall<T = any>(maxAgeMs = 120000): T | null {
  try {
    const raw = sessionStorage.getItem(PENDING_CALL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > maxAgeMs) { sessionStorage.removeItem(PENDING_CALL_STORAGE_KEY); return null; }
    return parsed.call || null;
  } catch { return null; }
}

export function clearPendingCall() {
  try { sessionStorage.removeItem(PENDING_CALL_STORAGE_KEY); } catch {}
}
