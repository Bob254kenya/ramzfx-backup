// deriv-api.ts - OAuth 2.0 with PKCE Implementation

// ============================================
// CONFIGURATION
// ============================================

// Your OAuth App credentials from Deriv Dashboard
const DERIV_CLIENT_ID = '32ZV1tqChTs1hNdvQ7skk';  // OAuth App ID from Ramz Fx
const DERIV_REDIRECT_URI = 'https://ramzfx.site'; // Must match exactly
const DERIV_APP_ID = 131592; // Legacy support (kept for backward compatibility)

// API Endpoints
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const DERIV_AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const DERIV_TOKEN_URL = 'https://auth.deriv.com/oauth2/token';

// ============================================
// TYPES
// ============================================

export interface DerivAccount {
  loginid: string;
  token: string;
  currency: string;
  is_virtual: boolean;
  refresh_token?: string;
  expires_at?: number;
}

export interface AuthState {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type: string;
  scope: string;
  active_loginid?: string;
  accounts?: DerivAccount[];
}

export interface AuthorizeResponse {
  authorize: {
    loginid: string;
    balance: number;
    currency: string;
    is_virtual: number;
    email: string;
    fullname: string;
    account_list: Array<{
      loginid: string;
      currency: string;
      is_virtual: number;
    }>;
  };
}

export interface TickData {
  tick: {
    symbol: string;
    epoch: number;
    quote: number;
    ask: number;
    bid: number;
  };
}

export interface TickHistoryResponse {
  history: {
    prices: number[];
    times: number[];
  };
}

export interface ContractResult {
  contractId: string;
  profit: number;
  status: 'won' | 'lost' | 'open';
  isExpired: boolean;
  buyPrice: number;
  sellPrice: number;
}

export type MessageHandler = (data: any) => void;

// ============================================
// PKCE HELPERS
// ============================================

/**
 * Generate a cryptographically random code verifier (43 characters)
 */
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '')
    .substring(0, 43);
}

/**
 * Generate SHA-256 code challenge from verifier
 */
async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Store PKCE verifier in sessionStorage with timestamp
 */
function storeCodeVerifier(verifier: string): void {
  sessionStorage.setItem('oauth_code_verifier', verifier);
  sessionStorage.setItem('oauth_code_verifier_timestamp', Date.now().toString());
}

/**
 * Retrieve and validate code verifier (expires after 10 minutes)
 */
function getCodeVerifier(): string | null {
  const verifier = sessionStorage.getItem('oauth_code_verifier');
  const timestamp = sessionStorage.getItem('oauth_code_verifier_timestamp');
  
  if (!verifier || !timestamp) return null;
  
  const age = Date.now() - parseInt(timestamp);
  if (age > 10 * 60 * 1000) { // 10 minutes expiry
    clearCodeVerifier();
    return null;
  }
  
  return verifier;
}

function clearCodeVerifier(): void {
  sessionStorage.removeItem('oauth_code_verifier');
  sessionStorage.removeItem('oauth_code_verifier_timestamp');
}

/**
 * Generate CSRF token for OAuth state parameter
 */
function generateCsrfToken(): string {
  const token = Math.random().toString(36).substring(2, 15);
  sessionStorage.setItem('oauth_csrf_token', token);
  sessionStorage.setItem('oauth_csrf_token_timestamp', Date.now().toString());
  return token;
}

function validateCsrfToken(token: string): boolean {
  const storedToken = sessionStorage.getItem('oauth_csrf_token');
  const timestamp = sessionStorage.getItem('oauth_csrf_token_timestamp');
  
  if (!storedToken || !timestamp) return false;
  if (storedToken !== token) return false;
  
  const age = Date.now() - parseInt(timestamp);
  if (age > 10 * 60 * 1000) return false; // Expired after 10 minutes
  
  return true;
}

// ============================================
// TOKEN MANAGEMENT
// ============================================

class TokenManager {
  private static readonly STORAGE_KEY = 'deriv_auth_state';
  
