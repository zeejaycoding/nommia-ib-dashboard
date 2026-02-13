/**
 * NOMMIA IB DASHBOARD - API INTEGRATION V2
 * Clean, efficient implementation based on XValley Backoffice API docs
 */

import autobahn from 'autobahn-browser';
import { supabase, uploadFileToStorage, deleteFileFromStorage } from './supabaseClient.js';

// ============= COMMISSION CALCULATION =============
// All commissions are fetched directly from XValley (including metals, instruments, tier adjustments)
// We do NOT calculate commissions locally - only add tier bonuses on top of XValley's value

const API_CONFIG = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || "https://api.nommia.io",
  BACKEND_URL: import.meta.env.VITE_BACKEND_URL || "https://nommia-ib-backend.onrender.com",
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

/**
 * Wait for sessionPartnerId to be available (with timeout)
 * Waits up to 5 seconds for the WebSocket to establish and set the partner ID
 */
const ensurePartnerIdAvailable = async () => {
  let attempts = 0;
  const maxAttempts = 50; // 5 seconds (50 * 100ms)
  
  while (!sessionPartnerId && attempts < maxAttempts) {
    await new Promise(resolve => setTimeout(resolve, 100));
    attempts++;
  }
  
  if (!sessionPartnerId) {
    console.warn('[Partner ID] Timeout waiting for partner ID - WebSocket may not be connected');
  }
  
  return sessionPartnerId;
};
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
    // Store in localStorage for password reset endpoint
    if (authToken) {
      localStorage.setItem('authToken', authToken);
    }
    //console.log("Auth token obtained:", authToken ? "Yes" : "No");
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
     // console.log("Updated WS_URL to:", API_CONFIG.WS_URL);
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
      //console.log("WebSocket Connected to:", API_CONFIG.WS_URL);
      wsSession = session;
      
      try {
        // PING to authenticate
        const pingMsg = JSON.stringify({ token: authToken, host: API_CONFIG.BROKER_HOST });
       // console.log("Sending PING with host:", API_CONFIG.BROKER_HOST);
        
        const result = await session.call(API_CONFIG.TOPICS.PING, [pingMsg]);
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        
        //console.log("PING Response:", JSON.stringify(data, null, 2));
        
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
        //console.log("Session ID (username):", wsSessionId);
        //console.log("Roles:", data.Messages?.[1]);
        
        // PartnerId is at Messages[3] as a string
        const partnerIdStr = data.Messages?.[3];
        if (partnerIdStr) {
          sessionPartnerId = parseInt(partnerIdStr, 10);
        //  console.log("Extracted PartnerId:", sessionPartnerId);
        }
        
        // CompanyId is at Messages[4] as a string
        const companyIdStr = data.Messages?.[4];
        if (companyIdStr) {
          sessionCompanyId = parseInt(companyIdStr, 10);
         // console.log("Extracted CompanyId:", sessionCompanyId);
        }
        
        if (!sessionPartnerId) {
        //  console.warn("No PartnerId found in PING response - this IB may not have partner access");
        }
        
        //console.log("✅ Authenticated. PartnerId:", sessionPartnerId, "CompanyId:", sessionCompanyId);
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
export const getSessionUsername = () => wsSessionId;  // Returns current user's username from WebSocket

/**
 * Fetch ALL leads/clients from the platform for network building
 * Returns clients with their referrer information (no filtering)
 * This is used to build complete Tier 1/2/3 hierarchies
 */
export const fetchAllLeads = async (pageSize = 5000) => {
  if (!wsSession) throw new Error("Not connected");
  
  console.log("[fetchAllLeads] Fetching all leads/clients from platform...");
  
  try {
    // Request with NO filters to get all clients
    const msg = {
      MessageType: 100,
      Filters: [],  // NO company/partner filter
      PageSize: pageSize,
      Sort: "Registration desc",
      Skip: 0,
      AdminType: 2  // 2 = Customers/Leads
    };
    
   // console.log("[fetchAllLeads] Request:", JSON.stringify(msg, null, 2));
    const result = await wsSession.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const clients = wrapper?.Messages || [];
    
    //console.log(`[fetchAllLeads] Found ${clients.length} total clients (Total: ${wrapper?.Total || 'N/A'})`);
    
    // Log sample clients with referrer data
    if (clients.length > 0) {
     // console.log("[fetchAllLeads] Sample clients with referrer info:");
      clients.slice(0, 5).forEach((c, idx) => {
        //console.log(`  ${idx + 1}. ${c.UserName || c.A} | Id=${c.Id || c.I} | PartnerId=${c.PartnerId} | Referrer=${c.Referrer || c.ReferrerId || c.ReferralCode || 'N/A'}`);
      });
    }
    
    // Map to consistent format
    return clients.map(lead => {
      const isApproved = lead.Approved === true;
      const statusString = lead.StatusString || '';
      
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
        
        approved: isApproved,
        approvedDate: lead.ApprovedDate || null,
        kycStatus: isApproved ? 'Approved' : (lead.Status === 2 ? 'Rejected' : 'Pending'),
        status: lead.Status,
        statusString: statusString,
        
        lastLogin: lead.LastLogin,
        deposit: lead.DepositsAmount || 0,
        depositTimes: lead.DepositTimes || 0,
        registrationDate: lead.Registration || lead.CreatedOn,
        
        partnerId: lead.PartnerId,
        companyId: lead.CompanyId,
        companyName: lead.CompanyName,
        
        // Referral data - critical for network building
        referrer: lead.Referrer || lead.ReferrerId || lead.ReferrerUsername || lead.ReferralCode || lead.Referral || null,
        
        _raw: lead
      };
    });
    
  } catch (error) {
    console.error("[fetchAllLeads] Error:", error);
    return [];
  }
};

