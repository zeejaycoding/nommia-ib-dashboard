/**
 * NOMMIA IB DASHBOARD - API INTEGRATION V2
 * Clean, efficient implementation based on XValley Backoffice API docs
 */

import autobahn from 'autobahn-browser';

// Commission rates per instrument (Tier 1 rates per documentation)
// FX: $4.50/lot, Metals: $8.00/lot
const COMMISSION_RATES = {
  // FX pairs - $4.50/lot
  EURUSD: 4.5, GBPUSD: 4.5, USDJPY: 4.5, AUDUSD: 4.5, USDCAD: 4.5,
  NZDUSD: 4.5, USDCHF: 4.5, EURGBP: 4.5, EURJPY: 4.5, GBPJPY: 4.5,
  // Metals - $8.00/lot
  XAUUSD: 8, XAGUSD: 8,
  // Crypto - higher rate
  BTCUSD: 10, ETHUSD: 10,
  // Default (FX rate)
  default: 4.5
};

const API_CONFIG = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || "https://api.nommia.io",
  // Use the local Vite proxy in development, direct URL in production
  WS_URL: import.meta.env.DEV ? "ws://localhost:5173/ws-admin" : "wss://platform-admin.vanex.site/ws",
  REALM: "fxplayer",
  BROKER_HOST: import.meta.env.VITE_BROKER_HOST || "nommia.io",
  TOPICS: {
    PING: 'com.fxplayer.ping',
    LEADS: 'com.fxplayer.leads',
    TRADERS: 'com.fxplayer.traders',
    PLATFORM_CLOSE: 'com.fxplayer.platformclose',
    DEPOSITS: 'com.fxplayer.deposits',
    CONTACTS: 'com.fxplayer.contacts',
    ACCOUNT_TYPES: 'com.fxplayer.accounttypes',
    ACCOUNT_LEVELS: 'com.fxplayer.accountlevels',
    SAVE_USER: 'com.fxplayer.saveuser'
  }
};

// Global state
let wsSession = null;
let wsConnection = null;
let wsSessionId = null;
let sessionPartnerId = null;
let sessionCompanyId = null;  // Store CompanyId from session for filtering
let authToken = null;

// ============= AUTHENTICATION =============

export const loginAndGetToken = async (username, password) => {
  try {
    // Try /token endpoint first (per XValley User API docs)
    let response = await fetch(`${API_CONFIG.API_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        username: username,
        password: password
      })
    });
    
    // Fallback to /auth/login if /token fails
    if (!response.ok) {
      response = await fetch(`${API_CONFIG.API_BASE_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: username, password })
      });
    }
    
    if (!response.ok) throw new Error('Login failed');
    const data = await response.json();
    
    // XValley returns refresh_token from /token endpoint
    authToken = data.refresh_token || data.refreshToken || data.token || data.access_token;
    console.log("Auth token obtained:", authToken ? "Yes" : "No");
    return authToken;
  } catch (error) {
    console.error("Login Error:", error);
    throw error;
  }
};


export const fetchServerConfig = async () => {
  try {
    const response = await fetch(`${API_CONFIG.API_BASE_URL}/settings/servers`);
    if (!response.ok) {
      console.log("Server config not available, using defaults");
      return null;
    }
    const data = await response.json();
    const servers = Array.isArray(data[0]) ? data[0] : data;
    
    const serverConfig = {};
    servers.forEach(s => {
      if (s.name && s.host && s.port) {
        serverConfig[s.name] = { host: s.host, port: s.port, url: `wss://${s.host}:${s.port}/ws` };
      }
    });
    
    // Update WS_URL if we got AdminServer from config (only in production)
    if (!import.meta.env.DEV && serverConfig.AdminServer) {
      API_CONFIG.WS_URL = serverConfig.AdminServer.url;
      console.log("Updated WS_URL to:", API_CONFIG.WS_URL);
    }
    return serverConfig;
  } catch (e) {
    console.warn("Could not fetch server config:", e.message);
    return null;
  }
};

// ============= WEBSOCKET CONNECTION =============

export const connectWebSocket = (token) => {
  return new Promise((resolve, reject) => {
    if (wsSession) { resolve(wsSession); return; }
    
    authToken = token;
    wsConnection = new autobahn.Connection({
      url: API_CONFIG.WS_URL,
      realm: API_CONFIG.REALM,
      max_retries: 5,
      retry_delay_initial: 1,
      retry_delay_max: 10
    });

    wsConnection.onopen = async (session) => {
      console.log("WebSocket Connected to:", API_CONFIG.WS_URL);
      wsSession = session;
      
      try {
        // PING to authenticate
        const pingMsg = JSON.stringify({ token: authToken, host: API_CONFIG.BROKER_HOST });
        console.log("Sending PING with host:", API_CONFIG.BROKER_HOST);
        
        const result = await session.call(API_CONFIG.TOPICS.PING, [pingMsg]);
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        
        console.log("PING Response:", JSON.stringify(data, null, 2));
        
        if (data.MessageType === -3) {
          console.error("Auth Error:", data.Messages);
          reject(new Error(data.Messages?.[0] || 'Auth failed'));
          return;
        }
        
        // PING Response format: [username, [roles], tradingOpen, partnerId, companyId, ...]
        // Messages[0] = session username (e.g., "divinedollars")
        // Messages[1] = roles array (e.g., ["countrymanager"])
        // Messages[3] = PartnerId as string (e.g., "36")
        // Messages[4] = CompanyId as string (e.g., "5")
        wsSessionId = data.Messages?.[0] || null;
        console.log("Session ID (username):", wsSessionId);
        console.log("Roles:", data.Messages?.[1]);
        
        // PartnerId is at Messages[3] as a string
        const partnerIdStr = data.Messages?.[3];
        if (partnerIdStr) {
          sessionPartnerId = parseInt(partnerIdStr, 10);
          console.log("Extracted PartnerId:", sessionPartnerId);
        }
        
        // CompanyId is at Messages[4] as a string
        const companyIdStr = data.Messages?.[4];
        if (companyIdStr) {
          sessionCompanyId = parseInt(companyIdStr, 10);
          console.log("Extracted CompanyId:", sessionCompanyId);
        }
        
        if (!sessionPartnerId) {
          console.warn("No PartnerId found in PING response - this IB may not have partner access");
        }
        
        console.log("✅ Authenticated. PartnerId:", sessionPartnerId, "CompanyId:", sessionCompanyId);
        resolve(session);
      } catch (err) {
        console.error("PING Error:", err);
        reject(err);
      }
    };

    wsConnection.onclose = (reason) => {
      console.log("WebSocket Closed:", reason);
      wsSession = null;
    };

    wsConnection.open();
  });
};

