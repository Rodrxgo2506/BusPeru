import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { setSessionExpiredHandler, tokenStorage } from '@/services/api';
import { authService } from '@/services';
import type { AuthUser, RoleName } from '@/types';

interface AuthContextValue {
  user: AuthUser | null;
  loading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<AuthUser>;
  /** Adopta una sesión ya emitida por el backend (retorno de OAuth). */
  adoptSession: (token: string, user: AuthUser) => void;
  register: (body: unknown) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  setUser: (user: AuthUser) => void;
  hasPermission: (...permissions: string[]) => boolean;
  hasRole: (...roles: RoleName[]) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadSession = useCallback(async () => {
    if (!tokenStorage.get()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await authService.me());
    } catch {
      tokenStorage.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // A 401 from any request means the token is gone or expired: drop the session.
    setSessionExpiredHandler(() => setUser(null));
    void loadSession();
  }, [loadSession]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authService.login(email, password);
    tokenStorage.set(result.token);
    setUser(result.user);
    return result.user;
  }, []);

  const adoptSession = useCallback((token: string, nextUser: AuthUser) => {
    tokenStorage.set(token);
    setUser(nextUser);
  }, []);

  const register = useCallback(async (body: unknown) => {
    const result = await authService.register(body);
    tokenStorage.set(result.token);
    setUser(result.user);
    return result.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await authService.logout();
    } catch {
      // Logging out locally must succeed even if the API call fails.
    } finally {
      tokenStorage.clear();
      setUser(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      isAuthenticated: user !== null,
      login,
      adoptSession,
      register,
      logout,
      refresh: loadSession,
      setUser,
      hasPermission: (...permissions: string[]) => permissions.some((permission) => user?.permissions.includes(permission) ?? false),
      hasRole: (...roles: RoleName[]) => (user ? roles.includes(user.role) : false),
    }),
    [user, loading, login, adoptSession, register, logout, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth debe usarse dentro de AuthProvider');
  return context;
}
