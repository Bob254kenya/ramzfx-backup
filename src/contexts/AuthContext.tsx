// src/contexts/AuthContext.tsx
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
  getOAuthUrl,
  handleOAuthRedirect,
  TokenManager,
  type DerivAccount,
  type AuthorizeResponse,
} from "@/services/deriv-api";

import { useNavigate, useLocation } from "react-router-dom";

interface AuthState {
  isAuthorized: boolean;
  isLoading: boolean;
  authError: string | null;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  accountInfo: AuthorizeResponse["authorize"] | null;
  balance: number;
  login: () => void;
  signup: () => void;
  logout: () => void;
  switchAccount: (loginid: string) => Promise<void>;
  getAccessToken: () => string | null;
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
  const oauthProcessed = useRef(false);

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
        localStorage.setItem("deriv_accounts", JSON.stringify(accounts));

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
    [cleanupSubscription, accounts]
  );

  // Load accounts from token manager after OAuth
  const loadAccountsFromToken = useCallback(async () => {
    const authState = TokenManager.getAuthState();
    if (authState?.accounts && authState.accounts.length > 0) {
      const allowedAccounts = filterAllowedAccounts(authState.accounts);
      
      if (allowedAccounts.length > 0) {
        setAccounts(allowedAccounts);
        
        // Update tokens in accounts with current access token
        const currentToken = TokenManager.getAccessToken();
        if (currentToken) {
          allowedAccounts.forEach(acc => {
            acc.token = currentToken;
          });
        }
        
        localStorage.setItem("deriv_accounts", JSON.stringify(allowedAccounts));
        
        const account = selectAccount(allowedAccounts);
        await authorizeAccount(account);
        return true;
      }
    }
    return false;
  }, [selectAccount, authorizeAccount]);

  // INIT AUTH WITH OAUTH 2.0 PKCE
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
        const code = new URLSearchParams(search).get('code');

        // OAUTH 2.0 PKCE REDIRECT (New flow)
        if (code && !oauthProcessed.current) {
          oauthProcessed.current = true;
          console.log('OAuth 2.0 PKCE redirect detected with code');
          
          try {
            const parsedAccounts = await handleOAuthRedirect(search);
            console.log('Parsed accounts from OAuth 2.0:', parsedAccounts?.map(a => a.loginid));

            if (parsedAccounts && parsedAccounts.length > 0 && !cancelled) {
              // Filter out CRW and VRW accounts
              const allowedAccounts = filterAllowedAccounts(parsedAccounts);
              
              if (allowedAccounts.length === 0) {
                console.warn('No allowed accounts found (CRW and VRW filtered out)');
                if (isMounted.current) {
                  setAuthError('No valid accounts found. Please use a different account.');
                }
                setIsLoading(false);
                return;
              }
              
              localStorage.setItem("deriv_accounts", JSON.stringify(allowedAccounts));

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
          } catch (oauthError: any) {
            console.error('OAuth 2.0 error:', oauthError);
            if (isMounted.current) {
              setAuthError(oauthError.message || 'OAuth authentication failed');
            }
            setIsLoading(false);
            // Clear URL params on error
            navigate("/", { replace: true });
          }
          return;
        }

        // LEGACY OAUTH REDIRECT (Backward compatibility - acct1 param)
        if (search.includes("acct1")) {
          console.log('Legacy OAuth redirect detected - please use new OAuth flow');
          setAuthError('Please use the updated login method');
          setIsLoading(false);
          return;
        }

        // Stored session login (OAuth 2.0 token)
        const hasValidToken = TokenManager.isAuthenticated();
        console.log('Stored token exists:', hasValidToken);

        if (hasValidToken) {
          const loaded = await loadAccountsFromToken();
          if (!loaded && isMounted.current) {
            // No accounts found but token exists - might need re-auth
            console.log('No accounts found with stored token');
            setIsLoading(false);
          }
        } else {
          // No stored session
          console.log('No stored session found');
          setIsLoading(false);
        }
      } catch (err) {
        console.error("Init auth error:", err);
        if (isMounted.current) {
          setAuthError(err instanceof Error ? err.message : 'Initialization failed');
        }
        setIsLoading(false);
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
  }, [location.search, selectAccount, authorizeAccount, navigate, loadAccountsFromToken]);

  // Check for token expiration periodically
  useEffect(() => {
    const checkTokenExpiry = () => {
      const authState = TokenManager.getAuthState();
      if (authState && authState.expires_at) {
        const timeToExpiry = authState.expires_at - Date.now();
        if (timeToExpiry <= 0) {
          console.log('Token expired, logging out');
          logout();
        } else if (timeToExpiry < 5 * 60 * 1000 && timeToExpiry > 0) {
          console.log('Token expiring soon, consider refresh');
          // Optionally trigger refresh here
          TokenManager.refreshToken().catch(console.error);
        }
      }
    };
    
    const interval = setInterval(checkTokenExpiry, 60000); // Check every minute
    return () => clearInterval(interval);
  }, []);

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
    TokenManager.clearAuthState();
    derivApi.disconnect();
    
    // Use OAuth 2.0 with PKCE
    getOAuthUrl('login').then(url => {
      window.location.href = url;
    }).catch(err => {
      console.error('Failed to generate OAuth URL:', err);
      setAuthError('Failed to initiate login');
    });
  }, []);

  const signup = useCallback(() => {
    // Clear any existing session before new signup
    localStorage.removeItem("deriv_accounts");
    localStorage.removeItem("last_active_loginid");
    TokenManager.clearAuthState();
    derivApi.disconnect();
    
    // Use OAuth 2.0 with registration prompt
    getOAuthUrl('registration').then(url => {
      window.location.href = url;
    }).catch(err => {
      console.error('Failed to generate signup URL:', err);
      setAuthError('Failed to initiate signup');
    });
  }, []);

  const logout = useCallback(() => {
    cleanupSubscription();
    derivApi.disconnect();
    TokenManager.clearAuthState();

    localStorage.removeItem("deriv_accounts");
    localStorage.removeItem("last_active_loginid");
    localStorage.removeItem("deriv_active_account");

    setIsAuthorized(false);
    setAccounts([]);
    setActiveAccount(null);
    setAccountInfo(null);
    setBalance(0);
    setAuthError(null);
    
    // Reset OAuth processed flag
    oauthProcessed.current = false;
  }, [cleanupSubscription]);

  const switchAccount = useCallback(async (loginid: string) => {
    const account = accounts.find((a) => a.loginid === loginid);
    if (!account) return;

    // Clear current state before switching
    setIsAuthorized(false);
    setActiveAccount(null);
    
    // Update token if needed
    const currentToken = TokenManager.getAccessToken();
    if (currentToken) {
      account.token = currentToken;
    }
    
    // Small delay to ensure cleanup
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await authorizeAccount(account);
  }, [accounts, authorizeAccount]);

  const getAccessToken = useCallback(() => {
    return TokenManager.getAccessToken();
  }, []);

  const value = useMemo(
    () => ({
      isAuthorized,
      isLoading,
      authError,
      accounts,
      activeAccount,
      accountInfo,
      balance,
      login,
      signup,
      logout,
      switchAccount,
      getAccessToken,
    }),
    [
      isAuthorized,
      isLoading,
      authError,
      accounts,
      activeAccount,
      accountInfo,
      balance,
      login,
      signup,
      logout,
      switchAccount,
      getAccessToken,
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
