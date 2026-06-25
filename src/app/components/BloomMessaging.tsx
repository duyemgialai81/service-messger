import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ImgHTMLAttributes, ChangeEvent, FormEvent } from "react";
import { Client } from "@stomp/stompjs";
import {
  Archive, Camera, Check, ChevronLeft, Image as ImageIcon, Copy, FileText, Inbox, Info,
  Loader2, MessageCircle, Mic, MicOff, MoreHorizontal, Phone, PhoneOff, Search, Send,
  ScreenShare, ScreenShareOff, ShieldAlert, Smile, Sparkles, SwitchCamera, ThumbsUp,
  Reply, Trash2, Pencil, User as UserIcon, Video, VideoOff, Volume2, X, Plus, Bell, Users, Wifi,
  LogOut, Sun, Moon, Snowflake, Flower2,
} from "lucide-react";
import { toast } from "sonner";
import api, { normalizeAssetUrl, normalizeAvatarUrl } from "../../lib/api";
import { localStorage_service } from "../../lib/localStorage";
import { useAuth } from "../../lib/authContext";
import { clearPendingCall, createRealtimeConnection, INCOMING_CALL_EVENT, readPendingCall } from "../../lib/realtime";
import { formatVietnamTime } from "../../lib/time";

// ==================== INTERFACES ====================
interface MessagesPageProps { readonly currentUser?: any; }
interface ConversationItem {
  id: string; type?: "direct" | "group" | string; targetUserId?: string;
  name: string; avatar?: string; lastMessage?: string; time?: string;
  unread?: number; status?: "accepted" | "pending" | string; isOnline?: boolean;
  memberCount?: number; backgroundId?: string; backgroundUrl?: string;
}
interface SearchUserItem { id: string; name: string; avatar?: string; isOnline?: boolean; }
interface MessageItem {
  id: string; senderId: string; senderName?: string; senderAvatar?: string;
  text: string; time: string; createdAt?: string; deliveryStatus?: "sending" | "sent";
  isDeleted?: boolean; isEdited?: boolean; replyToMessageId?: string;
  attachmentUrl?: string; attachmentName?: string; attachmentSize?: number;
  messageType?: string; reactions?: Record<string, number>; userReactions?: Record<string, boolean>;
}
type CallMode = "audio" | "video";
type CallStatus = "incoming" | "connecting" | "active";
interface CallSession {
  id: string; mode: CallMode; status: CallStatus; conversationId?: string;
  startedAt: number | null; elapsedSeconds: number; isMuted: boolean;
  isCameraOff: boolean; isScreenSharing: boolean; cameraFacing: "user" | "environment";
  isSpeakerOn: boolean; peerId: string; peerName: string; peerAvatar: string;
  hasMediaPermission: boolean; error: string | null;
}

// ==================== CONSTANTS ====================
const REACTION_EMOJIS = ['❤️', '😂', '👍', '😮', '😢', '🎉'];
const COMPOSER_EMOJIS = ["😀", "😂", "🥰", "😍", "😎", "😭", "😡", "👍", "👏", "❤️", "🎉", "🔥"];
const CHAT_BACKGROUNDS = [
  { id: "soft", label: "Aurora", value: "radial-gradient(circle at 8% 8%, rgba(167,139,250,.16), transparent 28%), radial-gradient(circle at 92% 4%, rgba(34,211,238,.12), transparent 24%), linear-gradient(180deg, #fbfbff 0%, #f5f5ff 100%)" },
  { id: "warm", label: "Lavender", value: "linear-gradient(145deg, #faf7ff 0%, #f0eaff 52%, #f7f5ff 100%)" },
  { id: "mint", label: "Mint", value: "linear-gradient(145deg, #f5fffd 0%, #e8fbf6 55%, #f5fffd 100%)" },
  { id: "sky", label: "Sky", value: "linear-gradient(145deg, #f6fbff 0%, #e8f4ff 55%, #f7fbff 100%)" },
  { id: "slate", label: "Graphite", value: "linear-gradient(145deg, #f8fafc 0%, #eef2f7 55%, #f8fafc 100%)" },
];
const CUSTOM_CHAT_BACKGROUND_STORAGE_KEY = "ksp_chat_background_image";
const CHAT_BACKGROUND_STORAGE_KEY = "ksp_chat_background";
const CHAT_LIST_CACHE_TTL_MS = 45_000;
const MESSAGE_PAGE_CACHE_TTL_MS = 5 * 60_000;
const INITIAL_MESSAGE_PAGE_SIZE = 40;
const OLDER_MESSAGE_PAGE_SIZE = 50;
const IMAGE_MEMORY_CACHE_LIMIT = 180;
const IMAGE_PLACEHOLDER_SRC = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";
const CALL_CONNECT_TIMEOUT_MS = 90_000;
const CALL_DISCONNECT_GRACE_MS = 30_000;
const iceServers: RTCConfiguration = {
  iceCandidatePoolSize: 10,
  iceServers: [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
    { urls: ["turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp", "turns:openrelay.metered.ca:443?transport=tcp"], username: "openrelayproject", credential: "openrelayproject" },
  ],
};
const formatCallDuration = (s: number) => `${Math.floor(s / 60).toString().padStart(2, "0")}:${Math.floor(s % 60).toString().padStart(2, "0")}`;

type ExpiringCache<T> = Map<string, { savedAt: number; value: T }>;
const chatListMemoryCache: ExpiringCache<ConversationItem[]> = new Map();
const messagePageMemoryCache: ExpiringCache<{ messages: MessageItem[]; oldestMessageCursor: string | null; hasMoreMessages: boolean }> = new Map();
const imageMemoryCache = new Map<string, string>();
const imageInflightCache = new Map<string, Promise<string>>();

function cloneCache<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }
function readCache<T>(cache: ExpiringCache<T>, key: string, ttl: number): T | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() - e.savedAt > ttl) { cache.delete(key); return null; }
  return cloneCache(e.value);
}
function writeCache<T>(cache: ExpiringCache<T>, key: string, value: T) { cache.set(key, { savedAt: Date.now(), value: cloneCache(value) }); }

function shouldCacheImage(src: string) { return Boolean(src) && !/^(data:|blob:)/i.test(src); }
function trimImageCache() {
  while (imageMemoryCache.size > IMAGE_MEMORY_CACHE_LIMIT) {
    const k = imageMemoryCache.keys().next().value;
    if (!k) break;
    const u = imageMemoryCache.get(k);
    if (u?.startsWith("blob:")) URL.revokeObjectURL(u);
    imageMemoryCache.delete(k);
  }
}
async function loadImageSrc(src: string) {
  const n = src.trim();
  if (!shouldCacheImage(n)) return n;
  const c = imageMemoryCache.get(n); if (c) return c;
  const f = imageInflightCache.get(n); if (f) return f;
  const p = fetch(n, { cache: "force-cache", credentials: "include", mode: "cors" })
    .then((r) => { if (!r.ok) throw new Error(""); return r.blob(); })
    .then((b) => { const u = URL.createObjectURL(b); imageMemoryCache.set(n, u); trimImageCache(); return u; })
    .catch(() => n).finally(() => { imageInflightCache.delete(n); });
  imageInflightCache.set(n, p); return p;
}
function getInitialSrc(src?: string, fallback = IMAGE_PLACEHOLDER_SRC) {
  const n = typeof src === "string" ? src.trim() : "";
  if (!n) return fallback;
  if (!shouldCacheImage(n)) return n;
  return imageMemoryCache.get(n) || fallback;
}
function useCachedSrc(src?: string, fallback = IMAGE_PLACEHOLDER_SRC) {
  const n = typeof src === "string" ? src.trim() : "";
  const [resolved, setResolved] = useState(() => getInitialSrc(n, fallback));
  useEffect(() => {
    let cancelled = false;
    setResolved(getInitialSrc(n, fallback));
    if (!n || !shouldCacheImage(n)) return () => { cancelled = true; };
    void loadImageSrc(n).then((s) => { if (!cancelled) setResolved(s || fallback); });
    return () => { cancelled = true; };
  }, [n, fallback]);
  return resolved;
}

type CachedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & { src?: string; fallbackSrc?: string };
const CachedImage = memo(function CachedImage({ src, fallbackSrc = IMAGE_PLACEHOLDER_SRC, loading, decoding, onError, ...props }: CachedImageProps) {
  const resolved = useCachedSrc(src, fallbackSrc);
  return <img {...props} src={resolved} loading={loading || "lazy"} decoding={decoding || "async"} onError={onError} />;
});

function getMessageDateKey(v?: string) {
  const d = v ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
function formatMessageDateLabel(v?: string) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const todayKey = getMessageDateKey(new Date().toISOString());
  if (getMessageDateKey(v) === todayKey) return "Hôm nay";
  return new Intl.DateTimeFormat("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", weekday: "short", day: "2-digit", month: "2-digit" }).format(d);
}
function isAudioAttachment(msg: Pick<MessageItem, "attachmentName" | "attachmentUrl">) {
  return /\.(webm|mp3|wav|m4a|aac|ogg)(?:$|[?#\s])/i.test(`${msg.attachmentName || ""} ${msg.attachmentUrl || ""}`.toLowerCase());
}
function isImageUrl(url?: string) {
  if (!url) return false;
  return /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif|ico)(?:$|[?#\s])/i.test(url);
}

// ============================================================
// CANVAS 0 — Hiệu ứng rơi: Tuyết & Hoa Anh Đào
// ============================================================
type FallingMode = "none" | "snow" | "sakura";
const FallingEffectsCanvas = memo(function FallingEffectsCanvas({ mode }: { mode: FallingMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    if (mode === "none") return;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let w = 0, h = 0;

    interface Flake { x: number; y: number; r: number; vx: number; vy: number; wobbleA: number; wobbleS: number; phase: number; opacity: number; rot: number; rotS: number; }
    const flakes: Flake[] = [];

    const init = () => {
      flakes.length = 0;
      const count = Math.min(Math.floor((w * h) / 6000), 120);
      for (let i = 0; i < count; i++) {
        flakes.push(makeFlake(true));
      }
    };

    const makeFlake = (randomY: boolean) => {
      if (mode === "snow") {
        return {
          x: Math.random() * w, y: randomY ? Math.random() * h : -10,
          r: 1.5 + Math.random() * 3.5, vx: (Math.random() - 0.5) * 0.3,
          vy: 0.5 + Math.random() * 1.5,
          wobbleA: 0.5 + Math.random() * 1, wobbleS: 0.01 + Math.random() * 0.02,
          phase: Math.random() * Math.PI * 2, opacity: 0.4 + Math.random() * 0.5,
          rot: 0, rotS: (Math.random() - 0.5) * 0.02,
        };
      } else {
        return {
          x: Math.random() * w, y: randomY ? Math.random() * h : -20,
          r: 3 + Math.random() * 5, vx: (Math.random() - 0.5) * 0.5,
          vy: 0.4 + Math.random() * 1.2,
          wobbleA: 1 + Math.random() * 1.5, wobbleS: 0.008 + Math.random() * 0.015,
          phase: Math.random() * Math.PI * 2, opacity: 0.35 + Math.random() * 0.45,
          rot: Math.random() * Math.PI * 2, rotS: (Math.random() - 0.5) * 0.04,
        };
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      init();
    };
    resize();
    window.addEventListener("resize", resize);

    let t = 0;
    const draw = () => {
      t++;
      ctx.clearRect(0, 0, w, h);

      for (const f of flakes) {
        f.phase += f.wobbleS;
        f.x += f.vx + Math.sin(f.phase) * f.wobbleA * 0.3;
        f.y += f.vy;
        f.rot += f.rotS;

        if (f.y > h + 20) { Object.assign(f, makeFlake(false)); }
        if (f.x < -20) f.x = w + 20;
        if (f.x > w + 20) f.x = -20;

        if (mode === "snow") {
          // Snowflake: soft glowing circle
          const gr = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.max(0.5, f.r * 2));
          gr.addColorStop(0, `rgba(220, 240, 255, ${f.opacity})`);
          gr.addColorStop(0.4, `rgba(200, 225, 250, ${f.opacity * 0.4})`);
          gr.addColorStop(1, `rgba(180, 210, 240, 0)`);
          ctx.fillStyle = gr;
          ctx.beginPath();
          ctx.arc(f.x, f.y, Math.max(0.5, f.r * 2), 0, Math.PI * 2);
          ctx.fill();
          // Core
          ctx.fillStyle = `rgba(255, 255, 255, ${f.opacity * 0.9})`;
          ctx.beginPath();
          ctx.arc(f.x, f.y, Math.max(0.3, f.r * 0.4), 0, Math.PI * 2);
          ctx.fill();
        } else {
          // Sakura petal: draw with rotation
          ctx.save();
          ctx.translate(f.x, f.y);
          ctx.rotate(f.rot);
          ctx.globalAlpha = f.opacity;
          ctx.fillStyle = `hsla(${340 + Math.sin(f.phase) * 10}, 75%, 80%, 1)`;
          ctx.beginPath();
          // Petal shape
          const s = f.r;
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(s * 0.8, -s * 0.6, s * 1.2, -s * 0.2, s * 1.2, 0);
          ctx.bezierCurveTo(s * 1.2, s * 0.2, s * 0.8, s * 0.6, 0, 0);
          ctx.fill();
          // Second petal rotated
          ctx.rotate(Math.PI * 0.6);
          ctx.fillStyle = `hsla(${345 + Math.sin(f.phase + 1) * 10}, 70%, 85%, 0.7)`;
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.bezierCurveTo(s * 0.7, -s * 0.5, s * 1.0, -s * 0.15, s * 1.0, 0);
          ctx.bezierCurveTo(s * 1.0, s * 0.15, s * 0.7, s * 0.5, 0, 0);
          ctx.fill();
          ctx.restore();
          // Soft glow
          const gg = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, Math.max(1, f.r * 1.8));
          gg.addColorStop(0, `hsla(345, 65%, 85%, ${f.opacity * 0.12})`);
          gg.addColorStop(1, `hsla(345, 65%, 85%, 0)`);
          ctx.fillStyle = gg;
          ctx.beginPath();
          ctx.arc(f.x, f.y, Math.max(1, f.r * 1.8), 0, Math.PI * 2);
          ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, [mode]);

  if (mode === "none") return null;
  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
});

// ============================================================
// CANVAS 1 — Nền toàn màn hình: Particle Network + Aurora + Shooting Stars
// ============================================================
const ParticleNetworkBackground = memo(function ParticleNetworkBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });
  const rafRef = useRef(0);
  const particlesRef = useRef<ParticleBG[]>([]);
  const aurorasRef = useRef<AuroraBG[]>([]);
  const shootingStarsRef = useRef<ShootingStarBG[]>([]);
  const dimsRef = useRef({ w: 0, h: 0 });
  const glitchRef = useRef<GlitchLine[]>([]);

  interface ParticleBG { x: number; y: number; vx: number; vy: number; r: number; opacity: number; hue: number; pulse: number; pulseSpeed: number; }
  interface AuroraBG { x: number; y: number; radius: number; hue: number; vx: number; vy: number; phase: number; speed: number; hueSpeed: number; }
  interface ShootingStarBG { x: number; y: number; vx: number; vy: number; life: number; maxLife: number; hue: number; length: number; width: number; }
  interface GlitchLine { y: number; h: number; life: number; maxLife: number; hue: number; }

  const init = useCallback((w: number, h: number) => {
    const count = Math.min(Math.floor((w * h) / 10000), 140);
    const particles: ParticleBG[] = [];
    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35,
        r: Math.random() * 1.6 + 0.5,
        opacity: Math.random() * 0.45 + 0.15,
        hue: 160 + Math.random() * 50,
        pulse: Math.random() * Math.PI * 2,
        pulseSpeed: 0.008 + Math.random() * 0.015,
      });
    }
    particlesRef.current = particles;
    aurorasRef.current = [
      { x: w * 0.15, y: h * 0.25, radius: Math.max(220, w * 0.28), hue: 162, vx: 0.25, vy: 0.12, phase: 0, speed: 0.007, hueSpeed: 0.12 },
      { x: w * 0.82, y: h * 0.18, radius: Math.max(200, w * 0.24), hue: 178, vx: -0.2, vy: 0.18, phase: Math.PI * 0.6, speed: 0.005, hueSpeed: 0.09 },
      { x: w * 0.5, y: h * 0.72, radius: Math.max(180, w * 0.22), hue: 150, vx: 0.18, vy: -0.15, phase: Math.PI * 1.3, speed: 0.009, hueSpeed: 0.14 },
      { x: w * 0.7, y: h * 0.6, radius: Math.max(150, w * 0.18), hue: 185, vx: -0.12, vy: 0.1, phase: Math.PI * 0.3, speed: 0.006, hueSpeed: 0.11 },
    ];
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true }); if (!ctx) return;
    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = window.innerWidth; const h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      dimsRef.current = { w, h }; init(w, h);
    };
    const onMouse = (e: MouseEvent) => { mouseRef.current = { x: e.clientX, y: e.clientY, active: true }; };
    const onMouseLeave = () => { mouseRef.current.active = false; };
    resize();
    window.addEventListener("resize", resize);
    window.addEventListener("mousemove", onMouse);
    window.addEventListener("mouseleave", onMouseLeave);

    let t = 0;
    let gridOffset = 0;
    const CONN_DIST = 130;
    const MOUSE_R = 200;
    const draw = () => {
      const { w, h } = dimsRef.current;
      const mx = mouseRef.current.x; const my = mouseRef.current.y;
      const mActive = mouseRef.current.active;
      t += 1;

      // --- VFX Max: Trail effect (semi-transparent clear) ---
      const isDark = document.documentElement.classList.contains("bloom-dark");
      ctx.fillStyle = isDark ? "rgba(10, 18, 32, 0.13)" : "rgba(249, 253, 255, 0.13)";
      ctx.fillRect(0, 0, w, h);

      // --- Cyber grid (scrolling 2D) ---
      gridOffset = (gridOffset + 0.35) % 60;
      ctx.strokeStyle = "rgba(8, 145, 178, 0.035)";
      ctx.lineWidth = 0.5;
      const gridSpacing = 60;
      for (let y = h + 60; y > -60; y -= gridSpacing) {
        const gy = y + gridOffset;
        if (gy < -60 || gy > h + 60) continue;
        ctx.globalAlpha = Math.max(0, 1 - Math.abs(gy - h * 0.5) / (h * 0.7)) * 0.55;
        ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
      }
      for (let x = -60; x < w + 60; x += gridSpacing) {
        const gx = x + gridOffset * 0.7;
        ctx.globalAlpha = Math.max(0, 1 - Math.abs(gx - w * 0.5) / (w * 0.7)) * 0.55;
        ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // --- Auroras (ADDITIVE BLENDING) ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const a of aurorasRef.current) {
        a.phase += a.speed; a.hue += a.hueSpeed * 0.01;
        a.x += a.vx + Math.sin(a.phase) * 0.45;
        a.y += a.vy + Math.cos(a.phase * 0.7) * 0.35;
        if (a.x < -a.radius * 0.6) a.vx = Math.abs(a.vx);
        if (a.x > w + a.radius * 0.6) a.vx = -Math.abs(a.vx);
        if (a.y < -a.radius * 0.6) a.vy = Math.abs(a.vy);
        if (a.y > h + a.radius * 0.6) a.vy = -Math.abs(a.vy);
        const pr = Math.max(1, a.radius + Math.sin(a.phase * 1.2) * 40);
        const hs = Math.sin(a.phase * 0.4) * 20;
        const g = ctx.createRadialGradient(a.x, a.y, 0, a.x, a.y, pr);
        g.addColorStop(0, `hsla(${a.hue + hs}, 72%, 55%, 0.06)`);
        g.addColorStop(0.3, `hsla(${a.hue + hs + 8}, 62%, 50%, 0.03)`);
        g.addColorStop(0.65, `hsla(${a.hue + hs + 15}, 50%, 45%, 0.01)`);
        g.addColorStop(1, `hsla(${a.hue + hs}, 40%, 40%, 0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(a.x, a.y, pr, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      // --- Shooting stars (ADDITIVE BLENDING + nebula trail) ---
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      if (Math.random() < 0.005) {
        const angle = Math.PI * 0.12 + Math.random() * Math.PI * 0.25;
        const speed = 5 + Math.random() * 6;
        shootingStarsRef.current.push({
          x: Math.random() * w * 0.85, y: Math.random() * h * 0.25,
          vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
          life: 0, maxLife: 45 + Math.random() * 35,
          hue: 162 + Math.random() * 35, length: 55 + Math.random() * 75, width: 1.2 + Math.random() * 1.8,
        });
      }
      for (let i = shootingStarsRef.current.length - 1; i >= 0; i--) {
        const s = shootingStarsRef.current[i];
        s.x += s.vx; s.y += s.vy; s.life++;
        if (s.life >= s.maxLife) { shootingStarsRef.current.splice(i, 1); continue; }
        const progress = s.life / s.maxLife;
        const alpha = progress < 0.15 ? progress / 0.15 : 1 - (progress - 0.15) / 0.85;
        const speed2 = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
        const tailX = s.x - (s.vx / speed2) * s.length;
        const tailY = s.y - (s.vy / speed2) * s.length;
        const grad = ctx.createLinearGradient(tailX, tailY, s.x, s.y);
        grad.addColorStop(0, `hsla(${s.hue}, 85%, 70%, 0)`);
        grad.addColorStop(0.5, `hsla(${s.hue}, 85%, 78%, ${alpha * 0.3})`);
        grad.addColorStop(0.85, `hsla(${s.hue}, 92%, 88%, ${alpha * 0.7})`);
        grad.addColorStop(1, `hsla(${s.hue}, 95%, 95%, ${alpha})`);
        ctx.strokeStyle = grad; ctx.lineWidth = s.width; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(s.x, s.y); ctx.stroke();
        // Wider nebula trail
        ctx.lineWidth = s.width * 4;
        ctx.globalAlpha = alpha * 0.12;
        ctx.beginPath(); ctx.moveTo(tailX, tailY); ctx.lineTo(s.x, s.y); ctx.stroke();
        ctx.globalAlpha = 1;
        // Head glow (bigger)
        const hg = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, 10);
        hg.addColorStop(0, `hsla(${s.hue}, 95%, 95%, ${alpha * 0.6})`);
        hg.addColorStop(0.4, `hsla(${s.hue}, 90%, 85%, ${alpha * 0.2})`);
        hg.addColorStop(1, `hsla(${s.hue}, 85%, 80%, 0)`);
        ctx.fillStyle = hg; ctx.beginPath(); ctx.arc(s.x, s.y, 10, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();

      // --- Particles (VFX: enhanced mouse attraction + additive glow) ---
      const pts = particlesRef.current;
      for (const p of pts) {
        p.pulse += p.pulseSpeed;
        if (mActive) {
          const dx = mx - p.x; const dy = my - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MOUSE_R && dist > 1) {
            const force = (MOUSE_R - dist) / MOUSE_R;
            const attract = force * force * 0.025;
            p.vx += (dx / dist) * attract; p.vy += (dy / dist) * attract;
          }
        }
        p.vx *= 0.995; p.vy *= 0.995;
        p.x += p.vx; p.y += p.vy;
        if (p.x < -15) p.x = w + 15; if (p.x > w + 15) p.x = -15;
        if (p.y < -15) p.y = h + 15; if (p.y > h + 15) p.y = -15;
        const pAlpha = p.opacity * (0.7 + Math.sin(p.pulse) * 0.3);
        // Particle glow with additive
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const glowR = Math.max(0.1, p.r * 5);
        const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, glowR);
        glow.addColorStop(0, `hsla(${p.hue}, 88%, 70%, ${pAlpha * 0.8})`);
        glow.addColorStop(0.35, `hsla(${p.hue}, 78%, 60%, ${pAlpha * 0.2})`);
        glow.addColorStop(1, `hsla(${p.hue}, 65%, 50%, 0)`);
        ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(p.x, p.y, glowR, 0, Math.PI * 2); ctx.fill();
        ctx.restore();
        // Bright core
        ctx.fillStyle = `hsla(${p.hue}, 95%, 88%, ${pAlpha * 0.9})`;
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.1, p.r * 0.55), 0, Math.PI * 2); ctx.fill();
      }

      // --- Connection lines ---
      ctx.lineWidth = 0.5;
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const dx = pts[i].x - pts[j].x; const dy = pts[i].y - pts[j].y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < CONN_DIST) {
            const alpha = (1 - dist / CONN_DIST) * 0.12;
            const hue = (pts[i].hue + pts[j].hue) * 0.5;
            ctx.strokeStyle = `hsla(${hue}, 70%, 60%, ${alpha})`;
            ctx.beginPath(); ctx.moveTo(pts[i].x, pts[i].y); ctx.lineTo(pts[j].x, pts[j].y); ctx.stroke();
          }
        }
      }

      // --- Mouse connections + glow ---
      if (mActive) {
        for (const p of pts) {
          const dx = mx - p.x; const dy = my - p.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < MOUSE_R) {
            const alpha = (1 - dist / MOUSE_R) * 0.2;
            ctx.strokeStyle = `hsla(${p.hue}, 80%, 72%, ${alpha})`;
            ctx.lineWidth = 0.7;
            ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(p.x, p.y); ctx.stroke();
          }
        }
        const mg = ctx.createRadialGradient(mx, my, 0, mx, my, MOUSE_R * 0.5);
        mg.addColorStop(0, `hsla(168, 80%, 60%, 0.05)`);
        mg.addColorStop(0.5, `hsla(170, 70%, 55%, 0.02)`);
        mg.addColorStop(1, `hsla(170, 60%, 50%, 0)`);
        ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(mx, my, MOUSE_R * 0.5, 0, Math.PI * 2); ctx.fill();
      }

      // --- Glitch scanlines (top layer) ---
      if (Math.random() < 0.015) {
        glitchRef.current.push({
          y: Math.random() * h, h: Math.random() * 2 + 1,
          life: 5, maxLife: 5, hue: 165 + Math.random() * 30,
        });
      }
      glitchRef.current = glitchRef.current.filter(l => l.life > 0);
      for (const l of glitchRef.current) {
        const a = (l.life / l.maxLife) * 0.09;
        ctx.fillStyle = `hsla(${l.hue}, 80%, 60%, ${a})`;
        ctx.fillRect(0, l.y, w, l.h);
        l.life--;
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouse);
      window.removeEventListener("mouseleave", onMouseLeave);
    };
  }, [init]);

  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
});

// ============================================================
// CANVAS 2 — Nền khu vực chat: Floating Orbs + Light Rays
// ============================================================
const ChatAmbientCanvas = memo(function ChatAmbientCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  interface Orb { x: number; y: number; r: number; hue: number; vx: number; vy: number; phase: number; speed: number; opacity: number; }

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let w = 0, h = 0;
    const orbs: Orb[] = [];
    for (let i = 0; i < 18; i++) {
      orbs.push({
        x: Math.random(), y: Math.random(), r: 30 + Math.random() * 80,
        hue: 155 + Math.random() * 45, vx: (Math.random() - 0.5) * 0.0002,
        vy: (Math.random() - 0.5) * 0.00015, phase: Math.random() * Math.PI * 2,
        speed: 0.003 + Math.random() * 0.006, opacity: 0.02 + Math.random() * 0.03,
      });
    }

    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    // Light rays config
    const rays = Array.from({ length: 5 }, () => ({
      angle: Math.random() * Math.PI * 2,
      width: 0.02 + Math.random() * 0.04,
      speed: 0.001 + Math.random() * 0.002,
      hue: 165 + Math.random() * 25,
      opacity: 0.012 + Math.random() * 0.015,
      length: 0.6 + Math.random() * 0.4,
    }));

    let t = 0;
    const draw = () => {
      if (!w || !h) { rafRef.current = requestAnimationFrame(draw); return; }
      t += 1; ctx.clearRect(0, 0, w, h);

      // Light rays from top-right corner
      const cx = w * 0.95; const cy = 0;
      for (const ray of rays) {
        ray.angle += ray.speed;
        const halfW = ray.width * Math.PI;
        const len = Math.max(w, h) * ray.length;
        const x1 = cx + Math.cos(ray.angle - halfW) * len;
        const y1 = cy + Math.sin(ray.angle - halfW) * len;
        const x2 = cx + Math.cos(ray.angle + halfW) * len;
        const y2 = cy + Math.sin(ray.angle + halfW) * len;
        const flicker = ray.opacity * (0.7 + Math.sin(t * 0.02 + ray.angle * 3) * 0.3);
        const grad = ctx.createLinearGradient(cx, cy, (x1 + x2) / 2, (y1 + y2) / 2);
        grad.addColorStop(0, `hsla(${ray.hue}, 70%, 65%, ${flicker})`);
        grad.addColorStop(0.5, `hsla(${ray.hue}, 60%, 55%, ${flicker * 0.4})`);
        grad.addColorStop(1, `hsla(${ray.hue}, 50%, 50%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x1, y1); ctx.lineTo(x2, y2); ctx.closePath(); ctx.fill();
      }

      // Floating orbs
      for (const o of orbs) {
        o.phase += o.speed;
        o.x += o.vx + Math.sin(o.phase * 0.7) * 0.0003;
        o.y += o.vy + Math.cos(o.phase * 0.5) * 0.0002;
        if (o.x < -0.1) o.x = 1.1; if (o.x > 1.1) o.x = -0.1;
        if (o.y < -0.1) o.y = 1.1; if (o.y > 1.1) o.y = -0.1;
        const px = o.x * w; const py = o.y * h;
        const pr = Math.max(1, o.r + Math.sin(o.phase) * 15);
        const flicker = o.opacity * (0.6 + Math.sin(o.phase * 1.5) * 0.4);
        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, `hsla(${o.hue + Math.sin(o.phase * 0.3) * 10}, 60%, 55%, ${flicker})`);
        g.addColorStop(0.5, `hsla(${o.hue + 5}, 50%, 50%, ${flicker * 0.4})`);
        g.addColorStop(1, `hsla(${o.hue}, 45%, 45%, 0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none", borderRadius: "inherit" }} />;
});

// ============================================================
// CANVAS 3 — Call UI: Pulsing Rings + Audio Bars
// ============================================================
const CallVisualCanvas = memo(function CallVisualCanvas({ isActive, mode }: { isActive: boolean; mode: CallMode }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const barsRef = useRef<number[]>(Array.from({ length: 32 }, () => Math.random() * 0.3));
  const ringsRef = useRef<{ r: number; opacity: number; speed: number }[]>([]);

  useEffect(() => {
    if (!isActive) { cancelAnimationFrame(rafRef.current); return; }
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 320;
    canvas.width = size * dpr; canvas.height = size * dpr;
    canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2; const cy = size / 2;
    let t = 0;
    let ringTimer = 0;

    const draw = () => {
      t += 1; ringTimer++;
      ctx.clearRect(0, 0, size, size);

      // Spawn ring every 45 frames
      if (ringTimer % 45 === 0) {
        ringsRef.current.push({ r: 40, opacity: 0.5, speed: 0.6 + Math.random() * 0.4 });
      }
      // Draw & update rings
      for (let i = ringsRef.current.length - 1; i >= 0; i--) {
        const ring = ringsRef.current[i];
        ring.r += ring.speed; ring.opacity -= 0.004;
        if (ring.opacity <= 0) { ringsRef.current.splice(i, 1); continue; }
        ctx.strokeStyle = `hsla(168, 70%, 55%, ${ring.opacity})`;
        ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(cx, cy, ring.r, 0, Math.PI * 2); ctx.stroke();
      }

      // Audio bars (circular)
      const barCount = barsRef.current.length;
      const innerR = 50; const maxBarH = 35;
      for (let i = 0; i < barCount; i++) {
        // Simulate audio
        const target = 0.15 + Math.sin(t * 0.08 + i * 0.4) * 0.25 + Math.sin(t * 0.13 + i * 0.7) * 0.15 + Math.random() * 0.1;
        barsRef.current[i] += (target - barsRef.current[i]) * 0.15;
        const barH = Math.max(2, barsRef.current[i] * maxBarH);
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
        const x1 = cx + Math.cos(angle) * innerR;
        const y1 = cy + Math.sin(angle) * innerR;
        const x2 = cx + Math.cos(angle) * (innerR + barH);
        const y2 = cy + Math.sin(angle) * (innerR + barH);
        const hue = 165 + (i / barCount) * 30;
        const alpha = 0.4 + barsRef.current[i] * 0.6;
        ctx.strokeStyle = `hsla(${hue}, 80%, 60%, ${alpha})`;
        ctx.lineWidth = 2.5; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }

      // Center glow
      const cg = ctx.createRadialGradient(cx, cy, 0, cx, cy, innerR - 5);
      cg.addColorStop(0, `hsla(168, 80%, 55%, ${0.06 + Math.sin(t * 0.03) * 0.02})`);
      cg.addColorStop(1, `hsla(168, 80%, 55%, 0)`);
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(cx, cy, innerR - 5, 0, Math.PI * 2); ctx.fill();

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ringsRef.current = []; };
  }, [isActive, mode]);

  if (!isActive) return null;
  return <canvas ref={canvasRef} style={{ position: "absolute", top: "50%", left: "50%", transform: "translate(-50%, -50%)", zIndex: 1, pointerEvents: "none", opacity: 0.7 }} />;
});

// ============================================================
// CANVAS 4 — Loading: Morphing Geometry + Orbiting Dots
// ============================================================
const LoadingCanvas = memo(function LoadingCanvas({ size = 64 }: { size?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr; canvas.height = size * dpr;
    canvas.style.width = `${size}px`; canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2; const cy = size / 2;
    let t = 0;
    const orbitDots = Array.from({ length: 6 }, (_, i) => ({
      angle: (i / 6) * Math.PI * 2, radius: size * 0.35,
      hue: 160 + i * 8, size: 2.5 + Math.random() * 1.5, speed: 0.025 + i * 0.003,
    }));

    const draw = () => {
      t += 1; ctx.clearRect(0, 0, size, size);
      // Morphing polygon (triangle → square → pentagon → hexagon → loop)
      const sides = 3 + (Math.floor(t / 80) % 4);
      const morphT = (t % 80) / 80;
      const eased = morphT < 0.5 ? 4 * morphT * morphT * morphT : 1 - Math.pow(-2 * morphT + 2, 3) / 2;
      const r = size * 0.22 * (0.9 + Math.sin(t * 0.04) * 0.1);
      ctx.strokeStyle = `hsla(168, 75%, 58%, ${0.5 + Math.sin(t * 0.05) * 0.2})`;
      ctx.lineWidth = 2; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.beginPath();
      for (let i = 0; i <= sides; i++) {
        const a = (i / sides) * Math.PI * 2 - Math.PI / 2 + t * 0.01;
        const px = cx + Math.cos(a) * r; const py = cy + Math.sin(a) * r;
        i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
      }
      ctx.stroke();

      // Glow behind polygon
      const pg = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 1.8);
      pg.addColorStop(0, `hsla(168, 80%, 55%, ${0.08 + Math.sin(t * 0.04) * 0.03})`);
      pg.addColorStop(1, `hsla(168, 80%, 55%, 0)`);
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(cx, cy, r * 1.8, 0, Math.PI * 2); ctx.fill();

      // Orbiting dots
      for (const dot of orbitDots) {
        dot.angle += dot.speed;
        const dx = cx + Math.cos(dot.angle) * dot.radius;
        const dy = cy + Math.sin(dot.angle) * dot.radius;
        const trail = 5;
        for (let j = trail; j >= 0; j--) {
          const ta = dot.angle - j * 0.06;
          const tx = cx + Math.cos(ta) * dot.radius;
          const ty = cy + Math.sin(ta) * dot.radius;
          const alpha = (1 - j / trail) * 0.5;
          const s = dot.size * (1 - j / trail * 0.5);
          ctx.fillStyle = `hsla(${dot.hue}, 80%, 65%, ${alpha})`;
          ctx.beginPath(); ctx.arc(tx, ty, s, 0, Math.PI * 2); ctx.fill();
        }
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [size]);

  return <canvas ref={canvasRef} />;
});

// ============================================================
// CANVAS 5 — Sidebar shimmer: Subtle flowing gradient
// ============================================================
const SidebarShimmerCanvas = memo(function SidebarShimmerCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let w = 0, h = 0;
    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);
    let t = 0;

    const draw = () => {
      if (!w || !h) { rafRef.current = requestAnimationFrame(draw); return; }
      t += 0.008; ctx.clearRect(0, 0, w, h);
      // Flowing diagonal shimmer
      const shimmerY = (Math.sin(t) * 0.5 + 0.5) * h * 1.5 - h * 0.25;
      const g = ctx.createLinearGradient(0, shimmerY - 80, 0, shimmerY + 80);
      g.addColorStop(0, `hsla(168, 70%, 55%, 0)`);
      g.addColorStop(0.5, `hsla(168, 70%, 55%, 0.015)`);
      g.addColorStop(1, `hsla(168, 70%, 55%, 0)`);
      ctx.fillStyle = g; ctx.fillRect(0, shimmerY - 80, w, 160);

      // Edge glow (left border)
      const eg = ctx.createLinearGradient(0, 0, 20, 0);
      eg.addColorStop(0, `hsla(168, 70%, 55%, ${0.03 + Math.sin(t * 1.5) * 0.01})`);
      eg.addColorStop(1, `hsla(168, 70%, 55%, 0)`);
      ctx.fillStyle = eg; ctx.fillRect(0, 0, 20, h);

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
});

// ============================================================
// CANVAS 6 — Voice Recording: Waveform Bars
// ============================================================
const VoiceWaveCanvas = memo(function VoiceWaveCanvas({ isActive }: { isActive: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const barsRef = useRef<number[]>(Array.from({ length: 28 }, () => 0.2));

  useEffect(() => {
    if (!isActive) { cancelAnimationFrame(rafRef.current); return; }
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 120, h = 32;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let t = 0;

    const draw = () => {
      t += 1; ctx.clearRect(0, 0, w, h);
      const barCount = barsRef.current.length;
      const gap = 2; const barW = (w - gap * (barCount - 1)) / barCount;
      for (let i = 0; i < barCount; i++) {
        const target = 0.15 + Math.abs(Math.sin(t * 0.09 + i * 0.45)) * 0.55 + Math.random() * 0.18;
        barsRef.current[i] += (target - barsRef.current[i]) * 0.2;
        const barH = Math.max(2, barsRef.current[i] * h * 0.85);
        const x = i * (barW + gap);
        const y = (h - barH) / 2;
        const grad = ctx.createLinearGradient(0, y, 0, y + barH);
        grad.addColorStop(0, `hsla(0, 85%, 65%, 0.95)`);
        grad.addColorStop(1, `hsla(348, 80%, 55%, 0.85)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        const r = Math.min(barW / 2, 2);
        ctx.roundRect(x, y, barW, barH, r);
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [isActive]);

  if (!isActive) return null;
  return <canvas ref={canvasRef} style={{ display: "block" }} />;
});

