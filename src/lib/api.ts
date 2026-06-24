import { localStorage_service } from './localStorage';

const DEFAULT_API_BASE = 'https://duyem.duckdns.org';
const DEFAULT_BROWSER_API_BASE = '/backend';

function normalizeHttpUrl(value?: string) {
  const raw = (value || DEFAULT_BROWSER_API_BASE).trim().replace(/\/+$/, '');
  if (!raw) return DEFAULT_BROWSER_API_BASE;
  if (raw.startsWith('/')) return raw;
  const httpUrl = raw.startsWith('ws://')
    ? `http://${raw.slice('ws://'.length)}`
    : raw.startsWith('wss://')
      ? `https://${raw.slice('wss://'.length)}`
      : /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return httpUrl.replace(/\/+$/, '');
}

export const API_BASE = normalizeHttpUrl(
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_URL) || DEFAULT_BROWSER_API_BASE
);

function resolveRealtimeUrl(value: string | undefined, fallbackPath: string) {
  const configured = (value || "").trim();
  if (!configured) return `${DEFAULT_API_BASE}${fallbackPath}`;
  if (configured === "/backend" || configured.startsWith("/backend/")) {
    return `${DEFAULT_API_BASE}${configured.slice("/backend".length) || fallbackPath}`;
  }
  return configured;
}

export const WS_BASE = normalizeHttpUrl(
  resolveRealtimeUrl(
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL),
    "/ws"
  )
);

function normalizeWsUrl(value?: string) {
  const httpUrl = normalizeHttpUrl(value);
  if (httpUrl.startsWith('/')) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${httpUrl}`;
  }
  return httpUrl.startsWith('https://')
    ? `wss://${httpUrl.slice('https://'.length)}`
    : httpUrl.startsWith('http://')
      ? `ws://${httpUrl.slice('http://'.length)}`
      : httpUrl;
}

export const WS_NATIVE_BASE = normalizeWsUrl(
  resolveRealtimeUrl(
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_NATIVE_URL),
    "/ws-native"
  )
);

const PUBLIC_AUTH_PATHS = [
  '/api/auth/login',
  '/api/auth/register',
  '/api/auth/register/request-otp',
  '/api/auth/google/login',
  '/api/auth/forgot-password/request-otp',
  '/api/auth/forgot-password/reset',
];

type TimedCacheEntry<T> = { savedAt: number; value: T };

const USER_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAT_CONVERSATIONS_PAGE_CACHE_TTL_MS = 2 * 1000;
const CHAT_MESSAGES_PAGE_CACHE_TTL_MS = 8 * 1000;
const NOTIFICATIONS_PAGE_CACHE_TTL_MS = 15 * 1000;

const userProfileCache = new Map<string, TimedCacheEntry<any>>();
const userProfileInflight = new Map<string, Promise<any>>();
const chatConversationsPageCache = new Map<string, TimedCacheEntry<any>>();
const chatConversationsPageInflight = new Map<string, Promise<any>>();
const chatMessagesPageCache = new Map<string, TimedCacheEntry<any>>();
const chatMessagesPageInflight = new Map<string, Promise<any>>();
const notificationsPageCache = new Map<string, TimedCacheEntry<any>>();
const notificationsPageInflight = new Map<string, Promise<any>>();

function isPublicAuthPath(path: string) {
  return PUBLIC_AUTH_PATHS.includes(path.split('?')[0]);
}

export function getWebSocketUrl() { return WS_BASE; }
export function getNativeWebSocketUrl() { return WS_NATIVE_BASE; }

export function normalizeAssetUrl(value?: string) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  if (/^(data:|blob:)/i.test(raw)) return raw;
  const stripProxyPrefixes = (pathname: string) => {
    const withLeadingSlash = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return withLeadingSlash.replace(/^(?:\/backend)+(?=\/|$)/i, '') || '/';
  };
  if (/^https?:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const browserOrigin = typeof window !== 'undefined' ? window.location.origin : '';
      const backendOrigin = new URL(DEFAULT_API_BASE).origin;
      if (parsed.origin === browserOrigin) {
        return `${API_BASE.replace(/\/+$/, '')}${stripProxyPrefixes(parsed.pathname)}${parsed.search}${parsed.hash}`;
      }
      if (parsed.origin === backendOrigin) {
        parsed.pathname = stripProxyPrefixes(parsed.pathname);
        return parsed.toString();
      }
    } catch { return raw; }
    return raw;
  }
  const parsed = new URL(raw, 'http://asset.local');
  return `${API_BASE.replace(/\/+$/, '')}${stripProxyPrefixes(parsed.pathname)}${parsed.search}${parsed.hash}`;
}

