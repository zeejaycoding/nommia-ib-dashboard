/**
 * NOMMIA IB DASHBOARD - API INTEGRATION V2
 * Clean, efficient implementation based on XValley Backoffice API docs
 */

import autobahn from 'autobahn-browser';
import { supabase, uploadFileToStorage, deleteFileFromStorage } from './supabaseClient.js';

// ============= COMMISSION CALCULATION =============
// All commissions are fetched directly from XValley (including metals, instruments, tier adjustments)
// We do NOT calculate commissions locally - only add tier bonuses on top of XValley's value

export const API_CONFIG = {
  API_BASE_URL: import.meta.env.VITE_API_BASE_URL || "https://api.nommia.io",
  BACKEND_URL: import.meta.env.VITE_BACKEND_URL || "https://nommia-ib-backend.onrender.com",
  
  // ============= DUAL WEBSOCKET ENDPOINTS =============
  // In development: Vite dev server proxies /ws-admin and /ws-trade to XValley servers.
  // In production: Route through the backend server which proxies WebSocket upgrades,
  //   avoiding CORS/firewall restrictions on direct browser → XValley connections.
  WS_ADMIN_URL: import.meta.env.DEV
    ? "ws://localhost:5173/ws-admin"
    : (import.meta.env.VITE_BACKEND_URL || "https://nommia-ib-backend.onrender.com")
        .replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + "/ws-admin",

  // TRADE: For trading operations (trades, deposits, transactions)
  WS_TRADE_URL: import.meta.env.DEV
    ? "ws://localhost:5173/ws-trade"
    : (import.meta.env.VITE_BACKEND_URL || "https://nommia-ib-backend.onrender.com")
        .replace(/^https/, 'wss').replace(/^http(?!s)/, 'ws') + "/ws-trade",
  
  REALM: "fxplayer",
  BROKER_HOST: import.meta.env.VITE_BROKER_HOST || "nommia.io",
  
  TOPICS: {
    // ========== ADMIN TOPICS (backoffice) ==========
    PING: 'com.fxplayer.ping',                    // Auth on both
    LEADS: 'com.fxplayer.leads',                  // ADMIN: Get customers/leads
    TRADERS: 'com.fxplayer.traders',              // ADMIN: Get trading accounts
    CONTACTS: 'com.fxplayer.contacts',            // ADMIN: Get contacts
    ACCOUNT_TYPES: 'com.fxplayer.accounttypes',   // ADMIN: Account type list
    ACCOUNT_LEVELS: 'com.fxplayer.accountlevels', // ADMIN: Account level groups
    SAVE_USER: 'com.fxplayer.saveuser',           // ADMIN: Create/update user
    RESET_PASSWORD: 'com.fxplayer.resetpassword', // ADMIN: Reset password
    
    // ========== TRADE TOPICS (trading operations) ==========
    PLATFORM_CLOSE: 'com.fxplayer.platformclose', // TRADE: Get closed trades
    DEPOSITS: 'com.fxplayer.deposits',            // TRADE: Get deposits/withdrawals
  },
  
  TOPIC_LOCATION: {
    // Map topics to their WebSocket connection type
    'com.fxplayer.ping': 'admin',                 // Both but primary admin
    'com.fxplayer.leads': 'admin',
    'com.fxplayer.traders': 'admin',
    'com.fxplayer.platformclose': 'trade',
    'com.fxplayer.deposits': 'trade',
    'com.fxplayer.contacts': 'admin',
    'com.fxplayer.accounttypes': 'admin',
    'com.fxplayer.accountlevels': 'admin',
    'com.fxplayer.saveuser': 'admin',
    'com.fxplayer.resetpassword': 'admin'
  }
};

// ============= DUAL WEBSOCKET GLOBAL STATE =============
// ADMIN WebSocket Session
let wsSessionAdmin = null;
let wsConnectionAdmin = null;

// TRADE WebSocket Session
let wsSessionTrade = null;
let wsConnectionTrade = null;

// Shared session state (from PING)
let wsSessionId = null;
let sessionPartnerId = null;
let sessionRoles = []; // Store user roles from PING response (e.g., ["countrymanager", "admin"])

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
    // console.warn('[Partner ID] Timeout waiting for partner ID - WebSocket may not be connected');
  }
  
  return sessionPartnerId;
};
let sessionCompanyId = null;  // Store CompanyId from session for filtering
let authToken = null;  // WAMP authentication token
let accessToken = null;  // HTTP Bearer token for REST endpoints

// Get current auth token for WAMP connection
export const getAuthToken = () => authToken;

// Get HTTP access token for Bearer auth
export const getAccessToken = () => accessToken;

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
    
    // XValley returns refresh_token from /token endpoint (for WAMP)
    // Also extract access_token for HTTP Bearer auth (REST endpoints like /profile/reset/)
    authToken = data.refresh_token || data.refreshToken || data.token || data.access_token;
    accessToken = data.access_token || data.accessToken || authToken; // Fallback to same token if access_token not provided
    // console.log("Auth token obtained:", authToken ? "Yes" : "No");
    // console.log("Access token obtained:", accessToken ? "Yes" : "No");
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
      // console.log("Server config not available, using defaults");
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
    // console.warn("Could not fetch server config:", e.message);
    return null;
  }
};

// ============= WEBSOCKET CONNECTION =============

/**
 * Connect to ADMIN WebSocket (backoffice: users, accounts, settings)
 */
const connectAdminWebSocket = (token) => {
  return new Promise((resolve, reject) => {
    if (wsSessionAdmin) {
      // console.log('[WS-ADMIN] 🔄 Already connected, reusing session');
      resolve(wsSessionAdmin);
      return;
    }
    
    // console.log('[WS-ADMIN] ⏳ Connecting to Admin WebSocket...');
    authToken = token;
    wsConnectionAdmin = new autobahn.Connection({
      url: API_CONFIG.WS_ADMIN_URL,
      realm: API_CONFIG.REALM,
      autoreconnect: true,
      max_retries: 15,
      max_retry_delay: 30,
      retry_delay_initial: 1,
      retry_delay_max: 30,
      retry_delay_growth: 1.5
    });

    wsConnectionAdmin.onopen = async (session) => {
      // console.log('[WS-ADMIN] ✅ Connected to:', API_CONFIG.WS_ADMIN_URL);
      wsSessionAdmin = session;
      
      try {
        // PING to authenticate
        const pingMsg = JSON.stringify({ token: authToken, host: API_CONFIG.BROKER_HOST });
        // console.log('[WS-ADMIN] 🔐 Sending PING with broker host:', API_CONFIG.BROKER_HOST);
        
        const result = await session.call(API_CONFIG.TOPICS.PING, [pingMsg]);
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        
        // console.log('[WS-ADMIN] 📨 PING Response received');
        
        // Check for errors (MessageType -3 is error, -2 is warning/partial)
        if (data.MessageType === -3) {
          console.error('[WS-ADMIN] ❌ Auth Error');
          reject(new Error(data.Messages?.[0] || 'Auth failed'));
          return;
        }
        
        if (data.MessageType === -2) {
          // console.warn('[WS-ADMIN] ⚠️  Warning response (MessageType -2)');
          // Still continue with -2, as it's a warning, not a fatal error
        }
        
        // Extract session info from PING response
        wsSessionId = data.Messages?.[0] || null;
        sessionRoles = Array.isArray(data.Messages?.[1]) ? data.Messages[1] : [];
        
        const partnerIdStr = data.Messages?.[3];
        if (partnerIdStr) {
          sessionPartnerId = parseInt(partnerIdStr, 10);
        }
        
        const companyIdStr = data.Messages?.[4];
        if (companyIdStr) {
          sessionCompanyId = parseInt(companyIdStr, 10);
        }
        
        // console.log('[WS-ADMIN] ✅ Session Info: Connected');
        
        resolve(session);
      } catch (err) {
        console.error('[WS-ADMIN] ❌ PING Error:', err);
        reject(err);
      }
    };

    wsConnectionAdmin.onclose = (reason) => {
      // console.log('[WS-ADMIN] 🔌 Connection closed');
      wsSessionAdmin = null;
    };

    wsConnectionAdmin.onerror = (error) => {
      console.error('[WS-ADMIN] ⚠️ WebSocket Error');
    };

    wsConnectionAdmin.open();
  });
};

/**
 * Connect to TRADE WebSocket (trading: trades, deposits, transactions)
 */
const connectTradeWebSocket = (token) => {
  return new Promise((resolve, reject) => {
    if (wsSessionTrade) {
      // console.log('[WS-TRADE] 🔄 Already connected, reusing session');
      resolve(wsSessionTrade);
      return;
    }
    
    // console.log('[WS-TRADE] ⏳ Connecting to Trade WebSocket...');
    authToken = token;
    wsConnectionTrade = new autobahn.Connection({
      url: API_CONFIG.WS_TRADE_URL,
      realm: API_CONFIG.REALM,
      autoreconnect: true,
      max_retries: 15,
      max_retry_delay: 30,
      retry_delay_initial: 1,
      retry_delay_max: 30,
      retry_delay_growth: 1.5
    });

    wsConnectionTrade.onopen = async (session) => {
      // console.log('[WS-TRADE] ✅ Connected to WebSocket');
      wsSessionTrade = session;
      
      try {
        // PING to authenticate
        const pingMsg = JSON.stringify({ token: authToken, host: API_CONFIG.BROKER_HOST });
        // console.log('[WS-TRADE] 🔐 Sending PING');
        
        const result = await session.call(API_CONFIG.TOPICS.PING, [pingMsg]);
        const data = typeof result === 'string' ? JSON.parse(result) : result;
        
        // console.log('[WS-TRADE] 📨 PING Response received');
        
        // Check for errors
        if (data.MessageType === -3) {
          console.error('[WS-TRADE] ❌ Auth Error');
          reject(new Error(data.Messages?.[0] || 'Auth failed'));
          return;
        }
        
        if (data.MessageType === -2) {
          // console.warn('[WS-TRADE] ⚠️  Warning response');
        }
        
        // console.log('[WS-TRADE] ✅ Trade WebSocket authenticated');
        resolve(session);
      } catch (err) {
        console.error('[WS-TRADE] ❌ PING Error:', err);
        reject(err);
      }
    };

    wsConnectionTrade.onclose = (reason) => {
      // console.log('[WS-TRADE] 🔌 Connection closed');
      wsSessionTrade = null;
    };

    wsConnectionTrade.onerror = (error) => {
      console.error('[WS-TRADE] ⚠️ WebSocket Error');
    };

    wsConnectionTrade.open();
  });
};

/**
 * Main connection function - establishes both WebSocket connections
 */