export const disconnectWebSocket = () => {
  if (wsConnection) wsConnection.close();
  wsSession = null;
  wsConnection = null;
};

export const getSessionPartnerId = () => sessionPartnerId;

// ============= CORE DATA FETCHING =============

/**
 * Fetch all leads/customers from leads endpoint
 * Uses AdminType 2 for customers (per docs p8-9)
 * Returns: Registration, Email, UserName, LastLogin, Approved, ApprovedDate, Status, StatusString, etc.
 */
export const fetchIBClients = async (usernames = []) => {
  if (!wsSession) throw new Error("Not connected");
  
  console.log("Fetching customers for usernames:", usernames.length > 0 ? usernames.slice(0, 5) : "all");
  
  // Add CompanyId filter to only return customers for this company
  // This is critical to prevent loading customers from all companies
  const filters = [];
  if (sessionCompanyId) {
    filters.push({"Field": "CompanyId", "Value": String(sessionCompanyId)});
  }
  
  const msg = {
    MessageType: 100,
    Filters: filters,
    PageSize: 500,
    Sort: "Registration desc",
    Skip: 0,
    AdminType: 2  // 2 = Customers (per docs p8)
  };
  
  console.log("Leads request:", JSON.stringify(msg, null, 2));
  const result = await wsSession.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual clients...], Total }] }
  const wrapper = data?.Messages?.[0];
  const clients = wrapper?.Messages || [];
  
  if (!clients.length) {
    console.log("No clients found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  console.log(`Found ${clients.length} clients from leads endpoint (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Filter by usernames if provided
  let filteredClients = clients;
  if (usernames.length > 0) {
    const usernameSet = new Set(usernames.map(u => u.toLowerCase()));
    filteredClients = clients.filter(c => {
      const username = (c.UserName || c.A || '').toLowerCase();
      return usernameSet.has(username);
    });
    console.log(`Filtered to ${filteredClients.length} clients matching IB's usernames`);
  }
  
  // Log first client to see field names
  if (filteredClients[0]) {
    console.log("Sample client data:", JSON.stringify(filteredClients[0], null, 2));
  }
  
  // Map to client objects with all fields from docs (p8-9)
  // Includes: Approved, ApprovedDate, Status, StatusString, LastLogin for KYC/activity
  return filteredClients.map(lead => {
    // Determine KYC status from Approved field (docs p9)
    const isApproved = lead.Approved === true;
    const statusString = lead.StatusString || '';
    
    // Pending = not approved OR status contains 'Pending'
    const isPending = !isApproved || statusString.toLowerCase().includes('pending');
    
    // Determine KYC status
    let kycStatus = 'Pending';
    if (isApproved) {
      kycStatus = 'Approved';
    } else if (lead.Status === 2) { // Rejected status
      kycStatus = 'Rejected';
    }
    
    return {
      id: lead.Id || lead.I,
      username: lead.UserName || lead.A,
      email: lead.Email || lead.E,
      firstName: lead.FirstName,
      lastName: lead.LastName,
      name: `${lead.FirstName || ''} ${lead.LastName || ''}`.trim() || lead.UserName,
      phone: lead.PhoneNumber,
      country: lead.CountryName || 'Unknown',
      countryCode: lead.CountryIsoCode,
      
      // KYC fields (from docs p9)
      approved: isApproved,
      approvedDate: lead.ApprovedDate || null,
      kycStatus: kycStatus,
      isPending: isPending,
      status: lead.Status,
      statusString: statusString,
      
      // Activity tracking
      lastLogin: lead.LastLogin,
      deposit: lead.DepositsAmount || 0,
      depositTimes: lead.DepositTimes || 0,
      registrationDate: lead.Registration || lead.CreatedOn,
      
      // Partner/Company
      partnerId: lead.PartnerId,
      companyId: lead.CompanyId,
      companyName: lead.CompanyName,
      
      _raw: lead
    };
  });
};

/**
 * Fetch trading accounts for clients to get Equity, Balance, etc.
 */
export const fetchTradingAccountsBulk = async (partnerId) => {
  if (!wsSession) throw new Error("Not connected");
  
  const pid = partnerId || sessionPartnerId;
  console.log("Fetching trading accounts (will filter by partnerId client-side):", pid);
  
  // Note: T.PartnerId filter doesn't work server-side
  // Fetch all account types (12 = real + demo) and filter client-side
  // We need both to check for real accounts (TATD.Type === 1)
  const msg = {
    MessageType: 100,
    Filters: [],
    AdminType: 8,
    Sort: "Id desc",
    AccountType: "1",  // 1=real, 2=demo, 12=all - fetch all to filter by Type
    PageSize: 1000,
    Skip: 0
  };
  
  console.log("Traders request:", JSON.stringify(msg, null, 2));
  const result = await wsSession.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual accounts...], Total }] }
  const wrapper = data?.Messages?.[0];
  const accounts = wrapper?.Messages || [];
  
  if (!accounts.length) {
    console.log("No trading accounts found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  console.log(`Found ${accounts.length} trading accounts (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Filter by PartnerId client-side
  let filteredAccounts = accounts;
  if (pid) {
    filteredAccounts = accounts.filter(acc => acc.T?.PartnerId === pid);
    console.log(`Filtered to ${filteredAccounts.length} accounts for PartnerId ${pid}`);
  }
  
  // Log first account to see field structure
  if (filteredAccounts[0]) {
    const sample = filteredAccounts[0];
    const accountType = sample.TATD || {};
    const isReal = accountType.Type === 1;
    console.log("Sample trading account:", {
      AccountId: sample.I,
      AccountName: sample.Name,
      Active: sample.A,  // Trading account Active flag
      IsReal: isReal,    // TATD.Type === 1 means REAL account
      AccountType: accountType.Type,
      AccountTypeName: accountType.Name,
      Username: sample.T?.A,
      Email: sample.T?.E,
      UserApproved: sample.T?.Approved,  // KYC from T.Approved!
      TraderDeposited: sample.T?.Deposited,
      TraderState: sample.T?.State,
      Equity: sample.E,
      Balance: sample.BAL,
      DepositsAmount: sample.DepositsAmount,
      DepositTimes: sample.DepositTimes,
      PartnerId: sample.T?.PartnerId
    });
  }
  
  return filteredAccounts;
};

/**
 * Fetch all closed trades for volume calculation
 * Uses a single bulk request instead of per-account queries
 */
export const fetchClosedTradesBulk = async (partnerId, fromDate, toDate, accountIds = []) => {
  if (!wsSession) throw new Error("Not connected");
  
  const pid = partnerId || sessionPartnerId;
  
  // Note: Can't filter by TA.T.PartnerId (doesn't exist)
  // Filter by TraderAccountId if we have specific accounts, otherwise fetch all
  const filters = [];
  
  // If we have account IDs, we could filter by them (but may need multiple calls)
  // For now, fetch all and filter client-side by partnerId
  
  const msg = {
    MessageType: 100,
    From: fromDate || "",
    To: toDate || "",
    Filters: filters,
    AdminType: 205,
    Sort: "Id desc",
    AccountType: "1",
    PageSize: 2000,
    Skip: 0
  };
  
  console.log(`[fetchClosedTradesBulk] Fetching trades for PartnerId ${pid}, Date range: ${fromDate || 'ALL'} to ${toDate || 'ALL'}`);
  console.log("[fetchClosedTradesBulk] Request:", JSON.stringify(msg, null, 2));
  const result = await wsSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual trades...], Total }] }
  const wrapper = data?.Messages?.[0];
  const trades = wrapper?.Messages || [];
  
  if (!trades.length) {
    console.log("[fetchClosedTradesBulk] No trades found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  console.log(`[fetchClosedTradesBulk] Found ${trades.length} closed trades total (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Filter trades by partnerId if specified
  let filteredTrades = trades;
  if (pid) {
    filteredTrades = trades.filter(t => t.TA?.T?.PartnerId === pid);
    console.log(`[fetchClosedTradesBulk] Filtered to ${filteredTrades.length} trades for PartnerId ${pid}`);
  }
  
  // Log first trade to see field structure
  if (filteredTrades[0]) {
    const sample = filteredTrades[0];
    console.log("[fetchClosedTradesBulk] Sample trade data:", {
      Ticket: sample.Ticket || sample.I,
      Username: sample.TA?.T?.A,
      Instrument: sample.Instrument?.Name,
      Volume: sample.VU,
      CloseDate: sample.CEDT,
      PL: sample.PL,
      PartnerId: sample.TA?.T?.PartnerId
    });
  }
  
  return filteredTrades.map(t => ({
    id: t.Ticket || t.I,
    username: t.TA?.T?.A || 'Unknown',
    accountId: t.TA?.I || t.TrI,
    accountName: t.TA?.Name,
    instrument: t.Instrument?.Name || 'Unknown',
    side: t.S === 1 ? 'Buy' : 'Sell',
    volume: parseFloat(t.VU) || 0,
    openPrice: t.EP || 0,
    closePrice: t.CEP || 0,
    profitLoss: parseFloat(t.PL) || 0,
    commission: parseFloat(t.Commission) || 0,
    openDate: t.EDT,
    closeDate: t.CEDT,
    partnerId: t.TA?.T?.PartnerId,
    _raw: t
  }));
};

/**
 * Fetch deposits/withdrawals transactions
 */
export const fetchTransactionsBulk = async (partnerId, fromDate = '', toDate = '') => {
  if (!wsSession) throw new Error("Not connected");
  
  const pid = partnerId || sessionPartnerId;
  
  // Build the request - AdminType 100 = Transactions
  // Add CompanyId filter to prevent loading all transactions for all companies
  // CompanyId = 5 (Nommia) is the correct filter field for transactions
  const filters = [];
  if (sessionCompanyId) {
    filters.push({"Field": "CompanyId", "Value": String(sessionCompanyId)});
  }
  
  const msg = {
    MessageType: 100,
    From: fromDate || '',
    To: toDate || '',
    Filters: filters,
    AdminType: 100,
    Sort: "Id desc",
    AccountType: "1",
    PageSize: 2000,
    Skip: 0
  };
  
  console.log(`[fetchTransactionsBulk] Fetching transactions for PartnerId ${pid}, Date range: ${fromDate || 'ALL'} to ${toDate || 'ALL'}`);
  console.log("[fetchTransactionsBulk] Request:", JSON.stringify(msg));
  const result = await wsSession.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...transactions...], Total }] }
  const wrapper = data?.Messages?.[0];
  const transactions = wrapper?.Messages || data?.Messages || [];
  
  if (!transactions.length) {
    console.log("[fetchTransactionsBulk] No transactions found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  console.log(`[fetchTransactionsBulk] Found ${transactions.length} transactions (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Log first transaction to understand structure
  if (transactions[0]) {
    const t = transactions[0];
    console.log("[fetchTransactionsBulk] Sample transaction fields:", Object.keys(t));
    console.log("[fetchTransactionsBulk] Sample transaction data:", {
      Id: t.Id,
      DA: t.DA,  // Deposit Amount (reference)
      AA: t.AA,  // Account Amount (actual deposit)
      SA: t.SA,  // Send Amount
      TS: t.TS,  // Transaction Side
      D: t.D,    // Date
      IsFiat: t.IsFiat,  // Is Fiat transaction
      'T.Name': t.T?.Name,  // Provider name
      'TA.T': t.TA?.T,  // Trader info
      'TrA.T': t.TrA?.T  // Alternative trader info
    });
  }
  
  // Calculate totals before filtering
  const totalAmount = transactions.reduce((sum, t) => sum + (t.AA || t.Amount || 0), 0);
  console.log(`[fetchTransactionsBulk] Total amount in response: $${totalAmount.toFixed(2)}`);
  
  // Map transactions - handle various field name formats
  // Per XValley docs: AA = Deposited amount (Account Amount), DA = Reference amount
  // Debug first transaction to see all field values
  if (transactions[0]) {
    console.log("[fetchTransactionsBulk] First transaction fields DEBUG:", {
      Id: transactions[0].Id,
      TS: transactions[0].TS,  // Side
      TSN: transactions[0].TSN,  // Type name
      D: transactions[0].D,  // Date
      DA: transactions[0].DA,  // Deposit Amount
      AA: transactions[0].AA,  // Account Amount
      SA: transactions[0].SA,  // Send Amount
      'T.Name': transactions[0].T?.Name,  // Provider
      IsFiat: transactions[0].IsFiat,  // Is Fiat
      Reason: transactions[0].Reason  // Reason code
    });
  }
  
  const mapped = transactions.map(t => {
    // Get username from nested structures - try multiple paths
    // TrA = Transaction Account (for deposits), TA = Trader Account
    const username = t.TrA?.T?.A || t.TA?.T?.A || t.Username || t.User || '';
    
    // Get amount - For deposits, try DA first (reference amount), then AA (account amount)
    // Only use amounts > 0 to avoid summing reference amounts
    let amount = 0;
    if (t.DA && t.DA > 0) {
      amount = t.DA;  // Deposit Amount (reference)
    } else if (t.AA && t.AA > 0) {
      amount = t.AA;  // Account Amount (actual)
    } else if (t.SA && t.SA > 0) {
      amount = t.SA;  // Send Amount
    }
    
    // Get date - D, Date, CreatedOn
    const txDate = t.D || t.Date || t.CreatedOn || t.Created || '';
    
    // Get side/type - TS (Transaction Side): 1=Deposit, 2=Withdrawal
    const side = t.TS ?? t.Type ?? t.Side;
    
    // Get partnerId from nested structure - try multiple paths
    const txPartnerId = t.TrA?.T?.PartnerId || t.TA?.T?.PartnerId || t.PartnerId;
    
    return {
      id: t.Id || t.I,
      username: username,
      accountId: t.TraderAccountId || t.TrA?.I || t.TA?.I,
      accountName: t.TrA?.Name || t.TA?.Name,
      sendAmount: t.SA || t.SendAmount || 0,
      depositedAmount: amount,
      date: txDate,
      type: t.TSN || t.TypeName,
      side: side,  // 1=Deposit, 2=Withdrawal
      sideLabel: side === 1 ? 'Deposit' : side === 2 ? 'Withdrawal' : 'Adjustment',
      state: t.St || t.State,
      stateLabel: t.StS || t.StateString,
      provider: t.T?.Name || t['T.Name'],
      partnerId: txPartnerId,
      isFiat: t.IsFiat,  // Add isFiat flag
      _raw: t
    };
  });
  
  // Log deposit stats with detailed breakdown
  const deposits = mapped.filter(t => t.side === 1);
  const withdrawals = mapped.filter(t => t.side === 2);
  
  // Show breakdown of deposit amounts by field
  const daDeposits = deposits.filter(t => {
    const d = transactions.find(tx => tx.Id === t.id);
    return d && d.DA > 0;
  });
  const aaDeposits = deposits.filter(t => {
    const d = transactions.find(tx => tx.Id === t.id);
    return d && d.DA <= 0 && d.AA > 0;
  });
  
  const daTotal = daDeposits.reduce((s, t) => s + (parseFloat(t.depositedAmount) || 0), 0);
  const aaTotal = aaDeposits.reduce((s, t) => s + (parseFloat(t.depositedAmount) || 0), 0);
  const totalDepositAmount = deposits.reduce((sum, t) => {
    const amt = parseFloat(t.depositedAmount) || 0;
    return sum + amt;
  }, 0);
  
  console.log(`[fetchTransactionsBulk] Deposits: ${deposits.length} total (${daDeposits.length} via DA=$${daTotal.toFixed(2)}, ${aaDeposits.length} via AA=$${aaTotal.toFixed(2)})`);
  console.log(`[fetchTransactionsBulk] Withdrawals: ${withdrawals.length}`);
  console.log(`[fetchTransactionsBulk] Total deposit amount: $${totalDepositAmount.toFixed(2)}`);
  
  return mapped;
};

// ============= AGGREGATED DATA FUNCTIONS =============

/**
 * Helper: Check if a date is within the last N days
 */
const isRecentDate = (dateStr, days = 30) => {
  if (!dateStr) return false;
  try {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= days;
  } catch {
    return false;
  }
};

/**
 * Get complete client data with equity, balance, lots, etc.
 * 
 * Data Sources (per docs):
 * 1. Trading Accounts (AdminType 8, p11): Active, Equity, Balance, DepositsAmount
 * 2. Leads/Customers (AdminType 2, p8-9): Approved, ApprovedDate, LastLogin, Status
 * 3. Closed Trades (AdminType 205, p13-14): Volume (VU) for lots calculation
 * 
 * Active Client Definition (per your recommendation):
 * - Has Active=true trading account AND (LastLogin recent OR DepositsAmount > 0 OR has trades)
 * 
 * Pending Client Definition:
 * - Approved=false OR StatusString contains 'Pending'
 * 
 * KYC Status:
 * - From Approved field in leads/customers endpoint
 * 
 * Lots Traded:
 * - Sum of VU from closed trades (not from undocumented Lots field)
 */
export const fetchCompleteClientData = async () => {
  const partnerId = sessionPartnerId;
  console.log("=== Fetching Complete Client Data ===");
  console.log("Using PartnerId:", partnerId);
  
  // Step 1: Get ALL trading accounts for this partner
  const tradingAccounts = await fetchTradingAccountsBulk(partnerId);
  console.log(`Step 1: ${tradingAccounts.length} trading accounts for PartnerId ${partnerId}`);
  
  if (tradingAccounts.length === 0) {
    console.warn("No trading accounts found for this partner");
    return [];
  }
  
  // Log a full sample to understand structure
  if (tradingAccounts[0]) {
    console.log("Full sample trading account:", JSON.stringify(tradingAccounts[0], null, 2).substring(0, 1500));
  }
  
  // Step 2: Group trading accounts by username and aggregate data
  // KYC logic from original api_integration.js:
  // 1. First check T.Approved (user object)
  // 2. If undefined, fallback to trading account A flag
  // Only aggregate financials from REAL accounts (TATD.Type === 1)
  const clientsMap = {};
  
  tradingAccounts.forEach(acc => {
    const username = acc.T?.A;
    if (!username) return;
    
    const trader = acc.T;
    const accountActive = acc.A === true;  // Trading account Active flag (docs p11)
    
    // Check if this is a REAL account (Type === 1) vs DEMO (Type === 2)
    const accountType = acc.TATD || {};
    const isReal = accountType.Type === 1;
    
    if (!clientsMap[username]) {
      clientsMap[username] = {
        id: trader?.I,
        username: username,
        email: trader?.E || '',
        name: username,
        firstName: trader?.FirstName || '',
        lastName: trader?.LastName || '',
        country: trader?.CountryName || trader?.Company?.Name || 'Unknown',
        countryCode: trader?.CountryIsoCode || '',
        
        // Aggregate financial data (ONLY from REAL accounts)
        equity: 0,
        balance: 0,
        deposit: 0,
        credit: 0,
        availableBalance: 0,
        closedPL: 0,
        
        // Status flags
        hasActiveAccount: false,      // From trading account A field
        hasRealAccounts: false,       // Has at least one real account
        hasDeposited: trader?.Deposited || false,
        
        // KYC - will be determined after all accounts are processed
        // Store the raw T.Approved value for later
        _userApproved: trader?.Approved,
        traderState: trader?.State,   // 0=Pending, 1=Approved, 2=Rejected
        
        // Activity tracking
        lastLogin: null,              // Will try to get from leads
        
        // Account tracking
        accountIds: [],
        realAccountIds: [],
        accountCount: 0,
        realAccountCount: 0,
        
        // Metadata
        registrationDate: trader?.CreatedOn,
        lastModified: trader?.ModifiedOn,
        partnerId: trader?.PartnerId,
        companyId: trader?.CompanyId,
        
        // Raw data for debugging
        _rawAccounts: []
      };
    }
    
    const client = clientsMap[username];
    
    // Track if ANY trading account has A === true (for KYC fallback)
    if (accountActive) {
      client.hasActiveAccount = true;
    }
    
    // ONLY aggregate financials from REAL accounts (not demo)
    if (isReal) {
      client.hasRealAccounts = true;
      client.equity += (acc.E || 0);
      client.balance += (acc.BAL || 0);
      client.deposit += (acc.DepositsAmount || 0);
      client.credit += (acc.CR || 0);
      client.availableBalance += (acc.ABAL || 0);
      client.closedPL += (acc.CPL || 0);
      client.realAccountIds.push(acc.I);
      client.realAccountCount++;
      
      // Track deposits from real accounts
      if (acc.DepositsAmount > 0 || acc.DepositTimes > 0) {
        client.hasDeposited = true;
      }
    }
    
    // Track if ANY account (real or demo) is active
    if (accountActive) {
      client.hasActiveAccount = true;
    }
    
    // Track if user has deposited on ANY account
    if (acc.DepositsAmount > 0 || acc.DepositTimes > 0) {
      client.hasDeposited = true;
    }
    
    client.accountIds.push(acc.I);
    client.accountCount++;
    client._rawAccounts.push(acc);
  });
  
  console.log(`Step 2: Grouped into ${Object.keys(clientsMap).length} unique clients`);
  
  // Step 3: Try to fetch leads/customers data to get Approved, LastLogin, Status fields
  // This may return empty for some users (permission-based)
  let leadsData = [];
  try {
    const usernames = Object.keys(clientsMap);
    leadsData = await fetchIBClients(usernames);
    console.log(`Step 3: Fetched ${leadsData.length} leads/customers records`);
    
    // Enrich clientsMap with leads data (Approved, LastLogin, Status)
    leadsData.forEach(lead => {
      const username = lead.username;
      if (clientsMap[username]) {
        clientsMap[username].approved = lead.approved;
        clientsMap[username].approvedDate = lead.approvedDate;
        clientsMap[username].status = lead.status;
        clientsMap[username].statusString = lead.statusString;
        clientsMap[username].lastLogin = lead.lastLogin;
        clientsMap[username].kycStatusFromLeads = lead.kycStatus;
        clientsMap[username].isPendingFromLeads = lead.isPending;
        // Also update country if available
        if (lead.country && lead.country !== 'Unknown') {
          clientsMap[username].country = lead.country;
          clientsMap[username].countryCode = lead.countryCode;
        }
      }
    });
  } catch (e) {
    console.warn("Could not fetch leads data (may be permission-based):", e.message);
  }
  
  // Step 4: Get closed trades for volume (lots) calculation
  // Lots = Sum of VU from trades (per docs p14), NOT from undocumented Lots field
  const trades = await fetchClosedTradesBulk(partnerId);
  console.log(`Step 4: ${trades.length} closed trades`);
  
  // Build map: username -> { totalVolume, tradeCount }
  const tradesByUser = {};
  let totalVolume = 0;
  let totalRevenue = 0;
  
  trades.forEach((t, idx) => {
    const username = t.username;
    const vol = parseFloat(t.volume) || 0;
    
    if (idx < 3) {
      console.log(`Trade ${idx + 1}:`, { username, volume: vol, instrument: t.instrument });
    }
    
    if (!username || username === 'Unknown') return;
    
    if (!tradesByUser[username]) {
      tradesByUser[username] = { volume: 0, count: 0 };
    }
    tradesByUser[username].volume += vol;
    tradesByUser[username].count++;
    totalVolume += vol;
    
    const rate = COMMISSION_RATES[t.instrument] || COMMISSION_RATES.default;
    totalRevenue += vol * rate;
  });
  
  console.log(`Total Volume: ${totalVolume.toFixed(2)} lots, Total Revenue: $${totalRevenue.toFixed(2)}`);
  
  // Step 5: Build final client list with proper Active, Pending, KYC, Lots
  // KYC LOGIC (EXACT COPY FROM ORIGINAL api_integration.js lines 493-510):
  // 1. If T.Approved is defined, use it
  // 2. Else if any trading account has A === true, treat as approved
  // 3. Else not approved (Pending)
  const enrichedClients = Object.values(clientsMap).map(client => {
    const userTrades = tradesByUser[client.username] || { volume: 0, count: 0 };
    // Fix floating point precision: round to 2 decimal places
    const lots = Math.round(userTrades.volume * 100) / 100;
    const hasTrades = userTrades.count > 0;
    
    // ACTIVE STATUS:
    // Active = has active trading account AND has real accounts
    const isActive = client.hasActiveAccount && client.hasRealAccounts;
    
    // KYC STATUS - EXACT LOGIC FROM ORIGINAL api_integration.js
    // Determine KYC by preferring explicit user.Approved when present,
    // otherwise fall back to trading-account flag `A` if any trader reports it.
    let approved = false;
    let kycSource = 'none';
    
    if (typeof client._userApproved !== 'undefined') {
      // T.Approved exists - use it
      approved = (client._userApproved === true || client._userApproved === 'true');
      kycSource = 'user.Approved';
    } else if (client.hasActiveAccount) {
      // Fallback: if any trading account has A === true
      approved = true;
      kycSource = 'trader.A';
    } else {
      approved = false;
      kycSource = 'none';
    }
    
    const kycStatus = approved ? 'Approved' : 'Pending';
    
    // PENDING STATUS:
    // Pending = NOT approved
    const isPending = !approved;
    
    // Log KYC source for debugging
    if (client.username && client._rawAccounts.length > 0) {
      console.log(`KYC for ${client.username}: ${kycStatus} (source: ${kycSource}, _userApproved: ${client._userApproved}, hasActiveAccount: ${client.hasActiveAccount})`);
    }
    
    return {
      ...client,
      // Fix floating point precision for all financial values
      equity: Math.round(client.equity * 1000) / 1000,
      balance: Math.round(client.balance * 1000) / 1000,
      deposit: Math.round(client.deposit * 100) / 100,
      credit: Math.round(client.credit * 100) / 100,
      availableBalance: Math.round(client.availableBalance * 100) / 100,
      closedPL: Math.round(client.closedPL * 100) / 100,
      
      // Lots from trades sum (rounded to 2 decimals)
      lots: lots,
      tradeCount: userTrades.count,
      
      // Active status
      active: isActive,
      hasTrades: hasTrades,
      
      // KYC status (from original logic)
      approved: approved,
      kycStatus: kycStatus,
      _kycSource: kycSource,
      
      // Pending status
      isPending: isPending,
      
      // Status label
      status: isActive ? 'Active' : 'Inactive'
    };
  });
  
  // Filter to only include clients with REAL accounts
  const realClients = enrichedClients.filter(c => c.hasRealAccounts);
  
  // Sort by deposit amount (highest first)
  realClients.sort((a, b) => b.deposit - a.deposit);
  
  // Log summary with all status breakdowns (using realClients only)
  const activeCount = realClients.filter(c => c.active).length;
  const inactiveCount = realClients.filter(c => !c.active).length;
  const pendingClientsCount = realClients.filter(c => c.isPending).length;
  const approvedKycCount = realClients.filter(c => c.kycStatus === 'Approved').length;
  const pendingKycCount = realClients.filter(c => c.kycStatus === 'Pending').length;
  const rejectedKycCount = realClients.filter(c => c.kycStatus === 'Rejected').length;
  const withDeposits = realClients.filter(c => c.deposit > 0).length;
  const withEquity = realClients.filter(c => c.equity > 0).length;
  const withLots = realClients.filter(c => c.lots > 0).length;
  const withTrades = realClients.filter(c => c.hasTrades).length;
  
  console.log(`
=== Client Summary (REAL ACCOUNTS ONLY) ===
Total Clients with Real Accounts: ${realClients.length}
(Filtered from ${enrichedClients.length} total users)

--- Activity Status ---
Active: ${activeCount}
Inactive: ${inactiveCount}
With Trades: ${withTrades}

--- KYC Status (from T.Approved) ---
Approved: ${approvedKycCount}
Pending (not approved): ${pendingKycCount}

--- Financial (Real Accounts) ---
With Deposits: ${withDeposits}
With Equity: ${withEquity}
With Lots: ${withLots}
======================
  `);
  
  // Log first 5 clients for verification with all status fields
  realClients.slice(0, 5).forEach((c, i) => {
    console.log(`Client ${i + 1}:`, {
      username: c.username,
      country: c.country,
      // Activity
      active: c.active,
      hasActiveAccount: c.hasActiveAccount,
      hasRealAccounts: c.hasRealAccounts,
      realAccountCount: c.realAccountCount,
      hasTrades: c.hasTrades,
      // KYC
      kycStatus: c.kycStatus,
      approved: c.approved,
      isPending: c.isPending,
      // Financial (from REAL accounts only)
      deposit: c.deposit,
      equity: c.equity,
      balance: c.balance,
      lots: c.lots,
      tradeCount: c.tradeCount
    });
  });
  
  console.log("=== Client Data Complete ===");
  return realClients;
};

/**
 * Get network statistics (true ALL-TIME with no date filter)
 */
export const fetchNetworkStats = async () => {
  const partnerId = sessionPartnerId;
  
  // Get ALL closed trades for this IB (no date filter = all time)
  const trades = await fetchClosedTradesBulk(partnerId, '', '');
  
  let totalVolume = 0;
  let totalPL = 0;
  let totalRevenue = 0;
  
  trades.forEach(t => {
    const vol = parseFloat(t.volume) || 0;
    const pl = parseFloat(t.profitLoss) || 0;
    
    totalVolume += vol;
    totalPL += pl;
    
    const rate = COMMISSION_RATES[t.instrument] || COMMISSION_RATES.default;
    totalRevenue += vol * rate;
  });
  
  return {
    totalVolume,
    totalPL,
    totalRevenue,
    tradesCount: trades.length,
    trades
  };
};

/**
 * Get volume history for charts
 * IMPORTANT: Revenue is calculated ONLY from trades filtered by PartnerId (logged-in IB's clients)
 * Volume formula: Sum of trade.VU (volume units) per trade
 * Revenue formula: Sum of (volume * commission_rate_for_instrument) for each trade
 * Commission rates: FX $4.50/lot, Metals $8.00/lot, Crypto $10/lot (Tier 1)
 */
export const fetchVolumeHistory = async (timeRange = 'This Month') => {
  const now = new Date();
  let fromDate = null;
  let toDate = now;
  let useEmptyDates = false;
  
  // Helper to format date as YYYY-MM-DD in LOCAL timezone (not UTC)
  const formatLocalDate = (d) => {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  switch (timeRange) {
    case 'Today':
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'This Week':
      // Start from Sunday of current week
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - now.getDay());
      fromDate.setHours(0, 0, 0, 0);
      break;
    case 'This Month':
      // Start from 1st of current month
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      break;
    case 'This Quarter':
      // Start from 1st of current quarter
      fromDate = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
      break;
    case 'This Year':
      // Start from Jan 1st of current year
      fromDate = new Date(now.getFullYear(), 0, 1);
      break;
    case 'Lifetime':
    default:
      // Use empty dates for true all-time (no date filter)
      useEmptyDates = true;
  }
  
  let trades;
  if (useEmptyDates) {
    console.log(`[fetchVolumeHistory] Time range ${timeRange}: fetching ALL trades (no date filter)`);
    trades = await fetchClosedTradesBulk(sessionPartnerId, '', '');
  } else {
    const fromStr = formatLocalDate(fromDate);
    const toStr = formatLocalDate(now);
    console.log(`[fetchVolumeHistory] Time range ${timeRange}: from ${fromStr} to ${toStr}`);
    console.log(`[fetchVolumeHistory] Current date: ${new Date().toISOString()}, Local today: ${formatLocalDate(now)}`);
    trades = await fetchClosedTradesBulk(sessionPartnerId, fromStr, toStr);
  }
  
  let totalVolume = 0;
  let totalPL = 0;
  let totalRevenue = 0;
  
  trades.forEach(t => {
    const vol = parseFloat(t.volume) || 0;
    totalVolume += vol;
    totalPL += parseFloat(t.profitLoss) || 0;
    
    const rate = COMMISSION_RATES[t.instrument] || COMMISSION_RATES.default;
    totalRevenue += vol * rate;
  });
  
  // VERIFY: trades are already filtered by PartnerId in fetchClosedTradesBulk
  // This revenue represents ONLY logged-in IB's clients (PartnerId ${sessionPartnerId})
  console.log(`[fetchVolumeHistory] ${timeRange}: Found ${trades.length} trades for PartnerId ${sessionPartnerId}, Volume=${totalVolume.toFixed(2)} lots, Revenue=$${totalRevenue.toFixed(2)} (verified IB-specific)`);
  
  return { trades, totalVolume, totalPL, totalRevenue, fromDate, toDate: now };
};

// ============= UTILITY EXPORTS =============

export const fetchCurrentUser = async () => {
  // Return basic user info from session
  return { partnerId: sessionPartnerId };
};

export const fetchTradingAccounts = async (username) => {
  if (!wsSession) throw new Error("Not connected");
  
  const filters = [{
    Filter: username,
    FilterComparison: 2,  // TextEquals
    FilterType: "Trader.Alias",
    FilterValueType: 1    // Text
  }];
  
  const msg = {
    MessageType: 100,
    Filters: filters,
    AdminType: 8,
    AccountType: "12"
  };
  
  const result = await wsSession.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual accounts...], Total }] }
  const wrapper = data?.Messages?.[0];
  const accounts = wrapper?.Messages || [];
  
  console.log(`fetchTradingAccounts for ${username}: found ${accounts.length} accounts`);
  
  // Map to consistent format with id field
  return accounts.map(acc => ({
    id: acc.I,
    name: acc.Name,
    username: acc.T?.A,
    email: acc.T?.E,
    active: acc.A === true,
    equity: acc.E || 0,
    balance: acc.BAL || 0,
    accountType: acc.TATD?.Type,  // 1=Real, 2=Demo
    isReal: acc.TATD?.Type === 1,
    _raw: acc
  }));
};

