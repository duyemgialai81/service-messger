
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { ImgHTMLAttributes } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { Client } from "@stomp/stompjs";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  Camera,
  Check,
  ChevronLeft,
  Image as ImageIcon,
  Copy,
  FileText,
  Inbox,
  Info,
  Loader2,
  MessageCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Phone,
  PhoneOff,
  Search,
  Send,
  ScreenShare,
  ScreenShareOff,
  ShieldAlert,
  Smile,
  Sparkles,
  SwitchCamera,
  ThumbsUp,
  Reply,
  Trash2,
  Pencil,
  User as UserIcon,
  Video,
  VideoOff,
  Volume2,
  X,
  Plus,
  Bell,
  Users,
  Wifi,
} from "lucide-react";
import { toast } from "sonner";
import api, { normalizeAssetUrl, normalizeAvatarUrl } from "../lib/api";
import { localStorage_service } from "../lib/localStorage";
import { clearPendingCall, createRealtimeConnection, INCOMING_CALL_EVENT, readPendingCall } from "../lib/realtime";
import { formatVietnamTime } from "../lib/time";

// ==================== INTERFACES ====================
interface MessagesPageProps {
  readonly currentUser?: any;
}

interface ConversationItem {
  id: string;
  type?: "direct" | "group" | string;
  targetUserId?: string;
  name: string;
  avatar?: string;
  lastMessage?: string;
  time?: string;
  unread?: number;
  status?: "accepted" | "pending" | string;
  isOnline?: boolean;
  memberCount?: number;
  backgroundId?: string;
  backgroundUrl?: string;
}

interface SearchUserItem {
  id: string;
  name: string;
  avatar?: string;
  isOnline?: boolean;
}

interface MessageItem {
  id: string;
  senderId: string;
  senderName?: string;
  senderAvatar?: string;
  text: string;
  time: string;
  createdAt?: string;
  deliveryStatus?: "sending" | "sent";
  isDeleted?: boolean;
  isEdited?: boolean;
  replyToMessageId?: string;
  attachmentUrl?: string;
  attachmentName?: string;
  attachmentSize?: number;
  messageType?: string;
  reactions?: Record<string, number>;
  userReactions?: Record<string, boolean>;
}

type CallMode = "audio" | "video";
type CallStatus = "incoming" | "connecting" | "active";

interface CallSession {
  id: string;
  mode: CallMode;
  status: CallStatus;
  conversationId?: string;
  startedAt: number | null;
  elapsedSeconds: number;
  isMuted: boolean;
  isCameraOff: boolean;
  isScreenSharing: boolean;
  cameraFacing: "user" | "environment";
  isSpeakerOn: boolean;
  peerId: string;
  peerName: string;
  peerAvatar: string;
  hasMediaPermission: boolean;
  error: string | null;
}

// ==================== CONSTANTS ====================
const REACTION_EMOJIS = ['❤️', '😂', '👍', '😮', '😢', '🎉', '👎', '😡', '⭐', '🔥'];

// ── AURORA THEME ──
const ORANGE = "#6D5DFC";
const ORANGE_LIGHT = "#F1EDFF";
const ORANGE_MID = "#A855F7";
const ORANGE_DARK = "#4F46E5";
const GRADIENT_SEND = "linear-gradient(135deg, #5a4deb 0%, #7860f2 50%, #9333ea 100%)";
const GRADIENT_PRIMARY = "linear-gradient(135deg, #6d5dfc, #a855f7)";
const SHADOW_PRIMARY = "0 10px 28px rgba(92, 74, 218, 0.22)";
const SHADOW_PRIMARY_HOVER = "0 14px 36px rgba(92, 74, 218, 0.32)";

const CHAT_BACKGROUNDS = [
  { id: "soft", label: "Aurora", value: "radial-gradient(circle at 8% 8%, rgba(167,139,250,.16), transparent 28%), radial-gradient(circle at 92% 4%, rgba(34,211,238,.12), transparent 24%), linear-gradient(180deg, #fbfbff 0%, #f5f5ff 100%)" },
  { id: "warm", label: "Lavender", value: "linear-gradient(145deg, #faf7ff 0%, #f0eaff 52%, #f7f5ff 100%)" },
  { id: "mint", label: "Mint", value: "linear-gradient(145deg, #f5fffd 0%, #e8fbf6 55%, #f5fffd 100%)" },
  { id: "sky", label: "Sky", value: "linear-gradient(145deg, #f6fbff 0%, #e8f4ff 55%, #f7fbff 100%)" },
  { id: "slate", label: "Graphite", value: "linear-gradient(145deg, #f8fafc 0%, #eef2f7 55%, #f8fafc 100%)" },
];

const CUSTOM_CHAT_BACKGROUND_STORAGE_KEY = "ksp_chat_background_image";

const CHAT_BACKGROUND_STORAGE_KEY = "ksp_chat_background";

const formatCallDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
};

const iceServers: RTCConfiguration = {
  iceCandidatePoolSize: 10,
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp",
        "turns:openrelay.metered.ca:443?transport=tcp",
      ],
      username: "openrelayproject",
      credential: "openrelayproject",
    },
  ],
};

const CHAT_LIST_CACHE_TTL_MS = 45_000;
const MESSAGE_PAGE_CACHE_TTL_MS = 5 * 60_000;
const INITIAL_MESSAGE_PAGE_SIZE = 40;
const OLDER_MESSAGE_PAGE_SIZE = 50;
const IMAGE_MEMORY_CACHE_LIMIT = 180;
const IMAGE_PLACEHOLDER_SRC =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const CALL_CONNECT_TIMEOUT_MS = 90_000;
const CALL_DISCONNECT_GRACE_MS = 30_000;
const COMPOSER_EMOJIS = ["😀", "😂", "🥰", "😍", "😎", "😭", "😡", "👍", "👏", "❤️", "🎉", "🔥"];

type ExpiringMemoryCache<T> = Map<string, { savedAt: number; value: T }>;

const chatListMemoryCache: ExpiringMemoryCache<ConversationItem[]> = new Map();
const messagePageMemoryCache: ExpiringMemoryCache<{
  messages: MessageItem[];
  oldestMessageCursor: string | null;
  hasMoreMessages: boolean;
}> = new Map();
const imageMemoryCache = new Map<string, string>();
const imageInflightCache = new Map<string, Promise<string>>();

function cloneCacheValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readExpiringCache<T>(cache: ExpiringMemoryCache<T>, key: string, ttlMs: number): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.savedAt > ttlMs) {
    cache.delete(key);
    return null;
  }
  return cloneCacheValue(entry.value);
}

function writeExpiringCache<T>(cache: ExpiringMemoryCache<T>, key: string, value: T) {
  cache.set(key, { savedAt: Date.now(), value: cloneCacheValue(value) });
}

function shouldCacheImageSource(src: string) {
  return Boolean(src) && !/^(data:|blob:)/i.test(src);
}

function trimImageMemoryCache() {
  while (imageMemoryCache.size > IMAGE_MEMORY_CACHE_LIMIT) {
    const oldestKey = imageMemoryCache.keys().next().value;
    if (!oldestKey) break;
    const objectUrl = imageMemoryCache.get(oldestKey);
    if (objectUrl?.startsWith("blob:")) {
      URL.revokeObjectURL(objectUrl);
    }
    imageMemoryCache.delete(oldestKey);
  }
}

async function loadCachedImageSource(src: string) {
  const normalizedSrc = src.trim();
  if (!shouldCacheImageSource(normalizedSrc)) return normalizedSrc;
  const cached = imageMemoryCache.get(normalizedSrc);
  if (cached) return cached;
  const running = imageInflightCache.get(normalizedSrc);
  if (running) return running;

  const promise = fetch(normalizedSrc, { cache: "force-cache", credentials: "omit" })
    .then((response) => {
      if (!response.ok) throw new Error(`Image request failed: ${response.status}`);
      return response.blob();
    })
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob);
      imageMemoryCache.set(normalizedSrc, objectUrl);
      trimImageMemoryCache();
      return objectUrl;
    })
    .catch(() => normalizedSrc)
    .finally(() => {
      imageInflightCache.delete(normalizedSrc);
    });

  imageInflightCache.set(normalizedSrc, promise);
  return promise;
}

function getInitialCachedImageSource(src?: string, fallbackSrc = IMAGE_PLACEHOLDER_SRC) {
  const normalizedSrc = typeof src === "string" ? src.trim() : "";
  if (!normalizedSrc) return fallbackSrc;
  if (!shouldCacheImageSource(normalizedSrc)) return normalizedSrc;
  return imageMemoryCache.get(normalizedSrc) || fallbackSrc;
}

function useCachedImageSource(src?: string, fallbackSrc = IMAGE_PLACEHOLDER_SRC) {
  const normalizedSrc = typeof src === "string" ? src.trim() : "";
  const [resolvedSrc, setResolvedSrc] = useState(() => getInitialCachedImageSource(normalizedSrc, fallbackSrc));

  useEffect(() => {
    let cancelled = false;
    setResolvedSrc(getInitialCachedImageSource(normalizedSrc, fallbackSrc));
    if (!normalizedSrc || !shouldCacheImageSource(normalizedSrc)) {
      return () => {
        cancelled = true;
      };
    }

    void loadCachedImageSource(normalizedSrc).then((nextSrc) => {
      if (!cancelled) setResolvedSrc(nextSrc || fallbackSrc);
    });

    return () => {
      cancelled = true;
    };
  }, [normalizedSrc, fallbackSrc]);

  return resolvedSrc;
}

type CachedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
  src?: string;
  fallbackSrc?: string;
};

const CachedImage = memo(function CachedImage({
  src,
  fallbackSrc = IMAGE_PLACEHOLDER_SRC,
  loading,
  decoding,
  onError,
  ...props
}: CachedImageProps) {
  const resolvedSrc = useCachedImageSource(src, fallbackSrc);
  return (
    <img
      {...props}
      src={resolvedSrc}
      loading={loading || "lazy"}
      decoding={decoding || "async"}
      onError={(event) => {
        onError?.(event);
      }}
    />
  );
});