export const fetchIBClients = async (usernames = []) => {
  if (!wsSession) throw new Error("Not connected");
  
 // console.log("Fetching customers for usernames:", usernames.length > 0 ? usernames.slice(0, 5) : "all");
  
  const filters = [];
  if (sessionCompanyId) {
    filters.push({
      Filter: String(sessionCompanyId),        // value to filter
      FilterComparison: 1,                      // 1 = NumberEquals 
      FilterType: "CompanyId",                  // column name
      FilterValueType: 2                        // 2 = Number 
    });
  }
  
  const msg = {
    MessageType: 100,
    Filters: filters,
    PageSize: 500,
    Sort: "Registration desc",
    Skip: 0,
    AdminType: 2  // 2 = Customers 
  };
  
 // console.log("Leads request:", JSON.stringify(msg, null, 2));
  const result = await wsSession.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  const wrapper = data?.Messages?.[0];
  const clients = wrapper?.Messages || [];
  
  if (!clients.length) {
  //  console.log("No clients found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
 // console.log(`Found ${clients.length} clients from leads endpoint (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Filter by usernames if provided
  let filteredClients = clients;
  if (usernames.length > 0) {
    const usernameSet = new Set(usernames.map(u => u.toLowerCase()));
    filteredClients = clients.filter(c => {
      const username = (c.UserName || c.A || '').toLowerCase();
      return usernameSet.has(username);
    });
  //  console.log(`Filtered to ${filteredClients.length} clients matching IB's usernames`);
  }
    
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

export const fetchAllClientsForNetwork = async () => {
  if (!wsSession) throw new Error("Not connected");
  
  //console.log("[fetchAllClientsForNetwork] Fetching all trading accounts with aggregated data...");
  
  try {
    const msg = {
      MessageType: 100,
      Filters: [],
      AdminType: 8,
      Sort: "Id desc",
      AccountType: "1",  // 1=real accounts only (not demo)
      PageSize: 2000,
      Skip: 0
    };
    
    const result = await wsSession.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const accounts = wrapper?.Messages || [];
    
    if (!accounts.length) {
      console.log("[fetchAllClientsForNetwork] No trading accounts found");
      return [];
    }
    
    //console.log(`[fetchAllClientsForNetwork] Found ${accounts.length} total trading accounts`);
    
    const clientMap = {};
    
    accounts.forEach(acc => {
      const trader = acc.T;
      if (!trader || !trader.A) return;
      
      const username = trader.A;
      const isRealAccount = acc.TATD?.Type === 1;
      
      if (!clientMap[username]) {
        clientMap[username] = {
          id: trader.I,
          username: trader.A,
          email: trader.E || '',
          name: trader.A,
          country: trader.CountryName || trader.Company?.Name || 'Unknown',
          approved: trader.Approved === true,
          kycStatus: trader.Approved === true ? 'Approved' : 'Pending',
          status: 'Active',
          
          deposit: 0,
          equity: 0,
          balance: 0,
          volume: 0,
          revenue: 0,
          
          registrationDate: trader.CreatedOn,
          partnerId: trader.PartnerId,
          _raw: trader
        };
      }
      
      if (isRealAccount) {
        clientMap[username].deposit += (acc.DepositsAmount || 0);
        clientMap[username].equity += (acc.E || 0);
        clientMap[username].balance += (acc.BAL || 0);
      }
    });
    
    //console.log("[fetchAllClientsForNetwork] Fetching closed trades for volume/commission...");
    
    const tradesMsg = {
      MessageType: 100,
      From: "",
      To: "",
      Filters: [],
      AdminType: 205,
      Sort: "Id desc",
      AccountType: "1",
      PageSize: 2000,
      Skip: 0
    };
    
    const tradesResult = await wsSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(tradesMsg)]);
    const tradesData = typeof tradesResult === 'string' ? JSON.parse(tradesResult) : tradesResult;
    
    const tradesWrapper = tradesData?.Messages?.[0];
    const trades = tradesWrapper?.Messages || [];
    
    //console.log(`[fetchAllClientsForNetwork] Found ${trades.length} closed trades for volume/commission`);
    
    const tradesByUsername = {};
    trades.forEach(t => {
      const username = t.TA?.T?.A || t.username;
      if (!username) return;
      
      const vol = parseFloat(t.VU) || 0;
      const comm = parseFloat(t.Commission) || 0;
      
      if (!tradesByUsername[username]) {
        tradesByUsername[username] = { volume: 0, revenue: 0, count: 0 };
      }
      tradesByUsername[username].volume += vol;
      tradesByUsername[username].revenue += comm;
      tradesByUsername[username].count++;
    });
    
    Object.keys(clientMap).forEach(username => {
      const tradeData = tradesByUsername[username];
      if (tradeData) {
        clientMap[username].volume = Math.round(tradeData.volume * 100) / 100;
        clientMap[username].revenue = Math.round(tradeData.revenue * 100) / 100;
      }
    });
    
    const allClients = Object.values(clientMap);
   // console.log(`[fetchAllClientsForNetwork] Grouped into ${allClients.length} unique traders with aggregated data`);
    
    
    // Debug: Log full raw trader data for first few clients to understand available fields
   // console.log("[fetchAllClientsForNetwork] Full raw trader data samples:");
    samples.forEach((c, idx) => {
      const raw = c._raw;
      if (raw) {
        console.log(`Trader ${idx + 1} (${c.username}):`, {
          Id: raw.I,
          Alias: raw.A,
          PartnerId: raw.PartnerId,
          Referrer: raw.Referrer,
          ReferrerId: raw.ReferrerId,
          Company: raw.Company?.Name,
          CompanyId: raw.CompanyId,
          State: raw.State,
          Approved: raw.Approved,
          Keys: Object.keys(raw).slice(0, 20)
        });
      }
    });
    
    return allClients;
  } catch (error) {
    console.error('[fetchAllClientsForNetwork] Error:', error);
    return [];
  }
};

/**
 * Fetch trading accounts for clients to get Equity, Balance, etc.
 */