export const connectWebSocket = async (token) => {
  try {
    // console.log('[WS] 🚀 Starting connection');
    
    // Connect both Admin and Trade WebSockets in parallel
    const [adminSession, tradeSession] = await Promise.all([
      connectAdminWebSocket(token),
      connectTradeWebSocket(token)
    ]);
    
    // console.log('[WS] ✅ Connections established');
    return { admin: adminSession, trade: tradeSession };
  } catch (error) {
    console.error('[WS] ❌ Connection failed');
    throw error;
  }
};

export const disconnectWebSocket = () => {
  // console.log('[WS] 🔌 Disconnecting');
  
  if (wsConnectionAdmin) {
    wsConnectionAdmin.close();
    wsSessionAdmin = null;
    wsConnectionAdmin = null;
  }
  
  if (wsConnectionTrade) {
    wsConnectionTrade.close();
    wsSessionTrade = null;
    wsConnectionTrade = null;
  }
  
  // console.log('[WS] ✅ All connections closed');
};

/**
 * Get the appropriate WebSocket session based on topic
 * Returns the correct session (admin or trade) for the topic
 */
const getSessionForTopic = (topic) => {
  const location = API_CONFIG.TOPIC_LOCATION[topic];
  
  if (location === 'trade') {
    if (!wsSessionTrade) throw new Error(`Trade WebSocket not connected. Cannot call ${topic}`);
    return wsSessionTrade;
  } else {
    if (!wsSessionAdmin) throw new Error(`Admin WebSocket not connected. Cannot call ${topic}`);
    return wsSessionAdmin;
  }
};

export const getSessionPartnerId = () => sessionPartnerId;

export const getSessionUsername = () => wsSessionId;

export const getSessionRoles = () => sessionRoles;

/**
 * Convert raw role string to UI display format
 * "countrymanager" => "CountryManager"
 * "ib" => "IB"
 * "admin" => "Admin"
 */
export const normalizeRoleFormat = (role) => {
  if (!role) return null;
  const lowerRole = role.toLowerCase().trim();
  
  if (lowerRole === 'countrymanager' || lowerRole === 'country_manager') return 'CountryManager';
  if (lowerRole === 'regionalmanager' || lowerRole === 'regional_manager') return 'RegionalManager';
  if (lowerRole === 'ib') return 'IB';
  if (lowerRole === 'admin') return 'Admin';
  if (lowerRole === 'cm') return 'CountryManager';
  if (lowerRole === 'rm') return 'RegionalManager';
  
  return role;
};

/**
 * Get the primary/main role for the logged-in user
 */
export const getUserPrimaryRole = () => {
  if (!sessionRoles || sessionRoles.length === 0) return 'IB';
  
  // Order of precedence for display
  const normRoles = sessionRoles.map(r => normalizeRoleFormat(r)).filter(Boolean);
  
  if (normRoles.includes('Admin')) return 'Admin';
  if (normRoles.includes('RegionalManager')) return 'RegionalManager';
  if (normRoles.includes('CountryManager')) return 'CountryManager';
  if (normRoles.includes('IB')) return 'IB';
  
  return normRoles[0] || 'IB';
};

/**
 * Get all valid roles user can view as (for admin hierarchy)
 * 
 * ROLE HIERARCHY (from highest to lowest):
 * 1. Admin      - Can view as: Admin, RM, CM, IB
 * 2. RM         - Can view as: RM, CM, IB
 * 3. CM         - Can view as: CM, IB
 * 4. IB         - Can view as: IB only
 */
export const getAccessibleRoles = () => {
  if (!sessionRoles || sessionRoles.length === 0) return ['IB'];
  
  const normRoles = sessionRoles.map(r => normalizeRoleFormat(r)).filter(Boolean);
  const uniqueRoles = [...new Set(normRoles)];
  
  // Admins can view as all roles (full hierarchy)
  if (uniqueRoles.includes('Admin')) {
    return ['Admin', 'RegionalManager', 'CountryManager', 'IB'];
  }
  
  // Regional managers can view as RM and lower (CM, IB)
  if (uniqueRoles.includes('RegionalManager')) {
    return ['RegionalManager', 'CountryManager', 'IB'];
  }
  
  // Country managers can view as CM and lower (IB)
  if (uniqueRoles.includes('CountryManager')) {
    return ['CountryManager', 'IB'];
  }
  
  // IB can only view as IB
  return ['IB'];
};

/**
 * Check if user is allowed to view as a specific role
 * Returns true if the role is in the user's accessible roles
 * 
 * @param {string} targetRole - The role to check (e.g., 'Admin', 'RegionalManager', 'CountryManager', 'IB')
 * @returns {boolean} - True if user can view as this role
 */
export const canViewAsRole = (targetRole) => {
  const accessible = getAccessibleRoles();
  return accessible.includes(targetRole);
};

/**
 * Get the highest role in the hierarchy that the user has
 * Used to determine the "master" role and restrictions
 * 
 * @returns {string} - The highest role (Admin > RM > CM > IB)
 */
export const getHighestRole = () => {
  if (!sessionRoles || sessionRoles.length === 0) return 'IB';
  
  const normRoles = sessionRoles.map(r => normalizeRoleFormat(r)).filter(Boolean);
  const uniqueRoles = [...new Set(normRoles)];
  
  if (uniqueRoles.includes('Admin')) return 'Admin';
  if (uniqueRoles.includes('RegionalManager')) return 'RegionalManager';
  if (uniqueRoles.includes('CountryManager')) return 'CountryManager';
  return 'IB';
};

/**
 * Check if user has a specific role
 * 
 * Role hierarchy for logging purposes (for debugging):
 * Admin can view as:      [Admin, RM, CM, IB]
 * RM can view as:         [RM, CM, IB]
 * CM can view as:         [CM, IB]
 * IB can view as:         [IB]
 */

/**
 * Log role change attempt (for audit trail)
 */
export const logRoleChange = (fromRole, toRole, allowed) => {
  const timestamp = new Date().toISOString();
  const highestRole = getHighestRole();
  const username = wsSessionId || 'unknown';
  
  if (allowed) {
    // console.log(`[ROLE_HIERARCHY] ✅ ${timestamp} | User: ${username} | Highest: ${highestRole} | Changed: ${fromRole} → ${toRole}`);
  } else {
    console.warn(`[ROLE_HIERARCHY] ⚠️ ${timestamp} | User: ${username} | Highest: ${highestRole} | Blocked: ${fromRole} → ${toRole} (UNAUTHORIZED)`);
  }
};

/**
 * Fetch ALL leads/clients from the platform for network building
 * Returns clients with their referrer information (no filtering)
 * This is used to build complete Tier 1/2/3 hierarchies
 */
/**
 * Fetch ALL users/leads from Nommia company (CompanyId: 5) for admin user management
 * Uses LEADS endpoint with CompanyId filter
 * @param {number} pageSize - Pagination size (default 5000)
 * @returns {Promise<Array>} All company users/leads
 */
export const fetchAllCompanyUsers = async (pageSize = 5000) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.LEADS);
  if (!isAdminUser()) throw new Error("Only admins can fetch company users");
  
  const NOMMIA_COMPANY_ID = 5;
  
  // console.log("[📋 fetchAllCompanyUsers] START - Fetching ALL users from LEADS endpoint for Nommia (CompanyId: 5)...");
  
  // Log diagnostic information for backend support
  const requestTimestamp = new Date().toISOString();
  // console.log("=== 🔍 DIAGNOSTIC INFO ===");
  // console.log("Timestamp:", requestTimestamp);
  // console.log("Admin PartnerId:", sessionPartnerId);
  // console.log("Admin Roles:", sessionRoles);
  // console.log("Session ID:", wsSessionId);
  // console.log("Company ID:", sessionCompanyId);
  // console.log("==========================");
  
  try {
    let allUsers = [];
    let skip = 0;
    let hasMore = true;
    let totalCount = 0;
    const today = new Date();
    const fiveYearsAgo = new Date(today.getTime() - 5 * 365 * 24 * 60 * 60 * 1000);
    
    const dateFrom = fiveYearsAgo.toISOString().split('T')[0];
    const dateTo = today.toISOString().split('T')[0];
    
    const companyIdFilter = {
      Filter: NOMMIA_COMPANY_ID,
      FilterComparison: 3,  
      FilterType: "CompanyId",
      FilterValueType: 2  
    };
    
    while (hasMore) {
      const msg = {
        MessageType: 100,
        From: dateFrom,
        To: dateTo,
        Filters: [companyIdFilter],
        PageSize: pageSize,
        Sort: "Registration desc",
        Skip: skip,
        AdminType: 1  
      };
      
      // console.log(`[📋 fetchAllCompanyUsers] 🔄 Batch ${skip}-${skip + pageSize} via ADMIN WebSocket...`);
      
      // Log API call details for XValley support
      console.log(`[XVALLEY_API] fetchAllCompanyUsers | Topic: ${API_CONFIG.TOPICS.LEADS} | Request: AdminType=${msg.AdminType}, PageSize=${msg.PageSize}, Skip=${skip}`);
      
      const result = await session.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
      const data = typeof result === 'string' ? JSON.parse(result) : result;
      const wrapper = data?.Messages?.[0];
      const users = wrapper?.Messages || [];
      
      if (!totalCount) {
        totalCount = wrapper?.Total || 0;
        // console.log(`[📋 fetchAllCompanyUsers] ✅ Total available: ${totalCount} users`);
      }
      
      if (skip === 0) {
        // console.log(`[📋 fetchAllCompanyUsers] First batch: Got ${users.length} users (Total: ${totalCount})`);
        if (totalCount > 0 && users.length === 0) {
          // console.warn(`[📋 fetchAllCompanyUsers] ⚠️  Permissions issue: Total=${totalCount} but returned 0 entries (PartnerId=${sessionPartnerId} may lack visibility)`);
        }
      }
      
      // Transform LEADS response to standardized user format
      const transformedUsers = users.map(lead => ({
        id: lead.Id,
        username: lead.UserName || '',
        email: lead.Email || '',
        firstName: lead.FirstName || '',
        lastName: lead.LastName || '',
        name: `${lead.FirstName || ''} ${lead.LastName || ''}`.trim() || lead.UserName,
        phone: lead.PhoneNumber || '',
        country: lead.CountryName || 'Unknown',
        countryCode: lead.CountryIsoCode || lead.CountryCode || '',
        approved: lead.Approved === true,
        approvedDate: lead.ApprovedDate || null,
        kycStatus: lead.Approved === true ? 'Approved' : 'Pending',
        lastLogin: lead.LastLogin || null,
        registrationDate: lead.Registration || lead.CreatedOn || null,
        referralCode: lead.ReferralCode || '',
        referrer: lead.Referrer || null,
        status: lead.Status || lead.StatusString || 'Active',
        role: lead.Role || '',
        language: lead.Language || '',
        partnerId: lead.PartnerId || null,
        companyId: lead.CompanyId || NOMMIA_COMPANY_ID,
        companyName: lead.CompanyName || 'Nommia',
        deposit: lead.DepositsAmount || 0,
        depositTimes: lead.DepositTimes || 0,
        _raw: lead
      }));
      
      allUsers = allUsers.concat(transformedUsers);
      
      // If we got fewer users than pageSize, we've reached the end
      if (users.length < pageSize) {
        // console.log(`[fetchAllCompanyUsers] Pagination complete: ${users.length} < ${pageSize}`);
        hasMore = false;
      } else {
        skip += pageSize;
        hasMore = skip < totalCount;
      }
    }
    
    // console.log(`[fetchAllCompanyUsers] Successfully fetched ${allUsers.length} total users from Nommia`);
    
    return allUsers;
  } catch (error) {
    console.error("[fetchAllCompanyUsers] Error:", error);
    throw error;
  }
};

