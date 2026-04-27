import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";

import {
  derivApi,
  parseOAuthRedirect,
  getOAuthUrl,
  type DerivAccount,
  type AuthorizeResponse,
} from "@/services/deriv-api";

import { useNavigate, useLocation } from "react-router-dom";

interface AuthState {
  isAuthorized: boolean;
  isLoading: boolean;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  accountInfo: AuthorizeResponse["authorize"] | null;
  balance: number;
  login: () => void;
  logout: () => void;
  switchAccount: (loginid: string) => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

// Helper function to filter out CRW and VRW accounts
const filterAllowedAccounts = (accounts: DerivAccount[]): DerivAccount[] => {
  console.log('Filtering accounts:', accounts.map(a => a.loginid));
  
  const filtered = accounts.filter(account => {
    const loginid = account.loginid.toUpperCase();
    const isExcluded = loginid.startsWith('CRW') || loginid.startsWith('VRW');
    
    if (isExcluded) {
      console.log(`Excluding account: ${account.loginid}`);
    } else {
      console.log(`Keeping account: ${account.loginid}`);
    }
    
    return !isExcluded;
  });
  
  console.log('Filtered accounts:', filtered.map(a => a.loginid));
  return filtered;
};

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<DerivAccount | null>(null);
  const [accountInfo, setAccountInfo] =
    useState<AuthorizeResponse["authorize"] | null>(null);
  const [balance, setBalance] = useState(0);

  const location = useLocation();
  const navigate = useNavigate();

  const unsubscribeRef = useRef<null | (() => void)>(null);
  const authLock = useRef(false);
  const initialized = useRef(false);
  const isMounted = useRef(true);

  const cleanupSubscription = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  const selectAccount = useCallback(
    (available: DerivAccount[]) => {
      console.log('Selecting account from:', available.map(a => a.loginid));
      
      const saved = localStorage.getItem("last_active_loginid");

      if (saved) {
        const match = available.find((a) => a.loginid === saved);
        if (match) {
          console.log('Using saved account:', match.loginid);
          return match;
        }
      }

      const real = available.find((a) => !a.is_virtual);
      if (real) {
        console.log('Using real account:', real.loginid);
        return real;
      }

      console.log('Using first account:', available[0]?.loginid);
      return available[0];
    },
    []
  );

  const authorizeAccount = useCallback(
    async (account: DerivAccount) => {
      if (authLock.current) {
        console.log('Auth already in progress, skipping');
        return;
      }
      
      authLock.current = true;
      setAuthError(null);

      try {
        // Ensure WebSocket is disconnected before new authorization
        derivApi.disconnect();
        cleanupSubscription();

        console.log('Authorizing account:', account.loginid);
        const response = await derivApi.authorize(account.token);

        if (!isMounted.current) return;

        setAccountInfo(response.authorize);
        setBalance(response.authorize.balance);
        setActiveAccount(account);
        setIsAuthorized(true);
        setAuthError(null);

        localStorage.setItem("last_active_loginid", account.loginid);

        // Subscribe to balance updates
        unsubscribeRef.current = derivApi.onMessage((data) => {
          if (data?.balance && isMounted.current) {
            setBalance(data.balance.balance);
          }
        });

        await derivApi.getBalance();
        
        console.log('Authorization successful for:', account.loginid);
      } catch (err) {
        console.error("Auth failed:", err);
        if (isMounted.current) {
          setAuthError(err instanceof Error ? err.message : 'Authorization failed');
          setIsAuthorized(false);
          setActiveAccount(null);
        }
      } finally {
        if (isMounted.current) {
          authLock.current = false;
        }
      }
    },
    [cleanupSubscription]
  );

  // ✅ INIT AUTH ONLY ONCE (FIXED REDIRECT BUG)
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;
    isMounted.current = true;

    let cancelled = false;