function getMessageDateKey(value?: string) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function formatMessageDateLabel(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const todayKey = getMessageDateKey(new Date().toISOString());
  const messageKey = getMessageDateKey(value);
  if (messageKey === todayKey) return "Hôm nay";
  return new Intl.DateTimeFormat("vi-VN", {
    timeZone: "Asia/Ho_Chi_Minh",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function isAudioAttachment(message: Pick<MessageItem, "attachmentName" | "attachmentUrl">) {
  const source = `${message.attachmentName || ""} ${message.attachmentUrl || ""}`.toLowerCase();
  return /\.(webm|mp3|wav|m4a|aac|ogg)(?:$|[?#\s])/i.test(source);
}

export default function MessagesPage({ currentUser }: MessagesPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [chatFilter, setChatFilter] = useState<"all" | "unread" | "pending" | "favorite">("all");
  const [userSearchQuery, setUserSearchQuery] = useState("");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [searchResults, setSearchResults] = useState<SearchUserItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [messages, setMessages] = useState<MessageItem[]>([]);
  const [oldestMessageCursor, setOldestMessageCursor] = useState<string | null>(null);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [isLoadingOlderMessages, setIsLoadingOlderMessages] = useState(false);
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null);
  const [showInfo, setShowInfo] = useState(false);
  const [infoTab, setInfoTab] = useState<"info" | "chat">("info");
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<MessageItem | null>(null);
  const [activeMessageMenu, setActiveMessageMenu] = useState<string | null>(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
  const [customChatBackground, setCustomChatBackground] = useState(() => {
    try {
      return localStorage.getItem(CUSTOM_CHAT_BACKGROUND_STORAGE_KEY) || "";
    } catch {
      return "";
    }
  });
  const [isLoadingChats, setIsLoadingChats] = useState(true);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<string, boolean>>({});
  const [callSession, setCallSession] = useState<CallSession | null>(null);
  const [showReactionPicker, setShowReactionPicker] = useState<string | null>(null);
  const [hoveredMessageId, setHoveredMessageId] = useState<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const [showComposerEmojiPicker, setShowComposerEmojiPicker] = useState(false);
  const [showComposerTools, setShowComposerTools] = useState(false);
  const [isRecordingAudio, setIsRecordingAudio] = useState(false);
  const [isAcceptingRequest, setIsAcceptingRequest] = useState(false);
  const [chatBackgroundId, setChatBackgroundId] = useState(() => {
    try {
      return localStorage.getItem(CHAT_BACKGROUND_STORAGE_KEY) || "soft";
    } catch {
      return "soft";
    }
  });

  const stompClientRef = useRef<Client | null>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const messageInputRef = useRef<HTMLInputElement>(null);
  const chatBackgroundInputRef = useRef<HTMLInputElement>(null);
  const selectedChatIdRef = useRef<string | null>(null);
  const messagesConversationIdRef = useRef<string | null>(null);
  const conversationsRef = useRef<ConversationItem[]>([]);
  const callSessionRef = useRef<CallSession | null>(null);
  const realtimeMessageIdsRef = useRef<Set<string>>(new Set());
  const openedUrlUserRef = useRef<string | null>(null);
  const openingUrlUserRef = useRef<string | null>(null);
  const initialMessageFetchAtRef = useRef<Map<string, number>>(new Map());
  const lastReadConversationRef = useRef<string | null>(null);
  const chatRefreshDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const incomingOfferRef = useRef<RTCSessionDescriptionInit | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const pendingAutoAcceptCallIdRef = useRef<string | null>(null);
  const acceptCallTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callDisconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const processedCallSignalsRef = useRef<Set<string>>(new Set());
  const loadingOlderMessagesRef = useRef(false);
  const userSearchSequenceRef = useRef(0);
  const audioRecorderRef = useRef<MediaRecorder | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const toId = (value: unknown) => (value === undefined || value === null ? "" : String(value));
  const currentUserId = toId(currentUser?.id);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { callSessionRef.current = callSession; }, [callSession]);
  useEffect(() => { selectedChatIdRef.current = selectedChatId; }, [selectedChatId]);
  useEffect(() => {
    setReplyingTo(null);
    setActiveMessageMenu(null);
    setShowReactionPicker(null);
    setShowComposerEmojiPicker(false);
    setShowComposerTools(false);
  }, [selectedChatId]);
  useEffect(() => {
    if (!currentUserId || conversations.length === 0) return;
    writeExpiringCache(chatListMemoryCache, `chat-list:${currentUserId}`, conversations);
  }, [conversations, currentUserId]);
  useEffect(() => {
    const conversationId = messagesConversationIdRef.current;
    if (!currentUserId || !conversationId || conversationId.startsWith("new_")) return;
    writeExpiringCache(messagePageMemoryCache, `messages:${currentUserId}:${conversationId}`, {
      messages,
      oldestMessageCursor,
      hasMoreMessages,
    });
  }, [messages, oldestMessageCursor, hasMoreMessages, currentUserId]);
  const dedupConversations = (list: ConversationItem[]) => {
    const map = new Map<string, ConversationItem>();
    list.forEach((c) => {
      const key = c.targetUserId ? String(c.targetUserId) : String(c.id);
      if (!map.has(key)) map.set(key, c);
    });
    return Array.from(map.values());
  };

  const getAvatarUrl = (url?: string, id?: string) => {
    return normalizeAvatarUrl(url, id || "default");
  };

  const normalizeConversationItem = (c: any): ConversationItem => ({
    id: toId(c.id),
    type: c.type || "direct",
    targetUserId: toId(c.targetUserId) || undefined,
    name: c.type === "group" ? (c.groupName || c.name || "Nhóm chat") : (c.targetUserName || c.name || "Người dùng"),
    avatar: c.targetUserAvatar || c.avatar,
    lastMessage: c.lastMessage || "Bắt đầu cuộc trò chuyện mới.",
    time: c.lastMessageTime ? formatVietnamTime(c.lastMessageTime) : (c.time || ""),
    unread: c.unreadCount ?? c.unread ?? 0,
    status: c.status || "accepted",
    isOnline: Boolean(c.targetIsOnline ?? c.isOnline),
    memberCount: c.memberCount,
    backgroundId: c.backgroundId || undefined,
    backgroundUrl: c.backgroundUrl || undefined,
  });

  const mergeConversationUpdate = (list: ConversationItem[], incoming: Partial<ConversationItem> & { id?: string }) => {
    const incomingId = toId(incoming.id);
    if (!incomingId) return list;
    const idx = list.findIndex((c) => toId(c.id) === incomingId);
    if (idx === -1) return dedupConversations([normalizeConversationItem(incoming), ...list]);
    const next = [...list];
    next[idx] = { ...next[idx], ...incoming, id: incomingId };
    return dedupConversations(next);
  };

  const getMessageRenderKey = (message: MessageItem, index: number) => {
    const id = toId(message.id);
    if (id) return id;
    return `${toId(message.senderId)}:${toId(message.time)}:${toId(message.text)}:${index}`;
  };

  const dedupeMessages = (list: MessageItem[]) => {
    const seen = new Set<string>();
    const result: MessageItem[] = [];
    list.forEach((message, index) => {
      const key = getMessageRenderKey(message, index);
      if (!key || seen.has(key)) return;
      seen.add(key);
      result.push(message);
    });
    return result;
  };

  const setConversationMessages = (
    conversationId: string | null,
    value: MessageItem[] | ((prev: MessageItem[]) => MessageItem[]),
  ) => {
    messagesConversationIdRef.current = conversationId;
    setMessages((prev) => {
      const next = typeof value === "function" ? value(prev) : value;
      return dedupeMessages(next);
    });
  };

  const mapMessageItem = (m: any): MessageItem => ({
    id: toId(m.id) || Math.random().toString(),
    senderId: toId(m.senderId) === currentUserId ? "me" : toId(m.senderId),
    senderName: m.senderName,
    senderAvatar: m.senderAvatar,
    text: m.isDeleted ? "Tin nhắn đã được thu hồi" : (m.content || m.text || "Tin nhắn không hợp lệ."),
    time: formatVietnamTime(m.createdAt || Date.now()),
    createdAt: m.createdAt || new Date().toISOString(),
    deliveryStatus: "sent",
    isDeleted: Boolean(m.isDeleted),
    isEdited: Boolean(m.editedAt),
    replyToMessageId: m.replyToMessageId,
    attachmentUrl: m.attachmentUrl,
    attachmentName: m.attachmentName,
    attachmentSize: m.attachmentSize,
    messageType: m.messageType,
    reactions: m.reactions || {},
    userReactions: m.userReactions || {},
  });

  const parseRealtimePayload = (data: any) => {
    if (!data) return null;
    if (typeof data === "object") return data;
    const s = String(data).trim();
    if (!s || s === "undefined" || s === "null") return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  const clearCallTimers = () => {
    if (acceptCallTimeoutRef.current) {
      clearTimeout(acceptCallTimeoutRef.current);
      acceptCallTimeoutRef.current = null;
    }
    if (callDisconnectTimeoutRef.current) {
      clearTimeout(callDisconnectTimeoutRef.current);
      callDisconnectTimeoutRef.current = null;
    }
  };

  const markCallActive = (callId: string) => {
    clearCallTimers();
    setCallSession((prev) => {
      if (!prev || prev.id !== callId) return prev;
      const next = { ...prev, status: "active" as CallStatus, startedAt: prev.startedAt || Date.now(), error: null };
      callSessionRef.current = next;
      return next;
    });
  };

  const getConversationPeerId = (conversation?: Pick<ConversationItem, "id" | "targetUserId"> | null) => {
    if (!conversation) return "";
    const targetUserId = toId(conversation.targetUserId);
    if (targetUserId) return targetUserId;
    const conversationId = toId(conversation.id);
    return conversationId.startsWith("new_") ? conversationId.slice(4) : conversationId;
  };

  const getEventPeerId = (senderId?: unknown, receiverId?: unknown) => {
    const s = toId(senderId); const r = toId(receiverId);
    if (s && s === currentUserId) return r;
    if (r && r === currentUserId) return s;
    return s || r;
  };

  const doesEventMatchSelectedChat = (conversationId?: unknown, senderId?: unknown, receiverId?: unknown) => {
    const selectedId = toId(selectedChatIdRef.current);
    if (!selectedId) return false;
    if (toId(conversationId) === selectedId) return true;
    const sel = conversationsRef.current.find((c) => toId(c.id) === selectedId);
    const selPeerId = sel ? getConversationPeerId(sel) : selectedId.startsWith("new_") ? selectedId.slice(4) : "";
    const evPeerId = getEventPeerId(senderId, receiverId);
    return Boolean(selPeerId && evPeerId && selPeerId === evPeerId);
  };

  const resolveCallConversationId = (peerId: string, preferredConversationId?: string | null) => {
    const preferred = toId(preferredConversationId);
    if (preferred && !preferred.startsWith("new_")) return preferred;
    const selected = toId(selectedChatIdRef.current);
    if (selected && !selected.startsWith("new_")) {
      const selectedConversation = conversationsRef.current.find((c) => toId(c.id) === selected);
      if (selectedConversation && getConversationPeerId(selectedConversation) === peerId) return selected;
    }
    const found = conversationsRef.current.find((c) => getConversationPeerId(c) === peerId);
    return found && !found.id.startsWith("new_") ? found.id : "";
  };

  const selectedChat = useMemo(() => {
    if (!selectedChatId) return null;
    return [
      ...conversations,
      ...searchResults.map((u) => ({
        id: `new_${toId(u.id)}`, targetUserId: toId(u.id),
        name: u.name, avatar: u.avatar, status: "accepted", isOnline: Boolean(u.isOnline),
      })),
    ].find((c) => c.id === selectedChatId);
  }, [conversations, searchResults, selectedChatId]);

  const selectedChatAvatar = selectedChat
    ? getAvatarUrl(selectedChat.avatar, getConversationPeerId(selectedChat) || selectedChat.id)
    : "";
  const hasPersistedSelectedChat = Boolean(selectedChat && !selectedChat.id.startsWith("new_"));
  const effectiveChatBackgroundId = hasPersistedSelectedChat ? (selectedChat?.backgroundId || "soft") : (chatBackgroundId || "soft");
  const effectiveCustomChatBackground = hasPersistedSelectedChat ? (selectedChat?.backgroundUrl || "") : customChatBackground;
  const selectedChatBackground = CHAT_BACKGROUNDS.find((item) => item.id === effectiveChatBackgroundId) || CHAT_BACKGROUNDS[0];
  const normalizedCustomChatBackground = effectiveCustomChatBackground ? (normalizeAssetUrl(effectiveCustomChatBackground) || effectiveCustomChatBackground) : "";
  const cachedCustomChatBackground = useCachedImageSource(normalizedCustomChatBackground, "");
  const selectedChatBackgroundValue = normalizedCustomChatBackground
    ? `linear-gradient(180deg, rgba(248,250,252,0.12) 0%, rgba(248,250,252,0.18) 62%, rgba(248,250,252,0.28) 100%), url("${cachedCustomChatBackground || IMAGE_PLACEHOLDER_SRC}") center/cover no-repeat`
    : selectedChatBackground.value;

  const updateChatBackground = async (id: string) => {
    setChatBackgroundId(id);
    setCustomChatBackground("");
    const conversationId = selectedChat && !selectedChat.id.startsWith("new_") ? selectedChat.id : "";
    if (conversationId) {
      setConversations((prev) => mergeConversationUpdate(prev, { id: conversationId, backgroundId: id, backgroundUrl: "" }));
      try {
        const res = await api.updateChatConversationBackground(conversationId, { backgroundId: id, backgroundUrl: "" });
        const updated = normalizeConversationItem(res?.data || res);
        setConversations((prev) => mergeConversationUpdate(prev, updated));
      } catch (error: any) {
        toast.error(error?.message || "Không thể đổi nền hội thoại.");
        void loadChatsAndFriends({ force: true, silent: true });
      }
      return;
    }
    try {
      localStorage.setItem(CHAT_BACKGROUND_STORAGE_KEY, id);
      localStorage.removeItem(CUSTOM_CHAT_BACKGROUND_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  };

  const updateCustomChatBackground = async (url: string) => {
    const normalizedUrl = normalizeAssetUrl(url) || url;
    setCustomChatBackground(normalizedUrl);
    const conversationId = selectedChat && !selectedChat.id.startsWith("new_") ? selectedChat.id : "";
    if (conversationId) {
      setConversations((prev) => mergeConversationUpdate(prev, { id: conversationId, backgroundId: "custom", backgroundUrl: normalizedUrl }));
      try {
        const res = await api.updateChatConversationBackground(conversationId, { backgroundId: "custom", backgroundUrl: normalizedUrl });
        const updated = normalizeConversationItem(res?.data || res);
        setConversations((prev) => mergeConversationUpdate(prev, updated));
      } catch (error: any) {
        toast.error(error?.message || "Không thể đổi nền hội thoại.");
        void loadChatsAndFriends({ force: true, silent: true });
      }
      return;
    }
    try {
      localStorage.setItem(CUSTOM_CHAT_BACKGROUND_STORAGE_KEY, normalizedUrl);
    } catch {
      // Ignore storage failures.
    }
  };

  const applyIncomingCallEvent = (ev: any) => {
    if (!ev || !currentUserId) return;
    const callId = toId(ev.callId);
    const senderId = toId(ev.senderId);
    if (!callId || !senderId || senderId === currentUserId) return;
    if (ev.autoAccept) pendingAutoAcceptCallIdRef.current = callId;
    const activeCall = callSessionRef.current;
    if (activeCall && activeCall.id !== callId) return;

    const parsedOffer = parseRealtimePayload(ev.offer || (ev.type === "offer" ? ev.signalData : null));
    if (parsedOffer) incomingOfferRef.current = parsedOffer;
    const storedCandidates = Array.isArray(ev.candidates) ? ev.candidates : [];
    const parsedCandidate = parseRealtimePayload(ev.candidate || ((ev.type === "ice-candidate" || ev.type === "ice") ? ev.signalData : null));
    if (storedCandidates.length > 0) iceCandidateQueueRef.current = storedCandidates;
    if (parsedCandidate) iceCandidateQueueRef.current.push(parsedCandidate);

    if (activeCall?.id === callId) return;
    const mode: CallMode = ev.callType === "audio" ? "audio" : "video";
    const caller = conversationsRef.current.find((c) => getConversationPeerId(c) === senderId);
    const incoming: CallSession = {
      id: callId,
      mode,
      conversationId: toId(ev.conversationId),
      status: "incoming",
      startedAt: null,
      elapsedSeconds: 0,
      isMuted: false,
      isCameraOff: mode === "audio",
      isScreenSharing: false,
      cameraFacing: "user",
      isSpeakerOn: true,
      peerId: senderId,
      peerName: ev.senderName || caller?.name || "Người gọi",
      peerAvatar: ev.senderAvatar || caller?.avatar || getAvatarUrl("", senderId),
      hasMediaPermission: true,
      error: null,
    };
    callSessionRef.current = incoming;
    setCallSession(incoming);
  };

  // ==================== DATA LOADING ====================
  const loadChatsAndFriends = async (options: { force?: boolean; silent?: boolean } = {}) => {
    if (!currentUserId) {
      setIsLoadingChats(false);
      return;
    }

    const cacheKey = `chat-list:${currentUserId}`;
    const cached = options.force ? null : readExpiringCache(chatListMemoryCache, cacheKey, CHAT_LIST_CACHE_TTL_MS);
    if (cached) {
      setConversations(cached);
      setIsLoadingChats(false);
      return;
    }

    if (!options.silent) setIsLoadingChats(true);
    try {
      let convs: ConversationItem[] = [];
      try {
        const res = await api.getChatConversationsPage(0, 50);
        const raw = res?.content || [];
        convs = raw.map((c: any) => ({
          id: toId(c.id), type: c.type || "direct", targetUserId: toId(c.targetUserId) || undefined,
          name: c.type === "group" ? (c.groupName || "Nhóm chat") : (c.targetUserName || "Người dùng"), avatar: c.targetUserAvatar,
          lastMessage: c.lastMessage || "Bắt đầu cuộc trò chuyện mới.",
          time: c.lastMessageTime ? formatVietnamTime(c.lastMessageTime) : "",
          unread: c.unreadCount || 0, status: c.status || "accepted", isOnline: Boolean(c.targetIsOnline), memberCount: c.memberCount,
          backgroundId: c.backgroundId || undefined, backgroundUrl: c.backgroundUrl || undefined,
        }));
      } catch (e) { console.error(e); }

      let friends: any[] = [];

      const final = [...convs];
      const existingIds = new Set(convs.map((c) => String(c.targetUserId || c.id)));
      friends.forEach((f: any) => {
        const fId = toId(f.id);
        if (!existingIds.has(fId)) {
          final.push({ id: `new_${fId}`, targetUserId: fId, name: f.name || "Người dùng", avatar: f.avatar, lastMessage: "Sẵn sàng mở cuộc trò chuyện.", time: "", unread: 0, isOnline: Boolean(f.isOnline), status: "accepted" });
        }
      });
      const nextConversations = dedupConversations(final);
      writeExpiringCache(chatListMemoryCache, cacheKey, nextConversations);
      setConversations(nextConversations);
    } finally {
      if (!options.silent) setIsLoadingChats(false);
    }
  };

  const scheduleChatsRefresh = () => {
    if (chatRefreshDebounceRef.current) return;
    chatRefreshDebounceRef.current = setTimeout(() => {
      chatRefreshDebounceRef.current = null;
      void loadChatsAndFriends({ force: true, silent: true });
    }, 1200);
  };

  // ==================== ACCEPT / REJECT PENDING ====================
  const handleAcceptRequestLegacy = async () => {
    if (!selectedChat) return;
    setIsAcceptingRequest(true);
    const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;

    try {
      if (convId) await api.acceptChatConversation(convId);
      setConversations((prev) => prev.map((c) => c.id === selectedChat.id ? { ...c, status: "accepted" } : c));
      toast.success("Đã chấp nhận tin nhắn");
    } catch {
      setConversations((prev) => prev.map((c) => c.id === selectedChat.id ? { ...c, status: "accepted" } : c));
      toast.warning("Đã mở hội thoại trên giao diện. Backend cần deploy endpoint accept mới.");
    } finally {
      setIsAcceptingRequest(false);
    }
  };

  const handleAcceptRequest = async () => {
    if (!selectedChat) return;
    setIsAcceptingRequest(true);
    const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;

    try {
      if (!convId) throw new Error("Không thể chấp nhận hội thoại chưa có id.");
      const res = await api.acceptChatConversation(convId);
      const accepted = normalizeConversationItem(res || {});
      setConversations((prev) => prev.map((c) => c.id === selectedChat.id ? { ...c, ...accepted, id: convId, status: "accepted", unread: c.unread } : c));
      await loadChatsAndFriends({ force: true });
      toast.success("Đã chấp nhận tin nhắn");
    } catch (error: any) {
      toast.error(error?.message || "Không thể chấp nhận tin nhắn.");
    } finally {
      setIsAcceptingRequest(false);
    }
  };

  const handleRejectRequest = async () => {
    if (!selectedChat) return;
    const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;

    let succeeded = false;
    if (convId) {
      try {
        await api.rejectChatConversation(convId);
        succeeded = true;
      } catch {
        succeeded = false;
      }
    }

    setConversations((prev) => prev.filter((c) => c.id !== selectedChat.id));
    setConversationMessages(null, []);
    setSelectedChatId(null);
    if (succeeded) toast.success("Đã từ chối tin nhắn");
    else toast.warning("Đã xóa khỏi giao diện. Backend cần deploy endpoint reject mới.");
  };

  // ==================== CALL SIGNALING ====================
  const sendCallSignal = (type: string, signalData: any = null, targetId: string, callId: string, callMode: CallMode) => {
    if (!stompClientRef.current?.connected) return;
    const sessionConvId = callSessionRef.current?.id === callId ? callSessionRef.current.conversationId : undefined;
    const convId = resolveCallConversationId(targetId, sessionConvId);
    stompClientRef.current.publish({
      destination: "/app/chat.call",
      body: JSON.stringify({ callId, conversationId: convId, receiverId: targetId, type, callType: callMode, signalData }),
    });
  };

  const scheduleCallConnectTimeout = (callId: string) => {
    if (acceptCallTimeoutRef.current) clearTimeout(acceptCallTimeoutRef.current);
    acceptCallTimeoutRef.current = setTimeout(() => {
      const session = callSessionRef.current;
      if (!session || session.id !== callId || session.status !== "connecting") return;
      toast.error("Khong ket noi duoc cuoc goi. Vui long thu lai.");
      closeCall(true);
    }, CALL_CONNECT_TIMEOUT_MS);
  };

  const logCallStatusToChat = (session: CallSession, reason: "ended" | "missed" | "rejected") => {
    if (!stompClientRef.current?.connected) return;
    let logText = reason === "rejected"
      ? (session.mode === "video" ? "📹 Đã từ chối cuộc gọi video" : "📞 Đã từ chối cuộc gọi thoại")
      : (session.elapsedSeconds === 0 || reason === "missed")
      ? (session.mode === "video" ? "📹 Cuộc gọi video nhỡ" : "📞 Cuộc gọi thoại nhỡ")
      : `📞 Cuộc gọi kết thúc. Thời lượng: ${formatCallDuration(session.elapsedSeconds)}`;
    const convId = resolveCallConversationId(session.peerId, session.conversationId);
    if (!convId) return;
    stompClientRef.current.publish({
      destination: "/app/chat.sendMessage",
      body: JSON.stringify({ conversationId: convId, receiverId: session.peerId, content: logText, messageType: "call_log" }),
    });
  };

  const createPeerConnection = (targetId: string, callId: string, callMode: CallMode) => {
    const pc = new RTCPeerConnection(iceServers);
    pc.onicecandidate = (e) => {
      if (e.candidate) sendCallSignal("ice-candidate", { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }, targetId, callId, callMode);
    };
    pc.ontrack = (e) => {
      const incomingStream = e.streams?.[0];
      const stream = incomingStream || remoteStreamRef.current || new MediaStream();
      if (!incomingStream && !stream.getTracks().some((track) => track.id === e.track.id)) {
        stream.addTrack(e.track);
      }
      remoteStreamRef.current = stream;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = stream;
        remoteVideoRef.current.muted = true;
        remoteVideoRef.current.play().catch(() => {});
      }
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = stream;
        remoteAudioRef.current.volume = 1;
        remoteAudioRef.current.muted = !callSessionRef.current?.isSpeakerOn;
        remoteAudioRef.current.play().catch(() => {});
      }
    };
    const handleConnectionState = () => {
      const state = pc.connectionState;
      const iceState = pc.iceConnectionState;
      if (state === "connected" || iceState === "connected" || iceState === "completed") {
        markCallActive(callId);
        return;
      }
      if (state === "failed" || iceState === "failed" || state === "disconnected" || iceState === "disconnected") {
        if (callDisconnectTimeoutRef.current) clearTimeout(callDisconnectTimeoutRef.current);
        callDisconnectTimeoutRef.current = setTimeout(() => {
          if (peerConnectionRef.current !== pc) return;
          const currentState = pc.connectionState;
          const currentIceState = pc.iceConnectionState;
          if (currentState === "connected" || currentIceState === "connected" || currentIceState === "completed") {
            markCallActive(callId);
            return;
          }
          const currentSession = callSessionRef.current;
          if (currentSession?.id === callId && currentSession.status === "connecting") return;
          if (currentState === "failed" || currentIceState === "failed" || currentState === "disconnected" || currentIceState === "disconnected") {
            toast.error("Ket noi cuoc goi bi gian doan.");
            closeCall(true);
          }
        }, CALL_DISCONNECT_GRACE_MS);
        return;
      }
      if (callDisconnectTimeoutRef.current) {
        clearTimeout(callDisconnectTimeoutRef.current);
        callDisconnectTimeoutRef.current = null;
      }
    };
    pc.oniceconnectionstatechange = handleConnectionState;
    pc.onconnectionstatechange = handleConnectionState;
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
    peerConnectionRef.current = pc;
    return pc;
  };

  const replaceLocalVideoTrack = (track: MediaStreamTrack) => {
    const sender = peerConnectionRef.current?.getSenders().find((s) => s.track?.kind === "video");
    sender?.replaceTrack(track).catch(() => toast.error("Không thể đổi nguồn video."));

    const audioTracks = localStreamRef.current?.getAudioTracks() || cameraStreamRef.current?.getAudioTracks() || [];
    localStreamRef.current?.getVideoTracks().forEach((oldTrack) => {
      if (oldTrack.id !== track.id) oldTrack.stop();
    });
    localStreamRef.current = new MediaStream([...audioTracks, track]);
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = new MediaStream([track]);
      localVideoRef.current.play().catch(() => {});
    }
  };

  const stopScreenShare = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || !s.isScreenSharing) return;
    screenStreamRef.current?.getVideoTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    screenStreamRef.current = null;
    try {
      const cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: s.cameraFacing }, audio: false });
      cameraStreamRef.current?.getVideoTracks().forEach((track) => track.stop());
      cameraStreamRef.current = cameraStream;
      const [cameraTrack] = cameraStream.getVideoTracks();
      if (cameraTrack) replaceLocalVideoTrack(cameraTrack);
      setCallSession((prev) => prev ? { ...prev, isScreenSharing: false, isCameraOff: false } : prev);
    } catch {
      toast.error("Không thể bật lại camera.");
      setCallSession((prev) => prev ? { ...prev, isScreenSharing: false, isCameraOff: true } : prev);
    }
  };

  const closeCall = (isLocal = true, isReject = false) => {
    clearCallTimers();
    clearPendingCall();
    const s = callSessionRef.current;
    if (s && isLocal) {
      if (isReject) { logCallStatusToChat(s, "rejected"); sendCallSignal("reject", null, s.peerId, s.id, s.mode); }
      else if (s.status === "incoming") { logCallStatusToChat(s, "rejected"); sendCallSignal("reject", null, s.peerId, s.id, s.mode); }
      else { logCallStatusToChat(s, s.elapsedSeconds === 0 ? "missed" : "ended"); sendCallSignal("end", null, s.peerId, s.id, s.mode); }
    }
    if (peerConnectionRef.current) { peerConnectionRef.current.close(); peerConnectionRef.current = null; }
    remoteStreamRef.current = null; incomingOfferRef.current = null; iceCandidateQueueRef.current = [];
    if (localStreamRef.current) { localStreamRef.current.getTracks().forEach((t) => t.stop()); localStreamRef.current = null; }
    if (cameraStreamRef.current) { cameraStreamRef.current.getTracks().forEach((t) => t.stop()); cameraStreamRef.current = null; }
    if (screenStreamRef.current) { screenStreamRef.current.getTracks().forEach((t) => t.stop()); screenStreamRef.current = null; }
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    setCallSession(null);
  };

  const getCallMediaStream = async (mode: CallMode) => {
    if (mode === "audio") return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
      });
    } catch {
      const audioOnly = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      toast.warning("Không mở được camera trên máy này, cuộc gọi vẫn tiếp tục bằng micro.");
      return audioOnly;
    }
  };

  const startCall = async (mode: CallMode) => {
    if (!selectedChat) { toast.error("Hãy chọn một cuộc trò chuyện trước."); return; }
    if (selectedChat.status === "pending") { toast.error("Không thể gọi khi hội thoại đang chờ phê duyệt."); return; }
    closeCall(false);
    clearPendingCall();
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const targetId = getConversationPeerId(selectedChat);
    if (!targetId) { toast.error("Khong tim thay nguoi nhan cuoc goi."); return; }
    const conversationId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;
    const newSession: CallSession = { id: callId, mode, conversationId, status: "connecting", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: mode === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: targetId, peerName: selectedChat.name, peerAvatar: selectedChatAvatar, hasMediaPermission: true, error: null };
    callSessionRef.current = newSession; setCallSession(newSession);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Trình duyệt không hỗ trợ media devices.");
      const stream = await getCallMediaStream(mode);
      localStreamRef.current = stream;
      if (mode === "video" && stream.getVideoTracks().length > 0) cameraStreamRef.current = stream.clone();
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.play().catch(() => {}); }
      const pc = createPeerConnection(targetId, callId, mode);
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      sendCallSignal("start", null, targetId, callId, mode);
      sendCallSignal("offer", { type: offer.type, sdp: offer.sdp }, targetId, callId, mode);
      scheduleCallConnectTimeout(callId);
    } catch (err: any) {
      toast.error("Không thể truy cập micro/camera.");
      closeCall(true);
    }
  };

  const acceptCall = async () => {
    const s = callSessionRef.current; if (!s) return;
    try {
      clearPendingCall();
      const stream = await getCallMediaStream(s.mode);
      localStreamRef.current = stream;
      if (s.mode === "video" && stream.getVideoTracks().length > 0) cameraStreamRef.current = stream.clone();
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.play().catch(() => {}); }
      const pc = createPeerConnection(s.peerId, s.id, s.mode);
      const next = { ...s, status: "connecting" as CallStatus, startedAt: null };
      callSessionRef.current = next; setCallSession(next);
      sendCallSignal("accept", null, s.peerId, s.id, s.mode);
      scheduleCallConnectTimeout(s.id);
      if (incomingOfferRef.current) {
        await pc.setRemoteDescription(new RTCSessionDescription(incomingOfferRef.current));
        incomingOfferRef.current = null;
        for (const c of iceCandidateQueueRef.current) await pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
        iceCandidateQueueRef.current = [];
        const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
        sendCallSignal("answer", { type: answer.type, sdp: answer.sdp }, s.peerId, s.id, s.mode);
        markCallActive(s.id);
      }
    } catch (err: any) { toast.error(`Lỗi thiết bị: ${err.message}`); closeCall(true, true); }
  };

  useEffect(() => {
    if (!callSession || callSession.status !== "incoming") return;
    if (pendingAutoAcceptCallIdRef.current !== callSession.id) return;
    pendingAutoAcceptCallIdRef.current = null;
    void acceptCall();
  }, [callSession?.id, callSession?.status]);

  const rejectCall = () => closeCall(true, true);
  const toggleMute = () => setCallSession((prev) => { if (!prev) return prev; const m = !prev.isMuted; localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !m)); return { ...prev, isMuted: m }; });
  const toggleCamera = () => setCallSession((prev) => { if (!prev || prev.mode !== "video") return prev; const c = !prev.isCameraOff; localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !c)); return { ...prev, isCameraOff: c }; });
  const toggleScreenShare = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || s.status === "incoming") return;
    if (s.isScreenSharing) {
      await stopScreenShare();
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast.error("Trình duyệt không hỗ trợ chia sẻ màn hình.");
      return;
    }
    try {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = screenStream;
      const [screenTrack] = screenStream.getVideoTracks();
      if (!screenTrack) throw new Error("Không có màn hình được chọn.");
      screenTrack.onended = () => {
        if (callSessionRef.current?.isScreenSharing) void stopScreenShare();
      };
      replaceLocalVideoTrack(screenTrack);
      setCallSession((prev) => prev ? { ...prev, isScreenSharing: true, isCameraOff: false } : prev);
    } catch (error: any) {
      toast.error(error?.message || "Không thể chia sẻ màn hình.");
    }
  };
  const switchCamera = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || s.isScreenSharing) return;
    const nextFacing = s.cameraFacing === "user" ? "environment" : "user";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nextFacing }, audio: false });
      cameraStreamRef.current?.getVideoTracks().forEach((track) => track.stop());
      cameraStreamRef.current = stream;
      const [track] = stream.getVideoTracks();
      if (!track) throw new Error("Không tìm thấy camera.");
      replaceLocalVideoTrack(track);
      setCallSession((prev) => prev ? { ...prev, cameraFacing: nextFacing, isCameraOff: false } : prev);
    } catch {
      toast.error("Thiết bị không có camera trước/sau để đổi.");
    }
  };
  const toggleSpeaker = () => setCallSession((prev) => {
    if (!prev) return prev;
    const isSpeakerOn = !prev.isSpeakerOn;
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !isSpeakerOn;
    return { ...prev, isSpeakerOn };
  });

  const handleToggleReaction = (messageId: string, emoji: string) => {
    if (!stompClientRef.current?.connected) { toast.error("Kết nối chưa sẵn sàng."); return; }
    setShowReactionPicker(null);
    stompClientRef.current.publish({ destination: "/app/chat.react", body: JSON.stringify({ messageId, emoji }) });
  };

  // ==================== WEBSOCKET ====================
  useEffect(() => {
    if (!currentUserId) return;
    const token = localStorage_service.getAuthToken();
    if (!token) return;
    if (stompClientRef.current?.active) stompClientRef.current.deactivate();

    const client = new Client({
      webSocketFactory: () => createRealtimeConnection(),
      connectHeaders: { Authorization: `Bearer ${token}` },
      reconnectDelay: 5000, heartbeatIncoming: 10000, heartbeatOutgoing: 10000,
      onStompError: (f) => console.error("[STOMP Error]", f),
      onConnect: () => {
        const safe = (data: any) => {
          if (!data) return null;
          if (typeof data === "object") return data;
          const s = String(data).trim();
          if (!s || s === "undefined" || s === "null") return null;
          try { return JSON.parse(s); } catch { return null; }
        };

        const subscribeUserQueue = (queue: string, handler: (frame: any) => void) => {
          [`/user/queue/${queue}`, `/user/${currentUserId}/queue/${queue}`].forEach((destination) => {
            client.subscribe(destination, handler);
          });
        };

        subscribeUserQueue("messages", (frame) => {
  const msg = safe(frame.body); 
  if (!msg) return;
  
  const messageKey = toId(msg.id) || `${toId(msg.conversationId)}:${toId(msg.senderId)}:${toId(msg.createdAt)}:${toId(msg.content)}`;
  if (messageKey && realtimeMessageIdsRef.current.has(messageKey)) return;
  if (messageKey) {
    realtimeMessageIdsRef.current.add(messageKey);
    if (realtimeMessageIdsRef.current.size > 300) {
      realtimeMessageIdsRef.current = new Set(Array.from(realtimeMessageIdsRef.current).slice(-150));
    }
  }
  
  const convId = toId(msg.conversationId);
  const senderId = toId(msg.senderId);
  const receiverId = toId(msg.receiverId);
  const peerId = getEventPeerId(senderId, receiverId);
  
  // Cập nhật danh sách hội thoại
  setConversations((prev) => {
    const updated = [...prev];
    
    // Bước 1: Tìm bằng conversationId (ƯU TIÊN SỐ 1)
    let idx = updated.findIndex((c) => convId && toId(c.id) === convId);
    
    // Bước 2: Nếu không tìm thấy, tìm theo peerId (cho chat 1-1)
    if (idx === -1) {
      idx = updated.findIndex((c) => {
        if (!toId(c.id).startsWith("new_")) return false;
        const cPeerId = getConversationPeerId(c);
        if (!c.type || c.type === "direct") {
          return (senderId === currentUserId && cPeerId === receiverId) || 
                 (receiverId === currentUserId && cPeerId === senderId);
        }
        return c.type === "group" && convId && toId(c.id) === convId;
      });
    }
    
    if (idx > -1) {
      const conv = { ...updated[idx] };
      conv.lastMessage = msg.content;
      conv.time = formatVietnamTime(msg.createdAt);
      
      // Chỉ tăng unread nếu:
      // 1. Tin nhắn KHÔNG phải của mình
      // 2. Hội thoại này KHÔNG đang được chọn
      if (senderId !== currentUserId && toId(selectedChatIdRef.current) !== toId(conv.id)) {
        conv.unread = (conv.unread || 0) + 1;
      }
      
      // Cập nhật ID nếu hội thoại đang ở dạng "new_"
      if (toId(conv.id).startsWith("new_") && convId) {
        const prevPeerId = getConversationPeerId(conv);
        conv.id = convId; 
        conv.targetUserId = conv.targetUserId || prevPeerId || peerId;
        if (selectedChatIdRef.current === `new_${prevPeerId}` || selectedChatIdRef.current === `new_${peerId}`) {
          setSelectedChatId(convId);
        }
      }
      
      updated.splice(idx, 1); 
      updated.unshift(conv); 
      return dedupConversations(updated);
    }
    
    scheduleChatsRefresh();
    return updated;
  });
  
  // ✅ CHỈ HIỂN THỊ TIN NHẮN NẾU ĐÚNG HỘI THOẠI ĐANG MỞ
  // So sánh trực tiếp conversationId với selectedChatId
  const selectedId = toId(selectedChatIdRef.current);
  const messageBelongsToSelectedChat = convId && selectedId && toId(convId) === selectedId;
  
  if (messageBelongsToSelectedChat) {
    setConversationMessages(convId, (prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      const clean = prev.filter((m) => !(m.id.startsWith("temp_") && m.text === msg.content));
      return [...clean, {
        id: msg.id,
        senderId: senderId === currentUserId ? "me" : senderId,
        senderName: msg.senderName,
        senderAvatar: msg.senderAvatar,
        text: msg.content,
        time: formatVietnamTime(msg.createdAt),
        createdAt: msg.createdAt || new Date().toISOString(),
        deliveryStatus: "sent",
        replyToMessageId: msg.replyToMessageId,
        attachmentUrl: msg.attachmentUrl,
        attachmentName: msg.attachmentName,
        attachmentSize: msg.attachmentSize,
        messageType: msg.messageType,
      }];
    });
  }
});

        subscribeUserQueue("message-updates", (frame) => {
          const msg = safe(frame.body); if (!msg) return;
          if (toId(msg.conversationId) !== toId(messagesConversationIdRef.current)) return;
          setConversationMessages(toId(msg.conversationId), (prev) => prev.map((item) => {
            if (toId(item.id) !== toId(msg.id)) return item;
            return {
              ...item,
              text: msg.isDeleted ? "Tin nhắn đã được thu hồi" : (msg.content || msg.text || item.text),
              isDeleted: Boolean(msg.isDeleted),
              isEdited: Boolean(msg.editedAt),
              time: msg.createdAt ? formatVietnamTime(msg.createdAt) : item.time,
            };
          }));
          setConversations((prev) => prev.map((c) => (
            toId(c.id) === toId(msg.conversationId)
              ? { ...c, lastMessage: msg.isDeleted ? "Tin nhắn đã được thu hồi" : (msg.content || c.lastMessage) }
              : c
          )));
        });

        subscribeUserQueue("typing", (frame) => {
          const ev = safe(frame.body); if (!ev) return;
          const isTyping = ev.isTyping === true || ev.typing === true;
          const convKey = toId(ev.conversationId), peerId = getEventPeerId(ev.senderId, ev.receiverId);
          setTypingUsers((prev) => { const next = { ...prev }; if (convKey) next[convKey] = isTyping; if (peerId) next[`new_${peerId}`] = isTyping; return next; });
        });

        subscribeUserQueue("conversation-updates", (frame) => {
          const update = safe(frame.body); if (!update?.id) return;
          const partial: Partial<ConversationItem> & { id: string } = { id: toId(update.id) };
          if ("backgroundId" in update) partial.backgroundId = update.backgroundId || undefined;
          if ("backgroundUrl" in update) partial.backgroundUrl = update.backgroundUrl || undefined;
          if ("status" in update) partial.status = update.status || "accepted";
          if ("lastMessage" in update) partial.lastMessage = update.lastMessage || "";
          if ("lastMessageTime" in update) partial.time = update.lastMessageTime ? formatVietnamTime(update.lastMessageTime) : "";
          if ("targetIsOnline" in update) partial.isOnline = Boolean(update.targetIsOnline);
          if ("targetUserName" in update) partial.name = update.targetUserName || partial.name;
          if ("targetUserAvatar" in update) partial.avatar = update.targetUserAvatar || partial.avatar;
          if ("groupName" in update) partial.name = update.groupName || partial.name;
          if ("memberCount" in update) partial.memberCount = update.memberCount;
          setConversations((prev) => mergeConversationUpdate(prev, partial));
        });

        subscribeUserQueue("call", (frame) => {
          const ev = safe(frame.body); if (!ev) return;
          const { type, callId, callType, senderId, signalData } = ev;
          const signalKey = `${toId(callId)}:${toId(senderId)}:${toId(type)}:${typeof signalData === "string" ? signalData : JSON.stringify(signalData || "")}`;
          if (processedCallSignalsRef.current.has(signalKey)) return;
          processedCallSignalsRef.current.add(signalKey);
          if (processedCallSignalsRef.current.size > 500) {
            processedCallSignalsRef.current = new Set(Array.from(processedCallSignalsRef.current).slice(-250));
          }
          const parsed = safe(signalData);
          const normalizedCallId = toId(callId);
          const normalizedSenderId = toId(senderId);
          const mode: CallMode = callType === "audio" ? "audio" : "video";
          const activeCall = callSessionRef.current;
          if (type !== "start" && activeCall && activeCall.id !== normalizedCallId) return;
          if (type === "start") {
            if (activeCall && activeCall.id !== normalizedCallId) return;
            clearPendingCall();
            const caller = conversationsRef.current.find((c) => getConversationPeerId(c) === toId(senderId));
            const incoming: CallSession = { id: callId, mode: callType, status: "incoming", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: callType === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: toId(senderId), peerName: caller?.name || "Người gọi", peerAvatar: caller?.avatar || getAvatarUrl("", senderId), hasMediaPermission: true, error: null };
            incoming.conversationId = toId(ev.conversationId);
            callSessionRef.current = incoming; setCallSession(incoming);
          } else if (type === "offer" && parsed) {
            if (!callSessionRef.current) {
              clearPendingCall();
              const caller = conversationsRef.current.find((c) => getConversationPeerId(c) === normalizedSenderId);
              const incoming: CallSession = { id: normalizedCallId, mode, conversationId: toId(ev.conversationId), status: "incoming", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: mode === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: normalizedSenderId, peerName: ev.senderName || caller?.name || "Nguoi goi", peerAvatar: ev.senderAvatar || caller?.avatar || getAvatarUrl("", senderId), hasMediaPermission: true, error: null };
              callSessionRef.current = incoming; setCallSession(incoming);
            }
            incomingOfferRef.current = parsed;
            const pc = peerConnectionRef.current;
            if (pc && !pc.remoteDescription) {
              pc.setRemoteDescription(new RTCSessionDescription(parsed)).then(() => {
                iceCandidateQueueRef.current.forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
                iceCandidateQueueRef.current = [];
                return pc.createAnswer();
              }).then((ans) => pc.setLocalDescription(ans)).then(() => {
                if (pc.localDescription) {
                  sendCallSignal("answer", { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, toId(senderId), callId, callType);
                  markCallActive(normalizedCallId);
                }
              }).catch(console.error);
            }
          } else if (type === "answer" && parsed && peerConnectionRef.current) {
            clearPendingCall();
            if (acceptCallTimeoutRef.current) { clearTimeout(acceptCallTimeoutRef.current); acceptCallTimeoutRef.current = null; }
            peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(parsed)).then(() => {
              iceCandidateQueueRef.current.forEach((c) => peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {}));
              iceCandidateQueueRef.current = [];
            }).catch(console.error);
            markCallActive(normalizedCallId);
          } else if ((type === "ice-candidate" || type === "ice") && parsed) {
            if (peerConnectionRef.current?.remoteDescription) peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(parsed)).catch(() => {});
            else iceCandidateQueueRef.current.push(parsed);
          } else if (type === "reject" || type === "end") {
            if (callSessionRef.current) toast.info(type === "reject" ? "Đã từ chối cuộc gọi" : "Cuộc gọi đã kết thúc");
            closeCall(false);
          }
        });

        subscribeUserQueue("reactions", (frame) => {
          const reaction = safe(frame.body); if (!reaction) return;
          const currentConversationId = messagesConversationIdRef.current;
          if (currentConversationId && currentConversationId !== toId(selectedChatIdRef.current)) return;
          setConversationMessages(currentConversationId, (prev) => prev.map((msg) => {
            if (msg.id !== reaction.messageId) return msg;
            const updated = { ...(msg.userReactions || {}) };
            if (reaction.action === "added") updated[reaction.emoji] = true;
            else delete updated[reaction.emoji];
            return { ...msg, reactions: reaction.reactions, userReactions: updated };
          }));
        });

        subscribeUserQueue("online-status", (frame) => {
          const status = safe(frame.body); if (!status) return;
          const userId = toId(status.userId);
          if (!userId) return;
          setConversations((prev) => prev.map((c) => getConversationPeerId(c) === userId ? { ...c, isOnline: Boolean(status.isOnline) } : c));
          setSearchResults((prev) => prev.map((u) => toId(u.id) === userId ? { ...u, isOnline: Boolean(status.isOnline) } : u));
        });

        subscribeUserQueue("errors", (frame) => {
          const message = safe(frame.body) || frame.body;
          if (message) toast.error(String(message));
        });

        client.publish({ destination: "/app/presence.ping", body: "{}" });
        const presenceTimer = window.setInterval(() => {
          if (client.connected) client.publish({ destination: "/app/presence.ping", body: "{}" });
        }, 60000);
        (client as any).__presenceTimer = presenceTimer;
      },
    });

    client.activate();
    stompClientRef.current = client;
    return () => {
      const presenceTimer = (client as any).__presenceTimer;
      if (presenceTimer) window.clearInterval(presenceTimer);
      if (client.active) client.deactivate();
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    const onIncomingCall = (event: Event) => {
      applyIncomingCallEvent((event as CustomEvent).detail);
    };
    window.addEventListener(INCOMING_CALL_EVENT, onIncomingCall);

    const pendingCall = readPendingCall<any>();
    if (pendingCall) {
      applyIncomingCallEvent(pendingCall);
      clearPendingCall();
    }

    return () => window.removeEventListener(INCOMING_CALL_EVENT, onIncomingCall);
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    loadChatsAndFriends();
    const refreshTimer = window.setInterval(() => loadChatsAndFriends({ silent: true }), 60000);
    return () => window.clearInterval(refreshTimer);
  }, [currentUserId]);

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const userId = toId(params.get("user")).trim();
    if (!userId) {
      openedUrlUserRef.current = null;
      openingUrlUserRef.current = null;
      return;
    }
    if (isLoadingChats) return;

    const existing = conversations.find((chat) => toId(getConversationPeerId(chat)) === userId || toId(chat.id) === userId);
    if (existing) {
      openedUrlUserRef.current = userId;
      openingUrlUserRef.current = null;
      if (selectedChatIdRef.current !== existing.id) setSelectedChatId(existing.id);
      return;
    }

    const pendingConversationId = `new_${userId}`;
    const alreadyPrepared = selectedChatIdRef.current === pendingConversationId
      || searchResults.some((item) => toId(item.id) === userId);
    if (alreadyPrepared) {
      const alreadyOpenedThisUser = openedUrlUserRef.current === userId;
      openedUrlUserRef.current = userId;
      if (!alreadyOpenedThisUser && selectedChatIdRef.current !== pendingConversationId) {
        setConversationMessages(pendingConversationId, []);
        setSelectedChatId(pendingConversationId);
      }
      return;
    }

    if (openedUrlUserRef.current === userId || openingUrlUserRef.current === userId) {
      return;
    }

    let cancelled = false;
    openingUrlUserRef.current = userId;
    const openNewConversation = async () => {
      try {
        const user = await api.getUser(userId);
        if (cancelled || !user?.id) return;
        const item: SearchUserItem = {
          id: toId(user.id),
          name: user.name || "Người dùng",
          avatar: user.avatar,
          isOnline: Boolean(user.isOnline),
        };
        openedUrlUserRef.current = userId;
        setSearchResults((prev) => prev.some((u) => toId(u.id) === toId(item.id)) ? prev : [item, ...prev]);
        const newConversationId = `new_${toId(item.id)}`;
        setConversationMessages(newConversationId, []);
        setSelectedChatId(newConversationId);
      } catch {
        toast.error("Không thể mở hội thoại với người dùng này.");
      } finally {
        if (openingUrlUserRef.current === userId) openingUrlUserRef.current = null;
      }
    };
    openNewConversation();
    return () => { cancelled = true; };
  }, [location.search, isLoadingChats, conversations, searchResults]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typingUsers]);

  useEffect(() => {
    if (!callSession || callSession.status !== "active" || !callSession.startedAt) return;
    const timer = setInterval(() => {
      setCallSession((prev) => prev?.startedAt ? { ...prev, elapsedSeconds: Math.floor((Date.now() - prev.startedAt) / 1000) } : prev);
    }, 1000);
    return () => clearInterval(timer);
  }, [callSession?.status, callSession?.startedAt]);

  useEffect(() => {
    const stream = remoteStreamRef.current;
    if (!callSession || callSession.status === "incoming" || !stream) return;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = stream;
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.play().catch(() => {});
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = stream;
      remoteAudioRef.current.volume = 1;
      remoteAudioRef.current.muted = !callSession.isSpeakerOn;
      remoteAudioRef.current.play().catch(() => {});
    }
  }, [callSession?.id, callSession?.status, callSession?.isSpeakerOn]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (chatRefreshDebounceRef.current) clearTimeout(chatRefreshDebounceRef.current);
      if (audioRecorderRef.current) {
        audioRecorderRef.current.ondataavailable = null;
        audioRecorderRef.current.onstop = null;
        if (audioRecorderRef.current.state !== "inactive") audioRecorderRef.current.stop();
      }
      audioStreamRef.current?.getTracks().forEach((track) => track.stop());
      closeCall(false);
    };
  }, []);

  useEffect(() => {
    const sequence = ++userSearchSequenceRef.current;
    if (!userSearchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setIsSearching(true);
      try {
        const r = await api.searchUsersToChat(userSearchQuery);
        if (sequence === userSearchSequenceRef.current) setSearchResults(r || []);
      } catch {
      } finally {
        if (sequence === userSearchSequenceRef.current) setIsSearching(false);
      }
    }, 500);
    return () => clearTimeout(t);
  }, [userSearchQuery]);

  useEffect(() => {
    if (!selectedChatId) return;
    const conversationId = selectedChatId;
    if (conversationId.startsWith("new_")) {
      setOldestMessageCursor(null);
      setHasMoreMessages(false);
      setConversationMessages(conversationId, []);
      return;
    }
    if (!currentUserId) return;
    let cancelled = false;
    const cacheKey = `messages:${currentUserId}:${conversationId}`;
    const cached = readExpiringCache(messagePageMemoryCache, cacheKey, MESSAGE_PAGE_CACHE_TTL_MS);
    const lastInitialFetchAt = initialMessageFetchAtRef.current.get(cacheKey) || 0;
    const hasFreshInitialFetch = Date.now() - lastInitialFetchAt < 8000;
    if (cached) {
      setConversationMessages(conversationId, cached.messages);
      setOldestMessageCursor(cached.oldestMessageCursor);
      setHasMoreMessages(cached.hasMoreMessages);
      setIsLoadingMessages(false);
    } else {
      setConversationMessages(conversationId, []);
      setOldestMessageCursor(null);
      setHasMoreMessages(false);
      setIsLoadingMessages(true);
    }
    setConversations((prev) => prev.map((c) => c.id === conversationId ? { ...c, unread: 0 } : c));
    const selectedConversation = conversationsRef.current.find((c) => toId(c.id) === conversationId);
    if (lastReadConversationRef.current !== conversationId || Number(selectedConversation?.unread || 0) > 0) {
      lastReadConversationRef.current = conversationId;
      void api.markChatConversationRead(conversationId).catch(() => {});
    }

    if (cached && hasFreshInitialFetch) {
      return () => { cancelled = true; };
    }

    const fetchMessages = async () => {
      try {
        initialMessageFetchAtRef.current.set(cacheKey, Date.now());
        const res = await api.getChatMessagesPage(conversationId, INITIAL_MESSAGE_PAGE_SIZE);
        if (cancelled || selectedChatIdRef.current !== conversationId) return;
        const payload = res?.data || res;
        const list = Array.isArray(payload) ? payload : payload?.messages || [];
        const nextMessages = list.map(mapMessageItem);
        setOldestMessageCursor(Array.isArray(payload) ? null : (payload?.nextBeforeMessageId || null));
        setHasMoreMessages(Boolean(!Array.isArray(payload) && payload?.hasMore));
        setConversationMessages(conversationId, nextMessages);
      } catch {
        if (!cached && !cancelled && selectedChatIdRef.current === conversationId) {
          setConversationMessages(conversationId, []);
        }
      } finally {
        if (!cancelled && selectedChatIdRef.current === conversationId) {
          setIsLoadingMessages(false);
        }
      }
    };
    fetchMessages();
    return () => { cancelled = true; };
  }, [selectedChatId, currentUserId]);

  const loadOlderMessages = async () => {
    const conversationId = toId(selectedChatIdRef.current);
    if (!conversationId || conversationId.startsWith("new_") || !oldestMessageCursor || loadingOlderMessagesRef.current) return;

    loadingOlderMessagesRef.current = true;
    const scrollContainer = messagesScrollRef.current;
    const previousScrollHeight = scrollContainer?.scrollHeight || 0;
    const previousScrollTop = scrollContainer?.scrollTop || 0;
    setIsLoadingOlderMessages(true);
    try {
      const res = await api.getChatMessagesPage(conversationId, OLDER_MESSAGE_PAGE_SIZE, oldestMessageCursor);
      if (toId(selectedChatIdRef.current) !== conversationId) return;
      const payload = res?.data || res;
      const list = payload?.messages || [];
      const olderMessages = list.map(mapMessageItem);
      setOldestMessageCursor(payload?.nextBeforeMessageId || null);
      setHasMoreMessages(Boolean(payload?.hasMore));
      setConversationMessages(conversationId, (prev) => {
        const existingIds = new Set(prev.map((item) => item.id));
        return [
          ...olderMessages.filter((item: MessageItem) => !existingIds.has(item.id)), 
          ...prev];
      });
      window.requestAnimationFrame(() => {
        const currentContainer = messagesScrollRef.current;
        if (!currentContainer) return;
        currentContainer.scrollTop = currentContainer.scrollHeight - previousScrollHeight + previousScrollTop;
      });
    } catch (error: any) {
      toast.error(error?.message || "Không thể tải tin nhắn cũ.");
    } finally {
      loadingOlderMessagesRef.current = false;
      setIsLoadingOlderMessages(false);
    }
  };

  const handleMessagesScroll = () => {
    const container = messagesScrollRef.current;
    if (!container || container.scrollTop > 120) return;
    if (hasMoreMessages && !isLoadingOlderMessages) {
      void loadOlderMessages();
    }
  };

  // ==================== SEND MESSAGE ====================
  const sendTextMessage = async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content || !selectedChat) return;
    setMessageInput("");
    setShowComposerEmojiPicker(false);
    setShowComposerTools(false);
    const selectedConversationId = selectedChat.id;
    const currentReply = replyingTo;
    setReplyingTo(null);
    const createdAt = new Date().toISOString();
    const opt: MessageItem = {
      id: `temp_${Date.now()}`,
      senderId: "me",
      text: content,
      time: formatVietnamTime(createdAt),
      createdAt,
      deliveryStatus: "sending",
      replyToMessageId: currentReply?.id,
    };
    setConversationMessages(selectedConversationId, (prev) => [...prev, opt]);
    setConversations((prev) => {
      const updated = [...prev];
      const idx = updated.findIndex((c) => c.id === selectedConversationId);
      if (idx > -1) { const conv = { ...updated[idx], lastMessage: `Bạn: ${content}`, time: opt.time }; updated.splice(idx, 1); updated.unshift(conv); }
      return dedupConversations(updated);
    });
    const payload = { conversationId: selectedConversationId.startsWith("new_") ? "" : selectedConversationId, receiverId: getConversationPeerId(selectedChat), content, messageType: "text", replyToMessageId: currentReply?.id };
    try {
      const saved = await api.sendChatMessage(payload);
      const savedConversationId = toId(saved?.conversationId) || selectedConversationId;
      const stillViewingConversation =
        toId(selectedChatIdRef.current) === selectedConversationId ||
        toId(selectedChatIdRef.current) === savedConversationId;

      if (selectedConversationId.startsWith("new_") && savedConversationId) {
        selectedChatIdRef.current = savedConversationId;
        setSelectedChatId(savedConversationId);
      }

      setConversations((prev) => {
        const updated = [...prev];
        const idx = updated.findIndex((conversation) =>
          toId(conversation.id) === selectedConversationId ||
          toId(conversation.id) === savedConversationId
        );
        if (idx < 0) return updated;
        const conversation = {
          ...updated[idx],
          id: savedConversationId,
          lastMessage: `Bạn: ${saved?.content || content}`,
          time: formatVietnamTime(saved?.createdAt || Date.now()),
        };
        updated.splice(idx, 1);
        updated.unshift(conversation);
        return dedupConversations(updated);
      });

      if (stillViewingConversation) {
        const acknowledged = mapMessageItem(saved);
        setConversationMessages(savedConversationId, (prev) => {
          const withoutTemporary = prev.filter((message) => message.id !== opt.id);
          return withoutTemporary.some((message) => message.id === acknowledged.id)
            ? withoutTemporary
            : [...withoutTemporary, acknowledged];
        });
      }
    } catch (error: any) {
      if (toId(selectedChatIdRef.current) === selectedConversationId) {
        setConversationMessages(selectedConversationId, (prev) => prev.filter((message) => message.id !== opt.id));
        setMessageInput((current) => current || content);
      }
      void loadChatsAndFriends({ force: true, silent: true });
      toast.error(error?.message || "Không thể gửi tin nhắn.");
    }
    if (stompClientRef.current?.connected) stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify({ ...payload, isTyping: false, typing: false }) });
  };

  const handleSendMessage = (event: FormEvent) => {
    event.preventDefault();
    void sendTextMessage(messageInput);
  };

  const handleEditMessage = async (message: MessageItem) => {
    if (message.senderId !== "me" || message.isDeleted || message.id.startsWith("temp_")) return;
    const content = window.prompt("Sửa tin nhắn", message.text);
    if (content === null) return;
    const nextContent = content.trim();
    if (!nextContent) return;
    try {
      const res = await api.editChatMessage(message.id, nextContent);
      const updated = res?.data || res || {};
      setConversationMessages(messagesConversationIdRef.current, (prev) => prev.map((item) => item.id === message.id ? { ...item, text: updated.content || nextContent, isEdited: true } : item));
    } catch (error: any) {
      toast.error(error?.message || "Không thể sửa tin nhắn.");
    }
  };

  const handleRecallMessage = async (message: MessageItem) => {
    if (message.senderId !== "me" || message.isDeleted || message.id.startsWith("temp_")) return;
    if (!window.confirm("Thu hồi tin nhắn này?")) return;
    try {
      await api.deleteChatMessage(message.id);
      setConversationMessages(messagesConversationIdRef.current, (prev) => prev.map((item) => item.id === message.id ? { ...item, text: "Tin nhắn đã được thu hồi", isDeleted: true } : item));
    } catch (error: any) {
      toast.error(error?.message || "Không thể thu hồi tin nhắn.");
    }
  };

  const handleCopyMessage = async (message: MessageItem) => {
    try {
      await navigator.clipboard.writeText(message.text || message.attachmentUrl || "");
      toast.success("Đã copy tin nhắn.");
    } catch {
      toast.error("Không thể copy tin nhắn.");
    }
  };

  const sendAttachmentMessage = async (file: File) => {
    if (!selectedChat) return;
    setIsUploadingAttachment(true);
    setShowComposerTools(false);
    try {
      const uploaded = await api.uploadFile(file);
      const isImage = String(uploaded.type || file.type).startsWith("image/");
      const isAudio = String(uploaded.type || file.type).startsWith("audio/");
      const payload = {
        conversationId: selectedChat.id.startsWith("new_") ? "" : selectedChat.id,
        receiverId: getConversationPeerId(selectedChat),
        content: isImage
          ? "Đã gửi một hình ảnh"
          : isAudio
            ? "Đã gửi một tin nhắn thoại"
            : `Đã gửi tệp: ${uploaded.name || file.name}`,
        messageType: isImage ? "image" : "text",
        attachmentUrl: uploaded.url,
        attachmentName: uploaded.name || file.name,
        attachmentSize: uploaded.size || file.size,
      };
      const saved = await api.sendChatMessage(payload);
      const savedConversationId = toId(saved?.conversationId) || selectedChat.id;
      if (toId(selectedChatIdRef.current) === selectedChat.id || toId(selectedChatIdRef.current) === savedConversationId) {
        if (selectedChat.id.startsWith("new_") && savedConversationId) {
          selectedChatIdRef.current = savedConversationId;
          setSelectedChatId(savedConversationId);
        }
        const acknowledged = mapMessageItem(saved);
        setConversationMessages(savedConversationId, (prev) =>
          prev.some((message) => message.id === acknowledged.id)
            ? prev
            : [...prev, acknowledged]
        );
      }
    } catch (error: any) {
      toast.error(error?.message || "Không thể gửi file.");
    } finally {
      setIsUploadingAttachment(false);
    }
  };

  const handleAttachmentChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void sendAttachmentMessage(file);
  };

  const handleComposerEmoji = (emoji: string) => {
    setMessageInput((current) => `${current}${emoji}`);
    window.requestAnimationFrame(() => messageInputRef.current?.focus());
  };

  const scrollToRepliedMessage = (messageId?: string) => {
    if (!messageId) return;
    const target = document.getElementById(`message-${messageId}`);
    if (!target) {
      toast.info("Tin nhắn gốc nằm trong phần lịch sử cũ hơn.");
      return;
    }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(messageId);
    window.setTimeout(() => setHighlightedMessageId((current) => current === messageId ? null : current), 1600);
  };

  const toggleAudioRecording = async () => {
    if (isRecordingAudio) {
      audioRecorderRef.current?.stop();
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      toast.error("Trình duyệt này chưa hỗ trợ ghi âm.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioStreamRef.current = stream;
      audioRecorderRef.current = recorder;
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const extension = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioStreamRef.current?.getTracks().forEach((track) => track.stop());
        audioStreamRef.current = null;
        audioRecorderRef.current = null;
        audioChunksRef.current = [];
        setIsRecordingAudio(false);
        if (blob.size > 0) {
          void sendAttachmentMessage(new File([blob], `ghi-am-${Date.now()}.${extension}`, { type: mimeType }));
        }
      };
      recorder.start();
      setShowComposerTools(false);
      setShowComposerEmojiPicker(false);
      setIsRecordingAudio(true);
    } catch {
      toast.error("Không thể mở micro. Hãy kiểm tra quyền truy cập micro.");
    }
  };

  const handleChatBackgroundChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Chỉ chọn ảnh làm nền hội thoại.");
      return;
    }
    try {
      const uploaded = await api.uploadFile(file);
      if (uploaded?.url) await updateCustomChatBackground(uploaded.url);
    } catch (error: any) {
      toast.error(error?.message || "Không thể tải ảnh nền.");
    }
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
    if (stompClientRef.current?.connected && selectedChat) {
      const payload = { conversationId: selectedChat.id.startsWith("new_") ? "" : selectedChat.id, receiverId: getConversationPeerId(selectedChat), isTyping: true, typing: true };
      stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify(payload) });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => {
        stompClientRef.current?.connected && stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify({ ...payload, isTyping: false, typing: false }) });
      }, 2000);
    }
  };

  const handleComposerFocus = () => {
    window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: "end" }), 120);
    window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: "end" }), 360);
  };

  const openSelectedProfile = () => {
    const peerId = selectedChat ? getConversationPeerId(selectedChat) : "";
    if (!peerId) return;
    navigate(`/nguoi-dung/${peerId}`);
  };

  const handleCreateGroup = async () => {
    const memberIds = Array.from(new Set(groupMemberIds.filter(Boolean)));
    if (memberIds.length < 2) {
      toast.error("Chọn ít nhất 2 người để tạo nhóm.");
      return;
    }
    try {
      const res = await api.createChatConversation({
        type: "group",
        groupName: groupName.trim() || "Nhóm chat",
        memberIds,
      });
      const item = res?.data || res;
      const nextChat: ConversationItem = {
        id: toId(item.id),
        type: "group",
        name: item.groupName || groupName.trim() || "Nhóm chat",
        lastMessage: item.lastMessage || "Bắt đầu cuộc trò chuyện nhóm.",
        time: item.lastMessageTime ? formatVietnamTime(item.lastMessageTime) : "",
        unread: 0,
        status: "accepted",
        memberCount: item.memberCount,
        backgroundId: item.backgroundId || undefined,
        backgroundUrl: item.backgroundUrl || undefined,
      };
      setConversations((prev) => dedupConversations([nextChat, ...prev]));
      setConversationMessages(nextChat.id, []);
      setSelectedChatId(nextChat.id);
      setShowCreateGroup(false);
      setGroupName("");
      setGroupMemberIds([]);
      toast.success("Đã tạo nhóm chat.");
    } catch (error: any) {
      toast.error(error?.message || "Không thể tạo nhóm chat.");
    }
  };

  const handleSelectChat = (chat: ConversationItem) => {
    const nextId = toId(chat.id);
    if (!nextId) return;
    setSelectedChatId(nextId);
    setShowInfo(false);
  };

  useEffect(() => {
    const root = document.documentElement;
    let raf = 0;

    const updateVisualHeight = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => {
        const height = Math.round(window.visualViewport?.height || window.innerHeight);
        root.style.setProperty("--app-visual-height", `${height}px`);
      });
    };

    updateVisualHeight();

    window.visualViewport?.addEventListener("resize", updateVisualHeight);
    window.addEventListener("resize", updateVisualHeight);
    window.addEventListener("orientationchange", updateVisualHeight);

    return () => {
      window.cancelAnimationFrame(raf);
      root.style.removeProperty("--app-visual-height");
      window.visualViewport?.removeEventListener("resize", updateVisualHeight);
      window.removeEventListener("resize", updateVisualHeight);
      window.removeEventListener("orientationchange", updateVisualHeight);
    };
  }, []);

  // ==================== COMPUTED ====================
  const isSearchMode = userSearchQuery.trim().length > 0;
  const inboxConvs = conversations.filter((c) => c.status === "accepted");
  const pendingConvs = conversations.filter((c) => c.status === "pending");
  const totalUnread = inboxConvs.reduce((s, c) => s + (c.unread || 0), 0);
  const onlineConversations = inboxConvs.filter((c) => c.isOnline).slice(0, 6);

  const displayList: ConversationItem[] = isSearchMode
    ? searchResults.map((u) => ({ id: `new_${toId(u.id)}`, targetUserId: toId(u.id), name: u.name, avatar: u.avatar, lastMessage: "Nhắn để mở cuộc trò chuyện ngay.", time: "", unread: 0, isOnline: Boolean(u.isOnline), status: "accepted" }))
    : chatFilter === "all" ? conversations
    : chatFilter === "unread" ? conversations.filter((c) => (c.unread || 0) > 0)
    : chatFilter === "pending" ? pendingConvs
    : conversations;

  const selectedPeerId = selectedChat ? getConversationPeerId(selectedChat) : "";
  const isSelectedTyping = selectedChat ? Boolean(typingUsers[selectedChat.id] || (selectedPeerId && typingUsers[`new_${selectedPeerId}`])) : false;
  const selectedStatus = isSelectedTyping ? "Đang soạn tin nhắn..." : selectedChat?.isOnline ? "Đang hoạt động" : "Ngoại tuyến";

  // ==================== RENDER ====================
  return (
    <div
      className={`messages-shell${selectedChat ? " has-selected-chat" : ""}`}
      style={{ display: "flex", height: "100%", minHeight: 0, overflow: "hidden" }}
    >
      {/* ── CHAT LIST PANEL ── */}
      <div
        className="chat-list-panel"
        style={{
          width: 320, minWidth: 260, maxWidth: 360, background: "#fff",
          borderRight: "1px solid #f0f0f0",
          display: "flex", flexDirection: "column", height: "100%", minHeight: 0,
        }}
      >
        {/* Header */}
        <div className="chat-list-header" style={{ padding: "16px 16px 0", flexShrink: 0 }}>
          <div className="chat-list-title-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
            <div>
              <span className="chat-list-eyebrow">Workspace</span>
              <h1 style={{ fontSize: 20, fontWeight: 700, color: "#1a1a1a", margin: 0 }}>Tin nhắn</h1>
            </div>
            <div className="chat-list-actions" style={{ display: "flex", gap: 6 }}>
              {/* Plus button */}
              <button type="button" onClick={() => setShowCreateGroup(true)} className="chat-icon-button chat-icon-button-primary" style={{
                width: 34, height: 34, borderRadius: 10,
                border: "none", background: ORANGE, cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#fff",
                boxShadow: `0 2px 8px ${ORANGE}50`,
              }}>
                <Plus size={16} />
              </button>
              <button type="button" className="chat-icon-button" style={{
                width: 34, height: 34, borderRadius: 10,
                border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#b0b0b0",
              }}>
                <Bell size={16} />
              </button>
              <button type="button" className="chat-icon-button" style={{
                width: 34, height: 34, borderRadius: 10,
                border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer",
                display: "flex", alignItems: "center", justifyContent: "center", color: "#b0b0b0",
              }}>
                <MoreHorizontal size={16} />
              </button>
            </div>
          </div>

          <div className="chat-inbox-summary">
            <div className="chat-inbox-summary-icon">
              <Sparkles size={17} />
            </div>
            <div className="chat-inbox-summary-copy">
              <strong>{totalUnread > 0 ? `${totalUnread} tin chưa đọc` : "Hộp thư đã cập nhật"}</strong>
              <span>{onlineConversations.length} người đang hoạt động</span>
            </div>
            <span className="chat-live-indicator"><Wifi size={12} /> Live</span>
          </div>

          {/* Search */}
          <div className="chat-search" style={{ position: "relative", marginBottom: 12 }}>
            <Search size={15} style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", color: "#b0b0b0" }} />
            <input
              type="text"
              placeholder="Tìm người dùng để nhắn tin..."
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              style={{
                width: "100%", height: 38, borderRadius: 10,
                border: "1px solid #f0f0f0", paddingLeft: 36, paddingRight: 12,
                fontSize: 14, outline: "none", boxSizing: "border-box",
                background: "#f8f8f8", color: "#1a1a1a",
              }}
            />
          </div>

          {/* Filter tabs */}
          <div className="chat-filter-tabs" style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            {[
              { label: "Tất cả", value: "all" },
              { label: `Chưa đọc${totalUnread > 0 ? ` (${totalUnread})` : ""}`, value: "unread" },
              { label: `Chờ (${pendingConvs.length})`, value: "pending" },
            ].map((tab) => (
              <button
                key={tab.value}
                type="button"
                onClick={() => setChatFilter(tab.value as any)}
                className="chat-filter-button"
                data-active={chatFilter === tab.value ? "true" : "false"}
                style={{
                  padding: "5px 12px", borderRadius: 20, border: "none", cursor: "pointer",
                  fontSize: 12, fontWeight: 600,
                  background: chatFilter === tab.value ? ORANGE : "#f0f0f0",
                  color: chatFilter === tab.value ? "#fff" : "#888",
                  transition: "all 0.15s",
                  boxShadow: chatFilter === tab.value ? `0 2px 8px ${ORANGE}40` : "none",
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {!isSearchMode && onlineConversations.length > 0 && (
            <div className="chat-online-section">
              <div className="chat-online-heading">
                <span>Đang hoạt động</span>
                <small>{onlineConversations.length}</small>
              </div>
              <div className="chat-online-list">
                {onlineConversations.map((chat) => (
                  <button
                    key={`online:${chat.id}`}
                    type="button"
                    className="chat-online-person"
                    title={chat.name}
                    onClick={() => handleSelectChat(chat)}
                  >
                    <span className="chat-online-avatar">
                      <CachedImage src={getAvatarUrl(chat.avatar, chat.targetUserId || chat.id)} alt="" />
                      <i />
                    </span>
                    <span>{chat.name.split(" ").slice(-1)[0]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Conversation List */}
        <div className="conversation-list" style={{ flex: 1, overflowY: "auto", padding: "4px 8px" }}>
          {isLoadingChats || isSearching ? (
            <div className="conversation-skeleton-list" aria-label="Đang tải hội thoại">
              {Array.from({ length: 6 }).map((_, index) => (
                <div className="conversation-skeleton" key={index}>
                  <span className="conversation-skeleton-avatar" />
                  <span className="conversation-skeleton-copy"><i /><i /></span>
                </div>
              ))}
            </div>
          ) : displayList.length === 0 ? (
            <div style={{ textAlign: "center", padding: "48px 16px", color: "#b0b0b0" }}>
              <Inbox size={40} style={{ margin: "0 auto 12px", opacity: 0.4 }} />
              <div style={{ fontSize: 14 }}>
                {isSearchMode ? "Không tìm thấy kết quả" : chatFilter === "pending" ? "Không có tin nhắn chờ" : "Chưa có hội thoại nào"}
              </div>
            </div>
          ) : (
            displayList.map((chat) => {
              const isActive = selectedChat?.id === chat.id;
              const avatar = getAvatarUrl(chat.avatar, chat.targetUserId || chat.id);
              const isTyping = Boolean(typingUsers[chat.id]);
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => handleSelectChat(chat)}
                  className="conversation-item"
                  data-active={isActive ? "true" : "false"}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 10,
                    padding: "9px 10px", borderRadius: 12, border: "none", cursor: "pointer", textAlign: "left",
                    background: isActive ? ORANGE_LIGHT : "transparent",
                    transition: "background 0.15s", boxSizing: "border-box",
                  }}
                >
                  <div className="conversation-avatar" style={{ position: "relative", flexShrink: 0 }}>
                    <CachedImage src={avatar} alt={chat.name} style={{ width: 48, height: 48, borderRadius: 14, objectFit: "cover" }} />
                    {chat.isOnline && chat.status !== "pending" && (
                      <span style={{ position: "absolute", bottom: 1, right: 1, width: 11, height: 11, borderRadius: "50%", background: "#22c55e", border: "2px solid #fff" }} />
                    )}
                    {chat.status === "pending" && (
                      <span style={{ position: "absolute", bottom: 1, right: 1, width: 11, height: 11, borderRadius: "50%", background: "#f59e0b", border: "2px solid #fff" }} />
                    )}
                  </div>
                  <div className="conversation-copy" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                      <div className="conversation-name" style={{ fontSize: 14, fontWeight: 600, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 140 }}>{chat.name}</div>
                      <div className="conversation-time" style={{ fontSize: 11, color: "#b0b0b0", whiteSpace: "nowrap", marginLeft: 4 }}>{chat.time}</div>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 2 }}>
                      <div className="conversation-preview" style={{ fontSize: 12, color: isTyping ? ORANGE : "#9ca3af", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 160, fontStyle: isTyping ? "italic" : "normal" }}>
                        {isTyping ? "Đang nhập..." : chat.status === "pending" ? "📨 Tin nhắn chờ phê duyệt" : (chat.lastMessage || "")}
                      </div>
                      {(chat.unread || 0) > 0 && (
                        <span className="conversation-unread" style={{ background: ORANGE, color: "#fff", fontSize: 11, fontWeight: 700, borderRadius: 10, padding: "1px 7px", minWidth: 20, textAlign: "center", flexShrink: 0 }}>{chat.unread}</span>
                      )}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>

      {/* ── MAIN CHAT AREA ── */}
      <div className="chat-thread-panel" style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100%", minHeight: 0 }}>
        {selectedChat ? (
          <>
            {/* Chat Header */}
            <div className="chat-thread-header" style={{ height: 60, background: "#fff", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", padding: "0 16px", gap: 10, flexShrink: 0 }}>
              <button
                type="button"
                onClick={() => { setConversationMessages(null, []); setSelectedChatId(null); }}
                className="mobile-back-btn chat-icon-button"
                style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: ORANGE }}
              >
                <ChevronLeft size={18} />
              </button>
              <div className="chat-thread-avatar" style={{ position: "relative" }}>
                <CachedImage src={selectedChatAvatar} alt={selectedChat.name} style={{ width: 42, height: 42, borderRadius: 13, objectFit: "cover" }} />
                {selectedChat.isOnline && <span style={{ position: "absolute", bottom: 1, right: 1, width: 10, height: 10, borderRadius: "50%", background: "#22c55e", border: "2px solid #fff" }} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{selectedChat.name}</div>
                <div className="chat-presence-label" data-online={selectedChat.isOnline || isSelectedTyping ? "true" : "false"} style={{ fontSize: 12, color: selectedChat.status === "pending" ? "#f59e0b" : isSelectedTyping ? ORANGE : "#22c55e" }}>
                  <span />
                  {selectedChat.status === "pending" ? "⏳ Chờ phê duyệt" : selectedStatus}
                </div>
              </div>
              <div className="chat-header-actions" style={{ display: "flex", gap: 6 }}>
                <button type="button" className="chat-icon-button" onClick={() => startCall("audio")} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: ORANGE }}><Phone size={16} /></button>
                <button type="button" className="chat-icon-button" onClick={() => startCall("video")} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: ORANGE }}><Video size={16} /></button>
                <button type="button" className="chat-icon-button" data-active={showInfo ? "true" : "false"} onClick={() => setShowInfo((p) => !p)} style={{ width: 34, height: 34, borderRadius: 10, border: "1px solid #f0f0f0", background: showInfo ? ORANGE_LIGHT : "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: ORANGE }}><Info size={16} /></button>
              </div>
            </div>

            <div className="chat-workspace" style={{ flex: 1, display: "flex", minHeight: 0 }}>
              {/* Messages */}
              <div
                className="chat-message-stage"
                data-custom-background={normalizedCustomChatBackground ? "true" : "false"}
                style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, background: selectedChatBackgroundValue }}
              >
                <div
                  ref={messagesScrollRef}
                  className="messages-scroll-area"
                  onScroll={handleMessagesScroll}
                  style={{ flex: 1, overflowY: "auto", padding: "16px 16px 0" }}
                >
                  {isLoadingMessages && messages.length === 0 ? (
                    <div className="message-loading-state" aria-label="Đang tải tin nhắn">
                      <span className="message-loading-bubble left" />
                      <span className="message-loading-bubble right" />
                      <span className="message-loading-bubble left short" />
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="chat-empty-state" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: 12, color: "#b0b0b0", textAlign: "center", padding: 24 }}>
                      <CachedImage src={selectedChatAvatar} alt="" style={{ width: 72, height: 72, borderRadius: 22, objectFit: "cover", marginBottom: 8, border: `3px solid rgba(109, 93, 252, 0.12)` }} />
                      <div style={{ fontSize: 17, fontWeight: 700, color: "#1a1a1a" }}>{selectedChat.name}</div>
                      <div style={{ fontSize: 13, color: "#b0b0b0", maxWidth: 280 }}>Hãy nhắn tin trước để bắt đầu!</div>
                    </div>
                  ) : (
                    <div className="message-stream" style={{ display: "flex", flexDirection: "column", gap: 2, maxWidth: 720, width: "100%", margin: "0 auto" }}>
                      {hasMoreMessages && (
                        <div style={{ display: "flex", justifyContent: "center", padding: "2px 0 10px" }}>
                          <button type="button" onClick={loadOlderMessages} disabled={isLoadingOlderMessages} style={{ height: 32, padding: "0 14px", borderRadius: 16, border: "1px solid #e2e8f0", background: "#fff", color: ORANGE, fontSize: 12, fontWeight: 800, cursor: isLoadingOlderMessages ? "wait" : "pointer", boxShadow: "0 2px 8px rgba(15,23,42,0.06)", display: "inline-flex", alignItems: "center", gap: 6 }}>
                            {isLoadingOlderMessages && <Loader2 size={13} style={{ animation: "spin 1s linear infinite" }} />}
                            Tải tin nhắn cũ hơn
                          </button>
                        </div>
                      )}
                      {messages.map((msg, idx) => {
                        const isMe = msg.senderId === "me";
                        const showAvatar = !isMe && (idx === messages.length - 1 || messages[idx + 1]?.senderId !== msg.senderId);
                        const isGroupChat = selectedChat?.type === "group";
                        const repliedMessage = msg.replyToMessageId ? messages.find((item) => item.id === msg.replyToMessageId) : null;
                        const previousSameSender = idx > 0 && messages[idx - 1]?.senderId === msg.senderId;
                        const nextSameSender = idx < messages.length - 1 && messages[idx + 1]?.senderId === msg.senderId;
                        const hasReply = Boolean(msg.replyToMessageId);
                        const isTemporary = msg.id.startsWith("temp_");
                        const attachmentIsAudio = Boolean(msg.attachmentUrl && isAudioAttachment(msg));
                        const isGeneratedAttachmentCaption = Boolean(
                          msg.attachmentUrl && (
                            msg.text === "Đã gửi một hình ảnh" ||
                            msg.text === "Đã gửi một tin nhắn thoại" ||
                            msg.text.startsWith("Đã gửi tệp:")
                          )
                        );
                        const visibleReactions = Object.entries(msg.reactions || {}).filter(([, count]) => count > 0);
                        const totalReactions = visibleReactions.reduce((total, [, count]) => total + count, 0);
                        const hasMyReaction = Object.values(msg.userReactions || {}).some(Boolean);
                        const isLatestOwnMessage = isMe && !messages.slice(idx + 1).some((item) => item.senderId === "me");
                        const showDateDivider = idx === 0 || getMessageDateKey(messages[idx - 1]?.createdAt) !== getMessageDateKey(msg.createdAt);
                        const replyTargetName = repliedMessage?.senderId === "me"
                          ? "bạn"
                          : (repliedMessage?.senderName || selectedChat.name);
                        const replyAuthor = repliedMessage?.senderId === "me"
                          ? "Bạn"
                          : (repliedMessage?.senderName || selectedChat.name);
                        return (
                          <div className="message-entry" key={getMessageRenderKey(msg, idx)}>
                            {showDateDivider && msg.createdAt && (
                              <div className="message-date-divider"><span>{formatMessageDateLabel(msg.createdAt)}</span></div>
                            )}
                            <div
                              id={`message-${msg.id}`}
                              className="message-row"
                              data-side={isMe ? "right" : "left"}
                              data-highlighted={highlightedMessageId === msg.id ? "true" : "false"}
                              data-group-start={!previousSameSender ? "true" : "false"}
                              data-group-end={!nextSameSender ? "true" : "false"}
                              style={{ display: "flex", justifyContent: isMe ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 8, position: "relative", marginTop: previousSameSender ? 1 : 7 }}
                              onMouseEnter={() => !msg.isDeleted && setHoveredMessageId(msg.id)}
                              onMouseLeave={() => setHoveredMessageId((current) => current === msg.id ? null : current)}
                            >
                              {!isMe && (
                                <div className="message-avatar-slot">
                                  {showAvatar
                                    ? <CachedImage className="message-avatar" src={selectedChatAvatar} alt="" />
                                    : <div className="message-avatar-spacer" />}
                                </div>
                              )}
                              <div
                                className="message-bubble-group"
                                data-side={isMe ? "right" : "left"}
                                data-has-reply={hasReply ? "true" : "false"}
                              >
                                {!isMe && isGroupChat && msg.senderName && (
                                  <div className="message-sender-name">{msg.senderName}</div>
                                )}

                                {hasReply && (
                                  <div className="message-reply-context" data-side={isMe ? "right" : "left"}>
                                    <Reply size={12} />
                                    <span>{isMe ? `Bạn đã trả lời ${replyTargetName}` : `${msg.senderName || selectedChat.name} đã trả lời`}</span>
                                  </div>
                                )}

                                <div className="message-bubble-stack" data-side={isMe ? "right" : "left"} data-has-reply={hasReply ? "true" : "false"}>
                                  {hasReply && (
                                    <button
                                      type="button"
                                      className="message-reply-quote"
                                      data-side={isMe ? "right" : "left"}
                                      onClick={() => scrollToRepliedMessage(msg.replyToMessageId)}
                                      title="Đi tới tin nhắn gốc"
                                    >
                                      <span className="message-reply-author">{replyAuthor}</span>
                                      <span className="message-reply-text">{repliedMessage?.text || "Tin nhắn gốc"}</span>
                                    </button>
                                  )}

                                  <div
                                    className="message-bubble"
                                    data-side={isMe ? "right" : "left"}
                                    data-deleted={msg.isDeleted ? "true" : "false"}
                                    onContextMenu={(event) => {
                                      event.preventDefault();
                                      setShowReactionPicker(null);
                                      if (!msg.isDeleted) setActiveMessageMenu(activeMessageMenu === msg.id ? null : msg.id);
                                    }}
                                    onDoubleClick={() => {
                                      if (!msg.isDeleted && !isTemporary) handleToggleReaction(msg.id, "❤️");
                                    }}
                                    onClick={() => {
                                      if (!msg.isDeleted) setHoveredMessageId(msg.id);
                                    }}
                                  >
                                    {msg.attachmentUrl && !msg.isDeleted && (
                                      String(msg.messageType).toLowerCase() === "image" ? (
                                        <CachedImage className="message-image-attachment" src={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} alt={msg.attachmentName || ""} />
                                      ) : attachmentIsAudio ? (
                                        <div className="message-audio-attachment">
                                          <Mic size={16} />
                                          <audio controls preload="metadata" src={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} />
                                        </div>
                                      ) : (
                                        <a className="message-file-attachment" href={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} target="_blank" rel="noreferrer">
                                          <FileText size={18} />
                                          <span>{msg.attachmentName || "Tệp đính kèm"}</span>
                                        </a>
                                      )
                                    )}
                                    {msg.text && !isGeneratedAttachmentCaption && <span className="message-text-content">{msg.text}</span>}
                                  </div>

                                  {visibleReactions.length > 0 && (
                                    <button
                                      type="button"
                                      className="message-reaction-summary"
                                      data-side={isMe ? "right" : "left"}
                                      data-active={hasMyReaction ? "true" : "false"}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setActiveMessageMenu(null);
                                        setShowReactionPicker(showReactionPicker === msg.id ? null : msg.id);
                                      }}
                                      title="Xem hoặc đổi cảm xúc"
                                    >
                                      <span className="message-reaction-icons">
                                        {visibleReactions.slice(0, 3).map(([emoji]) => <span key={`${msg.id}:summary:${emoji}`}>{emoji}</span>)}
                                      </span>
                                      {totalReactions > 1 && <span className="message-reaction-count">{totalReactions}</span>}
                                    </button>
                                  )}
                                </div>

                                <div className="message-meta" data-side={isMe ? "right" : "left"}>
                                  <span>{msg.time}{msg.isEdited && !msg.isDeleted ? " · đã sửa" : ""}</span>
                                  {isLatestOwnMessage && (
                                    <span className="message-delivery-status">{msg.deliveryStatus === "sending" ? "Đang gửi..." : "Đã gửi"}</span>
                                  )}
                                </div>

                                {!msg.isDeleted && (
                                  <div className="message-action-row" data-side={isMe ? "right" : "left"} data-active={hoveredMessageId === msg.id || activeMessageMenu === msg.id || showReactionPicker === msg.id ? "true" : "false"}>
                                    {!isTemporary && (
                                      <button type="button" className="message-action-button" title="Thả cảm xúc" onClick={(event) => { event.stopPropagation(); setActiveMessageMenu(null); setShowReactionPicker(showReactionPicker === msg.id ? null : msg.id); }}><Smile size={15} /></button>
                                    )}
                                    <button type="button" className="message-action-button" title="Trả lời" onClick={() => { setReplyingTo(msg); setActiveMessageMenu(null); setShowReactionPicker(null); window.requestAnimationFrame(() => messageInputRef.current?.focus()); }}><Reply size={15} /></button>
                                    <button type="button" className="message-action-button" title="Thêm" onClick={(event) => { event.stopPropagation(); setShowReactionPicker(null); setActiveMessageMenu(activeMessageMenu === msg.id ? null : msg.id); }}><MoreHorizontal size={16} /></button>
                                  </div>
                                )}

                                {activeMessageMenu === msg.id && !msg.isDeleted && (
                                  <div className="message-context-menu" data-side={isMe ? "right" : "left"}>
                                    <button type="button" onClick={() => { setActiveMessageMenu(null); handleCopyMessage(msg); }}><Copy size={14} /> Sao chép</button>
                                    <button type="button" onClick={() => { setActiveMessageMenu(null); setReplyingTo(msg); window.requestAnimationFrame(() => messageInputRef.current?.focus()); }}><Reply size={14} /> Trả lời</button>
                                    {isMe && !isTemporary && (
                                      <>
                                        <button type="button" onClick={() => { setActiveMessageMenu(null); handleEditMessage(msg); }}><Pencil size={14} /> Sửa tin nhắn</button>
                                        <button type="button" className="danger" onClick={() => { setActiveMessageMenu(null); handleRecallMessage(msg); }}><Trash2 size={14} /> Thu hồi</button>
                                      </>
                                    )}
                                  </div>
                                )}

                                {showReactionPicker === msg.id && !msg.isDeleted && !isTemporary && (
                                  <div className="message-reaction-picker" data-side={isMe ? "right" : "left"}>
                                    {REACTION_EMOJIS.slice(0, 6).map((emoji) => (
                                      <button
                                        key={`${msg.id}:${emoji}`}
                                        type="button"
                                        data-active={msg.userReactions?.[emoji] ? "true" : "false"}
                                        onClick={() => { handleToggleReaction(msg.id, emoji); setShowReactionPicker(null); }}
                                        className="message-reaction-option"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                      {isSelectedTyping && (
                        <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
                          <CachedImage src={selectedChatAvatar} alt="" style={{ width: 32, height: 32, borderRadius: 10, objectFit: "cover" }} />
                          <div style={{ background: "rgba(255,255,255,0.92)", borderRadius: "18px 18px 18px 4px", padding: "12px 16px", display: "flex", gap: 4, boxShadow: "0 8px 24px rgba(45,40,89,0.06)", backdropFilter: "blur(16px)" }}>
                            {[0, 0.15, 0.3].map((delay, i) => (
                              <span key={i} style={{ width: 8, height: 8, borderRadius: "50%", background: "#7c6df5", display: "block", animation: `bounce 1s ${delay}s infinite` }} />
                            ))}
                          </div>
                        </div>
                      )}
                      <div ref={messagesEndRef} style={{ height: 8 }} />
                    </div>
                  )}
                </div>

                {/* Input area */}
                {selectedChat.status === "pending" ? (
                  <div style={{ padding: 16, background: "#fff", borderTop: "1px solid #f0f0f0", flexShrink: 0 }}>
                    <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 16, padding: 16, textAlign: "center" }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
                        <ShieldAlert size={18} color="#f59e0b" />
                        <span style={{ fontWeight: 600, color: "#92400e", fontSize: 14 }}>Tin nhắn chờ phê duyệt</span>
                      </div>
                      <p style={{ fontSize: 13, color: "#78350f", marginBottom: 12, lineHeight: 1.5 }}>
                        <strong>{selectedChat.name}</strong> muốn nhắn tin với bạn.
                      </p>
                      <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                        <button type="button" onClick={handleRejectRequest}
                          style={{ padding: "8px 20px", borderRadius: 10, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
                          ✕ Từ chối
                        </button>
                        <button type="button" onClick={handleAcceptRequest} disabled={isAcceptingRequest}
                          style={{ padding: "8px 20px", borderRadius: 10, border: "none", background: ORANGE, color: "#fff", cursor: isAcceptingRequest ? "not-allowed" : "pointer", fontSize: 14, fontWeight: 600, display: "flex", alignItems: "center", gap: 6, opacity: isAcceptingRequest ? 0.7 : 1, boxShadow: `0 2px 8px ${ORANGE}50` }}>
                          {isAcceptingRequest ? <Loader2 size={14} style={{ animation: "spin 1s linear infinite" }} /> : <Check size={14} />}
                          Chấp nhận
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="message-composer" data-recording={isRecordingAudio ? "true" : "false"}>
                    {replyingTo && (
                      <div className="message-reply-preview">
                        <span className="message-reply-preview-line" />
                        <div className="message-reply-preview-copy">
                          <div>Đang trả lời {replyingTo.senderId === "me" ? "chính bạn" : (replyingTo.senderName || selectedChat.name)}</div>
                          <span>{replyingTo.text}</span>
                        </div>
                        <button type="button" className="message-reply-close" onClick={() => setReplyingTo(null)} aria-label="Hủy trả lời"><X size={16} /></button>
                      </div>
                    )}

                    <input ref={attachmentInputRef} type="file" className="hidden" onChange={handleAttachmentChange} />
                    <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleAttachmentChange} />
                    <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleAttachmentChange} />

                    {showComposerTools && (
                      <div className="composer-tools-popover">
                        <button type="button" onClick={() => attachmentInputRef.current?.click()}><FileText size={17} /><span>Gửi tệp</span></button>
                        <button type="button" onClick={() => imageInputRef.current?.click()}><ImageIcon size={17} /><span>Ảnh</span></button>
                        <button type="button" onClick={() => cameraInputRef.current?.click()}><Camera size={17} /><span>Camera</span></button>
                        <button type="button" onClick={() => startCall("video")}><Video size={17} /><span>Video call</span></button>
                      </div>
                    )}

                    {showComposerEmojiPicker && (
                      <div className="composer-emoji-picker">
                        {COMPOSER_EMOJIS.map((emoji) => (
                          <button key={emoji} type="button" onClick={() => handleComposerEmoji(emoji)}>{emoji}</button>
                        ))}
                      </div>
                    )}

                    {isRecordingAudio && (
                      <div className="composer-recording-banner">
                        <span className="composer-recording-dot" />
                        <span>Đang ghi âm...</span>
                        <button type="button" onClick={toggleAudioRecording}>Dừng và gửi</button>
                      </div>
                    )}

                    <form className="message-composer-form" onSubmit={handleSendMessage}>
                      <div className="composer-primary-actions">
                        <button
                          type="button"
                          className="composer-action-button"
                          data-active={showComposerTools ? "true" : "false"}
                          onClick={() => { setShowComposerTools((current) => !current); setShowComposerEmojiPicker(false); }}
                          aria-label="Thêm nội dung"
                        >
                          {isUploadingAttachment ? <Loader2 size={19} className="spin" /> : <Plus size={20} />}
                        </button>
                        <button type="button" className="composer-action-button" onClick={() => cameraInputRef.current?.click()} aria-label="Chụp ảnh"><Camera size={19} /></button>
                        <button type="button" className="composer-action-button" onClick={() => imageInputRef.current?.click()} aria-label="Gửi ảnh"><ImageIcon size={19} /></button>
                        <button type="button" className="composer-action-button" data-active={isRecordingAudio ? "true" : "false"} onClick={toggleAudioRecording} aria-label={isRecordingAudio ? "Dừng ghi âm" : "Ghi âm"}>
                          {isRecordingAudio ? <MicOff size={19} /> : <Mic size={19} />}
                        </button>
                      </div>

                      <div className="message-composer-input">
                        <input
                          ref={messageInputRef}
                          type="text"
                          value={messageInput}
                          onChange={handleInputChange}
                          onFocus={() => { handleComposerFocus(); setShowComposerTools(false); }}
                          placeholder="Aa"
                        />
                        <button
                          type="button"
                          className="composer-emoji-button"
                          data-active={showComposerEmojiPicker ? "true" : "false"}
                          onClick={() => { setShowComposerEmojiPicker((current) => !current); setShowComposerTools(false); }}
                          aria-label="Chọn biểu tượng cảm xúc"
                        >
                          <Smile size={20} />
                        </button>
                      </div>

                      {messageInput.trim() ? (
                        <button type="submit" className="composer-send-button" aria-label="Gửi tin nhắn"><Send size={19} /></button>
                      ) : (
                        <button type="button" className="composer-like-button" onClick={() => void sendTextMessage("👍")} aria-label="Gửi lượt thích"><ThumbsUp size={22} /></button>
                      )}
                    </form>
                  </div>
                )}
              </div>

              {/* ── INFO PANEL ── */}
              {showInfo && (
                <div className="chat-info-panel" style={{ width: 272, minWidth: 250, borderLeft: "1px solid #f0f0f0", background: "#fff", display: "flex", flexDirection: "column", height: "100%", flexShrink: 0 }}>
                  <div className="chat-info-header" style={{ padding: "14px 14px 0", flexShrink: 0 }}>
                    <div className="chat-info-title-row" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 14, color: "#1a1a1a" }}>Thông tin hội thoại</span>
                      <button type="button" className="chat-icon-button" onClick={() => setShowInfo(false)} style={{ width: 30, height: 30, borderRadius: 8, border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", color: "#b0b0b0" }}><X size={14} /></button>
                    </div>
                    <div className="chat-info-tabs" style={{ display: "flex", gap: 0, background: "#f3f4f6", borderRadius: 10, padding: 3 }}>
                      {[{ label: "Thông tin", value: "info" }, { label: "Đoạn chat", value: "chat" }].map((tab) => (
                        <button key={tab.value} type="button" onClick={() => setInfoTab(tab.value as any)}
                          className="chat-info-tab"
                          data-active={infoTab === tab.value ? "true" : "false"}
                          style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, background: infoTab === tab.value ? "#fff" : "transparent", color: infoTab === tab.value ? ORANGE : "#9ca3af", boxShadow: infoTab === tab.value ? "0 1px 4px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s" }}
                        >{tab.label}</button>
                      ))}
                    </div>
                  </div>

                  <div className="chat-info-scroll" style={{ flex: 1, overflowY: "auto", padding: 14 }}>
                    {infoTab === "info" ? (
                      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                        <div className="chat-info-profile" style={{ background: `linear-gradient(135deg, ${ORANGE_LIGHT}, #f0f9ff)`, borderRadius: 18, padding: 18, textAlign: "center" }}>
                          <CachedImage src={selectedChatAvatar} alt={selectedChat.name} style={{ width: 64, height: 64, borderRadius: 20, objectFit: "cover", border: "3px solid #fff", boxShadow: `0 4px 16px ${ORANGE}30` }} />
                          <div style={{ fontSize: 15, fontWeight: 700, color: "#1a1a1a", marginTop: 10 }}>{selectedChat.name}</div>
                          <div style={{ fontSize: 12, color: ORANGE, marginTop: 4 }}>{selectedChat.isOnline ? "🟢 Đang hoạt động" : "⭕ Ngoại tuyến"}</div>
                        </div>

                        <div className="chat-info-stats" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          {[
                            { label: "Tin nhắn", value: messages.length },
                            { label: "Trạng thái", value: selectedChat.status === "pending" ? "Chờ" : "Kết nối" },
                          ].map((stat) => (
                            <div className="chat-info-stat" key={stat.label} style={{ background: "#f8f8f8", borderRadius: 12, padding: "10px 12px" }}>
                              <div style={{ fontSize: 16, fontWeight: 700, color: ORANGE }}>{stat.value}</div>
                              <div style={{ fontSize: 11, color: "#b0b0b0", marginTop: 2 }}>{stat.label}</div>
                            </div>
                          ))}
                        </div>

                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0b0", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Nền hội thoại</div>
                          <input ref={chatBackgroundInputRef} type="file" accept="image/*" className="hidden" onChange={handleChatBackgroundChange} />
                          <div className="chat-background-grid" style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                            {CHAT_BACKGROUNDS.map((bg) => (
                              <button
                                key={bg.id}
                                type="button"
                                title={bg.label}
                                onClick={() => void updateChatBackground(bg.id)}
                                className="chat-background-option"
                                data-active={effectiveChatBackgroundId === bg.id && !normalizedCustomChatBackground ? "true" : "false"}
                                style={{
                                  height: 42,
                                  borderRadius: 12,
                                  border: effectiveChatBackgroundId === bg.id && !normalizedCustomChatBackground ? `2px solid ${ORANGE}` : "1px solid #e5e7eb",
                                  background: bg.value,
                                  cursor: "pointer",
                                  boxShadow: effectiveChatBackgroundId === bg.id && !normalizedCustomChatBackground ? `0 0 0 3px ${ORANGE_LIGHT}` : "none",
                                }}
                              />
                            ))}
                          </div>
                          <button type="button" className="chat-secondary-button" onClick={() => chatBackgroundInputRef.current?.click()} style={{ marginTop: 8, width: "100%", height: 34, borderRadius: 10, border: "1px solid #bae6fd", background: "#f0f9ff", color: ORANGE, cursor: "pointer", fontSize: 12, fontWeight: 800 }}>
                            Tải ảnh nền lên
                          </button>
                        </div>

                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0b0", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 8 }}>Hành động nhanh</div>
                          <div className="chat-quick-actions" style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                            {[
                              { icon: Phone, label: "Gọi thoại", onClick: () => startCall("audio") },
                              { icon: Video, label: "Video call", onClick: () => startCall("video") },
                              { icon: UserIcon, label: "Xem trang cá nhân", onClick: openSelectedProfile },
                              { icon: Archive, label: "Lưu trữ hội thoại", onClick: () => {} },
                            ].map((action) => (
                              <button key={action.label} type="button" onClick={action.onClick}
                                className="chat-quick-action"
                                style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderRadius: 10, border: "1px solid #f0f0f0", background: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 500, color: "#374151", transition: "all 0.15s", textAlign: "left" }}>
                                <action.icon size={15} color={ORANGE} />
                                {action.label}
                              </button>
                            ))}
                          </div>
                        </div>

                        {selectedChat.status === "pending" && (
                          <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 14, padding: 12 }}>
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#92400e", marginBottom: 8 }}>Tin nhắn chờ</div>
                            <div style={{ display: "flex", gap: 8 }}>
                              <button type="button" onClick={handleRejectRequest} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "1px solid #fca5a5", background: "#fff", color: "#dc2626", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Từ chối</button>
                              <button type="button" onClick={handleAcceptRequest} disabled={isAcceptingRequest} style={{ flex: 1, padding: "7px 0", borderRadius: 8, border: "none", background: ORANGE, color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
                                {isAcceptingRequest ? <Loader2 size={13} /> : <Check size={13} />} Chấp nhận
                              </button>
                            </div>
                          </div>
                        )}

                        <div style={{ background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 14, padding: 12 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: "#991b1b", marginBottom: 6 }}>Bảo mật</div>
                          <button type="button" style={{ width: "100%", padding: "7px 0", borderRadius: 8, border: "none", background: "#dc2626", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
                            Chặn người dùng
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#b0b0b0", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Tin nhắn gần đây</div>
                        {messages.length === 0 ? (
                          <div style={{ textAlign: "center", padding: 24, color: "#b0b0b0", fontSize: 13 }}>Chưa có tin nhắn nào</div>
                        ) : [...messages].reverse().slice(0, 20).map((msg, recentIdx) => {
                          const isMe = msg.senderId === "me";
                          return (
                            <div key={getMessageRenderKey(msg, recentIdx)} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                              <CachedImage src={isMe ? getAvatarUrl(currentUser?.avatar, currentUserId) : getAvatarUrl(msg.senderAvatar || selectedChat.avatar, msg.senderId)} alt="" style={{ width: 26, height: 26, borderRadius: 8, objectFit: "cover", flexShrink: 0 }} />
                              <div style={{ flex: 1 }}>
                                <div style={{ fontSize: 11, color: "#b0b0b0", marginBottom: 2 }}>{isMe ? "Bạn" : (msg.senderName || selectedChat.name)} · {msg.time}</div>
                                <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.4, wordBreak: "break-word" }}>{msg.text}</div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="chat-welcome-state" style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 12, color: "#b0b0b0" }}>
            <div className="chat-welcome-visual">
              <span className="chat-welcome-orbit orbit-one" />
              <span className="chat-welcome-orbit orbit-two" />
              <div className="chat-welcome-icon" style={{ width: 72, height: 72, borderRadius: 22, background: ORANGE_LIGHT, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <MessageCircle size={32} color={ORANGE} />
              </div>
            </div>
            <div className="chat-welcome-kicker">Không gian trò chuyện</div>
            <div className="chat-welcome-title" style={{ fontSize: 17, fontWeight: 700, color: "#374151" }}>Kết nối và chia sẻ tức thì</div>
            <div className="chat-welcome-description" style={{ fontSize: 13, color: "#b0b0b0" }}>Chọn một hội thoại hoặc tìm người bạn muốn nhắn tin.</div>
            <div className="chat-welcome-features">
              <span><ShieldAlert size={14} /> Phiên đăng nhập an toàn</span>
              <span><Wifi size={14} /> Đồng bộ realtime</span>
              <span><Users size={14} /> Hỗ trợ nhóm chat</span>
            </div>
          </div>
        )}
      </div>

      {/* ── CALL MODAL ── */}
      {callSession && (
        <div className="call-overlay" role="dialog" aria-modal="true" aria-label={`${callSession.mode === "video" ? "Video call" : "Cuộc gọi thoại"} với ${callSession.peerName}`}>
          <div className="call-window" data-mode={callSession.mode} data-status={callSession.status}>
            <div className="call-window-ambient" />
            <div className="call-window-header">
              <div className="call-kind">
                {callSession.mode === "video" ? <Camera size={14} /> : <Phone size={14} />}
                <span>{callSession.mode === "video" ? "Video call" : "Cuộc gọi thoại"}</span>
              </div>
              <button type="button" className="call-close-button" onClick={() => closeCall(true)} aria-label="Đóng cuộc gọi">
                <X size={18} />
              </button>
            </div>

            {callSession.mode === "video" && callSession.status !== "incoming" ? (
              <div className="call-video-stage">
                <div className="call-video-fallback">
                  <CachedImage src={callSession.peerAvatar} alt="" />
                </div>
                <video ref={remoteVideoRef} autoPlay muted playsInline className="call-remote-video" />
                <div className="call-local-video-wrap">
                  <video ref={localVideoRef} autoPlay muted playsInline className="call-local-video" />
                  {callSession.isCameraOff && <div className="call-camera-off"><VideoOff size={18} /></div>}
                  <span>Bạn</span>
                </div>
                <div className="call-video-status">
                  <span className="call-live-dot" />
                  {callSession.status === "connecting" ? "Đang kết nối" : formatCallDuration(callSession.elapsedSeconds)}
                </div>
              </div>
            ) : (
              <div className="call-identity">
                <div className="call-avatar-shell">
                  <span className="call-avatar-pulse call-avatar-pulse-one" />
                  <span className="call-avatar-pulse call-avatar-pulse-two" />
                  <CachedImage className="call-avatar" src={callSession.peerAvatar} alt={callSession.peerName} />
                  <span className="call-avatar-mode">
                    {callSession.mode === "video" ? <Video size={17} /> : <Phone size={17} />}
                  </span>
                </div>
                {callSession.mode === "audio" && callSession.status === "active" && (
                  <div className="call-audio-wave" aria-hidden="true">
                    {Array.from({ length: 7 }).map((_, index) => <span key={index} />)}
                  </div>
                )}
              </div>
            )}

            <div className="call-participant">
              <h2>{callSession.peerName}</h2>
              <p>
                {callSession.status === "incoming"
                  ? `${callSession.mode === "video" ? "Video call" : "Cuộc gọi thoại"} đang đến`
                  : callSession.status === "connecting"
                    ? "Đang thiết lập kết nối bảo mật..."
                    : `Đang gọi · ${formatCallDuration(callSession.elapsedSeconds)}`}
              </p>
              {callSession.error && <div className="call-error">{callSession.error}</div>}
            </div>

            {callSession.status !== "incoming" && (
              <audio ref={remoteAudioRef} autoPlay playsInline />
            )}

            {callSession.status === "incoming" ? (
              <div className="call-incoming-actions">
                <button type="button" className="call-decision call-decision-decline" onClick={rejectCall}>
                  <span><PhoneOff size={22} /></span>
                  Từ chối
                </button>
                <button type="button" className="call-decision call-decision-answer" onClick={acceptCall}>
                  <span>{callSession.mode === "video" ? <Video size={22} /> : <Phone size={22} />}</span>
                  Trả lời
                </button>
              </div>
            ) : (
              <div className="call-controls">
                {[
                  { icon: callSession.isMuted ? MicOff : Mic, label: callSession.isMuted ? "Bật mic" : "Tắt mic", onClick: toggleMute, active: callSession.isMuted },
                  ...(callSession.mode === "video" ? [{ icon: callSession.isCameraOff ? VideoOff : Video, label: callSession.isCameraOff ? "Bật camera" : "Tắt camera", onClick: toggleCamera, active: callSession.isCameraOff }] : []),
                  ...(callSession.mode === "video" ? [{ icon: callSession.isScreenSharing ? ScreenShareOff : ScreenShare, label: callSession.isScreenSharing ? "Dừng chia sẻ" : "Chia sẻ màn hình", onClick: toggleScreenShare, active: callSession.isScreenSharing }] : []),
                  ...(callSession.mode === "video" ? [{ icon: SwitchCamera, label: "Đổi camera", onClick: switchCamera, active: false }] : []),
                  { icon: Volume2, label: callSession.isSpeakerOn ? "Tắt loa" : "Bật loa", onClick: toggleSpeaker, active: !callSession.isSpeakerOn },
                ].map((btn) => (
                  <button
                    key={btn.label}
                    type="button"
                    className="call-control-button"
                    data-active={btn.active ? "true" : "false"}
                    onClick={btn.onClick}
                    aria-label={btn.label}
                    title={btn.label}
                  >
                    <btn.icon size={20} />
                  </button>
                ))}
                <button type="button" className="call-control-button call-hangup" onClick={() => closeCall(true)} aria-label="Kết thúc cuộc gọi" title="Kết thúc">
                  <PhoneOff size={20} />
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {showCreateGroup && (
        <div className="chat-group-modal-backdrop" style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(15,23,42,0.45)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div className="chat-group-modal" style={{ width: "100%", maxWidth: 420, borderRadius: 18, background: "#fff", boxShadow: "0 24px 80px rgba(15,23,42,0.25)", overflow: "hidden" }}>
            <div className="chat-group-modal-header" style={{ padding: 16, borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{ fontWeight: 800, color: "#0f172a" }}>Tạo nhóm chat</div>
              <button type="button" onClick={() => setShowCreateGroup(false)} style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid #e2e8f0", background: "#fff", cursor: "pointer" }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ padding: 16 }}>
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Tên nhóm"
                style={{ width: "100%", height: 40, borderRadius: 12, border: "1px solid #e2e8f0", padding: "0 12px", boxSizing: "border-box", fontSize: 14, marginBottom: 12 }}
              />
              <div style={{ maxHeight: 280, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
                {dedupConversations([
                  ...conversations.filter((c) => c.type !== "group" && getConversationPeerId(c)),
                  ...searchResults.map((u) => ({ id: `new_${toId(u.id)}`, targetUserId: toId(u.id), name: u.name, avatar: u.avatar, status: "accepted" })),
                ]).map((item) => {
                  const peerId = getConversationPeerId(item);
                  if (!peerId) return null;
                  const checked = groupMemberIds.includes(peerId);
                  return (
                    <label key={peerId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 12, cursor: "pointer", background: checked ? ORANGE_LIGHT : "#fff" }}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => {
                          setGroupMemberIds((prev) => e.target.checked ? [...prev, peerId] : prev.filter((id) => id !== peerId));
                        }}
                      />
                      <CachedImage src={getAvatarUrl(item.avatar, peerId)} alt="" style={{ width: 36, height: 36, borderRadius: 10, objectFit: "cover" }} />
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#1e293b" }}>{item.name}</span>
                    </label>
                  );
                })}
              </div>
              <button
                type="button"
                onClick={handleCreateGroup}
                style={{ width: "100%", height: 42, borderRadius: 12, border: "none", background: ORANGE, color: "#fff", fontWeight: 800, cursor: "pointer", marginTop: 14 }}
              >
                Tạo nhóm
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
        @keyframes pulse { 0%,100% { opacity: 0.6; transform: scale(1); } 50% { opacity: 0.3; transform: scale(1.1); } }

        .messages-shell {
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
        }
        .chat-list-panel { display: flex !important; }
        .mobile-back-btn { display: none; }
        .messages-scroll-area {
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
        }

        @media (max-width: 768px) {
          .chat-list-panel {
            position: static !important;
            width: 100vw !important;
            min-width: 0 !important;
            max-width: none !important;
            flex: 1 1 auto !important;
          }
          .messages-shell.has-selected-chat .chat-list-panel {
            display: none !important;
          }
          .messages-shell:not(.has-selected-chat) .chat-thread-panel {
            display: none !important;
          }
          .messages-shell.has-selected-chat .chat-thread-panel {
            display: flex !important;
            width: 100vw !important;
            max-width: 100vw !important;
            flex: 1 1 100% !important;
          }
          .messages-shell.has-selected-chat .messages-scroll-area {
            padding: 12px 12px 0 !important;
          }
          .message-composer {
            padding: 8px 10px max(8px, env(safe-area-inset-bottom)) !important;
          }
          .message-composer-form {
            gap: 8px !important;
            min-width: 0 !important;
          }
          .message-composer-input input {
            font-size: 16px !important;
          }
          .chat-info-panel {
            display: none !important;
          }
          .mobile-back-btn { display: flex !important; }
        }
      `}</style>
    </div>
  );
}