export function normalizeAvatarUrl(value?: string, seed?: string) {
  const raw = typeof value === 'string' ? value.trim() : '';
  const fallback = getAvatarFallbackDataUrl(seed);
  if (!raw) return fallback;
  if (/^blob:/i.test(raw)) return fallback;
  if (/^data:/i.test(raw)) return raw;
  if (/^\/?avt\d+\.png$/i.test(raw)) return fallback;
  if (/^https?:\/\/api\.dicebear\.com\//i.test(raw)) return fallback;
  return normalizeAssetUrl(raw) || fallback;
}

export function getAvatarFallbackDataUrl(seed?: string) {
  const normalizedSeed = String(seed || 'U');
  const hash = Array.from(normalizedSeed).reduce(
    (value, character) => ((value * 31) + (character.codePointAt(0) || 0)) >>> 0, 0,
  );
  const colors = ['0f766e', '2563eb', '7c3aed', 'c2410c', 'be123c', '0369a1'];
  const background = colors[hash % colors.length];
  const label = normalizedSeed.trim().charAt(0).toUpperCase() || 'U';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="24" fill="#${background}"/><text x="48" y="58" text-anchor="middle" font-family="Arial,sans-serif" font-size="36" font-weight="700" fill="#fff">${label.replace(/[<>&"']/g, '')}</text></svg>`;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

async function safeJson(res: Response) {
  try { return await res.json(); } catch { return undefined; }
}

export async function request(method: string, path: string, body?: any, token?: string, signal?: AbortSignal) {
  const publicAuthRequest = isPublicAuthPath(path);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const _token = token || localStorage_service.getAuthToken();
  if (_token && !publicAuthRequest) headers['Authorization'] = `Bearer ${_token}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const res = await fetch(`${API_BASE}${normalizedPath}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
    cache: publicAuthRequest ? 'no-store' : 'default',
    signal,
  });
  const parsed = await safeJson(res);
  if (!res.ok) {
    const message = parsed?.message || JSON.stringify(parsed || {});
    throw new Error(`API error: ${res.status} ${message}`);
  }
  if (parsed && typeof parsed === 'object' && parsed.isSuccess === false) {
    throw new Error(parsed.message || 'Backend request failed');
  }
  return parsed;
}

async function publicGet(path: string) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const res = await fetch(`${API_BASE}${normalizedPath}`, { method: 'GET', credentials: 'include' });
  const parsed = await safeJson(res);
  if (!res.ok) throw new Error(`API error: ${res.status} ${parsed?.message || ''}`);
  if (parsed && typeof parsed === 'object' && parsed.isSuccess === false) throw new Error(parsed.message || 'Backend request failed');
  return parsed;
}

function unwrapResponse(res: any) {
  if (!res) return res;
  if (Array.isArray(res)) return res;
  if (res.data && Array.isArray(res.data)) return res.data;
  if (res.data?.data && Array.isArray(res.data.data)) return res.data.data;
  if (res.data?.content && Array.isArray(res.data.content)) return res.data.content;
  if (res.content && Array.isArray(res.content)) return res.content;
  if (res.items && Array.isArray(res.items)) return res.items;
  return res;
}

function unwrapData(res: any) {
  if (!res) return res;
  return res.data !== undefined ? res.data : res;
}

function unwrapPage(res: any) {
  const payload = unwrapData(res);
  if (!payload || typeof payload !== 'object') {
    return { content: Array.isArray(payload) ? payload : [], page: 0, size: 0, totalElements: 0, totalPages: 0 };
  }
  if (Array.isArray(payload)) {
    return { content: payload, page: 0, size: payload.length, totalElements: payload.length, totalPages: 1 };
  }
  return {
    ...payload,
    content: Array.isArray(payload.content) ? payload.content : [],
    page: Number.isFinite(Number(payload.page)) ? Number(payload.page) : 0,
    size: Number.isFinite(Number(payload.size)) ? Number(payload.size) : 0,
    totalElements: Number.isFinite(Number(payload.totalElements)) ? Number(payload.totalElements) : 0,
    totalPages: Number.isFinite(Number(payload.totalPages)) ? Number(payload.totalPages) : 0,
  };
}

function getAuthCacheScope(token?: string) {
  const activeToken = token || localStorage_service.getAuthToken() || '';
  if (!activeToken) return 'anon';
  return `${activeToken.length}:${activeToken.slice(-12)}`;
}

function readTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, ttlMs: number) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.savedAt > ttlMs) { cache.delete(key); return null; }
  return hit.value;
}

function writeTimedCache<T>(cache: Map<string, TimedCacheEntry<T>>, key: string, value: T) {
  cache.set(key, { savedAt: Date.now(), value });
  if (cache.size > 250) {
    Array.from(cache.keys()).slice(0, cache.size - 200).forEach((k) => cache.delete(k));
  }
}

