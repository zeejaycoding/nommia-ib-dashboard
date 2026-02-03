/**
 * NOMMIA IB DASHBOARD - API INTEGRATION
 * Handles all WAMP connections, Authentication, and Real-Time Data Fetching
 * Based on XValley WAMP Protocol
 */

import autobahn from 'autobahn-browser';

// Commission rates per instrument (use Instrument.Name or FixName as key)
// Adjust rates to match broker commission structure
const COMMISSION_RATES = {
  EURUSD: 5,
  GBPUSD: 5,
  XAUUSD: 8,
  BTCUSD: 10,
  USOil: 7,
  default: 5
};

const API_CONFIG = {
  // API Base URL - configure to your XValley API server
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || "https://api.nommia.io",
  
  // WebSocket endpoints - Will be updated from server config (AdminServer)
  WS_URL: "wss://platform.nommia.io:23027/ws", 
  REALM: "fxplayer", 
  BROKER_HOST: import.meta.env.VITE_BROKER_HOST || "nommia.io",
  
  // WAMP RPC endpoints (Backoffice API)
  TOPICS: {
    PING: 'com.fxplayer.ping',
    LEADS: 'com.fxplayer.leads',                    // Get clients/leads (AdminType: 1)
    TRADERS: 'com.fxplayer.traders',                // Get trading accounts (AdminType: 8)
    PLATFORM_OPEN: 'com.fxplayer.platformopen',     // Get open trades (AdminType: 205)
    PLATFORM_PENDING: 'com.fxplayer.platformpending', // Get pending trades
    PLATFORM_CLOSE: 'com.fxplayer.platformclose',   // Get closed trades
    PLATFORM_CANCEL: 'com.fxplayer.platformcancel', // Get cancelled trades
    DEPOSITS: 'com.fxplayer.deposits',              // Get deposits/withdrawals (AdminType: 100)
    DEPOSIT: 'com.fxplayer.deposit',                // Create deposit action
    CONTACTS: 'com.fxplayer.contacts',              // Get communication history
    ACCOUNT_TYPES: 'com.fxplayer.accounttypes',     // Get account types
    ACCOUNT_LEVELS: 'com.fxplayer.accountlevels',   // Get account levels
    COMPANIES: 'com.fxplayer.Companies',            // Get companies
    COUNTRIES: 'com.fxplayer.GetCountries',         // Get countries
    INSTRUMENTS: 'com.fxplayer.instruments',        // Get instruments
    OPEN_NEW_ACCOUNT: 'com.fxplayer.OpenNewAccount', // Create new user with trading account
    ADD_TRADER_ACCOUNT: 'com.fxplayer.AddTraderAccount', // Add trading account to existing user
    CONTRACT: 'com.fxplayer.contract',              // Get instrument contract specs
    SAVE_USER: 'com.fxplayer.saveuser'              // Save user details
  },
  
  // Subscription topics for real-time events
  SUBSCRIPTIONS: {
    TRADE_EVENTS: 'com.fxplayer.trade',    // Real-time trade events
    ACCOUNT_EVENTS: 'com.fxplayer.account', // Real-time account events
  }
};

// --- Server Configuration (fetched from API) ---
let serverConfig = null;


/**
 * Fetch server configuration from XValley API
 * Returns server endpoints for QuoteServer, TradeServer, AdminServer, etc.
 */
export const fetchServerConfig = async () => {
  try {
    console.log("Fetching server configuration...");
    const response = await fetch(`${API_CONFIG.API_BASE_URL}/settings/servers`);
    
    if (!response.ok) {
      console.warn("Could not fetch server config, using defaults");
      return null;
    }
    
    const data = await response.json();
    console.log("Server Configuration:", data);
    
    // data[0] contains array of servers
    const servers = Array.isArray(data[0]) ? data[0] : data;
    serverConfig = {};
    
    servers.forEach(server => {
      serverConfig[server.name] = {
        host: server.host,
        port: server.port,
        url: `wss://${server.host}:${server.port}/ws`
      };
    });
    
    console.log("Parsed Servers:", serverConfig);
    
    // Use AdminServer from API response (platform.nommia.io)
    if (serverConfig.AdminServer) {
      API_CONFIG.WS_URL = serverConfig.AdminServer.url;
      console.log("Using AdminServer from config:", API_CONFIG.WS_URL);
    }
    
    return serverConfig;
  } catch (e) {
    console.error("Failed to fetch server config:", e);
    return null;
  }
};

// --- Connection State Management ---
let wsSession = null;
let wsConnection = null;  // Store the connection object for proper closing
let wsSessionId = null;  // Session ID returned from PING for subscriptions
let sessionUsername = null;  // Username from PING response
let sessionPartnerId = null;  // PartnerId from PING response
let connectionPromise = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 20;