export const fetchClientTrades = async (accountId, fromDate, toDate) => {
  if (!wsSession) throw new Error("Not connected");
  
  const filters = [{
    Filter: String(accountId),
    FilterComparison: 1,
    FilterType: "TraderAccountId",
    FilterValueType: 2
  }];
  
  const msg = {
    MessageType: 100,
    From: fromDate || "",
    To: toDate || "",
    Filters: filters,
    AdminType: 205,
    AccountType: "1",
    PageSize: 500
  };
  
  console.log(`fetchClientTrades for account ${accountId}`);
  const result = await wsSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual trades...], Total }] }
  const wrapper = data?.Messages?.[0];
  const trades = wrapper?.Messages || [];
  
  console.log(`fetchClientTrades for account ${accountId}: found ${trades.length} trades`);
  
  return trades.map(t => ({
    id: t.Ticket || t.I,
    instrument: t['Instrument.Name'] || t.Instrument?.Name || 'Unknown',
    side: t.S === 1 ? 'Buy' : 'Sell',
    volume: t.VU || 0,
    openPrice: t.EP || 0,
    closePrice: t.CEP || 0,
    profitLoss: t.PL || 0,
    openDate: t.EDT,
    closeDate: t.CEDT
  }));
};

export const fetchClientTransactions = async (accountId) => {
  if (!wsSession) throw new Error("Not connected");
  
  const filters = [{
    Filter: String(accountId),
    FilterComparison: 1,
    FilterType: "TraderAccountId",
    FilterValueType: 2
  }];
  
  const msg = {
    MessageType: 100,
    Filters: filters,
    AdminType: 100,
    AccountType: "1",
    PageSize: 200
  };
  
  const result = await wsSession.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  return (data?.Messages || []).map(t => ({
    id: t.Id,
    amount: t.AA || 0,
    date: t.D,
    type: t.TSN,
    side: t.TS,
    sideLabel: t.TS === 1 ? 'Deposit' : t.TS === 2 ? 'Withdrawal' : 'Adjustment',
    state: t.StS
  }));
};