async function cachedInflightRequest<T>(
  key: string, ttlMs: number,
  cache: Map<string, TimedCacheEntry<T>>, inflight: Map<string, Promise<T>>,
  loader: () => Promise<T>,
) {
  const cached = readTimedCache(cache, key, ttlMs);
  if (cached !== null) return cached;
  const running = inflight.get(key);
  if (running) return running;
  const promise = loader()
    .then((value) => { writeTimedCache(cache, key, value); return value; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, promise);
  return promise;
}

function unwrapDeepData(res: any) {
  let value = res;
  for (let i = 0; i < 6; i += 1) {
    if (!value || typeof value !== 'object' || !('data' in value)) break;
    value = value.data;
  }
  return value;
}

function toFiniteNumber(value: any, fallback = 0) {
  const payload = unwrapDeepData(value);
  if (typeof payload === 'number') return Number.isFinite(payload) ? payload : fallback;
  if (typeof payload === 'string') {
    const parsed = Number(payload);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  if (payload && typeof payload === 'object') {
    for (const key of ['count', 'likesCount', 'likes', 'total', 'value']) {
      if (payload[key] !== undefined) return toFiniteNumber(payload[key], fallback);
    }
  }
  return fallback;
}

function normalizePost(post: any) {
  if (!post) return post;
  const tags = post.tags;
  let normalizedTags: string[] = [];
  if (Array.isArray(tags)) {
    normalizedTags = tags.map((t: any) => {
      if (!t && t !== 0) return null;
      if (typeof t === 'string') return t.trim();
      if (typeof t === 'number') return String(t);
      if (typeof t === 'object') return String(t.name || t.label || t.id || JSON.stringify(t));
      return String(t);
    }).filter(Boolean) as string[];
  } else if (typeof tags === 'string') {
    normalizedTags = tags.split(',').map((t: string) => t.trim()).filter(Boolean);
  } else { normalizedTags = []; }
  return {
    ...post, tags: normalizedTags,
    attachments: Array.isArray(post.attachments) ? post.attachments.map((a: any) => ({ ...a, url: normalizeAssetUrl(a?.url) || a?.url })) : post.attachments,
    videoUrl: normalizeAssetUrl(post.videoUrl) || post.videoUrl,
    major: post.major || post.majorId, subject: post.subject || post.subjectId,
    views: toFiniteNumber(post.views, 0), likes: toFiniteNumber(post.likes ?? post.likesCount, 0),
    likesCount: toFiniteNumber(post.likesCount ?? post.likes, 0), commentsCount: toFiniteNumber(post.commentsCount, 0),
    points: toFiniteNumber(post.points, 0),
  };
}

function normalizeUser(user: any) {
  if (!user) return user;
  return {
    ...user,
    avatar: normalizeAvatarUrl(user.avatar, user.id || user.email || 'default'),
    major: user.major || user.majorId || '',
    class: user.class || user.className || '',
    points: toFiniteNumber(user.points, 0),
    followers: toFiniteNumber(user.followers, 0),
    following: toFiniteNumber(user.following, 0),
    postsCount: toFiniteNumber(user.postsCount, 0),
    joinedDate: user.joinedDate || user.createdAt,
    selectedBadgeId: user.selectedBadgeId || '',
  };
}

function normalizeComment(comment: any) {
  if (!comment) return comment;
  return { ...comment, createdAt: comment.createdAt || new Date().toISOString(), likes: comment.likes || 0, replies: Array.isArray(comment.replies) ? comment.replies.map(normalizeComment) : [] };
}

// AUTH
export async function login(payload: any) {
  const res = await request('POST', '/api/auth/login', payload);
  const user = res?.data || res;
  return user ? normalizeUser(user) : user;
}
export async function logout() {
  return (await request('POST', '/api/auth/logout'))?.data;
}
export async function me(token?: string) {
  const res = await request('GET', '/api/auth/me', undefined, token);
  const user = res?.data || res;
  return user ? normalizeUser(user) : user;
}
export async function requestRegisterOtp(userData: any) {
  return (await request('POST', '/api/auth/register/request-otp', userData))?.data;
}
export async function verifyRegisterOtp(userData: any) {
  const res = await request('POST', '/api/auth/register', userData);
  const user = res?.data || res;
  return user ? normalizeUser(user) : user;
}
export async function googleLogin(payload: any) {
  const res = await request('POST', '/api/auth/google/login', payload);
  const user = res?.data || res;
  return user ? normalizeUser(user) : user;
}
export async function requestPasswordResetOtp(email: string) {
  return (await request('POST', '/api/auth/forgot-password/request-otp', { email }))?.data;
}
export async function resetPassword(data: any) {
  return (await request('POST', '/api/auth/forgot-password/reset', data))?.data;
}

// POSTS
export async function getPosts(page = 0, size = 20) {
  const res = await request('GET', `/api/posts?page=${page}&size=${size}`);
  const list = unwrapResponse(res);
  return Array.isArray(list) ? list.map(normalizePost) : list;
}
export async function getPost(id: string) {
  const res = await request('GET', `/api/posts/${id}`);
  const data = res?.data || res;
  return data ? normalizePost(data) : data;
}
export async function createPost(data: any, token?: string) {
  const res = await request('POST', '/api/posts', data, token);
  const payload = res?.data || res;
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? normalizePost(payload) : payload;
}
export async function getPostsCursor(limit = 20, cursor?: any, filters?: any, signal?: AbortSignal) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor?.beforeCreatedAt && cursor?.beforeId) { params.set('beforeCreatedAt', cursor.beforeCreatedAt); params.set('beforeId', cursor.beforeId); }
  if (filters?.keyword?.trim()) params.set('keyword', filters.keyword.trim());
  if (filters?.majorId?.trim()) params.set('majorId', filters.majorId.trim());
  if (filters?.topic?.trim()) params.set('topic', filters.topic.trim());
  const res = await request('GET', `/api/posts/cursor?${params.toString()}`, undefined, undefined, signal);
  const payload = unwrapData(res) || {};
  return { ...payload, posts: Array.isArray(payload.posts) ? payload.posts.map(normalizePost) : [] };
}
export async function getPostViewerState(postIds: string[], token?: string) {
  const uniqueIds = Array.from(new Set(postIds.filter(Boolean))).slice(0, 50);
  if (uniqueIds.length === 0) return { likedPostIds: [] as string[], savedPostIds: [] as string[] };
  const params = new URLSearchParams();
  uniqueIds.forEach((id) => params.append('ids', id));
  const res = await request('GET', `/api/posts/viewer-state?${params.toString()}`, undefined, token);
  const payload = unwrapData(res) || {};
  return {
    likedPostIds: Array.isArray(payload.likedPostIds) ? payload.likedPostIds.map(String) : [],
    savedPostIds: Array.isArray(payload.savedPostIds) ? payload.savedPostIds.map(String) : [],
  };
}