// ============================================================
// CANVAS 7 — Confetti Burst (celebration)
// ============================================================
const ConfettiBurstCanvas = memo(function ConfettiBurstCanvas({ trigger }: { trigger: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particlesRef = useRef<{
    x: number; y: number; vx: number; vy: number;
    color: string; size: number; rotation: number; vr: number; life: number; maxLife: number;
  }[]>([]);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (trigger === lastTriggerRef.current) return;
    lastTriggerRef.current = trigger;
    if (trigger === 0) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 360, h = 200;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const colors = ["#06b6d4", "#22d3ee", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
    const cx = w / 2, cy = h * 0.7;
    for (let i = 0; i < 80; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9;
      const speed = 3 + Math.random() * 5;
      particlesRef.current.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 3 + Math.random() * 5,
        rotation: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.4,
        life: 0,
        maxLife: 80 + Math.random() * 40,
      });
    }

    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      let alive = false;
      for (const p of particlesRef.current) {
        p.life++;
        if (p.life >= p.maxLife) continue;
        alive = true;
        p.vy += 0.12;
        p.vx *= 0.99;
        p.x += p.vx; p.y += p.vy;
        p.rotation += p.vr;
        const alpha = 1 - p.life / p.maxLife;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.fillStyle = p.color;
        ctx.globalAlpha = alpha;
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
        ctx.restore();
      }
      if (!alive && particlesRef.current.length > 0) {
        particlesRef.current = [];
        ctx.clearRect(0, 0, w, h);
        return;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [trigger]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed", inset: 0, zIndex: 999,
        pointerEvents: "none", display: trigger > 0 ? "block" : "none",
      }}
    />
  );
});

// ============================================================
// CANVAS 8 — Emoji Burst (Like button)
// ============================================================
const EmojiBurstCanvas = memo(function EmojiBurstCanvas({ emoji, trigger }: { emoji: string; trigger: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const particlesRef = useRef<{ x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number; rot: number; vr: number; }[]>([]);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (trigger === lastTriggerRef.current) return;
    lastTriggerRef.current = trigger;
    if (trigger === 0) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Burst from bottom-right (near like button)
    const cx = w - 80; const cy = h - 100;
    for (let i = 0; i < 14; i++) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.2;
      const speed = 2 + Math.random() * 3.5;
      particlesRef.current.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 0, maxLife: 70 + Math.random() * 30,
        size: 18 + Math.random() * 16,
        rot: 0, vr: (Math.random() - 0.5) * 0.2,
      });
    }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      let alive = false;
      ctx.font = `${24}px serif`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (const p of particlesRef.current) {
        p.life++;
        if (p.life >= p.maxLife) continue;
        alive = true;
        p.vy += 0.08; p.vx *= 0.99;
        p.x += p.vx; p.y += p.vy; p.rot += p.vr;
        const alpha = 1 - p.life / p.maxLife;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.font = `${p.size}px serif`;
        ctx.fillText(emoji, 0, 0);
        ctx.restore();
      }
      if (!alive && particlesRef.current.length > 0) {
        particlesRef.current = []; ctx.clearRect(0, 0, w, h); return;
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [emoji, trigger]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "fixed", inset: 0, zIndex: 998,
        pointerEvents: "none", display: trigger > 0 ? "block" : "none",
      }}
    />
  );
});