export const fetchTradingAccountsBulk = async (partnerId) => {
  if (!wsSession) throw new Error("Not connected");
  
  const pid = partnerId || sessionPartnerId;
  // console.log("Fetching trading accounts (will filter by partnerId client-side):", pid);
  
  const msg = {
    MessageType: 100,
    Filters: [],
    AdminType: 8,
    Sort: "Id desc",
    AccountType: "1",  // 1=real, 2=demo, 12=all - fetch all to filter by Type
    PageSize: 1000,
    Skip: 0
  };
  
  // console.log("Traders request:", JSON.stringify(msg, null, 2));
  const result = await wsSession.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  const wrapper = data?.Messages?.[0];
  const accounts = wrapper?.Messages || [];
  
  if (!accounts.length) {
    console.log("No trading accounts found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  //console.log(`Found ${accounts.length} trading accounts (Total: ${wrapper?.Total || 'N/A'})`);
  
  // Filter by PartnerId client-side
  let filteredAccounts = accounts;
  if (pid) {
    filteredAccounts = accounts.filter(acc => acc.T?.PartnerId === pid);
   // console.log(`Filtered to ${filteredAccounts.length} accounts for PartnerId ${pid}`);
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
  if (!wsSession) {
    console.error("[fetchClosedTradesBulk] API call unsuccessful: WebSocket not connected");
    return [];
  }
  
  try {
    const pid = partnerId || sessionPartnerId;
    
    const filters = [];
    
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
    
   // console.log(`[fetchClosedTradesBulk] Fetching trades for PartnerId ${pid}, Date range: ${fromDate || 'ALL'} to ${toDate || 'ALL'}`);
    // console.log("[fetchClosedTradesBulk] Request:", JSON.stringify(msg, null, 2));
    const result = await wsSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const trades = wrapper?.Messages || [];
    
    if (!trades.length) {
      console.error("[fetchClosedTradesBulk] API call unsuccessful: No trades returned");
      return [];
    }
    
   // console.log(`[fetchClosedTradesBulk] Found ${trades.length} closed trades total (Total: ${wrapper?.Total || 'N/A'})`);
    
    let filteredTrades = trades;
    if (pid) {
      filteredTrades = trades.filter(t => t.TA?.T?.PartnerId === pid);
      // console.log(`[fetchClosedTradesBulk] Filtered to ${filteredTrades.length} trades for PartnerId ${pid}`);
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
    
    
  } catch (error) {
    //console.error("[fetchClosedTradesBulk] API call unsuccessful:", error.message);
    return [];
  }
};

/**
 * Fetch deposits/withdrawals transactions
 */
export const fetchTransactionsBulk = async (partnerId, fromDate = '', toDate = '') => {
  if (!wsSession) {
    console.error("[fetchTransactionsBulk] API call unsuccessful: WebSocket not connected");
    return [];
  }
  
  try {
    const pid = partnerId || sessionPartnerId;
    
    const filters = [];
    if (sessionCompanyId) {
      filters.push({
        Filter: String(sessionCompanyId),        // value to filter
        FilterComparison: 1,                      // 1 = NumberEquals (per docs p7)
        FilterType: "CompanyId",                  // column name
        FilterValueType: 2                        // 2 = Number (per docs p7)
      });
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
  
  // console.log(`[fetchTransactionsBulk] Fetching transactions for PartnerId ${pid}, Date range: ${fromDate || 'ALL'} to ${toDate || 'ALL'}`);
  // console.log("[fetchTransactionsBulk] Request:", JSON.stringify(msg));
  const result = await wsSession.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...transactions...], Total }] }
  const wrapper = data?.Messages?.[0];
  const transactions = wrapper?.Messages || data?.Messages || [];
  
  if (!transactions.length) {
    console.log("[fetchTransactionsBulk] No transactions found - Response:", JSON.stringify(data, null, 2));
    return [];
  }
  
  // console.log(`[fetchTransactionsBulk] Found ${transactions.length} transactions (Total: ${wrapper?.Total || 'N/A'})`);
  
  
  const totalAmount = transactions.reduce((sum, t) => sum + (t.AA || t.Amount || 0), 0);
  //console.log(`[fetchTransactionsBulk] Total amount in response: $${totalAmount.toFixed(2)}`);
  
  
  const mapped = transactions.map(t => {
    const username = t.TrA?.T?.A || t.TA?.T?.A || t.Username || t.User || '';
    
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
  
 // console.log(`[fetchTransactionsBulk] Deposits: ${deposits.length} total (${daDeposits.length} via DA=$${daTotal.toFixed(2)}, ${aaDeposits.length} via AA=$${aaTotal.toFixed(2)})`);
 // console.log(`[fetchTransactionsBulk] Withdrawals: ${withdrawals.length}`);
 // console.log(`[fetchTransactionsBulk] Total deposit amount: $${totalDepositAmount.toFixed(2)}`);
  
  return mapped;
  } catch (error) {
    console.error("[fetchTransactionsBulk] API call unsuccessful:", error.message);
    return [];
  }
};

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

export const fetchCompleteClientData = async (forcePartnerId = null) => {
  const partnerId = forcePartnerId || sessionPartnerId;
 // console.log("=== Fetching Complete Client Data ===");
 // console.log("Using PartnerId:", partnerId, forcePartnerId ? "(forced)" : "(session)");
  
  // Step 1: Get ALL trading accounts for this partner
  const tradingAccounts = await fetchTradingAccountsBulk(partnerId);
  //console.log(`Step 1: ${tradingAccounts.length} trading accounts for PartnerId ${partnerId}`);
  
  if (tradingAccounts.length === 0) {
   // console.warn("No trading accounts found for this partner");
    return [];
  }
    const clientsMap = {};
  
  tradingAccounts.forEach(acc => {
    const username = acc.T?.A;
    if (!username) return;
    
    const trader = acc.T;
    const accountActive = acc.A === true;  // Trading account Active flag (docs p11)
    
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
  
  //console.log(`Step 2: Grouped into ${Object.keys(clientsMap).length} unique clients`);
  
  // Step 3: Try to fetch leads/customers data to get Approved, LastLogin, Status fields
  // This may return empty for some users (permission-based)
  let leadsData = [];
  try {
    const usernames = Object.keys(clientsMap);
    leadsData = await fetchIBClients(usernames);
  //  console.log(`Step 3: Fetched ${leadsData.length} leads/customers records`);
    
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
  // Revenue = Sum of XValley's Commission field (not calculated from volume × rate)
  const trades = await fetchClosedTradesBulk(partnerId);
  //console.log(`Step 4: ${trades.length} closed trades`);
  
  // Build map: username -> { totalCommission, totalVolume, tradeCount }
  // Commission comes directly from XValley - includes all calculations (metals, instruments, etc)
  const tradesByUser = {};
  let totalVolume = 0;
  let totalRevenue = 0;  // Base commission from XValley (no fallbacks, no calculations)
  
  trades.forEach((t, idx) => {
    const username = t.username;
    const vol = parseFloat(t.volume) || 0;
    const comm = parseFloat(t.commission) || 0;  // ← 100% from XValley API
        
    if (!username || username === 'Unknown') return;
    
    if (!tradesByUser[username]) {
      tradesByUser[username] = { commission: 0, volume: 0, count: 0 };
    }
    tradesByUser[username].commission += comm;  // Sum XValley's commission
    tradesByUser[username].volume += vol;
    tradesByUser[username].count++;
    totalVolume += vol;
    totalRevenue += comm;  // Base commission = sum of XValley commissions
  });
  
 // console.log(`Total Volume: ${totalVolume.toFixed(2)} lots | Base Commission: $${totalRevenue.toFixed(2)} (XValley, no calculations)`);
  
  const enrichedClients = Object.values(clientsMap).map(client => {
    const userTrades = tradesByUser[client.username] || { commission: 0, volume: 0, count: 0 };
    
    const lots = Math.round(userTrades.volume * 100) / 100;
    const baseCommission = Math.round(userTrades.commission * 100) / 100;  // From XValley
    const hasTrades = userTrades.count > 0;
    
    const isActive = client.hasActiveAccount && client.hasRealAccounts;
    let approved = false;
    let kycSource = 'none';
    
    if (typeof client._userApproved !== 'undefined') {
      approved = (client._userApproved === true || client._userApproved === 'true');
      kycSource = 'user.Approved';
    } else if (client.hasActiveAccount) {
      approved = true;
      kycSource = 'trader.A';
    } else {
      approved = false;
      kycSource = 'none';
    }
    
    const kycStatus = approved ? 'Approved' : 'Pending';
    const isPending = !approved;
    
        const firstRawAccount = client._rawAccounts?.[0] || {};
    const rawTrader = firstRawAccount.T || {};
    
    return {
      ...client,
      equity: Math.round(client.equity * 1000) / 1000,
      balance: Math.round(client.balance * 1000) / 1000,
      deposit: Math.round(client.deposit * 100) / 100,
      credit: Math.round(client.credit * 100) / 100,
      availableBalance: Math.round(client.availableBalance * 100) / 100,
      closedPL: Math.round(client.closedPL * 100) / 100,
      
      lots: lots,
      tradeCount: userTrades.count,
      
      baseCommission: baseCommission,
      
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
      status: isActive ? 'Active' : 'Inactive',
      
      // Raw referral data for network building
      // PartnerId from trader indicates who referred this user
      _raw: {
        PartnerId: rawTrader.PartnerId,  // ID of the partner who referred this user
        Referrer: rawTrader.PartnerId,   // Alternative name for same field
        Id: rawTrader.I,                 // User's own ID
        ReferralCode: rawTrader.ReferralCode || null
      }
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
    
  return realClients;
};

export const fetchNetworkStats = async () => {
  const partnerId = sessionPartnerId;
  
  // Get ALL closed trades for this IB (no date filter = all time)
  const trades = await fetchClosedTradesBulk(partnerId, '', '');
  
  let totalVolume = 0;
  let totalPL = 0;
  let totalRevenue = 0;  // Base commission from XValley
  
  trades.forEach(t => {
    const vol = parseFloat(t.volume) || 0;
    const pl = parseFloat(t.profitLoss) || 0;
    const comm = parseFloat(t.commission) || 0;  // ← 100% from XValley API
    
    totalVolume += vol;
    totalPL += pl;
    totalRevenue += comm;  // Sum XValley commissions (not calculations)
  });
  
  return {
    totalVolume,
    totalPL,
    totalRevenue,  // Base commission = sum from XValley
    tradesCount: trades.length,
    trades
  };
};

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
   // console.log(`[fetchVolumeHistory] Time range ${timeRange}: fetching ALL trades (no date filter)`);
    trades = await fetchClosedTradesBulk(sessionPartnerId, '', '');
  } else {
    const fromStr = formatLocalDate(fromDate);
    const toStr = formatLocalDate(now);
  //  console.log(`[fetchVolumeHistory] Time range ${timeRange}: from ${fromStr} to ${toStr}`);
   // console.log(`[fetchVolumeHistory] Current date: ${new Date().toISOString()}, Local today: ${formatLocalDate(now)}`);
    trades = await fetchClosedTradesBulk(sessionPartnerId, fromStr, toStr);
  }
  
  let totalVolume = 0;
  let totalPL = 0;
  let totalRevenue = 0;  // Base commission from XValley
  
  trades.forEach(t => {
    const vol = parseFloat(t.volume) || 0;
    const comm = parseFloat(t.commission) || 0;  // ← 100% from XValley API
    
    totalVolume += vol;
    totalPL += parseFloat(t.profitLoss) || 0;
    totalRevenue += comm;  // Sum XValley commissions (no local calculations)
  });
  
  //console.log(`[fetchVolumeHistory] ${timeRange}: ${trades.length} trades | Volume=${totalVolume.toFixed(2)} lots | Commission=$${totalRevenue.toFixed(2)} (XValley only)`);
  
  return { trades, totalVolume, totalPL, totalRevenue, fromDate, toDate: now };
};

export const fetch3MonthCommissionHistory = async () => {
  const now = new Date();
  const history = [];

  // Get current month, previous month, and 2 months ago
  for (let i = 0; i < 3; i++) {
    const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    
    const formatLocalDate = (d) => {
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    };
    
    try {
      const trades = await fetchClosedTradesBulk(
        sessionPartnerId, 
        formatLocalDate(monthStart), 
        formatLocalDate(monthEnd)
      );
      
      let monthRevenue = 0;
      trades.forEach(t => {
        const comm = parseFloat(t.commission) || 0;  // ← 100% from XValley API
        monthRevenue += comm;
      });
      
      history.unshift(monthRevenue); // Add to front (oldest first)
     // console.log(`[fetch3MonthCommissionHistory] ${formatLocalDate(monthStart)} - ${formatLocalDate(monthEnd)}: $${monthRevenue.toFixed(2)} (XValley commission)`);
    } catch (error) {
    //  console.error(`[fetch3MonthCommissionHistory] Error fetching month ${i}:`, error);
      history.unshift(0); // Add 0 if fetch fails
    }
  }

  return history;
};

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
  
  // console.log(`fetchTradingAccounts for ${username}: found ${accounts.length} accounts`);
  
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
  
  // console.log(`fetchClientTrades for account ${accountId}`);
  const result = await wsSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
  const data = typeof result === 'string' ? JSON.parse(result) : result;
  
  // Response structure: { Messages: [{ AdminType, Messages: [...actual trades...], Total }] }
  const wrapper = data?.Messages?.[0];
  const trades = wrapper?.Messages || [];
  
  // console.log(`fetchClientTrades for account ${accountId}: found ${trades.length} trades`);
  
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

/**
 * Submit withdrawal request to XValley
 * Maps withdrawal method to XValley transaction type and submits via Deposit Action topic
 * @param {Object} data - Withdrawal data
 * @param {string} data.username - Username (trading account owner)
 * @param {number} data.accountId - Trading Account ID
 * @param {number} data.amount - Withdrawal amount
 * @param {string} data.method - Withdrawal method label (e.g., "Bank Wire", "USDT (TRC20)")
 * @param {number} data.xvalleyType - XValley transaction type ID
 * @param {string} data.reference - Optional reference/invoice number
 * @returns {Promise<{success: boolean, message: string, transactionId?: string}>}
 * 
 * Transaction Type IDs (from XValley Appendix A):
 * 1=BankWire, 5=Bitcoin, 34=Ethereum, 35=Tether, 44=USDCoin, 46=TetherTron(TRC20)
 * Side values (Appendix D): 1=Deposit, 2=Withdraw
 * State values (Appendix C): 1=Pending, 2=Processing, 3=Approved, 4=Rejected
 */
export const submitWithdrawalRequest = async (data) => {
  try {
    if (!wsSession || !sessionPartnerId) {
      return { success: false, message: 'WebSocket not connected. Please reconnect.' };
    }

    // Validate required fields
    if (!data.username || !data.accountId || !data.amount || !data.xvalleyType) {
      return { success: false, message: 'Missing required withdrawal data' };
    }

    // Prepare the withdrawal request for XValley Deposit Action API
    const withdrawalData = {
      TA: data.amount,              // Transaction Amount
      AA: data.amount,              // Account Amount
      F: 0,                         // Fee (set by admin later if needed)
      R: 1,                         // Rate (1:1 conversion)
      D: new Date().toISOString().split('T')[0],  // Date
      TId: data.xvalleyType,        // Type ID (e.g., 1=BankWire, 35=Tether, etc.)
      TCId: 1,                      // Transaction Currency (1=USD)
      ACId: 1,                      // Account Currency (1=USD)
      St: 1,                        // State (1=Pending - awaiting approval)
      TrId: data.accountId,         // Trading Account ID
      In: data.reference || `WD-${sessionPartnerId}-${Date.now()}`, // Reference/Invoice
      TS: 2                         // Side (2=Withdrawal, from Appendix D)
    };

    // Submit to XValley via WebSocket
    const topic = 'com.fxplayer.deposit';
    const msg = {
      MessageType: 100,
      Username: data.username,
      Messages: [withdrawalData]
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('XValley withdrawal request timeout (30s)'));
      }, 30000);

      wsSession.call(topic, [msg]).then(res => {
        clearTimeout(timeout);
        
        // XValley response format: { MessageType: 200 (OK) or -3 (Error), Messages: [...] }
        if (res && res.MessageType === 200) {
          // Success - withdrawal pending admin approval
          resolve({
            success: true,
            message: `Withdrawal request submitted. Your admin will review it shortly.`,
            transactionId: data.reference || `WD-${sessionPartnerId}-${Date.now()}`,
            status: 'Pending',
            method: data.method
          });
        } else {
          // Error response from XValley
          const errorMsg = res?.Messages?.[0] || 'Unknown error from XValley';
          resolve({
            success: false,
            message: `Withdrawal failed: ${errorMsg}`
          });
        }
      }).catch(err => {
        clearTimeout(timeout);
        console.error('[submitWithdrawalRequest] XValley error:', err);
        resolve({
          success: false,
          message: `Error submitting withdrawal to XValley: ${err.message}`
        });
      });
    });
  } catch (error) {
    console.error('[submitWithdrawalRequest] Error:', error);
    return {
      success: false,
      message: `Withdrawal error: ${error.message}`
    };
  }
};

export const fetchWithdrawalsHistory = async () => [];

// Fetch all transactions (deposits/withdrawals) for the IB's clients
export const fetchAllTransactions = async (from = '', to = '') => {
  try {
    // Fetch all company transactions with CompanyId filter
    const allTransactions = await fetchTransactionsBulk(sessionPartnerId, from, to);
    
    // Filter to only this IB's clients (PartnerId) since API doesn't support direct PartnerId filter
    const ibTransactions = allTransactions.filter(t => t.partnerId === sessionPartnerId);
    
    // console.log(`[fetchAllTransactions] Filtered ${allTransactions.length} company transactions to ${ibTransactions.length} for PartnerId ${sessionPartnerId}`);
    
    return ibTransactions;
  } catch (error) {
    //console.error('fetchAllTransactions error:', error);
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

export const saveCampaign = async (campaign) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
     // console.log('[Campaigns] Partner ID not available yet, waiting...');
      partnerId = await ensurePartnerIdAvailable();
    }
    if (!partnerId) {
      //console.error('[Campaigns] No partner ID found after waiting');
      return null;
    }

    const campaignObj = {
      id: campaign.id || `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      partner_id: String(partnerId),
      name: campaign.name,
      referrer_tag: campaign.referrerTag,
      description: campaign.description || '',
      cost: campaign.cost || 0,
      status: campaign.status || 'active',
      created_date: campaign.createdDate || new Date().toISOString(),
      updated_date: new Date().toISOString()
    };

    // Upsert: Update if exists, insert if new
    const { data, error } = await supabase
      .from('campaigns')
      .upsert(campaignObj, { onConflict: 'id' })
      .select();

    if (error) {
      console.error('[Campaigns] Error saving campaign:', error);
      return null;
    }

    //console.log(`[Campaigns] Saved campaign: ${campaignObj.name} for partner ${partnerId}`);
    return campaignObj.id;
  } catch (error) {
    console.error('[Campaigns] Exception saving campaign:', error);
    // Fallback to localStorage
    return saveCampaignLocal(campaign);
  }
};

export const getCampaigns = async () => {
  try {
    let partnerId = getSessionPartnerId();
    
    // If partner ID not yet available, wait for it (WebSocket may still be connecting)
    if (!partnerId) {
      console.log('[Campaigns] Partner ID not available yet, waiting for WebSocket...');
      partnerId = await ensurePartnerIdAvailable();
    }
    
   // console.log('[Campaigns] Query started. Partner ID:', partnerId);
    
    if (!partnerId) {
      console.warn('[Campaigns] No partner ID even after waiting, using localStorage fallback');
      return getCampaignsLocal();
    }

   // console.log('[Campaigns] Querying Supabase for partner_id:', partnerId);
    
    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('partner_id', String(partnerId))
      .order('created_date', { ascending: false });

    // console.log('[Campaigns] Supabase response:', { data, error });
    
    if (error) {
      console.error('[Campaigns] Error fetching campaigns:', error);
      // console.log('[Campaigns] Falling back to localStorage');
      //return getCampaignsLocal();
    }

    // Convert snake_case to camelCase for consistency
    const campaigns = (data || []).map(c => ({
      ...c,
      referrerTag: c.referrer_tag,
      createdDate: c.created_date,
      updatedDate: c.updated_date
    }));

    console.log(`[Campaigns] Successfully fetched ${campaigns.length} campaigns for partner ${partnerId}`);
    return campaigns;
  } catch (error) {
    console.error('[Campaigns] Exception fetching campaigns:', error);
    return getCampaignsLocal();
  }
};

/**
 * Get single campaign by ID from Supabase
 */
export const getCampaignById = async (id) => {
  try {
    const partnerId = getSessionPartnerId();
    if (!partnerId) return null;

    const { data, error } = await supabase
      .from('campaigns')
      .select('*')
      .eq('id', id)
      .eq('partner_id', String(partnerId))
      .single();

    if (error) {
      console.error('[Campaigns] Error fetching campaign:', error);
      return null;
    }

    if (!data) return null;

    // Convert snake_case to camelCase
    return {
      ...data,
      referrerTag: data.referrer_tag,
      createdDate: data.created_date,
      updatedDate: data.updated_date
    };
  } catch (error) {
    console.error('[Campaigns] Exception fetching campaign:', error);
    return null;
  }
};

/**
 * Delete campaign by ID from Supabase
 */
export const deleteCampaign = async (id) => {
  try {
    const partnerId = getSessionPartnerId();
    if (!partnerId) {
      console.error('[Campaigns] No partner ID found');
      return false;
    }

    const { error } = await supabase
      .from('campaigns')
      .delete()
      .eq('id', id)
      .eq('partner_id', String(partnerId));

    if (error) {
      console.error('[Campaigns] Error deleting campaign:', error);
      return false;
    }

    console.log(`[Campaigns] Deleted campaign: ${id} for partner ${partnerId}`);
    return true;
  } catch (error) {
    console.error('[Campaigns] Exception deleting campaign:', error);
    return false;
  }
};

export const getCampaignStats = async (referrerTag, clients = null) => {
  try {
    // If clients not provided, fetch them
    let clientList = clients;
    if (!clientList) {
      clientList = await fetchCompleteClientData();
    }
    
    // Match clients by Referrer field
    // Check multiple possible field names: Referrer, referrer, ReferralCode, referralCode
    const matchingClients = clientList.filter(c => {
      const clientReferrer = c.Referrer || c.referrer || c.ReferralCode || c.referralCode || '';
      return clientReferrer.toLowerCase().trim() === referrerTag.toLowerCase().trim();
    });
    
    // Calculate stats
    const signups = matchingClients.length;
    const activeClients = matchingClients.filter(c => c.active).length;
    
    // Get total commission from matching clients
    // Commission comes directly from XValley (includes all calculations, no local computations)
    let totalRevenue = 0;
    matchingClients.forEach(c => {
      // Use baseCommission directly (100% from XValley API)
      const clientCommission = c.baseCommission || 0;
      totalRevenue += clientCommission;
    });
    
    return {
      signups,
      activeClients,
      totalRevenue: Math.round(totalRevenue * 100) / 100,
      clients: matchingClients
    };
  } catch (error) {
    console.error('[getCampaignStats] Error:', error);
    return {
      signups: 0,
      activeClients: 0,
      totalRevenue: 0,
      clients: []
    };
  }
};

/**
 * Get stats for all campaigns (with clients pre-fetched for efficiency)
 */
export const getAllCampaignStats = async () => {
  try {
    const campaigns = await getCampaigns();
    const clients = await fetchCompleteClientData();
    
    const campaignStats = {};
    for (const campaign of campaigns) {
      const stats = await getCampaignStats(campaign.referrerTag, clients);
      campaignStats[campaign.id] = {
        ...campaign,
        stats: {
          ...stats,
          roi: campaign.cost > 0 
            ? Math.round(((stats.totalRevenue - campaign.cost) / campaign.cost) * 100) 
            : 0
        }
      };
    }
    
    return campaignStats;
  } catch (error) {
    console.error('[getAllCampaignStats] Error:', error);
    return {};
  }
};

export const saveAsset = async (asset) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      console.log('[Assets] Partner ID not available yet, waiting...');
      partnerId = await ensurePartnerIdAvailable();
    }
    if (!partnerId) {
      console.error('[Assets] No partner ID found after waiting');
      return null;
    }

    const assetId = asset.id || `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    let fileDataOrUrl = null;

    // If we have base64 file data, upload to Storage
    if (asset.fileData && asset.fileData.startsWith('data:')) {
      console.log(`[Assets] Uploading file to Storage: ${asset.fileName}`);
      
      try {
        // Convert base64 to blob
        const response = await fetch(asset.fileData);
        const blob = await response.blob();
        
        // Upload to Storage
        const storagePath = `partner_${partnerId}/${assetId}/${asset.fileName}`;
        const fileUrl = await uploadFileToStorage('nommia-ib', storagePath, blob);
        
        if (fileUrl) {
          fileDataOrUrl = fileUrl;  // Store URL in database
          console.log(`[Assets] File uploaded to Storage: ${fileUrl}`);
        } else {
          throw new Error('Failed to upload file to Storage');
        }
      } catch (uploadErr) {
        console.error('[Assets] Storage upload failed:', uploadErr);
        // Fallback: store base64 directly (not ideal but works)
        fileDataOrUrl = asset.fileData;
      }
    } else if (asset.fileData) {
      // Already a URL or other format
      fileDataOrUrl = asset.fileData;
    }

    const assetObj = {
      id: assetId,
      partner_id: String(partnerId),
      name: asset.name,
      type: asset.type,
      file_name: asset.fileName,
      file_size: asset.fileSize || 'Unknown',
      file_data: fileDataOrUrl,  // Now stores URL or fallback base64
      description: asset.description || '',
      tags: asset.tags || [],
      upload_date: asset.uploadDate || new Date().toISOString(),
      updated_date: new Date().toISOString()
    };

    // Save to Supabase database
    const { data, error } = await supabase
      .from('assets')
      .upsert(assetObj, { onConflict: 'id' })
      .select();

    if (error) {
      console.error('[Assets] Error saving to Supabase:', error);
      throw error;
    }

    console.log(`[Assets] Saved to Supabase: ${assetObj.name} for partner ${partnerId}`);
    return assetId;
  } catch (error) {
    console.error('[Assets] Exception saving asset:', error);
    throw error;
  }
};

/**
 * Get all marketing assets from Supabase (source of truth)
 */
export const getAssets = async () => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      console.log('[Assets] Partner ID not available, waiting...');
      partnerId = await ensurePartnerIdAvailable();
    }
    
    if (!partnerId) {
      console.warn('[Assets] No partner ID available');
      return [];
    }

    // Query from Supabase (source of truth)
    const { data, error } = await supabase
      .from('assets')
      .select('*')
      .eq('partner_id', String(partnerId))
      .order('upload_date', { ascending: false });

    if (error) {
      console.error('[Assets] Error fetching from Supabase:', error);
      return [];
    }

    // Convert snake_case to camelCase for consistency
    const assets = (data || []).map(a => ({
      id: a.id,
      partner_id: a.partner_id,
      name: a.name,
      type: a.type,
      file_name: a.file_name,
      fileName: a.file_name,
      file_size: a.file_size,
      fileSize: a.file_size,
      file_data: a.file_data,
      fileData: a.file_data,
      description: a.description,
      tags: a.tags,
      upload_date: a.upload_date,
      uploadDate: a.upload_date,
      updated_date: a.updated_date,
      updatedDate: a.updated_date
    }));

    console.log(`[Assets] Loaded ${assets.length} assets from Supabase`);
    if (assets.length > 0) {
      const first = assets[0];
      console.log('[Assets] First asset:', {
        name: first.name,
        type: first.type,
        hasFileData: !!(first.fileData || first.file_data),
        fileDataLength: (first.fileData || first.file_data) ? String(first.fileData || first.file_data).length : 0
      });
    }
    return assets;
  } catch (error) {
    console.error('[Assets] Exception fetching assets:', error);
    return [];
  }
};