// LIKES
export async function likePost(postId: string, token?: string) { return (await request('POST', `/api/posts-like/${postId}/like`, undefined, token))?.data; }
export async function unlikePost(postId: string, token?: string) { return (await request('POST', `/api/posts-like/${postId}/unlike`, undefined, token))?.data; }
export async function getPostLikesCount(postId: string, token?: string) { return toFiniteNumber(await request('GET', `/api/posts-like/${encodeURIComponent(postId)}/likes/count`, undefined, token), 0); }
export async function checkLikeStatus(postId: string, userId: string, token?: string) {
  const res = await request('GET', `/api/posts-like/${encodeURIComponent(postId)}/like-status`, undefined, token);
  const data = unwrapDeepData(res);
  return Boolean(data?.isLiked ?? data?.liked ?? data?.following ?? false);
}

// COMMENTS
export async function addComment(data: any, token?: string) {
  const res = await request('POST', '/api/comments', data, token);
  const comment = res?.data || res;
  return comment ? normalizeComment(comment) : comment;
}
export async function getCommentsByPost(postId: string, token?: string) {
  const res = await request('GET', `/api/comments/post/${postId}?page=0&size=40`, undefined, token);
  const comments = unwrapResponse(res);
  return Array.isArray(comments) ? comments.map(normalizeComment) : comments;
}
export async function getCommentReplies(commentId: string, token?: string) {
  const res = await request('GET', `/api/comments/${encodeURIComponent(commentId)}/replies`, undefined, token);
  const comments = unwrapResponse(res);
  return Array.isArray(comments) ? comments.map(normalizeComment) : comments;
}
export async function likeComment(commentId: string, token?: string) { return (await request('POST', `/api/comments/${encodeURIComponent(commentId)}/like`, undefined, token))?.data; }
export async function reportComment(commentId: string, reason: string, token?: string) { return (await request('POST', `/api/comments/${encodeURIComponent(commentId)}/report`, reason, token))?.data; }
export async function updateComment(commentId: string, content: string, token?: string) {
  const res = await request('PUT', `/api/comments/${encodeURIComponent(commentId)}`, { content }, token);
  const comment = res?.data || res;
  return comment ? normalizeComment(comment) : comment;
}
export async function deleteComment(commentId: string, token?: string) { return (await request('DELETE', `/api/comments/${encodeURIComponent(commentId)}`, undefined, token))?.data; }

