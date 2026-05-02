// src/services/deriv-api.ts - Complete working OAuth implementation

// ============================================
// CONFIGURATION
// ============================================

const DERIV_CLIENT_ID = '32ZV1tqChTs1hNdvQ7skk';
const DERIV_REDIRECT_URI = 'https://ramzfx.site/oauth/callback';
const DERIV_APP_ID = 131592;
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const DERIV_AUTH_URL = 'https://oauth.deriv.com/oauth2/authorize';

// ============================================
// TYPES
// ============================================

export interface DerivAccount {
  loginid: string;
  token: string;
  currency: string;
  is_virtual: boolean;
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
// OAUTH HELPERS
// ============================================

/**
 * Generate OAuth URL - Deriv redirects BACK to ramzfx.site/oauth/callback#token1=xxx
 */
export function getOAuthUrl(prompt?: 'login' | 'registration'): string {
  const state = Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
  sessionStorage.setItem('oauth_state', state);
  sessionStorage.setItem('oauth_state_timestamp', Date.now().toString());
  
  const params = new URLSearchParams({
    response_type: 'token',
    client_id: DERIV_CLIENT_ID,
    redirect_uri: DERIV_REDIRECT_URI,
    state: state,
    scope: 'read write trade',
  });
  
  if (prompt === 'registration') {
    params.set('prompt', 'registration');
  }
  
  console.log('OAuth URL:', `${DERIV_AUTH_URL}?${params.toString()}`);
  return `${DERIV_AUTH_URL}?${params.toString()}`;
}

/**
 * Parse tokens from Deriv redirect URL
 * Deriv redirects to: https://ramzfx.site/oauth/callback#token1=xxx&acct1=xxx&cur1=USD
 */
export function parseDerivRedirect(urlHash: string): DerivAccount[] {
  console.log('Parsing redirect hash:', urlHash.substring(0, 200));
  
  const hash = urlHash.startsWith('#') ? urlHash.substring(1) : urlHash;
  const params = new URLSearchParams(hash);
  
  const accounts: DerivAccount[] = [];
  let i = 1;
  
  while (params.has(`token${i}`)) {
    const loginid = params.get(`acct${i}`);
    const token = params.get(`token${i}`);
    const currency = params.get(`cur${i}`);
    
    if (loginid && token && currency) {
      accounts.push({
        loginid,
        token,
        currency,
        is_virtual: loginid.startsWith('VRTC'),
      });
      console.log(`Found account ${i}: ${loginid} (${currency})`);
    }
    i++;
  }
  
  // Validate CSRF state
  const receivedState = params.get('state');
  const storedState = sessionStorage.getItem('oauth_state');
  
  if (receivedState && storedState && receivedState !== storedState) {
    console.error('CSRF validation failed');
    return [];
  }
  
  // Clean up
  sessionStorage.removeItem('oauth_state');
  sessionStorage.removeItem('oauth_state_timestamp');
  
  return accounts;
}

// ============================================
// TOKEN MANAGEMENT
// ============================================

export class TokenManager {
  private static readonly STORAGE_KEY = 'deriv_auth_state';
  
  static saveAccounts(accounts: DerivAccount[], activeLoginid?: string): void {
    const data = {
      accounts,
      activeLoginid: activeLoginid || accounts[0]?.loginid,
      savedAt: Date.now(),
    };
    sessionStorage.setItem(this.STORAGE_KEY, JSON.stringify(data));
    
    if (accounts.length > 0) {
      localStorage.setItem('deriv_active_account', activeLoginid || accounts[0].loginid);
      localStorage.setItem('deriv_accounts', JSON.stringify(accounts));
    }
    console.log('Accounts saved:', accounts.map(a => a.loginid));
  }
  
  static getAccounts(): DerivAccount[] | null {
    const data = sessionStorage.getItem(this.STORAGE_KEY);
    if (!data) return null;
    
    try {
      const parsed = JSON.parse(data);
      return parsed.accounts || null;
    } catch {
      return null;
    }
  }
  
  static getActiveAccount(): DerivAccount | null {
    const accounts = this.getAccounts();
    if (!accounts || accounts.length === 0) return null;
    
    const activeId = localStorage.getItem('deriv_active_account');
    if (activeId) {
      const active = accounts.find(a => a.loginid === activeId);
      if (active) return active;
    }
    
    const demo = accounts.find(a => a.is_virtual);
    if (demo) return demo;
    return accounts[0];
  }
  