/**
 * Get single asset by ID from Supabase
 */
export const getAssetById = async (id) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      partnerId = await ensurePartnerIdAvailable();
    }
    if (!partnerId) return null;

    const { data, error } = await supabase
      .from('assets')
      .select('*')
      .eq('id', id)
      .eq('partner_id', String(partnerId))
      .single();

    if (error) {
      console.error('[Assets] Error fetching asset:', error);
      return null;
    }

    if (!data) return null;

    // Convert snake_case to camelCase
    return {
      ...data,
      fileName: data.file_name,
      fileSize: data.file_size,
      fileData: data.file_data,
      uploadDate: data.upload_date,
      updatedDate: data.updated_date
    };
  } catch (error) {
    console.error('[Assets] Exception fetching asset:', error);
    return null;
  }
};

/**
 * Delete asset by ID from Supabase + Storage
 */
export const deleteAsset = async (id) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      console.log('[Assets] Partner ID not available, waiting...');
      partnerId = await ensurePartnerIdAvailable();
    }
    if (!partnerId) {
      console.error('[Assets] No partner ID found');
      return false;
    }

    // First, get the asset to find the file path
    const asset = await getAssetById(id);
    
    // Try to delete file from Storage if it's a Storage URL
    if (asset && asset.fileData && asset.fileData.includes('storage.googleapis.com')) {
      // Extract file path from URL
      try {
        const storagePath = `partner_${partnerId}/${id}`;
        console.log(`[Assets] Deleting file from Storage: ${storagePath}`);
        await deleteFileFromStorage('nommia-ib', storagePath);
      } catch (storageErr) {
        console.warn('[Assets] Could not delete file from Storage (may have been deleted already):', storageErr);
      }
    }

    // Delete from database
    const { error } = await supabase
      .from('assets')
      .delete()
      .eq('id', id)
      .eq('partner_id', String(partnerId));

    if (error) {
      console.error('[Assets] Error deleting asset:', error);
      return false;
    }

    console.log(`[Assets] Deleted asset: ${id} for partner ${partnerId}`);
    return true;
  } catch (error) {
    console.error('[Assets] Exception deleting asset:', error);
    return false;
  }
};