// SAVED POSTS
export async function savePost(userId: string, postId: string, token?: string) { return (await request('POST', `/api/saved-posts?userId=${encodeURIComponent(userId)}&postId=${encodeURIComponent(postId)}`, undefined, token))?.data; }
export async function unsavePost(userId: string, postId: string, token?: string) { return (await request('DELETE', `/api/saved-posts?userId=${encodeURIComponent(userId)}&postId=${encodeURIComponent(postId)}`, undefined, token))?.data; }
export async function getSavedPosts(userId: string, token?: string) {
  const res = await request('GET', `/api/saved-posts/${encodeURIComponent(userId)}`, undefined, token);
  const list = unwrapResponse(res);
  return Array.isArray(list) ? list.map(normalizePost) : list;
}
export async function checkSavedPost(userId: string, postId: string, token?: string) { return unwrapData(await request('GET', `/api/saved-posts/check?userId=${encodeURIComponent(userId)}&postId=${encodeURIComponent(postId)}`, undefined, token)); }
export async function getSavedPostsCount(userId: string, token?: string) { return unwrapData(await request('GET', `/api/saved-posts/${encodeURIComponent(userId)}/count`, undefined, token)); }

// USERS
export async function getUsers(page = 0, size = 50) {
  const res = await request('GET', `/api/users/search?keyword=&page=${page}&size=${size}`);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function getUser(id: string, token?: string) {
  const normalizedId = String(id || '').trim();
  if (!normalizedId) return null;
  const key = `user:${getAuthCacheScope(token)}:${normalizedId}`;
  return cachedInflightRequest(key, USER_PROFILE_CACHE_TTL_MS, userProfileCache, userProfileInflight, async () => {
    const res = await request('GET', `/api/users/${encodeURIComponent(normalizedId)}`, undefined, token);
    const user = res?.data || res;
    return user ? normalizeUser(user) : user;
  });
}
export async function getRealtimeToken() { return (await request('GET', '/api/auth/realtime-token'))?.data; }
export async function getUsersByIds(ids: string[], token?: string) {
  const uniqueIds = Array.from(new Set(ids.filter(Boolean))).slice(0, 100);
  if (uniqueIds.length === 0) return [];
  const res = await request('GET', `/api/users/batch?ids=${encodeURIComponent(uniqueIds.join(','))}`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : [];
}
export async function followUser(followerId: string, followeeId: string, token?: string) { return (await request('POST', `/api/users/${encodeURIComponent(followerId)}/follow/${encodeURIComponent(followeeId)}`, undefined, token))?.data; }
export async function unfollowUser(followerId: string, followeeId: string, token?: string) { return (await request('DELETE', `/api/users/${encodeURIComponent(followerId)}/unfollow/${encodeURIComponent(followeeId)}`, undefined, token))?.data; }
export async function getFollowers(userId: string, token?: string) {
  const res = await request('GET', `/api/users/${encodeURIComponent(userId)}/followers`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function getFollowing(userId: string, token?: string) {
  const res = await request('GET', `/api/users/${encodeURIComponent(userId)}/following`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function getFollowStatus(followerId: string, followeeId: string, token?: string) {
  const res = await request('GET', `/api/users/follow-status?followeeId=${encodeURIComponent(followeeId)}`, undefined, token);
  let data = res?.data?.data || res?.data;
  let isFollowing: boolean | undefined;
  if (typeof data === 'boolean') isFollowing = data;
  else if (typeof data === 'object' && data !== null) {
    isFollowing = data.isFollowing !== undefined ? data.isFollowing : data.followed !== undefined ? data.followed : data.following;
  }
  return { isFollowing: Boolean(isFollowing) };
}
export async function updateUserProfile(userId: string, data: any, token?: string) { return (await request('PUT', `/api/users/${encodeURIComponent(userId)}`, data, token))?.data; }
export async function uploadUserAvatar(userId: string, file: File, token?: string) {
  const formData = new FormData();
  formData.append('file', file);
  const _token = token || localStorage_service.getAuthToken();
  const headers: Record<string, string> = {};
  if (_token) headers.Authorization = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}/api/users/me/avatar`, { method: 'POST', headers, body: formData, credentials: 'include' });
  const parsed = await safeJson(res);
  if (!res.ok || parsed?.isSuccess === false) throw new Error(parsed?.message || `API error: ${res.status}`);
  const data = parsed?.data || parsed;
  if (data?.avatar) return { ...data, avatar: normalizeAvatarUrl(data.avatar, userId) };
  return data;
}
export async function updateSelectedBadge(userId: string, badgeId: string | null, token?: string) {
  const res = await request('PUT', `/api/users/${encodeURIComponent(userId)}/selected-badge`, { badgeId: badgeId || '' }, token);
  const user = unwrapData(res);
  return user ? normalizeUser(user) : user;
}
export async function uploadFile(file: File, token?: string) {
  const formData = new FormData();
  formData.append('file', file);
  const _token = token || localStorage_service.getAuthToken();
  const headers: Record<string, string> = {};
  if (_token) headers.Authorization = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}/api/files`, { method: 'POST', headers, body: formData, credentials: 'include' });
  const parsed = await safeJson(res);
  if (!res.ok || parsed?.isSuccess === false) throw new Error(parsed?.message || `API error: ${res.status}`);
  const data = parsed?.data || parsed;
  if (data?.url) return { ...data, url: normalizeAssetUrl(data.url) || data.url };
  return data;
}
export async function searchUsers(keyword: string, page = 0, size = 10, token?: string) {
  const res = await request('GET', `/api/users/search?keyword=${encodeURIComponent(keyword)}&page=${page}&size=${size}`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function getUserStats(userId: string, token?: string) { return (await request('GET', `/api/users/${encodeURIComponent(userId)}/stats`, undefined, token))?.data; }
export async function recordProfileVisit(userId: string, token?: string) { return (await request('POST', `/api/profile-visits/${encodeURIComponent(userId)}`, undefined, token))?.data; }
export async function getProfileVisitCount(userId: string, token?: string) { return Number((await request('GET', `/api/profile-visits/${encodeURIComponent(userId)}/count`, undefined, token))?.data?.count || 0); }
export async function getProfileVisitors(userId: string, token?: string) { return (await request('GET', `/api/profile-visits/${encodeURIComponent(userId)}/recent?limit=30`, undefined, token))?.data; }

// PRIVACY & BLOCK
export async function getPrivacySettings(token?: string) { return (await request('GET', '/api/users/privacy', undefined, token))?.data; }
export async function updatePrivacySettings(data: any, token?: string) { return (await request('PUT', '/api/users/privacy', data, token))?.data; }
export async function blockUser(blockedId: string, token?: string) { return (await request('POST', `/api/users/${encodeURIComponent(blockedId)}/block`, undefined, token))?.data; }
export async function unblockUser(blockedId: string, token?: string) { return (await request('DELETE', `/api/users/${encodeURIComponent(blockedId)}/unblock`, undefined, token))?.data; }
export async function getBlockedUsers(page = 0, size = 10, token?: string) {
  const res = await request('GET', `/api/users/blocks?page=${page}&size=${size}`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}

// VIDEO CALLS
export async function getCallHistory(conversationId: string, token?: string) { return unwrapResponse(await request('GET', `/api/chat/calls/${conversationId}`, undefined, token)); }
export async function updateCallStatus(callId: string, status: 'completed' | 'missed' | 'declined', token?: string) { return (await request('PUT', `/api/chat/calls/${callId}?status=${status}`, undefined, token))?.data; }

// CHAT & MESSAGING
export async function getMutualFollowersForChat(token?: string) {
  const res = await request('GET', '/api/chat/mutual-followers', undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function searchUsersToChat(keyword: string, token?: string) {
  const res = await request('GET', `/api/chat/search-users?keyword=${encodeURIComponent(keyword)}`, undefined, token);
  const users = unwrapResponse(res);
  return Array.isArray(users) ? users.map(normalizeUser) : users;
}
export async function getChatConversationsPage(page = 0, size = 50, token?: string) {
  const key = `chat-conversations:${getAuthCacheScope(token)}:${page}:${size}`;
  return cachedInflightRequest(key, CHAT_CONVERSATIONS_PAGE_CACHE_TTL_MS, chatConversationsPageCache, chatConversationsPageInflight, async () => {
    return unwrapPage(await request('GET', `/api/chat/conversations/page?page=${page}&size=${size}`, undefined, token));
  });
}
export async function getChatMessagesPage(conversationId: string, limit = 100, beforeMessageId?: string | null, token?: string) {
  const key = `chat-messages:${getAuthCacheScope(token)}:${conversationId}:${limit}:${beforeMessageId || ''}`;
  return cachedInflightRequest(key, CHAT_MESSAGES_PAGE_CACHE_TTL_MS, chatMessagesPageCache, chatMessagesPageInflight, async () => {
    const cursor = beforeMessageId ? `&beforeMessageId=${encodeURIComponent(beforeMessageId)}` : '';
    const res = await request('GET', `/api/chat/messages/${encodeURIComponent(conversationId)}/page?limit=${limit}${cursor}`, undefined, token);
    return unwrapData(res) || { messages: [], hasMore: false, nextBeforeMessageId: null };
  });
}
export async function markChatConversationRead(conversationId: string, token?: string) { return unwrapData(await request('POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/read`, undefined, token)); }
export async function sendChatMessage(data: any, token?: string) { return unwrapData(await request('POST', '/api/chat/messages', data, token)); }
export async function createChatConversation(data: any, token?: string) { return unwrapData(await request('POST', '/api/chat/conversations', data, token)); }
export async function acceptChatConversation(conversationId: string, token?: string) { return unwrapData(await request('PUT', `/api/chat/conversations/${encodeURIComponent(conversationId)}/accept`, undefined, token)); }
export async function rejectChatConversation(conversationId: string, token?: string) { return unwrapData(await request('POST', `/api/chat/conversations/${encodeURIComponent(conversationId)}/reject`, undefined, token)); }
export async function updateChatConversationBackground(conversationId: string, data: any, token?: string) { return unwrapData(await request('PUT', `/api/chat/conversations/${encodeURIComponent(conversationId)}/background`, data, token)); }
export async function editChatMessage(messageId: string, content: string, token?: string) { return unwrapData(await request('PUT', `/api/chat/messages/${encodeURIComponent(messageId)}`, { content }, token)); }
export async function deleteChatMessage(messageId: string, token?: string) { return unwrapData(await request('DELETE', `/api/chat/messages/${encodeURIComponent(messageId)}`, undefined, token)); }

// SHOP
export async function getShopItems(token?: string) { return unwrapData(await request('GET', '/api/shop/items', undefined, token)); }
export async function getMyShopItems(token?: string) { return unwrapData(await request('GET', '/api/shop/my-items', undefined, token)); }
export async function buyShopItem(itemId: string, token?: string) { return unwrapData(await request('POST', `/api/shop/buy/${encodeURIComponent(itemId)}`, undefined, token)); }
export async function equipShopItem(itemId: string, token?: string) { return unwrapData(await request('POST', `/api/shop/equip/${encodeURIComponent(itemId)}`, undefined, token)); }
export async function unequipShopItem(type: string, token?: string) { return unwrapData(await request('POST', `/api/shop/unequip/${encodeURIComponent(type)}`, undefined, token)); }
export async function getShopEquipped(token?: string) { return unwrapData(await request('GET', '/api/shop/equipped', undefined, token)); }
export async function getProfileTheme(userId: string, token?: string) { return unwrapData(await request('GET', `/api/users/${encodeURIComponent(userId)}/profile-theme`, undefined, token)); }

// BADGES
export async function getBadges(token?: string) { return unwrapResponse(await request('GET', '/api/badges', undefined, token)); }
export async function getBadgeById(id: string, token?: string) { return (await request('GET', `/api/badges/${encodeURIComponent(id)}`, undefined, token))?.data; }
export async function getUserBadges(userId: string, token?: string) { return unwrapResponse(await request('GET', `/api/badges/user/${userId}`, undefined, token)); }
export async function getBadgeProgress(userId: string, token?: string) { return unwrapResponse(await request('GET', `/api/badges/user/${encodeURIComponent(userId)}/progress`, undefined, token)); }

// NOTIFICATIONS
export async function getNotifications(userId: string, page = 0, size = 20, token?: string) {
  const key = `notifications:${getAuthCacheScope(token)}:${userId}:${page}:${size}`;
  return cachedInflightRequest(key, NOTIFICATIONS_PAGE_CACHE_TTL_MS, notificationsPageCache, notificationsPageInflight, async () => {
    return unwrapResponse(await request('GET', `/api/notifications/${encodeURIComponent(userId)}?page=${page}&size=${size}`, undefined, token));
  });
}
export async function getUnreadNotificationsCount(userId: string, token?: string) { return unwrapData(await request('GET', `/api/notifications/${encodeURIComponent(userId)}/unread-count`, undefined, token)); }
export async function markNotificationAsRead(id: string, token?: string) { return (await request('PUT', `/api/notifications/${id}/read`, undefined, token))?.data; }
export async function markAllNotificationsAsRead(userId: string, token?: string) { return (await request('PUT', `/api/notifications/${encodeURIComponent(userId)}/read-all`, undefined, token))?.data; }
export async function deleteNotification(id: string, userId: string, token?: string) { return (await request('DELETE', `/api/notifications/${id}?userId=${encodeURIComponent(userId)}`, undefined, token))?.data; }
export async function deleteAllNotifications(userId: string, token?: string) { return (await request('DELETE', `/api/notifications/${encodeURIComponent(userId)}/all`, undefined, token))?.data; }

// REPORTS
export async function createReport(data: any, token?: string) { return (await request('POST', '/api/reports', data, token))?.data; }
export async function getReport(id: string, token?: string) { return (await request('GET', `/api/reports/${encodeURIComponent(id)}`, undefined, token))?.data; }
export async function getReportsByStatus(status: string, token?: string) { return unwrapResponse(await request('GET', `/api/reports/status/${encodeURIComponent(status)}`, undefined, token)); }
export async function getReportsByPost(postId: string, token?: string) { return unwrapResponse(await request('GET', `/api/reports/post/${encodeURIComponent(postId)}`, undefined, token)); }
export async function getReportsByUser(userId: string, token?: string) { return unwrapResponse(await request('GET', `/api/reports/user/${encodeURIComponent(userId)}`, undefined, token)); }
export async function updateReportStatus(reportId: string, data: any, token?: string) { return (await request('PUT', `/api/reports/${encodeURIComponent(reportId)}/status`, data, token))?.data; }
export async function deleteReport(reportId: string, token?: string) { return (await request('DELETE', `/api/reports/${encodeURIComponent(reportId)}`, undefined, token))?.data; }
export async function getReportStats(token?: string) { return (await request('GET', '/api/reports/stats', undefined, token))?.data; }

// LEADERBOARD
export async function getOverallLeaderboard(limit = 10, token?: string) {
  return unwrapResponse(token ? await request('GET', `/api/leaderboard/top?limit=${limit}`, undefined, token) : await publicGet(`/api/leaderboard/top?limit=${limit}`));
}
export async function getUserRank(userId: string, token?: string) { return (await request('GET', `/api/leaderboard/user/${encodeURIComponent(userId)}`, undefined, token))?.data; }
export async function updateLeaderboard(token?: string) { return (await request('POST', '/api/leaderboard/update', {}, token))?.data; }
export async function getLeaderboardByMajor(majorId: string, limit = 10, token?: string) {
  const path = `/api/leaderboard/major/${encodeURIComponent(majorId)}?limit=${limit}`;
  return unwrapResponse(token ? await request('GET', path, undefined, token) : await publicGet(path));
}
export async function getTopPostersThisWeek(limit = 10, token?: string) {
  return unwrapResponse(token ? await request('GET', `/api/leaderboard/top-posters-week?limit=${limit}`, undefined, token) : await publicGet(`/api/leaderboard/top-posters-week?limit=${limit}`));
}
export async function getMyRank(token?: string) {
  const user = await me(token);
  if (!user?.id) return null;
  return getUserRank(user.id, token);
}

// MAJORS
export async function getMajors(token?: string) { return unwrapResponse(await request('GET', '/api/majors', undefined, token)); }
export async function getMajor(id: string, token?: string) { return (await request('GET', `/api/majors/${id}`, undefined, token))?.data; }
export async function getSubjectsForMajor(majorId: string, token?: string) {
  try { return unwrapResponse(await request('GET', `/api/subject/${majorId}`, undefined, token)) || []; } catch { return []; }
}

// SESSIONS
export async function getSessions(token?: string) { return unwrapResponse(await request('GET', '/api/sessions', undefined, token)); }
export async function revokeSession(tokenToRevoke: string, token?: string) { return (await request('POST', `/api/sessions/${encodeURIComponent(tokenToRevoke)}/revoke`, undefined, token))?.data; }
export async function getDevices(token?: string) { return unwrapResponse(await request('GET', '/api/devices', undefined, token)); }
export async function deleteDevice(id: string, token?: string) { return (await request('DELETE', `/api/devices/${encodeURIComponent(id)}`, undefined, token))?.data; }

export default {
  request, getWebSocketUrl, getNativeWebSocketUrl, normalizeAvatarUrl, normalizeAssetUrl,
  login, logout, me, getRealtimeToken, requestRegisterOtp, verifyRegisterOtp, googleLogin, requestPasswordResetOtp, resetPassword,
  getPosts, getPostsCursor, getPostViewerState, getPost, getPostTags: async (postId: string) => unwrapResponse(await request('GET', `/api/posts/${postId}/tags`)), likePost, unlikePost, getPostLikesCount, checkLikeStatus, createPost,
  addComment, getCommentsByPost, getCommentReplies, likeComment, reportComment, updateComment, deleteComment,
  savePost, unsavePost, getSavedPosts, checkSavedPost, getSavedPostsCount,
  getUsers, getUser, getUsersByIds, followUser, unfollowUser, getFollowers, getFollowing, getFollowStatus, updateUserProfile, updateSelectedBadge, uploadUserAvatar, uploadFile, searchUsers, getUserStats, recordProfileVisit, getProfileVisitCount, getProfileVisitors,
  getPrivacySettings, updatePrivacySettings, blockUser, unblockUser, getBlockedUsers,
  getMutualFollowersForChat, searchUsersToChat, getChatConversationsPage, getChatMessagesPage, markChatConversationRead, sendChatMessage, createChatConversation, acceptChatConversation, rejectChatConversation, updateChatConversationBackground, editChatMessage, deleteChatMessage,
  getShopItems, getMyShopItems, buyShopItem, equipShopItem, unequipShopItem, getShopEquipped, getProfileTheme,
  getCallHistory, updateCallStatus,
  getBadges, getBadgeById, getUserBadges, getBadgeProgress,
  getNotifications, getUnreadNotificationsCount, markNotificationAsRead, markAllNotificationsAsRead, deleteNotification, deleteAllNotifications,
  createReport, getReport, getReportsByStatus, getReportsByPost, getReportsByUser, updateReportStatus, deleteReport, getReportStats,
  getOverallLeaderboard, getUserRank, updateLeaderboard, getLeaderboardByMajor, getTopPostersThisWeek, getMyRank,
  getMajors, getMajor, getSubjectsForMajor,
  getSessions, revokeSession, getDevices, deleteDevice,
};