  static saveAuthState(state: AuthState): void {
    sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(state));
  }
  
  static getAuthState(): AuthState | null {
    const data = sessionStorage.getItem(this.STORAGE_KEY);
    if (!data) return null;
    
    const state: AuthState = JSON.parse(data);
    
    // Check if token is expired
    if (state.expires_at && Date.now() >= state.expires_at) {
      this.clearAuthState();
      return null;
    }
    
    return state;
  }
  
  static clearAuthState(): void {
    sessionStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem('deriv_active_account');
  }
  
  static getAccessToken(): string | null {
    return this.getAuthState()?.access_token || null;
  }
  
  static async refreshToken(): Promise<boolean> {
    const state = this.getAuthState();
    if (!state?.refresh_token) return false;
    
    try {
      const response = await fetch(DERIV_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: state.refresh_token,
          client_id: DERIV_CLIENT_ID,
        }),
      });
      
      if (!response.ok) return false;
      
      const data = await response.json();
      
      const newState: AuthState = {
        access_token: data.access_token,
        refresh_token: data.refresh_token || state.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000,
        token_type: data.token_type,
        scope: data.scope,
        active_loginid: state.active_loginid,
        accounts: state.accounts,
      };
      
      this.saveAuthState(newState);
      return true;
      
    } catch (error) {
      console.error('Token refresh failed:', error);
      return false;
    }
  }
}

// ============================================
// OAUTH 2.0 WITH PKCE
// ============================================

/**
 * Generate OAuth URL with PKCE parameters
 */
export async function getOAuthUrl(prompt?: 'login' | 'registration'): Promise<string> {
  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const csrfToken = generateCsrfToken();
  
  // Store verifier for later token exchange
  storeCodeVerifier(codeVerifier);
  
  // Build OAuth URL
  let url = `${DERIV_AUTH_URL}?` +
    `response_type=code&` +
    `client_id=${DERIV_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(DERIV_REDIRECT_URI)}&` +
    `state=${csrfToken}&` +
    `code_challenge=${codeChallenge}&` +
    `code_challenge_method=S256&` +
    `scope=${encodeURIComponent('account_manage trade')}`;
  
  if (prompt === 'registration') {
    url += `&prompt=registration`;
  }
  
  return url;
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForToken(code: string): Promise<AuthState | null> {
  const codeVerifier = getCodeVerifier();
  
  if (!codeVerifier) {
    throw new Error('PKCE code verifier not found or expired');
  }
  
  const response = await fetch(DERIV_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: DERIV_REDIRECT_URI,
      code_verifier: codeVerifier,
      client_id: DERIV_CLIENT_ID,
    }),
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }
  
  const data = await response.json();
  
  const authState: AuthState = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    token_type: data.token_type,
    scope: data.scope,
  };
  
  // Fetch accounts after successful auth
  const accounts = await fetchAccountsFromAPI(data.access_token);
  authState.accounts = accounts;
  
  if (accounts && accounts.length > 0) {
    authState.active_loginid = accounts[0].loginid;
    localStorage.setItem('deriv_active_account', accounts[0].loginid);
  }
  
  TokenManager.saveAuthState(authState);
  clearCodeVerifier();
  sessionStorage.removeItem('oauth_csrf_token');
  sessionStorage.removeItem('oauth_csrf_token_timestamp');
  
  return authState;
}

/**
 * Fetch accounts using access token
 */
async function fetchAccountsFromAPI(accessToken: string): Promise<DerivAccount[]> {
  const ws = new WebSocket(DERIV_WS_URL);
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Account fetch timeout')), 10000);
    
    ws.onopen = () => {
      ws.send(JSON.stringify({ 
        authorize: accessToken,
        req_id: 1 
      }));
    };
    
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.msg_type === 'authorize') {
        clearTimeout(timeout);
        
        const accounts: DerivAccount[] = data.authorize.account_list.map((acc: any) => ({
          loginid: acc.loginid,
          token: accessToken, // Same token for all accounts
          currency: acc.currency,
          is_virtual: acc.is_virtual === 1,
        }));
        
        ws.close();
        resolve(accounts);
      }
      
      if (data.error) {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(data.error.message));
      }
    };
    
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error('WebSocket error fetching accounts'));
    };
  });
}