export const fetchAllLeads = async (pageSize = 5000) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.LEADS);
  
  // console.log("[📋 fetchAllLeads] Fetching all leads/clients from ADMIN WebSocket...");
  
  try {
    const msg = {
      MessageType: 100,
      Filters: [],  // NO company/partner filter
      PageSize: pageSize,
      Sort: "Registration desc",
      Skip: 0,
      AdminType: 1  // AdminType 1 = LEADS endpoint (per XValley docs)
    };
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchAllLeads | Topic: ${API_CONFIG.TOPICS.LEADS} | Request: AdminType=${msg.AdminType}, PageSize=${msg.PageSize}`);
    
    const result = await session.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const clients = wrapper?.Messages || [];
    
    // console.log(`[✅ fetchAllLeads] Found ${clients.length} clients (Total available: ${wrapper?.Total || 0})`);
    
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
    console.error("[❌ fetchAllLeads] Error:", error.message);
    return [];
  }
};

// ============= CORE DATA FETCHING =============

/**
 * Fetch IB clients/leads from the LEADS endpoint
 * ⚠️ IMPORTANT: Uses AdminType 1 (LEADS), NOT AdminType 2
 * Per XValley Backoffice API docs: AdminType 1 = Leads/Customers
 */
export const fetchIBClients = async (usernames = []) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.LEADS);
  
  // console.log(`[👥 fetchIBClients] Fetching IB clients${usernames.length > 0 ? ` for usernames: ${usernames.slice(0, 3).join(', ')}...` : ' (all)'}`);
  
  // Try WITH CompanyId filter first, then fallback to no filters if returns 0
  let filters = [];
  if (sessionCompanyId) {
    filters.push({
      Filter: String(sessionCompanyId),        
      FilterComparison: 1,                      // NumberEquals
      FilterType: "CompanyId",                  
      FilterValueType: 2                        // Number
    });
    // console.log(`[👥 fetchIBClients] Applied CompanyId filter: ${sessionCompanyId}`);
  }
  
  let msg = {
    MessageType: 100,
    Filters: filters,
    PageSize: 500,
    Sort: "Registration desc",
    Skip: 0,
    AdminType: 1  // CORRECTED: AdminType 1 for LEADS endpoint
  };
  
  // Log API call details for XValley support
  console.log(`[XVALLEY_API] fetchIBClients | Topic: ${API_CONFIG.TOPICS.LEADS} | Request: AdminType=${msg.AdminType}, PageSize=${msg.PageSize}, Filters=${filters.length}`);
  
  let result = await session.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
  let data = typeof result === 'string' ? JSON.parse(result) : result;
  
  let wrapper = data?.Messages?.[0];
  let clients = wrapper?.Messages || [];
  
  // FALLBACK: If CompanyId filter returned 0 results but Total > 0, retry without filter
  if (clients.length === 0 && wrapper?.Total > 0 && filters.length > 0) {
    // console.warn(`[⚠️  fetchIBClients] CompanyId filter (${sessionCompanyId}) returned 0 of ${wrapper?.Total}. Retrying without filter...`);
    
    msg.Filters = [];
    result = await session.call(API_CONFIG.TOPICS.LEADS, [JSON.stringify(msg)]);
    data = typeof result === 'string' ? JSON.parse(result) : result;
    wrapper = data?.Messages?.[0];
    clients = wrapper?.Messages || [];
    
    // console.log(`[👥 fetchIBClients] Fallback request (no filter): Got ${clients.length} clients (Total: ${wrapper?.Total || 0})`);
  }
  
  // console.log(`[✅ fetchIBClients] Received ${clients.length} clients (Total: ${wrapper?.Total || 0})`);
  
  if (!clients.length) {
    // console.warn("[⚠️  fetchIBClients] No clients found - Response:", data);
    return [];
  }
  
  // Filter by usernames if provided
  let filteredClients = clients;
  if (usernames.length > 0) {
    const usernameSet = new Set(usernames.map(u => u.toLowerCase()));
    filteredClients = clients.filter(c => {
      const username = (c.UserName || c.A || '').toLowerCase();
      return usernameSet.has(username);
    });
    // console.log(`[👥 fetchIBClients] Filtered to ${filteredClients.length} of ${clients.length} matching provided usernames`);
  }
  
  // Map to client objects 
  return filteredClients.map(lead => {
    const isApproved = lead.Approved === true;
    const statusString = lead.StatusString || '';
    const isPending = !isApproved || statusString.toLowerCase().includes('pending');
    
    let kycStatus = 'Pending';
    if (isApproved) {
      kycStatus = 'Approved';
    } else if (lead.Status === 2) {
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
 * Fetch ALL clients in Nommia company (no partner filter) for network tree building
 * Uses trading accounts endpoint to get tier 1, 2, 3 across all partners
 * Aggregates financial data (deposits, volume, equity) for display
 */
export const fetchAllClientsForNetwork = async () => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.TRADERS);
  // console.log(`[👥 fetchAllClientsForNetwork] START - Fetching all trading accounts...`);
  
  try {
    // Step 1: Fetch all trading account (REAL ONLY - AccountType: "1")
    const msg = {
      MessageType: 100,
      Filters: [],
      AdminType: 8,
      Sort: "Id desc",
      AccountType: "1",  // 1=real accounts only (not demo)
      PageSize: 2000,
      Skip: 0
    };
    
    // console.log("[👥 fetchAllClientsForNetwork] Calling TRADERS topic...");
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchAllClientsForNetwork | Topic: ${API_CONFIG.TOPICS.TRADERS} | Request: AdminType=${msg.AdminType}, AccountType=${msg.AccountType}, PageSize=${msg.PageSize}`);
    
    const result = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const accounts = wrapper?.Messages || [];
    
    if (!accounts.length) {
      // console.log("[fetchAllClientsForNetwork] No trading accounts found");
      return [];
    }
    
    // console.log(`[fetchAllClientsForNetwork] Found ${accounts.length} total trading accounts`);
    
    // Step 2: Group accounts by trader and aggregate financial data
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
          
          // Financial data (aggregated from trading accounts)
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
      
      // Aggregate from REAL accounts only
      if (isRealAccount) {
        clientMap[username].deposit += (acc.DepositsAmount || 0);
        clientMap[username].equity += (acc.E || 0);
        clientMap[username].balance += (acc.BAL || 0);
      }
    });
    
    // Step 3: Get closed trades for volume and commission
    // console.log("[👥 fetchAllClientsForNetwork] Fetching closed trades...");
    
    const tradeSession = getSessionForTopic(API_CONFIG.TOPICS.PLATFORM_CLOSE);
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
    
    // console.log("[👥 fetchAllClientsForNetwork] Calling PLATFORM_CLOSE...");
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchAllClientsForNetwork-Trades | Topic: ${API_CONFIG.TOPICS.PLATFORM_CLOSE} | Request: AdminType=${tradesMsg.AdminType}, PageSize=${tradesMsg.PageSize}`);
    
    const tradesResult = await tradeSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(tradesMsg)]);
    const tradesData = typeof tradesResult === 'string' ? JSON.parse(tradesResult) : tradesResult;
    
    const tradesWrapper = tradesData?.Messages?.[0];
    const trades = tradesWrapper?.Messages || [];
    
    // console.log(`[fetchAllClientsForNetwork] Found ${trades.length} closed trades for volume/commission`);
    
    // Group trades by username and aggregate
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
    
    // Apply trade data to clients
    Object.keys(clientMap).forEach(username => {
      const tradeData = tradesByUsername[username];
      if (tradeData) {
        clientMap[username].volume = Math.round(tradeData.volume * 100) / 100;
        clientMap[username].revenue = Math.round(tradeData.revenue * 100) / 100;
      }
    });
    
    const allClients = Object.values(clientMap);
    // console.log(`[fetchAllClientsForNetwork] Grouped into ${allClients.length} unique traders with aggregated data`);
    
    // Log samples
    // const samples = allClients.slice(0, 5);
    // samples.forEach((c, idx) => {
    //   console.log(`Sample client ${idx + 1}: ${c.username}, partnerId=${c.partnerId}, deposit=$${c.deposit}, volume=${c.volume}, kyc=${c.kycStatus}`);
    // });
    
    // Debug: Log full raw trader data for first few clients to understand available fields
    // console.log("[fetchAllClientsForNetwork] Full raw trader data samples:");
    // samples.forEach((c, idx) => {
    //   const raw = c._raw;
    //   if (raw) {
    //     console.log(`Trader ${idx + 1} (${c.username}):`, {
    //       Id: raw.I,
    //       Alias: raw.A,
    //       PartnerId: raw.PartnerId,
    //       Referrer: raw.Referrer,
    //       ReferrerId: raw.ReferrerId,
    //       Company: raw.Company?.Name,
    //       CompanyId: raw.CompanyId,
    //       State: raw.State,
    //       Approved: raw.Approved,
    //       Keys: Object.keys(raw).slice(0, 20)
    //     });
    //   }
    // });
    
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
  const session = getSessionForTopic(API_CONFIG.TOPICS.TRADERS);
  // console.log("[👤 fetchTradingAccountsBulk] START - Loading trading accounts...");
  
  try {
    const pid = partnerId || sessionPartnerId;
    
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
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchTradingAccountsBulk | Topic: ${API_CONFIG.TOPICS.TRADERS} | Request: AdminType=${msg.AdminType}, AccountType=${msg.AccountType}, PageSize=${msg.PageSize}`);
    
    const result = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
    
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    // Response structure: { Messages: [{ AdminType, Messages: [...actual accounts...], Total }] }
    const wrapper = data?.Messages?.[0];
    const accounts = wrapper?.Messages || [];
    
    // console.log(`[👤 fetchTradingAccountsBulk] ✅ Response received: ${accounts.length} accounts (Total available: ${wrapper?.Total || 'N/A'})`);
    
    if (!accounts.length) {
      // console.warn("[⚠️  fetchTradingAccountsBulk] No trading accounts found in response");
      return [];
    }
    
    // Filter by PartnerId client-side
    let filteredAccounts = accounts;
    if (pid) {
      // Debug: Check where PartnerId is actually stored
      if (accounts.length > 0) {
        // const firstAcc = accounts[0];
        // console.log(`[👤 fetchTradingAccountsBulk] DEBUG - PartnerId lookup in first account:`, {
        //   'acc.PartnerId': firstAcc.PartnerId,
        //   'acc.T.PartnerId': firstAcc.T?.PartnerId,
        //   'acc.T.I (trader ID)': firstAcc.T?.I,
        //   'targetPartnerId': pid,
        //   allKeys: Object.keys(firstAcc).slice(0, 20)
        // });
      }
      
      // Try multiple filter approaches
      const filterAtRoot = accounts.filter(acc => acc.PartnerId === pid);
      const filterAtTrader = accounts.filter(acc => acc.T?.PartnerId === pid);
      
      filteredAccounts = filterAtTrader.length > 0 ? filterAtTrader : filterAtRoot;
      
      // console.log(`[👤 fetchTradingAccountsBulk] PartnerId filter results:`, {
      //   total: accounts.length,
      //   atRoot: filterAtRoot.length,
      //   atTrader: filterAtTrader.length,
      //   used: filteredAccounts.length,
      //   targetPartnerId: pid
      // });
    }
    
    // Log first account to see field structure
    // if (filteredAccounts[0]) {
    //   const sample = filteredAccounts[0];
    //   const accountType = sample.TATD || {};
    //   const isReal = accountType.Type === 1;
    //   console.log("[👤 fetchTradingAccountsBulk] Sample account structure:", {
    //     AccountId: sample.I,
    //     AccountName: sample.Name,
    //     IsReal: isReal,
    //     Username: sample.T?.A,
    //     Email: sample.T?.E,
    //     UserApproved: sample.T?.Approved,
    //     Equity: sample.E,
    //     Balance: sample.BAL,
    //     DepositsAmount: sample.DepositsAmount,
    //     PartnerId: sample.T?.PartnerId
    //   });
    // }
    
    return filteredAccounts;
  } catch (error) {
    console.error('[👤 fetchTradingAccountsBulk] Error:', error);
    return [];
  }
};

