const DERIV_APP_ID = 131592;
const DERIV_WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${DERIV_APP_ID}`;
const DERIV_OAUTH_URL = `https://oauth.deriv.com/oauth2/authorize?app_id=${DERIV_APP_ID}&brand=deriv`;

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

class DerivAPI {
  private ws: WebSocket | null = null;
  private reqId = 0;
  private handlers: Map<number, (data: any) => void> = new Map();
  private subscriptionHandlers: Map<string, MessageHandler[]> = new Map();
  private globalHandlers: MessageHandler[] = [];
  private connected = false;
  private connectPromise: Promise<void> | null = null;
  private activeCurrency: string = 'USD';
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;

  get isConnected() { return this.connected; }

  setActiveCurrency(currency: string) {
    this.activeCurrency = currency;
  }

  private async reconnect(): Promise<void> {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnection attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    
    console.log(`Attempting to reconnect in ${delay}ms...`);
    
    await new Promise(resolve => setTimeout(resolve, delay));
    
    if (!this.connected) {
      await this.connect();
    }
  }

  connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    
    this.connectPromise = new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(DERIV_WS_URL);
        
        this.ws.onopen = () => {
          console.log('WebSocket connected successfully');
          this.connected = true;
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            
            // Handle timeout responses properly
            if (data.error?.code === 'RequestTimeout') {
              console.warn('Request timeout received:', data.error);
              if (data.req_id && this.handlers.has(data.req_id)) {
                this.handlers.get(data.req_id)!({ error: data.error });
                this.handlers.delete(data.req_id);
              }
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
          } catch (err) {
            console.error('Error parsing WebSocket message:', err);
          }
        };

        this.ws.onclose = (event) => {
          console.log(`WebSocket disconnected: ${event.code} - ${event.reason}`);
          this.connected = false;
          this.connectPromise = null;
          
          // Attempt reconnect if not a normal closure
          if (event.code !== 1000) {
            this.reconnect().catch(console.error);
          }
        };

        this.ws.onerror = (err) => {
          console.error('WebSocket error:', err);
          this.connected = false;
          this.connectPromise = null;
          reject(err);
        };
      } catch (err) {
        reject(err);
      }
    });

    return this.connectPromise;
  }

  disconnect() {
    if (this.ws) {
      this.ws.close(1000, 'Normal closure');
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
      
      const timeoutId = setTimeout(() => {
        if (this.handlers.has(reqId)) {
          this.handlers.delete(reqId);
          reject(new Error(`Request timeout for ${JSON.stringify(data)}`));
        }
      }, 30000);
      
      this.handlers.set(reqId, (response) => {
        clearTimeout(timeoutId);
        resolve(response);
      });
      
      try {
        this.ws!.send(JSON.stringify(data));
      } catch (err) {
        clearTimeout(timeoutId);
        this.handlers.delete(reqId);
        reject(err);
      }
    });
  }

  async authorize(token: string): Promise<AuthorizeResponse> {
    await this.connect();
    const response = await this.send({ authorize: token });
    
    if (response.error) {
      throw new Error(response.error.message || response.error.code || 'Authorization failed');
    }
    
    if (response.authorize) {
      if (response.authorize.currency) {
        this.setActiveCurrency(response.authorize.currency);
      }
      return response;
    }
    
    throw new Error('Invalid authorize response');
  }

  async getBalance(): Promise<any> {
    const response = await this.send({ balance: 1 });
    if (response.error) throw new Error(response.error.message);
    return response;
  }

  async subscribeBalance(handler: MessageHandler) {
    return this.onMessage(handler);
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
        cleanup();
        reject(new Error('Contract result timeout (60s)'));
      }, 60000);

      const cleanup = () => {
        clearTimeout(timeout);
        if (subscriptionId) {
          this.send({ forget: subscriptionId }).catch(() => {});
        }
        this.globalHandlers = this.globalHandlers.filter(h => h !== checkResult);
      };

      const checkResult = (data: any) => {
        const poc = data.proposal_open_contract;
        if (!poc) return;
        if (String(poc.contract_id) !== String(contractId)) return;

        const isSettled = poc.is_expired === 1 || poc.is_sold === 1 || poc.status === 'sold';

        if (isSettled) {
          cleanup();

          const profit = typeof poc.profit === 'number' ? poc.profit : (poc.sell_price - poc.buy_price) || 0;
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
          cleanup();
          reject(new Error(data.error.message));
          return;
        }
        if (data.subscription) {
          subscriptionId = data.subscription.id;
        }
        checkResult(data);
      }).catch(err => {
        cleanup();
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

  onMessage(handler: MessageHandler): () => void {
    this.globalHandlers.push(handler);
    return () => {
      this.globalHandlers = this.globalHandlers.filter(h => h !== handler);
    };
  }
}

export const derivApi = new DerivAPI();

export function getOAuthUrl(): string {
  // Generate a random state parameter for security
  const state = Math.random().toString(36).substring(2) + Date.now().toString(36);
  // Store state in sessionStorage to verify on redirect
  sessionStorage.setItem('oauth_state', state);
  return `${DERIV_OAUTH_URL}&state=${state}`;
}

export function parseOAuthRedirect(search: string): DerivAccount[] {
  const params = new URLSearchParams(search);
  const accounts: DerivAccount[] = [];
  
  // Verify state parameter if present
  const state = params.get('state');
  const storedState = sessionStorage.getItem('oauth_state');
  
  if (state && storedState && state !== storedState) {
    console.error('OAuth state mismatch - possible CSRF attack');
    return [];
  }
  
  // Clear stored state after verification
  sessionStorage.removeItem('oauth_state');
  
  let i = 1;
  while (params.has(`acct${i}`)) {
    const loginid = params.get(`acct${i}`)!;
    const token = params.get(`token${i}`)!;
    const currency = params.get(`cur${i}`) || 'USD';
    
    // Skip invalid entries
    if (loginid && token) {
      accounts.push({
        loginid,
        token,
        currency,
        is_virtual: loginid.startsWith('VRTC'),
      });
    }
    i++;
  }
  
  return accounts;
}

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