/**
 * Parse OAuth redirect and exchange code for token
 */
export async function handleOAuthRedirect(search: string): Promise<DerivAccount[] | null> {
  const params = new URLSearchParams(search);
  const code = params.get('code');
  const state = params.get('state');
  const error = params.get('error');
  
  if (error) {
    console.error('OAuth error:', error);
    return null;
  }
  
  if (!code) {
    return null;
  }
  
  // Validate CSRF token
  if (!state || !validateCsrfToken(state)) {
    console.error('Invalid CSRF token');
    return null;
  }
  
  try {
    const authState = await exchangeCodeForToken(code);
    
    if (!authState || !authState.accounts) {
      return null;
    }
    
    return authState.accounts;
    
  } catch (error) {
    console.error('OAuth token exchange failed:', error);
    return null;
  }
}

// ============================================
// DERIV API CLASS (UPDATED FOR OAuth 2.0)
// ============================================

class DerivAPI {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private handlers: Map<number, (data: any) => void> = new Map();
  private subscriptionHandlers: Map<string, MessageHandler[]> = new Map();
  private globalHandlers: MessageHandler[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private activeCurrency: string = 'USD';
  private currentAccessToken: string | null = null;
  private tokenRefreshInProgress = false;

  get isConnected() { return this.connected; }

  setActiveCurrency(currency: string) {
    this.activeCurrency = currency;
  }

  /**
   * Get valid access token (auto-refresh if needed)
   */
  private async getValidToken(): Promise<string | null> {
    let token = TokenManager.getAccessToken();
    
    if (!token) {
      return null;
    }
    
    // Check if token needs refresh (within 5 minutes of expiry)
    const state = TokenManager.getAuthState();
    if (state && state.expires_at && (state.expires_at - Date.now()) < 5 * 60 * 1000) {
      if (!this.tokenRefreshInProgress) {
        this.tokenRefreshInProgress = true;
        const refreshed = await TokenManager.refreshToken();
        this.tokenRefreshInProgress = false;
        
        if (refreshed) {
          token = TokenManager.getAccessToken();
        }
      } else {
        // Wait for refresh in progress
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.getValidToken();
      }
    }
    
    return token;
  }

  /**
   * Connect and authorize with OAuth 2.0 token
   */
  async connect(accessToken?: string): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    
    // Get token if not provided
    let token = accessToken || await this.getValidToken();
    
    if (!token) {
      throw new Error('No valid access token available. Please login first.');
    }
    
    this.currentAccessToken = token;
    
    this.connectPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(DERIV_WS_URL);
      
      this.ws.onopen = () => {
        // Authorize with OAuth token
        this.send({ authorize: token })
          .then(() => {
            this.connected = true;
            resolve();
          })
          .catch(reject);
      };
      
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        // Handle token expiration
        if (data.error?.code === 'InvalidToken' || data.error?.code === 'AuthorizationRequired') {
          console.warn('Token invalid or expired, clearing session');
          TokenManager.clearAuthState();
          this.connected = false;
          this.connectPromise = null;
          return;
        }
        
        if (data.req_id && this.handlers.has(data.req_id)) {
          this.handlers.get(data.req_id)!(data);
          this.handlers.delete(data.req_id);
        }
        
        if (data.tick) {
          const symbol = data.tick.symbol;
          const handlers = this.subscriptionHandlers.get(symbol) || [];
          handlers.forEach(h => h(data));
        }
        
        this.globalHandlers.forEach(h => h(data));
      };
      
      this.ws.onclose = () => {
        this.connected = false;
        this.connectPromise = null;
      };
      