/**
 * Fetch all closed trades for volume calculation
 * Uses TRADE WebSocket for real-time trade data
 */
export const fetchClosedTradesBulk = async (partnerId, fromDate, toDate, accountIds = []) => {
  // console.log(`[📊 fetchClosedTradesBulk] Starting fetch...`);
  
  try {
    const pid = partnerId || sessionPartnerId;
    const adminSession = getSessionForTopic(API_CONFIG.TOPICS.LEADS);
    
    const filters = [];
    
    const msg = {
      MessageType: 100,
      From: fromDate || "",
      To: toDate || "",
      Filters: filters,
      AdminType: 205,  // Closed trades
      Sort: "Id desc",
      AccountType: "1",  // Real accounts only
      PageSize: 2000,
      Skip: 0
    };
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchClosedTradesBulk | Topic: ${API_CONFIG.TOPICS.PLATFORM_CLOSE} | Request: AdminType=${msg.AdminType}, PageSize=${msg.PageSize}`);
    
    const result = await adminSession.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const wrapper = data?.Messages?.[0];
    const trades = wrapper?.Messages || [];
    
    // console.log(`[✅ fetchClosedTradesBulk] Received ${trades.length} trades`);
    
    if (!trades.length) return [];
    
    // Filter trades by partnerId if specified
    let filteredTrades = trades;
    if (pid) {
      filteredTrades = trades.filter(t => t.TA?.T?.PartnerId === pid);
      // console.log(`[📊 fetchClosedTradesBulk] Filtered trades`);
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
    console.error("[❌ fetchClosedTradesBulk] Error");
    // console.error("[❌ fetchClosedTradesBulk] Error stack:", error.stack);
    return [];
  }
};

/**
 * Fetch deposits/withdrawals transactions via TRADE WebSocket
 */
export const fetchTransactionsBulk = async (partnerId, fromDate = '', toDate = '') => {
  // console.log(`[💰 fetchTransactionsBulk] Starting fetch...`);
  
  try {
    const pid = partnerId || sessionPartnerId;
    
    const filters = [];
    if (sessionCompanyId) {
      filters.push({
        Filter: String(sessionCompanyId),        
        FilterComparison: 1,                      
        FilterType: "CompanyId",                  
        FilterValueType: 2                        
      });
    }
  
    const msg = {
      MessageType: 100,
      From: fromDate || '',
      To: toDate || '',
      Filters: filters,
      AdminType: 100,  // Transactions
      Sort: "Id desc",
      AccountType: "1",
      PageSize: 2000,
      Skip: 0
    };
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchTransactionsBulk | Topic: ${API_CONFIG.TOPICS.DEPOSITS} | Request: AdminType=${msg.AdminType}, PageSize=${msg.PageSize}, Filters=${filters.length}`);
    
    let result, data;
    
    try {
      const adminSession = getSessionForTopic(API_CONFIG.TOPICS.LEADS);
      result = await adminSession.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
      data = typeof result === 'string' ? JSON.parse(result) : result;
      // console.log(`[💰 fetchTransactionsBulk] Response received`);
    } catch (callError) {
      // console.error(`[💰 fetchTransactionsBulk] WAMP call failed`);
      // console.warn(`[⚠️  fetchTransactionsBulk] DEPOSITS not available`);
      return [];
    }
    
    const wrapper = data?.Messages?.[0];
    const transactions = wrapper?.Messages || data?.Messages || [];
    
    // console.log(`[✅ fetchTransactionsBulk] Received ${transactions.length} transactions`);
    
    // if (transactions[0]) {
    //   console.log(`[💰 fetchTransactionsBulk] Sample transaction structure:`, {
    //     hasId: !!transactions[0].Id,
    //     hasDA: !!transactions[0].DA,
    //     hasAA: !!transactions[0].AA,
    //     hasTS: !!transactions[0].TS,
    //     hasD: !!transactions[0].D
    //   });
    // }
  
  // Calculate totals before filtering
  const totalAmount = transactions.reduce((sum, t) => sum + (t.AA || t.Amount || 0), 0);
  // console.log(`[fetchTransactionsBulk] Total amount in response: $${totalAmount.toFixed(2)}`);
  
  // DEBUG: Log ALL fields from first few transactions to understand data structure
  // comment.log(`[💰 fetchTransactionsBulk] DETAILED TRANSACTION STRUCTURE:`);
  // for (let i = 0; i < Math.min(3, transactions.length); i++) {
  //   const t = transactions[i];
  //   console.log(`Transaction ${i + 1}:`, {
  //     Id: t.Id,
  //     TS: t.TS,        // Side: 1=Deposit, 2=Withdrawal
  //     TSN: t.TSN,      // Type Name  
  //     D: t.D,          // Date
  //     DA: t.DA,        // Deposit Amount (reference)
  //     AA: t.AA,        // Account Amount (balance?)
  //     F: t.F,          // F field
  //     R: t.R,          // R field  
  //     SA: t.SA,        // Send Amount
  //     'T.Name': t.T?.Name,  // Provider
  //     IsFiat: t.IsFiat,
  //     In: t.In,        // In field (might be amount)
  //     Reason: t.Reason,
  //     State: t.St || t.State,
  //     allFieldNames: Object.keys(t).filter(k => !k.startsWith('_')).slice(0, 30)
  //   });
  // }
  
  // // Check what F and R fields actually contain - important for amount calculation
  // console.log(`[💰 fetchTransactionsBulk] F & R Field Analysis (by deposit type):`);
  // const hasFField = transactions.some(t => t.F !== undefined && t.F !== null);
  // const hasRField = transactions.some(t => t.R !== undefined && t.R !== null);
  // const fValues = transactions.slice(0, 5).map(t => `F=${t.F}`).join(', ');
  // const rValues = transactions.slice(0, 5).map(t => `R=${t.R}`).join(', ');
  // console.log(`F field present: ${hasFField}, sample values: ${fValues}`);
  // console.log(`R field present: ${hasRField}, sample values: ${rValues}`);
  
  // // Calculate totals ONLY for deposits (TS=1) vs ALL transactions
  // const depositsOnly = transactions.filter(t => t.TS === 1);
  // const withdrawalsOnly = transactions.filter(t => t.TS === 2);
  // const aaAllTx = transactions.reduce((sum, t) => sum + (t.AA || 0), 0);
  // const aaDepositsRunningTotal = depositsOnly.reduce((sum, t) => sum + (t.AA || 0), 0);
  // console.log(`[💰 Amount Calculation Check]:`);
  // console.log(`  All transactions (${transactions.length}): Sum(AA) = $${aaAllTx.toFixed(2)}`);
  // console.log(`  Deposits only (${depositsOnly.length}): Sum(AA) = $${aaDepositsRunningTotal.toFixed(2)}`);
  // console.log(`  Withdrawals only (${withdrawalsOnly.length}): Count = ${withdrawalsOnly.length}`);
  
  // // DEBUG: Check nested objects for amounts - T, TA, TrA, TC, AC
  // console.log(`[💰 fetchTransactionsBulk] Searching for deposit amount in nested objects:`);
  // for (let i = 0; i < Math.min(2, depositsOnly.length); i++) {
  //   const t = depositsOnly[i];
  //   console.log(`Deposit ${i + 1} (Id=${t.Id}):`, {
  //     'Direct fields': { AA: t.AA, DA: t.DA, F: t.F, R: t.R, In: t.In, SA: t.SA },
  //     'T object': t.T ? { ...t.T }.toString().substring(0, 100) : 'null',
  //     'TA object': t.TA ? { I: t.TA?.I, Name: t.TA?.Name } : 'null',
  //     'TrA object': t.TrA ? { I: t.TrA?.I, Name: t.TrA?.Name } : 'null',
  //     'TC object': t.TC ? { I: t.TC?.I, Name: t.TC?.Name } : 'null',
  //     'AC object': t.AC ? { I: t.AC?.I, Name: t.AC?.Name } : 'null'
  //   });
  // }
  
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
  
  // console.log(`[fetchTransactionsBulk] Deposits: ${deposits.length} total (${daDeposits.length} via DA=$${daTotal.toFixed(2)}, ${aaDeposits.length} via AA=$${aaTotal.toFixed(2)})`);
  // console.log(`[fetchTransactionsBulk] Withdrawals: ${withdrawals.length}`);
  // console.log(`[fetchTransactionsBulk] Total deposit amount: $${totalDepositAmount.toFixed(2)}`);
  
  return mapped;
  } catch (error) {
    console.error("[fetchTransactionsBulk] Error");
    // console.error("[fetchTransactionsBulk] Error stack:", error.stack);
    return [];
  }
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
export const fetchCompleteClientData = async (forcePartnerId = null) => {
  const partnerId = forcePartnerId || sessionPartnerId;
  // console.log("=== Fetching Complete Client Data ===");
  // console.log("Using PartnerId:", partnerId, forcePartnerId ? "(forced)" : "(session)");
  
  // Step 1: Get ALL trading accounts for this partner
  const tradingAccounts = await fetchTradingAccountsBulk(partnerId);
  // console.log(`Step 1: ${tradingAccounts.length} trading accounts`);
  
  if (tradingAccounts.length === 0) {
    // console.warn("No trading accounts found for this partner");
    return [];
  }
  
  // Log a full sample to understand structure
  if (tradingAccounts[0]) {
    // console.log("Full sample trading account:", JSON.stringify(tradingAccounts[0], null, 2).substring(0, 1500));
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
  
  // console.log(`Step 2: Grouped into clients`);
  
  // Step 3: Try to fetch leads/customers data to get Approved, LastLogin, Status fields
  // This may return empty for some users (permission-based)
  let leadsData = [];
  try {
    const usernames = Object.keys(clientsMap);
    leadsData = await fetchIBClients(usernames);
    // console.log(`Step 3: Fetched leads/customers records`);
    
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
    // console.warn("Could not fetch leads data (may be permission-based):", e.message);
  }
  
  // Step 4: Get closed trades for volume (lots) calculation
  // Revenue = Sum of XValley's Commission field (not calculated from volume × rate)
  const trades = await fetchClosedTradesBulk(partnerId);
  // console.log(`Step 4: Closed trades`);
  
  // Build map: username -> { totalCommission, totalVolume, tradeCount }
  // Commission comes directly from XValley - includes all calculations (metals, instruments, etc)
  const tradesByUser = {};
  let totalVolume = 0;
  let totalRevenue = 0;  // Base commission from XValley (no fallbacks, no calculations)
  
  trades.forEach((t, idx) => {
    const username = t.username;
    const vol = parseFloat(t.volume) || 0;
    const comm = parseFloat(t.commission) || 0;  // ← 100% from XValley API
    
    if (idx < 3) {
      // console.log(`Trade ${idx + 1}:`, { username, volume: vol, xvalleyCommission: comm, instrument: t.instrument });
    }
    
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
  
  // console.log(`Total Volume & Commission calculated`);
  
  // Step 5: Build final client list with proper Active, Pending, KYC, Lots
  // BaseCommission = Sum of XValley's Commission field per user (not calculated)
  const enrichedClients = Object.values(clientsMap).map(client => {
    const userTrades = tradesByUser[client.username] || { commission: 0, volume: 0, count: 0 };
    
    // Lots = volume for display, Commission = already from XValley
    const lots = Math.round(userTrades.volume * 100) / 100;
    const baseCommission = Math.round(userTrades.commission * 100) / 100;  // From XValley
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
    
    
    // Extract raw referral info from first trading account
    const firstRawAccount = client._rawAccounts?.[0] || {};
    const rawTrader = firstRawAccount.T || {};
    
    return {
      ...client,
      // Fix floating point precision for all financial values
      equity: Math.round(client.equity * 1000) / 1000,
      balance: Math.round(client.balance * 1000) / 1000,
      deposit: Math.round(client.deposit * 100) / 100,
      credit: Math.round(client.credit * 100) / 100,
      availableBalance: Math.round(client.availableBalance * 100) / 100,
      closedPL: Math.round(client.closedPL * 100) / 100,
      
      // Lots from trades volume (for display)
      lots: lots,
      tradeCount: userTrades.count,
      
      // Base commission from XValley (not calculated)
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
  
  // console.log(`Client Summary`);
  
  // // Log first 5 clients for verification with all status fields
  // realClients.slice(0, 5).forEach((c, i) => {
    /* console.log(`Client ${i + 1}:`, {
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
    */
  // });
  
  // console.log("=== Client Data Complete ===");
  return realClients;
};

/**
 * Get network statistics (true ALL-TIME with no date filter)
 * Base Commission pulled from XValley's Commission field
 */
export const fetchNetworkStats = async () => {
  const partnerId = sessionPartnerId;
  
  const trades = await fetchClosedTradesBulk(partnerId, '', '');
  
  let totalVolume = 0;
  let totalPL = 0;
  let totalRevenue = 0;  // Base commission from XValley
  
  trades.forEach(t => {
    const vol = parseFloat(t.volume) || 0;
    const pl = parseFloat(t.profitLoss) || 0;
    const comm = parseFloat(t.commission) || 0;  
    totalVolume += vol;
    totalPL += pl;
    totalRevenue += comm;  
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
 * IMPORTANT: Revenue is Base Commission pulled from XValley's Commission field
 * (Already calculated by XValley based on their tier structure)
 * Volume = Sum of trade.VU (for display only)
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
   // console.log(`[fetchVolumeHistory] Time range ${timeRange}: fetching ALL trades (no date filter)`);
    trades = await fetchClosedTradesBulk(sessionPartnerId, '', '');
  } else {
    const fromStr = formatLocalDate(fromDate);
    const toStr = formatLocalDate(now);
    //console.log(`[fetchVolumeHistory] Time range ${timeRange}: from ${fromStr} to ${toStr}`);
    //console.log(`[fetchVolumeHistory] Current date: ${new Date().toISOString()}, Local today: ${formatLocalDate(now)}`);
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
  
  // Calculate tier bonus based on 3-month rolling commission average
  let tierBonus = 0;
  let tierInfo = { tierRate: 0, tierLabel: 'Base', bonus: 0, avgCommission: 0, monthsInHistory: 0 };
  let totalRevenueWithBonus = totalRevenue;
  
  try {
    // Only calculate bonus if we have revenue in this period
    if (totalRevenue > 0) {
      const history = await fetch3MonthCommissionHistory();
      tierInfo = calculateTierBonus(history, totalRevenue);
      tierBonus = tierInfo.bonus;
      totalRevenueWithBonus = totalRevenue + tierBonus;
      
      console.log(`[fetchVolumeHistory] ${timeRange}: Tier calculated`);
    }
  } catch (err) {
    // console.warn(`[fetchVolumeHistory] Could not calculate tier bonus`);
    // Fallback: just use base commission without bonus
    totalRevenueWithBonus = totalRevenue;
  }
  
  // Revenue = Base Commission from XValley + Tier Bonus (already filtered by PartnerId in fetchClosedTradesBulk)
  
  return { trades, totalVolume, totalPL, totalRevenue: totalRevenueWithBonus, totalRevenueBefore: totalRevenue, tierBonus, tierInfo, fromDate, toDate: now };
};

/**
 * Calculate tier bonus based on 3-month rolling average commission
 * 
 * Tier Logic:
 * - Tier 3: Average >= $4500 → 10% bonus
 * - Tier 2: Average >= $1000 → 8% bonus
 * - Tier 1: Average >= $450 → 4% bonus
 * - Base: Average < $450 → 0% bonus
 * 
 * @param {number[]} commissionHistory - Array of monthly commissions (oldest first)
 * @param {number} currentMonthCommission - Current month's base commission from XValley
 * @returns {Object} { tierRate: number, tierLabel: string, bonus: number }
 */
export const calculateTierBonus = (commissionHistory, currentMonthCommission) => {
  // Ensure we have valid history array
  if (!Array.isArray(commissionHistory) || commissionHistory.length === 0) {
    return { tierRate: 0, tierLabel: 'New', bonus: 0, avgCommission: 0, monthsInHistory: 0 };
  }
  
  // Calculate average from available months (1, 2, or 3 months)
  // Include zeros if month had no trades - they count toward the rolling average
  const validMonths = commissionHistory.filter(c => typeof c === 'number').length;
  
  if (validMonths === 0) {
    return { tierRate: 0, tierLabel: 'New', bonus: 0, avgCommission: 0, monthsInHistory: 0 };
  }
  
  // Average: sum all months / number of months in history (1, 2, or 3)
  const avgCommission = commissionHistory.reduce((sum, c) => sum + (c || 0), 0) / validMonths;
  
  let tierRate = 0;
  let tierLabel = 'Base';
  
  if (avgCommission >= 4500) {
    tierRate = 0.10;
    tierLabel = 'Tier 3 (+10%)';
  } else if (avgCommission >= 1000) {
    tierRate = 0.08;
    tierLabel = 'Tier 2 (+8%)';
  } else if (avgCommission >= 450) {
    tierRate = 0.04;
    tierLabel = 'Tier 1 (+4%)';
  }
  
  // Bonus is applied to CURRENT month's commission (not the average)
  const bonus = Math.round(currentMonthCommission * tierRate * 100) / 100;
  
  return {
    tierRate,
    tierLabel,
    bonus,
    avgCommission: Math.round(avgCommission * 100) / 100,
    monthsInHistory: validMonths
  };
};

/**
 * Fetch 3-month rolling base commission history for bonus tier calculation
 * Returns array of [month1Commission, month2Commission, month3Commission]
 * Commission pulled directly from XValley (not calculated)
 */
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
     // console.error(`[fetch3MonthCommissionHistory] Error fetching month ${i}:`, error);
      history.unshift(0); // Add 0 if fetch fails
    }
  }

  return history;
};

// ============= UTILITY EXPORTS =============

export const fetchCurrentUser = async () => {
  // Return basic user info from session
  return { partnerId: sessionPartnerId };
};

export const fetchTradingAccounts = async (username) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.TRADERS);
  // console.log(`[👤 fetchTradingAccounts] START - Fetching accounts`);
  
  try {
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
    
    // console.log(`[👤 fetchTradingAccounts] Calling TRADERS topic`);
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchTradingAccounts | Topic: ${API_CONFIG.TOPICS.TRADERS} | Request: AdminType=${msg.AdminType}, AccountType=${msg.AccountType}, Filters=${filters.length}`);
    
    const result = await session.call(API_CONFIG.TOPICS.TRADERS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    // Response structure: { Messages: [{ AdminType, Messages: [...actual accounts...], Total }] }
    const wrapper = data?.Messages?.[0];
    const accounts = wrapper?.Messages || [];
    
    // console.log(`[👤 fetchTradingAccounts] Retrieved accounts`);
  
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
  } catch (error) {
    console.error('[👤 fetchTradingAccounts] Error:', error);
    return [];
  }
};

export const fetchClientTrades = async (accountId, fromDate, toDate) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.PLATFORM_CLOSE);
  // console.log(`[📊 fetchClientTrades] START - Fetching trades`);
  
  try {
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
    
    // console.log(`[📊 fetchClientTrades] Calling PLATFORM_CLOSE topic`);
    // console.log(`[📊 fetchClientTrades] DateRange: ${fromDate || 'ALL'} to ${toDate || 'ALL'}`);
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchClientTrades | Topic: ${API_CONFIG.TOPICS.PLATFORM_CLOSE} | Request: AdminType=${msg.AdminType}, AccountType=${msg.AccountType}, PageSize=${msg.PageSize}`);
    
    const result = await session.call(API_CONFIG.TOPICS.PLATFORM_CLOSE, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    // Response structure: { Messages: [{ AdminType, Messages: [...actual trades...], Total }] }
    const wrapper = data?.Messages?.[0];
    const trades = wrapper?.Messages || [];
    
    // console.log(`[📊 fetchClientTrades] Retrieved trades`);
  
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
  } catch (error) {
    console.error('[📊 fetchClientTrades] Error:', error);
    return [];
  }
};

export const fetchClientTransactions = async (accountId) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.DEPOSITS);
  // console.log(`[💰 fetchClientTransactions] START - Fetching transactions`);
  
  try {
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
    
    // console.log(`[💰 fetchClientTransactions] Calling DEPOSITS topic`);
    
    // Log API call details for XValley support
    console.log(`[XVALLEY_API] fetchClientTransactions | Topic: ${API_CONFIG.TOPICS.DEPOSITS} | Request: AdminType=${msg.AdminType}, AccountType=${msg.AccountType}, PageSize=${msg.PageSize}`);
    
    const result = await session.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const transactions = data?.Messages || [];
    // console.log(`[💰 fetchClientTransactions] Retrieved transactions`);
    
    return transactions.map(t => ({
      id: t.Id,
      amount: t.AA || 0,
      date: t.D,
      type: t.TSN,
      side: t.TS,
      sideLabel: t.TS === 1 ? 'Deposit' : t.TS === 2 ? 'Withdrawal' : 'Adjustment',
      state: t.StS
    }));
  } catch (error) {
    console.error('[💰 fetchClientTransactions] Error:', error);
    return [];
  }
};



// Subscription stubs
export const subscribeToTradeUpdates = (callback) => {
  // Both ADMIN and TRADE sessions can use wsSessionId for subscriptions
  // Use admin session since it's more stable for session subscriptions
  if (!wsSessionAdmin || !wsSessionId) {
    // console.warn("[🔔 subscribeToTradeUpdates] Not connected");
    return;
  }
  
  // console.log("[🔔 subscribeToTradeUpdates] Subscribing to trade updates");
  wsSessionAdmin.subscribe(wsSessionId, (args) => {
    const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
    if (msg.MessageType === 20) {
      // console.log("[🔔 subscribeToTradeUpdates] Trade update received");
      callback(msg);
    }
  });
};

export const subscribeToAccountEvents = (callback) => {
  if (!wsSessionAdmin || !wsSessionId) {
    // console.warn("[🔔 subscribeToAccountEvents] Not connected");
    return;
  }
  
  // console.log("[🔔 subscribeToAccountEvents] Subscribing to account events");
  wsSessionAdmin.subscribe(wsSessionId, (args) => {
    const msg = typeof args[0] === 'string' ? JSON.parse(args[0]) : args[0];
    if (msg.MessageType === 30 || msg.MessageType === 40) {
      // console.log(`[🔔 subscribeToAccountEvents] Account event received`);
      callback(msg);
    }
  });
};

export const subscribeToSystemAlerts = (callback) => {
  // Stub for alerts
};

export const fetchAccountTypes = async () => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.ACCOUNT_TYPES);
  // console.log("[📋 fetchAccountTypes] START - Fetching account types");
  
  try {
    const result = await session.call(API_CONFIG.TOPICS.ACCOUNT_TYPES, [JSON.stringify({ MessageType: 100 })]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const types = data?.Messages || [];
    // console.log(`[📋 fetchAccountTypes] Retrieved account types`);
    
    return types;
  } catch (error) {
    console.error("[📋 fetchAccountTypes] Error:", error);
    return [];
  }
};

