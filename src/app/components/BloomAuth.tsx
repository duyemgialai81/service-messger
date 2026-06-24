import { useState, useEffect } from "react";
import { Mail, Lock, User, Building, KeyRound, X, Sparkles, Eye, EyeOff } from "lucide-react";
import { GoogleLogin } from "@react-oauth/google";
import api from "../../lib/api";
import { toast } from "sonner";
import { useAuth } from "../../lib/authContext";

interface BloomAuthProps {
  onSuccess: () => void;
}

export function BloomAuth({ onSuccess }: BloomAuthProps) {
  const { login, loginWithGoogle } = useAuth() as any;
  const [activeTab, setActiveTab] = useState<"login" | "register">("login");

  // Login states
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // Register states
  const [registerName, setRegisterName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState("");
  const [registerMajor, setRegisterMajor] = useState("");
  const [registerClass, setRegisterClass] = useState("");
  const [registerRole, setRegisterRole] = useState<"student" | "lecturer">("student");
  const [showRegPassword, setShowRegPassword] = useState(false);
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState("");

  // Forgot password states
  const [isForgotOpen, setIsForgotOpen] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [isForgotOtpStep, setIsForgotOtpStep] = useState(false);
  const [forgotOtp, setForgotOtp] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const [isLoading, setIsLoading] = useState(false);
  const [majorsData, setMajorsData] = useState<any[]>([]);

  useEffect(() => {
    let mounted = true;
    api.getMajors().then((res) => {
      const list = Array.isArray(res) ? res : (res?.data || res);
      if (mounted && Array.isArray(list)) setMajorsData(list);
    }).catch(() => {});
    return () => { mounted = false; };
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail || !loginPassword) return toast.error("Vui lòng điền đầy đủ thông tin");
    setIsLoading(true);
    try {
      await login(loginEmail, loginPassword);
      toast.success("Đăng nhập thành công!");
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Đăng nhập thất bại");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: any) => {
    if (!credentialResponse.credential) return;
    setIsLoading(true);
    try {
      await loginWithGoogle(credentialResponse.credential);
      toast.success("Đăng nhập Google thành công!");
      onSuccess();
    } catch (error: any) {
      toast.error(error.message || "Đăng nhập Google thất bại.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registerName || !registerEmail || !registerPassword || !registerMajor) return toast.error("Vui lòng điền đầy đủ thông tin");
    if (registerPassword !== registerConfirmPassword) return toast.error("Mật khẩu xác nhận không khớp");
    if (registerPassword.length < 6) return toast.error("Mật khẩu phải có ít nhất 6 ký tự");
    setIsLoading(true);
    try {
      await api.requestRegisterOtp({ name: registerName, email: registerEmail, password: registerPassword, majorId: registerMajor, className: registerClass, role: registerRole });
      toast.success("Mã OTP đã được gửi đến Email của bạn!");
      setIsOtpStep(true);
    } catch (error: any) {
      toast.error(error?.message || "Lỗi khi gửi mã OTP. Email có thể đã tồn tại.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!otpCode) return toast.error("Vui lòng nhập mã OTP");
    setIsLoading(true);
    try {
      const res = await api.verifyRegisterOtp({ email: registerEmail, otp: otpCode });
      if (res?.userId || res?.data?.userId) {
        toast.success("Đăng ký thành công!");
        window.location.reload();
      }
    } catch {
      toast.error("Mã OTP không hợp lệ hoặc đã hết hạn.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleRequestForgotOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail) return toast.error("Vui lòng nhập email");
    setIsLoading(true);
    try {
      await api.requestPasswordResetOtp(forgotEmail);
      toast.success("Mã xác nhận đã được gửi!");
      setIsForgotOtpStep(true);
    } catch (error: any) {
      toast.error(error.message || "Không thể gửi mã.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotOtp || !newPassword) return toast.error("Vui lòng điền đầy đủ");
    if (newPassword.length < 6) return toast.error("Mật khẩu mới phải có ít nhất 6 ký tự");
    setIsLoading(true);
    try {
      await api.resetPassword({ email: forgotEmail, otp: forgotOtp, newPassword });
      toast.success("Đổi mật khẩu thành công!");
      setIsForgotOpen(false);
      setIsForgotOtpStep(false);
      setForgotEmail(""); setForgotOtp(""); setNewPassword("");
    } catch (error: any) {
      toast.error(error.message || "Mã OTP không hợp lệ.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden flex items-center justify-center p-4">
      {/* Animated background */}
      <div
        className="absolute inset-0 -z-10"
        style={{ background: "linear-gradient(135deg, #f9fdff 0%, #edf9fb 42%, #f7fcff 100%)" }}
      />
      <div className="absolute inset-0 -z-10 overflow-hidden">
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage: "linear-gradient(rgba(8,145,178,0.045) 1px, transparent 1px), linear-gradient(90deg, rgba(8,145,178,0.04) 1px, transparent 1px)",
            backgroundSize: "42px 42px",
            maskImage: "linear-gradient(135deg, rgba(0,0,0,0.32), transparent 72%)",
          }}
        />
      </div>

      <div className="w-full max-w-5xl grid md:grid-cols-2 gap-6 items-center">
        {/* Left branding */}
        <div className="hidden md:flex flex-col gap-8 px-4">
          <div className="flex items-center gap-3">
            <div
              className="w-12 h-12 rounded-2xl flex items-center justify-center"
              style={{ background: "linear-gradient(135deg, #22d3ee, #0ea5e9)", boxShadow: "0 12px 32px rgba(6,182,212,0.28)" }}
            >
              <Sparkles size={22} className="text-white" />
            </div>
            <div>
              <div className="text-slate-800 font-bold text-xl tracking-tight">Bloom</div>
              <div className="text-slate-500 text-xs">Knowledge Hub</div>
            </div>
          </div>

          <div>
            <h1 className="text-5xl text-slate-900 font-bold leading-tight mb-4">
              Kết nối<br />
              <span style={{ background: "linear-gradient(135deg, #0891b2, #38bdf8)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
                chia sẻ tri thức
              </span>
            </h1>
            <p className="text-slate-600 leading-relaxed">
              Không gian học tập thông minh với giao diện tuyệt đẹp. Kết nối với cộng đồng và chia sẻ kiến thức mọi lúc mọi nơi.
            </p>
          </div>

          <div className="flex flex-col gap-3">
            {[
              { icon: "📚", title: "Kho kiến thức", desc: "Chia sẻ và học hỏi từ cộng đồng" },
              { icon: "🏆", title: "Tích điểm huy hiệu", desc: "Ghi nhận đóng góp của bạn" },
              { icon: "💬", title: "Chat realtime", desc: "Kết nối tức thì với mọi người" },
            ].map((f) => (
              <div key={f.title} className="flex items-center gap-3 p-3 rounded-2xl" style={{ background: "rgba(255,255,255,0.62)", backdropFilter: "blur(18px)", border: "1px solid rgba(255,255,255,0.86)", boxShadow: "0 12px 30px rgba(8,145,178,0.08)" }}>
                <span className="text-2xl">{f.icon}</span>
                <div>
                  <div className="text-slate-800 font-semibold text-sm">{f.title}</div>
                  <div className="text-slate-500 text-xs">{f.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Auth card */}
        <div
          className="w-full rounded-3xl overflow-hidden"
          style={{
            background: "rgba(255,255,255,0.68)",
            backdropFilter: "blur(28px) saturate(1.35)",
            border: "1px solid rgba(255,255,255,0.86)",
            boxShadow: "0 24px 70px rgba(15,118,145,0.14), 0 8px 24px rgba(15,23,42,0.06), inset 0 1px 0 rgba(255,255,255,0.84)",
          }}
        >
          {/* Tab switcher */}
          <div className="flex" style={{ borderBottom: "1px solid rgba(8,145,178,0.13)" }}>
            {(["login", "register"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setIsOtpStep(false); }}
                className="flex-1 py-4 text-sm font-semibold transition-all"
                style={{
                  color: activeTab === tab ? "#0891b2" : "rgba(100,116,139,0.72)",
                  borderBottom: activeTab === tab ? "2px solid #22d3ee" : "2px solid transparent",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                }}
              >
                {tab === "login" ? "Đăng nhập" : "Đăng ký"}
              </button>
            ))}
          </div>

          <div className="p-6 sm:p-8">
            {activeTab === "login" ? (
              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                <div>
                  <p className="text-slate-800 font-bold text-xl mb-1">Chào mừng trở lại</p>
                  <p className="text-slate-500 text-sm">Đăng nhập để tiếp tục</p>
                </div>

                <GlassInput
                  icon={<Mail size={16} />}
                  type="email"
                  placeholder="Email của bạn"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  disabled={isLoading}
                />

                <GlassInput
                  icon={<Lock size={16} />}
                  type={showLoginPassword ? "text" : "password"}
                  placeholder="Mật khẩu"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  disabled={isLoading}
                  rightSlot={
                    <button type="button" onClick={() => setShowLoginPassword((p) => !p)} className="text-slate-400 hover:text-slate-700 transition-colors" tabIndex={-1}>
                      {showLoginPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  }
                />

                <div className="flex justify-end">
                  <button type="button" onClick={() => setIsForgotOpen(true)} className="text-xs text-cyan-700 hover:text-cyan-600 transition-colors">
                    Quên mật khẩu?
                  </button>
                </div>

                <GlassButton type="submit" disabled={isLoading} loading={isLoading}>
                  Đăng nhập
                </GlassButton>

                <div className="flex items-center gap-3 my-1">
                  <div className="flex-1 h-px" style={{ background: "rgba(8,145,178,0.14)" }} />
                  <span className="text-slate-400 text-xs">hoặc</span>
                  <div className="flex-1 h-px" style={{ background: "rgba(8,145,178,0.14)" }} />
                </div>

                <div className="flex justify-center">
                  <GoogleLogin
                    onSuccess={handleGoogleSuccess}
                    onError={() => toast.error("Đăng nhập Google thất bại")}
                    useOneTap
                  />
                </div>
              </form>
            ) : isOtpStep ? (
              <form onSubmit={handleVerifyOtp} className="flex flex-col gap-4">
                <div className="text-center">
                  <div className="w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center" style={{ background: "linear-gradient(135deg, rgba(207,250,254,0.9), rgba(255,255,255,0.72))", border: "1px solid rgba(6,182,212,0.26)" }}>
                    <KeyRound size={28} className="text-cyan-600" />
                  </div>
                  <p className="text-slate-800 font-bold text-lg mb-1">Xác nhận OTP</p>
                  <p className="text-slate-500 text-sm">Mã 6 số đã gửi đến <span className="text-cyan-700">{registerEmail}</span></p>
                </div>

                <GlassInput
                  icon={<KeyRound size={16} />}
                  placeholder="Nhập 6 số OTP"
                  value={otpCode}
                  onChange={(e) => setOtpCode(e.target.value)}
                  maxLength={6}
                  disabled={isLoading}
                  className="text-center tracking-widest"
                />

                <GlassButton type="submit" disabled={isLoading} loading={isLoading}>
                  Xác nhận đăng ký
                </GlassButton>

                <button type="button" onClick={() => setIsOtpStep(false)} className="text-center text-slate-500 hover:text-slate-800 text-sm transition-colors">
                  ← Quay lại
                </button>
              </form>
            ) : (
              <form onSubmit={handleRequestOtp} className="flex flex-col gap-4">
                <div>
                  <p className="text-slate-800 font-bold text-xl mb-1">Tạo tài khoản</p>
                  <p className="text-slate-500 text-sm">Tham gia cộng đồng học tập</p>
                </div>

                <GlassInput icon={<User size={16} />} placeholder="Họ và tên" value={registerName} onChange={(e) => setRegisterName(e.target.value)} disabled={isLoading} />
                <GlassInput icon={<Mail size={16} />} type="email" placeholder="Email" value={registerEmail} onChange={(e) => setRegisterEmail(e.target.value)} disabled={isLoading} />

                <div className="grid grid-cols-2 gap-3">
                  <GlassSelect value={registerRole} onChange={(e) => setRegisterRole(e.target.value as any)} disabled={isLoading}>
                    <option value="student">Sinh viên</option>
                    <option value="lecturer">Giảng viên</option>
                  </GlassSelect>
                  <GlassSelect value={registerMajor} onChange={(e) => setRegisterMajor(e.target.value)} disabled={isLoading}>
                    <option value="">Chuyên ngành</option>
                    {majorsData.map((m) => (<option key={m.id} value={m.id}>{m.code} - {m.name}</option>))}
                  </GlassSelect>
                </div>

                {registerRole === "student" && (
                  <GlassInput icon={<Building size={16} />} placeholder="Lớp (tùy chọn)" value={registerClass} onChange={(e) => setRegisterClass(e.target.value)} disabled={isLoading} />
                )}

                <GlassInput
                  icon={<Lock size={16} />}
                  type={showRegPassword ? "text" : "password"}
                  placeholder="Mật khẩu (ít nhất 6 ký tự)"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  disabled={isLoading}
                  rightSlot={
                    <button type="button" onClick={() => setShowRegPassword((p) => !p)} className="text-slate-400 hover:text-slate-700 transition-colors" tabIndex={-1}>
                      {showRegPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  }
                />
                <GlassInput icon={<Lock size={16} />} type="password" placeholder="Xác nhận mật khẩu" value={registerConfirmPassword} onChange={(e) => setRegisterConfirmPassword(e.target.value)} disabled={isLoading} />

                <GlassButton type="submit" disabled={isLoading} loading={isLoading}>
                  Nhận mã OTP
                </GlassButton>
              </form>
            )}
          </div>
        </div>
      </div>

      {/* Forgot password modal */}
      {isForgotOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(224,247,250,0.42)", backdropFilter: "blur(14px) saturate(1.25)" }}>
          <div
            className="w-full max-w-md rounded-3xl p-6 relative"
            style={{
              background: "rgba(255,255,255,0.76)",
              backdropFilter: "blur(28px) saturate(1.35)",
              border: "1px solid rgba(255,255,255,0.86)",
              boxShadow: "0 24px 70px rgba(15,118,145,0.14), 0 8px 24px rgba(15,23,42,0.06)",
            }}
          >
            <button onClick={() => { setIsForgotOpen(false); setIsForgotOtpStep(false); }} className="absolute top-4 right-4 text-slate-400 hover:text-slate-800 transition-colors">
              <X size={20} />
            </button>
            <h3 className="text-slate-800 font-bold text-xl mb-1">Lấy lại mật khẩu</h3>
            <p className="text-slate-500 text-sm mb-5">{isForgotOtpStep ? "Nhập OTP và mật khẩu mới" : "Nhập email để nhận mã"}</p>

            {!isForgotOtpStep ? (
              <form onSubmit={handleRequestForgotOtp} className="flex flex-col gap-4">
                <GlassInput icon={<Mail size={16} />} type="email" placeholder="Email đã đăng ký" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} disabled={isLoading} />
                <GlassButton type="submit" disabled={isLoading} loading={isLoading}>Gửi mã OTP</GlassButton>
              </form>
            ) : (
              <form onSubmit={handleResetPassword} className="flex flex-col gap-4">
                <GlassInput icon={<KeyRound size={16} />} placeholder="Nhập 6 số OTP" value={forgotOtp} onChange={(e) => setForgotOtp(e.target.value)} maxLength={6} disabled={isLoading} className="tracking-widest" />
                <GlassInput icon={<Lock size={16} />} type="password" placeholder="Mật khẩu mới" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={isLoading} />
                <GlassButton type="submit" disabled={isLoading} loading={isLoading}>Xác nhận đổi mật khẩu</GlassButton>
              </form>
            )}
          </div>
        </div>
      )}

      <style>{`
        @keyframes float {
          0% { transform: translateY(0px) scale(1); }
          100% { transform: translateY(-30px) scale(1.05); }
        }
      `}</style>
    </div>
  );
}

// ── Glass UI Primitives ──

function GlassInput({
  icon, rightSlot, className = "", ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { icon?: React.ReactNode; rightSlot?: React.ReactNode; className?: string }) {
  return (
    <div
      className="flex items-center gap-2 rounded-xl px-3 h-11 transition-all"
      style={{
        background: "rgba(255,255,255,0.72)",
        border: "1px solid rgba(255,255,255,0.88)",
        backdropFilter: "blur(16px)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.88), 0 8px 24px rgba(8,145,178,0.06)",
      }}
    >
      {icon && <span className="text-slate-400 flex-shrink-0">{icon}</span>}
      <input
        {...props}
        className={`flex-1 bg-transparent outline-none text-slate-800 placeholder-slate-400 text-sm min-w-0 ${className}`}
        style={{ color: "rgba(15,23,42,0.88)" }}
      />
      {rightSlot}
    </div>
  );
}

function GlassSelect({ children, className = "", ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { className?: string }) {
  return (
    <select
      {...props}
      className={`w-full rounded-xl h-11 px-3 text-sm outline-none transition-all ${className}`}
      style={{
        background: "rgba(255,255,255,0.72)",
        border: "1px solid rgba(255,255,255,0.88)",
        backdropFilter: "blur(16px)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.88), 0 8px 24px rgba(8,145,178,0.06)",
        color: "rgba(15,23,42,0.78)",
      }}
    >
      {children}
    </select>
  );
}

function GlassButton({ children, loading, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; className?: string }) {
  return (
    <button
      {...props}
      className={`w-full h-11 rounded-xl font-semibold text-sm text-white transition-all hover:opacity-90 active:scale-95 flex items-center justify-center gap-2 ${className}`}
      style={{
        background: loading || props.disabled ? "rgba(6,182,212,0.42)" : "linear-gradient(135deg, #22d3ee, #38bdf8 48%, #0ea5e9)",
        boxShadow: loading || props.disabled ? "none" : "0 12px 32px rgba(6,182,212,0.28)",
        cursor: loading || props.disabled ? "not-allowed" : "pointer",
      }}
    >
      {loading && (
        <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
      )}
      {children}
    </button>
  );
}