      this.ws.onerror = (err) => {
        this.connected = false;
        this.connectPromise = null;
        reject(err);
      };
    });
    
    return this.connectPromise;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.connected = false;
      this.connectPromise = null;
      this.handlers.clear();
      this.subscriptionHandlers.clear();
    }
  }

  private send(data: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error('WebSocket not connected'));
        return;
      }
      const reqId = ++this.reqId;
      data.req_id = reqId;
      this.handlers.set(reqId, resolve);
      this.ws.send(JSON.stringify(data));
      
      setTimeout(() => {
        if (this.handlers.has(reqId)) {
          this.handlers.delete(reqId);
          reject(new Error('Request timeout'));
        }
      }, 30000);
    });
  }

  /**
   * Authorize with token (backward compatible)
   */
  async authorize(token: string): Promise<AuthorizeResponse> {
    await this.connect(token);
    const response = await this.send({ authorize: token });
    if (response.error) throw new Error(response.error.message);
    if (response.authorize && response.authorize.currency) {
      this.setActiveCurrency(response.authorize.currency);
    }
    return response;
  }

  /**
   * Reconnect with refreshed token
   */
  async reconnect(): Promise<void> {
    const newToken = await this.getValidToken();
    if (!newToken) {
      throw new Error('No valid token available for reconnection');
    }
    
    this.disconnect();
    await this.connect(newToken);
  }

  async getBalance(): Promise<any> {
    const response = await this.send({ balance: 1, subscribe: 1 });
    if (response.error) throw new Error(response.error.message);
    return response;
  }

  async subscribeTicks(symbol: string, handler: MessageHandler) {
    const existing = this.subscriptionHandlers.get(symbol) || [];
    existing.push(handler);
    this.subscriptionHandlers.set(symbol, existing);
    
    if (existing.length === 1) {
      await this.send({ ticks: symbol, subscribe: 1 });
    }
  }
  
  async unsubscribeTicks(symbol: string) {
    this.subscriptionHandlers.delete(symbol);
    try {
      await this.send({ forget_all: 'ticks' });
    } catch {}
  }
  
  async getTickHistory(symbol: string, count: number = 100): Promise<TickHistoryResponse> {
    const response = await this.send({
      ticks_history: symbol,
      count,
      end: 'latest',
      style: 'ticks',
    });
    if (response.error) throw new Error(response.error.message);
    return response;
  }
  
  async buyContract(params: {
    contract_type: string;
    symbol: string;
    duration: number;
    duration_unit: string;
    basis: string;
    amount: number;
    barrier?: string;
    currency?: string;
  }): Promise<{ contractId: string; buyPrice: number }> {
    const proposalReq: any = {
      proposal: 1,
      contract_type: params.contract_type,
      symbol: params.symbol,
      duration: params.duration,
      duration_unit: params.duration_unit,
      basis: params.basis,
      amount: params.amount,
      currency: params.currency || this.activeCurrency || 'USD',
    };
    if (params.barrier !== undefined) {
      proposalReq.barrier = params.barrier;
    }
    
    const proposal = await this.send(proposalReq);
    if (proposal.error) throw new Error(proposal.error.message);
    
    const buyResponse = await this.send({
      buy: proposal.proposal.id,
      price: params.amount,
    });
    if (buyResponse.error) throw new Error(buyResponse.error.message);
    
    return {
      contractId: String(buyResponse.buy.contract_id),
      buyPrice: buyResponse.buy.buy_price,
    };
  }
  
  waitForContractResult(contractId: string): Promise<ContractResult> {
    return new Promise((resolve, reject) => {
      let subscriptionId: string | null = null;
      const timeout = setTimeout(() => {
        reject(new Error('Contract result timeout (60s)'));
      }, 60000);
      
      const checkResult = (data: any) => {
        const poc = data.proposal_open_contract;
        if (!poc) return;
        if (String(poc.contract_id) !== String(contractId)) return;
        
        const isSettled = poc.is_expired === 1 || poc.is_sold === 1 || poc.status === 'sold';
        
        if (isSettled) {
          clearTimeout(timeout);
          
          if (subscriptionId) {
            this.send({ forget: subscriptionId }).catch(() => {});
          }
          
          this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
          
          const profit = poc.profit || (poc.sell_price - poc.buy_price) || 0;
          const won = profit > 0;
          
          resolve({
            contractId: String(poc.contract_id),
            profit,
            status: won ? 'won' : 'lost',
            isExpired: poc.is_expired === 1,
            buyPrice: poc.buy_price || 0,
            sellPrice: poc.sell_price || 0,
          });
        }
      };
      
      this.globalHandlers.push(checkResult);
      
      this.send({
        proposal_open_contract: 1,
        contract_id: contractId,
        subscribe: 1,
      }).then(data => {
        if (data.error) {
          clearTimeout(timeout);
          this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
          reject(new Error(data.error.message));
          return;
        }
        if (data.subscription) {
          subscriptionId = data.subscription.id;
        }
        checkResult(data);
      }).catch(err => {
        clearTimeout(timeout);
        this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
        reject(err);
      });
    });
  }
  
  async buy(params: {
    contract_type: string;
    symbol: string;
    duration: number;
    duration_unit: string;
    basis: string;
    amount: number;
    barrier?: string;
    currency?: string;
  }): Promise<any> {
    const { contractId, buyPrice } = await this.buyContract(params);
    const result = await this.waitForContractResult(contractId);
    return {
      buy: {
        contract_id: contractId,
        buy_price: buyPrice,
        profit: result.profit,
      },
      contractResult: result,
    };
  }
  
  onMessage(handler: MessageHandler) {
    this.globalHandlers.push(handler);
    return () => {
      this.globalHandlers = this.globalHandlers.filter(h => h !== handler);
    };
  }
  
  isAuthenticated(): boolean {
    return TokenManager.getAccessToken() !== null;
  }
  
  logout(): void {
    TokenManager.clearAuthState();
    this.disconnect();
  }
}