export const fetchAccountLevels = async () => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.ACCOUNT_LEVELS);
  // console.log("[📊 fetchAccountLevels] START - Fetching account levels");
  
  try {
    const result = await session.call(API_CONFIG.TOPICS.ACCOUNT_LEVELS, [JSON.stringify({ MessageType: 100 })]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    const levels = data?.Messages || [];
    // console.log(`[📊 fetchAccountLevels] Retrieved account levels`);
    
    return levels;
  } catch (error) {
    console.error("[📊 fetchAccountLevels] Error:", error);
    return [];
  }
};

export const saveUserDetails = async (userData) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.SAVE_USER);
  // console.log("[💾 saveUserDetails] START - Saving user details");
  
  try {
    const msg = { MessageType: 100, Messages: [userData] };
    
    // console.log("[💾 saveUserDetails] Calling SAVE_USER topic");
    const result = await session.call(API_CONFIG.TOPICS.SAVE_USER, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    // console.log("[💾 saveUserDetails] User saved successfully");
    
    return data;
  } catch (error) {
    console.error("[💾 saveUserDetails] Error saving user:", error);
    throw error;
  }
};

export const resetUserPassword = async (username) => {
  // Stub
  return { success: true };
};

/**
 * Change password for logged-in user
 * Tries HTTP endpoint first (com.fxplayer), falls back to WAMP call if HTTP fails
 * @param {string} oldPassword - Current password
 * @param {string} newPassword - New password
 * @returns {Promise<{success: boolean, message: string}>}
 */