// ============= FALLBACK LOCALSTORAGE FUNCTIONS (For offline/fallback support) =============

const getCampaignsStorageKey = () => `nommia_campaigns_${getSessionPartnerId()}`;
const getAssetsStorageKey = () => `nommia_assets_${getSessionPartnerId()}`;

const saveCampaignLocal = (campaign) => {
  try {
    let campaigns = getCampaignsLocal();
    if (campaign.id) {
      const index = campaigns.findIndex(c => c.id === campaign.id);
      if (index >= 0) {
        campaigns[index] = { ...campaigns[index], ...campaign, updatedDate: new Date().toISOString() };
      } else {
        campaigns.push({ ...campaign, createdDate: new Date().toISOString(), updatedDate: new Date().toISOString() });
      }
    } else {
      const id = `campaign_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const now = new Date().toISOString();
      campaigns.push({ ...campaign, id, createdDate: now, updatedDate: now });
    }
    localStorage.setItem(getCampaignsStorageKey(), JSON.stringify(campaigns));
    console.log(`[Campaigns] Saved campaign to localStorage: ${campaign.name}`);
    return campaign.id || campaigns[campaigns.length - 1].id;
  } catch (error) {
    console.error('[Campaigns] Error saving to localStorage:', error);
    return null;
  }
};

const getCampaignsLocal = () => {
  try {
    const data = localStorage.getItem(getCampaignsStorageKey());
    return data ? JSON.parse(data) : [];
  } catch (error) {
    console.error('[Campaigns] Error reading campaigns from localStorage:', error);
    return [];
  }
};

const saveAssetLocal = (asset) => {
  try {
    let assets = getAssetsLocal();
    
    // Save FULL asset WITH fileData
    const assetToSave = {
      id: asset.id,
      partner_id: asset.partner_id,
      name: asset.name,
      type: asset.type,
      file_name: asset.file_name,
      file_size: asset.file_size,
      file_data: asset.file_data || asset.fileData || null,
      description: asset.description,
      tags: asset.tags,
      upload_date: asset.upload_date,
      updated_date: asset.updated_date
    };
    
    const index = assets.findIndex(a => a.id === asset.id);
    if (index >= 0) {
      assets[index] = assetToSave;
    } else {
      assets.push(assetToSave);
    }
    
    localStorage.setItem(getAssetsStorageKey(), JSON.stringify(assets));
    console.log(`[Assets] Saved to localStorage with fileData: ${asset.name}`);
    return asset.id;
  } catch (error) {
    console.error('[Assets] Error saving to localStorage:', error);
    return null;
  }
};

const getAssetsLocal = () => {
  try {
    const data = localStorage.getItem(getAssetsStorageKey());
    const assets = data ? JSON.parse(data) : [];
    // Return WITH file_data for image preview and download
    return assets.map(a => ({
      id: a.id,
      partner_id: a.partner_id,
      name: a.name,
      type: a.type,
      file_name: a.file_name || a.fileName,
      fileName: a.file_name || a.fileName,
      file_size: a.file_size || a.fileSize,
      fileSize: a.file_size || a.fileSize,
      file_data: a.file_data || a.fileData || null,
      fileData: a.file_data || a.fileData || null,
      description: a.description,
      tags: a.tags,
      upload_date: a.upload_date,
      uploadDate: a.upload_date,
      updated_date: a.updated_date,
      updatedDate: a.updated_date
    }));
  } catch (error) {
    console.error('[Assets] Error reading assets from localStorage:', error);
    return [];
  }
};

// ============= EMAIL NUDGE SYSTEM =============

/**
 * Send email nudge to a partner/client and store record in Supabase
 * Calls backend Express server which uses Nodemailer + Gmail
 * 
 * @param {string} recipientEmail - Email to send nudge to
 * @param {string} recipientName - Name of recipient
 * @param {string} referrerName - Name of person sending nudge (IB)
 * @param {string} nudgeType - Type: 'Complete KYC' or 'Fund Account'
 * @param {number} tier - Network tier (1, 2, or 3)
 * @param {string|number} partnerId - Partner/referrer ID
 * @returns {Promise<object>} - { success: boolean, messageId?: string, error?: string }
 */
export const sendNudgeEmail = async (recipientEmail, recipientName, referrerName, nudgeType, tier, partnerId) => {
  try {
    const backendUrl = API_CONFIG.BACKEND_URL;
    
    console.log(`[Nudge] Sending ${nudgeType} email to ${recipientEmail}...`);
    console.log(`[Nudge] Recipient: ${recipientName}, Referrer: ${referrerName}, Tier: ${tier}`);
    
    // Step 1: Call backend to send email
    const response = await fetch(`${backendUrl}/api/nudges/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientEmail,
        recipientName,
        referrerName,
        nudgeType,
        tier,
        partnerId: String(partnerId)
      })
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error(`[Nudge] Backend error (${response.status}):`, errorData);
      throw new Error(errorData.error || 'Failed to send email');
    }

    const emailResult = await response.json();
    console.log(`[Nudge] ✅ Email sent successfully:`, emailResult);

    // Step 2: Store nudge record in Supabase (for tracking/audit)
    const nudgeRecord = {
      recipient_email: recipientEmail,
      recipient_name: recipientName,
      referrer_name: referrerName,
      nudge_type: nudgeType,
      tier: tier,
      partner_id: String(partnerId),
      email_message_id: emailResult.messageId || null,
      status: 'sent',
      sent_at: new Date().toISOString(),
      backend_response: emailResult
    };

    try {
      const { data, error: supabaseError } = await supabase
        .from('nudges')
        .insert([nudgeRecord])
        .select();

      if (supabaseError) {
        console.warn('[Nudge] Supabase insert warning:', supabaseError);
        // Don't fail the nudge if Supabase insert fails - email was already sent
      } else {
        console.log('[Nudge] ✅ Record stored in Supabase:', data?.[0]?.id);
      }
    } catch (supabaseErr) {
      console.warn('[Nudge] Could not store nudge record:', supabaseErr.message);
      // Continue - email was already sent successfully
    }

    return {
      success: true,
      messageId: emailResult.messageId,
      timestamp: emailResult.timestamp
    };

  } catch (error) {
    console.error('[Nudge] Error sending nudge:', error);
    return {
      success: false,
      error: error.message
    };
  }
};