  static getActiveToken(): string | null {
    return this.getActiveAccount()?.token || null;
  }
  
  static clearAuthState(): void {
    sessionStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem('deriv_active_account');
    localStorage.removeItem('deriv_accounts');
    console.log('Auth state cleared');
  }
  
  static isAuthenticated(): boolean {
    return this.getActiveToken() !== null;
  }
}

// ============================================
// DERIV API CLASS
// ============================================

class DerivAPI {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private handlers = new Map<number, (data: any) => void>();
  private subscriptionHandlers = new Map<string, MessageHandler[]>();
  private globalHandlers: MessageHandler[] = [];
  private connected = false;
  private activeCurrency = 'USD';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get isConnected() { return this.connected; }

  setActiveCurrency(currency: string) {
    this.activeCurrency = currency;
  }

  async connect(accessToken?: string): Promise<void> {
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      console.log('Already connected');
      return;
    }
    
    let token = accessToken;
    if (!token) {
      const storedToken = TokenManager.getActiveToken();
      if (!storedToken) {
        throw new Error('No access token available. Please login first.');
      }
      token = storedToken;
    }
    
    console.log('Connecting to Deriv WebSocket...');
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Connection timeout (10s)'));
      }, 10000);
      
      this.ws = new WebSocket(DERIV_WS_URL);
      
      this.ws.onopen = () => {
        console.log('WebSocket opened, authorizing...');
        this.send({ authorize: token })
          .then((response) => {
            clearTimeout(timeout);
            if (response.error) {
              console.error('Authorization error:', response.error);
              reject(new Error(response.error.message));
              return;
            }
            if (response.authorize?.currency) {
              this.activeCurrency = response.authorize.currency;
            }
            this.connected = true;
            this.reconnectAttempts = 0;
            console.log('Connected and authorized successfully');
            resolve();
          })
          .catch(reject);
      };
      
      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        clearTimeout(timeout);
        reject(new Error('WebSocket connection error'));
      };
      
      this.ws.onclose = (event) => {
        console.log('WebSocket closed:', event.code, event.reason);
        this.connected = false;
        
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.scheduleReconnect();
        }
      };
      
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      };
    });
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    
    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);
    
    this.reconnectTimer = setTimeout(async () => {
      const token = TokenManager.getActiveToken();
      if (token) {
        try {
          await this.connect(token);
        } catch (error) {
          console.error('Reconnect failed:', error);
        }
      }
    }, delay);
  }

  private handleMessage(data: any) {
    if (data.error?.code === 'InvalidToken' || data.error?.code === 'AuthorizationRequired') {
      console.warn('Token expired or invalid');
      TokenManager.clearAuthState();
      this.connected = false;
      return;
    }
    
    if (data.req_id && this.handlers.has(data.req_id)) {
      this.handlers.get(data.req_id)!(data);
      this.handlers.delete(data.req_id);
    }
    
    if (data.tick) {
      const handlers = this.subscriptionHandlers.get(data.tick.symbol) || [];
      handlers.forEach(h => h(data));
    }
    
    if (data.balance) {
      this.globalHandlers.forEach(h => h({ type: 'balance', balance: data.balance }));
    }
    
    this.globalHandlers.forEach(h => h(data));
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
          reject(new Error(`Request timeout: ${JSON.stringify(data)}`));
        }
      }, 30000);
    });
  }

  async authorize(token: string): Promise<AuthorizeResponse> {
    await this.connect(token);
    const response = await this.send({ authorize: token });
    if (response.error) throw new Error(response.error.message);
    return response;
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
      console.log(`Subscribed to ${symbol} ticks`);
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
      count: Math.min(count, 20000),
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
      const timeout = setTimeout(() => {
        reject(new Error('Contract result timeout (60s)'));
      }, 60000);
      
      let subscriptionId: string | null = null;
      
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
      const index = this.globalHandlers.indexOf(handler);
      if (index !== -1) this.globalHandlers.splice(index, 1);
    };
  }
  
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.handlers.clear();
    this.subscriptionHandlers.clear();
    this.globalHandlers = [];
    console.log('Disconnected from Deriv');
  }
}

export const derivApi = new DerivAPI();