export const changePasswordForLoggedInUser = async (oldPassword, newPassword) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.RESET_PASSWORD);
  
  if (!getAccessToken()) throw new Error("No access token available");
  
  console.log("[🔐 changePasswordForLoggedInUser] START - Attempting password change...");
  
  // Method 1: Try HTTP endpoint first (most reliable)
  try {
    console.log("[🔐 changePasswordForLoggedInUser] Attempting HTTP method via /profile/reset/");
    
    const httpRes = await fetch(`${API_CONFIG.API_BASE_URL}/profile/reset/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + getAccessToken()
      },
      body: JSON.stringify({
        OldPassword: oldPassword,
        NewPassword: newPassword,
        ConfirmPassword: true
      })
    });
    
    const responseText = await httpRes.text();
    console.log(`[🔐 changePasswordForLoggedInUser] HTTP Response Status: ${httpRes.status}`);
    
    if (httpRes.ok) {
      console.log("[🔐 changePasswordForLoggedInUser] ✅ HTTP method succeeded");
      return { success: true, message: "Password updated successfully" };
    }
    
    console.warn("[🔐 changePasswordForLoggedInUser] ⚠️  HTTP method failed, falling back to WAMP...");
  } catch (httpError) {
    console.warn("[🔐 changePasswordForLoggedInUser] HTTP method error:", httpError.message);
  }
  
  // Method 2: Fallback to WAMP/WebSocket method
  try {
    console.log("[🔐 changePasswordForLoggedInUser] Attempting WAMP method via RESET_PASSWORD topic");
    
    const msg = {
      MessageType: 100,
      Messages: [{
        Email: wsSessionId,  // Use session username/email
        OldPassword: oldPassword,
        NewPassword: newPassword,
        ConfirmPassword: newPassword === newPassword  // Always true
      }]
    };
    
    console.log("[🔐 changePasswordForLoggedInUser] Calling RESET_PASSWORD via ADMIN WebSocket...");
    const result = await session.call(API_CONFIG.TOPICS.RESET_PASSWORD, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    if (data.MessageType === 200 || data.MessageType === '200') {
      console.log("[🔐 changePasswordForLoggedInUser] ✅ WAMP method succeeded");
      return { success: true, message: "Password updated successfully via WAMP" };
    } else {
      throw new Error(data.Messages?.[0] || "WAMP password change failed");
    }
  } catch (wampError) {
    console.error("[🔐 changePasswordForLoggedInUser] WAMP method error:", wampError);
    return { 
      success: false, 
      message: `Password change failed: ${wampError.message}` 
    };
  }
};

/**
 * Submit withdrawal request to XValley via WebSocket Admin API
 * Sends withdrawal to com.fxplayer.deposit topic (DEPOSITS topic)
 * Will appear in XValley admin dashboard for actionable withdrawal approval
 * @param {object} withdrawalData - Withdrawal details
 * @returns {Promise<{success: boolean, message: string, data?: object}>}
 */
export const submitWithdrawalRequest = async (withdrawalData) => {
  const session = getSessionForTopic(API_CONFIG.TOPICS.DEPOSITS);
  
  console.log("[💰 submitWithdrawalRequest] START - Submitting withdrawal request amount:", withdrawalData?.amount);
  
  try {
    
    // Build withdrawal message per XValley Backoffice API spec (page 18-19)
    // TS: 2 = Withdrawal (vs 1 = Deposit)
    const msg = {
      MessageType: 100,
      Username: wsSessionId,
      Messages: [{
        TA: withdrawalData.amount || 0,           // TransactionAmount
        AA: withdrawalData.amount || 0,           // AccountAmount
        F: withdrawalData.fee || 0,               // Fee
        R: withdrawalData.rate || 1,              // Rate
        D: withdrawalData.date || new Date().toISOString(),  // Date
        TId: withdrawalData.typeId || 1,          // Type (1=BankWire, 2=Crypto, etc)
        TCId: withdrawalData.currencyId || 1,     // Transaction Currency
        ACId: withdrawalData.accountCurrencyId || 1,  // Account Currency
        St: withdrawalData.state || 1,            // State (1=Pending)
        TrId: withdrawalData.accountId,           // TraderAccountId (required)
        In: withdrawalData.reference || "",       // Reference/Invoice
        TS: 2                                     // Side: 2 = Withdrawal
      }]
    };
    
    console.log("[💰 submitWithdrawalRequest] Calling DEPOSITS topic via TRADE WebSocket with TS=2 (Withdrawal)...");
    console.log("[💰 submitWithdrawalRequest] Request details:", {
      amount: withdrawalData.amount,
      fee: withdrawalData.fee,
      accountId: withdrawalData.accountId,
      typeId: withdrawalData.typeId
    });
    
    // Call XValley WebSocket deposit topic
    const result = await session.call(API_CONFIG.TOPICS.DEPOSITS, [JSON.stringify(msg)]);
    const data = typeof result === 'string' ? JSON.parse(result) : result;
    
    // Check response status
    if (data.MessageType === 200) {
      // MessageType 200 = OK
      console.log("[💰 submitWithdrawalRequest] ✅ Withdrawal submitted successfully to XValley admin");
      return { 
        success: true, 
        message: 'Withdrawal submitted successfully. Check your XValley admin dashboard.',
        data: data 
      };
    } else if (data.MessageType === -3) {
      // MessageType -3 = Error
      const errorMsg = data.Messages?.[0] || 'Withdrawal submission failed';
      console.error("[💰 submitWithdrawalRequest] ❌ XValley error:", errorMsg);
      throw new Error(errorMsg);
    } else {
      // Unexpected response
      console.log("[💰 submitWithdrawalRequest] ℹ️  Unexpected response type:", data.MessageType);
      return { 
        success: true, 
        message: 'Withdrawal submitted',
        data: data 
      };
    }
  } catch (error) {
    console.error("[💰 submitWithdrawalRequest] ❌ Error submitting withdrawal:", error);
    return { 
      success: false, 
      message: error.message || 'Failed to submit withdrawal request'
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

// ============= CAMPAIGN MANAGEMENT (FOR MARKETING VIEW) =============

/**
 * Save campaign to Supabase
 */
export const saveCampaign = async (campaign) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      // console.log('[Campaigns] Partner ID not available yet, waiting...');
      partnerId = await ensurePartnerIdAvailable();
    }
    if (!partnerId) {
      console.error('[Campaigns] No partner ID found after waiting');
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

    // console.log(`[Campaigns] Saved campaign: ${campaignObj.name} for partner ${partnerId}`);
    return campaignObj.id;
  } catch (error) {
    console.error('[Campaigns] Exception saving campaign:', error);
    // Fallback to localStorage
    return saveCampaignLocal(campaign);
  }
};

/**
 * Get all campaigns for current partner from Supabase
 */
export const getCampaigns = async () => {
  try {
    let partnerId = getSessionPartnerId();
    
    // If partner ID not yet available, wait for it (WebSocket may still be connecting)
    if (!partnerId) {
      // console.log('[Campaigns] Partner ID not available yet, waiting for WebSocket...');
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
      return getCampaignsLocal();
    }

    // Convert snake_case to camelCase for consistency
    const campaigns = (data || []).map(c => ({
      ...c,
      referrerTag: c.referrer_tag,
      createdDate: c.created_date,
      updatedDate: c.updated_date
    }));

    // console.log(`[Campaigns] Successfully fetched ${campaigns.length} campaigns for partner ${partnerId}`);
    if (campaigns.length > 0) {
      // console.log('[Campaigns] First campaign:', campaigns[0]);
    }
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

    // console.log(`[Campaigns] Deleted campaign: ${id} for partner ${partnerId}`);
    return true;
  } catch (error) {
    console.error('[Campaigns] Exception deleting campaign:', error);
    return false;
  }
};

/**
 * Get campaign performance stats by matching referrerTag with customer Referrer field
 * Returns: {
 *   signups: number,
 *   activeClients: number,
 *   totalRevenue: number,
 *   roi: number (in %),
 *   clients: array of matching clients
 * }
 */
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

// ============= ASSET MANAGEMENT (FOR MARKETING VIEW) =============

/**
 * Save marketing asset to Supabase Storage + Database (source of truth)
 */
export const saveAsset = async (asset) => {
  try {
    let partnerId = getSessionPartnerId();
    if (!partnerId) {
      // console.log('[Assets] Partner ID not available yet, waiting...');
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
      // console.log(`[Assets] Uploading file to Storage: ${asset.fileName}`);
      
      try {
        // Convert base64 to blob
        const response = await fetch(asset.fileData);
        const blob = await response.blob();
        
        // Upload to Storage
        const storagePath = `partner_${partnerId}/${assetId}/${asset.fileName}`;
        const fileUrl = await uploadFileToStorage('nommia-ib', storagePath, blob);
        
        if (fileUrl) {
          fileDataOrUrl = fileUrl;  // Store URL in database
          // console.log(`[Assets] File uploaded to Storage: ${fileUrl}`);
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

    // console.log(`[Assets] Saved to Supabase: ${assetObj.name} for partner ${partnerId}`);
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

    // console.log(`[Assets] Loaded ${assets.length} assets from Supabase`);
    // if (assets.length > 0) {
    //   const first = assets[0];
    //   console.log('[Assets] First asset:', {
    //     name: first.name,
    //     type: first.type,
    //     hasFileData: !!(first.fileData || first.file_data),
    //     fileDataLength: (first.fileData || first.file_data) ? String(first.fileData || first.file_data).length : 0
    //   });
    // }
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
        // console.log(`[Assets] Deleting file from Storage: ${storagePath}`);
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

    // console.log(`[Assets] Deleted asset: ${id} for partner ${partnerId}`);
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
    // console.log(`[Campaigns] Saved campaign to localStorage: ${campaign.name}`);
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
    // console.log(`[Assets] Saved to localStorage with fileData: ${asset.name}`);
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

// ============= NUDGE EMAIL =============
export const sendNudgeEmail = async (recipientEmail, partnerName, referrerName, nudgeType, tier, partnerId) => {
  try {
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/nudges/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recipientEmail,
        recipientName: partnerName,
        referrerName,
        nudgeType,
        tier,
        partnerId
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      return { success: false, error: errorData.error || 'Failed to send nudge' };
    }
    
    const data = await response.json();
    return { success: true, messageId: data.messageId };
  } catch (error) {
    console.error('[Nudge] Error:', error);
    return { success: false, error: error.message };
  }
};

export const getNudgeHistory = async () => {
  try {
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/nudges/history`);
    if (!response.ok) throw new Error('Failed to fetch nudge history');
    return await response.json();
  } catch (error) {
    console.error('[Nudge History] Error:', error);
    return [];
  }
};

