import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IS_PLATFORM } from '../../../constants/config';
import { ApiError } from '../../../utils/api';
import { apiClient } from '../../../utils/apiClient';
import { AUTH_ERROR_MESSAGES, AUTH_TOKEN_STORAGE_KEY } from '../constants';
import type {
  AuthContextValue,
  AuthProviderProps,
  AuthSessionPayload,
  AuthStatusPayload,
  AuthUser,
  AuthUserPayload,
  OnboardingStatusPayload,
} from '../types';
import { resolveApiErrorMessage } from '../utils';

const AuthContext = createContext<AuthContextValue | null>(null);
const IS_LOCAL_DESKTOP = typeof window !== 'undefined' && window.leocodeboxLocal?.enabled === true;
const IS_LOCAL_AUTH_READY = !IS_LOCAL_DESKTOP || window.leocodeboxLocal?.authReady !== false;

const readStoredToken = (): string | null => localStorage.getItem(AUTH_TOKEN_STORAGE_KEY);

const persistToken = (token: string) => {
  localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
};

const clearStoredToken = () => {
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
};

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const { t } = useTranslation('auth');
  const [user, setUser] = useState<AuthUser | null>(() => (
    IS_LOCAL_DESKTOP && IS_LOCAL_AUTH_READY ? { username: 'local-user' } : null
  ));
  const [token, setToken] = useState<string | null>(() => readStoredToken());
  const [isLoading, setIsLoading] = useState(!IS_LOCAL_DESKTOP || !IS_LOCAL_AUTH_READY);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [hasCompletedOnboarding, setHasCompletedOnboarding] = useState(true);
  const [error, setError] = useState<string | null>(() => (
    IS_LOCAL_DESKTOP && !IS_LOCAL_AUTH_READY
      ? t('localDesktop.localAuthInitFailed')
      : null
  ));

  const setSession = useCallback((nextUser: AuthUser, nextToken: string) => {
    setUser(nextUser);
    setToken(nextToken);
    persistToken(nextToken);
  }, []);

  const clearSession = useCallback(() => {
    setUser(null);
    setToken(null);
    clearStoredToken();
  }, []);

  const checkOnboardingStatus = useCallback(async () => {
    try {
      const payload = await apiClient.get<OnboardingStatusPayload>(
        '/api/user/onboarding-status',
      );
      setHasCompletedOnboarding(Boolean(payload?.hasCompletedOnboarding));
    } catch (caughtError) {
      console.error('Error checking onboarding status:', caughtError);
      // Fail open to avoid blocking access on transient onboarding status errors.
      setHasCompletedOnboarding(true);
    }
  }, []);

  const refreshOnboardingStatus = useCallback(async () => {
    await checkOnboardingStatus();
  }, [checkOnboardingStatus]);

  const checkAuthStatus = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusPayload = await apiClient.get<AuthStatusPayload>('/api/auth/status');

      if (statusPayload?.needsSetup) {
        setNeedsSetup(true);
        return;
      }

      setNeedsSetup(false);

      if (!token) {
        return;
      }

      const userPayload = await apiClient.get<AuthUserPayload>('/api/auth/user');
      if (!userPayload?.user) {
        clearSession();
        return;
      }

      setUser(userPayload.user);
      await checkOnboardingStatus();
    } catch (caughtError) {
      console.error('[Auth] Auth status check failed:', caughtError);
      if (caughtError instanceof ApiError && caughtError.status === 401) {
        clearSession();
      } else {
        setError(AUTH_ERROR_MESSAGES.authStatusCheckFailed);
      }
    } finally {
      setIsLoading(false);
    }
  }, [checkOnboardingStatus, clearSession, token]);

  useEffect(() => {
    if (IS_LOCAL_DESKTOP) {
      if (!IS_LOCAL_AUTH_READY) {
        setUser(null);
        setError(t('localDesktop.localAuthInitFailed'));
        setIsLoading(false);
        return;
      }
      setUser({ username: 'local-user' });
      setNeedsSetup(false);
      setHasCompletedOnboarding(true);
      setIsLoading(false);
      return;
    }

    if (IS_PLATFORM) {
      setUser({ username: 'platform-user' });
      setNeedsSetup(false);
      void checkOnboardingStatus().finally(() => {
        setIsLoading(false);
      });
      return;
    }

    void checkAuthStatus();
  }, [checkAuthStatus, checkOnboardingStatus, t]);

  const login = useCallback<AuthContextValue['login']>(
    async (username, password) => {
      try {
        setError(null);
        const payload = await apiClient.post<AuthSessionPayload>('/api/auth/login', { username, password });

        if (!payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.loginFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Login error:', caughtError);
        const message = caughtError instanceof ApiError
          ? resolveApiErrorMessage(caughtError.payload, caughtError.message || AUTH_ERROR_MESSAGES.loginFailed)
          : AUTH_ERROR_MESSAGES.networkError;
        setError(message);
        return { success: false, error: message };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const register = useCallback<AuthContextValue['register']>(
    async (username, password) => {
      try {
        setError(null);
        const payload = await apiClient.post<AuthSessionPayload>('/api/auth/register', { username, password });

        if (!payload?.token || !payload.user) {
          const message = resolveApiErrorMessage(payload, AUTH_ERROR_MESSAGES.registrationFailed);
          setError(message);
          return { success: false, error: message };
        }

        setSession(payload.user, payload.token);
        setNeedsSetup(false);
        await checkOnboardingStatus();
        return { success: true };
      } catch (caughtError) {
        console.error('Registration error:', caughtError);
        const message = caughtError instanceof ApiError
          ? resolveApiErrorMessage(caughtError.payload, caughtError.message || AUTH_ERROR_MESSAGES.registrationFailed)
          : AUTH_ERROR_MESSAGES.networkError;
        setError(message);
        return { success: false, error: message };
      }
    },
    [checkOnboardingStatus, setSession],
  );

  const logout = useCallback(() => {
    if (IS_LOCAL_DESKTOP) return;
    const tokenToInvalidate = token;
    clearSession();

    if (tokenToInvalidate) {
      void apiClient.post('/api/auth/logout').catch((caughtError: unknown) => {
        console.error('Logout endpoint error:', caughtError);
      });
    }
  }, [clearSession, token]);

  const contextValue = useMemo<AuthContextValue>(
    () => ({
      user,
      token,
      isLoading,
      needsSetup,
      hasCompletedOnboarding,
      error,
      login,
      register,
      logout,
      refreshOnboardingStatus,
    }),
    [
      error,
      hasCompletedOnboarding,
      isLoading,
      login,
      logout,
      needsSetup,
      refreshOnboardingStatus,
      register,
      token,
      user,
    ],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
}