// --- 1. Login & Token ---
export const loginAndGetToken = async (username, password) => {
  console.log("1. Requesting Token from User API...");
  try {
    const response = await fetch(`${API_CONFIG.API_BASE_URL}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password', username, password })
    });
    
    if (!response.ok) throw new Error("Login Failed");
    
    const data = await response.json();
    console.log("2. Token Received:", data.access_token ? "Valid" : "Invalid");
    return data.refresh_token || data.access_token;
  } catch (e) {
    console.error("Login Error:", e);
    return null;
  }
};

// --- Fetch Current User Details ---
export const fetchCurrentUser = async (username, token) => {
  const userToFetch = username || sessionUsername;
  if (!userToFetch || !token) {
    console.log("No username or token available for fetching user details");
    return null;
  }
  try {
    console.log("Fetching current user details for:", userToFetch);
    // Use the username as referralcode for now, adjust if needed
    const response = await fetch(`${API_CONFIG.API_BASE_URL}/auth/getuser/?username=${userToFetch}&referralcode=${userToFetch}&real=true`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    if (!response.ok) throw new Error("Failed to fetch user details");
    
    const user = await response.json();
    console.log("Current user details:", user);
    return user;
  } catch (e) {
    console.error("Error fetching current user:", e);
    return null;
  }
};

// --- Get Session PartnerId ---
export const getSessionPartnerId = () => sessionPartnerId;

// --- 2. WebSocket Connection & Authentication ---
export const connectWebSocket = (token) => {
  // Return existing connection if already connecting/connected
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise((resolve, reject) => {
    console.log("3. Initializing WAMP Connection to XValley...");

    try {
      const connection = new autobahn.Connection({
        url: API_CONFIG.WS_URL,
        realm: API_CONFIG.REALM,
        max_retries: MAX_RECONNECT_ATTEMPTS,
        initial_retry_delay: 1.5,
        max_retry_delay: 30,
        retry_delay_growth: 1.5,
        autoping: true,
        autoping_interval: 10000,
        autoping_timeout: 5000,
      });
      
      // Store connection for proper closing later
      wsConnection = connection;

      connection.onopen = (session) => {
        console.log("4. WAMP Session ESTABLISHED!");
        reconnectAttempts = 0;
        
        // Authenticate with xvalley backend using PING message
        session.call(API_CONFIG.TOPICS.PING, [JSON.stringify({
          token: token,
          host: API_CONFIG.BROKER_HOST
        })]).then((rawRes) => {
          // Parse response if it's a string
          const res = typeof rawRes === 'string' ? JSON.parse(rawRes) : rawRes;
          console.log("5. PING Response from XValley:", res);
          
          // Log full PING response to understand account permissions
          console.log("=== PING RESPONSE DETAILS ===");
          if (res && res.Messages) {
            res.Messages.forEach((msg, i) => {
              console.log(`  Message[${i}]:`, typeof msg === 'object' ? JSON.stringify(msg) : msg);
            });
          }
          
          // Check for error response (MessageType: -3 = Error)
          if (res && res.MessageType === -3) {
            const errorMsg = res.Messages?.[0] || "Authentication failed";
            console.error("5. Authentication REJECTED:", errorMsg);
            console.error("   This account does not have IB/Admin permissions in XValley.");
            console.error("   Contact your broker admin to grant IB access.");
            wsSession = null;
            wsSessionId = null;
            connectionPromise = null;
            connection.close();
            reject(new Error(errorMsg));
            return;
          }
          
          // Extract session ID from response for subscriptions
          // Response format: {MessageType: x, Messages: [sessionId, ...]}
          if (res && res.Messages && res.Messages[0]) {
            wsSessionId = res.Messages[0];
            sessionUsername = res.Messages[0];
            sessionPartnerId = res.Messages[3];  // Assuming Message[3] is PartnerId
            console.log("5. ✅ Authenticated with XValley - Session ID:", wsSessionId, "PartnerId:", sessionPartnerId);
          } else if (res && res[0]) {
            wsSessionId = res[0];
            sessionUsername = res[0];
            sessionPartnerId = res[3];
            console.log("5. ✅ Authenticated with XValley - Session ID:", wsSessionId, "PartnerId:", sessionPartnerId);
          } else {
            console.warn("5. ⚠️ Authenticated but no session ID received - real-time updates may not work");
          }
          
          wsSession = session;
          resolve(session);
        }, (err) => {
          console.error("5. Authentication Failed:", err);
          wsSession = null;
          wsSessionId = null;
          connectionPromise = null;
          reject(err); 
        });
      };

      connection.onclose = (reason, details) => {
        console.warn("Connection Closed:", reason, details);
        wsSession = null;
        connectionPromise = null;
        
        if (reason === 'unreachable') {
          reject("Server Unreachable");
        }
      };

      connection.open();
      
    } catch (e) {
      console.error("WebSocket Library Error:", e);
      connectionPromise = null;
      reject(e);
    }
  });

  return connectionPromise;
};

// Get current session (create if needed)
export const getSession = async () => {
  if (wsSession) return wsSession;
  throw new Error("WebSocket not connected. Call connectWebSocket first.");
};

// --- 3. Real-Time Data Fetching Functions ---

/**
 * Fetch all IB clients/leads from XValley
 * Uses com.fxplayer.leads with correct XValley message format
 * Returns: Array of client objects
 */
/**
 * Fetch clients (leads) referred by the current logged-in partner/IB
 * Uses com.fxplayer.leads (AdminType: 1) — direct mapping, no calculations
 * 
 * @param {string|null} partnerId - Partner ID from session (getSessionPartnerId())
 * @returns {Promise<Array<Object>>} Array of client objects
 */
export const fetchNommiaClients = async (partnerId = null) => {
  try {
    const session = await getSession();
    
    // Build filters array
    let filters = [];
    if (partnerId) {
      filters.push({
        Filter: partnerId,
        FilterComparison: 3, // Equal
        FilterType: "PartnerId",
        FilterValueType: 2 // Number
      });
    }
    
    // XValley backoffice message format for leads
    const msg = { 
      MessageType: 100,
      From: "",                    // Date filter - empty for all
      To: "",                      // Date filter - empty for all
      Filters: filters,            // Add filter for PartnerId if provided
      PageSize: 100,               // Start with smaller page
      Sort: "Registration desc",
      Skip: 0, 
      AdminType: 1                 // Leads admin type
    };

    console.log("Fetching clients with filters:", filters.length > 0 ? filters : "No filters");
    console.log("Message being sent:", JSON.stringify(msg));
    
    // Try sending as raw object first (per API docs example)
    let result;
    try {
      result = await session.call(API_CONFIG.TOPICS.LEADS, [msg]);
      console.log("Raw object call succeeded");
    } catch (e) {
      console.log("Raw object failed, trying JSON.stringify...", e.message);
      result = await session.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
    }
    
    // Parse result - it comes as JSON string
    let data = result;
    if (typeof result === 'string') {
      data = JSON.parse(result);
    }
    
    // Debug: Log the FULL raw response to understand structure
    console.log("=== RAW API RESPONSE ===");
    console.log("Full response:", JSON.stringify(data, null, 2).substring(0, 3000));
    
    // XValley response structure is NESTED:
    // Response: { MessageType: 100, Messages: [wrapperObject] }
    // wrapperObject: { AdminType: 1, Messages: [...actualClients...], Total: N }
    let clients = [];
    let totalInDB = 0;
    
    // Check for nested structure: data.Messages[0].Messages
    if (data && data.Messages && Array.isArray(data.Messages) && data.Messages.length > 0) {
      const wrapper = data.Messages[0];
      if (wrapper && wrapper.Messages && Array.isArray(wrapper.Messages)) {
        // Nested structure - actual clients are in wrapper.Messages
        clients = wrapper.Messages;
        totalInDB = wrapper.Total || 0;
        console.log(`Received ${clients.length} clients (Total in DB: ${totalInDB})`);
      } else if (!wrapper.AdminType) {
        // Direct structure - data.Messages contains the clients
        clients = data.Messages;
        totalInDB = data.Total || clients.length;
        console.log(`Received ${clients.length} clients (direct response)`);
      } else {
        // Wrapper object but no clients
        totalInDB = wrapper.Total || 0;
        console.log(`Received 0 clients (Total in DB: ${totalInDB})`);
      }
    } else if (Array.isArray(data)) {
      clients = data;
      console.log(`Received ${clients.length} clients (array response)`);
    }
    
    // If leads endpoint returns empty, try traders endpoint (trading accounts)
    if (clients.length === 0 && totalInDB > 0) {
      console.log("Leads endpoint returned empty. Trying traders endpoint (AdminType: 8)...");
      
      const tradersMsg = {
        MessageType: 100,
        Filters: [],
        AdminType: 8,
        Sort: "Id desc",
        PageSize: 500,           // Get more accounts
        AccountType: "12"        // All account types (real + demo)
      };
      
      try {
        const tradersResult = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(tradersMsg)]);
        let tradersData = typeof tradersResult === 'string' ? JSON.parse(tradersResult) : tradersResult;
        
        console.log("=== TRADERS API RESPONSE ===");
        console.log("Full response:", JSON.stringify(tradersData, null, 2).substring(0, 3000));
        
        // Parse traders response
        if (tradersData && tradersData.Messages && tradersData.Messages.length > 0) {
          const wrapper = tradersData.Messages[0];
          if (wrapper && wrapper.Messages && Array.isArray(wrapper.Messages)) {
            const traders = wrapper.Messages;
            console.log(`✅ Received ${traders.length} trading accounts (Total: ${wrapper.Total})`);
            
            if (traders.length > 0) {
              console.log("First trader raw data:", traders[0]);
              console.log("Trader user object:", traders[0].T);
              console.log("All trader fields:", Object.keys(traders[0]));
              console.log("All user (T) fields:", Object.keys(traders[0].T || {}));

              // If a partner filter is available from session or function arg, apply it
              const partnerFilter = sessionPartnerId || partnerId || null;
              let filteredTraders = traders;

              if (partnerFilter) {
                filteredTraders = traders.filter(tr => {
                  const user = tr.T || {};
                  const pId = user.PartnerId || tr.PartnerId || (user.Partner && user.Partner.Id) || null;
                  return pId != null && Number(pId) === Number(partnerFilter);
                });
                console.log(`Filtered traders to ${filteredTraders.length} accounts for partner ${partnerFilter}`);
              }

              // Group trading accounts by the underlying user and return one row per user.
              // Rules:
              // - KYC is taken strictly from the XValley user object (`user.Approved`), not from trading-account flags.
              // - Financials prefer a real account's values; demo-account balances are ignored for the user row.
              // - Do NOT aggregate balances across accounts; pick a primary real account's values when present.
              const usersMap = {};
              filteredTraders.forEach(trader => {
                const user = trader.T || {};
                const uid = user.I || user.G || user.E || user.A || (`u_${trader.TI || trader.I}`);
                if (!usersMap[uid]) {
                  usersMap[uid] = {
                    id: uid,
                    username: user.A || user.Alias || `Trader-${trader.I}`,
                    name: user.A || user.Alias || user.Name || '',
                    email: user.E || user.Email || '',
                    // KYC from user object only
                    kycStatus: (user.Approved === true || user.Approved === 'true') ? 'Approved' : 'Pending',
                    approved: (user.Approved === true || user.Approved === 'true') || false,
                    // Financial placeholders (prefer real account values)
                    deposit: 0,
                    depositTimes: 0,
                    equity: 0,
                    balance: 0,
                    lots: 0,
                    availableBalance: 0,
                    closedPL: 0,
                    openPL: 0,
                    // Flags
                    hasRealAccounts: false,
                    isDemo: true,
                    partnerId: user.PartnerId || trader.PartnerId || '',
                    companyId: user.CompanyId || '',
                    companyName: (user.Company && user.Company.Name) || '',
                    // Keep all raw trader records for debugging / drilldown in UI
                    _rawTraders: []
                  };
                }

                const entry = usersMap[uid];
                entry._rawTraders.push(trader);

                const accountType = trader.TATD || {};
                const isReal = accountType.Type === 1;

                if (isReal) {
                  entry.hasRealAccounts = true;
                  entry.isDemo = false;
                  // Aggregate financials across ALL real trading accounts for this user
                  const depAmt = trader.DepositsAmount || 0;
                  const eqAmt = trader.E || 0;
                  const balAmt = trader.BAL || 0;
                  console.log(`  [${entry.username}] Adding REAL account ID=${trader.I}:`);
                  console.log(`    -> DepositsAmount=${depAmt}, Equity=${eqAmt}, Balance=${balAmt}`);
                  console.log(`    -> Raw trader keys:`, Object.keys(trader).join(', '));
                  entry.deposit += depAmt;
                  entry.depositTimes += (trader.DepositTimes || 0);
                  entry.equity += eqAmt;
                  entry.balance += balAmt;
                  entry.availableBalance += (trader.ABAL || 0);
                  entry.closedPL += (trader.CPL || 0);
                  entry.openPL += (trader.OPL || 0);
                  // Note: lots cannot be summed from trading accounts; they must come from closed trades (VU field)
                  // We'll leave lots=0 here and compute it from trade history later
                  // Store account ID for later deposit fetching
                  if (!entry._accountIds) entry._accountIds = [];
                  entry._accountIds.push(trader.I);
                }
              });

              const deduped = Object.keys(usersMap).map(k => {
                const u = usersMap[k];
                // Determine KYC by preferring explicit user.Approved when present,
                // otherwise fall back to trading-account flag `A` if any trader reports it.
                const raw = u._rawTraders || [];
                const firstTrader = raw[0] || {};
                const userObj = firstTrader.T || {};

                let approved = false;
                let kycSource = null;

                if (typeof userObj.Approved !== 'undefined') {
                  approved = (userObj.Approved === true || userObj.Approved === 'true');
                  kycSource = 'user.Approved';
                } else if (raw.some(t => t.A === true)) {

                  approved = true;
                  kycSource = 'trader.A';
                } else {
                  approved = false;
                  kycSource = 'none';
                }

                u.approved = !!approved;
                u.kycStatus = approved ? 'Approved' : 'Pending';
                u._kycSource = kycSource;

                // Country: prefer explicit country fields if present, otherwise use Company name
                u.country = (userObj.CountryName || userObj.Country || (userObj.Company && userObj.Company.Name) || 'Unknown');
                u.countryCode = (userObj.CountryIsoCode || userObj.CountryCode || '');

                // Ensure lots is numeric (will be populated from trade history)
                u.lots = u.lots || 0;

                return u;
              });

              // Log final aggregation summary for each user
              console.log('=== CLIENT AGGREGATION SUMMARY ===');
              deduped.forEach(u => {
                console.log(`User: ${u.username}`);
                console.log(`  Net Deposit (from DepositsAmount): $${u.deposit.toFixed(2)}`);
                console.log(`  Equity (sum of E fields): $${u.equity.toFixed(2)}`);
                console.log(`  Balance (sum of BAL fields): $${u.balance.toFixed(2)}`);
                console.log(`  Account IDs: ${(u._accountIds || []).join(', ')}`);
              });
              console.log('=== END SUMMARY ===');

              return deduped;
            }
          }
        }
      } catch (tradersErr) {
        console.error("Traders endpoint also failed:", tradersErr.message);
      }
    }
    
    if (clients.length === 0) {
      console.warn("⚠️ No clients returned. This could mean:");
      console.warn("   1. Your IB account has no referred clients yet");
      console.warn("   2. Your IB permissions don't allow viewing clients");
      console.warn("   3. Contact your broker admin to verify IB setup");
      return [];
    }
    
    // Debug: Log first client's raw data to see actual field names
    console.log("First client raw data:", clients[0]);
    console.log("Available fields:", Object.keys(clients[0]));

    return clients.map(client => ({
      id: client.Id,
      username: client.UserName,
      name: `${client.FirstName || ''} ${client.LastName || ''}`.trim() || client.Email || 'Unknown',
      firstName: client.FirstName,
      lastName: client.LastName,
      email: client.Email || '',
      phone: client.PhoneNumber || '',
      kycStatus: client.Approved ? "Approved" : "Pending",
      approved: client.Approved,
      emailConfirmed: client.EmailConfirmed,
      phoneConfirmed: client.PhoneNumberConfirmed,
      country: client.CountryName || "Unknown",
      countryCode: client.CountryIsoCode,
      deposit: client.DepositsAmount || 0,
      depositTimes: client.DepositTimes || 0,
      // Note: equity and lots require separate API calls to trading accounts/trades
      equity: 0,                   // Will be populated from trading accounts if needed
      lots: 0,                     // Will be populated from trades if needed
      risk: "N/A",                 // Calculate based on equity vs deposit
      lastActive: client.LastLogin || "Never",
      status: client.StatusString || (client.Approved ? "Active" : "Pending"),
      statusCode: client.Status,
      role: client.Role,
      accessRoles: client.AccessRoles,
      referralCode: client.ReferralCode,
      referrer: client.Referrer,
      partner: client.Partner,
      partnerId: client.PartnerId,
      companyId: client.CompanyId,
      companyName: client.CompanyName,
      language: client.Language,
      registration: client.Registration,
      lastLogin: client.LastLogin,
      approvedDate: client.ApprovedDate,
      createdBy: client.CreatedBy,
      createdOn: client.CreatedOn,
      modifiedBy: client.ModifiedBy,
      modifiedOn: client.ModifiedOn,
      lastComment: client.LastComment,
      lastCommentDate: client.LastCommentDate,
      twoFactor: client.TwoFactor,
      resetPasswordPending: client.ResetPasswordPending
    }));
  } catch (error) {
    console.error("Fetch Clients Error:", error);
    return [];
  }
};
/**
 * Fetch client's trades (open, pending, closed, cancelled)
 * Uses correct XValley Backoffice API topics and message format
 * Returns: Array of trade objects
 */
export const fetchClientTrades = async (tradingAccountId = null, tradeType = 'open') => {
  try {
    const session = await getSession();
    
    // Map trade types to correct XValley topic names
    const topicMap = {
      'open': API_CONFIG.TOPICS.PLATFORM_OPEN,
      'pending': API_CONFIG.TOPICS.PLATFORM_PENDING,
      'closed': API_CONFIG.TOPICS.PLATFORM_CLOSE,
      'cancelled': API_CONFIG.TOPICS.PLATFORM_CANCEL
    };
    
    const topic = topicMap[tradeType] || API_CONFIG.TOPICS.PLATFORM_OPEN;
    
    // Build filters if tradingAccountId is provided
    const filters = tradingAccountId ? [{
      Filter: String(tradingAccountId),
      FilterComparison: 1,         // NumberEquals
      FilterType: "TraderAccountId",
      FilterValueType: 2           // Number
    }] : [];
    
    // XValley backoffice message format for trades
    const msg = { 
      MessageType: 100,
      From: "",                    // Date filter - empty for all
      To: "",                      // Date filter - empty for all
      Filters: filters,
      AdminType: 205,              // Trades admin type
      Sort: "Id desc",
      Skip: 0,
      PageSize: 500,
      AccountType: "12"            // 1=real, 2=demo, 12=all
    };

    console.log(`Fetching ${tradeType} trades with topic:`, topic);
    const result = await session.call(topic, [JSON.stringify(msg)]);
    
    // Parse result - it comes as JSON string
    let data = result;
    if (typeof result === 'string') {
      data = JSON.parse(result);
    }
    
    if (!data || !data.Messages) return [];

    return data.Messages.map(trade => ({
      id: trade.Ticket || trade.Id,
      tradingAccountId: trade.TraderAccountId,
      accountName: trade['TA.Name'] || trade.AccountName,
      username: trade['TA.T.A'] || trade.Username,
      symbol: trade['Instrument.Name'] || trade.Instrument?.Name || trade.Symbol || "UNKNOWN",
      type: trade.Side === 1 ? 'Buy' : 'Sell',
      tradeTypeName: trade.TTN || (trade.Side === 1 ? 'Buy' : 'Sell'),
      volume: trade.VU || trade.Volume || 0,
      openPrice: trade.EP || trade.OpenPrice || 0,
      requestedPrice: trade.RP || 0,
      closePrice: trade.CEP || trade.ClosePrice || 0,
      openTime: trade.EDT || trade.OpenTime || new Date(),
      closeTime: trade.CEDT || trade.CloseTime,
      profit: trade.PL || trade.Profit || 0,
      commission: trade.Commission || 0,
      interest: trade.Interest || 0,
      status: trade.ESS || trade.ExecutionState || "Open",
      sl: trade.SL || 0,
      tp: trade.SP || 0,
      marginUsed: trade.Col || 0,
      expiry: trade.EX || null,
      payout: trade.PO || 0
    }));
  } catch (error) {
    console.error(`Fetch ${tradeType} Trades Error:`, error);
    return [];
  }
};

/**
 * Fetch trading accounts for a user
 * Uses com.fxplayer.traders with correct XValley message format
 * Returns: Array of trading account objects
 */
export const fetchTradingAccounts = async (username = null) => {
  try {
    const session = await getSession();
    
    // Build filters if username is provided
    const filters = username ? [{
      Filter: username,
      FilterComparison: 2,        // TextEquals
      FilterType: "Trader.Alias", // T.A
      FilterValueType: 1          // Text
    }] : [];
    
    // XValley backoffice message format for trading accounts
    const msg = { 
      MessageType: 100,
      Filters: filters,
      AdminType: 8,               // Trading accounts admin type
      Sort: "Id asc",
      AccountType: "12"           // 1=real, 2=demo, 12=all
    };

    console.log("Fetching trading accounts...");
    const result = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
    
    // Parse result
    let data = result;
    if (typeof result === 'string') {
      data = JSON.parse(result);
    }
    
    if (!data || !data.Messages || data.Messages.length === 0) {
      return [];
    }

    return data.Messages.map(account => ({
      id: account.Id,
      username: account['T.A'] || account.Username,
      name: account.Name,
      type: account['TATD.Name'] || account.Type,
      level: account.TAL || account.Level,
      book: account.B || account.Book,
      active: account.A || account.Active,
      depositsAmount: account.DepositsAmount || 0,
      bonus: account.BA || account.Bonus || 0,
      credit: account.CR || account.Credit || 0,
      equity: account.E || account.Equity || 0,
      balance: account.BAL || account.Balance || 0,
      closedPL: account.CPL || 0,
      currency: account['Cur.Name'] || account.Currency || "USD",
      displayCurrency: account['DCur.Name'] || account.DisplayCurrency,
      marginUsed: account.UC || account.MarginUsed || 0,
      marginLevel: account.MCL || account.MarginLevel || 0,
      marginAmount: account.MC || 0,
      stopoutLevel: account.SOL || 0,
      stopoutAmount: account.SO || 0,
      forexLeverage: account.FL || 100,
      metalsLeverage: account.ML || 100,
      energyLeverage: account.EL || 100,
      indicesLeverage: account.IL || 100,
      stocksLeverage: account.SL || 100,
      cryptoLeverage: account.CRL || 100,
      external: account.EXI || false,
      mam: account.MAM || false,
      leader: account.LEA || false,
      funded: account.FUA || false,
      expiration: account.Expiration,
      companyId: account['T.CompanyId']
    }));
  } catch (error) {
    console.error("Fetch Trading Accounts Error:", error);
    return [];
  }
};

/**
 * Fetch single client's account info (alias for fetchTradingAccounts with single result)
 */
export const fetchClientAccount = async (username) => {
  try {
    const accounts = await fetchTradingAccounts(username);
    return accounts.length > 0 ? accounts[0] : null;
  } catch (error) {
    console.error("Fetch Account Error:", error);
    return null;
  }
};

/**
 * Fetch all transactions (deposits/withdrawals) for a trading account
 * Uses com.fxplayer.deposits with correct XValley message format
 * Returns: Array of transaction objects
 */
export const fetchClientTransactions = async (tradingAccountId = null) => {
  try {
    const session = await getSession();
    
    // Build filters if tradingAccountId is provided
    const filters = tradingAccountId ? [{
      Filter: String(tradingAccountId),
      FilterComparison: 1,           // NumberEquals
      FilterType: "TraderAccountId",
      FilterValueType: 2             // Number
    }] : [];
    
    // XValley backoffice message format for deposits
    const msg = { 
      MessageType: 100,
      From: "",                      // Date filter - empty for all
      To: "",                        // Date filter - empty for all
      Filters: filters,
      AdminType: 100,                // Deposits admin type
      Sort: "Id desc",
      Skip: 0,
      PageSize: 500,
      AccountType: "12"              // 1=real, 2=demo, 12=all
    };

    console.log("Fetching transactions (deposits/withdrawals) for account:", tradingAccountId);
    const result = await session.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
    
    // Parse result
    let data = result;
    if (typeof result === 'string') {
      data = JSON.parse(result);
    }
    
    // Debug: log raw response
    if (data && data.Messages) {
      console.log(`  -> Deposits endpoint returned ${data.Messages.length} records for account ${tradingAccountId}`);
    } else {
      console.log(`  -> Deposits endpoint returned no Messages for account ${tradingAccountId}. Response keys:`, data ? Object.keys(data) : 'null');
    }
    
    if (!data || !data.Messages) return [];

    return data.Messages.map(txn => ({
      id: txn.Id,
      tradingAccountId: txn.TraderAccountId || txn.TrId,
      username: txn['TrA.T.A'] || txn.Username,
      accountName: txn['TrA.Name'] || txn.AccountName,
      sendAmount: txn.TA || txn.SendAmount || 0,
      depositedAmount: txn.AA || txn.DepositedAmount || 0,
      referenceAmount: txn.DA || txn.ReferenceAmount || 0,
      conversionRate: txn.R || txn.ConversionRate || 1,
      date: txn.D || txn.Date || new Date(),
      type: txn.TSN || txn.Type || "Unknown",
      typeName: txn.TSN || "Unknown",
      side: txn.TS,  // 1=Deposit, 2=Withdrawal, 3=Adjustment (per XValley Appendix D)
      sideLabel: txn.TS === 1 ? 'Deposit' : txn.TS === 2 ? 'Withdrawal' : 'Adjustment',
      stateId: txn.St,  // 1=Pending, 2=Completed, 3=Cancelled, 4=Failed, 5=Deleted
      provider: txn['T.Name'] || txn.Provider || "Unknown",
      state: txn.StS || txn.State || "Pending",
      status: txn.StS || txn.Status || "Pending",
      fee: txn.F || txn.Fee || 0,
      invoice: txn.In || txn.Invoice || "",
      address: txn.BA || txn.Address || "",
      trxId: txn.IBAN || txn.TrxId || "",
      salesName: txn['TrA.T.Partner.Name'] || txn.SalesName || "",
      createdBy: txn.CreatedBy,
      createdOn: txn.CreatedOn,
      modifiedBy: txn.ModifiedBy,
      modifiedOn: txn.ModifiedOn,
      companyId: txn['TrA.T.CompanyId'],
      _raw: txn  // Keep raw for debugging
    }));
  } catch (error) {
    console.error("Fetch Transactions Error:", error);
    return [];
  }
};

/**
 * Fetch total equity for a user (sum of all trading accounts)
 * Gets equity from trading accounts data
 * Returns: Total equity value
 */
export const fetchClientEquity = async (username) => {
  try {
    const accounts = await fetchTradingAccounts(username);
    
    if (!accounts || accounts.length === 0) return 0;

    // Sum equity from all accounts
    return accounts.reduce((total, acc) => total + (acc.equity || 0), 0);
  } catch (error) {
    console.error("Fetch Equity Error:", error);
    return 0;
  }
};

// --- 4. Real-Time Subscription Functions ---

/**
 * Subscribe to account events (balance changes, trades, etc.)
 * Uses the session ID returned from PING for real-time updates
 */
export const subscribeToAccountEvents = (onAccountUpdate) => {
  try {
    const session = wsSession;
    if (!session || !wsSessionId) {
      console.warn("Not connected to WebSocket or missing session ID");
      return null;
    }

    // Subscribe to the session ID for real-time events
    session.subscribe(wsSessionId, (args) => {
      try {
        const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
        
        // Handle different message types from XValley
        if (msg.MessageType === 30) {
          // Trade event
          const payload = msg.Messages ? msg.Messages[0] : msg;
          const tsDate = extractTimestamp(msg);
          const tsIso = tsDate ? (tsDate instanceof Date ? tsDate.toISOString() : (typeof tsDate === 'string' ? tsDate : undefined)) : undefined;
          console.log('Account event - extracted timestamp:', tsIso, 'from msg:', msg);
          onAccountUpdate({
            type: 'trade',
            data: payload,
            raw: msg,
            timestamp: tsIso
          });
        } else if (msg.MessageType === 40) {
          // Account/Balance event
          const payload = msg.Messages ? msg.Messages[0] : msg;
          const tsDate = extractTimestamp(msg);
          const tsIso = tsDate ? (tsDate instanceof Date ? tsDate.toISOString() : (typeof tsDate === 'string' ? tsDate : undefined)) : undefined;
          console.log('Account event - extracted timestamp:', tsIso, 'from msg:', msg);
          onAccountUpdate({
            type: 'account',
            data: payload,
            raw: msg,
            timestamp: tsIso
          });
        } else if (msg.MessageType === 2) {
          // Logout/Connection event
          const tsDate = extractTimestamp(msg);
          const tsIso = tsDate ? (tsDate instanceof Date ? tsDate.toISOString() : (typeof tsDate === 'string' ? tsDate : undefined)) : undefined;
          console.log('Connection event - extracted timestamp:', tsIso, 'from msg:', msg);
          onAccountUpdate({
            type: 'connection',
            data: msg,
            raw: msg,
            timestamp: tsIso
          });
        }
      } catch (e) {
        console.error("Error processing account event:", e);
      }
    }).then((subscription) => {
      console.log("Subscribed to account events with session ID:", wsSessionId);
      return subscription;
    }).catch((err) => {
      console.error("Failed to subscribe to account events:", err);
    });
  } catch (e) {
    console.error("Account subscription error:", e);
  }
};

/**
 * Subscribe to real-time trade updates
 * Note: XValley sends all trade updates through the main session subscription
 * This function is deprecated in favor of subscribeToAccountEvents
 */
export const subscribeToTradeUpdates = (onTradeUpdate) => {
  try {
    const session = wsSession;
    if (!session || !wsSessionId) {
      console.warn("Not connected to WebSocket or missing session ID");
      return null;
    }

    // Subscribe to session ID for trade updates
    session.subscribe(wsSessionId, (args) => {
      try {
        const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
        
        // Filter for trade-related message types (30, 31, etc.)
        if (msg.MessageType === 30) {
          const payload = msg.Messages ? msg.Messages[0] : msg;
          const tsDate = extractTimestamp(msg);
          const tsIso = tsDate ? (tsDate instanceof Date ? tsDate.toISOString() : (typeof tsDate === 'string' ? tsDate : undefined)) : undefined;
          console.log('Trade event - extracted timestamp:', tsIso, 'from msg:', msg);
          onTradeUpdate({
            type: 'trade',
            data: payload,
            raw: msg,
            timestamp: tsIso
          });
        }
      } catch (e) {
        console.error("Error processing trade update:", e);
      }
    }).then((subscription) => {
      console.log("Subscribed to trade updates via session:", wsSessionId);
      return subscription;
    }).catch((err) => {
      console.error("Failed to subscribe to trade updates:", err);
    });
  } catch (e) {
    console.error("Trade subscription error:", e);
  }
};

/**
 * Subscribe to price updates for a specific instrument
 * Uses the Quotes WebSocket via autobahn
 */
export const subscribeToInstrumentPrices = (instrumentName, onPriceUpdate) => {
  try {
    const session = wsSession;
    if (!session) {
      console.warn("Not connected to WebSocket");
      return null;
    }

    // For price subscriptions, use the proper WAMP URI format
    // If you have a separate quotes endpoint, subscribe to it directly
    // Otherwise, prices may come through the main session subscription
    const subscriptionUri = instrumentName; // Use instrument name directly as WAMP URI
    
    session.subscribe(subscriptionUri, (args) => {
      try {
        const priceData = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
        onPriceUpdate({
          instrument: instrumentName,
          bid: priceData.Bid || priceData.bid || 0,
          ask: priceData.Ask || priceData.ask || 0,
          last: priceData.Last || priceData.last || 0,
          timestamp: new Date()
        });
      } catch (e) {
        console.error("Error processing price update:", e);
      }
    }).then((subscription) => {
      console.log("Subscribed to prices for:", instrumentName);
      return subscription;
    }).catch((err) => {
      console.error("Failed to subscribe to instrument prices:", err);
      // Prices may not be available through this subscription in your setup
    });
  } catch (e) {
    console.error("Price subscription error:", e);
  }
};

// --- 5. Additional Helper Functions ---

/**
 * Get contract specifications for an instrument
 */
export const getInstrumentContract = async (instrumentName) => {
  try {
    const session = await getSession();
    
    const msg = { 
      MessageType: 10,
      Messages: [{
        Name: instrumentName
      }]
    };

    const result = await session.call(API_CONFIG.TOPICS.CONTRACT, [JSON.stringify(msg)]);
    
    if (!result || !result.Messages || result.Messages.length === 0) {
      return null;
    }

    const contract = result.Messages[0];
    return {
      name: contract.Name || instrumentName,
      minVolume: contract.MinVolume || 0.01,
      maxVolume: contract.MaxVolume || 1000,
      stepVolume: contract.StepVolume || 0.01,
      digits: contract.Digits || 5,
      spread: contract.Spread || 0,
      swapBuy: contract.SwapBuy || 0,
      swapSell: contract.SwapSell || 0,
      marginRequired: contract.MarginRequired || 0,
      commission: contract.Commission || 0
    };
  } catch (error) {
    console.error("Get Contract Error:", error);
    return null;
  }
};

/**
 * Submit withdrawal request (async)
 */
export const submitWithdrawalRequest = async (clientId, amount, method) => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 50,
      Messages: [{
        ClientId: clientId,
        Amount: amount,
        Method: method,
        Date: new Date().toISOString()
      }]
    };

    const result = await session.call('com.fxplayer.withdraw', [JSON.stringify(msg)]);
    
    return {
      success: result && result.MessageType !== -3,
      message: result?.Messages?.[0] || "Withdrawal request submitted"
    };
  } catch (error) {
    console.error("Withdrawal Error:", error);
    return {
      success: false,
      message: error.message || "Withdrawal failed"
    };
  }
};

/**
 * Get deposits for a client
 */
export const fetchClientDeposits = async (clientId) => {
  try {
    const session = await getSession();
    
    // The Backoffice deposits call expects filters (e.g., TraderAccountId) for
    // server-side filtering. If `clientId` is numeric we treat it as a
    // TraderAccountId; otherwise we include it as ClientId (back-compat).
    const filters = [];
    if (clientId) {
      if (!isNaN(Number(clientId))) {
        filters.push({
          Filter: String(clientId),
          FilterComparison: 1,
          FilterType: "TraderAccountId",
          FilterValueType: 2
        });
      }
    }

    const msg = { 
      MessageType: 100,
      From: "",
      To: "",
      Filters: filters,
      PageSize: 500,
      Skip: 0,
      AdminType: 100,
      AccountType: "12"
    };

    const result = await session.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
    
    if (!result || !result.Messages) return [];

    return result.Messages.map(deposit => ({
      id: deposit.Id,
      clientId: deposit.ClientId,
      amount: deposit.Amount || 0,
      currency: deposit.Currency || "USD",
      method: deposit.Method || "Unknown",
      date: deposit.Date || new Date(),
      status: deposit.Status || "Completed",
      reference: deposit.Reference || ""
    }));
  } catch (error) {
    console.error("Fetch Deposits Error:", error);
    return [];
  }
};

/**
 * Disconnect WebSocket session
 */
export const disconnectWebSocket = () => {
  console.log("Disconnecting WebSocket...");
  
  // Close the connection (not the session)
  if (wsConnection) {
    try {
      wsConnection.close();
    } catch (e) {
      console.warn("Error closing connection:", e);
    }
    wsConnection = null;
  }
  
  wsSession = null;
  wsSessionId = null;
  connectionPromise = null;
  
  console.log("WebSocket disconnected");
};

// ============================================================
// ADDITIONAL INTEGRATIONS - Based on XValley Backoffice API
// ============================================================

/**
 * Fetch ALL transactions (deposits + withdrawals) for IB's clients
 * This is what populates the Withdrawals History in the dashboard
 * Uses com.fxplayer.deposits topic which returns all transaction types
 */
export const fetchAllTransactions = async (filters = {}) => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 100,
      From: filters.from || "",
      To: filters.to || "",
      Filters: filters.clientId ? [{
        Filter: filters.clientId,
        FilterComparison: 1,
        FilterType: "TraderAccountId",
        FilterValueType: 2
      }] : [],
      PageSize: filters.pageSize || 500,
      Sort: "Id desc",  // Sort by Id descending (most recent first)
      Skip: filters.skip || 0,
      AdminType: 100,
      AccountType: "1"  // Real accounts only
    };

    const result = await session.call('com.fxplayer.deposits', [JSON.stringify(msg)]);
    
    if (!result || !result.Messages) return [];

    return result.Messages.map(txn => ({
      id: txn.Id || txn.I,
      date: txn.D || txn.Date || new Date(),
      amount: txn.TA || txn.Amount || 0,
      depositedAmount: txn.AA || 0,
      method: getTransactionTypeName(txn.TId || txn.TypeId),
      status: getTransactionStateName(txn.St || txn.State),
      side: txn.TS === 1 ? 'Deposit' : txn.TS === 2 ? 'Withdrawal' : 'Adjustment',
      currency: txn.TCId || "USD",
      reference: txn.In || txn.Invoice || "",
      username: txn.Username || "",
      accountName: txn.Account || "",
      fee: txn.F || 0,
      createdBy: txn.CreatedBy || "",
      createdOn: txn.CreatedOn || ""
    }));
  } catch (error) {
    console.error("Fetch All Transactions Error:", error);
    return [];
  }
};

/**
 * Fetch withdrawal history specifically (filter by side = 2)
 */
export const fetchWithdrawalsHistory = async () => {
  try {
    const allTransactions = await fetchAllTransactions();
    // Filter for withdrawals only (side = 2)
    return allTransactions.filter(txn => txn.side === 'Withdrawal');
  } catch (error) {
    console.error("Fetch Withdrawals Error:", error);
    return [];
  }
};

// fetchTradingAccounts is already defined above at line ~403

/**
 * Save/Update user details (Admin action)
 * Uses com.fxplayer.lead topic
 */
export const saveUserDetails = async (userData) => {
  try {
    const session = await getSession();
    
    const data = {
      FirstName: userData.firstName,
      LastName: userData.lastName,
      Email: userData.email,
      Phone: userData.phone,
      Country: userData.countryCode,
      CompanyId: userData.companyId,
      Approved: userData.approved,
      EmailConfirmed: userData.emailConfirmed,
      PhoneConfirmed: userData.phoneConfirmed,
      Language: userData.language || "en"
    };

    const msg = {
      MessageType: 100,
      Messages: [data]
    };

    const result = await session.call('com.fxplayer.lead', [JSON.stringify(msg)]);
    
    return {
      success: result && result.MessageType === 200,
      message: result?.Messages?.[0] || (result.MessageType === 200 ? "User updated successfully" : "Update failed")
    };
  } catch (error) {
    console.error("Save User Error:", error);
    return { success: false, message: error.message };
  }
};

/**
 * Get account types available (Real/Demo)
 */
export const fetchAccountTypes = async () => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 100,
      PageSize: 100,
      Skip: 0
    };

    const result = await session.call('com.fxplayer.accounttypes', [JSON.stringify(msg)]);
    
    if (!result || !result.Messages) return [];

    return result.Messages.map(type => ({
      id: type.Id,
      name: type.Name,
      type: type.Type,
      leverage: type.Leverage,
      active: type.Active,
      deposit: type.Deposit
    }));
  } catch (error) {
    console.error("Fetch Account Types Error:", error);
    return [];
  }
};

/**
 * Get account levels/groups
 */
export const fetchAccountLevels = async () => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 100,
      PageSize: 100,
      Skip: 0
    };

    const result = await session.call('com.fxplayer.accountlevels', [JSON.stringify(msg)]);
    
    if (!result || !result.Messages) return [];

    return result.Messages.map(level => ({
      id: level.Id,
      name: level.Name,
      min: level.Min,
      max: level.Max,
      increment: level.Increment,
      commission: level.Commission,
      levelType: level.LevelType
    }));
  } catch (error) {
    console.error("Fetch Account Levels Error:", error);
    return [];
  }
};

/**
 * Get all countries (for user registration/updates)
 */
export const fetchCountries = async () => {
  try {
    const session = await getSession();
    const result = await session.call('com.fxplayer.GetCountries', ['']);
    
    if (!result || !result.Messages) return [];
    return result.Messages;
  } catch (error) {
    console.error("Fetch Countries Error:", error);
    return [];
  }
};

/**
 * Get companies/brands
 */
export const fetchCompanies = async () => {
  try {
    const session = await getSession();
    const result = await session.call('com.fxplayer.Companies', ['']);
    
    if (!result || !result.Messages) return [];
    return result.Messages;
  } catch (error) {
    console.error("Fetch Companies Error:", error);
    return [];
  }
};

/**
 * Create deposit/withdrawal transaction (Admin action)
 */
export const createTransaction = async (transactionData) => {
  try {
    const session = await getSession();
    
    const reqData = {
      TA: transactionData.amount,           // Transaction Amount
      AA: transactionData.accountAmount || transactionData.amount,  // Account Amount
      F: transactionData.fee || 0,          // Fee
      R: transactionData.rate || 1,         // Rate
      D: new Date().toISOString(),          // Date
      TId: transactionData.typeId || 1,     // Type (see Appendix A)
      TCId: transactionData.currencyId || 1, // Transaction Currency ID
      ACId: transactionData.accountCurrencyId || 1, // Account Currency ID
      St: transactionData.state || 2,       // State: 2 = Completed
      TrId: transactionData.tradingAccountId, // Trading Account ID
      In: transactionData.reference || "",  // Invoice/Reference
      TS: transactionData.side || 1         // Side: 1=Deposit, 2=Withdraw
    };

    const msg = {
      MessageType: 100,
      Username: transactionData.username,
      Messages: [reqData]
    };

    const result = await session.call('com.fxplayer.deposit', [JSON.stringify(msg)]);
    
    return {
      success: result && result.MessageType === 200,
      message: result?.Messages?.[0] || (result.MessageType === 200 ? "Transaction created" : "Transaction failed")
    };
  } catch (error) {
    console.error("Create Transaction Error:", error);
    return { success: false, message: error.message };
  }
};

/**
 * Get user communication history
 */
export const fetchUserCommunications = async (username) => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 100,
      PageSize: 100,
      Skip: 0,
      AdminType: 401,
      Username: username
    };

    const result = await session.call('com.fxplayer.contacts', [JSON.stringify(msg)]);
    
    if (!result || !result.Messages) return [];

    return result.Messages.map(comm => ({
      message: comm.Message,
      dateTime: comm.DateTime,
      type: comm.MessageTypeName,
      toTrader: comm.ToTrader,
      fromTrader: comm.FromTrader
    }));
  } catch (error) {
    console.error("Fetch Communications Error:", error);
    return [];
  }
};

/**
 * Reset user password (sends email)
 */
export const resetUserPassword = async (email) => {
  try {
    const session = await getSession();
    
    const msg = {
      MessageType: 100,
      Messages: [{ Email: email }]
    };

    const result = await session.call('com.fxplayer.resetpassword', [JSON.stringify(msg)]);
    
    return {
      success: result && result.MessageType === 200,
      message: result.MessageType === 200 ? "Password reset email sent" : "Reset failed"
    };
  } catch (error) {
    console.error("Reset Password Error:", error);
    return { success: false, message: error.message };
  }
};

/**
 * Subscribe to real-time system alerts/notifications
 * Maps WebSocket events to UI-friendly alert objects
 */
let alertCallbacks = [];
export const subscribeToSystemAlerts = (onAlert) => {
  alertCallbacks.push(onAlert);
  
  // Subscribe to account events and map them to alerts
  subscribeToAccountEvents((event) => {
    let alert = null;
    
    switch (event.type) {
      case 'trade':
        const trade = event.data;
        const tradeTs = event && event.timestamp ? event.timestamp : (trade && (trade.CEDT || trade.EDT || trade.CreatedOn || trade.ModifiedOn));
        let tradeTsIso;
        if (tradeTs instanceof Date) tradeTsIso = tradeTs.toISOString();
        else if (typeof tradeTs === 'number') tradeTsIso = (tradeTs > 1e12 ? new Date(tradeTs) : new Date(tradeTs * 1000)).toISOString();
        else if (typeof tradeTs === 'string' && !isNaN(Date.parse(tradeTs))) tradeTsIso = tradeTs;
        else tradeTsIso = undefined;

        alert = {
          id: Date.now(),
          title: trade.Side === 1 ? "New Buy Trade" : "New Sell Trade",
          msg: `${trade.Instrument?.Name || 'Trade'} - Volume: ${trade.Volume || trade.VU}`,
          type: trade.Profit > 0 ? "success" : "info",
          timestamp: tradeTsIso
        };
        break;
        
      case 'account':
        const acc = event.data;
        if (acc.Balance !== undefined) {
          const accTs = event && event.timestamp ? event.timestamp : (acc && (acc.ModifiedOn || acc.CreatedOn || acc.Date));
          let accTsIso;
          if (accTs instanceof Date) accTsIso = accTs.toISOString();
          else if (typeof accTs === 'number') accTsIso = (accTs > 1e12 ? new Date(accTs) : new Date(accTs * 1000)).toISOString();
          else if (typeof accTs === 'string' && !isNaN(Date.parse(accTs))) accTsIso = accTs;
          else accTsIso = undefined;

          alert = {
            id: Date.now(),
            title: "Balance Update",
            msg: `Account balance changed to $${acc.Balance?.toFixed(2) || 0}`,
            type: "info",
            timestamp: accTsIso
          };
        }
        break;
        
      case 'connection':
        if (event.data.MessageType === 2) {
          alert = {
            id: Date.now(),
            title: "Connection Event",
            msg: "Session status changed",
            type: "warning",
            time: "Just now"
          };
        }
        break;
    }
    
    if (alert) {
      alertCallbacks.forEach(cb => cb(alert));
    }
  });
};

// --- Helper Functions for Transaction Types ---
function getTransactionTypeName(typeId) {
  const types = {
    1: "Bank Wire", 2: "Neteller", 3: "PayPal", 4: "Skrill",
    5: "Bitcoin", 6: "Card", 7: "Demo", 9: "Bonus",
    11: "Credit Card", 13: "Internal", 26: "External",
    34: "Ethereum", 35: "Tether", 37: "Credit",
    42: "Ripple", 44: "USDC", 45: "Tron", 46: "USDT TRC20"
  };
  return types[typeId] || "Other";
}

function getTransactionStateName(stateId) {
  const states = {
    1: "Pending", 2: "Completed", 3: "Cancelled",
    4: "Failed", 5: "Deleted"
  };
  return states[stateId] || "Unknown";
}

// --- Helper: Extract Timestamp From Incoming WAMP Message ---
const extractTimestamp = (msg) => {
  try {
    const payload = msg && msg.Messages ? (Array.isArray(msg.Messages) ? msg.Messages[0] : msg.Messages) : msg;

    // If payload is primitive, bail out
    if (!payload || typeof payload !== 'object') return null;

    // Quick candidates for well-known fields
    const quick = ['CEDT','EDT','D','Date','CreatedOn','ModifiedOn','Time','Timestamp','ts','DED','Created','CreatedDate','Modified','RDT','CloseDate','OpenTime'];
    for (const key of quick) {
      const v = payload[key];
      if (!v) continue;
      if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
      if (typeof v === 'string' && !isNaN(Date.parse(v))) return new Date(Date.parse(v));
    }

    // Scan all keys for any date-like field name and attempt to parse
    const keys = Object.keys(payload);
    const dateKeyRegex = /(date|time|dt|cedt|ced|edt|created|modified|ts|timestamp|ded|rdt|close|open)/i;
    for (const k of keys) {
      if (!dateKeyRegex.test(k)) continue;
      const v = payload[k];
      if (!v) continue;
      if (typeof v === 'number') return new Date(v > 1e12 ? v : v * 1000);
      if (typeof v === 'string' && !isNaN(Date.parse(v))) return new Date(Date.parse(v));
    }

    // Check nested arrays/objects (common wrapper.Messages[0].Messages[0])
    for (const k of keys) {
      const v = payload[k];
      if (!v) continue;
      if (Array.isArray(v) && v.length > 0) {
        const nested = v[0];
        if (nested && typeof nested === 'object') {
          const nestedTs = extractTimestamp({ Messages: [nested] });
          if (nestedTs) return nestedTs;
        }
      } else if (v && typeof v === 'object') {
        const nestedTs = extractTimestamp({ Messages: [v] });
        if (nestedTs) return nestedTs;
      }
    }
  } catch (e) {
    // ignore and fall through
  }
  return null;
};

/**
 * Fetch closed trades history from XValley
 * Returns trade data with execution dates and volumes for chart visualization
 * @param {string} fromDate - Start date in YYYY-MM-DD format
 * @param {string} toDate - End date in YYYY-MM-DD format
 * @param {string} accountType - "1" for real, "2" for demo, "12" for all
 */
export const fetchTradeHistory = async (fromDate, toDate, accountType = "1", clientUsernames = null) => {
  try {
    console.log(`Fetching trade history from ${fromDate} to ${toDate}${clientUsernames ? ` for ${clientUsernames.length} clients` : ''}`);
    const session = await getSession();

    // Determine if caller provided numeric account IDs (so we can use numeric filters server-side)
    let isAccountId = clientUsernames && Array.isArray(clientUsernames) && clientUsernames.length > 0 && clientUsernames.every(v => !isNaN(Number(v)));

    // If caller provided non-numeric trader aliases, try resolving them to
    // numeric TraderAccountId values using `fetchTradingAccounts`. Querying by
    // account id is more reliable for the trades endpoint and avoids server
    // runtime errors when using nested property filters like 'Trader.Alias'.
    if (!isAccountId && clientUsernames && Array.isArray(clientUsernames) && clientUsernames.length > 0) {
      try {
        console.log(`Resolving ${clientUsernames.length} trader aliases to account IDs (bulk)...`);

        // Try to bulk-fetch trading accounts for current partner/session to build a mapping
        const partnerId = sessionPartnerId || getSessionPartnerId();
        const allAccounts = await fetchAllTradingAccounts(partnerId);

        if (allAccounts && allAccounts.length > 0) {
          const aliasMap = new Map();
          allAccounts.forEach(a => {
            if (a.username) aliasMap.set(String(a.username).toLowerCase(), String(a.id));
          });

          const resolvedIds = new Set();
          for (const alias of clientUsernames) {
            const key = String(alias || '').toLowerCase();
            if (aliasMap.has(key)) {
              resolvedIds.add(aliasMap.get(key));
            } else if (!isNaN(Number(alias))) {
              // If the alias already looks numeric, include it directly
              resolvedIds.add(String(Number(alias)));
            }
          }

          if (resolvedIds.size > 0) {
            clientUsernames = Array.from(resolvedIds);
            isAccountId = true;
            console.log(`Resolved aliases -> ${clientUsernames.length} account IDs (bulk)`);
          } else {
            console.log('No account IDs resolved from bulk traders; will NOT use nested alias filters (they cause server errors) and will attempt paged queries without alias filters');
          }
        } else {
          console.log('Bulk traders fetch returned no accounts; skipping alias resolution');
        }
      } catch (e) {
        console.warn('Alias resolution (bulk) failed:', e && e.message ? e.message : e);
      }
    }

    // Use paginated requests to avoid single long-running call that times out
    const pageSize = 200; // smaller page to reduce server work per-call
    let allTrades = [];

    // If caller passed many numeric account IDs, avoid sending a huge Filters
    // array (which can trigger server runtime errors). Instead, query per
    // account with limited concurrency, retries and a longer timeout.
    const PER_ACCOUNT_THRESHOLD = 40;
    if (isAccountId && clientUsernames && clientUsernames.length > PER_ACCOUNT_THRESHOLD) {
      console.log(`Large account list (${clientUsernames.length}) - fetching per-account with concurrency to avoid server filter overload`);

      const concurrency = 5; // number of accounts to fetch in parallel
      const perPageTimeout = 60000; // 60s per-page timeout
      const perPageRetries = 2; // retry each page this many times before giving up
      const perAccountPageSize = 100; // smaller page for per-account queries

      const fetchAccountPages = async (id) => {
        const collected = [];
        let pageIndex = 0;
        while (pageIndex < 50) {
          const filters = [{
            Filter: String(id),
            FilterComparison: 1,
            FilterType: "TraderAccountId",
            FilterValueType: 2
          }];

          const msg = {
            MessageType: 100,
            From: fromDate,
            To: toDate,
            Filters: filters,
            AdminType: 205,
            Sort: "Id asc",
            AccountType: accountType,
            Skip: pageIndex * perAccountPageSize,
            PageSize: perAccountPageSize
          };

          console.log(`Per-account trade request for ${id} page ${pageIndex}`);

          // retry loop for this page
          let lastErr = null;
          let parsed = null;
          for (let attempt = 1; attempt <= perPageRetries; attempt++) {
            const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Trade history request timed out')), perPageTimeout));
            try {
              let result = await Promise.race([
                session.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]),
                timeoutPromise
              ]);
              if (typeof result === 'string') {
                try { parsed = JSON.parse(result); } catch (e) { parsed = null; console.warn('Failed to parse page result as JSON'); }
              } else parsed = result;

              if (parsed && parsed.Messages) {
                break; // success
              }
            } catch (err) {
              lastErr = err;
              console.warn(`Attempt ${attempt} failed for account ${id} page ${pageIndex}:`, err && (err.message || err));
              // short backoff before retrying
              await new Promise(r => setTimeout(r, 500 * attempt));
            }
          }

          if (!parsed || !parsed.Messages) {
            console.error(`Giving up on account ${id} page ${pageIndex} after ${perPageRetries} attempts:`, lastErr && (lastErr.message || lastErr));
            break; // stop paging this account
          }

          let trades = parsed.Messages;
          if (trades.length > 0 && trades[0].Messages) {
            trades = trades[0].Messages;
          }

          // Annotate each trade with the account ID we queried by (in case it's not in the trade object)
          if (trades && trades.length > 0) {
            trades = trades.map(t => ({ ...t, _queriedAccountId: id }));
          }

          collected.push(...(trades || []));
          if (!trades || trades.length < perAccountPageSize) break;
          pageIndex += 1;
        }

        return collected;
      };

      // process accounts in batches to limit concurrent calls
      for (let i = 0; i < clientUsernames.length; i += concurrency) {
        const batch = clientUsernames.slice(i, i + concurrency);
        const promises = batch.map(id => fetchAccountPages(id).catch(e => { console.warn(`Account ${id} failed:`, e && (e.message || e)); return []; }));
        const results = await Promise.all(promises);
        results.forEach(r => { if (r && r.length) allTrades = allTrades.concat(r); });
      }

      console.log(`✅ Collected ${allTrades.length} closed trades total (per-account mode)`);
    } else {
      let pageIndex = 0;
      const maxPages = 20; // safety limit (200 * 20 = 4000 records)
      while (pageIndex < maxPages) {
        // Build filters to limit server-side work when clientUsernames provided
        const filters = [];
        if (clientUsernames && Array.isArray(clientUsernames) && clientUsernames.length > 0) {
          // If we don't have numeric account ids, try to pick numeric candidates
          if (!isAccountId) {
            const numericCandidates = clientUsernames.filter(u => !isNaN(Number(u)));
            if (numericCandidates.length > 0) {
              clientUsernames = numericCandidates;
              isAccountId = true;
              console.log(`Converted ${numericCandidates.length} username(s) to numeric account IDs for filtering`);
            } else {
              // Avoid building nested 'Trader.Alias' filters that cause server runtime errors
              console.warn('Skipping nested alias filters (they cause server errors). Querying without client filters.');
              clientUsernames = null; // clear to avoid building alias filters below
            }
          }

          if (clientUsernames && isAccountId) {
            const batch = clientUsernames.slice(0, 500);
            batch.forEach(id => {
              filters.push({
                Filter: String(id),
                FilterComparison: 1,   // NumberEquals
                FilterType: "TraderAccountId",
                FilterValueType: 2
              });
            });
          }
        }

        const msg = {
          MessageType: 100,
          From: fromDate,
          To: toDate,
          Filters: filters,
          AdminType: 205,
          Sort: "Id asc",
          AccountType: accountType,
          Skip: pageIndex * pageSize,
          PageSize: pageSize
        };

        console.log("Trade history page request:", { pageIndex, pageSize, filters: filters.length });

        // Per-request timeout (30s) to fail fast and continue with partial data
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Trade history request timed out')), 30000));

        let result;
        try {
          result = await Promise.race([
            session.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]),
            timeoutPromise
          ]);
        } catch (err) {
          console.error(`Error fetching trades page ${pageIndex}:`, err && err.args ? err.args : (err.message || err));
          // Break on timeout/error to return whatever we have collected so far
          break;
        }

        let parsed = result;
        if (typeof result === 'string') {
          try { parsed = JSON.parse(result); } catch (e) { console.warn('Failed to parse page result as JSON'); }
        }

        if (!parsed || !parsed.Messages) break;

        // Extract nested messages if present
        let trades = parsed.Messages;
        if (trades.length > 0 && trades[0].Messages) {
          trades = trades[0].Messages;
        }

        console.log(`Received ${trades.length} trades on page ${pageIndex}`);

        allTrades = allTrades.concat(trades || []);

        // If fewer results than pageSize, we've reached the end
        if (!trades || trades.length < pageSize) break;

        pageIndex += 1;
      }

      console.log(`✅ Collected ${allTrades.length} closed trades total`);
    }

    if (allTrades.length === 0) return [];

    // Map trades to a simplified format for charting
    let mappedTrades = allTrades.map(trade => {
      // Extract username from nested structure (XValley format: TA.T.A)
      const rawUsername = trade.TA?.T?.A || trade['TA.T.A'] || trade['TA']?.['T']?.['A'] || null;
      const rawAccountId = trade.TraderAccountId || trade.TA?.I || trade['TA.I'] || trade['TA']?.['I'] || trade._queriedAccountId || null;
      
      return {
        id: trade.Ticket || trade.I || trade.Id,
        instrument: trade.Instrument?.Name || trade['Instrument.Name'] || 'Unknown',
        traderUsername: rawUsername || 'Unknown',
        traderAccountId: rawAccountId,
        traderAccountName: trade.TA?.Name || trade['TA.Name'] || '',
        side: trade.S === 1 ? 'Buy' : 'Sell',
        volume: trade.VU || trade.Volume || 0,
        openPrice: trade.EP || trade.OpenPrice || 0,
        closePrice: trade.CEP || trade.ClosePrice || 0,
        profitLoss: trade.PL || 0,
        commission: trade.Commission || 0,
        interest: trade.Interest || 0,
        openDate: trade.EDT || trade.OpenTime || '',
        closeDate: trade.CEDT || trade.CloseDate || trade.EDT || '',
        status: trade.ESS || trade.ExecutionState || '',
        _raw: trade  // Keep raw for debugging
      };
    });

    // If caller provided clientUsernames: only perform client-side username filtering
    // when the caller passed non-numeric trader aliases. If numeric account IDs
    // were passed, server-side filters already applied and no extra filtering is needed.
    if (clientUsernames) {
      if (clientUsernames.length === 0) {
        console.log("No clients to filter trades by, returning empty array");
        return [];
      } else if (!isAccountId) {
        const usernameSet = new Set(clientUsernames);
        const before = mappedTrades.length;
        mappedTrades = mappedTrades.filter(trade => usernameSet.has(trade.traderUsername));
        console.log(`Filtered trades from ${before} to ${mappedTrades.length} for IB clients (by alias)`);
      }
    }

    return mappedTrades;
  } catch (error) {
    console.error("Error fetching trade history:", error.message || error);
    return [];
  }
};

/**
 * Fetch aggregated trade volume for a time range
 * Groups trades by time intervals for chart display
 * @param {string} timeRange - "Today", "This Week", "This Month", etc.
 */
export const fetchVolumeHistory = async (timeRange = 'This Month', clientUsernames = null) => {
  const now = new Date();
  let fromDate, toDate;
  
  // Calculate date range based on timeRange
  switch (timeRange) {
    case 'Today':
      fromDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      toDate = now;
      break;
    case 'This Week':
      fromDate = new Date(now);
      fromDate.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
      fromDate.setHours(0, 0, 0, 0);
      toDate = now;
      break;
    case 'This Month':
      fromDate = new Date(now.getFullYear(), now.getMonth(), 1);
      toDate = now;
      break;
    case 'This Quarter':
      const qMonth = Math.floor(now.getMonth() / 3) * 3;
      fromDate = new Date(now.getFullYear(), qMonth, 1);
      toDate = now;
      break;
    case 'This Year':
      fromDate = new Date(now.getFullYear(), 0, 1);
      toDate = now;
      break;
    case 'Lifetime':
    default:
      // Go back 5 years for lifetime
      fromDate = new Date(now.getFullYear() - 5, 0, 1);
      toDate = now;
  }
  
  const formatDate = (d) => d.toISOString().split('T')[0];
  
  const trades = await fetchTradeHistory(formatDate(fromDate), formatDate(toDate), "12", clientUsernames);

  const totalVolume = trades.reduce((sum, t) => sum + (parseFloat(t.volume || t.VU || 0) || 0), 0);
  const totalPL = trades.reduce((sum, t) => sum + (parseFloat(t.profitLoss || t.PL || 0) || 0), 0);
  const revenue = trades.reduce((sum, t) => {
    const instrumentKey = (t.instrument || (t.Instrument && t.Instrument.Name) || 'default');
    const rate = COMMISSION_RATES[instrumentKey] || COMMISSION_RATES['default'] || 5;
    const vol = parseFloat(t.volume || t.VU || 0) || 0;
    return sum + (vol * rate);
  }, 0);
  
  console.log(`Volume History: ${trades.length} trades for ${timeRange}, totalVolume=${totalVolume.toFixed(2)}, totalPL=${totalPL.toFixed(2)}, revenue=${revenue.toFixed(2)}`);
  
  return {
    trades,
    fromDate,
    toDate,
    totalVolume,
    totalPL,
    revenue
  };
};

/**
 * Compute net deposits (deposits - withdrawals) for given accounts or time range
 * @param {string} fromDate - YYYY-MM-DD (optional)
 * @param {string} toDate - YYYY-MM-DD (optional)
 * @param {Array<number>|null} accountIds - array of numeric TraderAccountId to restrict to (optional)
 */
export const fetchNetDeposits = async (fromDate = '', toDate = '', accountIds = null) => {
  try {
    let allTxns = [];

    if (Array.isArray(accountIds) && accountIds.length > 0) {
      // Fetch transactions per account (server supports TraderAccountId numeric filter)
      for (const id of accountIds) {
        try {
          const txns = await fetchClientTransactions(id);
          allTxns = allTxns.concat(txns || []);
        } catch (e) {
          console.warn(`Failed to fetch transactions for account ${id}:`, e.message || e);
        }
      }
    } else {
      // Fetch all transactions in the range (may be heavier)
      const filters = { from: fromDate, to: toDate };
      allTxns = await fetchAllTransactions(filters);
    }

    // Optionally filter by date range if provided
    const fromTs = fromDate ? new Date(fromDate) : null;
    const toTs = toDate ? new Date(toDate) : null;
    if (fromTs || toTs) {
      allTxns = allTxns.filter(t => {
        const d = new Date(t.date);
        if (fromTs && d < fromTs) return false;
        if (toTs && d > toTs) return false;
        return true;
      });
    }

    // Aggregate by currency
    // Note: side is numeric (1=Deposit, 2=Withdrawal, 3=Adjustment) or string label
    const totalsByCurrency = {};
    allTxns.forEach(t => {
      const cur = t.currency || 'USD';
      if (!totalsByCurrency[cur]) totalsByCurrency[cur] = { deposits: 0, withdrawals: 0, net: 0 };
      const amt = parseFloat(t.depositedAmount || t.amount || 0) || 0;
      // Check both numeric and string side values
      const isDeposit = t.side === 1 || t.side === 'Deposit' || t.sideLabel === 'Deposit';
      const isWithdrawal = t.side === 2 || t.side === 'Withdrawal' || t.sideLabel === 'Withdrawal';
      
      if (isDeposit) totalsByCurrency[cur].deposits += amt;
      else if (isWithdrawal) totalsByCurrency[cur].withdrawals += amt;
      else totalsByCurrency[cur].deposits += amt; // treat adjustments as deposits by default
    });

    Object.keys(totalsByCurrency).forEach(cur => {
      totalsByCurrency[cur].net = totalsByCurrency[cur].deposits - totalsByCurrency[cur].withdrawals;
    });

    const totalNet = Object.values(totalsByCurrency).reduce((s, v) => s + (v.net || 0), 0);

    return {
      transactionsCount: allTxns.length,
      totalsByCurrency,
      totalNet,
      sampleTransactions: allTxns.slice(0, 200)
    };
  } catch (error) {
    console.error('fetchNetDeposits error:', error);
    return { transactionsCount: 0, totalsByCurrency: {}, totalNet: 0, sampleTransactions: [] };
  }
};

/**
 * Fetch net deposits per user from actual deposit/withdrawal transactions
 * Returns a map: { username: { deposits, withdrawals, netDeposit, accountIds, transactions } }
 * This is more accurate than DepositsAmount which may include credits/bonuses.
 * @param {Array<{username: string, _accountIds: number[]}>} users - array of user objects with account IDs
 */
export const fetchNetDepositsPerUser = async (users) => {
  const result = {};
  
  console.log(`Fetching actual deposit transactions for ${users.length} users...`);
  
  for (const user of users) {
    const accountIds = user._accountIds || [];
    if (accountIds.length === 0) {
      result[user.username] = { deposits: 0, withdrawals: 0, netDeposit: 0, accountIds: [], transactions: [] };
      continue;
    }
    
    let allTxns = [];
    for (const id of accountIds) {
      try {
        const txns = await fetchClientTransactions(id);
        allTxns = allTxns.concat(txns || []);
      } catch (e) {
        console.warn(`Failed to fetch transactions for account ${id}:`, e.message || e);
      }
    }
    
    // Log all transactions for debugging (before filtering)
    if (allTxns.length > 0) {
      console.log(`  [${user.username}] Raw transactions (${allTxns.length}):`, allTxns.slice(0, 3).map(t => ({
        id: t.id,
        side: t.side,
        sideLabel: t.sideLabel,
        stateId: t.stateId,
        state: t.state,
        depositedAmount: t.depositedAmount,
        type: t.type
      })));
    }
    
    // Count ALL transactions (not just completed - the IB may not have permission to see state)
    // Only exclude clearly cancelled/failed states if we can detect them
    const validTxns = allTxns.filter(t => {
      // Exclude cancelled (3), failed (4), deleted (5) if stateId is present
      if (t.stateId === 3 || t.stateId === 4 || t.stateId === 5) return false;
      // Otherwise include (pending and completed are both valid for reporting)
      return true;
    });
    
    let deposits = 0;
    let withdrawals = 0;
    
    validTxns.forEach(t => {
      const amt = parseFloat(t.depositedAmount || t.amount || 0) || 0;
      const isDeposit = t.side === 1 || t.sideLabel === 'Deposit';
      const isWithdrawal = t.side === 2 || t.sideLabel === 'Withdrawal';
      
      if (isDeposit) deposits += amt;
      else if (isWithdrawal) withdrawals += amt;
    });
    
    result[user.username] = {
      deposits,
      withdrawals,
      netDeposit: deposits - withdrawals,
      accountIds,
      transactions: validTxns
    };
    
    console.log(`  [${user.username}] Net deposit: $${(deposits - withdrawals).toFixed(2)} (${validTxns.length} valid txns from ${allTxns.length} total)`);
  }
  
  return result;
};

/**
 * Compute network volume and revenue for a time range and optional list of account IDs
 * Delegates to `fetchVolumeHistory` which already supports account IDs or aliases
 */
export const fetchNetworkVolume = async (timeRange = 'Lifetime', accountIds = null) => {
  try {
    const res = await fetchVolumeHistory(timeRange, accountIds);
    return {
      totalVolume: res.totalVolume || 0,
      totalPL: res.totalPL || 0,
      revenue: res.revenue || 0,
      tradesCount: res.trades ? res.trades.length : 0,
      trades: res.trades
    };
  } catch (error) {
    console.error('fetchNetworkVolume error:', error);
    return { totalVolume: 0, totalPL: 0, revenue: 0, tradesCount: 0, trades: [] };
  }
};

/**
 * Fetch all trading accounts (bulk) optionally filtered by partnerId.
 * This avoids per-alias RPC calls and provides a local alias -> accountId map.
 */
export const fetchAllTradingAccounts = async (partnerId = null) => {
  try {
    const session = await getSession();

    // Fetch a large page of trading accounts and filter locally by partnerId
    const msg = {
      MessageType: 100,
      Filters: [],
      AdminType: 8,
      Sort: 'Id asc',
      PageSize: 1000,
      AccountType: '12'
    };

    console.log('Fetching all trading accounts (bulk) to build alias map');
    const result = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);

    let data = result;
    if (typeof result === 'string') data = JSON.parse(result);
    if (!data || !data.Messages || data.Messages.length === 0) return [];

    // Unwrap wrapper.Messages[0].Messages if present
    let msgs = data.Messages;
    if (msgs.length > 0 && msgs[0].Messages) msgs = msgs[0].Messages;
    // Optionally filter locally by partnerId when provided
    let filtered = msgs;
    if (partnerId && !isNaN(Number(partnerId))) {
      filtered = msgs.filter(a => (a.T && a.T.PartnerId && Number(a.T.PartnerId) === Number(partnerId)) || (a.PartnerId && Number(a.PartnerId) === Number(partnerId)));
    }

    return filtered.map(account => ({
      id: account.Id || account.I,
      username: (account.T && account.T.A) || account['T.A'] || account.A || account.Username || '',
      partnerId: (account.T && account.T.PartnerId) || account.PartnerId || null,
      raw: account
    }));
  } catch (error) {
    console.error('fetchAllTradingAccounts error:', error && (error.message || error));
    return [];
  }
};