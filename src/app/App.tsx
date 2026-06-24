import { useRef, useEffect } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { Toaster } from "sonner";
import { AuthProvider, useAuth } from "../lib/authContext";
import { BloomAuth } from "./components/BloomAuth";
import BloomMessaging from "./components/BloomMessaging";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;

// ============================================================
// CANVAS — Loading: Morphing Geometry + Orbiting Dots
// ============================================================
const LoadingCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 72;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    canvas.style.width = `${size}px`;
    canvas.style.height = `${size}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = size / 2;
    const cy = size / 2;
    let t = 0;

    const orbitDots = Array.from({ length: 8 }, (_, i) => ({
      angle: (i / 8) * Math.PI * 2,
      radius: size * 0.38,
      hue: 158 + i * 7,
      dotSize: 2 + Math.random() * 1.8,
      speed: 0.018 + i * 0.004,
    }));

    const draw = () => {
      t += 1;
      ctx.clearRect(0, 0, size, size);

      // Morphing polygon: 3 → 4 → 5 → 6 → 3...
      const sides = 3 + (Math.floor(t / 90) % 4);
      const morphProgress = (t % 90) / 90;
      const eased = morphProgress < 0.5
        ? 4 * morphProgress * morphProgress * morphProgress
        : 1 - Math.pow(-2 * morphProgress + 2, 3) / 2;
      const prevSides = sides === 3 ? 6 : sides - 1;
      const r = size * 0.2 * (0.88 + Math.sin(t * 0.035) * 0.12);
      const rotation = t * 0.008;

      // Vẽ morphing polygon
      ctx.save();
      ctx.globalAlpha = 0.5 + Math.sin(t * 0.04) * 0.2;
      ctx.strokeStyle = `hsla(172, 75%, 42%, 0.8)`;
      ctx.lineWidth = 1.8;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.shadowColor = `hsla(172, 80%, 50%, 0.4)`;
      ctx.shadowBlur = 12;
      ctx.beginPath();

      const totalPoints = Math.max(prevSides, sides);
      for (let i = 0; i <= totalPoints; i++) {
        const anglePrev = (i / prevSides) * Math.PI * 2 - Math.PI / 2 + rotation;
        const angleCurr = (i / sides) * Math.PI * 2 - Math.PI / 2 + rotation;
        const px = cx + Math.cos(anglePrev) * r;
        const py = cy + Math.sin(anglePrev) * r;
        const qx = cx + Math.cos(angleCurr) * r;
        const qy = cy + Math.sin(angleCurr) * r;
        const fx = px + (qx - px) * eased;
        const fy = py + (qy - py) * eased;
        i === 0 ? ctx.moveTo(fx, fy) : ctx.lineTo(fx, fy);
      }
      ctx.stroke();
      ctx.restore();

      // Inner glow
      const ig = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2);
      ig.addColorStop(0, `hsla(172, 80%, 50%, ${0.07 + Math.sin(t * 0.03) * 0.025})`);
      ig.addColorStop(1, "hsla(172, 80%, 50%, 0)");
      ctx.fillStyle = ig;
      ctx.beginPath();
      ctx.arc(cx, cy, r * 2, 0, Math.PI * 2);
      ctx.fill();

      // Orbiting dots với trail
      for (const dot of orbitDots) {
        dot.angle += dot.speed;
        const trailLen = 6;
        for (let j = trailLen; j >= 0; j--) {
          const ta = dot.angle - j * 0.055;
          const tx = cx + Math.cos(ta) * dot.radius;
          const ty = cy + Math.sin(ta) * dot.radius;
          const alpha = (1 - j / trailLen) * 0.55;
          const s = dot.dotSize * (1 - j / trailLen * 0.6);
          ctx.fillStyle = `hsla(${dot.hue}, 82%, 62%, ${alpha})`;
          ctx.beginPath();
          ctx.arc(tx, ty, s, 0, Math.PI * 2);
          ctx.fill();
        }
        // Head dot glow
        const hx = cx + Math.cos(dot.angle) * dot.radius;
        const hy = cy + Math.sin(dot.angle) * dot.radius;
        const hg = ctx.createRadialGradient(hx, hy, 0, hx, hy, 8);
        hg.addColorStop(0, `hsla(${dot.hue}, 85%, 70%, 0.25)`);
        hg.addColorStop(1, `hsla(${dot.hue}, 85%, 70%, 0)`);
        ctx.fillStyle = hg;
        ctx.beginPath();
        ctx.arc(hx, hy, 8, 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return <canvas ref={canvasRef} />;
};

// ============================================================
// CANVAS — Nền trang Auth: Gentle particles + gradient waves
// ============================================================
const AuthBackgroundCanvas = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    let w = 0, h = 0;

    interface SoftParticle { x: number; y: number; r: number; opacity: number; hue: number; vx: number; vy: number; phase: number; speed: number; }

    const particles: SoftParticle[] = [];
    const initParticles = () => {
      particles.length = 0;
      const count = Math.min(Math.floor((w * h) / 18000), 60);
      for (let i = 0; i < count; i++) {
        particles.push({
          x: Math.random() * w, y: Math.random() * h,
          r: 1 + Math.random() * 2.5,
          opacity: 0.1 + Math.random() * 0.2,
          hue: 170 + Math.random() * 30,
          vx: (Math.random() - 0.5) * 0.2,
          vy: (Math.random() - 0.5) * 0.15 - 0.1,
          phase: Math.random() * Math.PI * 2,
          speed: 0.005 + Math.random() * 0.008,
        });
      }
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initParticles();
    };
    resize();
    window.addEventListener("resize", resize);

    let t = 0;
    const draw = () => {
      t += 1;
      ctx.clearRect(0, 0, w, h);

      // Gradient waves (2 lớp)
      for (let wave = 0; wave < 2; wave++) {
        const baseY = h * (0.65 + wave * 0.15);
        const hue = 175 + wave * 12;
        ctx.beginPath();
        ctx.moveTo(0, h);
        for (let x = 0; x <= w; x += 4) {
          const y = baseY
            + Math.sin(x * 0.003 + t * 0.012 + wave * 2) * 30
            + Math.sin(x * 0.007 + t * 0.008 + wave) * 15
            + Math.cos(x * 0.002 + t * 0.005) * 20;
          x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
        ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
        const wg = ctx.createLinearGradient(0, baseY - 40, 0, h);
        wg.addColorStop(0, `hsla(${hue}, 65%, 60%, ${0.04 - wave * 0.015})`);
        wg.addColorStop(0.5, `hsla(${hue}, 55%, 55%, ${0.02 - wave * 0.008})`);
        wg.addColorStop(1, `hsla(${hue}, 45%, 50%, 0)`);
        ctx.fillStyle = wg;
        ctx.fill();
      }

      // Particles
      for (const p of particles) {
        p.phase += p.speed;
        p.x += p.vx + Math.sin(p.phase * 0.6) * 0.15;
        p.y += p.vy + Math.cos(p.phase * 0.4) * 0.1;
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;
        if (p.y < -10) p.y = h + 10;
        if (p.y > h + 10) p.y = -10;
        const flicker = p.opacity * (0.5 + Math.sin(p.phase * 1.5) * 0.5);
        const gr = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, Math.max(0.5, p.r * 4));
        gr.addColorStop(0, `hsla(${p.hue}, 70%, 58%, ${flicker})`);
        gr.addColorStop(0.5, `hsla(${p.hue}, 60%, 52%, ${flicker * 0.25})`);
        gr.addColorStop(1, `hsla(${p.hue}, 50%, 48%, 0)`);
        ctx.fillStyle = gr;
        ctx.beginPath();
        ctx.arc(p.x, p.y, Math.max(0.5, p.r * 4), 0, Math.PI * 2);
        ctx.fill();
      }

      rafRef.current = requestAnimationFrame(draw);
    };
    rafRef.current = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(rafRef.current);
      window.removeEventListener("resize", resize);
    };
  }, []);

  return <canvas ref={canvasRef} style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none" }} />;
};

// ============================================================
// APP SHELL
// ============================================================
function AppShell() {
  const { isAuthenticated, isAuthReady, user } = useAuth();

  if (!isAuthReady) {
    return (
      <div
        className="fixed inset-0 flex items-center justify-center"
        style={{
          background: "linear-gradient(145deg, #f0fdfa 0%, #ecfeff 35%, #f0f9ff 65%, #f5f3ff 100%)",
        }}
      >
        {/* ✅ Thay 3 dot bằng Canvas morphing */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 20,
            position: "relative",
            zIndex: 1,
          }}
        >
          <div
            style={{
              width: 80,
              height: 80,
              borderRadius: 22,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(135deg, #0d9488, #0891b2)",
              boxShadow: "0 16px 40px rgba(13,148,136,0.3), 0 4px 12px rgba(13,148,136,0.2), inset 0 1px 0 rgba(255,255,255,0.2)",
              animation: "logoFloat 3s ease-in-out infinite",
            }}
          >
            <span
              style={{
                color: "#fff",
                fontSize: 30,
                fontWeight: 800,
                textShadow: "0 2px 8px rgba(0,0,0,0.15)",
                letterSpacing: "-0.5px",
              }}
            >
              B
            </span>
          </div>
          <LoadingCanvas />
          <span
            style={{
              fontSize: 13,
              color: "rgba(13,148,136,0.6)",
              fontWeight: 500,
              letterSpacing: "0.5px",
              animation: "textPulse 2s ease-in-out infinite",
            }}
          >
            Đang khởi tạo...
          </span>
        </div>
        <style>{`
          @keyframes logoFloat {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-8px); }
          }
          @keyframes textPulse {
            0%, 100% { opacity: 0.5; }
            50% { opacity: 1; }
          }
        `}</style>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div style={{ position: "relative" }}>
        {/* ✅ Canvas nền cho trang đăng nhập */}
        <AuthBackgroundCanvas />
        <div style={{ position: "relative", zIndex: 1 }}>
          <BloomAuth onSuccess={() => window.location.reload()} />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden">
      <BloomMessaging currentUser={user} />
    </div>
  );
}

export default function App() {
  return (
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
    <AuthProvider>
      <AppShell />
      <Toaster
        position="top-center"
        toastOptions={{
          style: {
            background: "rgba(12, 20, 38, 0.92)",
            backdropFilter: "blur(24px) saturate(1.4)",
            border: "1px solid rgba(13,148,136,0.15)",
            color: "rgba(255,255,255,0.92)",
            borderRadius: "16px",
            boxShadow: "0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05) inset",
            fontSize: "14px",
          },
        }}
      />
    </AuthProvider>
    </GoogleOAuthProvider>
  );
}