// Subscription stubs
export const subscribeToTradeUpdates = (callback) => {
  if (!wsSession || !wsSessionId) return;
  wsSession.subscribe(wsSessionId, (args) => {
    const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
    if (msg.MessageType === 20) callback(msg);
  });
};

export const subscribeToAccountEvents = (callback) => {
  if (!wsSession || !wsSessionId) return;
  wsSession.subscribe(wsSessionId, (args) => {
    const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
    if (msg.MessageType === 30 || msg.MessageType === 40) callback(msg);
  });
};

export const subscribeToSystemAlerts = (callback) => {
  // Stub for alerts
};

export const fetchAccountTypes = async () => {
  if (!wsSession) return [];
  const result = await wsSession.call(API_CONFIG.TOPICS.ACCOUNT_TYPES, [JSON.stringify({ MessageType: 100 })]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  return data?.Messages || [];
};

export const fetchAccountLevels = async () => {
  if (!wsSession) return [];
  const result = await wsSession.call(API_CONFIG.TOPICS.ACCOUNT_LEVELS, [JSON.stringify({ MessageType: 100 })]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  return data?.Messages || [];
};

export const saveUserDetails = async (userData) => {
  if (!wsSession) throw new Error("Not connected");
  const msg = { MessageType: 100, Messages: [userData] };
  const result = await wsSession.call(API_CONFIG.TOPICS.SAVE_USER, [JSON.stringify(msg)]);
  return typeof result === 'string' ? JSON.parse(result) : result;
};

export const resetUserPassword = async (username) => {
  // Stub
  return { success: true };
};

export const submitWithdrawalRequest = async (data) => {
  // Stub
  return { success: true };
};

export const fetchWithdrawalsHistory = async () => [];

// Fetch all transactions (deposits/withdrawals) for the IB's clients
export const fetchAllTransactions = async (from = '', to = '') => {
  try {
    // Fetch all company transactions with CompanyId filter
    const allTransactions = await fetchTransactionsBulk(sessionPartnerId, from, to);
    
    // Filter to only this IB's clients (PartnerId) since API doesn't support direct PartnerId filter
    const ibTransactions = allTransactions.filter(t => t.partnerId === sessionPartnerId);
    
    console.log(`[fetchAllTransactions] Filtered ${allTransactions.length} company transactions to ${ibTransactions.length} for PartnerId ${sessionPartnerId}`);
    
    return ibTransactions;
  } catch (error) {
    console.error('fetchAllTransactions error:', error);
    return [];
  }
};

export const fetchClientAccount = async (u) => (await fetchTradingAccounts(u))[0] || null;
export const fetchClientEquity = async (u) => {
  const accs = await fetchTradingAccounts(u);
  return accs.reduce((s, a) => s + (a.E || 0), 0);
};
export const fetchClientDeposits = async () => [];
export const fetchUserCommunications = async () => [];

// Legacy exports for compatibility
export const fetchNommiaClients = fetchIBClients;
export const fetchNetworkVolume = fetchNetworkStats;
