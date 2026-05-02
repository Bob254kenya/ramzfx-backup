// src/contexts/AuthContext.tsx - Complete with OAuth redirect handling

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { derivApi, getOAuthUrl, parseDerivRedirect, TokenManager, type DerivAccount } from "@/services/deriv-api";

interface AuthContextType {
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

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<DerivAccount[]>([]);
  const [activeAccount, setActiveAccount] = useState<DerivAccount | null>(null);
  const [balance, setBalance] = useState(0);
  
  const navigate = useNavigate();
  const location = useLocation();
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
      
      if (balanceIntervalRef.current) clearInterval(balanceIntervalRef.current);
      balanceIntervalRef.current = setInterval(refreshBalance, 1000);
      
      console.log('Connected to account:', account.loginid);
      return true;
    } catch (err: any) {
      console.error('Connection failed:', err);
      setAuthError(err.message || 'Connection failed');
      setIsAuthorized(false);
      setActiveAccount(null);
      return false;
    }
  }, [refreshBalance]);

  // Handle OAuth redirect when coming BACK to ramzfx.site
  useEffect(() => {
    const handleRedirect = async () => {
      const isCallbackUrl = location.pathname === '/oauth/callback';
      const hash = window.location.hash;
      
      console.log('Location:', location.pathname, 'Hash exists:', !!hash);
      
      if (isCallbackUrl && hash && hash.includes('token1') && !oauthProcessed.current) {
        oauthProcessed.current = true;
        console.log('Processing OAuth redirect callback...');
        
        const parsedAccounts = parseDerivRedirect(hash);
        
        if (parsedAccounts.length > 0) {
          const allowedAccounts = parsedAccounts.filter(a => 
            !a.loginid.startsWith('CRW') && !a.loginid.startsWith('VRW')
          );
          
          if (allowedAccounts.length > 0) {
            TokenManager.saveAccounts(allowedAccounts);
            setAccounts(allowedAccounts);
            
            const demoAccount = allowedAccounts.find(a => a.is_virtual);
            const accountToUse = demoAccount || allowedAccounts[0];
            
            console.log('Using account:', accountToUse.loginid);
            await connectAccount(accountToUse);
            
            // Navigate to home after successful login
            navigate('/', { replace: true });
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
  }, [location.pathname, navigate, connectAccount]);

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
    console.log('Initiating login - redirecting to Deriv');
    TokenManager.clearAuthState();
    derivApi.disconnect();
    oauthProcessed.current = false;
    const oauthUrl = getOAuthUrl('login');
    window.location.href = oauthUrl;
  }, []);

  const signup = useCallback(() => {
    console.log('Initiating signup - redirecting to Deriv');
    TokenManager.clearAuthState();
    derivApi.disconnect();
    oauthProcessed.current = false;
    const oauthUrl = getOAuthUrl('registration');
    window.location.href = oauthUrl;
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
    navigate('/');
    console.log('Logged out');
  }, [navigate]);

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