/**
 * Get nudge history from Supabase (for audit trail)
 */
export const getNudgeHistory = async (partnerId = null) => {
  try {
    let query = supabase.from('nudges').select('*');
    
    if (partnerId) {
      query = query.eq('partner_id', String(partnerId));
    }
    
    const { data, error } = await query.order('sent_at', { ascending: false });
    
    if (error) {
      console.error('[Nudge] Error fetching history:', error);
      return [];
    }
    
    console.log(`[Nudge] Fetched ${data?.length || 0} nudge records`);
    return data || [];
  } catch (error) {
    console.error('[Nudge] Exception fetching nudge history:', error);
    return [];
  }
};

// ============= PAYOUT DETAILS =============

/**
 * Save payout details (bank wire and crypto wallet addresses)
 * @param {Object} payoutData - Payout information
 * @returns {Promise<Object>} Response from backend
 */
export const savePayoutDetails = async (payoutData) => {
  try {
    const partnerId = getSessionPartnerId();
    if (!partnerId) {
      throw new Error('Partner ID not found in session');
    }

    console.log('[Payouts] Saving payout details for partner:', partnerId);

    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payouts/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        partnerId,
        bankName: payoutData.bankName,
        accountNumber: payoutData.accountNum,
        iban: payoutData.accountNum, // Assume IBAN if it looks like one
        swiftCode: payoutData.bic,
        usdtTrc20: payoutData.usdtTrc,
        usdtErc20: payoutData.usdtErc,
        usdcPolygon: payoutData.usdcPol,
        usdcErc20: payoutData.usdcErc,
        preferredMethod: payoutData.preferredMethod
      })
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error('[Payouts] ❌ Save failed:', result.error);
      throw new Error(result.error || 'Failed to save payout details');
    }

    console.log('[Payouts] ✅ Saved successfully');
    return result;
  } catch (error) {
    console.error('[Payouts] Exception:', error);
    throw error;
  }
};