export const derivApi = new DerivAPI();

// Legacy exports for backward compatibility
export { TokenManager as OAuthTokenManager };

// ============================================
// MARKETS (unchanged)
// ============================================

export const MARKETS = [
  { symbol: '1HZ10V', name: 'Volatility 10 (1s)', group: 'vol' },
  { symbol: 'R_10', name: 'Volatility 10', group: 'vol' },
  { symbol: '1HZ15V', name: 'Volatility 15 (1s)', group: 'vol' },
  { symbol: '1HZ25V', name: 'Volatility 25 (1s)', group: 'vol' },
  { symbol: 'R_25', name: 'Volatility 25', group: 'vol' },
  { symbol: '1HZ30V', name: 'Volatility 30 (1s)', group: 'vol' },
  { symbol: '1HZ50V', name: 'Volatility 50 (1s)', group: 'vol' },
  { symbol: 'R_50', name: 'Volatility 50', group: 'vol' },
  { symbol: '1HZ75V', name: 'Volatility 75 (1s)', group: 'vol' },
  { symbol: 'R_75', name: 'Volatility 75', group: 'vol' },
  { symbol: '1HZ90V', name: 'Volatility 90 (1s)', group: 'vol' },
  { symbol: '1HZ100V', name: 'Volatility 100 (1s)', group: 'vol' },
  { symbol: 'R_100', name: 'Volatility 100', group: 'vol' },
  { symbol: 'JD10', name: 'Jump 10', group: 'jump' },
  { symbol: 'JD25', name: 'Jump 25', group: 'jump' },
  { symbol: 'JD50', name: 'Jump 50', group: 'jump' },
  { symbol: 'JD75', name: 'Jump 75', group: 'jump' },
  { symbol: 'JD100', name: 'Jump 100', group: 'jump' },
  { symbol: 'RDBULL', name: 'Bull Market', group: 'bull' },
  { symbol: 'RDBEAR', name: 'Bear Market', group: 'bear' },
] as const;

export type MarketSymbol = typeof MARKETS[number]['symbol'];

export const MARKET_GROUPS = [
  { value: 'vol', label: 'Volatilities' },
  { value: 'jump', label: 'Jump' },
  { value: 'bull', label: 'Bull' },
  { value: 'bear', label: 'Bear' },
] as const;