// ============= OTP VERIFICATION (For Settings Page) =============
/**
 * Send OTP to user's email via Nommia backend
 * @param {string} email - User's email address
 * @param {string} type - Type of OTP: 'security' (for settings changes) or 'password' (for password reset)
 * @returns {Promise<{success: boolean, message: string}>}
 */
export const sendOTP = async (email, type = 'security') => {
  try {
    // Normalize email: trim whitespace and convert to lowercase
    email = email ? String(email).trim().toLowerCase() : '';
    // console.log(`[OTP] Sending ${type} OTP to ${email}`);
    
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        type: type  // 'security' for settings, 'password' for password reset
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `Failed to send ${type} OTP`);
    }
    
    const data = await response.json();
    // console.log(`[OTP] Successfully sent ${type} OTP to ${email}`);
    return {
      success: true,
      message: data.message || `${type} code sent to ${email}`
    };
  } catch (error) {
    console.error(`[OTP] Error sending ${type} OTP:`, error);
    return {
      success: false,
      message: error.message
    };
  }
};

/**
 * Verify OTP code from user's email
 * @param {string} email - User's email address
 * @param {string} code - OTP code entered by user (typically 6 digits)
 * @param {string} type - Type of OTP: 'security' or 'password'
 * @returns {Promise<{success: boolean, message: string}>}
 */
export const verifyOTP = async (email, code, type = 'security') => {
  try {
    // Normalize email: trim whitespace and convert to lowercase
    email = email ? String(email).trim().toLowerCase() : '';
    // console.log(`[OTP] Verifying ${type} OTP for ${email}`);
    
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: email,
        code: code,
        type: type
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Invalid or expired OTP code');
    }
    
    const data = await response.json();
    // console.log(`[OTP] Successfully verified ${type} OTP for ${email}`);
    return {
      success: true,
      message: data.message || `${type} verified successfully`
    };
  } catch (error) {
    console.error(`[OTP] Error verifying ${type} OTP:`, error);
    return {
      success: false,
      message: error.message
    };
  }
};

// ============= PAYOUT DETAILS (Nommia Backend) =============
/**
 * Save payout/payment details to Nommia backend
 * Called after OTP verification in settings page
 * @param {object} paymentDetails - Payment details object with bank/crypto info
 * @returns {Promise<object>} - Response from Nommia backend
 */
export const savePayoutDetails = async (paymentDetails) => {
  try {
    const partnerId = getSessionPartnerId() || paymentDetails.partnerId;
    const userEmail = localStorage.getItem('email') || paymentDetails.email;
    
    // console.log(`[Payouts] Saving payout details for partnerId: ${partnerId}`);
    
    // Call Nommia backend instead of XValley
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payout/save`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}` // Include auth token if available
      },
      body: JSON.stringify({
        partnerId: partnerId,
        email: userEmail,
        ...paymentDetails
      })
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || 'Failed to save payout details');
    }
    
    const data = await response.json();
    // console.log(`[Payouts] Successfully saved payout details`);
    return data;
  } catch (error) {
    console.error('[Payouts] Error saving:', error);
    throw error;
  }
};

/**
 * Retrieve payout details from Nommia backend
 * @param {string} partnerId - Partner ID to fetch details for
 * @returns {Promise<object|null>} - Payout details object or null if not found
 */