    const init = async () => {
      setIsLoading(true);
      setAuthError(null);

      try {
        const search = location.search;

        // OAuth redirect login
        if (search.includes("acct1")) {
          console.log('OAuth redirect detected');
          const parsed = parseOAuthRedirect(search);
          console.log('Parsed accounts from OAuth:', parsed.map(a => a.loginid));

          if (parsed.length > 0 && !cancelled) {
            // Filter out CRW and VRW accounts
            const allowedAccounts = filterAllowedAccounts(parsed);
            
            if (allowedAccounts.length === 0) {
              console.warn('No allowed accounts found (CRW and VRW filtered out)');
              if (isMounted.current) {
                setAuthError('No valid accounts found. Please use a different account.');
              }
              setIsLoading(false);
              return;
            }
            
            localStorage.setItem(
              "deriv_accounts",
              JSON.stringify(allowedAccounts)
            );

            if (isMounted.current) {
              setAccounts(allowedAccounts);
            }

            const account = selectAccount(allowedAccounts);

            await authorizeAccount(account);

            if (!cancelled && isMounted.current) {
              // Clear the search params from URL
              navigate("/", { replace: true });
            }
          } else if (!cancelled && isMounted.current) {
            setIsLoading(false);
          }
          return;
        }

        // Stored session login
        const stored = localStorage.getItem("deriv_accounts");
        console.log('Stored accounts from localStorage:', stored);

        if (stored) {
          try {
            const parsed: DerivAccount[] = JSON.parse(stored);
            console.log('Parsed stored accounts:', parsed.map(a => a.loginid));
            
            // Filter out CRW and VRW accounts
            const allowedAccounts = filterAllowedAccounts(parsed);
            
            if (allowedAccounts.length === 0) {
              console.warn('No allowed accounts found in stored data');
              // Clear invalid stored data
              localStorage.removeItem("deriv_accounts");
              if (isMounted.current) {
                setIsLoading(false);
              }
              return;
            }

            if (isMounted.current) {
              setAccounts(allowedAccounts);
            }

            const account = selectAccount(allowedAccounts);
            await authorizeAccount(account);
          } catch (parseErr) {
            console.error('Error parsing stored accounts:', parseErr);
            localStorage.removeItem("deriv_accounts");
          }
        }
      } catch (err) {
        console.error("Init auth error:", err);
        if (isMounted.current) {
          setAuthError(err instanceof Error ? err.message : 'Initialization failed');
        }
      } finally {
        if (!cancelled && isMounted.current) {
          setIsLoading(false);
        }
      }
    };

    init();

    return () => {
      cancelled = true;
      isMounted.current = false;
    };
  }, [location.search, selectAccount, authorizeAccount, navigate]);

  // cleanup websocket on unmount
  useEffect(() => {
    return () => {
      cleanupSubscription();
      derivApi.disconnect();
    };
  }, [cleanupSubscription]);

  const login = useCallback(() => {
    // Clear any existing session before new login
    localStorage.removeItem("deriv_accounts");
    localStorage.removeItem("last_active_loginid");
    derivApi.disconnect();
    window.location.href = getOAuthUrl();
  }, []);

  const logout = useCallback(() => {
    cleanupSubscription();
    derivApi.disconnect();

    localStorage.removeItem("deriv_accounts");
    localStorage.removeItem("last_active_loginid");

    setIsAuthorized(false);
    setAccounts([]);
    setActiveAccount(null);
    setAccountInfo(null);
    setBalance(0);
    setAuthError(null);
  }, [cleanupSubscription]);

  const switchAccount = useCallback(async (loginid: string) => {
    const account = accounts.find((a) => a.loginid === loginid);
    if (!account) return;

    // Clear current state before switching
    setIsAuthorized(false);
    setActiveAccount(null);
    
    // Small delay to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await authorizeAccount(account);
  }, [accounts, authorizeAccount]);

  const value = useMemo(
    () => ({
      isAuthorized,
      isLoading,
      accounts,
      activeAccount,
      accountInfo,
      balance,
      authError,
      login,
      logout,
      switchAccount,
    }),
    [
      isAuthorized,
      isLoading,
      accounts,
      activeAccount,
      accountInfo,
      balance,
      authError,
      login,
      logout,
      switchAccount,
    ]
  );

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
