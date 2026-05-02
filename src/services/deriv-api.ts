// deriv-api.ts - REAL Deriv OAuth Flow (tokens in URL, no code exchange)

// ============================================
// CONFIGURATION
// ============================================

const DERIV_CLIENT_ID = '32ZV1tqChTs1hNdvQ7skk';
const DERIV_REDIRECT_URI = 'https://ramzfx.site/oauth/callback'; // MUST match registered URI
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

export type MessageHandler = (data: any) => void;

// ============================================
// REAL DERIV OAUTH - TOKENS IN URL
// ============================================

/**
 * Generate OAuth URL - Deriv returns tokens directly, NO code exchange
 */
export function getOAuthUrl(prompt?: 'login' | 'registration'): string {
  // Generate simple state for CSRF (optional but good)
  const state = Math.random().toString(36).substring(2, 15);
  sessionStorage.setItem('oauth_state', state);
  
  let url = `${DERIV_AUTH_URL}?` +
    `response_type=token&` +  // IMPORTANT: 'token' not 'code'
    `client_id=${DERIV_CLIENT_ID}&` +
    `redirect_uri=${encodeURIComponent(DERIV_REDIRECT_URI)}&` +
    `state=${state}&` +
    `scope=${encodeURIComponent('read write trade')}`;
  
  if (prompt === 'registration') {
    url += `&prompt=registration`;
  }
  
  return url;
}

/**
 * Parse tokens from Deriv redirect URL
 * Deriv redirects to: https://ramzfx.site/oauth/callback?token1=xxx&acct1=xxx&cur1=USD&token2=xxx&acct2=xxx...
 */
export function parseDerivRedirect(search: string): DerivAccount[] {
  const params = new URLSearchParams(search);
  const accounts: DerivAccount[] = [];
  
  // Deriv returns token1, token2, token3... for each account
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
        is_virtual: loginid.startsWith('VRTC'), // VRTC = demo, VRW = real
      });
    }
    i++;
  }
  
  // Validate state for CSRF protection
  const state = params.get('state');
  const savedState = sessionStorage.getItem('oauth_state');
  if (state && savedState && state !== savedState) {
    console.error('CSRF validation failed');
    return [];
  }
  
  // Clean up
  sessionStorage.removeItem('oauth_state');
  
  return accounts;
}

// ============================================
// TOKEN MANAGEMENT (Simplified)
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
    
    // Also save for quick access
    if (accounts.length > 0) {
      localStorage.setItem('deriv_active_account', activeLoginid || accounts[0].loginid);
      localStorage.setItem('deriv_accounts', JSON.stringify(accounts));
    }
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
    
    return accounts[0];
  }
  
  static getActiveToken(): string | null {
    return this.getActiveAccount()?.token || null;
  }
  
  static clearAuthState(): void {
    sessionStorage.removeItem(this.STORAGE_KEY);
    localStorage.removeItem('deriv_active_account');
    localStorage.removeItem('deriv_accounts');
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

  get isConnected() { return this.connected; }

  setActiveCurrency(currency: string) {
    this.activeCurrency = currency;
  }

  async connect(accessToken: string): Promise<void> {
    if (this.connected) {
      // If already connected with same token, return
      return;
    }
    
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(DERIV_WS_URL);
      const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);
      
      this.ws.onopen = () => {
        this.send({ authorize: accessToken })
          .then((response) => {
            clearTimeout(timeout);
            if (response.error) {
              reject(new Error(response.error.message));
              return;
            }
            if (response.authorize?.currency) {
              this.activeCurrency = response.authorize.currency;
            }
            this.connected = true;
            resolve();
          })
          .catch(reject);
      };
      
      this.ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket error'));
      };
      
      this.ws.onclose = () => {
        this.connected = false;
      };
      
      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      };
    });
  }

  private handleMessage(data: any) {
    // Request responses
    if (data.req_id && this.handlers.has(data.req_id)) {
      this.handlers.get(data.req_id)!(data);
      this.handlers.delete(data.req_id);
    }
    
    // Tick subscriptions
    if (data.tick) {
      const handlers = this.subscriptionHandlers.get(data.tick.symbol) || [];
      handlers.forEach(h => h(data));
    }
    
    // Global handlers
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
    }
  }
  
  async unsubscribeTicks(symbol: string) {
    this.subscriptionHandlers.delete(symbol);
    try {
      await this.send({ forget_all: 'ticks' });
    } catch {}
  }
  
  async getTickHistory(symbol: string, count: number = 100) {
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
  }) {
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
  
  waitForContractResult(contractId: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Contract result timeout')), 60000);
      
      const checkResult = async () => {
        try {
          const result = await this.send({
            proposal_open_contract: 1,
            contract_id: contractId,
          });
          
          if (result.error) {
            clearTimeout(timeout);
            reject(new Error(result.error.message));
            return;
          }
          
          const contract = result.proposal_open_contract;
          const isSettled = contract.is_expired === 1 || contract.is_sold === 1;
          
          if (isSettled) {
            clearTimeout(timeout);
            resolve({
              contractId: String(contract.contract_id),
              profit: contract.profit || 0,
              status: contract.profit > 0 ? 'won' : 'lost',
              buyPrice: contract.buy_price,
              sellPrice: contract.sell_price,
            });
          } else {
            setTimeout(checkResult, 1000);
          }
        } catch (err) {
          clearTimeout(timeout);
          reject(err);
        }
      };
      
      checkResult();
    });
  }
  
  onMessage(handler: MessageHandler) {
    this.globalHandlers.push(handler);
    return () => {
      const index = this.globalHandlers.indexOf(handler);
      if (index !== -1) this.globalHandlers.splice(index, 1);
    };
  }
  
  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    this.handlers.clear();
    this.subscriptionHandlers.clear();
  }
}

export const derivApi = new DerivAPI();