/**
 * Fetch payout details for current partner
 * @returns {Promise<Object|null>} Payout details or null if not found
 */
export const getPayoutDetails = async () => {
  try {
    const partnerId = getSessionPartnerId();
    if (!partnerId) {
      throw new Error('Partner ID not found in session');
    }

    console.log('[Payouts] Fetching payout details for partner:', partnerId);

    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payouts/${partnerId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error('[Payouts] ❌ Fetch failed:', result.error);
      throw new Error(result.error || 'Failed to fetch payout details');
    }

    console.log('[Payouts] ✅ Fetched successfully');
    return result.data;
  } catch (error) {
    console.error('[Payouts] Exception:', error);
    return null;
  }
};

/**
 * Delete payout details for current partner
 * @returns {Promise<Object>} Response from backend
 */
export const deletePayoutDetails = async () => {
  try {
    const partnerId = getSessionPartnerId();
    if (!partnerId) {
      throw new Error('Partner ID not found in session');
    }

    console.log('[Payouts] Deleting payout details for partner:', partnerId);

    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payouts/${partnerId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();
    
    if (!response.ok) {
      console.error('[Payouts] ❌ Delete failed:', result.error);
      throw new Error(result.error || 'Failed to delete payout details');
    }

    console.log('[Payouts] ✅ Deleted successfully');
    return result;
  } catch (error) {
    console.error('[Payouts] Exception:', error);
    throw error;
  }
};

// ============= SECURITY API FUNCTIONS =============

/**
 * Send OTP to email address - matches nudge email pattern
 * Calls backend Express server which uses Nodemailer + Brevo SMTP
 * Stores OTP record in Supabase for audit trail
 * 
 * @param {string} email - Email address to send OTP to
 * @param {string} type - Type of OTP: 'security' or 'admin'
 * @returns {Promise<object>} - { success: boolean, message?: string, code?: string }
 */
export const sendOtp = async (email, type = 'security') => {
  try {
    const backendUrl = API_CONFIG.BACKEND_URL;
    
    // Validate email
    if (!email || typeof email !== 'string' || email.trim() === '') {
      const errorMsg = 'Email is required to send OTP';
      console.error('[OTP] ❌', errorMsg, 'Received:', email);
      return {
        success: false,
        message: errorMsg
      };
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const cleanEmail = email.trim().toLowerCase();
    
    if (!emailRegex.test(cleanEmail)) {
      const errorMsg = `Invalid email format: ${cleanEmail}`;
      console.error('[OTP] ❌', errorMsg);
      return {
        success: false,
        message: errorMsg
      };
    }

    console.log(`[OTP] Sending OTP to ${cleanEmail} (type: ${type})...`);
    
    // Step 1: Call backend to send OTP
    const response = await fetch(`${backendUrl}/api/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanEmail,
        type: type || 'security'
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error(`[OTP] Backend error (${response.status}):`, errorData);
      throw new Error(errorData.error || errorData.message || `Server error: ${response.status}`);
    }

    const otpResult = await response.json();
    console.log(`[OTP] ✅ OTP sent successfully:`, otpResult);

    // Step 2: Store OTP record in Supabase (for tracking/audit)
    const otpRecord = {
      email: cleanEmail,
      type: type || 'security',
      status: 'sent',
      sent_at: new Date().toISOString(),
      backend_response: otpResult,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString() // 10 minutes from now
    };

    try {
      const { data, error: supabaseError } = await supabase
        .from('otp_logs')
        .insert([otpRecord])
        .select();

      if (supabaseError) {
        console.warn('[OTP] Supabase insert warning:', supabaseError);
        // Don't fail the OTP if Supabase insert fails - email was already sent
      } else {
        console.log('[OTP] ✅ Record stored in Supabase:', data?.[0]?.id);
      }
    } catch (supabaseErr) {
      console.warn('[OTP] Could not store OTP record:', supabaseErr.message);
      // Continue - email was already sent successfully
    }

    return {
      success: true,
      message: `Security code sent to ${cleanEmail}`,
      timestamp: otpResult.timestamp
    };

  } catch (error) {
    console.error('[OTP] ❌ Send error:', error);
    return {
      success: false,
      message: error.message || 'Failed to send OTP'
    };
  }
};

/**
 * Verify OTP code - improved error handling
 * @param {string} email - Email address
 * @param {string} code - 6-digit OTP code
 * @returns {Promise<object>} - { success: boolean, message?: string }
 */
export const verifyOtp = async (email, code) => {
  try {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanCode = (code || '').trim();

    if (!cleanEmail || !cleanCode) {
      console.error('[OTP] ❌ Email and code are required');
      return {
        success: false,
        message: 'Email and code are required'
      };
    }

    console.log(`[OTP] Verifying code for ${cleanEmail}...`);

    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanEmail,
        code: cleanCode
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error(`[OTP] Verify backend error (${response.status}):`, errorData);
      throw new Error(errorData.error || errorData.message || `Server error: ${response.status}`);
    }

    const data = await response.json();
    console.log(`[OTP] Verify for ${cleanEmail}:`, data.success ? '✅' : '❌');
    
    // Store verification attempt
    try {
      await supabase
        .from('otp_logs')
        .update({
          status: data.success ? 'verified' : 'failed',
          verified_at: new Date().toISOString()
        })
        .eq('email', cleanEmail)
        .order('sent_at', { ascending: false })
        .limit(1);
    } catch (err) {
      console.warn('[OTP] Could not update verification status:', err.message);
    }

    return data;
  } catch (error) {
    console.error('[OTP] Verify error:', error);
    return {
      success: false,
      message: error.message || 'Failed to verify OTP'
    };
  }
};

/**
 * Reset password with OTP verification - improved error handling
 * @param {string} email - User email
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @param {string} code - OTP code
 * @returns {Promise<object>} - { success: boolean, message?: string }
 */
export const resetPasswordWithOtp = async (email, oldPassword, newPassword, code) => {
  try {
    const cleanEmail = (email || '').trim().toLowerCase();
    const cleanCode = (code || '').trim();

    // Validate required fields
    if (!cleanEmail || !oldPassword || !newPassword || !cleanCode) {
      console.error('[Password] ❌ All fields are required (email, oldPassword, newPassword, code)');
      return {
        success: false,
        message: 'Missing required fields'
      };
    }

    // Validate password strength
    if (newPassword.length < 6) {
      console.error('[Password] ❌ New password must be at least 6 characters');
      return {
        success: false,
        message: 'New password must be at least 6 characters'
      };
    }

    console.log('[Password] Resetting password with OTP for:', cleanEmail);

    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/password/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: cleanEmail,
        oldPassword: oldPassword,
        newPassword: newPassword,
        code: cleanCode
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      console.error(`[Password] Backend error (${response.status}):`, errorData);
      throw new Error(errorData.error || errorData.message || `Server error: ${response.status}`);
    }

    const data = await response.json();
    console.log('[Password] Reset with OTP:', data.success ? '✅' : '❌');
    
    return data;
  } catch (error) {
    console.error('[Password] Reset error:', error);
    return {
      success: false,
      message: error.message || 'Failed to reset password'
    };
  }
};

/**
 * Update password in XValley API
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<Response>} - XValley API response
 */
export const updatePasswordXValley = async (oldPassword, newPassword) => {
  try {
    const authToken = localStorage.getItem('authToken');
    if (!authToken) {
      throw new Error('Authentication token not found');
    }

    const response = await fetch(`${API_CONFIG.API_BASE_URL}/profile/reset/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        OldPassword: oldPassword,
        NewPassword: newPassword,
        ConfirmPassword: newPassword
      })
    });
    console.log('[XValley] Password update:', response.ok ? '✅' : '❌');
    return response;
  } catch (error) {
    console.error('[XValley] Password update error:', error);
    throw error;
  }
};

