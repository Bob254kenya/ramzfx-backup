// src/contexts/AuthContext.tsx (simplified, working version)

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { derivApi, getOAuthUrl, parseDerivRedirect, TokenManager, type DerivAccount } from "@/services/deriv-api";

interface AuthState {
  isAuthorized: boolean;
  isLoading: boolean;
  authError: string | null;
  accounts: DerivAccount[];
  activeAccount: DerivAccount | null;
  balance: number;
  login: () => void;
  signup: () => void;
  logout: () => void;
  switchAccount: (loginid: string) => Promise<void>;
  refreshBalance: () => Promise<number>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<DerivAccount | null>(null);
  const [balance, setBalance] = useState(0);
  
  const balanceIntervalRef = useRef<NodeJS.Timeout>();
  const oauthProcessed = useRef(false);

  const refreshBalance = useCallback(async (): Promise<number> => {
    if (!derivApi.isConnected) return balance;
    try {
      const response = await derivApi.getBalance();
      const newBalance = response.balance?.balance || 0;
      setBalance(newBalance);
      return newBalance;
    } catch (error) {
      console.error('Balance fetch failed:', error);
      return balance;
    }
  }, [balance]);

  const connectAccount = useCallback(async (account: DerivAccount) => {
    setAuthError(null);
    try {
      derivApi.disconnect();
      await derivApi.connect(account.token);
      await refreshBalance();
      
      setActiveAccount(account);
      setIsAuthorized(true);
      
      // Start balance polling
      if (balanceIntervalRef.current) clearInterval(balanceIntervalRef.current);
      balanceIntervalRef.current = setInterval(refreshBalance, 1000);
      
      return true;
    } catch (err: any) {
      console.error('Connection failed:', err);
      setAuthError(err.message || 'Connection failed');
      setIsAuthorized(false);
      setActiveAccount(null);
      return false;
    }
  }, [refreshBalance]);

  // Handle OAuth redirect
  useEffect(() => {
    const handleRedirect = async () => {
      const search = window.location.search;
      const hash = window.location.hash;
      
      // Check both search and hash for tokens
      const hasTokens = search.includes('token1') || hash.includes('token1');
      
      if (hasTokens && !oauthProcessed.current) {
        oauthProcessed.current = true;
        console.log('Processing OAuth redirect...');
        
        // Clean up URL - remove tokens from hash if present
        let queryToProcess = search;
        if (hash.includes('token1')) {
          queryToProcess = hash.substring(1); // Remove # from hash
          window.history.replaceState({}, '', window.location.pathname);
        } else if (search.includes('token1')) {
          window.history.replaceState({}, '', window.location.pathname);
        }
        
        const parsedAccounts = parseDerivRedirect(queryToProcess);
        console.log('Parsed accounts:', parsedAccounts.map(a => ({ loginid: a.loginid, is_virtual: a.is_virtual })));
        
        if (parsedAccounts.length > 0) {
          // Filter out VRW/CRW accounts if needed (keep VRTC demo and real accounts)
          const allowedAccounts = parsedAccounts.filter(a => 
            !a.loginid.startsWith('CRW') && !a.loginid.startsWith('VRW')
          );
          
          if (allowedAccounts.length > 0) {
            TokenManager.saveAccounts(allowedAccounts);
            setAccounts(allowedAccounts);
            
            // Try demo account first, then real
            const demoAccount = allowedAccounts.find(a => a.is_virtual);
            const realAccount = allowedAccounts.find(a => !a.is_virtual);
            const accountToUse = demoAccount || realAccount || allowedAccounts[0];
            
            await connectAccount(accountToUse);
          } else {
            setAuthError('No valid accounts found. Please use a different Deriv account.');
          }
        } else {
          setAuthError('No accounts received from Deriv. Please try again.');
        }
        
        setIsLoading(false);
      }
    };
    
    handleRedirect();
  }, [connectAccount]);

  // Load stored session on mount
  useEffect(() => {
    const loadStoredSession = async () => {
      const storedAccounts = TokenManager.getAccounts();
      const storedActive = TokenManager.getActiveAccount();
      
      if (storedAccounts && storedAccounts.length > 0 && storedActive) {
        console.log('Loading stored session for:', storedActive.loginid);
        setAccounts(storedAccounts);
        await connectAccount(storedActive);
      }
      setIsLoading(false);
    };
    
    loadStoredSession();
    
    return () => {
      if (balanceIntervalRef.current) clearInterval(balanceIntervalRef.current);
    };
  }, [connectAccount]);

  const login = useCallback(() => {
    TokenManager.clearAuthState();
    derivApi.disconnect();
    oauthProcessed.current = false;
    window.location.href = getOAuthUrl('login');
  }, []);

  const signup = useCallback(() => {
    TokenManager.clearAuthState();
    derivApi.disconnect();
    oauthProcessed.current = false;
    window.location.href = getOAuthUrl('registration');
  }, []);

  const logout = useCallback(() => {
    if (balanceIntervalRef.current) clearInterval(balanceIntervalRef.current);
    derivApi.disconnect();
    TokenManager.clearAuthState();
    setIsAuthorized(false);
    setAccounts([]);
    setActiveAccount(null);
    setBalance(0);
    setAuthError(null);
    oauthProcessed.current = false;
  }, []);

  const switchAccount = useCallback(async (loginid: string) => {
    const account = accounts.find(a => a.loginid === loginid);
    if (!account) return;
    
    TokenManager.saveAccounts(accounts, loginid);
    await connectAccount(account);
  }, [accounts, connectAccount]);

  const value = useMemo(() => ({
    isAuthorized,
    isLoading,
    authError,
    accounts,
    activeAccount,
    balance,
    login,
    signup,
    logout,
    switchAccount,
    refreshBalance,
  }), [isAuthorized, isLoading, authError, accounts, activeAccount, balance, login, signup, logout, switchAccount, refreshBalance]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