export const getPayoutDetails = async (partnerId = null) => {
  try {
    const id = partnerId || getSessionPartnerId();
    if (!id) throw new Error('No partner ID available');
    
    // console.log(`[Payouts] Fetching payout details for partnerId: ${id}`);
    
    // Call Nommia backend instead of XValley
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payout/${id}`, {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // console.log(`[Payouts] No payout details found for partnerId: ${id}`);
        return null;
      }
      throw new Error('Failed to fetch payout details');
    }
    
    const data = await response.json();
    // console.log(`[Payouts] Successfully fetched payout details`);
    return data.data || null;
  } catch (error) {
    console.error('[Payouts] Error fetching:', error);
    return null;
  }
};

/**
 * Delete payout details from Nommia backend
 * @param {string} partnerId - Partner ID to delete details for
 * @returns {Promise<object>} - Response from Nommia backend
 */
export const deletePayoutDetails = async (partnerId = null) => {
  try {
    const id = partnerId || getSessionPartnerId();
    if (!id) throw new Error('No partner ID available');
    
    // console.log(`[Payouts] Deleting payout details for partnerId: ${id}`);
    
    // Call Nommia backend instead of XValley
    const response = await fetch(`${API_CONFIG.BACKEND_URL}/api/payout/${id}`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    
    if (!response.ok) throw new Error('Failed to delete payout details');
    
    const data = await response.json();
    // console.log(`[Payouts] Successfully deleted payout details`);
    return data;
  } catch (error) {
    console.error('[Payouts] Error deleting:', error);
    throw error;
  }
};

// Legacy exports for compatibility
export const fetchNommiaClients = fetchIBClients;
export const fetchNetworkVolume = fetchNetworkStats;

// ============= USER MANAGEMENT (ADMIN ONLY) =============

/**
 * Check if current user is an Admin
 * Checks if 'admin' is in the session roles from PING response
 */
export const isAdminUser = () => {
  if (!sessionRoles || sessionRoles.length === 0) return false;
  const normRoles = sessionRoles.map(r => normalizeRoleFormat(r)).filter(Boolean);
  return normRoles.includes('Admin');
};

export const fetchAllUsersForManagement = async () => {
  if (!isAdminUser()) throw new Error("Only admins can fetch user management data");
  
  try {
    console.log("[👥 fetchAllUsersForManagement] START - Fetching all company users...");
    const allUsers = await fetchAllCompanyUsers();
    
    console.log(`[👥 fetchAllUsersForManagement] ✅ Got ${allUsers.length} users from XValley, fetching roles from Supabase...`);
    
    // Fetch all user roles from Supabase
    const { data: userRoles, error: err } = await supabase
      .from('user_roles')
      .select('*');
    
    if (err) {
      console.error('[👥 fetchAllUsersForManagement] ⚠️  Supabase error:', err);
      // Continue with users only if Supabase fails
      return allUsers.map(user => ({
        ...user,
        localRole: 'IB', // Default role
        assignedCountry: null,
        assignedRegion: null
      }));
    }
    
    // Create a map of user roles keyed by userId
    const roleMap = {};
    if (userRoles && Array.isArray(userRoles)) {
      userRoles.forEach(role => {
        roleMap[role.user_id] = role;
      });
    }
    
    // Merge users with role data
    return allUsers.map(user => {
      const role = roleMap[user.id] || {};
      return {
        ...user,
        localRole: role.role || 'IB',
        assignedCountry: role.assigned_country || null,
        assignedRegion: role.assigned_region || null,
        regionManagers: role.region_managers || [] // For regional managers
      };
    });
  } catch (error) {
    console.error("[👥 fetchAllUsersForManagement] ❌ Error:", error);
    throw error;
  }
};

/**
 * Update user role in BOTH XValley AND Supabase
 * Used by admins to assign roles (IB, CountryManager, RegionalManager)
 * @param {number} userId - XValley user ID
 * @param {string} role - New role (IB, CountryManager, RegionalManager)
 * @param {string|null} assignedCountry - Country code if CountryManager
 * @param {Array|null} regionManagers - Array of manager IDs if RegionalManager
 * @param {object} userData - User data object (for XValley update)
 * @returns {Promise<object>} Updated role record
 */
export const updateUserRole = async (userId, role, assignedCountry = null, regionManagers = null, userData = null) => {
  if (!isAdminUser()) throw new Error("Only admins can update user roles");
  
  try {
    console.log(`[👤 updateUserRole] START - Updating user ${userId} role to: ${role}`);
    
    // Step 1: Update in XValley via WebSocket (if userData provided)
    if (userData) {
      const session = getSessionForTopic(API_CONFIG.TOPICS.SAVE_USER);
      
      try {
        console.log(`[👤 updateUserRole] Updating in XValley...`);
        
        // Map role name to XValley AccessRoles format
        // Nommia roles: IB, CountryManager, RegionalManager
        // Sent to XValley as AccessRoles (may need adjustment based on XValley's expected format)
        const xvalleyRoleString = role === 'CountryManager' ? 'countrymanager' : 
                                  role === 'RegionalManager' ? 'regionalmanager' : 
                                  'ib';
        
        const xvalleyUpdateData = {
          ...userData,
          // Try to update AccessRoles in XValley
          // This field may vary - could be 'Role', 'AccessRoles', or 'UserType'
          AccessRoles: [xvalleyRoleString],  // Try as array
          Role: xvalleyRoleString,            // Try as string
          UpdatedRole: role                   // Our format
        };
        
        const msg = { 
          MessageType: 100, 
          Messages: [xvalleyUpdateData] 
        };
        
        console.log(`[👤 updateUserRole] Calling SAVE_USER topic via ADMIN WebSocket...`);
        
        const xvalleyResult = await session.call(API_CONFIG.TOPICS.SAVE_USER, [JSON.stringify(msg)]);
        const xvalleyData = typeof xvalleyResult === 'string' ? JSON.parse(xvalleyResult) : xvalleyResult;
        
        // Check for error response from XValley
        if (xvalleyData.MessageType === -3) {
          console.warn(`[👤 updateUserRole] ⚠️  XValley returned error: ${xvalleyData.Messages?.[0] || 'Unknown error'}`);
          // Don't throw - continue to save locally even if XValley update fails
        } else if (xvalleyData.MessageType === 200) {
          console.log(`[👤 updateUserRole] ✅ Successfully updated user ${userId} in XValley`);
        }
      } catch (xvalleyError) {
        console.warn('[👤 updateUserRole] ⚠️  XValley update warning (will still save locally):', xvalleyError.message);
        // Don't throw - we'll save locally as fallback
      }
    }
    
    // Step 2: Update in Supabase (always do this for local role management)
    const { data, error } = await supabase
      .from('user_roles')
      .upsert(
        {
          user_id: userId,
          role: role,
          assigned_country: role === 'CountryManager' ? assignedCountry : null,
          assigned_region: role === 'RegionalManager' ? assignedCountry : null,
          region_managers: role === 'RegionalManager' && Array.isArray(regionManagers) ? regionManagers : [],
          updated_at: new Date().toISOString()
        },
        { onConflict: 'user_id' }
      )
      .select();
    
    if (error) {
      console.error('[updateUserRole] Supabase error:', error);
      throw error;
    }
    
    // console.log(`[updateUserRole] Successfully updated user ${userId} in Supabase`);
    return data?.[0] || null;
  } catch (error) {
    console.error("[updateUserRole] Error:", error);
    throw error;
  }
};

/**
 * Fetch nudge rules for current admin session
 * Rules are stored per admin (using partner_id or admin_id)
 * @returns {Promise<object>} Nudge rules configuration
 */
export const fetchNudgeRules = async () => {
  try {
    const adminId = getSessionPartnerId() || sessionPartnerId;
    if (!adminId) {
      console.warn('[fetchNudgeRules] No admin/partner ID available');
      return {
        cooldown_hours: 24,
        max_nudges_per_client: 5,
        ib_qualification_threshold: 5
      };
    }
    
    // Fetch nudge rules for THIS specific admin
    const { data, error } = await supabase
      .from('nudge_rules')
      .select('*')
      .eq('admin_id', adminId)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      console.error('[fetchNudgeRules] Supabase error:', error);
      return {
        cooldown_hours: 24,
        max_nudges_per_client: 5,
        ib_qualification_threshold: 5
      };
    }
    
    if (!data) {
      console.log(`[fetchNudgeRules] No rules found for admin ${adminId}, using defaults`);
      return {
        cooldown_hours: 24,
        max_nudges_per_client: 5,
        ib_qualification_threshold: 5
      };
    }
    
    console.log(`[fetchNudgeRules] Loaded rules for admin ${adminId}:`, data);
    return {
      cooldown_hours: data.cooldown_hours || 24,
      max_nudges_per_client: data.max_nudges_per_client || 5,
      ib_qualification_threshold: data.ib_qualification_threshold || 5
    };
  } catch (error) {
    console.error("[fetchNudgeRules] Error:", error);
    return {
      cooldown_hours: 24,
      max_nudges_per_client: 5,
      ib_qualification_threshold: 5
    };
  }
};

/**
 * Save nudge rules and qualification threshold for current admin session
 * Rules are stored per admin (using partner_id or admin_id)
 * @param {number} cooldownHours - How often nudges can be sent (in hours)
 * @param {number} maxNudgesPerClient - Maximum nudges allowed per client
 * @param {number} ibQualificationThreshold - Minimum clients needed for IB qualification (optional)
 * @returns {Promise<object>} Saved rules
 */
export const saveNudgeRules = async (cooldownHours, maxNudgesPerClient, ibQualificationThreshold = 5) => {
  if (!isAdminUser()) throw new Error("Only admins can update nudge rules");
  
  try {
    const adminId = getSessionPartnerId() || sessionPartnerId;
    if (!adminId) throw new Error("No admin/partner ID available");
    
    console.log(`[saveNudgeRules] Saving rules for admin ${adminId}: cooldown=${cooldownHours}h, max=${maxNudgesPerClient}, threshold=${ibQualificationThreshold}`);
    
    // Upsert nudge rules for THIS specific admin
    const { data, error } = await supabase
      .from('nudge_rules')
      .upsert(
        {
          admin_id: adminId,  // Key for account-specific rules
          cooldown_hours: cooldownHours,
          max_nudges_per_client: maxNudgesPerClient,
          ib_qualification_threshold: ibQualificationThreshold,
          updated_at: new Date().toISOString()
        },
        { onConflict: 'admin_id' }  // Update if exists for this admin
      )
      .select();
    
    if (error) {
      console.error('[saveNudgeRules] Supabase error:', error);
      throw error;
    }
    
    console.log(`[saveNudgeRules] Successfully saved rules for admin ${adminId}`);
    return data?.[0] || null;
  } catch (error) {
    console.error("[saveNudgeRules] Error:", error);
    throw error;
  }
};

/**
 * Get users filtered by assigned country (for Country Manager view)
 * Returns all IBs assigned to that country
 * @param {string} countryCode - 2-letter ISO country code
 * @param {Array} allUsers - All users array
 * @returns {Array} Filtered user list
 */
export const getUsersByCountry = (countryCode, allUsers) => {
  if (!countryCode || !Array.isArray(allUsers)) return [];
  
  return allUsers.filter(user => {
    // If user is IB and their referrer is a CountryManager for this country
    if (user.localRole === 'IB') {
      // Check if their referrer is a CM for this country
      const referrer = allUsers.find(u => u.id === user.referrer);
      return referrer && referrer.localRole === 'CountryManager' && referrer.assignedCountry === countryCode;
    }
    return false;
  });
};

/**
 * Get users filtered by regional manager
 * Returns all IBs within countries managed by this regional manager
 * @param {number} managerId - Regional Manager's user ID
 * @param {Array} allUsers - All users array
 * @returns {Array} Filtered user list
 */
export const getUsersByRegionalManager = (managerId, allUsers) => {
  if (!managerId || !Array.isArray(allUsers)) return [];
  
  const result = [];
  
  // Get all country managers under this regional manager
  const countryManagers = allUsers.filter(user => {
    if (user.localRole === 'CountryManager') {
      // Check if this CM reports to the RM
      return user.referrer === managerId || (user.regionManagers && user.regionManagers.includes(managerId));
    }
    return false;
  });
  
  // Get all IBs under those country managers
  countryManagers.forEach(cm => {
    const ibsUnderCM = allUsers.filter(user => user.referrer === cm.id);
    result.push(...ibsUnderCM);
  });
  
  return result;
};

/**
 * Get all IBs for an IB/Partner (standard view)
 * Returns direct referrals only
 * @param {number} ibId - IB's user ID
 * @param {Array} allUsers - All users array
 * @returns {Array} Direct referrals
 */
export const getIBDirectReferrals = (ibId, allUsers) => {
  if (!ibId || !Array.isArray(allUsers)) return [];
  
  return allUsers.filter(user => {
    return user.referrer === ibId && user.localRole === 'IB';
  });
};