/**
 * Setup 2FA for a user
 * @param {string} username - Username
 * @returns {Promise<object>} - { success: boolean, secret?: string, qrCodeUrl?: string, message?: string }
 */
export const setup2FA = async (username) => {
  try {
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await response.json();
    console.log('[2FA] Setup for', username, ':', data.success ? '✅' : '❌');
    return data;
  } catch (error) {
    console.error('[2FA] Setup error:', error);
    throw error;
  }
};

/**
 * Verify 2FA code
 * @param {string} username - Username
 * @param {string} secret - TOTP secret
 * @param {string} token - 6-digit TOTP code
 * @returns {Promise<object>} - { success: boolean, message?: string }
 */
export const verify2FA = async (username, secret, token) => {
  try {
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        secret,
        token
      })
    });
    const data = await response.json();
    console.log('[2FA] Verify for', username, ':', data.success ? '✅' : '❌');
    return data;
  } catch (error) {
    console.error('[2FA] Verify error:', error);
    throw error;
  }
};

/**
 * Disable 2FA for a user
 * @param {string} username - Username
 * @returns {Promise<object>} - { success: boolean, message?: string }
 */
export const disable2FA = async (username) => {
  try {
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/disable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username })
    });
    const data = await response.json();
    console.log('[2FA] Disable for', username, ':', data.success ? '✅' : '❌');
    return data;
  } catch (error) {
    console.error('[2FA] Disable error:', error);
    throw error;
  }
};

// Legacy exports for compatibility
export const fetchNommiaClients = fetchIBClients;
export const fetchNetworkVolume = fetchNetworkStats;
