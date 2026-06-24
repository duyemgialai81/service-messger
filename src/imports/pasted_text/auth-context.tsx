import { createContext, useContext, useEffect, useState } from "react";
import type { Context, ReactNode } from "react";
import type { User } from "./mockData";
import api from "./api";
import { localStorage_service } from "./localStorage";

export interface AppUser extends User {
  permissions?: string[];
}

interface AuthContextType {
  user: AppUser | null;
  isAuthenticated: boolean;
  isAuthReady: boolean;
  isAdmin: boolean;
  updateUser: (data: Partial<AppUser>) => void;
  login: (email: string, password: string) => Promise<void>;
  register: (userData: any) => Promise<void>;
  loginWithGoogle: (idToken: string) => Promise<void>;
  hasPermission: (permissionCode: string) => boolean;
  logout: () => void;
  setUser: React.Dispatch<React.SetStateAction<AppUser | null>>;
}

const globalAuthStore = globalThis as typeof globalThis & {
  __KSP_AUTH_CONTEXT__?: Context<AuthContextType | undefined>;
};

const AuthContext =
  globalAuthStore.__KSP_AUTH_CONTEXT__ ||
  (globalAuthStore.__KSP_AUTH_CONTEXT__ = createContext<AuthContextType | undefined>(undefined));

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isAuthReady, setIsAuthReady] = useState(false);

  const isAdmin = user?.role === "admin";

  const hydrateRealtimeToken = async () => {
    try {
      const realtime = await api.getRealtimeToken();
      if (realtime?.token) {
        localStorage_service.saveAuthToken(realtime.token);
      }
    } catch {
      localStorage_service.removeAuthToken();
    }
  };

  useEffect(() => {
    let mounted = true;

    api.me()
      .then(async (profile) => {
        if (!mounted || !profile) return;
        await hydrateRealtimeToken();
        if (!mounted) return;
        setUser(profile);
        setIsAuthenticated(true);
      })
      .catch(() => {
        if (!mounted) return;
        setUser(null);
        setIsAuthenticated(false);
        localStorage_service.removeAuthToken();
      })
      .finally(() => {
        if (mounted) setIsAuthReady(true);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const finishLogin = async (res: any) => {
    const userId = res?.userId || res?.data?.userId;
    const permissions = res?.permissions || res?.data?.permissions || [];
    const returnedDeviceId = res?.deviceId || res?.data?.deviceId;

    if (!userId) throw new Error("Invalid login response");
    if (returnedDeviceId) localStorage_service.saveDeviceId(returnedDeviceId);

    const profile = await api.me();
    if (!profile) throw new Error("Could not load user profile");
    await hydrateRealtimeToken();

    setUser({ ...profile, permissions });
    setIsAuthenticated(true);
    setIsAuthReady(true);
  };

  const login = async (email: string, password: string) => {
    try {
      const res = await api.login({
        email,
        password,
        deviceId: localStorage_service.getDeviceId() || undefined,
        deviceName: window.navigator.platform || undefined,
        userAgent: window.navigator.userAgent || undefined,
      });
      await finishLogin(res);
    } catch (error) {
      throw new Error((error as Error).message || "Đăng nhập thất bại");
    }
  };

  const loginWithGoogle = async (idToken: string) => {
    try {
      const res = await api.googleLogin({
        idToken,
        role: "student",
        deviceId: localStorage_service.getDeviceId() || undefined,
        deviceName: window.navigator.platform || undefined,
        userAgent: window.navigator.userAgent || undefined,
      });
      await finishLogin(res);
    } catch (error) {
      throw new Error((error as Error).message || "Đăng nhập Google thất bại");
    }
  };

  const register = async (_userData: any) => {
    throw new Error("Vui lòng sử dụng luồng OTP trong trang đăng ký");
  };

  const logout = () => {
    void api.logout().catch(() => {});
    setUser(null);
    setIsAuthenticated(false);
    localStorage_service.removeUser();
    localStorage_service.removeAuthToken();
  };

  const updateUser = (data: Partial<AppUser>) => {
    setUser((previous) => previous ? { ...previous, ...data } : previous);
  };

  const hasPermission = (permissionCode: string) =>
    user?.permissions?.includes(permissionCode) || user?.role === "admin";

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated,
        isAuthReady,
        isAdmin,
        updateUser,
        login,
        loginWithGoogle,
        register,
        hasPermission,
        logout,
        setUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
