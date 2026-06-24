
import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { Mail, Lock, User, Building, KeyRound, X } from "lucide-react";
import { GoogleLogin } from '@react-oauth/google';
import api from "../lib/api";
import { toast } from "sonner";
import { useAuth } from "../lib/authContext";

export function AuthPage() {
  const navigate = useNavigate();
  const { login, loginWithGoogle } = useAuth() as any;

  // --- States Đăng Nhập ---
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  
  // --- States Đăng Ký ---
  const [registerName, setRegisterName] = useState("");
  const [registerEmail, setRegisterEmail] = useState("");
  const [registerPassword, setRegisterPassword] = useState("");
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState("");
  const [registerMajor, setRegisterMajor] = useState("");
  const [registerClass, setRegisterClass] = useState("");
  const [registerRole, setRegisterRole] = useState<"student" | "lecturer">("student");
  
  // --- States Luồng OTP Đăng ký ---
  const [isOtpStep, setIsOtpStep] = useState(false);
  const [otpCode, setOtpCode] = useState("");
  
  // --- States Luồng QUÊN MẬT KHẨU ---
  const [isForgotModalOpen, setIsForgotModalOpen] = useState(false);
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

  // ================= CÁC HÀM XỬ LÝ ĐĂNG NHẬP / ĐĂNG KÝ =================
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginEmail || !loginPassword) return toast.error("Vui lòng điền đầy đủ thông tin");
    
    setIsLoading(true);
    try {
      await login(loginEmail, loginPassword);
      toast.success("Đăng nhập thành công!");
      navigate("/");
    } catch (error: any) {
      toast.error(error.message || "Đăng nhập thất bại");
    } finally {
      setIsLoading(false);
    }
  };

  const handleGoogleSuccess = async (credentialResponse: any) => {
    if (credentialResponse.credential) {
      setIsLoading(true);
      try {
        await loginWithGoogle(credentialResponse.credential);
        toast.success("Đăng nhập Google thành công!");
        navigate("/");
      } catch (error: any) {
        toast.error(error.message || "Đăng nhập Google thất bại.");
      } finally {
        setIsLoading(false);
      }
    }
  };

  const handleRequestOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!registerName || !registerEmail || !registerPassword || !registerMajor) {
      return toast.error("Vui lòng điền đầy đủ thông tin");
    }
    if (registerPassword !== registerConfirmPassword) {
      return toast.error("Mật khẩu xác nhận không khớp");
    }
    if (registerPassword.length < 6) return toast.error("Mật khẩu phải có ít nhất 6 ký tự");

    setIsLoading(true);
    try {
      await api.requestRegisterOtp({
        name: registerName, email: registerEmail, password: registerPassword,
        majorId: registerMajor, className: registerClass, role: registerRole
      }); 
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
        toast.success("Đăng ký thành công! Đang chuyển hướng...");
        window.location.href = "/"; 
      }
    } catch (error: any) {
      toast.error("Mã OTP không hợp lệ hoặc đã hết hạn.");
    } finally {
      setIsLoading(false);
    }
  };

  // ================= CÁC HÀM XỬ LÝ QUÊN MẬT KHẨU =================
  const handleRequestForgotOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotEmail) return toast.error("Vui lòng nhập email để lấy lại mật khẩu");
    
    setIsLoading(true);
    try {
      await api.requestPasswordResetOtp(forgotEmail);
      toast.success("Mã xác nhận đã được gửi vào email của bạn!");
      setIsForgotOtpStep(true);
    } catch (error: any) {
      toast.error(error.message || "Không thể gửi mã. Vui lòng kiểm tra lại email.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!forgotOtp || !newPassword) return toast.error("Vui lòng nhập đầy đủ OTP và Mật khẩu mới");
    if (newPassword.length < 6) return toast.error("Mật khẩu mới phải có ít nhất 6 ký tự");

    setIsLoading(true);
    try {
      await api.resetPassword({ email: forgotEmail, otp: forgotOtp, newPassword });
      toast.success("Đổi mật khẩu thành công! Bạn có thể đăng nhập bằng mật khẩu mới.");
      // Reset form & đóng modal
      setIsForgotModalOpen(false);
      setIsForgotOtpStep(false);
      setForgotEmail("");
      setForgotOtp("");
      setNewPassword("");
    } catch (error: any) {
      toast.error(error.message || "Mã OTP không hợp lệ hoặc đã hết hạn.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-sky-50 via-white to-cyan-50 p-4 relative">
      <div className="w-full max-w-4xl grid md:grid-cols-2 gap-8 items-center">
        
        {/* Left Side - Branding */}
        <div className="hidden md:block">
          <div className="text-center space-y-6">
            <div className="flex items-center justify-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-600 shadow-xl">
                <span className="text-white text-4xl">FP</span>
              </div>
            </div>
            <div>
              <h1 className="text-4xl text-sky-700 mb-2">Don Jade Roy</h1>
              <p className="text-xl text-gray-600">Knowledge Hub</p>
            </div>
            <div className="space-y-3 text-left bg-white rounded-lg p-6 shadow-lg">
              <h3 className="text-lg text-gray-800 mb-3">Tham gia ngay để:</h3>
              <div className="flex items-start gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-100">📚</div><p className="text-sm mt-1">Chia sẻ và học hỏi kiến thức</p></div>
              <div className="flex items-start gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-100">🏆</div><p className="text-sm mt-1">Tích lũy điểm và huy hiệu</p></div>
              <div className="flex items-start gap-3"><div className="flex h-8 w-8 items-center justify-center rounded-full bg-sky-100">👥</div><p className="text-sm mt-1">Kết nối với cộng đồng sinh viên</p></div>
            </div>
          </div>
        </div>

        {/* Right Side - Auth Forms */}
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl">Chào mừng trở lại!</CardTitle>
            <CardDescription>Đăng nhập hoặc tạo tài khoản mới để bắt đầu</CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="login" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="login" onClick={() => setIsOtpStep(false)}>Đăng nhập</TabsTrigger>
                <TabsTrigger value="register">Đăng ký</TabsTrigger>
              </TabsList>

              {/* ----- Form Đăng Nhập ----- */}
              <TabsContent value="login">
                <form onSubmit={handleLogin} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label htmlFor="login-email">Email</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input id="login-email" type="email" placeholder="example@fe.edu.vn" className="pl-10" value={loginEmail} onChange={(e) => setLoginEmail(e.target.value)} disabled={isLoading} />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="login-password">Mật khẩu</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input id="login-password" type="password" placeholder="••••••••" className="pl-10" value={loginPassword} onChange={(e) => setLoginPassword(e.target.value)} disabled={isLoading} />
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-sm">
                    <label className="flex items-center gap-2"><input type="checkbox" className="rounded" disabled={isLoading} /><span>Ghi nhớ đăng nhập</span></label>
                    {/* BẤM VÀO ĐÂY ĐỂ MỞ MODAL QUÊN MẬT KHẨU */}
                    <button type="button" onClick={() => setIsForgotModalOpen(true)} className="text-sky-600 hover:underline">
                      Quên mật khẩu?
                    </button>
                  </div>

                  <Button type="submit" className="w-full bg-sky-600 hover:bg-sky-700" disabled={isLoading}>
                    {isLoading ? "Đang đăng nhập..." : "Đăng nhập"}
                  </Button>

                  <div className="relative my-4">
                    <div className="absolute inset-0 flex items-center"><span className="w-full border-t border-gray-300" /></div>
                    <div className="relative flex justify-center text-xs uppercase"><span className="bg-white px-2 text-gray-500">Hoặc tiếp tục với</span></div>
                  </div>

                  {/* NÚT GOOGLE LOGIN */}
                  <div className="flex justify-center">
                     <GoogleLogin 
                        onSuccess={handleGoogleSuccess} 
                        onError={() => toast.error("Đăng nhập Google thất bại")} 
                        useOneTap
                     />
                  </div>
                </form>
              </TabsContent>

              {/* ----- Form Đăng Ký ----- */}
              <TabsContent value="register">
                {isOtpStep ? (
                    <form onSubmit={handleVerifyOtp} className="space-y-4 mt-4">
                        <div className="text-center mb-4">
                            <p className="text-sm text-gray-600">Chúng tôi đã gửi mã OTP gồm 6 chữ số đến email</p>
                            <p className="font-semibold text-sky-600">{registerEmail}</p>
                        </div>
                        <div className="space-y-2">
                            <Label htmlFor="otp-code">Mã OTP</Label>
                            <div className="relative">
                                <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                                <Input id="otp-code" placeholder="Nhập 6 số OTP" className="pl-10 text-center tracking-widest text-lg" value={otpCode} onChange={(e) => setOtpCode(e.target.value)} maxLength={6} disabled={isLoading} />
                            </div>
                        </div>
                        <Button type="submit" className="w-full bg-sky-600 hover:bg-sky-700" disabled={isLoading}>
                           {isLoading ? "Đang xác nhận..." : "Xác nhận đăng ký"}
                        </Button>
                        <Button type="button" variant="ghost" className="w-full mt-2" onClick={() => setIsOtpStep(false)}>
                            Quay lại sửa thông tin
                        </Button>
                    </form>
                ) : (
                    <form onSubmit={handleRequestOtp} className="space-y-4 mt-4 max-h-[500px] overflow-y-auto pr-2">
                      <div className="space-y-2">
                        <Label htmlFor="register-name">Họ và tên</Label>
                        <div className="relative"><User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" /><Input id="register-name" placeholder="Nguyễn Văn A" className="pl-10" value={registerName} onChange={(e) => setRegisterName(e.target.value)} disabled={isLoading} /></div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="register-email">Email</Label>
                        <div className="relative"><Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" /><Input id="register-email" type="email" placeholder="example@fe.edu.vn" className="pl-10" value={registerEmail} onChange={(e) => setRegisterEmail(e.target.value)} disabled={isLoading} /></div>
                      </div>

                      <div className="grid grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <Label>Vai trò</Label>
                          <Select value={registerRole} onValueChange={(value: any) => setRegisterRole(value)} disabled={isLoading}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="student">Sinh viên</SelectItem>
                              <SelectItem value="lecturer">Giảng viên</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Chuyên ngành</Label>
                          <Select value={registerMajor} onValueChange={setRegisterMajor} disabled={isLoading}>
                            <SelectTrigger><SelectValue placeholder="Chọn ngành" /></SelectTrigger>
                            <SelectContent>{majorsData.map((m) => (<SelectItem key={m.id} value={m.id}>{m.code} - {m.name}</SelectItem>))}</SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="register-password">Mật khẩu</Label>
                        <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" /><Input id="register-password" type="password" placeholder="Ít nhất 6 ký tự" className="pl-10" value={registerPassword} onChange={(e) => setRegisterPassword(e.target.value)} disabled={isLoading} /></div>
                      </div>

                      <div className="space-y-2">
                        <Label htmlFor="register-confirm-password">Xác nhận mật khẩu</Label>
                        <div className="relative"><Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" /><Input id="register-confirm-password" type="password" placeholder="Nhập lại mật khẩu" className="pl-10" value={registerConfirmPassword} onChange={(e) => setRegisterConfirmPassword(e.target.value)} disabled={isLoading} /></div>
                      </div>

                      <Button type="submit" className="w-full bg-sky-600 hover:bg-sky-700" disabled={isLoading}>
                        {isLoading ? "Đang gửi OTP..." : "Nhận mã OTP"}
                      </Button>
                    </form>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* ================= MODAL QUÊN MẬT KHẨU ================= */}
      {isForgotModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 backdrop-blur-sm p-4">
          <Card className="w-full max-w-md shadow-2xl relative">
            <button 
              onClick={() => { setIsForgotModalOpen(false); setIsForgotOtpStep(false); }} 
              className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
            >
              <X className="h-5 w-5" />
            </button>
            <CardHeader>
              <CardTitle className="text-xl">Lấy lại mật khẩu</CardTitle>
              <CardDescription>
                {isForgotOtpStep ? "Nhập mã OTP và mật khẩu mới" : "Nhập email của bạn để nhận mã xác nhận"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {!isForgotOtpStep ? (
                // Form 1: Yêu cầu OTP
                <form onSubmit={handleRequestForgotOtp} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Email đã đăng ký</Label>
                    <div className="relative">
                      <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input type="email" placeholder="Nhập email của bạn" className="pl-10" value={forgotEmail} onChange={(e) => setForgotEmail(e.target.value)} disabled={isLoading} />
                    </div>
                  </div>
                  <Button type="submit" className="w-full bg-sky-600 hover:bg-sky-700" disabled={isLoading}>
                    {isLoading ? "Đang gửi..." : "Gửi mã OTP"}
                  </Button>
                </form>
              ) : (
                // Form 2: Nhập OTP & Đổi mật khẩu
                <form onSubmit={handleResetPassword} className="space-y-4">
                  <div className="space-y-2">
                    <Label>Mã xác nhận (OTP)</Label>
                    <div className="relative">
                      <KeyRound className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input placeholder="Nhập 6 số OTP" className="pl-10 tracking-widest" value={forgotOtp} onChange={(e) => setForgotOtp(e.target.value)} maxLength={6} disabled={isLoading} />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Mật khẩu mới</Label>
                    <div className="relative">
                      <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
                      <Input type="password" placeholder="Ít nhất 6 ký tự" className="pl-10" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} disabled={isLoading} />
                    </div>
                  </div>
                  <Button type="submit" className="w-full bg-sky-600 hover:bg-sky-700" disabled={isLoading}>
                    {isLoading ? "Đang xử lý..." : "Xác nhận đổi mật khẩu"}
                  </Button>
                </form>
              )}
            </CardContent>
          </Card>
        </div>
      )}

    </div>
  );
}