// ============================================================
// CANVAS 9 — Welcome screen: Floating Bubbles
// ============================================================
const WelcomeCanvas = memo(function WelcomeCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    let w = 0, h = 0;
    const resize = () => {
      const rect = canvas.parentElement?.getBoundingClientRect();
      if (!rect) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = rect.width; h = rect.height;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    if (canvas.parentElement) ro.observe(canvas.parentElement);

    const bubbles = Array.from({ length: 14 }, () => ({
      x: Math.random(), y: Math.random(),
      r: 8 + Math.random() * 22,
      vy: -0.0002 - Math.random() * 0.0004,
      vx: (Math.random() - 0.5) * 0.0002,
      hue: 175 + Math.random() * 25,
      opacity: 0.08 + Math.random() * 0.12,
      phase: Math.random() * Math.PI * 2,
      speed: 0.003 + Math.random() * 0.005,
    }));

    let t = 0;
    const draw = () => {
      if (!w || !h) { rafRef.current = requestAnimationFrame(draw); return; }
      t += 1; ctx.clearRect(0, 0, w, h);
      for (const b of bubbles) {
        b.phase += b.speed;
        b.y += b.vy + Math.sin(b.phase * 0.5) * 0.0001;
        b.x += b.vx + Math.cos(b.phase * 0.3) * 0.00015;
        if (b.y < -0.1) { b.y = 1.1; b.x = Math.random(); }
        if (b.x < -0.1) b.x = 1.1; if (b.x > 1.1) b.x = -0.1;
        const px = b.x * w, py = b.y * h;
        const pr = Math.max(1, b.r + Math.sin(b.phase) * 3);
        const flicker = b.opacity * (0.6 + Math.sin(b.phase * 1.5) * 0.4);
        const g = ctx.createRadialGradient(px, py, 0, px, py, pr);
        g.addColorStop(0, `hsla(${b.hue}, 80%, 60%, ${flicker})`);
        g.addColorStop(0.6, `hsla(${b.hue}, 70%, 55%, ${flicker * 0.4})`);
        g.addColorStop(1, `hsla(${b.hue}, 60%, 50%, 0)`);
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
        // Outline
        ctx.strokeStyle = `hsla(${b.hue}, 80%, 60%, ${flicker * 0.5})`;
        ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.arc(px, py, pr * 0.8, 0, Math.PI * 2); ctx.stroke();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(rafRef.current); ro.disconnect(); };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
});

// ============================================================
// CANVAS 10 — Message Send Ripple (composer)
// ============================================================
const SendRippleCanvas = memo(function SendRippleCanvas({ trigger }: { trigger: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const ripplesRef = useRef<{ x: number; y: number; r: number; maxR: number; life: number; maxLife: number; }[]>([]);
  const lastTriggerRef = useRef(0);

  useEffect(() => {
    if (trigger === lastTriggerRef.current) return;
    lastTriggerRef.current = trigger;
    if (trigger === 0) return;
    const canvas = canvasRef.current; if (!canvas) return;
    const ctx = canvas.getContext("2d"); if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = 80, h = 80;
    canvas.width = w * dpr; canvas.height = h * dpr;
    canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ripplesRef.current.push({ x: w / 2, y: h / 2, r: 5, maxR: 50, life: 0, maxLife: 35 });
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      let alive = false;
      for (const r of ripplesRef.current) {
        r.life++;
        if (r.life >= r.maxLife) continue;
        alive = true;
        const progress = r.life / r.maxLife;
        r.r = 5 + (r.maxR - 5) * progress;
        const alpha = 1 - progress;
        ctx.strokeStyle = `hsla(188, 90%, 55%, ${alpha * 0.7})`;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = `hsla(188, 90%, 70%, ${alpha * 0.4})`;
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(r.x, r.y, r.r * 0.7, 0, Math.PI * 2); ctx.stroke();
      }
      if (!alive) { ripplesRef.current = []; ctx.clearRect(0, 0, w, h); return; }
      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [trigger]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute", top: "50%", left: "50%",
        transform: "translate(-50%, -50%)",
        pointerEvents: "none", zIndex: 0,
      }}
    />
  );
});
// ==================== COMPONENT ====================
export default function BloomMessaging({ currentUser }: MessagesPageProps) {
  const { logout: authLogout } = useAuth();
  const [chatFilter, setChatFilter] = useState<"all" | "unread" | "pending">("all");
  const [darkMode, setDarkMode] = useState(() => {
    try { return localStorage.getItem("bloom-dark-mode") === "true"; } catch { return false; }
  });
  const [fallingMode, setFallingMode] = useState<FallingMode>(() => {
    try { return (localStorage.getItem("bloom-falling-mode") as FallingMode) || "none"; } catch { return "none"; }
  });
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
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([]);
  const [messageInput, setMessageInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<MessageItem | null>(null);
  const [activeMessageMenu, setActiveMessageMenu] = useState<string | null>(null);
  const [isUploadingAttachment, setIsUploadingAttachment] = useState(false);
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
  const [customChatBackground, setCustomChatBackground] = useState(() => {
    try { return localStorage.getItem(CUSTOM_CHAT_BACKGROUND_STORAGE_KEY) || ""; }
    catch { return ""; }
  });
  const [chatBackgroundId, setChatBackgroundId] = useState(() => {
    try { return localStorage.getItem(CHAT_BACKGROUND_STORAGE_KEY) || "soft"; }
    catch { return "soft"; }
  });
  const [blockedUserIds, setBlockedUserIds] = useState<Set<string>>(() => new Set());
  const [isBlockLoading, setIsBlockLoading] = useState(false);

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
  const openedUrlUserRef = useRef<string | null>(null);
  const openingUrlUserRef = useRef<string | null>(null);
const [confettiTrigger, setConfettiTrigger] = useState(0);
const [emojiBurstTrigger, setEmojiBurstTrigger] = useState(0);
const [emojiBurstEmoji, setEmojiBurstEmoji] = useState("👍");
const [sendRippleTrigger, setSendRippleTrigger] = useState(0);
  const toId = (v: unknown) => (v == null ? "" : String(v));
  const currentUserId = toId(currentUser?.id);

  // Persist dark mode & falling mode
  useEffect(() => {
    try { localStorage.setItem("bloom-dark-mode", String(darkMode)); } catch {}
    document.documentElement.classList.toggle("bloom-dark", darkMode);
  }, [darkMode]);
  useEffect(() => {
    try { localStorage.setItem("bloom-falling-mode", fallingMode); } catch {}
  }, [fallingMode]);

  const toggleDarkMode = useCallback(() => setDarkMode(d => !d), []);
  const cycleFallingMode = useCallback(() => {
    setFallingMode(m => m === "none" ? "snow" : m === "snow" ? "sakura" : "none");
  }, []);
  const handleLogout = useCallback(() => {
    authLogout();
    toast.success("Đã đăng xuất");
  }, [authLogout]);

  useEffect(() => { conversationsRef.current = conversations; }, [conversations]);
  useEffect(() => { callSessionRef.current = callSession; }, [callSession]);
  useEffect(() => { selectedChatIdRef.current = selectedChatId; }, [selectedChatId]);
  useEffect(() => {
    setReplyingTo(null); setActiveMessageMenu(null); setShowReactionPicker(null);
    setShowComposerEmojiPicker(false); setShowComposerTools(false);
  }, [selectedChatId]);
  useEffect(() => {
    if (!currentUserId || conversations.length === 0) return;
    writeCache(chatListMemoryCache, `chat-list:${currentUserId}`, conversations);
  }, [conversations, currentUserId]);
  useEffect(() => {
    let cancelled = false;
    if (!currentUserId) {
      setBlockedUserIds(new Set());
      return () => { cancelled = true; };
    }
    void api.getBlockedUsers(0, 100)
      .then((res: any) => {
        if (cancelled) return;
        const rawList = Array.isArray(res) ? res : Array.isArray(res?.content) ? res.content : Array.isArray(res?.data) ? res.data : [];
        const ids = rawList
          .map((item: any) => toId(item?.id ?? item?.userId ?? item?.blockedId ?? item?.blockedUserId ?? item?.blocked?.id ?? item?.blockedUser?.id))
          .filter(Boolean);
        setBlockedUserIds(new Set(ids));
      })
      .catch(() => {
        if (!cancelled) setBlockedUserIds(new Set());
      });
    return () => { cancelled = true; };
  }, [currentUserId]);

  const dedupConversations = (list: ConversationItem[]) => {
    const map = new Map<string, ConversationItem>();
    list.forEach((c) => { const k = c.targetUserId ? String(c.targetUserId) : String(c.id); if (!map.has(k)) map.set(k, c); });
    return Array.from(map.values());
  };
  const getAvatarUrl = (url?: string, id?: string) => normalizeAvatarUrl(url, id || "default");
  const normalizeConvItem = (c: any): ConversationItem => ({
    id: toId(c.id), type: c.type || "direct", targetUserId: toId(c.targetUserId) || undefined,
    name: c.type === "group" ? (c.groupName || c.name || "Nhóm chat") : (c.targetUserName || c.name || "Người dùng"),
    avatar: c.targetUserAvatar || c.avatar, lastMessage: c.lastMessage || "Bắt đầu cuộc trò chuyện mới.",
    time: c.lastMessageTime ? formatVietnamTime(c.lastMessageTime) : (c.time || ""),
    unread: c.unreadCount ?? c.unread ?? 0, status: c.status || "accepted",
    isOnline: Boolean(c.targetIsOnline ?? c.isOnline), memberCount: c.memberCount,
    backgroundId: c.backgroundId || undefined, backgroundUrl: c.backgroundUrl || undefined,
  });
  const mergeConvUpdate = (list: ConversationItem[], inc: Partial<ConversationItem> & { id?: string }) => {
    const incId = toId(inc.id);
    if (!incId) return list;
    const idx = list.findIndex((c) => toId(c.id) === incId);
    if (idx === -1) return dedupConversations([normalizeConvItem(inc), ...list]);
    const next = [...list];
    next[idx] = { ...next[idx], ...inc, id: incId };
    return dedupConversations(next);
  };
  const getMsgKey = (m: MessageItem, i: number) => { const id = toId(m.id); if (id) return id; return `${toId(m.senderId)}:${toId(m.time)}:${i}`; };
  const dedupeMessages = (list: MessageItem[]) => {
    const seen = new Set<string>();
    return list.filter((m, i) => { const k = getMsgKey(m, i); if (!k || seen.has(k)) return false; seen.add(k); return true; });
  };
  const setConvMessages = (convId: string | null, value: MessageItem[] | ((prev: MessageItem[]) => MessageItem[])) => {
    messagesConversationIdRef.current = convId;
    setMessages((prev) => dedupeMessages(typeof value === "function" ? value(prev) : value));
  };
  const mapMessageItem = (m: any): MessageItem => ({
    id: toId(m.id) || Math.random().toString(),
    senderId: toId(m.senderId) === currentUserId ? "me" : toId(m.senderId),
    senderName: m.senderName, senderAvatar: m.senderAvatar,
    text: m.isDeleted ? "Tin nhắn đã được thu hồi" : (m.content || m.text || ""),
    time: formatVietnamTime(m.createdAt || Date.now()),
    createdAt: m.createdAt || new Date().toISOString(),
    deliveryStatus: "sent", isDeleted: Boolean(m.isDeleted), isEdited: Boolean(m.editedAt),
    replyToMessageId: m.replyToMessageId, attachmentUrl: m.attachmentUrl,
    attachmentName: m.attachmentName, attachmentSize: m.attachmentSize, messageType: m.messageType,
    reactions: m.reactions || {}, userReactions: m.userReactions || {},
  });
  const parsePayload = (d: any) => {
    if (!d) return null;
    if (typeof d === "object") return d;
    const s = String(d).trim();
    if (!s || s === "undefined" || s === "null") return null;
    try { return JSON.parse(s); } catch { return null; }
  };

  const clearCallTimers = () => {
    if (acceptCallTimeoutRef.current) { clearTimeout(acceptCallTimeoutRef.current); acceptCallTimeoutRef.current = null; }
    if (callDisconnectTimeoutRef.current) { clearTimeout(callDisconnectTimeoutRef.current); callDisconnectTimeoutRef.current = null; }
  };
  const markCallActive = (callId: string) => {
    clearCallTimers();
    setCallSession((p) => {
      if (!p || p.id !== callId) return p;
      const n = { ...p, status: "active" as CallStatus, startedAt: p.startedAt || Date.now(), error: null };
      callSessionRef.current = n; return n;
    });
  };
  const getConvPeerId = (conv?: Pick<ConversationItem, "id" | "targetUserId"> | null) => {
    if (!conv) return "";
    const t = toId(conv.targetUserId); if (t) return t;
    const id = toId(conv.id); return id.startsWith("new_") ? id.slice(4) : id;
  };
  const getEvtPeerId = (senderId?: unknown, receiverId?: unknown) => {
    const s = toId(senderId); const r = toId(receiverId);
    if (s && s === currentUserId) return r;
    if (r && r === currentUserId) return s;
    return s || r;
  };
  const resolveCallConvId = (peerId: string, preferred?: string | null) => {
    const p = toId(preferred); if (p && !p.startsWith("new_")) return p;
    const sel = toId(selectedChatIdRef.current);
    if (sel && !sel.startsWith("new_")) {
      const selConv = conversationsRef.current.find((c) => toId(c.id) === sel);
      if (selConv && getConvPeerId(selConv) === peerId) return sel;
    }
    const found = conversationsRef.current.find((c) => getConvPeerId(c) === peerId);
    return found && !found.id.startsWith("new_") ? found.id : "";
  };

  const selectedChat = useMemo(() => {
    if (!selectedChatId) return null;
    return [...conversations, ...searchResults.map((u) => ({ id: `new_${toId(u.id)}`, targetUserId: toId(u.id), name: u.name, avatar: u.avatar, status: "accepted", isOnline: Boolean(u.isOnline) }))].find((c) => c.id === selectedChatId);
  }, [conversations, searchResults, selectedChatId]);

  const selectedChatAvatar = selectedChat ? getAvatarUrl(selectedChat.avatar, getConvPeerId(selectedChat) || selectedChat.id) : "";
  const hasPersistedSelectedChat = Boolean(selectedChat && !selectedChat.id.startsWith("new_"));
  const effectiveChatBackgroundId = hasPersistedSelectedChat ? (selectedChat?.backgroundId || "soft") : (chatBackgroundId || "soft");
  const effectiveCustomChatBackground = hasPersistedSelectedChat ? (selectedChat?.backgroundUrl || "") : customChatBackground;
  const selectedChatBackground = CHAT_BACKGROUNDS.find((item) => item.id === effectiveChatBackgroundId) || CHAT_BACKGROUNDS[0];
  const normalizedCustomChatBackground = effectiveCustomChatBackground ? (normalizeAssetUrl(effectiveCustomChatBackground) || effectiveCustomChatBackground) : "";
  const cachedCustomChatBackground = useCachedSrc(normalizedCustomChatBackground, "");
  const selectedChatBackgroundValue = normalizedCustomChatBackground
    ? `linear-gradient(180deg, rgba(248,250,252,0.12) 0%, rgba(248,250,252,0.2) 62%, rgba(248,250,252,0.32) 100%), url("${cachedCustomChatBackground || IMAGE_PLACEHOLDER_SRC}") center/cover no-repeat`
    : selectedChatBackground.value;
  const selectedPeerId = selectedChat ? getConvPeerId(selectedChat) : "";
  const canBlockSelectedChat = Boolean(selectedChat && selectedChat.type !== "group" && selectedPeerId && selectedPeerId !== currentUserId);
  const selectedChatBlocked = Boolean(canBlockSelectedChat && blockedUserIds.has(selectedPeerId));

  const updateChatBackground = async (id: string) => {
    setChatBackgroundId(id);
    setCustomChatBackground("");
    const conversationId = selectedChat && !selectedChat.id.startsWith("new_") ? selectedChat.id : "";
    if (conversationId) {
      setConversations((prev) => mergeConvUpdate(prev, { id: conversationId, backgroundId: id, backgroundUrl: "" }));
      try {
        const res = await api.updateChatConversationBackground(conversationId, { backgroundId: id, backgroundUrl: "" });
        setConversations((prev) => mergeConvUpdate(prev, normalizeConvItem(res?.data || res)));
      } catch (error: any) {
        toast.error(error?.message || "KhÃ´ng thá»ƒ Ä‘á»•i ná»n há»™i thoáº¡i.");
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
      setConversations((prev) => mergeConvUpdate(prev, { id: conversationId, backgroundId: "custom", backgroundUrl: normalizedUrl }));
      try {
        const res = await api.updateChatConversationBackground(conversationId, { backgroundId: "custom", backgroundUrl: normalizedUrl });
        setConversations((prev) => mergeConvUpdate(prev, normalizeConvItem(res?.data || res)));
      } catch (error: any) {
        toast.error(error?.message || "KhÃ´ng thá»ƒ Ä‘á»•i ná»n há»™i thoáº¡i.");
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

  const loadChatsAndFriends = async (options: { force?: boolean; silent?: boolean } = {}) => {
    if (!currentUserId) { setIsLoadingChats(false); return; }
    const key = `chat-list:${currentUserId}`;
    const cached = options.force ? null : readCache(chatListMemoryCache, key, CHAT_LIST_CACHE_TTL_MS);
    if (cached) { setConversations(cached); setIsLoadingChats(false); return; }
    if (!options.silent) setIsLoadingChats(true);
    try {
      let convs: ConversationItem[] = [];
      try {
        const res = await api.getChatConversationsPage(0, 50);
        const raw = res?.content || [];
        convs = raw.map((c: any) => ({
          id: toId(c.id), type: c.type || "direct", targetUserId: toId(c.targetUserId) || undefined,
          name: c.type === "group" ? (c.groupName || "Nhóm chat") : (c.targetUserName || "Người dùng"),
          avatar: c.targetUserAvatar, lastMessage: c.lastMessage || "Bắt đầu cuộc trò chuyện mới.",
          time: c.lastMessageTime ? formatVietnamTime(c.lastMessageTime) : "",
          unread: c.unreadCount || 0, status: c.status || "accepted", isOnline: Boolean(c.targetIsOnline),
          memberCount: c.memberCount, backgroundId: c.backgroundId || undefined, backgroundUrl: c.backgroundUrl || undefined,
        }));
      } catch (e) { console.error(e); }
      const nextConversations = dedupConversations(convs);
      writeCache(chatListMemoryCache, key, nextConversations);
      setConversations(nextConversations);
    } finally { if (!options.silent) setIsLoadingChats(false); }
  };

  const scheduleChatsRefresh = () => {
    if (chatRefreshDebounceRef.current) return;
    chatRefreshDebounceRef.current = setTimeout(() => {
      chatRefreshDebounceRef.current = null;
      void loadChatsAndFriends({ force: true, silent: true });
    }, 1200);
  };

  const handleAcceptRequest = async () => {
  if (!selectedChat) return;
  setIsAcceptingRequest(true);
  const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;
  try {
    if (!convId) throw new Error("Không có id");
    const res = await api.acceptChatConversation(convId);
    const accepted = normalizeConvItem(res || {});
    setConversations((prev) => prev.map((c) => c.id === selectedChat.id ? { ...c, ...accepted, id: convId, status: "accepted", unread: c.unread } : c));
    await loadChatsAndFriends({ force: true });
    toast.success("Đã chấp nhận tin nhắn");
    setConfettiTrigger((t) => t + 1); // ✨ NEW: UI effect only
  } catch (error: any) {
    toast.error(error?.message || "Không thể chấp nhận tin nhắn.");
  } finally { setIsAcceptingRequest(false); }
};

  const handleRejectRequest = async () => {
    if (!selectedChat) return;
    const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;
    let succeeded = false;
    if (convId) { try { await api.rejectChatConversation(convId); succeeded = true; } catch {} }
    setConversations((prev) => prev.filter((c) => c.id !== selectedChat.id));
    setConvMessages(null, []);
    setSelectedChatId(null);
    if (succeeded) toast.success("Đã từ chối tin nhắn");
  };

  const sendCallSignal = (type: string, signalData: any = null, targetId: string, callId: string, callMode: CallMode) => {
    if (!stompClientRef.current?.connected) return;
    const convId = resolveCallConvId(targetId, callSessionRef.current?.id === callId ? callSessionRef.current.conversationId : undefined);
    stompClientRef.current.publish({ destination: "/app/chat.call", body: JSON.stringify({ callId, conversationId: convId, receiverId: targetId, type, callType: callMode, signalData }) });
  };

  const scheduleCallConnectTimeout = (callId: string) => {
    if (acceptCallTimeoutRef.current) clearTimeout(acceptCallTimeoutRef.current);
    acceptCallTimeoutRef.current = setTimeout(() => {
      const s = callSessionRef.current;
      if (!s || s.id !== callId || s.status !== "connecting") return;
      toast.error("Không kết nối được cuộc gọi.");
      closeCall(true);
    }, CALL_CONNECT_TIMEOUT_MS);
  };

  const logCallStatusToChat = (session: CallSession, reason: "ended" | "missed" | "rejected") => {
    if (!stompClientRef.current?.connected) return;
    const logText = reason === "rejected" ? (session.mode === "video" ? "📹 Đã từ chối cuộc gọi video" : "📞 Đã từ chối cuộc gọi thoại")
      : (session.elapsedSeconds === 0 || reason === "missed") ? (session.mode === "video" ? "📹 Cuộc gọi video nhỡ" : "📞 Cuộc gọi thoại nhỡ")
      : `📞 Cuộc gọi kết thúc. Thời lượng: ${formatCallDuration(session.elapsedSeconds)}`;
    const convId = resolveCallConvId(session.peerId, session.conversationId);
    if (!convId) return;
    stompClientRef.current.publish({ destination: "/app/chat.sendMessage", body: JSON.stringify({ conversationId: convId, receiverId: session.peerId, content: logText, messageType: "call_log" }) });
  };

  const createPeerConnection = (targetId: string, callId: string, callMode: CallMode) => {
    const pc = new RTCPeerConnection(iceServers);
    pc.onicecandidate = (e) => { if (e.candidate) sendCallSignal("ice-candidate", { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex }, targetId, callId, callMode); };
    pc.ontrack = (e) => {
      const stream = e.streams?.[0] || remoteStreamRef.current || new MediaStream();
      if (!e.streams?.[0] && !stream.getTracks().some((t) => t.id === e.track.id)) stream.addTrack(e.track);
      remoteStreamRef.current = stream;
      if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = stream; remoteVideoRef.current.muted = true; remoteVideoRef.current.play().catch(() => {}); }
      if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = stream; remoteAudioRef.current.volume = 1; remoteAudioRef.current.muted = !callSessionRef.current?.isSpeakerOn; remoteAudioRef.current.play().catch(() => {}); }
    };
    const handleState = () => {
      const state = pc.connectionState; const ice = pc.iceConnectionState;
      if (state === "connected" || ice === "connected" || ice === "completed") { markCallActive(callId); return; }
      if (state === "failed" || ice === "failed" || state === "disconnected" || ice === "disconnected") {
        if (callDisconnectTimeoutRef.current) clearTimeout(callDisconnectTimeoutRef.current);
        callDisconnectTimeoutRef.current = setTimeout(() => {
          if (peerConnectionRef.current !== pc) return;
          const cs = pc.connectionState; const ci = pc.iceConnectionState;
          if (cs === "connected" || ci === "connected" || ci === "completed") { markCallActive(callId); return; }
          const cur = callSessionRef.current;
          if (cur?.id === callId && cur.status === "connecting") return;
          if (cs === "failed" || ci === "failed" || cs === "disconnected" || ci === "disconnected") { toast.error("Kết nối cuộc gọi bị gián đoạn."); closeCall(true); }
        }, CALL_DISCONNECT_GRACE_MS);
        return;
      }
      if (callDisconnectTimeoutRef.current) { clearTimeout(callDisconnectTimeoutRef.current); callDisconnectTimeoutRef.current = null; }
    };
    pc.oniceconnectionstatechange = handleState;
    pc.onconnectionstatechange = handleState;
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current!));
    peerConnectionRef.current = pc; return pc;
  };

  const replaceLocalVideoTrack = (track: MediaStreamTrack) => {
    const sender = peerConnectionRef.current?.getSenders().find((s) => s.track?.kind === "video");
    sender?.replaceTrack(track).catch(() => toast.error("Không thể đổi nguồn video."));
    const audioTracks = localStreamRef.current?.getAudioTracks() || cameraStreamRef.current?.getAudioTracks() || [];
    localStreamRef.current?.getVideoTracks().forEach((t) => { if (t.id !== track.id) t.stop(); });
    localStreamRef.current = new MediaStream([...audioTracks, track]);
    if (localVideoRef.current) { localVideoRef.current.srcObject = new MediaStream([track]); localVideoRef.current.play().catch(() => {}); }
  };

  const stopScreenShare = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || !s.isScreenSharing) return;
    screenStreamRef.current?.getVideoTracks().forEach((t) => { t.onended = null; t.stop(); });
    screenStreamRef.current = null;
    try {
      const cs = await navigator.mediaDevices.getUserMedia({ video: { facingMode: s.cameraFacing }, audio: false });
      cameraStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      cameraStreamRef.current = cs;
      const [ct] = cs.getVideoTracks();
      if (ct) replaceLocalVideoTrack(ct);
      setCallSession((p) => p ? { ...p, isScreenSharing: false, isCameraOff: false } : p);
    } catch { toast.error("Không thể bật lại camera."); setCallSession((p) => p ? { ...p, isScreenSharing: false, isCameraOff: true } : p); }
  };

  const closeCall = (isLocal = true, isReject = false) => {
    clearCallTimers(); clearPendingCall();
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
    try { return await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" } }); }
    catch { const a = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false }); toast.warning("Camera không khả dụng, tiếp tục bằng micro."); return a; }
  };

  const startCall = async (mode: CallMode) => {
    if (!selectedChat) { toast.error("Hãy chọn một cuộc trò chuyện trước."); return; }
    if (selectedChat.status === "pending") { toast.error("Không thể gọi khi đang chờ phê duyệt."); return; }
    if (selectedChatBlocked) { toast.error("Báº¡n Ä‘ang cháº·n ngÆ°á»i dÃ¹ng nÃ y. HÃ£y bá» cháº·n Ä‘á»ƒ gá»i."); return; }
    closeCall(false); clearPendingCall();
    const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const targetId = getConvPeerId(selectedChat);
    if (!targetId) { toast.error("Không tìm thấy người nhận cuộc gọi."); return; }
    const convId = selectedChat.id.startsWith("new_") ? "" : selectedChat.id;
    const newSession: CallSession = { id: callId, mode, conversationId: convId, status: "connecting", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: mode === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: targetId, peerName: selectedChat.name, peerAvatar: selectedChatAvatar, hasMediaPermission: true, error: null };
    callSessionRef.current = newSession; setCallSession(newSession);
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Trình duyệt không hỗ trợ.");
      const stream = await getCallMediaStream(mode);
      localStreamRef.current = stream;
      if (mode === "video" && stream.getVideoTracks().length > 0) cameraStreamRef.current = stream.clone();
      if (localVideoRef.current) { localVideoRef.current.srcObject = stream; localVideoRef.current.play().catch(() => {}); }
      const pc = createPeerConnection(targetId, callId, mode);
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      sendCallSignal("start", null, targetId, callId, mode);
      sendCallSignal("offer", { type: offer.type, sdp: offer.sdp }, targetId, callId, mode);
      scheduleCallConnectTimeout(callId);
    } catch { toast.error("Không thể truy cập micro/camera."); closeCall(true); }
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
        const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
        sendCallSignal("answer", { type: ans.type, sdp: ans.sdp }, s.peerId, s.id, s.mode);
        markCallActive(s.id);
      }
    } catch (err: any) { toast.error(`Lỗi thiết bị: ${err.message}`); closeCall(true, true); }
  };

  useEffect(() => {
    if (!callSession || callSession.status !== "incoming") return;
    if (pendingAutoAcceptCallIdRef.current !== callSession.id) return;
    pendingAutoAcceptCallIdRef.current = null; void acceptCall();
  }, [callSession?.id, callSession?.status]);

  const rejectCall = () => closeCall(true, true);
  const toggleMute = () => setCallSession((p) => { if (!p) return p; const m = !p.isMuted; localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = !m)); return { ...p, isMuted: m }; });
  const toggleCamera = () => setCallSession((p) => { if (!p || p.mode !== "video") return p; const c = !p.isCameraOff; localStreamRef.current?.getVideoTracks().forEach((t) => (t.enabled = !c)); return { ...p, isCameraOff: c }; });
  const toggleScreenShare = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || s.status === "incoming") return;
    if (s.isScreenSharing) { await stopScreenShare(); return; }
    if (!navigator.mediaDevices?.getDisplayMedia) { toast.error("Trình duyệt không hỗ trợ chia sẻ màn hình."); return; }
    try {
      const ss = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      screenStreamRef.current = ss;
      const [st] = ss.getVideoTracks();
      if (!st) throw new Error("Không có màn hình được chọn.");
      st.onended = () => { if (callSessionRef.current?.isScreenSharing) void stopScreenShare(); };
      replaceLocalVideoTrack(st);
      setCallSession((p) => p ? { ...p, isScreenSharing: true, isCameraOff: false } : p);
    } catch (e: any) { toast.error(e?.message || "Không thể chia sẻ màn hình."); }
  };
  const switchCamera = async () => {
    const s = callSessionRef.current;
    if (!s || s.mode !== "video" || s.isScreenSharing) return;
    const nf = s.cameraFacing === "user" ? "environment" : "user";
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: nf }, audio: false });
      cameraStreamRef.current?.getVideoTracks().forEach((t) => t.stop());
      cameraStreamRef.current = stream;
      const [t] = stream.getVideoTracks();
      if (!t) throw new Error("Không tìm thấy camera.");
      replaceLocalVideoTrack(t);
      setCallSession((p) => p ? { ...p, cameraFacing: nf, isCameraOff: false } : p);
    } catch { toast.error("Thiết bị không có camera trước/sau."); }
  };
  const toggleSpeaker = () => setCallSession((p) => {
    if (!p) return p;
    const isSpeakerOn = !p.isSpeakerOn;
    if (remoteAudioRef.current) remoteAudioRef.current.muted = !isSpeakerOn;
    return { ...p, isSpeakerOn };
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
        const safe = (d: any) => {
          if (!d) return null;
          if (typeof d === "object") return d;
          const s = String(d).trim();
          if (!s || s === "undefined" || s === "null") return null;
          try { return JSON.parse(s); } catch { return null; }
        };
        const sub = (queue: string, handler: (f: any) => void) => {
          [`/user/queue/${queue}`, `/user/${currentUserId}/queue/${queue}`].forEach((dest) => client.subscribe(dest, handler));
        };

        sub("messages", (frame) => {
          const msg = safe(frame.body); if (!msg) return;
          const msgKey = toId(msg.id) || `${toId(msg.conversationId)}:${toId(msg.senderId)}:${toId(msg.createdAt)}:${toId(msg.content)}`;
          if (msgKey && realtimeMessageIdsRef.current.has(msgKey)) return;
          if (msgKey) {
            realtimeMessageIdsRef.current.add(msgKey);
            if (realtimeMessageIdsRef.current.size > 300) realtimeMessageIdsRef.current = new Set(Array.from(realtimeMessageIdsRef.current).slice(-150));
          }
          const convId = toId(msg.conversationId);
          const senderId = toId(msg.senderId);
          const receiverId = toId(msg.receiverId);
          const peerId = getEvtPeerId(senderId, receiverId);
          setConversations((prev) => {
            const updated = [...prev];
            let idx = updated.findIndex((c) => convId && toId(c.id) === convId);
            if (idx === -1) idx = updated.findIndex((c) => {
              if (!toId(c.id).startsWith("new_")) return false;
              const cPeerId = getConvPeerId(c);
              return (!c.type || c.type === "direct") && ((senderId === currentUserId && cPeerId === receiverId) || (receiverId === currentUserId && cPeerId === senderId));
            });
            if (idx > -1) {
              const conv = { ...updated[idx] };
              conv.lastMessage = msg.content;
              conv.time = formatVietnamTime(msg.createdAt);
              if (senderId !== currentUserId && toId(selectedChatIdRef.current) !== toId(conv.id)) conv.unread = (conv.unread || 0) + 1;
              if (toId(conv.id).startsWith("new_") && convId) {
                const prevPeerId = getConvPeerId(conv);
                conv.id = convId; conv.targetUserId = conv.targetUserId || prevPeerId || peerId;
                if (selectedChatIdRef.current === `new_${prevPeerId}` || selectedChatIdRef.current === `new_${peerId}`) setSelectedChatId(convId);
              }
              updated.splice(idx, 1); updated.unshift(conv); return dedupConversations(updated);
            }
            scheduleChatsRefresh(); return updated;
          });
          const selectedId = toId(selectedChatIdRef.current);
          if (convId && selectedId && toId(convId) === selectedId) {
            setConvMessages(convId, (prev) => {
              if (prev.some((m) => m.id === msg.id)) return prev;
              const clean = prev.filter((m) => !(m.id.startsWith("temp_") && m.text === msg.content));
              return [...clean, { id: msg.id, senderId: senderId === currentUserId ? "me" : senderId, senderName: msg.senderName, senderAvatar: msg.senderAvatar, text: msg.content, time: formatVietnamTime(msg.createdAt), createdAt: msg.createdAt || new Date().toISOString(), deliveryStatus: "sent", replyToMessageId: msg.replyToMessageId, attachmentUrl: msg.attachmentUrl, attachmentName: msg.attachmentName, attachmentSize: msg.attachmentSize, messageType: msg.messageType }];
            });
          }
        });

        sub("message-updates", (frame) => {
          const msg = safe(frame.body); if (!msg) return;
          if (toId(msg.conversationId) !== toId(messagesConversationIdRef.current)) return;
          setConvMessages(toId(msg.conversationId), (prev) => prev.map((item) => toId(item.id) !== toId(msg.id) ? item : { ...item, text: msg.isDeleted ? "Tin nhắn đã được thu hồi" : (msg.content || msg.text || item.text), isDeleted: Boolean(msg.isDeleted), isEdited: Boolean(msg.editedAt), time: msg.createdAt ? formatVietnamTime(msg.createdAt) : item.time }));
          setConversations((prev) => prev.map((c) => toId(c.id) === toId(msg.conversationId) ? { ...c, lastMessage: msg.isDeleted ? "Tin nhắn đã được thu hồi" : (msg.content || c.lastMessage) } : c));
        });

        sub("typing", (frame) => {
          const ev = safe(frame.body); if (!ev) return;
          const isTyping = ev.isTyping === true || ev.typing === true;
          const cKey = toId(ev.conversationId); const pId = getEvtPeerId(ev.senderId, ev.receiverId);
          setTypingUsers((prev) => { const next = { ...prev }; if (cKey) next[cKey] = isTyping; if (pId) next[`new_${pId}`] = isTyping; return next; });
        });

        sub("conversation-updates", (frame) => {
          const update = safe(frame.body); if (!update?.id) return;
          const partial: Partial<ConversationItem> & { id: string } = { id: toId(update.id) };
          if ("backgroundId" in update) partial.backgroundId = update.backgroundId || undefined;
          if ("backgroundUrl" in update) partial.backgroundUrl = update.backgroundUrl || undefined;
          if ("status" in update) partial.status = update.status || "accepted";
          if ("lastMessage" in update) partial.lastMessage = update.lastMessage || "";
          if ("lastMessageTime" in update) partial.time = update.lastMessageTime ? formatVietnamTime(update.lastMessageTime) : "";
          if ("targetIsOnline" in update) partial.isOnline = Boolean(update.targetIsOnline);
          if ("targetUserName" in update) partial.name = update.targetUserName || "";
          if ("groupName" in update) partial.name = update.groupName || "";
          if ("memberCount" in update) partial.memberCount = update.memberCount;
          setConversations((prev) => mergeConvUpdate(prev, partial));
        });

        sub("call", (frame) => {
          const ev = safe(frame.body); if (!ev) return;
          const { type, callId, callType, senderId, signalData } = ev;
          const sigKey = `${toId(callId)}:${toId(senderId)}:${toId(type)}:${typeof signalData === "string" ? signalData : JSON.stringify(signalData || "")}`;
          if (processedCallSignalsRef.current.has(sigKey)) return;
          processedCallSignalsRef.current.add(sigKey);
          if (processedCallSignalsRef.current.size > 500) processedCallSignalsRef.current = new Set(Array.from(processedCallSignalsRef.current).slice(-250));
          const parsed = safe(signalData);
          const nCallId = toId(callId); const nSenderId = toId(senderId);
          const mode: CallMode = callType === "audio" ? "audio" : "video";
          const activeCall = callSessionRef.current;
          if (type !== "start" && activeCall && activeCall.id !== nCallId) return;
          if (type === "start") {
            if (activeCall && activeCall.id !== nCallId) return;
            clearPendingCall();
            const caller = conversationsRef.current.find((c) => getConvPeerId(c) === toId(senderId));
            const incoming: CallSession = { id: callId, mode: callType, status: "incoming", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: callType === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: toId(senderId), peerName: caller?.name || "Người gọi", peerAvatar: caller?.avatar || getAvatarUrl("", senderId), hasMediaPermission: true, error: null };
            (incoming as any).conversationId = toId(ev.conversationId);
            callSessionRef.current = incoming; setCallSession(incoming);
          } else if (type === "offer" && parsed) {
            if (!callSessionRef.current) {
              clearPendingCall();
              const caller = conversationsRef.current.find((c) => getConvPeerId(c) === nSenderId);
              const incoming: CallSession = { id: nCallId, mode, conversationId: toId(ev.conversationId), status: "incoming", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: mode === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: nSenderId, peerName: ev.senderName || caller?.name || "Người gọi", peerAvatar: ev.senderAvatar || caller?.avatar || getAvatarUrl("", senderId), hasMediaPermission: true, error: null };
              callSessionRef.current = incoming; setCallSession(incoming);
            }
            incomingOfferRef.current = parsed;
            const pc = peerConnectionRef.current;
            if (pc && !pc.remoteDescription) {
              pc.setRemoteDescription(new RTCSessionDescription(parsed)).then(() => { iceCandidateQueueRef.current.forEach((c) => pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); iceCandidateQueueRef.current = []; return pc.createAnswer(); })
                .then((ans) => pc.setLocalDescription(ans)).then(() => { if (pc.localDescription) { sendCallSignal("answer", { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, toId(senderId), callId, callType); markCallActive(nCallId); } }).catch(console.error);
            }
          } else if (type === "answer" && parsed && peerConnectionRef.current) {
            clearPendingCall();
            if (acceptCallTimeoutRef.current) { clearTimeout(acceptCallTimeoutRef.current); acceptCallTimeoutRef.current = null; }
            peerConnectionRef.current.setRemoteDescription(new RTCSessionDescription(parsed)).then(() => { iceCandidateQueueRef.current.forEach((c) => peerConnectionRef.current?.addIceCandidate(new RTCIceCandidate(c)).catch(() => {})); iceCandidateQueueRef.current = []; }).catch(console.error);
            markCallActive(nCallId);
          } else if ((type === "ice-candidate" || type === "ice") && parsed) {
            if (peerConnectionRef.current?.remoteDescription) peerConnectionRef.current.addIceCandidate(new RTCIceCandidate(parsed)).catch(() => {});
            else iceCandidateQueueRef.current.push(parsed);
          } else if (type === "reject" || type === "end") {
            if (callSessionRef.current) toast.info(type === "reject" ? "Đã từ chối cuộc gọi" : "Cuộc gọi đã kết thúc");
            closeCall(false);
          }
        });

        sub("reactions", (frame) => {
          const reaction = safe(frame.body); if (!reaction) return;
          setConvMessages(messagesConversationIdRef.current, (prev) => prev.map((msg) => {
            if (msg.id !== reaction.messageId) return msg;
            const updated = { ...(msg.userReactions || {}) };
            if (reaction.action === "added") updated[reaction.emoji] = true; else delete updated[reaction.emoji];
            return { ...msg, reactions: reaction.reactions, userReactions: updated };
          }));
        });

        sub("online-status", (frame) => {
          const status = safe(frame.body); if (!status) return;
          const userId = toId(status.userId); if (!userId) return;
          setConversations((prev) => prev.map((c) => getConvPeerId(c) === userId ? { ...c, isOnline: Boolean(status.isOnline) } : c));
          setSearchResults((prev) => prev.map((u) => toId(u.id) === userId ? { ...u, isOnline: Boolean(status.isOnline) } : u));
        });

        sub("errors", (frame) => { const m = safe(frame.body) || frame.body; if (m) toast.error(String(m)); });
        client.publish({ destination: "/app/presence.ping", body: "{}" });
        const presenceTimer = window.setInterval(() => { if (client.connected) client.publish({ destination: "/app/presence.ping", body: "{}" }); }, 60000);
        (client as any).__presenceTimer = presenceTimer;
      },
    });
    client.activate(); stompClientRef.current = client;
    return () => {
      const pt = (client as any).__presenceTimer;
      if (pt) window.clearInterval(pt);
      if (client.active) client.deactivate();
    };
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    const onIncoming = (e: Event) => { const ev = (e as CustomEvent).detail; if (!ev || !currentUserId) return; const callId = toId(ev.callId); const senderId = toId(ev.senderId); if (!callId || !senderId || senderId === currentUserId) return; if (ev.autoAccept) pendingAutoAcceptCallIdRef.current = callId; const active = callSessionRef.current; if (active && active.id !== callId) return; const parsed = parsePayload(ev.offer || (ev.type === "offer" ? ev.signalData : null)); if (parsed) incomingOfferRef.current = parsed; const storedCands = Array.isArray(ev.candidates) ? ev.candidates : []; if (storedCands.length > 0) iceCandidateQueueRef.current = storedCands; if (active?.id === callId) return; const mode: CallMode = ev.callType === "audio" ? "audio" : "video"; const caller = conversationsRef.current.find((c) => getConvPeerId(c) === senderId); const incoming: CallSession = { id: callId, mode, conversationId: toId(ev.conversationId), status: "incoming", startedAt: null, elapsedSeconds: 0, isMuted: false, isCameraOff: mode === "audio", isScreenSharing: false, cameraFacing: "user", isSpeakerOn: true, peerId: senderId, peerName: ev.senderName || caller?.name || "Người gọi", peerAvatar: ev.senderAvatar || caller?.avatar || getAvatarUrl("", senderId), hasMediaPermission: true, error: null }; callSessionRef.current = incoming; setCallSession(incoming); };
    window.addEventListener(INCOMING_CALL_EVENT, onIncoming);
    const pendingCall = readPendingCall<any>();
    if (pendingCall) { onIncoming(new CustomEvent(INCOMING_CALL_EVENT, { detail: pendingCall })); clearPendingCall(); }
    return () => window.removeEventListener(INCOMING_CALL_EVENT, onIncoming);
  }, [currentUserId]);

  useEffect(() => {
    if (!currentUserId) return;
    loadChatsAndFriends();
    const t = window.setInterval(() => loadChatsAndFriends({ silent: true }), 60000);
    return () => window.clearInterval(t);
  }, [currentUserId]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, typingUsers]);

  useEffect(() => {
    if (!callSession || callSession.status !== "active" || !callSession.startedAt) return;
    const t = setInterval(() => setCallSession((p) => p?.startedAt ? { ...p, elapsedSeconds: Math.floor((Date.now() - p.startedAt) / 1000) } : p), 1000);
    return () => clearInterval(t);
  }, [callSession?.status, callSession?.startedAt]);

  useEffect(() => {
    const stream = remoteStreamRef.current;
    if (!callSession || callSession.status === "incoming" || !stream) return;
    if (remoteVideoRef.current) { remoteVideoRef.current.srcObject = stream; remoteVideoRef.current.muted = true; remoteVideoRef.current.play().catch(() => {}); }
    if (remoteAudioRef.current) { remoteAudioRef.current.srcObject = stream; remoteAudioRef.current.volume = 1; remoteAudioRef.current.muted = !callSession.isSpeakerOn; remoteAudioRef.current.play().catch(() => {}); }
  }, [callSession?.id, callSession?.status, callSession?.isSpeakerOn]);

  useEffect(() => {
    return () => {
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      if (chatRefreshDebounceRef.current) clearTimeout(chatRefreshDebounceRef.current);
      if (audioRecorderRef.current) { audioRecorderRef.current.ondataavailable = null; audioRecorderRef.current.onstop = null; if (audioRecorderRef.current.state !== "inactive") audioRecorderRef.current.stop(); }
      audioStreamRef.current?.getTracks().forEach((t) => t.stop());
      closeCall(false);
    };
  }, []);

  useEffect(() => {
    const sequence = ++userSearchSequenceRef.current;
    if (!userSearchQuery.trim()) { setSearchResults([]); return; }
    const t = setTimeout(async () => {
      setIsSearching(true);
      try { const r = await api.searchUsersToChat(userSearchQuery); if (sequence === userSearchSequenceRef.current) setSearchResults(r || []); }
      catch {} finally { if (sequence === userSearchSequenceRef.current) setIsSearching(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [userSearchQuery]);

  useEffect(() => {
    if (!selectedChatId) return;
    const convId = selectedChatId;
    if (convId.startsWith("new_")) { setOldestMessageCursor(null); setHasMoreMessages(false); setConvMessages(convId, []); return; }
    if (!currentUserId) return;
    let cancelled = false;
    const cacheKey = `messages:${currentUserId}:${convId}`;
    const cached = readCache(messagePageMemoryCache, cacheKey, MESSAGE_PAGE_CACHE_TTL_MS);
    const lastInitFetch = initialMessageFetchAtRef.current.get(cacheKey) || 0;
    const hasFreshFetch = Date.now() - lastInitFetch < 8000;
    if (cached) { setConvMessages(convId, cached.messages); setOldestMessageCursor(cached.oldestMessageCursor); setHasMoreMessages(cached.hasMoreMessages); setIsLoadingMessages(false); }
    else { setConvMessages(convId, []); setOldestMessageCursor(null); setHasMoreMessages(false); setIsLoadingMessages(true); }
    setConversations((prev) => prev.map((c) => c.id === convId ? { ...c, unread: 0 } : c));
    const selConv = conversationsRef.current.find((c) => toId(c.id) === convId);
    if (lastReadConversationRef.current !== convId || Number(selConv?.unread || 0) > 0) { lastReadConversationRef.current = convId; void api.markChatConversationRead(convId).catch(() => {}); }
    if (cached && hasFreshFetch) return () => { cancelled = true; };
    const fetchMessages = async () => {
      try {
        initialMessageFetchAtRef.current.set(cacheKey, Date.now());
        const res = await api.getChatMessagesPage(convId, INITIAL_MESSAGE_PAGE_SIZE);
        if (cancelled || selectedChatIdRef.current !== convId) return;
        const payload = res?.data || res;
        const list = Array.isArray(payload) ? payload : payload?.messages || [];
        const nextMessages = list.map(mapMessageItem);
        setOldestMessageCursor(Array.isArray(payload) ? null : (payload?.nextBeforeMessageId || null));
        setHasMoreMessages(Boolean(!Array.isArray(payload) && payload?.hasMore));
        setConvMessages(convId, nextMessages);
        writeCache(messagePageMemoryCache, cacheKey, { messages: nextMessages, oldestMessageCursor: Array.isArray(payload) ? null : (payload?.nextBeforeMessageId || null), hasMoreMessages: Boolean(!Array.isArray(payload) && payload?.hasMore) });
      } catch { if (!cached && !cancelled && selectedChatIdRef.current === convId) setConvMessages(convId, []); }
      finally { if (!cancelled && selectedChatIdRef.current === convId) setIsLoadingMessages(false); }
    };
    fetchMessages();
    return () => { cancelled = true; };
  }, [selectedChatId, currentUserId]);

  const loadOlderMessages = async () => {
    const convId = toId(selectedChatIdRef.current);
    if (!convId || convId.startsWith("new_") || !oldestMessageCursor || loadingOlderMessagesRef.current) return;
    loadingOlderMessagesRef.current = true;
    const sc = messagesScrollRef.current;
    const prevH = sc?.scrollHeight || 0; const prevT = sc?.scrollTop || 0;
    setIsLoadingOlderMessages(true);
    try {
      const res = await api.getChatMessagesPage(convId, OLDER_MESSAGE_PAGE_SIZE, oldestMessageCursor);
      if (toId(selectedChatIdRef.current) !== convId) return;
      const payload = res?.data || res;
      const list = payload?.messages || [];
      const older = list.map(mapMessageItem);
      setOldestMessageCursor(payload?.nextBeforeMessageId || null);
      setHasMoreMessages(Boolean(payload?.hasMore));
      setConvMessages(convId, (prev) => { const ids = new Set(prev.map((m) => m.id)); return [...older.filter((m: MessageItem) => !ids.has(m.id)), ...prev]; });
      window.requestAnimationFrame(() => { const cc = messagesScrollRef.current; if (!cc) return; cc.scrollTop = cc.scrollHeight - prevH + prevT; });
    } catch (error: any) { toast.error(error?.message || "Không thể tải tin nhắn cũ."); }
    finally { loadingOlderMessagesRef.current = false; setIsLoadingOlderMessages(false); }
  };

  const handleMessagesScroll = () => {
    const c = messagesScrollRef.current;
    if (!c || c.scrollTop > 120) return;
    if (hasMoreMessages && !isLoadingOlderMessages) void loadOlderMessages();
  };

  // ==================== SEND MESSAGE ====================
  const sendTextMessage = async (rawContent: string) => {
    const content = rawContent.trim();
    if (!content || !selectedChat) return;
    if (selectedChatBlocked) {
      toast.error("Báº¡n Ä‘ang cháº·n ngÆ°á»i dÃ¹ng nÃ y. HÃ£y bá» cháº·n Ä‘á»ƒ gá»­i tin nháº¯n.");
      return;
    }
    setMessageInput(""); setShowComposerEmojiPicker(false); setShowComposerTools(false);
    const selConvId = selectedChat.id;
    const curReply = replyingTo; setReplyingTo(null);
    const createdAt = new Date().toISOString();
    const opt: MessageItem = { id: `temp_${Date.now()}`, senderId: "me", text: content, time: formatVietnamTime(createdAt), createdAt, deliveryStatus: "sending", replyToMessageId: curReply?.id };
    setConvMessages(selConvId, (prev) => [...prev, opt]);
    setConversations((prev) => { const u = [...prev]; const idx = u.findIndex((c) => c.id === selConvId); if (idx > -1) { const c = { ...u[idx], lastMessage: `Bạn: ${content}`, time: opt.time }; u.splice(idx, 1); u.unshift(c); } return dedupConversations(u); });
    const payload = { conversationId: selConvId.startsWith("new_") ? "" : selConvId, receiverId: getConvPeerId(selectedChat), content, messageType: "text", replyToMessageId: curReply?.id };
    try {
      const saved = await api.sendChatMessage(payload);
      const savedConvId = toId(saved?.conversationId) || selConvId;
      const stillViewing = toId(selectedChatIdRef.current) === selConvId || toId(selectedChatIdRef.current) === savedConvId;
      if (selConvId.startsWith("new_") && savedConvId) { selectedChatIdRef.current = savedConvId; setSelectedChatId(savedConvId); }
      setConversations((prev) => {
        const u = [...prev];
        const idx = u.findIndex((c) => toId(c.id) === selConvId || toId(c.id) === savedConvId);
        if (idx < 0) return u;
        const conv = { ...u[idx], id: savedConvId, lastMessage: `Bạn: ${saved?.content || content}`, time: formatVietnamTime(saved?.createdAt || Date.now()) };
        u.splice(idx, 1); u.unshift(conv); return dedupConversations(u);
      });
      if (stillViewing) {
        const ack = mapMessageItem(saved);
        setConvMessages(savedConvId, (prev) => { const noTemp = prev.filter((m) => m.id !== opt.id); return noTemp.some((m) => m.id === ack.id) ? noTemp : [...noTemp, ack]; });
      }
    } catch (error: any) {
      if (toId(selectedChatIdRef.current) === selConvId) { setConvMessages(selConvId, (prev) => prev.filter((m) => m.id !== opt.id)); setMessageInput((c) => c || content); }
      void loadChatsAndFriends({ force: true, silent: true });
      toast.error(error?.message || "Không thể gửi tin nhắn.");
    }
    if (stompClientRef.current?.connected) stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify({ ...payload, isTyping: false, typing: false }) });
  };

  const handleSendMessage = (e: FormEvent) => { e.preventDefault(); void sendTextMessage(messageInput); };

  const handleEditMessage = async (msg: MessageItem) => {
    if (msg.senderId !== "me" || msg.isDeleted || msg.id.startsWith("temp_")) return;
    const content = window.prompt("Sửa tin nhắn", msg.text); if (content === null) return;
    const next = content.trim(); if (!next) return;
    try {
      const res = await api.editChatMessage(msg.id, next);
      const updated = res?.data || res || {};
      setConvMessages(messagesConversationIdRef.current, (prev) => prev.map((m) => m.id === msg.id ? { ...m, text: updated.content || next, isEdited: true } : m));
    } catch (e: any) { toast.error(e?.message || "Không thể sửa tin nhắn."); }
  };

  const handleRecallMessage = async (msg: MessageItem) => {
    if (msg.senderId !== "me" || msg.isDeleted || msg.id.startsWith("temp_")) return;
    if (!window.confirm("Thu hồi tin nhắn này?")) return;
    try {
      await api.deleteChatMessage(msg.id);
      setConvMessages(messagesConversationIdRef.current, (prev) => prev.map((m) => m.id === msg.id ? { ...m, text: "Tin nhắn đã được thu hồi", isDeleted: true } : m));
    } catch (e: any) { toast.error(e?.message || "Không thể thu hồi tin nhắn."); }
  };

  const handleCopyMessage = async (msg: MessageItem) => {
    try { await navigator.clipboard.writeText(msg.text || msg.attachmentUrl || ""); toast.success("Đã copy."); }
    catch { toast.error("Không thể copy."); }
  };

  const sendAttachmentMessage = async (file: File) => {
    if (!selectedChat) return;
    if (selectedChatBlocked) {
      toast.error("Báº¡n Ä‘ang cháº·n ngÆ°á»i dÃ¹ng nÃ y. HÃ£y bá» cháº·n Ä‘á»ƒ gá»­i file.");
      return;
    }
    setIsUploadingAttachment(true); setShowComposerTools(false);
    try {
      const uploaded = await api.uploadFile(file);
      const isImage = String(uploaded.type || file.type).startsWith("image/");
      const isAudio = String(uploaded.type || file.type).startsWith("audio/");
      const payload = { conversationId: selectedChat.id.startsWith("new_") ? "" : selectedChat.id, receiverId: getConvPeerId(selectedChat), content: isImage ? "Đã gửi một hình ảnh" : isAudio ? "Đã gửi một tin nhắn thoại" : `Đã gửi tệp: ${uploaded.name || file.name}`, messageType: isImage ? "image" : "text", attachmentUrl: uploaded.url, attachmentName: uploaded.name || file.name, attachmentSize: uploaded.size || file.size };
      const saved = await api.sendChatMessage(payload);
      const savedConvId = toId(saved?.conversationId) || selectedChat.id;
      if (toId(selectedChatIdRef.current) === selectedChat.id || toId(selectedChatIdRef.current) === savedConvId) {
        if (selectedChat.id.startsWith("new_") && savedConvId) { selectedChatIdRef.current = savedConvId; setSelectedChatId(savedConvId); }
        const ack = mapMessageItem(saved);
        setConvMessages(savedConvId, (prev) => prev.some((m) => m.id === ack.id) ? prev : [...prev, ack]);
      }
    } catch (e: any) { toast.error(e?.message || "Không thể gửi file."); }
    finally { setIsUploadingAttachment(false); }
  };

  const handleAttachmentChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; e.target.value = ""; if (file) void sendAttachmentMessage(file);
  };

  const handleChatBackgroundChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Chá»‰ chá»n áº£nh lÃ m ná»n há»™i thoáº¡i.");
      return;
    }
    try {
      const uploaded = await api.uploadFile(file);
      if (uploaded?.url) await updateCustomChatBackground(uploaded.url);
    } catch (error: any) {
      toast.error(error?.message || "KhÃ´ng thá»ƒ táº£i áº£nh ná»n.");
    }
  };

  const handleToggleBlockSelected = async () => {
    if (!canBlockSelectedChat || !selectedPeerId) return;
    const actionLabel = selectedChatBlocked ? "bá» cháº·n" : "cháº·n";
    if (!window.confirm(`Báº¡n muá»‘n ${actionLabel} ${selectedChat?.name || "ngÆ°á»i dÃ¹ng nÃ y"}?`)) return;
    setIsBlockLoading(true);
    try {
      if (selectedChatBlocked) {
        await api.unblockUser(selectedPeerId);
        setBlockedUserIds((prev) => {
          const next = new Set(prev);
          next.delete(selectedPeerId);
          return next;
        });
        toast.success("ÄÃ£ bá» cháº·n ngÆ°á»i dÃ¹ng.");
      } else {
        await api.blockUser(selectedPeerId);
        setBlockedUserIds((prev) => new Set(prev).add(selectedPeerId));
        setShowComposerEmojiPicker(false);
        setShowComposerTools(false);
        toast.success("ÄÃ£ cháº·n ngÆ°á»i dÃ¹ng.");
      }
      void loadChatsAndFriends({ force: true, silent: true });
    } catch (error: any) {
      toast.error(error?.message || `KhÃ´ng thá»ƒ ${actionLabel} ngÆ°á»i dÃ¹ng.`);
    } finally {
      setIsBlockLoading(false);
    }
  };

  const scrollToReplied = (msgId?: string) => {
    if (!msgId) return;
    const target = document.getElementById(`message-${msgId}`);
    if (!target) { toast.info("Tin nhắn gốc nằm trong phần lịch sử cũ."); return; }
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightedMessageId(msgId);
    window.setTimeout(() => setHighlightedMessageId((c) => c === msgId ? null : c), 1600);
  };

  const toggleAudioRecording = async () => {
    if (isRecordingAudio) { audioRecorderRef.current?.stop(); return; }
    if (selectedChatBlocked) {
      toast.error("Báº¡n Ä‘ang cháº·n ngÆ°á»i dÃ¹ng nÃ y. HÃ£y bá» cháº·n Ä‘á»ƒ gá»­i ghi Ã¢m.");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { toast.error("Trình duyệt này không hỗ trợ ghi âm."); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioStreamRef.current = stream; audioRecorderRef.current = recorder; audioChunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      recorder.onstop = () => {
        const mimeType = recorder.mimeType || "audio/webm";
        const ext = mimeType.includes("ogg") ? "ogg" : mimeType.includes("mp4") ? "m4a" : "webm";
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        audioStreamRef.current?.getTracks().forEach((t) => t.stop()); audioStreamRef.current = null; audioRecorderRef.current = null; audioChunksRef.current = [];
        setIsRecordingAudio(false);
        if (blob.size > 0) void sendAttachmentMessage(new File([blob], `ghi-am-${Date.now()}.${ext}`, { type: mimeType }));
      };
      recorder.start(); setShowComposerTools(false); setShowComposerEmojiPicker(false); setIsRecordingAudio(true);
    } catch { toast.error("Không thể mở micro."); }
  };

  const handleInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    setMessageInput(e.target.value);
    if (stompClientRef.current?.connected && selectedChat) {
      const payload = { conversationId: selectedChat.id.startsWith("new_") ? "" : selectedChat.id, receiverId: getConvPeerId(selectedChat), isTyping: true, typing: true };
      stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify(payload) });
      if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
      typingTimeoutRef.current = setTimeout(() => { stompClientRef.current?.connected && stompClientRef.current.publish({ destination: "/app/chat.typing", body: JSON.stringify({ ...payload, isTyping: false, typing: false }) }); }, 2000);
    }
  };

  const handleSelectChat = (chat: ConversationItem) => {
    const nextId = toId(chat.id); if (!nextId) return;
    setSelectedChatId(nextId); setShowInfo(false);
  };

  const handleCreateGroup = async () => {
    const memberIds = Array.from(new Set(groupMemberIds.filter(Boolean)));
    if (memberIds.length < 2) { toast.error("Chọn ít nhất 2 người."); return; }
    try {
      const res = await api.createChatConversation({ type: "group", groupName: groupName.trim() || "Nhóm chat", memberIds });
      const item = res?.data || res;
      const nextChat: ConversationItem = { id: toId(item.id), type: "group", name: item.groupName || groupName.trim() || "Nhóm chat", lastMessage: item.lastMessage || "Bắt đầu cuộc trò chuyện nhóm.", time: "", unread: 0, status: "accepted", memberCount: item.memberCount };
      setConversations((prev) => dedupConversations([nextChat, ...prev]));
      setConvMessages(nextChat.id, []);
      setSelectedChatId(nextChat.id);
      setShowCreateGroup(false); setGroupName(""); setGroupMemberIds([]);
      toast.success("Đã tạo nhóm chat.");
    } catch (e: any) { toast.error(e?.message || "Không thể tạo nhóm chat."); }
  };

  // ==================== COMPUTED ====================
  const isSearchMode = userSearchQuery.trim().length > 0;
  const inboxConvs = conversations.filter((c) => c.status === "accepted");
  const pendingConvs = conversations.filter((c) => c.status === "pending");
  const totalUnread = inboxConvs.reduce((s, c) => s + (c.unread || 0), 0);
  const onlineConvs = inboxConvs.filter((c) => c.isOnline).slice(0, 6);
  const displayList: ConversationItem[] = isSearchMode
    ? searchResults.map((u) => ({ id: `new_${toId(u.id)}`, targetUserId: toId(u.id), name: u.name, avatar: u.avatar, lastMessage: "Nhắn để mở cuộc trò chuyện.", time: "", unread: 0, isOnline: Boolean(u.isOnline), status: "accepted" }))
    : chatFilter === "all" ? conversations
    : chatFilter === "unread" ? conversations.filter((c) => (c.unread || 0) > 0)
    : pendingConvs;
  const isSelectedTyping = selectedChat ? Boolean(typingUsers[selectedChat.id] || (selectedPeerId && typingUsers[`new_${selectedPeerId}`])) : false;
  const selectedStatus = isSelectedTyping ? "Đang soạn tin nhắn..." : selectedChat?.isOnline ? "Đang hoạt động" : "Ngoại tuyến";

  // ==================== RENDER ====================
  return (
    <div className={`bloom-shell${selectedChat ? " has-chat" : ""}`}>
      {/* ── BACKGROUND ── */}
      <div className="bloom-bg-fixed" />
      <ParticleNetworkBackground />
<FallingEffectsCanvas mode={fallingMode} />
<ConfettiBurstCanvas trigger={confettiTrigger} />
<EmojiBurstCanvas emoji={emojiBurstEmoji} trigger={emojiBurstTrigger} />

      {/* ── CHAT LIST PANEL ── */}
      <div className="bloom-sidebar">
        {/* Sidebar Header */}
        <div className="bloom-sidebar-header">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="bloom-eyebrow">Bloom</div>
              <h1 className="bloom-title">Tin nhắn</h1>
            </div>
            <div className="flex gap-2">
              <GlassIconBtn onClick={() => setShowCreateGroup(true)} accent>
                <Plus size={15} />
              </GlassIconBtn>
              <GlassIconBtn>
                <Bell size={15} />
              </GlassIconBtn>
            </div>
          </div>

          {totalUnread > 0 && (
            <div className="bloom-unread-badge">
              <Sparkles size={13} className="text-cyan-500" />
              <span className="text-slate-700 text-xs">{totalUnread} tin chưa đọc</span>
              <span className="bloom-live-dot"><Wifi size={10} /> Live</span>
            </div>
          )}

          <div className="bloom-search-wrap">
            <Search size={14} className="bloom-search-icon" />
            <input
              type="text"
              placeholder="Tìm người dùng..."
              value={userSearchQuery}
              onChange={(e) => setUserSearchQuery(e.target.value)}
              className="bloom-search-input"
            />
          </div>

          <div className="flex gap-2">
            {[{ label: "Tất cả", value: "all" }, { label: `Chưa đọc${totalUnread > 0 ? ` (${totalUnread})` : ""}`, value: "unread" }, { label: `Chờ (${pendingConvs.length})`, value: "pending" }].map((tab) => (
              <button key={tab.value} type="button" onClick={() => setChatFilter(tab.value as any)} className={`bloom-filter-tab ${chatFilter === tab.value ? "active" : ""}`}>
                {tab.label}
              </button>
            ))}
          </div>

          {!isSearchMode && onlineConvs.length > 0 && (
            <div className="bloom-online-section">
              <span className="bloom-section-label">Đang hoạt động</span>
              <div className="bloom-online-list">
                {onlineConvs.map((c) => (
                  <button key={`online:${c.id}`} type="button" onClick={() => handleSelectChat(c)} className="bloom-online-item" title={c.name}>
                    <span className="bloom-online-avatar-wrap">
                      <CachedImage src={getAvatarUrl(c.avatar, c.targetUserId || c.id)} alt="" className="bloom-online-avatar" />
                      <i className="bloom-online-dot" />
                    </span>
                    <span className="bloom-online-name">{c.name.split(" ").slice(-1)[0]}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Conversation List */}
        <div className="bloom-conv-list">
          {isLoadingChats || isSearching ? (
            <div className="p-3 flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="bloom-conv-skeleton">
                  <div className="bloom-conv-skeleton-avatar" />
                  <div className="flex-1 flex flex-col gap-1.5">
                    <div className="bloom-conv-skeleton-line" style={{ width: "65%" }} />
                    <div className="bloom-conv-skeleton-line" style={{ width: "45%" }} />
                  </div>
                </div>
              ))}
            </div>
          ) : displayList.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Inbox size={36} className="mb-3 opacity-40" />
              <span className="text-sm">{isSearchMode ? "Không tìm thấy kết quả" : chatFilter === "pending" ? "Không có tin nhắn chờ" : "Chưa có hội thoại nào"}</span>
            </div>
          ) : (
            displayList.map((chat) => {
              const isActive = selectedChat?.id === chat.id;
              const isTyping = Boolean(typingUsers[chat.id]);
              return (
                <button
                  key={chat.id}
                  type="button"
                  onClick={() => handleSelectChat(chat)}
                  className={`bloom-conv-item ${isActive ? "active" : ""}`}
                >
                  <div className="bloom-conv-avatar-wrap">
                    <CachedImage src={getAvatarUrl(chat.avatar, chat.targetUserId || chat.id)} alt={chat.name} className="bloom-conv-avatar" />
                    {chat.isOnline && chat.status !== "pending" && <span className="bloom-status-dot online" />}
                    {chat.status === "pending" && <span className="bloom-status-dot pending" />}
                  </div>
                  <div className="bloom-conv-info">
                    <div className="flex justify-between items-start">
                      <span className="bloom-conv-name">{chat.name}</span>
                      <span className="bloom-conv-time">{chat.time}</span>
                    </div>
                    <div className="flex justify-between items-center mt-0.5">
                      <span className={`bloom-conv-preview ${isTyping ? "typing" : ""}`}>
                        {isTyping ? "Đang nhập..." : chat.status === "pending" ? "📨 Tin nhắn chờ" : (chat.lastMessage || "")}
                      </span>
                      {(chat.unread || 0) > 0 && <span className="bloom-unread-count">{chat.unread}</span>}
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>

        {/* ── iOS-STYLE BOTTOM DOCK ── */}
        <div className="bloom-dock">
          <button type="button" className="bloom-dock-item" onClick={toggleDarkMode}>
            <div className="bloom-dock-icon-wrap">{darkMode ? <Sun size={20} /> : <Moon size={20} />}</div>
            <span className="bloom-dock-label">{darkMode ? "Sáng" : "Tối"}</span>
          </button>
          <button type="button" className={`bloom-dock-item${fallingMode !== "none" ? " active" : ""}`} onClick={cycleFallingMode}>
            <div className="bloom-dock-icon-wrap">
              {fallingMode === "none" ? <Snowflake size={20} /> : fallingMode === "snow" ? <Flower2 size={20} /> : <X size={20} />}
            </div>
            <span className="bloom-dock-label">{fallingMode === "none" ? "Hiệu ứng" : fallingMode === "snow" ? "Tuyết" : "Hoa"}</span>
          </button>
          <button type="button" className="bloom-dock-item" onClick={handleLogout}>
            <div className="bloom-dock-icon-wrap"><LogOut size={20} /></div>
            <span className="bloom-dock-label">Thoát</span>
          </button>
        </div>
      </div>

      {/* ── MAIN CHAT ── */}
      <div className="bloom-main">
        {selectedChat ? (
          <>
            {/* Chat Header */}
            <div className="bloom-chat-header">
              <button type="button" onClick={() => { setConvMessages(null, []); setSelectedChatId(null); }} className="bloom-back-btn">
                <ChevronLeft size={18} />
              </button>
              <div className="relative">
                <CachedImage src={selectedChatAvatar} alt={selectedChat.name} className="bloom-header-avatar" />
                {selectedChat.isOnline && <span className="bloom-status-dot online" style={{ position: "absolute", bottom: 1, right: 1 }} />}
              </div>
              <div className="flex-1 min-w-0">
                <div className="bloom-header-name">{selectedChat.name}</div>
                <div className={`bloom-header-status ${selectedChat.isOnline || isSelectedTyping ? "online" : ""}`}>
                  {selectedChat.status === "pending" ? "⏳ Chờ phê duyệt" : selectedStatus}
                </div>
              </div>
              <div className="flex gap-2">
                <GlassIconBtn onClick={() => startCall("audio")}><Phone size={15} /></GlassIconBtn>
                <GlassIconBtn onClick={() => startCall("video")}><Video size={15} /></GlassIconBtn>
                <GlassIconBtn onClick={() => setShowInfo((p) => !p)} active={showInfo}><Info size={15} /></GlassIconBtn>
              </div>
            </div>

            <div className="bloom-chat-body">
              <div
                className="bloom-chat-workspace"
                data-custom-background={normalizedCustomChatBackground ? "true" : "false"}
                style={{ background: selectedChatBackgroundValue }}
              >
              {/* ── AMBIENT CANVAS BACKGROUND ── */}
              <ChatAmbientCanvas />
              {/* Messages */}
              <div
                ref={messagesScrollRef}
                className="bloom-messages-area"
                onScroll={handleMessagesScroll}
              >
                {isLoadingMessages && messages.length === 0 ? (
                  <div className="bloom-msg-loading">
                    {[false, true, false].map((isRight, i) => (
                      <div key={i} className={`bloom-msg-skeleton ${isRight ? "right" : ""}`}>
                        <div className="bloom-msg-skeleton-bubble" style={{ width: isRight ? 160 : 200 }} />
                      </div>
                    ))}
                  </div>
                ) : messages.length === 0 ? (
                  <div className="bloom-empty-state">
                    <CachedImage src={selectedChatAvatar} alt="" className="w-20 h-20 rounded-2xl object-cover mb-3" style={{ border: "2px solid rgba(6,182,212,0.35)" }} />
                    <div className="text-slate-800 font-bold text-lg">{selectedChat.name}</div>
                    <div className="text-slate-500 text-sm">Hãy nhắn tin trước để bắt đầu!</div>
                  </div>
                ) : (
                  <div className="bloom-msg-stream">
                    {hasMoreMessages && (
                      <div className="flex justify-center pb-3">
                        <button type="button" onClick={loadOlderMessages} disabled={isLoadingOlderMessages} className="bloom-load-more-btn">
                          {isLoadingOlderMessages && <Loader2 size={12} className="animate-spin" />}
                          Tải tin nhắn cũ hơn
                        </button>
                      </div>
                    )}
                    {messages.map((msg, idx) => {
                      const isMe = msg.senderId === "me";
                      const showAvatar = !isMe && (idx === messages.length - 1 || messages[idx + 1]?.senderId !== msg.senderId);
                      const repliedMsg = msg.replyToMessageId ? messages.find((m) => m.id === msg.replyToMessageId) : null;
                      const prevSame = idx > 0 && messages[idx - 1]?.senderId === msg.senderId;
                      const isTemp = msg.id.startsWith("temp_");
                      const attachIsAudio = Boolean(msg.attachmentUrl && isAudioAttachment(msg));
                      const effectiveMsgType = String(msg.messageType || "").toLowerCase();
                      const attachIsImage = Boolean(msg.attachmentUrl && (effectiveMsgType === "image" || isImageUrl(msg.attachmentUrl)));
                      const isGenCaption = Boolean(msg.attachmentUrl && (msg.text === "Đã gửi một hình ảnh" || msg.text === "Đã gửi một tin nhắn thoại" || msg.text.startsWith("Đã gửi tệp:")));
                      const showInlineImage = attachIsImage && !msg.isDeleted;
                      const visibleReactions = Object.entries(msg.reactions || {}).filter(([, count]) => count > 0);
                      const totalReactions = visibleReactions.reduce((t, [, c]) => t + c, 0);
                      const hasMyReaction = Object.values(msg.userReactions || {}).some(Boolean);
                      const isLatestOwnMsg = isMe && !messages.slice(idx + 1).some((m) => m.senderId === "me");
                      const showDate = idx === 0 || getMessageDateKey(messages[idx - 1]?.createdAt) !== getMessageDateKey(msg.createdAt);
                      const replyAuthor = repliedMsg?.senderId === "me" ? "Bạn" : (repliedMsg?.senderName || selectedChat.name);
                      return (
                        <div key={getMsgKey(msg, idx)} className="bloom-msg-entry">
                          {showDate && msg.createdAt && (
                            <div className="bloom-date-divider"><span>{formatMessageDateLabel(msg.createdAt)}</span></div>
                          )}
                          <div
                            id={`message-${msg.id}`}
                            className={`bloom-msg-row ${isMe ? "right" : "left"} ${highlightedMessageId === msg.id ? "highlighted" : ""}`}
                            style={{ marginTop: prevSame ? 2 : 8 }}
                            onMouseEnter={() => !msg.isDeleted && setHoveredMessageId(msg.id)}
                            onMouseLeave={() => setHoveredMessageId((c) => c === msg.id ? null : c)}
                          >
                            {!isMe && (
                              <div className="bloom-msg-avatar-slot">
                                {showAvatar
                                  ? <CachedImage src={selectedChatAvatar} alt="" className="bloom-msg-avatar" />
                                  : <div className="bloom-msg-avatar-spacer" />}
                              </div>
                            )}
                            <div className={`bloom-msg-group ${isMe ? "right" : "left"}`}>
                              {!isMe && selectedChat.type === "group" && msg.senderName && (
                                <div className="bloom-sender-name">{msg.senderName}</div>
                              )}

                              {msg.replyToMessageId && (
                                <div className={`bloom-reply-context ${isMe ? "right" : "left"}`}>
                                  <Reply size={11} className="flex-shrink-0" />
                                  <span>{isMe ? `Bạn đã trả lời ${repliedMsg?.senderId === "me" ? "chính bạn" : (repliedMsg?.senderName || selectedChat.name)}` : `${msg.senderName || selectedChat.name} đã trả lời`}</span>
                                </div>
                              )}

                              {msg.replyToMessageId && (
                                <button type="button" className={`bloom-reply-quote ${isMe ? "right" : "left"}`} onClick={() => scrollToReplied(msg.replyToMessageId)}>
                                  <span className="bloom-reply-author">{replyAuthor}</span>
                                  <span className="bloom-reply-text">{repliedMsg?.text || "Tin nhắn gốc"}</span>
                                </button>
                              )}

                              <div
                                className={`bloom-bubble ${isMe ? "mine" : "theirs"} ${msg.isDeleted ? "deleted" : ""}`}
                                onContextMenu={(e) => { e.preventDefault(); setShowReactionPicker(null); if (!msg.isDeleted) setActiveMessageMenu(activeMessageMenu === msg.id ? null : msg.id); }}
                                onDoubleClick={() => { if (!msg.isDeleted && !isTemp) handleToggleReaction(msg.id, "❤️"); }}
                              >
                                {msg.attachmentUrl && !msg.isDeleted && (
                                  showInlineImage
                                    ? <CachedImage className="bloom-img-attachment" src={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} alt={msg.attachmentName || ""} onClick={() => { const imgurl = normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl; if (imgurl) window.open(imgurl, '_blank'); }} />
                                    : attachIsAudio
                                      ? <div className="bloom-audio-attachment"><Mic size={14} /><audio controls preload="metadata" src={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} /></div>
                                      : <a className="bloom-file-attachment" href={normalizeAssetUrl(msg.attachmentUrl) || msg.attachmentUrl} target="_blank" rel="noreferrer"><FileText size={16} /><span>{msg.attachmentName || "Tệp đính kèm"}</span></a>
                                )}
                                {msg.text && !isGenCaption && <span className="bloom-msg-text">{msg.text}</span>}

                                {!msg.isDeleted && (
                                  <div className="bloom-bubble-meta">
                                    <span className="bloom-bubble-time">{msg.time}{msg.isEdited ? " · đã sửa" : ""}</span>
                                    {isLatestOwnMsg && (
                                      <span className="bloom-bubble-delivery">
                                        {msg.deliveryStatus === "sending" ? "..." : "✓"}
                                      </span>
                                    )}
                                  </div>
                                )}
                              </div>

                              {!msg.isDeleted && (
                                <div className={`bloom-msg-actions ${isMe ? "right" : "left"} ${hoveredMessageId === msg.id || activeMessageMenu === msg.id || showReactionPicker === msg.id ? "visible" : ""}`}>
                                  {!isTemp && (
                                    <button type="button" className="bloom-action-btn" title="Cảm xúc" onClick={(e) => { e.stopPropagation(); setActiveMessageMenu(null); setShowReactionPicker(showReactionPicker === msg.id ? null : msg.id); }}><Smile size={14} /></button>
                                  )}
                                  <button type="button" className="bloom-action-btn" title="Trả lời" onClick={() => { setReplyingTo(msg); setActiveMessageMenu(null); setShowReactionPicker(null); window.requestAnimationFrame(() => messageInputRef.current?.focus()); }}><Reply size={14} /></button>
                                  <button type="button" className="bloom-action-btn" title="Thêm" onClick={(e) => { e.stopPropagation(); setShowReactionPicker(null); setActiveMessageMenu(activeMessageMenu === msg.id ? null : msg.id); }}><MoreHorizontal size={14} /></button>
                                </div>
                              )}

                              {activeMessageMenu === msg.id && !msg.isDeleted && (
                                <div className={`bloom-ctx-menu ${isMe ? "right" : "left"}`}>
                                  <button type="button" onClick={() => { setActiveMessageMenu(null); handleCopyMessage(msg); }}><Copy size={13} /> Sao chép</button>
                                  <button type="button" onClick={() => { setActiveMessageMenu(null); setReplyingTo(msg); window.requestAnimationFrame(() => messageInputRef.current?.focus()); }}><Reply size={13} /> Trả lời</button>
                                  {isMe && !isTemp && (
                                    <>
                                      <button type="button" onClick={() => { setActiveMessageMenu(null); handleEditMessage(msg); }}><Pencil size={13} /> Sửa</button>
                                      <button type="button" className="danger" onClick={() => { setActiveMessageMenu(null); handleRecallMessage(msg); }}><Trash2 size={13} /> Thu hồi</button>
                                    </>
                                  )}
                                </div>
                              )}

                              {showReactionPicker === msg.id && !msg.isDeleted && !isTemp && (
                                <div className={`bloom-reaction-picker ${isMe ? "right" : "left"}`}>
                                  {REACTION_EMOJIS.map((emoji) => (
                                    <button key={`${msg.id}:${emoji}`} type="button" className={`bloom-reaction-opt ${msg.userReactions?.[emoji] ? "active" : ""}`} onClick={() => { handleToggleReaction(msg.id, emoji); setShowReactionPicker(null); }}>
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
                      <div className="flex items-end gap-2 mt-1 mb-2">
                        <CachedImage src={selectedChatAvatar} alt="" className="w-8 h-8 rounded-xl object-cover flex-shrink-0" />
                        <div className="bloom-typing-bubble">
                          {[0, 0.15, 0.3].map((delay, i) => <span key={i} className="bloom-typing-dot" style={{ animationDelay: `${delay}s` }} />)}
                        </div>
                      </div>
                    )}
                    <div ref={messagesEndRef} style={{ height: 8 }} />
                  </div>
                )}
              </div>

              {/* Input area */}
              {selectedChat.status === "pending" ? (
                <div className="bloom-pending-banner">
                  <div className="bloom-pending-card">
                    <ShieldAlert size={18} className="text-amber-400" />
                    <div className="bloom-pending-text">
                      <strong className="text-slate-800">{selectedChat.name}</strong> muốn nhắn tin với bạn.
                    </div>
                    <div className="flex gap-2 mt-3 justify-center">
                      <button type="button" onClick={handleRejectRequest} className="bloom-btn-danger-sm">✕ Từ chối</button>
                      <button type="button" onClick={handleAcceptRequest} disabled={isAcceptingRequest} className="bloom-btn-accent-sm">
                        {isAcceptingRequest ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Chấp nhận
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className={`bloom-composer ${isRecordingAudio ? "recording" : ""}`}>
                  {replyingTo && (
                    <div className="bloom-reply-preview">
                      <span className="bloom-reply-bar" />
                      <div className="bloom-reply-preview-copy">
                        <div className="text-blue-600 text-xs font-semibold">
                          Đang trả lời {replyingTo.senderId === "me" ? "chính bạn" : (replyingTo.senderName || selectedChat.name)}
                        </div>
                        <span className="text-slate-600 text-xs truncate">{replyingTo.text}</span>
                      </div>
                      <button type="button" onClick={() => setReplyingTo(null)} className="text-slate-400 hover:text-slate-700 ml-2"><X size={14} /></button>
                    </div>
                  )}

                  <input ref={attachmentInputRef} type="file" className="hidden" onChange={handleAttachmentChange} />
                  <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleAttachmentChange} />
                  <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={handleAttachmentChange} />
                  <input ref={chatBackgroundInputRef} type="file" accept="image/*" className="hidden" onChange={handleChatBackgroundChange} />

                  {showComposerTools && (
                    <div className="bloom-tools-popover">
                      {[
                        { icon: <FileText size={16} />, label: "Tệp", onClick: () => attachmentInputRef.current?.click() },
                        { icon: <ImageIcon size={16} />, label: "Ảnh", onClick: () => imageInputRef.current?.click() },
                        { icon: <Camera size={16} />, label: "Camera", onClick: () => cameraInputRef.current?.click() },
                        { icon: <Video size={16} />, label: "Video", onClick: () => startCall("video") },
                      ].map((t) => (
                        <button key={t.label} type="button" onClick={t.onClick} className="bloom-tools-item">
                          {t.icon} <span>{t.label}</span>
                        </button>
                      ))}
                    </div>
                  )}

                  {showComposerEmojiPicker && (
                    <div className="bloom-emoji-picker">
                      {COMPOSER_EMOJIS.map((emoji) => (
                        <button key={emoji} type="button" onClick={() => { setMessageInput((c) => `${c}${emoji}`); window.requestAnimationFrame(() => messageInputRef.current?.focus()); }} className="bloom-emoji-btn">{emoji}</button>
                      ))}
                    </div>
                  )}

                  {isRecordingAudio && (
                      <div className="bloom-recording-banner">
                        <span className="bloom-rec-dot" />
                        <VoiceWaveCanvas isActive={isRecordingAudio} />
                        <span className="text-slate-800 text-sm">Đang ghi âm...</span>
                        <button type="button" onClick={toggleAudioRecording} className="bloom-btn-stop-recording">Dừng và gửi</button>
                      </div>
                    )}

                  <form className="bloom-composer-form" onSubmit={handleSendMessage}>
                    <div className="bloom-composer-side-actions">
                      <button type="button" className={`bloom-composer-btn ${showComposerTools ? "active" : ""}`} onClick={() => { setShowComposerTools((c) => !c); setShowComposerEmojiPicker(false); }}>
                        {isUploadingAttachment ? <Loader2 size={18} className="animate-spin" /> : <Plus size={19} />}
                      </button>
                      <button type="button" className="bloom-composer-btn" onClick={() => cameraInputRef.current?.click()}><Camera size={18} /></button>
                      <button type="button" className="bloom-composer-btn" onClick={() => imageInputRef.current?.click()}><ImageIcon size={18} /></button>
                      <button type="button" className={`bloom-composer-btn ${isRecordingAudio ? "recording" : ""}`} onClick={toggleAudioRecording}>
                        {isRecordingAudio ? <MicOff size={18} /> : <Mic size={18} />}
                      </button>
                    </div>
                    <div className="bloom-input-field">
                      <input
                        ref={messageInputRef}
                        type="text"
                        value={messageInput}
                        onChange={handleInputChange}
                        onFocus={() => { window.setTimeout(() => messagesEndRef.current?.scrollIntoView({ block: "end" }), 120); setShowComposerTools(false); }}
                        placeholder="Nhắn tin..."
                        className="bloom-text-input"
                      />
                      <button type="button" className={`bloom-emoji-toggle ${showComposerEmojiPicker ? "active" : ""}`} onClick={() => { setShowComposerEmojiPicker((c) => !c); setShowComposerTools(false); }}>
                        <Smile size={19} />
                      </button>
                    </div>
                     {messageInput.trim()
                      ? (
                        <button
                          type="submit"
                          className="bloom-send-btn"
                          onClick={() => setSendRippleTrigger((t) => t + 1)}
                        >
                          <Send size={18} />
                          <SendRippleCanvas trigger={sendRippleTrigger} />
                        </button>
                      )
                      : (
                        <button
                          type="button"
                          className="bloom-like-btn"
                          onClick={() => {
                            setEmojiBurstEmoji("👍");
                            setEmojiBurstTrigger((t) => t + 1);
                            void sendTextMessage("👍");
                          }}
                        >
                          <ThumbsUp size={21} />
                        </button>
                      )
                    }
                  </form>
                </div>
              )}
            </div>

            {/* Info Panel */}
            {showInfo && (
              <div className="bloom-info-panel">
                <div className="bloom-info-header">
                  <span className="text-slate-800 font-semibold text-sm">Thông tin</span>
                  <button type="button" onClick={() => setShowInfo(false)} className="text-slate-400 hover:text-slate-700"><X size={15} /></button>
                </div>
                <div className="bloom-info-scroll">
                  <div className="bloom-info-profile">
                    <CachedImage src={selectedChatAvatar} alt={selectedChat.name} className="w-16 h-16 rounded-2xl object-cover mx-auto mb-3" style={{ border: "2px solid rgba(59,130,246,0.3)" }} />
                    <div className="text-slate-800 font-bold text-center">{selectedChat.name}</div>
                    <div className="text-center text-xs mt-1" style={{ color: selectedChat.isOnline ? "#22c55e" : "rgba(15,23,42,0.4)" }}>
                      {selectedChat.isOnline ? "🟢 Đang hoạt động" : "⭕ Ngoại tuyến"}
                    </div>
                  </div>

                  <div className="bloom-info-quick-actions">
                    {[
                      { icon: <Phone size={14} />, label: "Gọi thoại", onClick: () => startCall("audio") },
                      { icon: <Video size={14} />, label: "Video call", onClick: () => startCall("video") },
                      { icon: <UserIcon size={14} />, label: "Trang cá nhân", onClick: () => {} },
                    ].map((a) => (
                      <button key={a.label} type="button" onClick={a.onClick} className="bloom-info-action">
                        <span className="text-blue-500">{a.icon}</span>
                        <span className="text-slate-600 text-xs">{a.label}</span>
                      </button>
                    ))}
                  </div>

                  {selectedChat.status === "pending" && (
                    <div className="bloom-pending-info">
                      <div className="text-amber-400 font-semibold text-xs mb-2">Tin nhắn chờ</div>
                      <div className="flex gap-2">
                        <button type="button" onClick={handleRejectRequest} className="bloom-btn-danger-sm flex-1">Từ chối</button>
                        <button type="button" onClick={handleAcceptRequest} disabled={isAcceptingRequest} className="bloom-btn-accent-sm flex-1">
                          {isAcceptingRequest ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Chấp nhận
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
            </div>
          </>
        ) : (
            <div className="bloom-welcome">
              <WelcomeCanvas />
              <div className="bloom-welcome-icon">
                <MessageCircle size={36} className="text-cyan-500" />
              </div>
              <div className="text-slate-800 font-bold text-xl mb-2">Kết nối và chia sẻ</div>
              <div className="text-slate-500 text-sm">Chọn một hội thoại hoặc tìm người bạn muốn nhắn tin.</div>
              <div className="bloom-welcome-features">
                <span><ShieldAlert size={12} /> Phiên bảo mật</span>
                <span><Wifi size={12} /> Realtime</span>
                <span><Users size={12} /> Nhóm chat</span>
              </div>
            </div>
          )}
      </div>

      {/* ── CALL MODAL ── */}
      {callSession && (
        <div className="bloom-call-overlay">
          <div className="bloom-call-window">
            <div className="bloom-call-bg" />
            <div className="bloom-call-header">
              <div className="flex items-center gap-2 text-slate-500 text-xs">
                {callSession.mode === "video" ? <Camera size={13} /> : <Phone size={13} />}
                <span>{callSession.mode === "video" ? "Video call" : "Cuộc gọi thoại"}</span>
              </div>
              <button type="button" onClick={() => closeCall(true)} className="text-slate-400 hover:text-slate-800"><X size={18} /></button>
            </div>

            {callSession.mode === "video" && callSession.status !== "incoming" ? (
              <div className="bloom-video-stage">
                <CachedImage src={callSession.peerAvatar} alt="" className="bloom-video-fallback" />
                <video ref={remoteVideoRef} autoPlay muted playsInline className="bloom-remote-video" />
                <div className="bloom-local-video-wrap">
                  <video ref={localVideoRef} autoPlay muted playsInline className="bloom-local-video" />
                  {callSession.isCameraOff && <div className="bloom-camera-off"><VideoOff size={16} /></div>}
                </div>
                <div className="bloom-video-status">
                  <span className="bloom-live-dot-anim" />
                  {callSession.status === "connecting" ? "Đang kết nối..." : formatCallDuration(callSession.elapsedSeconds)}
                </div>
              </div>
            ) : (
              <div className="bloom-call-identity">
                <div className="bloom-call-avatar-shell">
                  <span className="bloom-pulse-ring pulse-1" />
                  <span className="bloom-pulse-ring pulse-2" />
                  <CachedImage className="bloom-call-avatar" src={callSession.peerAvatar} alt={callSession.peerName} />
                  <span className="bloom-call-mode-badge">
                    {callSession.mode === "video" ? <Video size={15} /> : <Phone size={15} />}
                  </span>
                </div>
                {callSession.mode === "audio" && callSession.status === "active" && (
                  <div className="bloom-audio-wave">{Array.from({ length: 7 }).map((_, i) => <span key={i} style={{ animationDelay: `${i * 0.1}s` }} />)}</div>
                )}
              </div>
            )}

            <div className="bloom-call-participant">
              <h2 className="text-slate-800 font-bold text-xl">{callSession.peerName}</h2>
              <p className="text-slate-500 text-sm mt-1">
                {callSession.status === "incoming" ? `${callSession.mode === "video" ? "Video call" : "Cuộc gọi"} đang đến`
                  : callSession.status === "connecting" ? "Đang thiết lập kết nối..."
                  : `Đang gọi · ${formatCallDuration(callSession.elapsedSeconds)}`}
              </p>
            </div>

            {callSession.status !== "incoming" && <audio ref={remoteAudioRef} autoPlay playsInline />}

            {callSession.status === "incoming" ? (
              <div className="bloom-call-incoming-actions">
                <button type="button" className="bloom-call-decline" onClick={rejectCall}><span className="bloom-call-btn-icon"><PhoneOff size={22} /></span> Từ chối</button>
                <button type="button" className="bloom-call-answer" onClick={acceptCall}><span className="bloom-call-btn-icon">{callSession.mode === "video" ? <Video size={22} /> : <Phone size={22} />}</span> Trả lời</button>
              </div>
            ) : (
              <div className="bloom-call-controls">
                {[
                  { icon: callSession.isMuted ? MicOff : Mic, label: callSession.isMuted ? "Bật mic" : "Tắt mic", onClick: toggleMute, active: callSession.isMuted },
                  ...(callSession.mode === "video" ? [{ icon: callSession.isCameraOff ? VideoOff : Video, label: "Camera", onClick: toggleCamera, active: callSession.isCameraOff }] : []),
                  ...(callSession.mode === "video" ? [{ icon: callSession.isScreenSharing ? ScreenShareOff : ScreenShare, label: "Màn hình", onClick: toggleScreenShare, active: callSession.isScreenSharing }] : []),
                  ...(callSession.mode === "video" ? [{ icon: SwitchCamera, label: "Đổi camera", onClick: switchCamera, active: false }] : []),
                  { icon: Volume2, label: "Loa", onClick: toggleSpeaker, active: !callSession.isSpeakerOn },
                ].map((btn) => (
                  <button key={btn.label} type="button" className={`bloom-call-ctrl ${btn.active ? "active" : ""}`} onClick={btn.onClick} title={btn.label}>
                    <btn.icon size={19} />
                  </button>
                ))}
                <button type="button" className="bloom-call-hangup" onClick={() => closeCall(true)} title="Kết thúc"><PhoneOff size={19} /></button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CREATE GROUP MODAL ── */}
      {showCreateGroup && (
        <div className="bloom-modal-backdrop">
          <div className="bloom-group-modal">
            <div className="bloom-group-modal-header">
              <span className="text-slate-800 font-bold">Tạo nhóm chat</span>
              <button type="button" onClick={() => setShowCreateGroup(false)} className="text-slate-400 hover:text-slate-800"><X size={16} /></button>
            </div>
            <div className="p-4">
              <input
                value={groupName}
                onChange={(e) => setGroupName(e.target.value)}
                placeholder="Tên nhóm"
                className="bloom-group-name-input"
              />
              <div className="max-h-64 overflow-y-auto flex flex-col gap-1.5 mt-3">
                {dedupConversations([
                  ...conversations.filter((c) => c.type !== "group" && getConvPeerId(c)),
                  ...searchResults.map((u) => ({ id: `new_${toId(u.id)}`, targetUserId: toId(u.id), name: u.name, avatar: u.avatar, status: "accepted" })),
                ]).map((item) => {
                  const peerId = getConvPeerId(item);
                  if (!peerId) return null;
                  const checked = groupMemberIds.includes(peerId);
                  return (
                    <label key={peerId} className={`bloom-group-member-item ${checked ? "checked" : ""}`}>
                      <input type="checkbox" checked={checked} onChange={(e) => setGroupMemberIds((prev) => e.target.checked ? [...prev, peerId] : prev.filter((id) => id !== peerId))} className="sr-only" />
                      <CachedImage src={getAvatarUrl(item.avatar, peerId)} alt="" className="w-9 h-9 rounded-xl object-cover" />
                      <span className="text-slate-700 font-medium text-sm">{item.name}</span>
                      {checked && <Check size={14} className="ml-auto text-cyan-500" />}
                    </label>
                  );
                })}
              </div>
              <button type="button" onClick={handleCreateGroup} className="bloom-create-group-btn mt-3">
                Tạo nhóm ({groupMemberIds.length} thành viên)
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── GLOBAL STYLES ── */}
      <style>{`
        :root {
          --accent: #3b82f6;
          --accent-grad: linear-gradient(135deg, #3b82f6, #60a5fa);
          --text-primary: rgba(15, 23, 42, 0.9);
          --text-secondary: rgba(15, 23, 42, 0.6);
          --text-tertiary: rgba(15, 23, 42, 0.4);
          --border-color: rgba(15, 23, 42, 0.08);
          --glass-bg: rgba(255, 255, 255, 0.45);
          --glass-hover: rgba(255, 255, 255, 0.65);
          --glass-active: rgba(59, 130, 246, 0.12);
        }

        @keyframes bounce { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-4px); } }
        @keyframes pulse { 0%,100% { opacity: 0.5; transform: scale(1); } 50% { opacity: 0.2; transform: scale(1.4); } }
        @keyframes waveBar { 0%,100% { height: 4px; } 50% { height: 20px; } }
        @keyframes shimmer { 0% { background-position: -200px 0; } 100% { background-position: calc(200px + 100%) 0; } }

        .bloom-shell {
          display: flex;
          width: 100%;
          height: 100%;
          min-height: 0;
          overflow: hidden;
          position: relative;
          font-family: Inter, system-ui, sans-serif;
          color: var(--text-primary);
        }
        .bloom-bg-fixed {
          position: fixed;
          inset: 0;
          z-index: -1;
          background: linear-gradient(135deg, #f9fdff 0%, #edf9fb 42%, #f7fcff 100%);
        }

        /* SIDEBAR */
        .bloom-sidebar {
          width: 300px; min-width: 260px; max-width: 320px;
          display: flex; flex-direction: column; height: 100%; min-height: 0;
          background: var(--glass-bg);
          border-right: 1px solid var(--border-color);
          backdrop-filter: blur(20px);
        }
        .bloom-sidebar-header { padding: 14px 14px 10px; flex-shrink: 0; border-bottom: 1px solid var(--border-color); }
        .bloom-eyebrow { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.12em; color: var(--accent); }
        .bloom-title { font-size: 20px; font-weight: 800; color: var(--text-primary); margin: 0; line-height: 1.2; }

        .bloom-unread-badge {
          display: flex; align-items: center; gap: 6px;
          background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.15);
          border-radius: 10px; padding: 6px 10px; margin-bottom: 10px;
          color: var(--text-primary);
        }
        .bloom-live-dot {
          display: flex; align-items: center; gap: 4px;
          margin-left: auto; font-size: 10px; color: #22c55e; font-weight: 700;
        }

        .bloom-search-wrap {
          position: relative; margin-bottom: 10px;
        }
        .bloom-search-icon {
          position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
          color: var(--text-tertiary); pointer-events: none;
        }
        .bloom-search-input {
          width: 100%; height: 36px; border-radius: 12px;
          background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color);
          color: var(--text-primary); font-size: 13px;
          padding: 0 12px 0 32px; outline: none; box-sizing: border-box;
        }
        .bloom-search-input::placeholder { color: var(--text-tertiary); }
        .bloom-search-input:focus { border-color: rgba(59, 130, 246, 0.4); background: rgba(255, 255, 255, 0.85); }

        .bloom-filter-tab {
          flex: 1; padding: 5px 8px; border-radius: 10px; border: none; cursor: pointer;
          font-size: 11px; font-weight: 600; color: var(--text-tertiary);
          background: transparent; transition: all 0.15s;
        }
        .bloom-filter-tab.active {
          background: rgba(59, 130, 246, 0.12); color: #2563eb;
          border: 1px solid rgba(59, 130, 246, 0.2);
        }

        .bloom-section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); }
        .bloom-online-section { margin-top: 10px; }
        .bloom-online-list { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; }
        .bloom-online-item { display: flex; flex-direction: column; align-items: center; gap: 3px; background: transparent; border: none; cursor: pointer; }
        .bloom-online-avatar-wrap { position: relative; }
        .bloom-online-avatar { width: 38px; height: 38px; border-radius: 12px; object-fit: cover; }
        .bloom-online-dot { position: absolute; bottom: 1px; right: 1px; width: 9px; height: 9px; border-radius: 50%; background: #22c55e; border: 2px solid #ffffff; display: block; }
        .bloom-online-name { font-size: 10px; color: var(--text-secondary); max-width: 38px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

        .bloom-conv-list { flex: 1; overflow-y: auto; padding: 6px; }
        .bloom-conv-list::-webkit-scrollbar { width: 3px; }
        .bloom-conv-list::-webkit-scrollbar-track { background: transparent; }
        .bloom-conv-list::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, 0.1); border-radius: 2px; }

        /* iOS-STYLE BOTTOM DOCK */
        .bloom-dock {
          flex-shrink: 0;
          display: flex;
          justify-content: center;
          gap: 4px;
          padding: 8px 12px 12px;
          background: linear-gradient(180deg, transparent 0%, rgba(255,255,255,0.08) 60%);
          border-top: 1px solid rgba(15, 23, 42, 0.06);
        }
        .bloom-dock-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 3px;
          padding: 8px 16px;
          border: none;
          border-radius: 18px;
          background: transparent;
          color: rgba(15, 23, 42, 0.4);
          cursor: pointer;
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          position: relative;
          -webkit-tap-highlight-color: transparent;
        }
        .bloom-dock-item:active {
          transform: scale(0.85);
        }
        .bloom-dock-item:hover {
          background: rgba(255, 255, 255, 0.1);
          color: rgba(15, 23, 42, 0.8);
        }
        .bloom-dock-item.active {
          color: #0891b2;
        }
        .bloom-dock-item.active .bloom-dock-icon-wrap {
          background: linear-gradient(135deg, #06b6d4, #22d3ee);
          color: white;
          box-shadow: 0 4px 14px rgba(6, 182, 212, 0.35);
        }
        .bloom-dock-icon-wrap {
          width: 44px;
          height: 44px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.2);
          border: 1px solid rgba(255, 255, 255, 0.35);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.03), inset 0 1px 0 rgba(255, 255, 255, 0.5), inset 0 -1px 0 rgba(0, 0, 0, 0.02);
          transition: all 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
          backdrop-filter: blur(20px) saturate(1.5);
          -webkit-backdrop-filter: blur(20px) saturate(1.5);
        }
        .bloom-dock-item:hover .bloom-dock-icon-wrap {
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.6);
          transform: translateY(-2px) scale(1.04);
        }
        .bloom-dock-label {
          font-size: 10px;
          font-weight: 600;
          letter-spacing: 0.02em;
          line-height: 1;
          transition: color 0.2s;
        }

        .bloom-conv-item {
          width: 100%; display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; border-radius: 14px; border: none; cursor: pointer; text-align: left;
          background: transparent; transition: background 0.15s; box-sizing: border-box;
        }
        .bloom-conv-item:hover { background: var(--glass-hover); }
        .bloom-conv-item.active { background: rgba(59, 130, 246, 0.1); border: 1px solid rgba(59, 130, 246, 0.15); }

        .bloom-conv-avatar-wrap { position: relative; flex-shrink: 0; }
        .bloom-conv-avatar { width: 46px; height: 46px; border-radius: 14px; object-fit: cover; }
        .bloom-status-dot { position: absolute; bottom: 2px; right: 2px; width: 10px; height: 10px; border-radius: 50%; border: 2px solid #ffffff; }
        .bloom-status-dot.online { background: #22c55e; }
        .bloom-status-dot.pending { background: #f59e0b; }
        .bloom-conv-info { flex: 1; min-width: 0; }
        .bloom-conv-name { font-size: 13px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; display: block; }
        .bloom-conv-time { font-size: 10px; color: var(--text-tertiary); white-space: nowrap; flex-shrink: 0; }
        .bloom-conv-preview { font-size: 12px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 155px; }
        .bloom-conv-preview.typing { color: #2563eb; font-style: italic; }
        .bloom-unread-count { background: var(--accent-grad); color: white; font-size: 10px; font-weight: 800; border-radius: 8px; padding: 1px 6px; min-width: 18px; text-align: center; flex-shrink: 0; }

        .bloom-conv-skeleton { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 14px; }
        .bloom-conv-skeleton-avatar { width: 46px; height: 46px; border-radius: 14px; background: linear-gradient(90deg, rgba(15, 23, 42, 0.03) 25%, rgba(15, 23, 42, 0.08) 50%, rgba(15, 23, 42, 0.03) 75%); background-size: 400px 100%; animation: shimmer 1.5s infinite; flex-shrink: 0; }
        .bloom-conv-skeleton-line { height: 10px; border-radius: 6px; background: linear-gradient(90deg, rgba(15, 23, 42, 0.03) 25%, rgba(15, 23, 42, 0.08) 50%, rgba(15, 23, 42, 0.03) 75%); background-size: 400px 100%; animation: shimmer 1.5s infinite; }

        /* GLASS ICON BUTTON */
        .bloom-glass-icon-btn {
          width: 34px; height: 34px; border-radius: 10px; border: none; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          background: rgba(255, 255, 255, 0.6); color: var(--text-secondary);
          transition: all 0.15s;
          border: 1px solid var(--border-color);
        }
        .bloom-glass-icon-btn:hover { background: rgba(255, 255, 255, 0.95); color: var(--text-primary); }
        .bloom-glass-icon-btn.accent { background: var(--accent-grad); color: white; box-shadow: 0 4px 16px rgba(59, 130, 246, 0.25); }
        .bloom-glass-icon-btn.active { background: rgba(59, 130, 246, 0.15); color: #2563eb; border: 1px solid rgba(59, 130, 246, 0.25); }

        /* MAIN */
        .bloom-main { flex: 1; display: flex; flex-direction: column; min-width: 0; height: 100%; min-height: 0; }

        /* CHAT HEADER */
        .bloom-chat-header {
          height: 64px; flex-shrink: 0;
          display: flex; align-items: center; padding: 0 16px; gap: 10px;
          background: var(--glass-bg); border-bottom: 1px solid var(--border-color);
          backdrop-filter: blur(20px);
        }
        .bloom-back-btn { display: none; width: 34px; height: 34px; border-radius: 10px; background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color); cursor: pointer; color: #2563eb; align-items: center; justify-content: center; }
        .bloom-header-avatar { width: 42px; height: 42px; border-radius: 13px; object-fit: cover; flex-shrink: 0; }
        .bloom-header-name { font-size: 15px; font-weight: 700; color: var(--text-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .bloom-header-status { font-size: 12px; color: var(--text-tertiary); }
        .bloom-header-status.online { color: #22c55e; }

        /* CHAT WORKSPACE */
        .bloom-chat-body { display: flex; flex-direction: row; flex: 1; min-height: 0; width: 100%; }
        .bloom-chat-workspace { flex: 1; display: flex; flex-direction: column; min-height: 0; position: relative; overflow: hidden; }
        .bloom-messages-area {
          flex: 1; overflow-y: auto; padding: 16px 16px 0; min-width: 0;
          -webkit-overflow-scrolling: touch; overscroll-behavior: contain;
          position: relative; z-index: 1;
        }
        .bloom-messages-area::-webkit-scrollbar { width: 3px; }
        .bloom-messages-area::-webkit-scrollbar-thumb { background: rgba(15, 23, 42, 0.08); border-radius: 2px; }

        .bloom-msg-stream { display: flex; flex-direction: column; max-width: 720px; width: 100%; margin: 0 auto; }
        .bloom-load-more-btn {
          display: inline-flex; align-items: center; gap: 6px;
          height: 30px; padding: 0 14px; border-radius: 15px;
          border: 1px solid var(--border-color); background: rgba(255, 255, 255, 0.6);
          color: #2563eb; font-size: 12px; font-weight: 700; cursor: pointer;
        }

        .bloom-msg-loading { display: flex; flex-direction: column; gap: 12px; padding: 20px 0; }
        .bloom-msg-skeleton { display: flex; align-items: flex-end; gap: 8px; }
        .bloom-msg-skeleton.right { flex-direction: row-reverse; }
        .bloom-msg-skeleton-bubble { height: 38px; border-radius: 18px; background: linear-gradient(90deg, rgba(15, 23, 42, 0.03) 25%, rgba(15, 23, 42, 0.08) 50%, rgba(15, 23, 42, 0.03) 75%); background-size: 400px 100%; animation: shimmer 1.5s infinite; }

        .bloom-empty-state { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 8px; text-align: center; padding: 32px; }

        /* MESSAGES */
        .bloom-msg-entry { display: flex; flex-direction: column; }
        .bloom-date-divider { display: flex; align-items: center; justify-content: center; padding: 12px 0; }
        .bloom-date-divider span { font-size: 11px; color: var(--text-tertiary); background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color); padding: 3px 12px; border-radius: 10px; }
        .bloom-msg-row { display: flex; align-items: flex-end; gap: 6px; position: relative; }
        .bloom-msg-row.right { flex-direction: row-reverse; }
        .bloom-msg-row.highlighted .bloom-bubble { box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.5) !important; }

        .bloom-msg-avatar-slot { width: 32px; flex-shrink: 0; }
        .bloom-msg-avatar { width: 32px; height: 32px; border-radius: 10px; object-fit: cover; }
        .bloom-msg-avatar-spacer { width: 32px; height: 32px; }

        .bloom-msg-group { display: flex; flex-direction: column; max-width: 70%; position: relative; }
        .bloom-msg-group.right { align-items: flex-end; }
        .bloom-msg-group.left { align-items: flex-start; }

        .bloom-sender-name { font-size: 11px; color: #2563eb; font-weight: 600; margin-bottom: 2px; }
        .bloom-reply-context { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-tertiary); margin-bottom: 2px; }
        .bloom-reply-quote {
          max-width: 100%; background: rgba(15, 23, 42, 0.04); border-radius: 10px; padding: 6px 10px;
          border: none; cursor: pointer; text-align: left; display: flex; flex-direction: column; gap: 1px;
          border-left: 2px solid #2563eb; margin-bottom: 3px;
        }
        .bloom-reply-author { font-size: 11px; color: #2563eb; font-weight: 600; }
        .bloom-reply-text { font-size: 11px; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 200px; display: block; }

        .bloom-bubble {
          max-width: 100%; padding: 8px 12px 18px 12px; border-radius: 18px; position: relative;
          word-break: break-word; cursor: default;
          min-width: 60px;
        }
        .bloom-bubble.mine {
          background: var(--accent-grad); color: white;
          border-radius: 18px 18px 6px 18px;
          box-shadow: 0 4px 20px rgba(59, 130, 246, 0.2);
        }
        .bloom-bubble.theirs {
          background: rgba(255, 255, 255, 0.7);
          backdrop-filter: blur(12px);
          border: 1px solid var(--border-color);
          color: var(--text-primary);
          border-radius: 18px 18px 18px 6px;
        }
        .bloom-bubble.deleted .bloom-msg-text { opacity: 0.4; font-style: italic; }

        .bloom-msg-text { font-size: 14px; line-height: 1.5; display: block; }
        .bloom-img-attachment { max-width: 260px; border-radius: 12px; display: block; cursor: pointer; }
        .bloom-audio-attachment { display: flex; align-items: center; gap: 8px; min-width: 200px; }
        .bloom-file-attachment { display: flex; align-items: center; gap: 8px; text-decoration: none; color: inherit; background: rgba(15, 23, 42, 0.05); padding: 8px 12px; border-radius: 12px; border: 1px solid var(--border-color); }

        .bloom-reaction-summary {
          display: flex; align-items: center; background: rgba(255, 255, 255, 0.8);
          border-radius: 12px; padding: 2px 8px; border: 1px solid var(--border-color);
          cursor: pointer; font-size: 12px; margin-top: 3px;
          color: var(--text-primary);
        }
        .bloom-reaction-summary.has-mine { background: rgba(59, 130, 246, 0.15); border-color: rgba(59, 130, 246, 0.3); }

        .bloom-bubble-meta {
          position: absolute; bottom: 3px; right: 10px;
          display: flex; align-items: center; gap: 3px;
          user-select: none; pointer-events: none;
        }
        .bloom-bubble-time { font-size: 8px; }
        .bloom-bubble.mine .bloom-bubble-time { color: rgba(255, 255, 255, 0.7); }
        .bloom-bubble.theirs .bloom-bubble-time { color: var(--text-tertiary); }
        .bloom-bubble-delivery { font-size: 8px; font-weight: bold; }
        .bloom-bubble.mine .bloom-bubble-delivery { color: rgba(255, 255, 255, 0.8); }

        .bloom-msg-actions {
          display: flex; gap: 2px; position: absolute;
          top: 50%; transform: translateY(-50%);
          opacity: 0; pointer-events: none; transition: opacity 0.15s;
          background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(12px);
          border: 1px solid var(--border-color); border-radius: 12px; padding: 3px 4px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.08);
          z-index: 10;
        }
        .bloom-msg-actions.visible { opacity: 1; pointer-events: auto; }
        .bloom-msg-actions.right { right: 105%; left: auto; }
        .bloom-msg-actions.left { left: 105%; right: auto; }
        .bloom-action-btn { width: 28px; height: 28px; border-radius: 8px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; }
        .bloom-action-btn:hover { background: rgba(15, 23, 42, 0.05); color: var(--text-primary); }

        .bloom-ctx-menu {
          position: absolute; top: 100%; z-index: 40;
          background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(20px);
          border: 1px solid var(--border-color); border-radius: 14px;
          padding: 6px; min-width: 150px; box-shadow: 0 8px 32px rgba(0,0,0,0.1);
        }
        .bloom-ctx-menu.right { right: 0; }
        .bloom-ctx-menu.left { left: 0; }
        .bloom-ctx-menu button { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 9px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; width: 100%; font-size: 13px; transition: all 0.1s; }
        .bloom-ctx-menu button:hover { background: rgba(15, 23, 42, 0.04); color: var(--text-primary); }
        .bloom-ctx-menu button.danger { color: #ef4444; }
        .bloom-ctx-menu button.danger:hover { background: rgba(239, 68, 68, 0.08); }

        .bloom-reaction-picker {
          position: absolute; top: -48px; z-index: 45;
          display: flex; gap: 4px; background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(20px);
          border: 1px solid var(--border-color); border-radius: 30px; padding: 6px 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,0.08);
        }
        .bloom-reaction-picker.right { right: 0; }
        .bloom-reaction-picker.left { left: 0; }
        .bloom-reaction-opt { width: 32px; height: 32px; border-radius: 50%; border: none; background: transparent; font-size: 18px; cursor: pointer; transition: transform 0.1s; display: flex; align-items: center; justify-content: center; }
        .bloom-reaction-opt:hover { transform: scale(1.3); }
        .bloom-reaction-opt.active { background: rgba(59, 130, 246, 0.15); }

        /* TYPING */
        .bloom-typing-bubble {
          display: flex; align-items: center; gap: 4px;
          background: rgba(255, 255, 255, 0.7); backdrop-filter: blur(12px);
          border: 1px solid var(--border-color); padding: 12px 16px; border-radius: 18px 18px 18px 6px;
        }
        .bloom-typing-dot { width: 8px; height: 8px; border-radius: 50%; background: #3b82f6; display: block; animation: bounce 1s infinite; }

        /* PENDING BANNER */
        .bloom-pending-banner { padding: 14px; flex-shrink: 0; }
        .bloom-pending-card {
          background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.15);
          border-radius: 16px; padding: 14px; text-align: center;
        }
        .bloom-pending-text { font-size: 13px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5; }

        /* COMPOSER */
        .bloom-composer {
          flex-shrink: 0; padding: 10px 12px;
          background: var(--glass-bg); border-top: 1px solid var(--border-color);
          backdrop-filter: blur(20px); position: relative;
        }
        .bloom-composer.recording { background: rgba(239, 68, 68, 0.03); border-top-color: rgba(239, 68, 68, 0.08); }
        .bloom-reply-preview { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(59, 130, 246, 0.08); border-radius: 12px; margin-bottom: 8px; }
        .bloom-reply-bar { width: 3px; height: 36px; background: var(--accent-grad); border-radius: 2px; flex-shrink: 0; }
        .bloom-reply-preview-copy { flex: 1; min-width: 0; }
        .bloom-tools-popover {
          position: absolute; bottom: calc(100% + 8px); left: 12px;
          background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(20px);
          border: 1px solid var(--border-color); border-radius: 16px; padding: 8px;
          display: flex; gap: 4px; box-shadow: 0 8px 32px rgba(0,0,0,0.08);
        }
        .bloom-tools-item { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 8px 12px; border-radius: 12px; border: none; background: transparent; color: var(--text-secondary); cursor: pointer; font-size: 11px; transition: all 0.1s; }
        .bloom-tools-item:hover { background: rgba(15, 23, 42, 0.04); color: var(--text-primary); }
        .bloom-emoji-picker {
          position: absolute; bottom: calc(100% + 8px); right: 12px;
          background: rgba(255, 255, 255, 0.98); backdrop-filter: blur(20px);
          border: 1px solid var(--border-color); border-radius: 16px; padding: 10px;
          display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.08);
        }
        .bloom-emoji-btn { width: 36px; height: 36px; font-size: 20px; border-radius: 10px; border: none; background: transparent; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: transform 0.1s; }
        .bloom-emoji-btn:hover { transform: scale(1.2); background: rgba(15, 23, 42, 0.04); }
        .bloom-recording-banner { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: rgba(239, 68, 68, 0.06); border-radius: 12px; margin-bottom: 8px; }
        .bloom-rec-dot { width: 8px; height: 8px; border-radius: 50%; background: #ef4444; animation: pulse 1s infinite; }
        .bloom-btn-stop-recording { margin-left: auto; padding: 4px 12px; border-radius: 8px; border: 1px solid rgba(239, 68, 68, 0.15); background: rgba(239, 68, 68, 0.08); color: #ef4444; cursor: pointer; font-size: 12px; font-weight: 600; }

        .bloom-composer-form { display: flex; align-items: center; gap: 8px; }
        .bloom-composer-side-actions { display: flex; gap: 4px; }
        .bloom-composer-btn { width: 36px; height: 36px; border-radius: 11px; border: none; background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color); color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; }
        .bloom-composer-btn:hover { background: rgba(255, 255, 255, 0.95); color: var(--text-primary); }
        .bloom-composer-btn.active { background: rgba(59, 130, 246, 0.15); color: #2563eb; }
        .bloom-composer-btn.recording { background: rgba(239, 68, 68, 0.15); color: #ef4444; }

        .bloom-input-field {
          flex: 1; display: flex; align-items: center; height: 44px;
          background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color);
          border-radius: 16px; padding: 0 12px; gap: 8px; backdrop-filter: blur(12px);
        }
        .bloom-input-field:focus-within { border-color: rgba(59, 130, 246, 0.4); background: rgba(255, 255, 255, 0.85); }
        .bloom-text-input { flex: 1; background: transparent; border: none; outline: none; color: var(--text-primary); font-size: 14px; }
        .bloom-text-input::placeholder { color: var(--text-tertiary); }
        .bloom-emoji-toggle { color: var(--text-tertiary); background: transparent; border: none; cursor: pointer; display: flex; align-items: center; transition: color 0.1s; }
        .bloom-emoji-toggle:hover { color: var(--text-secondary); }
        .bloom-emoji-toggle.active { color: #2563eb; }

        .bloom-send-btn { width: 44px; height: 44px; border-radius: 14px; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: white; background: var(--accent-grad); box-shadow: 0 4px 16px rgba(59, 130, 246, 0.25); transition: all 0.1s; }
        .bloom-send-btn:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(59, 130, 246, 0.35); }
        .bloom-like-btn { width: 44px; height: 44px; border-radius: 14px; border: none; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #2563eb; background: rgba(59, 130, 246, 0.08); transition: all 0.1s; }
        .bloom-like-btn:hover { background: rgba(59, 130, 246, 0.15); transform: scale(1.05); }

        /* SMALL BUTTONS */
        .bloom-btn-danger-sm { padding: 7px 16px; border-radius: 10px; border: 1px solid rgba(239, 68, 68, 0.15); background: rgba(239, 68, 68, 0.06); color: #ef4444; cursor: pointer; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 4px; }
        .bloom-btn-accent-sm { padding: 7px 16px; border-radius: 10px; border: none; background: var(--accent-grad); color: white; cursor: pointer; font-size: 12px; font-weight: 600; display: flex; align-items: center; gap: 4px; }

        /* INFO PANEL */
        .bloom-info-panel {
          width: 260px; min-width: 240px; border-left: 1px solid var(--border-color);
          background: var(--glass-bg); display: flex; flex-direction: column; flex-shrink: 0;
          backdrop-filter: blur(20px);
        }
        .bloom-info-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 14px 12px; border-bottom: 1px solid var(--border-color); flex-shrink: 0; }
        .bloom-info-scroll { flex: 1; overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 14px; }
        .bloom-info-profile { background: rgba(59, 130, 246, 0.06); border: 1px solid rgba(59, 130, 246, 0.12); border-radius: 16px; padding: 16px; }
        .bloom-info-quick-actions { display: flex; gap: 6px; }
        .bloom-info-action { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 6px; border-radius: 12px; background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color); cursor: pointer; transition: all 0.1s; color: var(--text-primary); }
        .bloom-info-action:hover { background: rgba(255, 255, 255, 0.95); }
        .bloom-pending-info { background: rgba(245, 158, 11, 0.06); border: 1px solid rgba(245, 158, 11, 0.15); border-radius: 12px; padding: 12px; }

        /* WELCOME */
        .bloom-welcome { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; }
        .bloom-welcome-icon { width: 80px; height: 80px; border-radius: 24px; background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.15); display: flex; align-items: center; justify-content: center; margin-bottom: 8px; color: #2563eb; }
        .bloom-welcome-features { display: flex; gap: 16px; margin-top: 8px; }
        .bloom-welcome-features span { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--text-tertiary); }

        /* CALL OVERLAY */
        .bloom-call-overlay { position: fixed; inset: 0; z-index: 90; background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; }
        .bloom-call-window { position: relative; width: 100%; max-width: 360px; border-radius: 28px; overflow: hidden; background: rgba(255, 255, 255, 0.95); border: 1px solid var(--border-color); box-shadow: 0 16px 48px rgba(0,0,0,0.1); padding: 20px; display: flex; flex-direction: column; gap: 16px; color: var(--text-primary); }
        .bloom-call-bg { position: absolute; inset: 0; background: linear-gradient(135deg, rgba(236,254,255,0.62), rgba(255,255,255,0.18)); pointer-events: none; }
        .bloom-call-header { display: flex; align-items: center; justify-content: space-between; z-index: 1; color: var(--text-secondary); }
        .bloom-call-identity { display: flex; flex-direction: column; align-items: center; padding: 16px 0; z-index: 1; }
        .bloom-call-avatar-shell { position: relative; width: 96px; height: 96px; }
        .bloom-pulse-ring { position: absolute; inset: -10px; border-radius: 50%; border: 2px solid rgba(59, 130, 246, 0.4); animation: pulse 1.5s infinite; }
        .bloom-pulse-ring.pulse-2 { inset: -20px; animation-delay: 0.5s; }
        .bloom-call-avatar { width: 96px; height: 96px; border-radius: 50%; object-fit: cover; border: 3px solid #ffffff; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
        .bloom-call-mode-badge { position: absolute; bottom: 0; right: 0; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-grad); display: flex; align-items: center; justify-content: center; color: white; border: 2px solid #ffffff; }
        .bloom-audio-wave { display: flex; gap: 3px; align-items: flex-end; height: 24px; margin-top: 16px; }
        .bloom-audio-wave span { width: 3px; border-radius: 2px; background: #3b82f6; animation: waveBar 0.8s infinite; }
        .bloom-call-participant { text-align: center; z-index: 1; }

        .bloom-video-stage { position: relative; background: #000; border-radius: 18px; overflow: hidden; aspect-ratio: 16/9; }
        .bloom-video-fallback { position: absolute; inset: 0; object-fit: cover; opacity: 0.4; width: 100%; height: 100%; }
        .bloom-remote-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
        .bloom-local-video-wrap { position: absolute; bottom: 10px; right: 10px; width: 80px; height: 56px; border-radius: 10px; overflow: hidden; border: 2px solid rgba(255,255,255,0.5); }
        .bloom-local-video { width: 100%; height: 100%; object-fit: cover; }
        .bloom-camera-off { position: absolute; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; color: white; }
        .bloom-video-status { position: absolute; top: 10px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,0.85); backdrop-filter: blur(8px); padding: 4px 12px; border-radius: 12px; font-size: 12px; color: var(--text-primary); border: 1px solid var(--border-color); }
        .bloom-live-dot-anim { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; animation: pulse 1s infinite; }

        .bloom-call-incoming-actions { display: flex; gap: 20px; justify-content: center; z-index: 1; }
        .bloom-call-decline { display: flex; flex-direction: column; align-items: center; gap: 8px; border: none; background: transparent; cursor: pointer; color: var(--text-secondary); font-size: 12px; }
        .bloom-call-answer { display: flex; flex-direction: column; align-items: center; gap: 8px; border: none; background: transparent; cursor: pointer; color: var(--text-secondary); font-size: 12px; }
        .bloom-call-btn-icon { width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: white; }
        .bloom-call-decline .bloom-call-btn-icon { background: #ef4444; }
        .bloom-call-answer .bloom-call-btn-icon { background: #22c55e; }

        .bloom-call-controls { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; z-index: 1; }
        .bloom-call-ctrl { width: 48px; height: 48px; border-radius: 50%; border: 1px solid var(--border-color); background: rgba(15, 23, 42, 0.05); color: var(--text-secondary); cursor: pointer; display: flex; align-items: center; justify-content: center; transition: all 0.1s; }
        .bloom-call-ctrl:hover { background: rgba(15, 23, 42, 0.1); color: var(--text-primary); }
        .bloom-call-ctrl.active { background: #3b82f6; color: white; border-color: transparent; }
        .bloom-call-hangup { background: #ef4444; color: white; border-color: transparent; }
        .bloom-call-hangup:hover { background: #dc2626; }

        /* GROUP MODAL */
        .bloom-modal-backdrop { position: fixed; inset: 0; z-index: 80; background: rgba(15, 23, 42, 0.4); backdrop-filter: blur(8px); display: flex; align-items: center; justify-content: center; padding: 16px; }
        .bloom-group-modal { width: 100%; max-width: 420px; border-radius: 22px; background: rgba(255, 255, 255, 0.98); border: 1px solid var(--border-color); box-shadow: 0 16px 48px rgba(0,0,0,0.1); overflow: hidden; }
        .bloom-group-modal-header { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border-color); color: var(--text-primary); }
        .bloom-group-name-input { width: 100%; height: 40px; border-radius: 12px; background: rgba(255, 255, 255, 0.6); border: 1px solid var(--border-color); color: var(--text-primary); font-size: 14px; padding: 0 12px; outline: none; box-sizing: border-box; }
        .bloom-group-name-input:focus { border-color: rgba(59, 130, 246, 0.4); background: rgba(255, 255, 255, 0.85); }
        .bloom-group-member-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; cursor: pointer; background: transparent; transition: background 0.1s; color: var(--text-primary); }
        .bloom-group-member-item:hover { background: rgba(15, 23, 42, 0.04); }
        .bloom-group-member-item.checked { background: rgba(59, 130, 246, 0.08); border: 1px solid rgba(59, 130, 246, 0.15); }
        .bloom-create-group-btn { width: 100%; height: 42px; border-radius: 14px; border: none; background: var(--accent-grad); color: white; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 16px rgba(59, 130, 246, 0.25); }

        /* LIGHT FROSTED GLASS REFRESH */
        .bloom-shell {
          --accent: #06b6d4;
          --accent-strong: #0891b2;
          --accent-grad: linear-gradient(135deg, #22d3ee 0%, #38bdf8 48%, #0ea5e9 100%);
          --text-primary: rgba(10, 15, 30, 0.95);
          --text-secondary: rgba(30, 41, 59, 0.78);
          --text-tertiary: rgba(71, 85, 105, 0.65);
          --border-color: rgba(8, 145, 178, 0.16);
          --glass-bg: rgba(255, 255, 255, 0.5);
          --glass-panel: rgba(255, 255, 255, 0.68);
          --glass-hover: rgba(255, 255, 255, 0.82);
          --glass-active: rgba(6, 182, 212, 0.14);
          --shadow-soft: 0 24px 70px rgba(15, 118, 145, 0.14), 0 8px 24px rgba(15, 23, 42, 0.06);
          box-sizing: border-box;
          gap: 16px;
          padding: 16px;
          isolation: isolate;
          background: linear-gradient(135deg, #f9fdff 0%, #edf9fb 42%, #f7fcff 100%);
        }
        .bloom-shell *, .bloom-shell *::before, .bloom-shell *::after { box-sizing: border-box; }
        .bloom-bg-fixed {
          z-index: 0;
          background:
            linear-gradient(120deg, rgba(255,255,255,0.96), rgba(226,248,252,0.72) 48%, rgba(244,251,255,0.94)),
            linear-gradient(180deg, rgba(255,255,255,0.5), rgba(207,243,247,0.28));
        }
        .bloom-bg-fixed::before {
          content: "";
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(rgba(8,145,178,0.045) 1px, transparent 1px),
            linear-gradient(90deg, rgba(8,145,178,0.04) 1px, transparent 1px);
          background-size: 42px 42px;
          mask-image: linear-gradient(135deg, rgba(0,0,0,0.34), transparent 72%);
          pointer-events: none;
        }
        .bloom-sidebar,
        .bloom-main,
        .bloom-call-window,
        .bloom-group-modal {
          position: relative;
          z-index: 1;
          border: 1px solid rgba(255, 255, 255, 0.86);
          box-shadow: var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.84);
          backdrop-filter: blur(28px) saturate(1.35);
          -webkit-backdrop-filter: blur(28px) saturate(1.35);
        }
        .bloom-sidebar {
          width: 316px;
          min-width: 286px;
          border-right: 1px solid rgba(255, 255, 255, 0.86);
          border-radius: 30px;
          overflow: hidden;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.78), rgba(255,255,255,0.5)),
            rgba(233, 249, 252, 0.5);
        }
        .bloom-sidebar::after,
        .bloom-main::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          pointer-events: none;
          box-shadow: inset 0 0 0 1px rgba(8,145,178,0.08);
        }
        .bloom-sidebar-header {
          padding: 18px 16px 14px;
          border-bottom: 1px solid rgba(8,145,178,0.12);
          background: linear-gradient(180deg, rgba(255,255,255,0.46), rgba(255,255,255,0.16));
        }
        .bloom-eyebrow {
          color: var(--accent-strong);
          letter-spacing: 0.2em;
        }
        .bloom-title {
          font-size: 21px;
          letter-spacing: 0;
        }
        .bloom-unread-badge {
          background: rgba(236, 254, 255, 0.74);
          border-color: rgba(6, 182, 212, 0.22);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.8), 0 10px 28px rgba(8,145,178,0.08);
        }
        .bloom-live-dot { color: #059669; }
        .bloom-search-input,
        .bloom-input-field,
        .bloom-group-name-input {
          background: rgba(255, 255, 255, 0.72);
          border-color: rgba(255,255,255,0.9);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.88), 0 8px 24px rgba(8,145,178,0.06);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
        }
        .bloom-search-input:focus,
        .bloom-input-field:focus-within,
        .bloom-group-name-input:focus {
          background: rgba(255, 255, 255, 0.92);
          border-color: rgba(6, 182, 212, 0.42);
          box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.14), inset 0 1px 0 rgba(255,255,255,0.9);
        }
        .bloom-filter-tab {
          height: 31px;
          border: 1px solid transparent;
          border-radius: 999px;
        }
        .bloom-filter-tab:hover {
          background: rgba(255,255,255,0.64);
          color: rgba(15,23,42,0.7);
        }
        .bloom-filter-tab.active {
          color: var(--accent-strong);
          background: rgba(255,255,255,0.82);
          border-color: rgba(6,182,212,0.24);
          box-shadow: 0 8px 22px rgba(8,145,178,0.12), inset 0 1px 0 rgba(255,255,255,0.92);
        }
        .bloom-online-avatar,
        .bloom-conv-avatar,
        .bloom-header-avatar,
        .bloom-msg-avatar {
          border: 2px solid rgba(255,255,255,0.84);
          box-shadow: 0 8px 24px rgba(8,145,178,0.14);
        }
        .bloom-conv-list { padding: 10px; }
        .bloom-conv-item {
          border: 1px solid transparent;
          border-radius: 18px;
          padding: 10px;
        }
        .bloom-conv-item:hover {
          background: rgba(255,255,255,0.58);
          border-color: rgba(255,255,255,0.72);
          box-shadow: 0 10px 26px rgba(8,145,178,0.08);
        }
        .bloom-conv-item.active {
          background: rgba(236, 254, 255, 0.8);
          border-color: rgba(6, 182, 212, 0.32);
          box-shadow: 0 12px 30px rgba(8,145,178,0.14), inset 0 1px 0 rgba(255,255,255,0.88);
        }
        .bloom-conv-preview.typing,
        .bloom-sender-name,
        .bloom-reply-author,
        .bloom-load-more-btn,
        .bloom-emoji-toggle.active {
          color: var(--accent-strong);
        }
        .bloom-unread-count,
        .bloom-send-btn,
        .bloom-btn-accent-sm,
        .bloom-create-group-btn,
        .bloom-call-mode-badge {
          background: var(--accent-grad);
          box-shadow: 0 10px 24px rgba(6,182,212,0.24);
        }
        .bloom-glass-icon-btn,
        .bloom-composer-btn,
        .bloom-back-btn,
        .bloom-like-btn,
        .bloom-info-action {
          background: rgba(255, 255, 255, 0.7);
          border: 1px solid rgba(255,255,255,0.88);
          color: var(--text-secondary);
          box-shadow: 0 8px 22px rgba(8,145,178,0.08), inset 0 1px 0 rgba(255,255,255,0.88);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
        }
        .bloom-glass-icon-btn:hover,
        .bloom-composer-btn:hover,
        .bloom-back-btn:hover,
        .bloom-like-btn:hover,
        .bloom-info-action:hover {
          background: rgba(255,255,255,0.94);
          color: var(--accent-strong);
          transform: translateY(-1px);
        }
        .bloom-glass-icon-btn.accent {
          background: var(--accent-grad);
          color: white;
          border-color: rgba(255,255,255,0.72);
        }
        .bloom-glass-icon-btn.active,
        .bloom-composer-btn.active {
          background: rgba(207,250,254,0.88);
          color: var(--accent-strong);
          border-color: rgba(6,182,212,0.3);
        }
        .bloom-main {
          overflow: hidden;
          border-radius: 30px;
          background:
            linear-gradient(180deg, rgba(255,255,255,0.64), rgba(255,255,255,0.38)),
            rgba(232, 249, 252, 0.5);
        }
        .bloom-chat-header {
          height: 70px;
          padding: 0 18px;
          background: rgba(255,255,255,0.48);
          border-bottom: 1px solid rgba(8,145,178,0.13);
          backdrop-filter: blur(24px) saturate(1.28);
          -webkit-backdrop-filter: blur(24px) saturate(1.28);
        }
        .bloom-header-status.online { color: #059669; }
        .bloom-chat-workspace {
          background: linear-gradient(180deg, rgba(241,252,254,0.45), rgba(255,255,255,0.14));
        }
        .bloom-messages-area {
          padding: 18px 18px 0;
        }
        .bloom-msg-stream { max-width: 760px; }
        .bloom-date-divider span,
        .bloom-load-more-btn,
        .bloom-typing-bubble,
        .bloom-reaction-summary {
          background: rgba(255,255,255,0.72);
          border-color: rgba(255,255,255,0.88);
          box-shadow: 0 8px 22px rgba(8,145,178,0.08), inset 0 1px 0 rgba(255,255,255,0.88);
          backdrop-filter: blur(16px);
          -webkit-backdrop-filter: blur(16px);
        }
        .bloom-bubble {
          box-shadow: 0 10px 26px rgba(15, 118, 145, 0.1), inset 0 1px 0 rgba(255,255,255,0.44);
        }
        .bloom-bubble.mine {
          background: linear-gradient(135deg, rgba(8,145,178,0.92), rgba(34,211,238,0.9));
          border: 1px solid rgba(255,255,255,0.58);
          box-shadow: 0 12px 30px rgba(6,182,212,0.22), inset 0 1px 0 rgba(255,255,255,0.36);
        }
        .bloom-bubble.theirs {
          background: rgba(255,255,255,0.78);
          border: 1px solid rgba(255,255,255,0.9);
          box-shadow: 0 10px 28px rgba(8,145,178,0.1), inset 0 1px 0 rgba(255,255,255,0.9);
          backdrop-filter: blur(18px);
          -webkit-backdrop-filter: blur(18px);
        }
        .bloom-reply-quote,
        .bloom-file-attachment,
        .bloom-pending-card,
        .bloom-info-profile,
        .bloom-pending-info {
          background: rgba(255,255,255,0.62);
          border: 1px solid rgba(255,255,255,0.82);
          box-shadow: inset 0 1px 0 rgba(255,255,255,0.82);
        }
        .bloom-reply-quote { border-left: 3px solid var(--accent); }
        .bloom-msg-row.highlighted .bloom-bubble {
          box-shadow: 0 0 0 3px rgba(34,211,238,0.38), 0 12px 30px rgba(6,182,212,0.2) !important;
        }
        .bloom-msg-actions,
        .bloom-ctx-menu,
        .bloom-reaction-picker,
        .bloom-tools-popover,
        .bloom-emoji-picker {
          background: rgba(255,255,255,0.82);
          border: 1px solid rgba(255,255,255,0.88);
          box-shadow: 0 18px 44px rgba(8,145,178,0.14), inset 0 1px 0 rgba(255,255,255,0.9);
          backdrop-filter: blur(24px) saturate(1.28);
          -webkit-backdrop-filter: blur(24px) saturate(1.28);
        }
        .bloom-action-btn:hover,
        .bloom-ctx-menu button:hover,
        .bloom-tools-item:hover,
        .bloom-emoji-btn:hover {
          background: rgba(207,250,254,0.66);
          color: var(--accent-strong);
        }
        .bloom-typing-dot,
        .bloom-audio-wave span {
          background: var(--accent);
        }
        .bloom-composer {
          padding: 12px 14px;
          background: rgba(255,255,255,0.52);
          border-top: 1px solid rgba(8,145,178,0.13);
          backdrop-filter: blur(24px) saturate(1.28);
          -webkit-backdrop-filter: blur(24px) saturate(1.28);
        }
        .bloom-reply-preview,
        .bloom-recording-banner {
          background: rgba(236,254,255,0.76);
          border: 1px solid rgba(6,182,212,0.18);
        }
        .bloom-like-btn {
          color: var(--accent-strong);
          background: rgba(236,254,255,0.76);
        }
        .bloom-info-panel {
          width: 282px;
          border-left: 1px solid rgba(8,145,178,0.13);
          background: rgba(255,255,255,0.52);
          backdrop-filter: blur(24px) saturate(1.28);
          -webkit-backdrop-filter: blur(24px) saturate(1.28);
        }
        .bloom-info-header { border-bottom-color: rgba(8,145,178,0.13); }
        .bloom-welcome {
          text-align: center;
          background: linear-gradient(180deg, rgba(255,255,255,0.2), rgba(236,254,255,0.16));
        }
        .bloom-welcome-icon {
          color: var(--accent-strong);
          background: rgba(255,255,255,0.66);
          border-color: rgba(255,255,255,0.9);
          box-shadow: 0 18px 44px rgba(8,145,178,0.14), inset 0 1px 0 rgba(255,255,255,0.9);
        }
        .bloom-call-overlay,
        .bloom-modal-backdrop {
          background: rgba(224, 247, 250, 0.42);
          backdrop-filter: blur(14px) saturate(1.25);
          -webkit-backdrop-filter: blur(14px) saturate(1.25);
        }
        .bloom-call-window,
        .bloom-group-modal {
          background: rgba(255,255,255,0.76);
          border-radius: 30px;
        }
        .bloom-call-bg {
          background: linear-gradient(135deg, rgba(236,254,255,0.62), rgba(255,255,255,0.18));
        }
        .bloom-call-ctrl {
          background: rgba(255,255,255,0.72);
          border-color: rgba(255,255,255,0.88);
        }
        .bloom-call-ctrl.active {
          background: var(--accent-grad);
          color: white;
        }
        .bloom-group-modal-header {
          border-bottom-color: rgba(8,145,178,0.13);
          background: rgba(255,255,255,0.44);
        }
        .bloom-group-member-item:hover,
        .bloom-group-member-item.checked {
          background: rgba(236,254,255,0.74);
          border-color: rgba(6,182,212,0.2);
        }

        /* LIGHT THEME DOCK ENHANCEMENT — Ultra-transparent iOS glass */
        .bloom-dock {
          background: linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.15) 60%);
          border-top: 1px solid rgba(255, 255, 255, 0.35);
          padding: 10px 16px 14px;
          gap: 6px;
          backdrop-filter: blur(40px) saturate(1.8);
          -webkit-backdrop-filter: blur(40px) saturate(1.8);
        }
        .bloom-dock-icon-wrap {
          background: rgba(255, 255, 255, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.45);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.6), inset 0 -1px 0 rgba(0, 0, 0, 0.03);
          backdrop-filter: blur(24px) saturate(1.6);
          -webkit-backdrop-filter: blur(24px) saturate(1.6);
        }
        .bloom-dock-item {
          color: rgba(8, 51, 68, 0.5);
        }
        .bloom-dock-item:hover {
          color: rgba(8, 51, 68, 0.85);
          background: rgba(255, 255, 255, 0.12);
        }
        .bloom-dock-item.active {
          color: #0891b2;
        }
        .bloom-dock-item.active .bloom-dock-icon-wrap {
          background: linear-gradient(135deg, rgba(6, 182, 212, 0.85), rgba(34, 211, 238, 0.85));
          color: white;
          box-shadow: 0 4px 16px rgba(6, 182, 212, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.3);
          border-color: rgba(255, 255, 255, 0.2);
        }
        .bloom-dock-item:hover .bloom-dock-icon-wrap {
          background: rgba(255, 255, 255, 0.4);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06), inset 0 1px 0 rgba(255, 255, 255, 0.7);
          transform: translateY(-2px) scale(1.04);
          border-color: rgba(255, 255, 255, 0.55);
        }

        /* RESPONSIVE - Mobile keyboard safe */
        @supports (height: 100dvh) {
          .bloom-shell { height: 100dvh; }
        }
        @supports not (height: 100dvh) {
          .bloom-shell { height: 100vh; height: -webkit-fill-available; }
        }
        @media (max-width: 768px) {
          .bloom-shell { padding: 0; gap: 0; height: 100dvh; height: -webkit-fill-available; }
          .bloom-sidebar { position: absolute; inset: 0; width: 100%; max-width: 100%; z-index: 1; border-radius: 0; }
          .bloom-sidebar,
          .bloom-main { border-radius: 0; border: none; }
          .bloom-shell.has-chat .bloom-sidebar { display: none; }
          .bloom-shell:not(.has-chat) .bloom-main { display: none; }
          .bloom-back-btn { display: flex !important; }
          .bloom-info-panel { display: none; }
          .bloom-chat-header { height: 56px; padding: 0 10px; gap: 8px; flex-shrink: 0; }
          .bloom-header-avatar { width: 36px; height: 36px; }
          .bloom-header-name { font-size: 14px; max-width: 120px; }
          .bloom-chat-body { flex: 1; min-height: 0; overflow: hidden; }
          .bloom-chat-workspace { flex: 1; min-height: 0; }
          .bloom-messages-area { flex: 1; min-height: 0; padding: 10px 10px 0; }
          .bloom-msg-stream { max-width: 100%; }
          .bloom-msg-group { max-width: 85%; }
          .bloom-msg-group.left { max-width: 85%; }
          .bloom-msg-avatar-slot, .bloom-msg-avatar, .bloom-msg-avatar-spacer { width: 26px; height: 26px; }
          .bloom-msg-avatar { border-radius: 8px; }
          .bloom-bubble { padding: 7px 10px 16px 10px; border-radius: 16px; min-width: 48px; }
          .bloom-bubble.mine { border-radius: 16px 16px 4px 16px; }
          .bloom-bubble.theirs { border-radius: 16px 16px 16px 4px; }
          .bloom-img-attachment { max-width: 200px; max-height: 240px; object-fit: cover; }
          .bloom-audio-attachment { min-width: 160px; }
          .bloom-composer { padding: 8px 8px; flex-shrink: 0; }
          .bloom-composer-form { gap: 4px; }
          .bloom-composer-side-actions { gap: 2px; }
          .bloom-composer-btn { width: 32px; height: 32px; border-radius: 10px; }
          .bloom-input-field { height: 38px; border-radius: 14px; }
          .bloom-send-btn, .bloom-like-btn { width: 38px; height: 38px; border-radius: 12px; }
          .bloom-msg-actions { display: none !important; }
          .bloom-ctx-menu, .bloom-reaction-picker { font-size: 13px; }
          .bloom-date-divider { padding: 8px 0; }
          .bloom-date-divider span { font-size: 10px; padding: 2px 10px; }
          .bloom-conv-item { padding: 8px 8px; gap: 8px; }
          .bloom-conv-avatar { width: 42px; height: 42px; }
          .bloom-conv-name { font-size: 13px; max-width: 110px; }
          .bloom-conv-preview { font-size: 11px; max-width: 120px; }
          .bloom-conv-skeleton-avatar { width: 42px; height: 42px; }
          .bloom-search-input { height: 34px; font-size: 13px; }
          .bloom-filter-tab { font-size: 10px; height: 28px; }
          .bloom-sidebar-header { padding: 12px 12px 8px; }
          .bloom-title { font-size: 18px; }
          .bloom-tools-popover { bottom: calc(100% + 4px); left: 8px; padding: 6px; }
          .bloom-tools-item { padding: 6px 8px; font-size: 10px; }
          .bloom-emoji-picker { bottom: calc(100% + 4px); right: 8px; padding: 8px; }
          .bloom-emoji-btn { width: 32px; height: 32px; font-size: 18px; }
          .bloom-pending-banner { padding: 10px; }
          .bloom-reply-preview { padding: 6px 8px; margin-bottom: 6px; }
          .bloom-recording-banner { padding: 6px 8px; margin-bottom: 6px; }
          .bloom-glass-icon-btn { width: 30px; height: 30px; border-radius: 8px; }
          .bloom-dock { padding: 6px 8px 10px; gap: 2px; border-radius: 0; }
          .bloom-dock-item { padding: 6px 12px; border-radius: 14px; }
          .bloom-dock-icon-wrap { width: 38px; height: 38px; border-radius: 12px; }
          .bloom-dock-icon-wrap svg { width: 17px; height: 17px; }
          .bloom-dock-label { font-size: 9px; }
        }
        @media (max-width: 380px) {
          .bloom-composer-side-actions { gap: 1px; }
          .bloom-composer-btn { width: 30px; height: 30px; }
          .bloom-msg-group, .bloom-msg-group.left { max-width: 90%; }
          .bloom-img-attachment { max-width: 160px; }
          .bloom-chat-header { padding: 0 8px; }
          .bloom-header-name { font-size: 13px; max-width: 90px; }
        }
        @media (min-width: 769px) and (max-width: 1024px) {
          .bloom-sidebar { width: 280px; min-width: 240px; }
          .bloom-info-panel { width: 220px; min-width: 200px; }
          .bloom-msg-group { max-width: 75%; }
        }

        /* ===== DARK MODE ===== */
        .bloom-dark .bloom-shell,
        .bloom-dark .bloom-bg-fixed {
          background: linear-gradient(135deg, #0c1220 0%, #0a1628 42%, #0d1117 100%) !important;
        }
        .bloom-dark .bloom-bg-fixed::before {
          background-image:
            linear-gradient(rgba(34,211,238,0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(34,211,238,0.025) 1px, transparent 1px) !important;
        }
        .bloom-dark .bloom-shell {
          --accent: #22d3ee !important;
          --accent-strong: #06b6d4 !important;
          --accent-grad: linear-gradient(135deg, #06b6d4, #22d3ee) !important;
          --text-primary: rgba(241, 245, 249, 0.95) !important;
          --text-secondary: rgba(203, 213, 225, 0.82) !important;
          --text-tertiary: rgba(148, 163, 184, 0.72) !important;
          --border-color: rgba(148, 163, 184, 0.12) !important;
          --glass-bg: rgba(15, 23, 42, 0.55) !important;
          --glass-panel: rgba(15, 23, 42, 0.68) !important;
          --glass-hover: rgba(30, 41, 59, 0.75) !important;
          --glass-active: rgba(6, 182, 212, 0.18) !important;
          --shadow-soft: 0 24px 70px rgba(0,0,0,0.3), 0 8px 24px rgba(0,0,0,0.2) !important;
          background: linear-gradient(135deg, #0c1220 0%, #0a1628 42%, #0d1117 100%) !important;
        }
        .bloom-dark .bloom-sidebar {
          background: linear-gradient(180deg, rgba(15,23,42,0.7), rgba(15,23,42,0.45)), rgba(8,25,40,0.5) !important;
          border-right: 1px solid rgba(148,163,184,0.1) !important;
          box-shadow: 0 0 40px rgba(0,0,0,0.3) !important;
        }
        .bloom-dark .bloom-sidebar::after,
        .bloom-dark .bloom-main::after {
          box-shadow: inset 0 0 0 1px rgba(34,211,238,0.06) !important;
        }
        .bloom-dark .bloom-sidebar-header {
          background: linear-gradient(180deg, rgba(15,23,42,0.5), rgba(15,23,42,0.2)) !important;
          border-bottom-color: rgba(148,163,184,0.1) !important;
        }
        .bloom-dark .bloom-eyebrow { color: #22d3ee !important; }
        .bloom-dark .bloom-title { color: var(--text-primary) !important; }
        .bloom-dark .bloom-unread-badge {
          background: rgba(6, 182, 212, 0.12) !important;
          border-color: rgba(6, 182, 212, 0.2) !important;
          color: var(--text-primary) !important;
          box-shadow: 0 10px 28px rgba(6,182,212,0.08) !important;
        }
        .bloom-dark .bloom-search-input,
        .bloom-dark .bloom-input-field,
        .bloom-dark .bloom-group-name-input {
          background: rgba(30, 41, 59, 0.7) !important;
          border-color: rgba(148,163,184,0.15) !important;
          color: var(--text-primary) !important;
        }
        .bloom-dark .bloom-search-input:focus,
        .bloom-dark .bloom-input-field:focus-within,
        .bloom-dark .bloom-group-name-input:focus {
          background: rgba(30, 41, 59, 0.9) !important;
          border-color: rgba(6, 182, 212, 0.4) !important;
          box-shadow: 0 0 0 3px rgba(34,211,238,0.1) !important;
        }
        .bloom-dark .bloom-filter-tab {
          color: var(--text-secondary) !important;
          background: transparent !important;
          border: 1px solid transparent !important;
        }
        .bloom-dark .bloom-filter-tab:hover {
          background: rgba(30,41,59,0.6) !important;
          color: var(--text-primary) !important;
        }
        .bloom-dark .bloom-filter-tab.active {
          color: #22d3ee !important;
          background: rgba(6,182,212,0.15) !important;
          border-color: rgba(6,182,212,0.25) !important;
        }
        .bloom-dark .bloom-conv-item {
          border-color: transparent !important;
        }
        .bloom-dark .bloom-conv-item:hover {
          background: rgba(30,41,59,0.5) !important;
          border-color: rgba(148,163,184,0.1) !important;
        }
        .bloom-dark .bloom-conv-item.active {
          background: rgba(6,182,212,0.12) !important;
          border-color: rgba(6,182,212,0.25) !important;
        }
        .bloom-dark .bloom-conv-name,
        .bloom-dark .bloom-conv-preview,
        .bloom-dark .bloom-conv-time {
          color: var(--text-primary) !important;
        }
        .bloom-dark .bloom-main {
          background: linear-gradient(180deg, rgba(15,23,42,0.5), rgba(15,23,42,0.25)), rgba(8,25,40,0.4) !important;
          border: 1px solid rgba(148,163,184,0.1) !important;
          box-shadow: 0 0 40px rgba(0,0,0,0.3) !important;
        }
        .bloom-dark .bloom-chat-header {
          background: rgba(15,23,42,0.6) !important;
          border-bottom-color: rgba(148,163,184,0.1) !important;
        }
        .bloom-dark .bloom-header-name { color: var(--text-primary) !important; }
        .bloom-dark .bloom-header-status { color: var(--text-secondary) !important; }
        .bloom-dark .bloom-chat-workspace {
          background: linear-gradient(180deg, rgba(8,25,40,0.3), rgba(15,23,42,0.1)) !important;
        }
        .bloom-dark .bloom-bubble.mine {
          background: linear-gradient(135deg, rgba(6,182,212,0.85), rgba(34,211,238,0.82)) !important;
          border-color: rgba(34,211,238,0.3) !important;
          box-shadow: 0 12px 30px rgba(6,182,212,0.15) !important;
        }
        .bloom-dark .bloom-bubble.mine .bloom-msg-text { color: #fff !important; }
        .bloom-dark .bloom-bubble.mine .bloom-msg-time { color: rgba(255,255,255,0.7) !important; }
        .bloom-dark .bloom-bubble.theirs {
          background: rgba(30, 41, 59, 0.75) !important;
          border-color: rgba(148,163,184,0.15) !important;
          box-shadow: 0 10px 28px rgba(0,0,0,0.15) !important;
        }
        .bloom-dark .bloom-bubble.theirs .bloom-msg-text { color: var(--text-primary) !important; }
        .bloom-dark .bloom-bubble.theirs .bloom-msg-time { color: var(--text-secondary) !important; }
        .bloom-dark .bloom-date-divider span,
        .bloom-dark .bloom-typing-bubble {
          background: rgba(30,41,59,0.7) !important;
          border-color: rgba(148,163,184,0.15) !important;
          color: var(--text-secondary) !important;
        }
        .bloom-dark .bloom-sender-name { color: var(--accent) !important; }
        .bloom-dark .bloom-reply-quote {
          background: rgba(30,41,59,0.6) !important;
          border-left-color: var(--accent) !important;
          border-color: rgba(148,163,184,0.12) !important;
        }
        .bloom-dark .bloom-reply-author { color: var(--accent) !important; }
        .bloom-dark .bloom-file-attachment {
          background: rgba(30,41,59,0.6) !important;
          border-color: rgba(148,163,184,0.15) !important;
          color: var(--text-primary) !important;
        }
        .bloom-dark .bloom-composer {
          background: rgba(15,23,42,0.6) !important;
          border-top-color: rgba(148,163,184,0.1) !important;
        }
        .bloom-dark .bloom-text-input { color: var(--text-primary) !important; }
        .bloom-dark .bloom-text-input::placeholder { color: var(--text-tertiary) !important; }
        .bloom-dark .bloom-glass-icon-btn,
        .bloom-dark .bloom-composer-btn,
        .bloom-dark .bloom-back-btn,
        .bloom-dark .bloom-like-btn {
          background: rgba(30,41,59,0.6) !important;
          border-color: rgba(148,163,184,0.15) !important;
          color: var(--text-secondary) !important;
        }
        .bloom-dark .bloom-glass-icon-btn:hover,
        .bloom-dark .bloom-composer-btn:hover,
        .bloom-dark .bloom-back-btn:hover,
        .bloom-dark .bloom-like-btn:hover {
          background: rgba(30,41,59,0.9) !important;
          color: #22d3ee !important;
        }
        .bloom-dark .bloom-glass-icon-btn.accent {
          background: var(--accent-grad) !important;
          color: white !important;
        }
        .bloom-dark .bloom-glass-icon-btn.active {
          background: rgba(6,182,212,0.2) !important;
          color: #22d3ee !important;
          border-color: rgba(6,182,212,0.3) !important;
        }
        .bloom-dark .bloom-msg-actions,
        .bloom-dark .bloom-ctx-menu,
        .bloom-dark .bloom-reaction-picker,
        .bloom-dark .bloom-tools-popover,
        .bloom-dark .bloom-emoji-picker {
          background: rgba(15,23,42,0.9) !important;
          border-color: rgba(148,163,184,0.15) !important;
          box-shadow: 0 18px 44px rgba(0,0,0,0.4) !important;
        }
        .bloom-dark .bloom-action-btn:hover,
        .bloom-dark .bloom-ctx-menu button:hover,
        .bloom-dark .bloom-tools-item:hover,
        .bloom-dark .bloom-emoji-btn:hover {
          background: rgba(6,182,212,0.15) !important;
          color: #22d3ee !important;
        }
        .bloom-dark .bloom-action-btn,
        .bloom-dark .bloom-ctx-menu button,
        .bloom-dark .bloom-tools-item {
          color: var(--text-secondary) !important;
        }
        .bloom-dark .bloom-reaction-summary {
          background: rgba(30,41,59,0.7) !important;
          border-color: rgba(148,163,184,0.15) !important;
        }
        .bloom-dark .bloom-info-panel {
          background: rgba(15,23,42,0.55) !important;
          border-left-color: rgba(148,163,184,0.1) !important;
        }
        .bloom-dark .bloom-info-header { border-bottom-color: rgba(148,163,184,0.1) !important; }
        .bloom-dark .bloom-info-action {
          background: rgba(30,41,59,0.5) !important;
          border-color: rgba(148,163,184,0.15) !important;
          color: var(--text-secondary) !important;
        }
        .bloom-dark .bloom-info-action:hover { background: rgba(6,182,212,0.15) !important; color: #22d3ee !important; }
        .bloom-dark .bloom-info-profile { background: rgba(30,41,59,0.5) !important; border-color: rgba(148,163,184,0.12) !important; }
        .bloom-dark .bloom-welcome { background: linear-gradient(180deg, rgba(15,23,42,0.2), rgba(6,182,212,0.08)) !important; }
        .bloom-dark .bloom-welcome h2, .bloom-dark .bloom-welcome p { color: var(--text-primary) !important; }
        .bloom-dark .bloom-welcome-icon { background: rgba(6,182,212,0.15) !important; border-color: rgba(6,182,212,0.2) !important; color: #22d3ee !important; }
        .bloom-dark .bloom-pending-card { background: rgba(30,41,59,0.6) !important; border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-pending-info { background: rgba(30,41,59,0.4) !important; }
        .bloom-dark .bloom-pending-banner { background: rgba(30,41,59,0.7) !important; border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-reply-preview { background: rgba(30,41,59,0.6) !important; border-color: rgba(6,182,212,0.2) !important; }
        .bloom-dark .bloom-recording-banner { background: rgba(239,68,68,0.12) !important; border-color: rgba(239,68,68,0.2) !important; }
        .bloom-dark .bloom-group-modal { background: rgba(15,23,42,0.95) !important; border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-group-modal-header { background: rgba(15,23,42,0.8) !important; border-bottom-color: rgba(148,163,184,0.1) !important; }
        .bloom-dark .bloom-group-member-item { color: var(--text-primary) !important; }
        .bloom-dark .bloom-group-member-item:hover { background: rgba(30,41,59,0.5) !important; }
        .bloom-dark .bloom-group-member-item.checked { background: rgba(6,182,212,0.12) !important; border-color: rgba(6,182,212,0.2) !important; }
        .bloom-dark .bloom-call-overlay, .bloom-dark .bloom-modal-backdrop { background: rgba(0,0,0,0.6) !important; }
        .bloom-dark .bloom-call-window { background: rgba(15,23,42,0.95) !important; border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-call-bg { background: linear-gradient(135deg, rgba(6,182,212,0.12), rgba(15,23,42,0.4)) !important; }
        .bloom-dark .bloom-call-ctrl { background: rgba(30,41,59,0.7) !important; border-color: rgba(148,163,184,0.15) !important; color: var(--text-primary) !important; }
        .bloom-dark .bloom-call-ctrl.active { background: var(--accent-grad) !important; color: white !important; }
        .bloom-dark .bloom-video-status { background: rgba(15,23,42,0.85) !important; border-color: rgba(148,163,184,0.15) !important; color: var(--text-primary) !important; }
        .bloom-dark .bloom-online-dot { color: #34d399 !important; }
        .bloom-dark .bloom-online-section-label, .bloom-dark .bloom-section-label { color: var(--text-secondary) !important; }
        .bloom-dark .bloom-online-item:hover { background: rgba(30,41,59,0.4) !important; }
        .bloom-dark .bloom-load-more-btn { background: rgba(30,41,59,0.6) !important; border-color: rgba(148,163,184,0.15) !important; color: var(--text-primary) !important; }
        .bloom-dark .bloom-audio-attachment { background: rgba(30,41,59,0.6) !important; border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-audio-attachment audio { filter: invert(1) hue-rotate(180deg); }
        .bloom-dark .bloom-img-attachment { border-color: rgba(148,163,184,0.15) !important; }
        .bloom-dark .bloom-send-btn, .bloom-dark .bloom-like-btn { background: var(--accent-grad) !important; color: white !important; }
        .bloom-dark .bloom-create-group-btn { background: var(--accent-grad) !important; }
        .bloom-dark .bloom-emoji-toggle.active { color: #22d3ee !important; }
        .bloom-dark .bloom-typing-dot, .bloom-dark .bloom-audio-wave span { background: var(--accent) !important; }
        .bloom-dark .bloom-msg-row.highlighted .bloom-bubble { box-shadow: 0 0 0 3px rgba(34,211,238,0.3) !important; }
        /* Dark mode scrollbars */
        .bloom-dark * { scrollbar-color: rgba(34,211,238,0.2) transparent !important; }
        .bloom-dark *::-webkit-scrollbar-thumb { background: rgba(34,211,238,0.2) !important; }
        .bloom-dark *::-webkit-scrollbar-thumb:hover { background: rgba(34,211,238,0.35) !important; }

        /* DARK MODE DOCK — Ultra-transparent iOS glass */
        .bloom-dark .bloom-dock {
          background: linear-gradient(180deg, transparent 0%, rgba(255, 255, 255, 0.04) 60%);
          border-top-color: rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(40px) saturate(1.8);
          -webkit-backdrop-filter: blur(40px) saturate(1.8);
        }
        .bloom-dark .bloom-dock-icon-wrap {
          background: rgba(255, 255, 255, 0.08);
          border-color: rgba(255, 255, 255, 0.12);
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15), inset 0 1px 0 rgba(255, 255, 255, 0.08);
          backdrop-filter: blur(24px) saturate(1.6);
          -webkit-backdrop-filter: blur(24px) saturate(1.6);
          color: rgba(148, 163, 184, 0.7);
        }
        .bloom-dark .bloom-dock-item {
          color: rgba(148, 163, 184, 0.45);
        }
        .bloom-dark .bloom-dock-item:hover {
          color: rgba(226, 232, 240, 0.9);
          background: rgba(255, 255, 255, 0.05);
        }
        .bloom-dark .bloom-dock-item:hover .bloom-dock-icon-wrap {
          background: rgba(255, 255, 255, 0.14);
          box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.12);
          transform: translateY(-2px) scale(1.04);
          color: #22d3ee;
          border-color: rgba(255, 255, 255, 0.18);
        }
        .bloom-dark .bloom-dock-item.active {
          color: #22d3ee;
        }
        .bloom-dark .bloom-dock-item.active .bloom-dock-icon-wrap {
          background: linear-gradient(135deg, rgba(6, 182, 212, 0.75), rgba(34, 211, 238, 0.75));
          color: white;
          box-shadow: 0 4px 16px rgba(6, 182, 212, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.15);
          border-color: rgba(255, 255, 255, 0.1);
        }

        /* ===== CANVAS + ANIMATION ENHANCEMENTS ===== */
@keyframes msgSlideIn {
  0% { opacity: 0; transform: translateY(12px) scale(0.96); filter: blur(4px); }
  60% { filter: blur(0); }
  100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
}
@keyframes msgSlideInMe {
  0% { opacity: 0; transform: translateX(16px) scale(0.96); filter: blur(4px); }
  60% { filter: blur(0); }
  100% { opacity: 1; transform: translateX(0) scale(1); filter: blur(0); }
}
@keyframes fadeInUp {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}
@keyframes fadeInScale {
  from { opacity: 0; transform: scale(0.92); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes slideInRight {
  from { opacity: 0; transform: translateX(24px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes slideInLeft {
  from { opacity: 0; transform: translateX(-24px); }
  to { opacity: 1; transform: translateX(0); }
}
@keyframes typingDotBounce {
  0%, 60%, 100% { transform: translateY(0) scale(1); opacity: 0.35; }
  30% { transform: translateY(-7px) scale(1.15); opacity: 1; }
}
@keyframes reactionPop {
  0% { transform: scale(0.5); opacity: 0; }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); opacity: 1; }
}
@keyframes reactionPickerIn {
  from { opacity: 0; transform: translateY(6px) scale(0.9); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes unreadPulse {
  0%, 100% { transform: scale(1); box-shadow: 0 2px 8px rgba(13,148,136,0.4); }
  50% { transform: scale(1.1); box-shadow: 0 2px 14px rgba(13,148,136,0.6); }
}
@keyframes onlineGlow {
  0%, 100% { box-shadow: 0 0 4px rgba(16,185,129,0.6); }
  50% { box-shadow: 0 0 10px rgba(16,185,129,0.9), 0 0 20px rgba(16,185,129,0.3); }
}
@keyframes callPulse {
  0% { transform: translate(-50%,-50%) scale(0.8); opacity: 0.6; }
  100% { transform: translate(-50%,-50%) scale(2.5); opacity: 0; }
}
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes borderGlow {
  0%, 100% { border-color: rgba(13,148,136,0.15); }
  50% { border-color: rgba(13,148,136,0.35); }
}
@keyframes floatSlow {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@keyframes spinSlow {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes emojiFloat {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  100% { transform: translateY(-40px) scale(1.4); opacity: 0; }
}

/* Custom scrollbar - toàn app */
* {
  scrollbar-width: thin !important;
  scrollbar-color: rgba(13,148,136,0.15) transparent !important;
}
*::-webkit-scrollbar { width: 5px !important; }
*::-webkit-scrollbar-track { background: transparent !important; }
*::-webkit-scrollbar-thumb {
  background: rgba(13,148,136,0.15) !important;
  border-radius: 10px !important;
}
*::-webkit-scrollbar-thumb:hover {
  background: rgba(13,148,136,0.3) !important;
}

/* ===== NEW CANVAS EFFECTS STYLES ===== */

/* Voice wave canvas */
.bloom-recording-banner canvas {
  flex-shrink: 0;
  filter: drop-shadow(0 2px 6px rgba(239, 68, 68, 0.25));
}

/* Send button ripple wrapper */
.bloom-send-btn {
  position: relative;
  overflow: visible;
}
.bloom-send-btn canvas {
  position: absolute !important;
  top: 50% !important;
  left: 50% !important;
  transform: translate(-50%, -50%) !important;
  pointer-events: none;
  z-index: 0;
}
.bloom-send-btn svg {
  position: relative;
  z-index: 1;
}

/* Welcome canvas wrapper */
.bloom-welcome {
  position: relative;
  overflow: hidden;
}
.bloom-welcome > *:not(canvas) {
  position: relative;
  z-index: 1;
}

/* ===== ADDITIONAL ANIMATIONS ===== */

@keyframes messageEnterLeft {
  0% { opacity: 0; transform: translateX(-12px) translateY(8px) scale(0.97); filter: blur(3px); }
  60% { filter: blur(0); }
  100% { opacity: 1; transform: translateX(0) translateY(0) scale(1); filter: blur(0); }
}
@keyframes messageEnterRight {
  0% { opacity: 0; transform: translateX(12px) translateY(8px) scale(0.97); filter: blur(3px); }
  60% { filter: blur(0); }
  100% { opacity: 1; transform: translateX(0) translateY(0) scale(1); filter: blur(0); }
}
@keyframes bubbleGlow {
  0%, 100% { box-shadow: 0 12px 30px rgba(6,182,212,0.22), inset 0 1px 0 rgba(255,255,255,0.36); }
  50% { box-shadow: 0 14px 38px rgba(6,182,212,0.35), inset 0 1px 0 rgba(255,255,255,0.5); }
}
@keyframes reactionBurst {
  0% { transform: scale(0.3) rotate(-15deg); opacity: 0; }
  50% { transform: scale(1.3) rotate(8deg); }
  100% { transform: scale(1) rotate(0); opacity: 1; }
}
@keyframes reactionFloat {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  100% { transform: translateY(-30px) scale(1.4); opacity: 0; }
}
@keyframes typingGlow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); }
  50% { box-shadow: 0 0 0 4px rgba(6, 182, 212, 0.12); }
}
@keyframes headerShimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
@keyframes statusBreath {
  0%, 100% { transform: scale(1); opacity: 1; }
  50% { transform: scale(1.15); opacity: 0.85; }
}
@keyframes onlinePing {
  0% { transform: scale(1); opacity: 0.7; }
  100% { transform: scale(2.2); opacity: 0; }
}
@keyframes convItemSlideIn {
  0% { opacity: 0; transform: translateX(-10px); }
  100% { opacity: 1; transform: translateX(0); }
}
@keyframes modalPopIn {
  0% { opacity: 0; transform: scale(0.92) translateY(20px); }
  100% { opacity: 1; transform: scale(1) translateY(0); }
}
@keyframes backdropFadeIn {
  from { opacity: 0; backdrop-filter: blur(0); }
  to { opacity: 1; backdrop-filter: blur(8px); }
}
@keyframes callWindowIn {
  0% { opacity: 0; transform: scale(0.9) translateY(30px); filter: blur(8px); }
  100% { opacity: 1; transform: scale(1) translateY(0); filter: blur(0); }
}
@keyframes pulseRingEnhanced {
  0% { transform: scale(0.8); opacity: 0.6; border-width: 2px; }
  100% { transform: scale(2.4); opacity: 0; border-width: 0.5px; }
}
@keyframes glowBorder {
  0%, 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0); }
  50% { box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15); }
}
@keyframes floatY {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-4px); }
}
@keyframes spinGlow {
  0% { transform: rotate(0deg); box-shadow: 0 0 0 0 rgba(6,182,212,0.3); }
  50% { box-shadow: 0 0 20px 4px rgba(6,182,212,0.2); }
  100% { transform: rotate(360deg); box-shadow: 0 0 0 0 rgba(6,182,212,0.3); }
}

/* ===== APPLY ANIMATIONS ===== */

/* Message bubbles entrance */
.bloom-msg-row.left {
  animation: messageEnterLeft 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}
.bloom-msg-row.right {
  animation: messageEnterRight 0.32s cubic-bezier(0.22, 1, 0.36, 1);
}

/* Bubble subtle glow on hover */
.bloom-bubble.mine {
  transition: box-shadow 0.3s ease, transform 0.15s ease;
}
.bloom-bubble.mine:hover {
  animation: bubbleGlow 2.4s ease-in-out infinite;
}

/* Conversation items slide in */
.bloom-conv-item {
  animation: convItemSlideIn 0.28s ease-out backwards;
}
.bloom-conv-item:nth-child(1) { animation-delay: 0.02s; }
.bloom-conv-item:nth-child(2) { animation-delay: 0.05s; }
.bloom-conv-item:nth-child(3) { animation-delay: 0.08s; }
.bloom-conv-item:nth-child(4) { animation-delay: 0.11s; }
.bloom-conv-item:nth-child(5) { animation-delay: 0.14s; }
.bloom-conv-item:nth-child(6) { animation-delay: 0.17s; }
.bloom-conv-item:nth-child(7) { animation-delay: 0.2s; }
.bloom-conv-item:nth-child(8) { animation-delay: 0.23s; }

/* Online status ping effect */
.bloom-status-dot.online {
  position: absolute;
  animation: statusBreath 2s ease-in-out infinite;
}
.bloom-status-dot.online::before {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: #22c55e;
  animation: onlinePing 1.6s ease-out infinite;
  z-index: -1;
}

/* Unread count pulse */
.bloom-unread-count {
  animation: unreadPulse 1.6s ease-in-out infinite;
}

/* Modal animations */
.bloom-modal-backdrop {
  animation: backdropFadeIn 0.22s ease-out;
}
.bloom-group-modal {
  animation: modalPopIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Call window animation */
.bloom-call-overlay {
  animation: backdropFadeIn 0.25s ease-out;
}
.bloom-call-window {
  animation: callWindowIn 0.4s cubic-bezier(0.22, 1, 0.36, 1);
}

/* Enhanced pulse rings */
.bloom-pulse-ring {
  animation: pulseRingEnhanced 1.8s cubic-bezier(0, 0.55, 0.45, 1) infinite;
}

/* Reaction picker enhanced entrance */
.bloom-reaction-picker {
  animation: reactionPickerIn 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.bloom-reaction-opt {
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.15s;
}
.bloom-reaction-opt:hover {
  transform: scale(1.4) translateY(-2px);
}

/* Typing bubble enhanced */
.bloom-typing-bubble {
  animation: typingGlow 1.5s ease-in-out infinite;
}
.bloom-typing-dot {
  animation: typingDotBounce 1.2s ease-in-out infinite !important;
}

/* Action buttons hover */
.bloom-action-btn {
  transition: all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.bloom-action-btn:hover {
  transform: scale(1.15);
  background: rgba(207, 250, 254, 0.7);
}

/* Context menu items */
.bloom-ctx-menu button {
  transition: all 0.12s ease;
  position: relative;
  overflow: hidden;
}
.bloom-ctx-menu button::before {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.08), transparent);
  transform: translateX(-100%);
  transition: transform 0.4s;
}
.bloom-ctx-menu button:hover::before {
  transform: translateX(100%);
}

/* Send button hover ripple */
.bloom-send-btn {
  position: relative;
  overflow: hidden;
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s;
}
.bloom-send-btn:hover {
  transform: scale(1.08) rotate(-3deg);
}
.bloom-send-btn:active {
  transform: scale(0.95);
}

/* Like button bounce */
.bloom-like-btn {
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.15s;
}
.bloom-like-btn:hover {
  transform: scale(1.12) rotate(-8deg);
}
.bloom-like-btn:active {
  transform: scale(0.92);
}

/* Composer input focus glow */
.bloom-input-field {
  transition: all 0.25s ease;
}
.bloom-input-field:focus-within {
  animation: glowBorder 2s ease-in-out infinite;
}

/* Welcome icon float */
.bloom-welcome-icon {
  animation: floatY 3s ease-in-out infinite;
}

/* Loading spinner enhanced */
.bloom-load-more-btn .animate-spin {
  animation: spinGlow 1.2s linear infinite;
}

/* Filter tabs transition */
.bloom-filter-tab {
  transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.bloom-filter-tab.active {
  animation: glowBorder 2.4s ease-in-out infinite;
}

/* Glass icon buttons */
.bloom-glass-icon-btn {
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.bloom-glass-icon-btn:hover {
  transform: translateY(-2px) scale(1.05);
}
.bloom-glass-icon-btn:active {
  transform: translateY(0) scale(0.95);
}

/* Sidebar header shimmer line */
.bloom-sidebar-header::after {
  content: "";
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(6, 182, 212, 0.4), transparent);
  background-size: 200% 100%;
  animation: headerShimmer 3s linear infinite;
}

/* Chat header gradient shimmer */
.bloom-chat-header::after {
  content: "";
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 1px;
  background: linear-gradient(90deg, transparent 10%, rgba(6, 182, 212, 0.35) 50%, transparent 90%);
  background-size: 200% 100%;
  animation: headerShimmer 4s linear infinite;
  pointer-events: none;
}
.bloom-chat-header {
  position: relative;
}

/* Reaction summary pop */
.bloom-reaction-summary {
  animation: reactionBurst 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

/* Date divider fade */
.bloom-date-divider {
  animation: fadeInUp 0.4s ease-out;
}

/* Empty state entrance */
.bloom-empty-state {
  animation: fadeInScale 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}

/* Pending banner slide */
.bloom-pending-banner {
  animation: fadeInUp 0.4s ease-out;
}

/* Info panel slide */
.bloom-info-panel {
  animation: slideInRight 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}

/* Back button slide */
.bloom-back-btn {
  transition: all 0.2s ease;
}
.bloom-back-btn:hover {
  transform: translateX(-3px);
}

/* Video status badge */
.bloom-video-status {
  animation: floatY 2.5s ease-in-out infinite;
}

/* Call controls stagger */
.bloom-call-ctrl {
  animation: fadeInUp 0.4s ease-out backwards;
}
.bloom-call-ctrl:nth-child(1) { animation-delay: 0.1s; }
.bloom-call-ctrl:nth-child(2) { animation-delay: 0.15s; }
.bloom-call-ctrl:nth-child(3) { animation-delay: 0.2s; }
.bloom-call-ctrl:nth-child(4) { animation-delay: 0.25s; }
.bloom-call-ctrl:nth-child(5) { animation-delay: 0.3s; }
.bloom-call-ctrl:nth-child(6) { animation-delay: 0.35s; }

.bloom-call-hangup {
  animation: fadeInUp 0.4s ease-out 0.4s backwards;
  transition: transform 0.15s, background 0.15s;
}
.bloom-call-hangup:hover {
  transform: scale(1.1) rotate(10deg);
}

/* Online avatars stagger */
.bloom-online-item {
  animation: fadeInScale 0.4s ease-out backwards;
}
.bloom-online-item:nth-child(1) { animation-delay: 0.05s; }
.bloom-online-item:nth-child(2) { animation-delay: 0.1s; }
.bloom-online-item:nth-child(3) { animation-delay: 0.15s; }
.bloom-online-item:nth-child(4) { animation-delay: 0.2s; }
.bloom-online-item:nth-child(5) { animation-delay: 0.25s; }
.bloom-online-item:nth-child(6) { animation-delay: 0.3s; }

/* Skeleton shimmer enhanced */
.bloom-conv-skeleton-avatar,
.bloom-conv-skeleton-line,
.bloom-msg-skeleton-bubble {
  background: linear-gradient(90deg, 
    rgba(6, 182, 212, 0.04) 25%, 
    rgba(6, 182, 212, 0.12) 50%, 
    rgba(6, 182, 212, 0.04) 75%);
  background-size: 400px 100%;
  animation: shimmer 1.6s infinite linear;
}

/* Search results entrance */
.bloom-search-wrap + .flex + .bloom-online-section,
.bloom-conv-list .bloom-conv-item {
  will-change: transform, opacity;
}

/* Image attachment hover */
.bloom-img-attachment {
  transition: transform 0.3s ease, filter 0.3s ease;
  cursor: pointer;
}
.bloom-img-attachment:hover {
  transform: scale(1.02);
  filter: brightness(1.05);
}

/* Audio attachment styling */
.bloom-audio-attachment audio {
  height: 32px;
  border-radius: 8px;
  filter: sepia(0.1) hue-rotate(160deg);
}

/* Tools popover items hover */
.bloom-tools-item {
  transition: all 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.bloom-tools-item:hover {
  transform: translateY(-2px);
}

/* Composer emoji button */
.bloom-emoji-btn {
  transition: transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.1s;
}
.bloom-emoji-btn:active {
  transform: scale(0.85);
}

/* Group member item check */
.bloom-group-member-item {
  transition: all 0.18s ease;
}
.bloom-group-member-item.checked .text-cyan-500 {
  animation: reactionBurst 0.3s ease-out;
}

/* Scrollbar enhancement */
.bloom-messages-area::-webkit-scrollbar-thumb {
  background: linear-gradient(180deg, rgba(6,182,212,0.15), rgba(6,182,212,0.25)) !important;
}
.bloom-messages-area::-webkit-scrollbar-thumb:hover {
  background: linear-gradient(180deg, rgba(6,182,212,0.3), rgba(6,182,212,0.4)) !important;
}

/* Highlighted message enhanced */
.bloom-msg-row.highlighted .bloom-bubble {
  animation: glowBorder 1.6s ease-in-out;
  transition: box-shadow 0.3s ease;
}

/* Recording banner glow */
.bloom-composer.recording {
  animation: glowBorder 2s ease-in-out infinite;
  border-top-color: rgba(239, 68, 68, 0.2) !important;
}

/* Reply quote hover */
.bloom-reply-quote {
  transition: all 0.15s ease;
}
.bloom-reply-quote:hover {
  background: rgba(6, 182, 212, 0.1);
  transform: translateX(2px);
}

/* File attachment hover */
.bloom-file-attachment {
  transition: all 0.15s ease;
}
.bloom-file-attachment:hover {
  background: rgba(6, 182, 212, 0.08);
  transform: translateY(-1px);
}
      `}</style>
    </div>
  );
}

function GlassIconBtn({ children, onClick, active, accent }: { children: React.ReactNode; onClick?: () => void; active?: boolean; accent?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`bloom-glass-icon-btn ${active ? "active" : ""} ${accent ? "accent" : ""}`}
    >
      {children}
    </button>
  );
}
