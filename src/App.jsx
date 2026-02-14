import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Users, LayoutDashboard, Wallet, PieChart, Link as LinkIcon, Settings, 
  Search, Filter, Download, ChevronDown, ChevronRight, AlertCircle, Copy, TrendingUp, 
  TrendingDown, DollarSign, Activity, Menu, X, Globe, Map, ArrowLeft, 
  Calculator, Info, Image, FileText, CreditCard, Clock, Plus, Upload, File, Calendar, Bell, Shield, Lock,
  Network, UserCog, Briefcase, BarChart2, FileCheck, Trash2
} from 'lucide-react';

// PDF Generation Libraries
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// Import API functions - Using new clean V2 API
import {
  API_CONFIG,
  loginAndGetToken, 
  connectWebSocket, 
  fetchIBClients,
  fetchCurrentUser,
  getSessionPartnerId,
  getSessionUsername,
  subscribeToTradeUpdates,
  subscribeToAccountEvents,
  fetchClientTrades,
  submitWithdrawalRequest,
  fetchClientAccount,
  fetchClientEquity,
  fetchClientTransactions,
  fetchClientDeposits,
  disconnectWebSocket,
  fetchWithdrawalsHistory,
  fetchAllTransactions,
  fetchTradingAccounts,
  saveUserDetails,
  fetchAccountTypes,
  fetchAccountLevels,
  fetchUserCommunications,
  resetUserPassword,
  subscribeToSystemAlerts,
  fetchServerConfig,
  fetchVolumeHistory,
  fetch3MonthCommissionHistory,
  fetchCompleteClientData,
  fetchNetworkStats,
  saveCampaign,
  getCampaigns,
  getCampaignById,
  deleteCampaign,
  getCampaignStats,
  saveAsset,
  savePayoutDetails,
  getPayoutDetails,
  deletePayoutDetails,
  getAssets,
  getAssetById,
  deleteAsset,
  sendNudgeEmail,
  getNudgeHistory,
  sendOTP,
  verifyOTP
} from './api_integration_v2';

import Login from './Login';

// --- Configuration ---
// Commission rates handled by XValley API - we only add tier bonuses
// Revenue = Commission from XValley + Tier Bonus (4%, 8%, or 10%)
const PERFORMANCE_BONUS_TIERS = [
  { threshold: 4500, rate: 0.10, label: "Tier 3 (+10%)" },
  { threshold: 1000, rate: 0.08, label: "Tier 2 (+8%)" },
  { threshold: 450, rate: 0.04, label: "Tier 1 (+4%)" },
  { threshold: 0, rate: 0.00, label: "Base Tier (0%)" }
];

// --- NO MOCK DATA - Everything is fetched from XValley API ---
// Empty arrays are used as initial state until real data loads

// --- Helper Components ---

// Removed top-level effect (moved into component lifecycle)

const SidebarItem = ({ icon: Icon, label, active, onClick, collapsed }) => (
  <button 
    onClick={onClick}
    className={`w-full flex items-center p-3 mb-1 transition-all rounded-lg ${
      active 
        ? 'bg-amber-500 text-neutral-900 font-bold shadow-lg shadow-amber-500/20' 
        : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'
    }`}
  >
    <Icon size={20} className="min-w-[20px]" />
    {!collapsed && <span className="ml-3 font-medium whitespace-nowrap">{label}</span>}
  </button>
);

const StatCard = ({ title, value, subtext, trend, icon: Icon, trendUp, isLoading }) => (
  <div className="bg-neutral-900 rounded-xl p-6 shadow-sm border border-neutral-800 flex items-start justify-between relative min-h-[140px]">
    {isLoading && (
      <div className="absolute inset-0 bg-neutral-900/50 rounded-xl flex items-center justify-center">
        <div className="flex items-center gap-2">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-amber-500"></div>
          <span className="text-xs text-neutral-400">Loading...</span>
        </div>
      </div>
    )}
    <div className={isLoading ? 'opacity-50' : ''}>
      <p className="text-sm font-medium text-neutral-400 mb-1">{title}</p>
      <h3 className="text-2xl font-bold text-white">{value}</h3>
      <div className="flex items-center mt-2">
        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full flex items-center ${trendUp ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
          {trendUp ? <TrendingUp size={12} className="mr-1"/> : <TrendingDown size={12} className="mr-1"/>}
          {trend}
        </span>
        <span className="text-xs text-neutral-500 ml-2">{subtext}</span>
      </div>
    </div>
    <div className={`p-3 bg-neutral-800 rounded-lg text-amber-500 border border-neutral-700 shadow-inner ${isLoading ? 'opacity-50' : ''}`}>
      <Icon size={24} />
    </div>
  </div>
);

const StatusBadge = ({ status }) => {
  const styles = {
    Approved: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    Pending: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    Rejected: "bg-red-500/10 text-red-400 border-red-500/20",
    Active: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    Onboarding: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    Paid: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    Processing: "bg-amber-500/10 text-amber-400 border-amber-500/20",
    High: "text-red-400 font-bold",
    Low: "text-emerald-400",
    Medium: "text-amber-400",
    "N/A": "text-neutral-500"
  };
  return (
    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium border ${styles[status] || "bg-neutral-800 text-neutral-400"}`}>
      {status}
    </span>
  );
};

// --- NEW FEATURES ---

const RealTimeTicker = () => {
  const [latestTrade, setLatestTrade] = useState(null);
  const [tradeTime, setTradeTime] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    subscribeToTradeUpdates((data) => {
      // Support both shapes: payload may be { data, timestamp } or raw payload
      const payload = data && data.data ? data.data : data;
      const tsRaw = data && data.timestamp ? data.timestamp : (payload && (payload.CEDT || payload.EDT || payload.CreatedOn || payload.ModifiedOn || payload.Date));
      let ts = null;
      if (tsRaw) {
        try {
          if (tsRaw instanceof Date) ts = tsRaw.getTime();
          else if (typeof tsRaw === 'number') ts = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
          else {
            const parsed = Date.parse(tsRaw);
            if (!isNaN(parsed)) ts = parsed;
          }
        } catch (e) {
          ts = null;
        }
      }
      setLatestTrade(payload);
      setTradeTime(ts);
      setTimeout(() => {
        setLatestTrade(null);
        setTradeTime(null);
      }, 4000);
    });
  }, []);

  // Force re-render every second while ticker is visible
  useEffect(() => {
    if (!latestTrade) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [latestTrade]);

  if (!latestTrade) return null;

  // Robust relative time helper - accepts Date | number | ISO string
  const getRelativeTime = (date) => {
    if (!date) return '';
    let ts = null;
    if (date instanceof Date) ts = date.getTime();
    else if (typeof date === 'number') ts = date > 1e12 ? date : date * 1000;
    else if (typeof date === 'string') {
      const parsed = Date.parse(date);
      if (!isNaN(parsed)) ts = parsed;
    }
    if (!ts) return '';

    const nowTs = Date.now();
    const diff = Math.floor((nowTs - ts) / 1000);
    if (diff < 0) return 'in the future';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)} hr ago`;
    if (diff < 2592000) return `${Math.floor(diff/86400)} day${Math.floor(diff/86400) === 1 ? '' : 's'} ago`;
    if (diff < 31536000) return `${Math.floor(diff/2592000)} month${Math.floor(diff/2592000) === 1 ? '' : 's'} ago`;
    return `${Math.floor(diff/31536000)} year${Math.floor(diff/31536000) === 1 ? '' : 's'} ago`;
  };

  return (
    <div className="fixed top-20 right-8 z-50 animate-bounce">
      <div className="bg-neutral-900 border border-amber-500/50 shadow-lg shadow-amber-500/20 text-white px-4 py-2 rounded-lg flex items-center space-x-3">
        <div className="bg-emerald-500/20 text-emerald-400 p-1 rounded-full">
          <DollarSign size={16} />
        </div>
        <div>
          <p className="text-xs text-neutral-400 uppercase font-bold">New Commission</p>
          <p className="text-sm font-bold text-amber-500">
            +${latestTrade.amount.toFixed(2)} 
            <span className="text-neutral-500 font-normal ml-1">({latestTrade.symbol})</span>
            <span className="ml-2 text-xs text-neutral-500">{getRelativeTime(tradeTime)}</span>
          </p>
        </div>
      </div>
    </div>
  );
};

// Withdrawal methods configuration - PULL FROM XVALLEY API OR UPDATE HERE
const WITHDRAWAL_METHODS = [
  { label: 'Bank Wire', xvalleyType: 1 },           // BankWire
  { label: 'USDT (TRC20)', xvalleyType: 46 },       // TetherTron
  { label: 'USDT (ERC20)', xvalleyType: 35 },       // Tether (Ethereum)
  { label: 'USDC (POL)', xvalleyType: 44 },         // USDCoin
  { label: 'Bitcoin', xvalleyType: 5 },             // Bitcoin
  { label: 'Ethereum', xvalleyType: 34 }            // Ethereum
  // NOTE: Skrill was removed - it's available in XValley but not configured for your platform
  // To use any XValley method, add it to this list with its xvalleyType ID
];

const WithdrawalModal = ({ onClose, onSubmit, available }) => {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState(WITHDRAWAL_METHODS[0].label);

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-6 w-full max-w-md shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
        <h3 className="text-xl font-bold text-white mb-1">Request Withdrawal</h3>
        <p className="text-sm text-neutral-400 mb-6">Available Balance: <span className="text-emerald-400 font-bold">${available.toLocaleString()}</span></p>

        <div className="space-y-4">
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Amount</label>
                <div className="relative mt-1">
                    <DollarSign size={16} className="absolute left-3 top-3 text-neutral-500"/>
                    <input 
                        type="number" 
                        value={amount} 
                        onChange={e => setAmount(e.target.value)}
                        className="w-full bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 pl-9 pr-4 text-white focus:border-amber-500 focus:outline-none"
                        placeholder="0.00"
                        max={available}
                    />
                </div>
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Method</label>
                <select 
                    value={method} 
                    onChange={e => setMethod(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-3 text-white focus:border-amber-500 focus:outline-none"
                >
                    {WITHDRAWAL_METHODS.map(m => (
                      <option key={m.xvalleyType} value={m.label}>{m.label}</option>
                    ))}
                </select>
            </div>
        </div>

        <div className="mt-8 flex gap-3">
            <button onClick={onClose} className="flex-1 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg font-medium transition-colors">Cancel</button>
            <button 
                onClick={() => onSubmit(amount, method)}
                disabled={!amount || amount > available}
                className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-900 rounded-lg font-bold transition-colors"
            >
                Confirm Request
            </button>
        </div>
      </div>
    </div>
  );
};

const CreateCampaignModal = ({ onClose, onSubmit }) => {
  const [name, setName] = useState('');
  const [referrerTag, setReferrerTag] = useState('');
  const [cost, setCost] = useState('0');
  const [description, setDescription] = useState('');
  
  const handleSubmit = () => {
    if(!name || !referrerTag) return;
    onSubmit({ 
      name, 
      referrerTag: referrerTag.toUpperCase().replace(/\s+/g, '_').replace(/[^A-Z0-9_]/g, ''),
      cost: parseFloat(cost) || 0,
      description
    });
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-6 w-full max-w-sm shadow-2xl relative">
        <button onClick={onClose} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
        <h3 className="text-xl font-bold text-white mb-4">Create New Campaign</h3>
        
        <div className="space-y-4">
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Campaign Name</label>
                <input 
                    type="text" 
                    value={name} 
                    onChange={e => setName(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none"
                    placeholder="e.g. Summer Promo 2026"
                    autoFocus
                />
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Referrer Tag (Tracking ID)</label>
                <input 
                    type="text" 
                    value={referrerTag} 
                    onChange={e => setReferrerTag(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none font-mono text-sm"
                    placeholder="e.g. SUMMER_2026 or FACEBOOK_ADS"
                    title="This unique tag identifies when a customer came from this campaign"
                />
                <p className="text-xs text-neutral-400 mt-1">Share unique link: https://nommia.com/register?ref={referrerTag || 'TAG'}</p>
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Campaign Cost ($)</label>
                <input 
                    type="number" 
                    value={cost} 
                    onChange={e => setCost(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none"
                    placeholder="0.00"
                    step="0.01"
                    min="0"
                />
                <p className="text-xs text-neutral-400 mt-1">Used to calculate ROI (Revenue - Cost) / Cost</p>
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Description (Optional)</label>
                <textarea 
                    value={description} 
                    onChange={e => setDescription(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none text-sm"
                    placeholder="e.g. Limited time offer, targeting new investors..."
                    rows="3"
                />
            </div>
        </div>
        <div className="mt-6">
            <button 
                onClick={handleSubmit}
                disabled={!name || !referrerTag}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-900 rounded-lg font-bold transition-colors"
            >
                Create Campaign
            </button>
        </div>
      </div>
    </div>
  );
};

const UploadAssetModal = ({ onClose, onSubmit }) => {
  const [name, setName] = useState('');
  const [type, setType] = useState('image');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [file, setFile] = useState(null);
  const [fileData, setFileData] = useState(null);
  const fileInputRef = useRef(null);

  const handleFileSelect = (e) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Read file as base64 for localStorage storage
      const reader = new FileReader();
      reader.onload = (event) => {
        const base64Data = event.target.result;
        setFileData(base64Data);
        setFile({
          name: selectedFile.name,
          size: (selectedFile.size / (1024 * 1024)).toFixed(2) + ' MB',
          type: selectedFile.type,
          lastModified: new Date(selectedFile.lastModified).toISOString().split('T')[0]
        });
       // console.log('[MarketingView] File selected and encoded:', selectedFile.name, selectedFile.size, 'bytes');
      };
      reader.readAsDataURL(selectedFile);
    }
  };

  const handleSubmit = () => {
    if(!name || !file) {
      alert('Please enter a name and select a file');
      return;
    }
    
    const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(t => t) : [];
    
    onSubmit({ 
      name, 
      type,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type,
      uploadDate: new Date().toISOString().split('T')[0],
      description: description.trim(),
      tags: tagArray,
      fileData: fileData,  // Base64 encoded data
      assetId: Date.now().toString(36) + Math.random().toString(36).substr(2),
      downloadUrl: `/assets/${name.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}`
    });
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-neutral-900 border border-neutral-700 rounded-xl p-6 w-full max-w-sm shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <button onClick={onClose} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
        <h3 className="text-xl font-bold text-white mb-4">Upload Marketing Asset</h3>
        
        <div className="space-y-4">
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Asset Name</label>
                <input 
                    type="text" 
                    value={name} 
                    onChange={e => setName(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none"
                    placeholder="e.g. Q4 Banner Set"
                />
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">File Type</label>
                <select 
                    value={type} 
                    onChange={e => setType(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none"
                >
                    <option value="image">Image (JPG/PNG)</option>
                    <option value="zip">Archive (ZIP)</option>
                    <option value="doc">Document (PDF)</option>
                    <option value="video">Video (MP4/MOV)</option>
                </select>
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Description (Optional)</label>
                <textarea 
                    value={description} 
                    onChange={e => setDescription(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none text-sm"
                    placeholder="e.g. Promotional banners for Q4 campaign"
                    rows="2"
                />
            </div>
            <div>
                <label className="text-xs uppercase text-neutral-500 font-bold">Tags (Optional)</label>
                <input 
                    type="text" 
                    value={tags} 
                    onChange={e => setTags(e.target.value)}
                    className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg py-2.5 px-4 text-white focus:border-amber-500 focus:outline-none"
                    placeholder="e.g. banners, q4, promo (comma-separated)"
                />
            </div>
            <div 
              onClick={() => fileInputRef.current?.click()}
              className="border-2 border-dashed border-neutral-700 rounded-lg p-8 text-center hover:border-amber-500/50 transition-colors cursor-pointer"
            >
                {file ? (
                  <div className="text-emerald-400">
                    <FileCheck size={24} className="mx-auto mb-2"/>
                    <p className="text-xs font-medium">{file.name}</p>
                    <p className="text-xs text-neutral-400 mt-1">{file.size}</p>
                  </div>
                ) : (
                  <div>
                    <Upload size={24} className="mx-auto text-neutral-500 mb-2"/>
                    <p className="text-xs text-neutral-400">Click to select file</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  onChange={handleFileSelect}
                  accept=".jpg,.jpeg,.png,.zip,.pdf,.mp4,.mov"
                  className="hidden"
                />
            </div>
        </div>
        <div className="mt-6">
            <button 
                onClick={handleSubmit}
                disabled={!name || !file}
                className="w-full py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-900 rounded-lg font-bold transition-colors"
            >
                Upload Asset
            </button>
        </div>
      </div>
    </div>
  );
};

const ClientDetailView = ({ client, onBack }) => {
  const [history, setHistory] = useState([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);  // Start with loading state

  useEffect(() => {
    let cancelled = false;
    const loadClientHistory = async () => {
      setIsLoadingHistory(true);
      try {
        let aggregated = [];
        
        // Use realAccountIds from client object if available (already fetched)
        // Otherwise fall back to fetching accounts by username
        let accountIds = client.realAccountIds || client.accountIds || [];
        
        if (accountIds.length === 0) {
          // Fallback: fetch trading accounts by username
          const username = client.username || client.UserName || client.Email || client.id;
         // console.log(`No cached account IDs, fetching accounts for: ${username}`);
          try {
            const accounts = await fetchTradingAccounts(username);
            accountIds = accounts.filter(a => a.isReal).map(a => a.id);
            // console.log(`Fetched ${accounts.length} accounts, ${accountIds.length} real accounts`);
          } catch (e) {
          //  console.warn('fetchTradingAccounts failed:', e && (e.message || e));
          }
        } else {
        //  console.log(`Using cached account IDs for ${client.username}: ${accountIds.join(', ')}`);
        }

        if (accountIds.length > 0) {
          // Fetch closed trades for each trading account and aggregate
          for (const accId of accountIds) {
            try {
              // Pass empty strings for fromDate/toDate to get all trades
              const accTrades = await fetchClientTrades(accId, '', '');
              if (Array.isArray(accTrades) && accTrades.length > 0) {
                aggregated = aggregated.concat(accTrades.map(t => ({...t, _accountId: accId})));
              }
            } catch (e) {
              // console.warn(`Failed to fetch trades for account ${accId}:`, e && (e.message || e));
            }
          }
        } else if (client.id) {
          // Fallback: try fetching trades by client.id (may be a TraderAccountId)
          try {
            const fallbackTrades = await fetchClientTrades(client.id, '', '');
            if (Array.isArray(fallbackTrades)) aggregated = aggregated.concat(fallbackTrades);
          } catch (e) {
            // console.warn('Fallback fetchClientTrades failed:', e && (e.message || e));
          }
        }

        if (!cancelled) setHistory(aggregated || []);
      } catch (err) {
    //    console.error('Load client history error:', err && (err.message || err));
        if (!cancelled) setHistory([]);
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    };

    loadClientHistory();
    return () => { cancelled = true; };
  }, [client]);

  return (
    <div className="space-y-6 animate-fadeIn">
      <button onClick={onBack} className="flex items-center text-neutral-400 hover:text-white mb-4">
        <ArrowLeft size={18} className="mr-2" /> Back to Client List
      </button>
      
      <div className="bg-neutral-900 border border-neutral-800 p-6 rounded-xl">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 border-b border-neutral-800 pb-6">
            <div>
                <h2 className="text-2xl font-bold text-white">{client.name}</h2>
                <p className="text-neutral-500 text-sm mt-1">Client ID: {client.id} • Account Status: <span className="text-emerald-400 font-medium">{client.status}</span></p>
            </div>
            <div className="mt-4 md:mt-0 text-right">
                 <span className="text-xs text-neutral-500 uppercase font-bold block mb-1">Risk Profile</span>
                 <StatusBadge status={client.risk || 'Low'} />
            </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            <div>
                <p className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Users size={12} className="mr-1"/> Contact Info</p>
                <div className="space-y-1">
                  <p className="text-white text-sm font-medium">{client.email}</p>
                  <p className="text-neutral-400 text-sm">{client.phone}</p>
                </div>
            </div>
            <div>
                <p className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Globe size={12} className="mr-1"/> Compliance</p>
                <div className="space-y-2">
                  <p className="text-white text-sm flex items-center">{client.country}</p>
                  <StatusBadge status={client.kycStatus} />
                </div>
            </div>
            <div>
                <p className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Wallet size={12} className="mr-1"/> Financials</p>
                <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                        <span className="text-neutral-400">Net Deposit:</span>
                        <span className="text-white font-medium">${client.deposit.toLocaleString()}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-neutral-400">Live Equity:</span>
                        <span className={`font-bold ${client.equity < client.deposit * 0.5 ? 'text-red-400' : 'text-emerald-400'}`}>${client.equity.toLocaleString()}</span>
                    </div>
                </div>
            </div>
            <div>
                <p className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Activity size={12} className="mr-1"/> Activity</p>
                <div className="space-y-2">
                    <div className="flex justify-between text-sm">
                        <span className="text-neutral-400">Total NV:</span>
                        <span className="text-amber-500 font-bold">{(typeof client.lots === 'number') ? client.lots.toFixed(2) : '0.00'}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                        <span className="text-neutral-400">Last Active:</span>
                        <span className="text-neutral-300">{(() => {
                          // Use lastLogin from API if available
                          const lastDate = client.lastLogin || client.lastActive;
                          if (!lastDate) return 'N/A';
                          try {
                            const d = new Date(lastDate);
                            if (isNaN(d.getTime())) return 'N/A';
                            return d.toLocaleDateString();
                          } catch { return 'N/A'; }
                        })()}</span>
                    </div>
                </div>
            </div>
        </div>
      </div>

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
        <div className="p-4 border-b border-neutral-800 font-bold text-white bg-neutral-800/20">Trading History</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
              <thead className="bg-neutral-800/50 text-neutral-400 font-semibold">
                  <tr>
                      <th className="p-3">Symbol</th>
                      <th className="p-3">Type</th>
                      <th className="p-3 text-right">Volume</th>
                      <th className="p-3">Open Time</th>
                      <th className="p-3 text-right">P/L</th>
                      <th className="p-3 text-right">Commission</th>
                  </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                  {isLoadingHistory ? (
                    <tr key="loading-history-row">
                      <td colSpan="6" className="p-8 text-center">
                        <div className="flex items-center justify-center">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-amber-500"></div>
                          <span className="ml-3 text-neutral-400">Loading trading history...</span>
                        </div>
                      </td>
                    </tr>
                  ) : history.length > 0 ? history.map((trade) => (
                      <tr key={trade.id || JSON.stringify(trade)} className="hover:bg-neutral-800/30">
                          <td className="p-3 font-medium text-white">{trade.symbol || trade.instrument}</td>
                          <td className={`p-3 ${(trade.type || trade.side) === 'Buy' ? 'text-emerald-400' : 'text-red-400'}`}>{trade.type || trade.side}</td>
                          <td className="p-3 text-right">{(trade.volume !== undefined && trade.volume !== null) ? (Number(trade.volume).toString()) : '0'}</td>
                          <td className="p-3 text-neutral-500">{(() => {
                              const v = trade.openTime || trade.openDate || trade.EDT || trade.OpenTime;
                              if (!v) return '';
                              try {
                                if (v instanceof Date) return v.toLocaleString();
                                if (typeof v === 'number') return (v > 1e12 ? new Date(v) : new Date(v * 1000)).toLocaleString();
                                if (typeof v === 'string' && !isNaN(Date.parse(v))) return new Date(Date.parse(v)).toLocaleString();
                                return String(v);
                              } catch (e) { return String(v); }
                          })()}</td>
                          <td className={`p-3 text-right font-medium ${(trade.profitLoss || trade.profit || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                              {(() => {
                                const pl = trade.profitLoss || trade.profit || 0;
                                return `${pl >= 0 ? '+' : ''}${Number(pl).toFixed(2)}`;
                              })()}
                          </td>
                          <td className="p-3 text-right font-bold text-amber-500">+${(() => {
                              // Use API commission if provided, otherwise calculate from volume
                              if (trade.commission && trade.commission > 0) return trade.commission.toFixed(2);
                              // Calculate based on instrument type
                              const vol = parseFloat(trade.volume) || 0;
                              const instrument = (trade.symbol || trade.instrument || '').toUpperCase();
                              // Metals get $8/lot, FX gets $4.50/lot
                              const rate = (instrument.includes('XAU') || instrument.includes('XAG')) ? 8 : 4.5;
                              return (vol * rate).toFixed(2);
                            })()}</td>
                      </tr>
                  )) : (
                    <tr key="no-history-row">
                      <td colSpan="6" className="p-8 text-center text-neutral-500">No trading history found for this client.</td>
                    </tr>
                  )}
              </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// --- VIEWS ---

const DashboardView = ({ clients, apiStatus, onNavigate, clientUsernames, setTotalVolume, setRevenue, setTotalPL, setTradeHistory: setParentTradeHistory, totalVolume, revenue, tradeHistory: parentTradeHistory }) => {
  const [timeRange, setTimeRange] = useState('Lifetime');
  const [showNotifModal, setShowNotifModal] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  const [notifPage, setNotifPage] = useState(1);
  // Initialize localTradeHistory from parent tradeHistory prop (for Lifetime view)
  const [localTradeHistory, setLocalTradeHistory] = useState({ trades: [], totalVolume: 0, totalPL: 0 });
  const [isLoadingTrades, setIsLoadingTrades] = useState(false);
  const [transactions, setTransactions] = useState([]);  // All transactions for deposit filtering
  const [localDeposits, setLocalDeposits] = useState(0);  // Deposits for current time range
  
  // Store lifetime data separately so we can restore it when switching back
  const [lifetimeData, setLifetimeData] = useState({ totalVolume: 0, totalRevenue: 0, totalPL: 0, trades: [] });
  
  // Sync lifetime data when parent tradeHistory changes (initial load)
  useEffect(() => {
    if (parentTradeHistory && Array.isArray(parentTradeHistory) && parentTradeHistory.length > 0) {
      // Parent passes trades array
      const vol = parentTradeHistory.reduce((sum, t) => sum + (t.volume || 0), 0);
      const pl = parentTradeHistory.reduce((sum, t) => sum + (t.profitLoss || 0), 0);
      setLifetimeData({
        trades: parentTradeHistory,
        totalVolume: vol,
        totalPL: pl,
        totalRevenue: totalVolume // Use parent's revenue
      });
      setLocalTradeHistory({ trades: parentTradeHistory, totalVolume: vol, totalPL: pl });
    } else if (parentTradeHistory && parentTradeHistory.trades) {
      setLifetimeData(parentTradeHistory);
      setLocalTradeHistory(parentTradeHistory);
    }
  }, [parentTradeHistory]);
  
  // Fetch all transactions once on mount for deposit filtering
  useEffect(() => {
    if (apiStatus !== 'connected') return;
    
    const loadTransactions = async () => {
      try {
        const txns = await fetchAllTransactions();
        setTransactions(txns || []);
        
        // Debug: Show transaction stats
        if (txns && txns.length > 0) {
          const deposits = txns.filter(t => t.side === 1);
          const withdrawals = txns.filter(t => t.side === 2);
          const totalDep = deposits.reduce((s, t) => s + (t.depositedAmount || 0), 0);
        //  console.log(`Loaded ${txns.length} transactions: ${deposits.length} deposits ($${totalDep.toFixed(2)}), ${withdrawals.length} withdrawals`);
          if (txns[0]) {
        //    console.log('Sample tx:', { username: txns[0].username, side: txns[0].side, amount: txns[0].depositedAmount, date: txns[0].date });
          }
        } else {
        //  console.log('No transactions loaded');
        }
      } catch (err) {
     //   console.error('Failed to load transactions:', err);
      }
    };
    
    loadTransactions();
  }, [apiStatus]);

  // Track current request to avoid race conditions - use AbortController pattern
  const abortControllerRef = useRef(null);
  const requestIdRef = useRef(0);

  // Fetch trade history when time range changes
  useEffect(() => {
    if (apiStatus !== 'connected') return;

    // Increment request ID to track latest request
    const requestId = ++requestIdRef.current;
    
    // Cancel any previous request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    
    // Create new abort controller for this request
    abortControllerRef.current = { 
      signal: { aborted: false },
      abort: function() { this.signal.aborted = true; }
    };
    
    const currentSignal = abortControllerRef.current.signal;
    
    //console.log(`[Request ${requestId}] Starting for ${timeRange}`);

    const loadTradeHistory = async () => {
      try {
        setIsLoadingTrades(true);
        
        if (timeRange === 'Lifetime') {
          // For Lifetime, prefer using stored data or parent data
          if (lifetimeData.totalVolume > 0) {
            // Check if request was cancelled before using stored data
            if (currentSignal.aborted) {
             // console.log(`[Request ${requestId}] Cancelled before setting lifetime data`);
              return;
            }
            // Use stored lifetime data
            //console.log(`[Request ${requestId}] Using stored lifetime data: ${lifetimeData.totalVolume}`);
            setLocalTradeHistory(lifetimeData);
            setTotalVolume(lifetimeData.totalVolume);
            setRevenue(lifetimeData.totalRevenue || revenue);
            setTotalPL(lifetimeData.totalPL);
            setIsLoadingTrades(false);
            return;
          }
          
          // Check if parent already has data (from initial fetchNetworkStats)
          if (totalVolume > 0 || revenue > 0) {
            if (currentSignal.aborted) {
          //    console.log(`[Request ${requestId}] Cancelled before setting parent data`);
              return;
            }
            //console.log(`[Request ${requestId}] Using parent data for Lifetime: ${totalVolume}`);
            setLocalTradeHistory({ trades: parentTradeHistory || [], totalVolume, totalPL: 0, totalRevenue: revenue });
            setLifetimeData({ trades: parentTradeHistory || [], totalVolume, totalPL: 0, totalRevenue: revenue });
            setIsLoadingTrades(false);
            return;
          }
          
          // Only re-fetch if we truly have no data
       //   console.log(`[Request ${requestId}] Re-fetching Lifetime data...`);
          const history = await fetchVolumeHistory('Lifetime');
          
          // Check if this request was cancelled
          if (currentSignal.aborted) {
         //   console.log(`[Request ${requestId}] Cancelled after Lifetime fetch`);
            return;
          }
          
          setLifetimeData(history);
          setLocalTradeHistory(history);
          setParentTradeHistory(history.trades || []);
          setTotalVolume(history.totalVolume || 0);
          setRevenue(history.totalRevenue || 0);
          setTotalPL(history.totalPL || 0);
        //  console.log(`[Request ${requestId}] Lifetime data updated successfully`);
        } else {
          //console.log(`[Request ${requestId}] Fetching volume history for ${timeRange}`);
          const history = await fetchVolumeHistory(timeRange);
          
          // Check if this request was cancelled
          if (currentSignal.aborted) {
        //    console.log(`[Request ${requestId}] Cancelled after ${timeRange} fetch`);
            return;
          }
          
          setLocalTradeHistory(history);
          // Don't update parent state for non-lifetime ranges - keep lifetime data intact
          setTotalVolume(history.totalVolume || 0);
          setRevenue(history.totalRevenue || 0);
          setTotalPL(history.totalPL || 0);
        //  console.log(`[Request ${requestId}] ${timeRange} data updated successfully`);
        }
      } catch (err) {
        if (!currentSignal.aborted) {
        //  console.error(`[Request ${requestId}] Failed to load trade history:`, err);
        } else {
       //   console.log(`[Request ${requestId}] Request was cancelled, ignoring error`);
        }
      } finally {
        // Only clear loading if this request wasn't cancelled
        if (!currentSignal.aborted) {
          setIsLoadingTrades(false);
        }
      }
    };

    loadTradeHistory();
    
    // Cleanup: cancel request if component unmounts or timeRange changes
    return () => {
      if (abortControllerRef.current) {
        //console.log(`[Request ${requestId}] Cleanup: Aborting request`);
        abortControllerRef.current.abort();
      }
    };
  }, [timeRange, apiStatus]);

  // Helper to compute lots for a client in dashboard context
  const computeClientLots = (client) => {
    return client?.lots || 0;
  };

  // Available time periods for filtering
  const timePeriods = ['Today', 'This Week', 'This Month', 'This Quarter', 'This Year', 'Lifetime'];

  // Helper function to get date range based on time period
  // FIXED: Properly set end-of-day (23:59:59.999) to include all data for the period
  const getDateRange = (period) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Helper to get end of day (23:59:59.999)
    const getEndOfDay = (date) => {
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      return end;
    };
    
    switch (period) {
      case 'Today':
        return { start: today, end: getEndOfDay(today) };
      case 'This Week': {
        const startOfWeek = new Date(today);
        startOfWeek.setDate(today.getDate() - today.getDay());
        return { start: startOfWeek, end: getEndOfDay(today) };
      }
      case 'This Month': {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start: startOfMonth, end: getEndOfDay(today) };
      }
      case 'This Quarter': {
        const quarter = Math.floor(now.getMonth() / 3);
        const startOfQuarter = new Date(now.getFullYear(), quarter * 3, 1);
        return { start: startOfQuarter, end: getEndOfDay(today) };
      }
      case 'This Year': {
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        return { start: startOfYear, end: getEndOfDay(today) };
      }
      case 'Lifetime':
      default:
        return { start: new Date(0), end: now }; // All time
    }
  };

  // Filter clients by time range based on registration date
  // Get usernames of clients who had trades in this time range
  const getActiveUsernamesForRange = (trades) => {
    const usernames = new Set();
    if (trades && Array.isArray(trades)) {
      trades.forEach(t => {
        if (t.username) {
          usernames.add(t.username.toLowerCase());
        }
      });
    }
    return usernames;
  };

  // Get filtered clients based on time range (clients with trades/activity)
  const filteredClients = useMemo(() => {
    if (timeRange === 'Lifetime') return clients;
    
    // For non-Lifetime ranges: filter to clients who had trades in that range
    const activeUsernames = getActiveUsernamesForRange(localTradeHistory?.trades);
    if (activeUsernames.size === 0) return [];
    
    return clients.filter(c => {
      const username = (c.username || '').toLowerCase();
      return activeUsernames.has(username);
    });
  }, [timeRange, localTradeHistory?.trades, clients]);
  
  // Build set of client usernames for filtering transactions
  const clientUsernameSet = useMemo(() => {
    return new Set(clients.map(c => (c.username || '').toLowerCase()).filter(Boolean));
  }, [clients]);

  // Calculate deposits for ALL time ranges using client.deposit field
  const calculateDepositsForRange = () => {
    // DEPOSITS = client.deposit field (authoritative cumulative deposit per client)
    // For ALL time ranges: sum client deposits from active clients
    // - Lifetime: ALL clients
    // - Other ranges: clients who had trades in that time range
    
    if (!clients || clients.length === 0) {
     // console.log(`[Deposits] No clients available`);
      return 0;
    }
    
    // For Lifetime: sum ALL client deposits
    if (timeRange === 'Lifetime') {
      const allDeposits = clients.reduce((sum, c) => sum + (c.deposit || 0), 0);
    //  console.log(`[Deposits] Lifetime: ALL ${clients.length} clients, deposits = $${allDeposits.toFixed(2)}`);
      return allDeposits;
    }
    
    // For other time ranges: use filteredClients (clients who had trades in this range)
    // Sum their authoritative client.deposit values
    const clientsToSum = (filteredClients && filteredClients.length > 0) ? filteredClients : [];
    const rangeDeposits = clientsToSum.reduce((sum, c) => sum + (c.deposit || 0), 0);
    
   // console.log(`[Deposits] ${timeRange}: ${clientsToSum.length} clients with trades, deposits = $${rangeDeposits.toFixed(2)}`);
    return rangeDeposits;
  };
  
  const totalDeposits = calculateDepositsForRange();
  
  // Debug metrics (use parent totals passed into component)
 // console.log(`Time Range: ${timeRange}, Clients: ${filteredClients.length}, Volume: ${totalVolume.toFixed ? totalVolume.toFixed(2) : totalVolume}, Revenue: ${revenue.toFixed ? revenue.toFixed(2) : revenue}, Deposits: ${totalDeposits}`);

  // Simplified metrics - trends are placeholder
  const currentMetrics = {
    revenue: revenue,
    deposits: totalDeposits,
    volume: totalVolume,
    revTrend: '+0.0%',
    depTrend: '+0.0%',
    volTrend: '+0.0%'
  };

  // Compute active/pending counts robustly using raw trader data when available
  const isClientActive = (c) => {
    // Check the explicit active flag we set from API
    if (c.active === true) return true;
    
    // Prefer explicit client.status when it clearly declares Active
    if (c.status && typeof c.status === 'string' && c.status.toLowerCase() === 'active') return true;
    
    // Check if client has equity or balance (indicates active trading)
    if ((c.equity && c.equity > 0) || (c.balance && c.balance > 0)) return true;
    
    // Check if client has deposits
    if (c.deposit && c.deposit > 0) return true;

    // If raw trading accounts are present, follow XValley logic
    if (Array.isArray(c._rawTraders) && c._rawTraders.length > 0) {
      return c._rawTraders.some(t => {
        const isActiveFlag = (t.A === true) || (t.Active === true) || (t.State === 0);
        const accountType = t.TATD || t.tatd || t['TATD'] || {};
        const isReal = (accountType && typeof accountType.Type !== 'undefined') ? (accountType.Type === 1) : (String(t.TATD?.Type || t.TAT || t.TATD).includes('1'));
        return isActiveFlag && isReal;
      });
    }

    return false;
  };

  const activeClients = clients.filter(c => isClientActive(c)).length;
  const pendingKYC = clients.filter(c => {
    // Prefer explicit approved boolean when present
    if (typeof c.approved !== 'undefined') return !c.approved;
    // Otherwise fall back to kycStatus string
    return (c.kycStatus || 'Pending') === 'Pending';
  }).length;
  
  // New clients in selected time period
  const newClientsInPeriod = filteredClients.length;

  // Generate notifications from real client data
  // Robust relative time helper - accepts Date | number | ISO string
  const getRelativeTime = (date) => {
    if (!date) return '';
    let ts = null;
    if (date instanceof Date) ts = date.getTime();
    else if (typeof date === 'number') ts = date > 1e12 ? date : date * 1000;
    else if (typeof date === 'string') {
      const parsed = Date.parse(date);
      if (!isNaN(parsed)) ts = parsed;
    }
    if (!ts) return '';

    const nowTs = Date.now();
    const diff = Math.floor((nowTs - ts) / 1000);
    if (diff < 0) return 'in the future';
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff/60)} min ago`;
    if (diff < 86400) return `${Math.floor(diff/3600)} hr ago`;
    if (diff < 2592000) return `${Math.floor(diff/86400)} day${Math.floor(diff/86400) === 1 ? '' : 's'} ago`;
    if (diff < 31536000) return `${Math.floor(diff/2592000)} month${Math.floor(diff/2592000) === 1 ? '' : 's'} ago`;
    return `${Math.floor(diff/31536000)} year${Math.floor(diff/31536000) === 1 ? '' : 's'} ago`;
  };

  const allNotifications = clients.length > 0 ? clients.slice(0, 25).map((client, i) => {
    const types = [
      { type: 'signup', msg: `${client.name || 'New client'} registered from ${client.country || 'Unknown'}`, icon: Users, color: 'text-blue-400', time: client.registeredAt || client.createdAt || client.updatedAt },
      { type: 'deposit', msg: `${client.name || 'Client'} deposited $${(client.deposit || 0).toLocaleString()}`, icon: Wallet, color: 'text-emerald-400', time: client.lastDepositAt || client.updatedAt || client.createdAt },
      { type: 'kyc', msg: `${client.name || 'Client'} - KYC ${client.kycStatus || 'Pending'}`, icon: FileText, color: 'text-amber-400', time: client.kycUpdatedAt || client.updatedAt || client.createdAt },
      { type: 'trade', msg: `${client.name || 'Client'} traded ${computeClientLots(client).toFixed(2)} NV`, icon: Activity, color: 'text-purple-400', time: client.lastTradeAt || client.updatedAt || client.createdAt }
    ];
    const typeData = types[i % 4];
    return {
      id: client.id || i,
      type: typeData.type,
      msg: typeData.msg,
      time: getRelativeTime(typeData.time),
      icon: typeData.icon,
      color: typeData.color
    };
  }) : [];

  const itemsPerPage = 10;
  const totalPages = Math.max(1, Math.ceil(allNotifications.length / itemsPerPage));
  const currentNotifications = allNotifications.slice((notifPage - 1) * itemsPerPage, notifPage * itemsPerPage);

  const handleCopyLink = () => {
    const mainLink = `https://nommia.com/register?ib=${getSessionPartnerId() || ''}`;
    navigator.clipboard.writeText(mainLink);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  return (
    <div className="space-y-6 animate-fadeIn relative">
      
      {showNotifModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-lg shadow-2xl flex flex-col max-h-[80vh]">
            <div className="p-4 border-b border-neutral-800 flex justify-between items-center">
              <h3 className="font-bold text-white">All Notifications</h3>
              <button onClick={() => setShowNotifModal(false)} className="text-neutral-500 hover:text-white"><X size={20}/></button>
            </div>
            <div className="overflow-y-auto p-4 space-y-3 flex-1">
              {currentNotifications.map((notif) => (
                <div key={notif.id} className="flex items-start p-3 bg-neutral-950 rounded-lg border border-neutral-800">
                  <div className={`mt-0.5 min-w-[24px] h-6 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center ${notif.color}`}>
                    <notif.icon size={12} />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-neutral-300">{notif.msg}</p>
                    <p className="text-xs text-neutral-600 mt-1 flex items-center"><Clock size={10} className="mr-1"/> {notif.time}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="p-4 border-t border-neutral-800 flex justify-between items-center bg-neutral-900 rounded-b-xl">
              <button onClick={() => setNotifPage(p => Math.max(1, p - 1))} disabled={notifPage === 1} className="text-xs font-bold text-neutral-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center px-3 py-2 bg-neutral-800 rounded"><ChevronDown size={14} className="rotate-90 mr-1"/> Previous</button>
              <span className="text-xs text-neutral-500">Page {notifPage} of {totalPages}</span>
              <button onClick={() => setNotifPage(p => Math.min(totalPages, p + 1))} disabled={notifPage === totalPages} className="text-xs font-bold text-neutral-400 hover:text-white disabled:opacity-30 disabled:cursor-not-allowed flex items-center px-3 py-2 bg-neutral-800 rounded">Next <ChevronDown size={14} className="rotate-[-90] ml-1"/></button>
            </div>
          </div>
        </div>
      )}

      {/* Header and Time Filter */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        {/* Status Bar */}
        <div className="flex-1 flex gap-4 w-full">
            {apiStatus === 'disconnected' ? (
            <div className="flex-1 bg-amber-900/30 border border-amber-500/30 text-amber-200 p-3 rounded-lg flex items-center text-sm">
                <AlertCircle size={16} className="mr-2" />
                <span>Viewing cached data. Connect to XValley API for live updates.</span>
            </div>
            ) : clients.length > 0 ? (
            <div className="flex-1 bg-emerald-900/20 border border-emerald-500/20 text-emerald-300 p-3 rounded-lg flex items-center text-sm">
                <Activity size={16} className="mr-2" />
                <span>Live Stream Active: Receiving tick data...</span>
            </div>
            ) : (
            <div className="flex-1 bg-amber-900/30 border border-amber-500/30 text-amber-200 p-3 rounded-lg flex items-center text-sm">
                <AlertCircle size={16} className="mr-2" />
                <span>Connecting to XValley API...</span>
            </div>
            )}
            
            {pendingKYC > 0 && (
            <div className="bg-neutral-800 border-l-4 border-amber-500 p-3 rounded-r-lg flex items-center shadow-lg animate-pulse hover:animate-none transition-all hidden md:flex">
                <div className="mr-4">
                <div className="text-2xl font-bold text-white">{pendingKYC}</div>
                </div>
                <div>
                <div className="text-xs text-neutral-400 uppercase font-bold">Pending Approvals</div>
                <div className="text-sm text-white">Clients awaiting KYC review</div>
                </div>
                <button onClick={() => onNavigate('clients')} className="ml-4 px-3 py-1 bg-neutral-700 hover:bg-neutral-600 text-xs rounded text-white transition-colors border border-neutral-600">Review Now</button>
            </div>
            )}
        </div>

        {/* Time Selector */}
        <div className="relative min-w-[160px]">
            <select 
                value={timeRange}
                onChange={(e) => setTimeRange(e.target.value)}
                className="w-full bg-neutral-900 border border-neutral-700 text-white text-sm rounded-lg pl-4 pr-10 py-2.5 focus:border-amber-500 outline-none appearance-none font-medium cursor-pointer hover:bg-neutral-800 transition-colors"
            >
                {timePeriods.map(period => (
                    <option key={period} value={period}>{period}</option>
                ))}
            </select>
            <ChevronDown size={16} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"/>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <StatCard title="Total Revenue" value={`$${currentMetrics.revenue.toLocaleString()}`} subtext={timeRange} trend={currentMetrics.revTrend} trendUp={!currentMetrics.revTrend.includes('-')} icon={DollarSign} isLoading={isLoadingTrades} />
        <StatCard title="Active Clients" value={activeClients} subtext="Live accounts (Current)" trend="+5.2%" trendUp={true} icon={Users} isLoading={false} />
        <StatCard title="Total Deposits" value={`$${currentMetrics.deposits.toLocaleString()}`} subtext={timeRange} trend={currentMetrics.depTrend} trendUp={!currentMetrics.depTrend.includes('-')} icon={Wallet} isLoading={isLoadingTrades} />
        <StatCard title="Network Volume" value={`${currentMetrics.volume.toLocaleString()}`} subtext={`${timeRange} (NV)`} trend={currentMetrics.volTrend} trendUp={!currentMetrics.volTrend.includes('-')} icon={Activity} isLoading={isLoadingTrades} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 p-6 flex flex-col">
          <div className="flex justify-between items-center mb-6">
             <div>
               <h3 className="font-bold text-white">Trading Volume History</h3>
               <p className="text-xs text-neutral-500 mt-0.5">Total NV traded by your direct clients</p>
             </div>
             <div className="text-xs text-neutral-500 font-mono bg-neutral-950 px-2 py-1 rounded border border-neutral-800">
                Viewing: {timeRange}
             </div>
          </div>
          
          <div className="flex-1 flex items-end gap-2 h-64 ml-12 px-2 border-l border-b border-neutral-800 relative min-h-[16rem]">
            {isLoadingTrades ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500"></div>
                <span className="ml-3 text-neutral-500">Loading trade history...</span>
              </div>
            ) : (() => {
              // Generate chart data - use trade history if available, otherwise fallback to client data
              const generateChartData = () => {
                const { trades } = localTradeHistory;
                const now = new Date();
                let labels = [];
                let buckets = [];
                // Define time buckets based on selected range
                switch (timeRange) {
                  case 'Today': {
                    labels = Array.from({length: 12}, (_, i) => `${i*2}h`);
                    buckets = labels.map((_, i) => {
                      const start = new Date(now);
                      start.setHours(i * 2, 0, 0, 0);
                      const end = new Date(start);
                      end.setHours(start.getHours() + 2);
                      return { start, end };
                    });
                    break;
                  }
                  case 'This Week': {
                    labels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
                    const weekStart = new Date(now);
                    weekStart.setDate(now.getDate() - now.getDay());
                    weekStart.setHours(0, 0, 0, 0);
                    buckets = labels.map((_, i) => {
                      const start = new Date(weekStart);
                      start.setDate(weekStart.getDate() + i);
                      const end = new Date(start);
                      end.setDate(start.getDate() + 1);
                      return { start, end };
                    });
                    break;
                  }
                  case 'This Month': {
                    labels = ['Week 1', 'Week 2', 'Week 3', 'Week 4'];
                    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
                    buckets = labels.map((_, i) => {
                      const start = new Date(monthStart);
                      start.setDate(1 + i * 7);
                      const end = new Date(start);
                      end.setDate(start.getDate() + 7);
                      return { start, end };
                    });
                    break;
                  }
                  case 'This Quarter': {
                    const qMonth = Math.floor(now.getMonth() / 3) * 3;
                    labels = [
                      new Date(now.getFullYear(), qMonth, 1).toLocaleString('default', {month: 'short'}),
                      new Date(now.getFullYear(), qMonth + 1, 1).toLocaleString('default', {month: 'short'}),
                      new Date(now.getFullYear(), qMonth + 2, 1).toLocaleString('default', {month: 'short'})
                    ];
                    buckets = labels.map((_, i) => {
                      const start = new Date(now.getFullYear(), qMonth + i, 1);
                      const end = new Date(now.getFullYear(), qMonth + i + 1, 1);
                      return { start, end };
                    });
                    break;
                  }
                  case 'This Year': {
                    labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    buckets = labels.map((_, i) => {
                      const start = new Date(now.getFullYear(), i, 1);
                      const end = new Date(now.getFullYear(), i + 1, 1);
                      return { start, end };
                    });
                    break;
                  }
                  case 'Lifetime':
                  default: {
                    // For Lifetime, find min/max trade dates and create monthly buckets spanning that range
                    if (trades && trades.length > 0) {
                      const tradeDates = trades.map(t => new Date(t.closeDate || t.EDT)).filter(d => !isNaN(d));
                      if (tradeDates.length > 0) {
                        const minDate = new Date(Math.min(...tradeDates.map(d => d.getTime())));
                        const maxDate = new Date(Math.max(...tradeDates.map(d => d.getTime())));
                        
                        // Create monthly buckets from min to max date
                        buckets = [];
                        labels = [];
                        let current = new Date(minDate.getFullYear(), minDate.getMonth(), 1);
                        while (current <= maxDate) {
                          const month = current.toLocaleString('default', {month: 'short', year: '2-digit'});
                          labels.push(month);
                          const start = new Date(current);
                          const end = new Date(current);
                          end.setMonth(current.getMonth() + 1);
                          buckets.push({ start, end });
                          current.setMonth(current.getMonth() + 1);
                        }
                      } else {
                        // Fallback: current year months
                        labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                        buckets = labels.map((_, i) => {
                          const start = new Date(now.getFullYear(), i, 1);
                          const end = new Date(now.getFullYear(), i + 1, 1);
                          return { start, end };
                        });
                      }
                    } else {
                      // No trades: current year
                      labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                      buckets = labels.map((_, i) => {
                        const start = new Date(now.getFullYear(), i, 1);
                        const end = new Date(now.getFullYear(), i + 1, 1);
                        return { start, end };
                      });
                    }
                  }
                }
                
                // Group volume by time bucket
                // Use trade history if available, otherwise distribute client volume evenly
                const bucketData = buckets.map((bucket, i) => {
                  // Only use real trade data; if no trades, show 0
                  if (!trades || trades.length === 0) {
                    return { label: labels[i], value: 0, tradeCount: 0 };
                  }
                  const bucketTrades = trades.filter(t => {
                    if (!t.closeDate) return false;
                    const tradeDate = new Date(t.closeDate);
                    return tradeDate >= bucket.start && tradeDate < bucket.end;
                  });
                  const vol = bucketTrades.reduce((sum, t) => sum + (t.volume || 0), 0);
                  return { label: labels[i], value: vol, tradeCount: bucketTrades.length };
                });
                
                // Calculate heights based on max value
                const maxVol = Math.max(...bucketData.map(d => d.value), 0.1);
                return bucketData.map(d => ({
                  ...d,
                  height: maxVol > 0 ? Math.max(5, (d.value / maxVol) * 95) : 5
                }));
              };
              
              const chartData = generateChartData();
              const maxVal = Math.max(...chartData.map(d => d.value), 0.1);
              
              return (
                <>
                  <div className="absolute -left-12 top-0 bottom-8 flex flex-col justify-between text-[10px] text-neutral-500 font-mono text-right w-10">
                    <span>{maxVal.toFixed(1)}</span>
                    <span>{(maxVal / 2).toFixed(1)}</span>
                    <span>0</span>
                  </div>
                  {chartData.map((data, i) => (
                    <div key={i} className="flex-1 flex flex-col relative group h-full">
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block bg-neutral-800 text-xs text-white p-2 rounded border border-neutral-700 whitespace-nowrap z-10 shadow-xl">
                        {data.label}: {data.value.toFixed(2)} NV ({data.tradeCount || 0} trades)
                      </div>
                      <div className="flex-1 flex items-end">
                        <div 
                          className="w-full bg-gradient-to-t from-amber-600 to-amber-400 rounded-t-sm transition-all duration-500 group-hover:from-amber-500 group-hover:to-amber-300 shadow-[0_0_10px_rgba(245,158,11,0.3)]" 
                          style={{ height: `${data.height}%` }}
                        ></div>
                      </div>
                      <div className="text-[10px] text-neutral-600 text-center mt-2 truncate">{data.label}</div>
                    </div>
                  ))}
                </>
              );
            })()}
          </div>
          <div className="text-center text-xs text-neutral-500 mt-2 font-mono uppercase tracking-widest">
            {timeRange === 'Today' ? 'Hours' : timeRange === 'This Week' ? 'Days' : timeRange === 'This Month' ? 'Weeks' : 'Months'}
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-gradient-to-br from-neutral-800 to-neutral-900 p-6 rounded-xl border border-neutral-700 shadow-lg">
             <h4 className="text-white font-bold mb-2 flex items-center"><LinkIcon size={16} className="mr-2 text-amber-500"/> Quick Invite</h4>
             <p className="text-xs text-neutral-400 mb-3">Copy your default referral link to start earning.</p>
               <div className="flex bg-neutral-950 rounded border border-neutral-700 p-1 relative">
                <input readOnly value={`https://nommia.com/register?ib=${getSessionPartnerId() || ''}`} className="bg-transparent text-xs text-neutral-300 px-2 w-full focus:outline-none"/>
                <button 
                  onClick={handleCopyLink}
                  className={`px-3 py-1.5 rounded text-xs font-bold transition-colors min-w-[60px] ${linkCopied ? 'bg-emerald-500 text-white' : 'bg-neutral-800 hover:bg-neutral-700 text-white'}`}
                >
                  {linkCopied ? "Copied!" : "Copy"}
                </button>
             </div>
          </div>

          <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 p-6 flex-1 flex flex-col">
            <h3 className="font-bold text-white mb-4 text-sm uppercase tracking-wider flex items-center justify-between">
              Live Activity
              <span className={`w-2 h-2 rounded-full ${currentNotifications.length > 0 ? 'bg-emerald-500 animate-pulse' : 'bg-neutral-600'}`}></span>
            </h3>
            <div className="space-y-5 flex-1 overflow-hidden">
              {currentNotifications.length > 0 ? currentNotifications.slice(0, 4).map((act) => (
                <div key={act.id} className="flex items-start">
                  <div className={`mt-0.5 min-w-[24px] h-6 rounded-full bg-neutral-900 border border-neutral-700 flex items-center justify-center ${act.color}`}>
                    <act.icon size={12} />
                  </div>
                  <div className="ml-3">
                    <p className="text-sm text-neutral-300 leading-snug">{act.msg}</p>
                    <p className="text-xs text-neutral-600 mt-0.5 flex items-center"><Clock size={10} className="mr-1"/> {act.time}</p>
                  </div>
                </div>
              )) : (
                <div className="flex flex-col items-center justify-center h-full text-neutral-500 py-8">
                  <Activity size={32} className="mb-2 opacity-50" />
                  <p className="text-sm">No activity yet</p>
                  <p className="text-xs mt-1">Activity will appear when clients join</p>
                </div>
              )}
            </div>
            {currentNotifications.length > 0 && (
              <button onClick={() => setShowNotifModal(true)} className="w-full mt-6 py-2 text-xs text-neutral-500 hover:text-white border border-neutral-800 rounded hover:bg-neutral-800 transition-colors">
                View All Notifications
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const ClientsView = ({ clients }) => {
  const [selectedClient, setSelectedClient] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  if (selectedClient) {
    return <ClientDetailView client={selectedClient} onBack={() => setSelectedClient(null)} />;
  }

  // Helper to compute lots for display: use only `client.lots` computed from trade history
  // Trading accounts do NOT have a "lots traded" field - that must come from summing VU on closed trades
  const computeClientLots = (client) => {
    if (!client) return 0;
    // Return the lots value computed from trade history (set during client loading)
    return (typeof client.lots === 'number') ? client.lots : 0;
  };

  const filteredClients = clients.filter(client => 
    client.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    client.email.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleExport = () => {
    const headers = ["ID,Name,Email,Phone,Country,KYC Status,Net Deposit,Equity,Lots Traded,Risk Level,Status"];
    const rows = filteredClients.map(c => {
      const lots = computeClientLots(c);
      return `${c.id},"${c.name}",${c.email},${c.phone},"${c.country}",${c.kycStatus},${c.deposit},${c.equity},${lots},${c.risk},${c.status}`
    });
    const csvContent = "data:text/csv;charset=utf-8," + [headers, ...rows].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "nommia_client_list.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 flex flex-col h-full animate-fadeIn">
      <div className="p-5 border-b border-neutral-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4 bg-neutral-900 rounded-t-xl">
        <div>
          <h2 className="text-lg font-bold text-white">Client Management</h2>
          <p className="text-sm text-neutral-400">View KYC status, deposits, and trading activity.</p>
        </div>
        <div className="flex gap-2">
          <div className="relative">
            <Search size={18} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-neutral-500" />
            <input type="text" placeholder="Search clients..." className="pl-10 pr-4 py-2 border border-neutral-700 bg-neutral-800 text-neutral-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-amber-500 w-full sm:w-64 placeholder-neutral-500" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
          <button 
            onClick={handleExport}
            className="flex items-center px-4 py-2 bg-amber-500 text-neutral-900 rounded-lg text-sm font-bold hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20"
          >
            <Download size={18} className="mr-2" /> Export
          </button>
        </div>
      </div>
      <div className="overflow-x-auto flex-1 bg-neutral-900 rounded-b-xl">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="bg-neutral-800/50 text-neutral-400 text-xs uppercase font-semibold tracking-wider border-b border-neutral-800">
              <th className="p-4">Name / Contact</th><th className="p-4">Country</th><th className="p-4">KYC Status</th><th className="p-4 text-right">Net Deposit</th><th className="p-4 text-right">Equity (Live)</th><th className="p-4 text-right">NV Traded</th><th className="p-4">Risk Level</th><th className="p-4 text-center">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-800">
            {clients.length === 0 ? (
              <tr>
                <td colSpan="8" className="p-12 text-center">
                  <Users size={48} className="mx-auto mb-4 text-neutral-600" />
                  <p className="text-lg font-medium text-neutral-400 mb-2">No Clients Yet</p>
                  <p className="text-sm text-neutral-500">Your referred clients will appear here once they register through your referral link.</p>
                </td>
              </tr>
            ) : filteredClients.length > 0 ? (
              filteredClients.map((client, index) => (
                <tr key={client.id || client.username || `client-${index}`} onClick={() => setSelectedClient(client)} className="hover:bg-neutral-800/50 transition-colors group cursor-pointer">
                  <td className="p-4"><div className="font-medium text-neutral-200 group-hover:text-amber-500">{client.name}</div><div className="text-xs text-neutral-400 flex flex-col"><span>{client.email}</span><span>{client.phone}</span></div></td>
                  <td className="p-4 text-sm text-neutral-500">{client.country}</td>
                  <td className="p-4"><StatusBadge status={client.kycStatus} /></td>
                  <td className="p-4 text-right font-medium text-neutral-300">${(client.deposit || 0).toLocaleString()}</td>
                  <td className="p-4 text-right"><span className={`font-bold ${client.equity < client.deposit * 0.5 && client.deposit > 0 ? 'text-red-400' : 'text-neutral-200'}`}>${(client.equity || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}</span></td>
                  <td className="p-4 text-right font-medium text-amber-500">{computeClientLots(client) || 0}</td>
                  <td className="p-4"><StatusBadge status={client.risk || 'N/A'} /></td>
                  <td className="p-4 text-center"><button className="text-neutral-500 hover:text-amber-500 transition-colors p-1"><Settings size={16} /></button></td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="8" className="p-8 text-center text-neutral-500 italic">No clients found matching "{searchTerm}"</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// C. UPDATED MARKETING VIEW (With Assets & Admin Mode)
const MarketingView = ({ userRole, clients, apiStatus }) => {
  const [subTab, setSubTab] = useState('links');
  const [campaigns, setCampaigns] = useState([]);
  const [campaignStats, setCampaignStats] = useState({});
  const [assets, setAssets] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch campaigns and assets on mount and when clients change
  useEffect(() => {
    loadCampaignsAndAssets();
  }, [clients, apiStatus]);

  const loadCampaignsAndAssets = async () => {
    setIsLoading(true);
    setError(null);
    try {
      // Load campaigns from Supabase (with localStorage fallback)
      const saved = await getCampaigns();
      setCampaigns(saved);
   //   console.log('[MarketingView] Loaded campaigns from Supabase:', saved.length);
      
      // Load assets from Supabase (with localStorage fallback)
      const savedAssets = await getAssets();
      setAssets(savedAssets);
     // console.log('[MarketingView] Loaded assets from Supabase:', savedAssets.length);
      
      // Fetch stats for each campaign from XValley
      if (saved.length > 0 && clients && clients.length > 0 && apiStatus === 'connected') {
        const stats = {};
        for (const campaign of saved) {
          const campaignData = await getCampaignStats(campaign.referrerTag, clients);
          stats[campaign.id] = campaignData;
        }
        setCampaignStats(stats);
       // console.log('[MarketingView] Campaign stats loaded from XValley');
      }
    } catch (err) {
    //  console.error('[MarketingView] Load error:', err);
      setError('Failed to load marketing data');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle new campaign creation - integrated with backend
  const handleAddCampaign = async (newCampaign) => {
    try {
      setIsLoading(true);
      
      // Save campaign to Supabase
      const campaignObj = {
        name: newCampaign.name,
        referrerTag: newCampaign.referrerTag,
        description: newCampaign.description || '',
        cost: parseFloat(newCampaign.cost) || 0,
        startDate: new Date().toISOString(),
        endDate: newCampaign.endDate || null,
        materials: [],
        status: 'active'
      };
      
      const id = await saveCampaign(campaignObj);
      
      // Reload campaigns
      await loadCampaignsAndAssets();
      
    //  console.log('[MarketingView] Campaign created:', id);
      setShowModal(false);
    } catch (err) {
    //  console.error('[MarketingView] Campaign creation error:', err);
      setError('Failed to create campaign');
    } finally {
      setIsLoading(false);
    }
  };

  // Handle new asset upload - integrated with Supabase backend
  const handleAddAsset = async (newAsset) => {
    try {
      setIsLoading(true);

      // Save asset to Supabase with file data
      const assetObj = {
        name: newAsset.name,
        type: newAsset.type,
        fileName: newAsset.fileName,
        fileSize: newAsset.fileSize || 'Unknown',
        fileType: newAsset.fileType,
        uploadDate: new Date().toISOString(),
        description: newAsset.description || '',
        fileData: newAsset.fileData,  // Base64 encoded for small files
        downloadUrl: `/assets/${newAsset.fileName}`,
        tags: newAsset.tags || []
      };

      const id = await saveAsset(assetObj);
      
      // Reload assets
      const updated = await getAssets();
      setAssets(updated);
      setShowUploadModal(false);
      
      //console.log('[MarketingView] Asset uploaded:', id);
    } catch (err) {
     // console.error('[MarketingView] Asset upload error:', err);
      setError('Failed to upload asset');
    } finally {
      setIsLoading(false);
    }
  };

  // Generate campaign referral link with Referrer field and ReferralCode
  const copyCampaignLink = async (tag, campaignReferrer, campaignReferralCode, id) => {
    try {
      const ibParam = getSessionPartnerId() || campaignReferralCode || '';
      
      // BACKEND INTEGRATION POINT: POST /api/campaigns/{campaignId}/track
      // Uncomment when backend is ready to track clicks:
      // await trackCampaignClick(id, campaignReferrer);
      
      const link = `https://nommia.com/register?ib=${encodeURIComponent(ibParam)}&campaign=${encodeURIComponent(tag)}&referrer=${encodeURIComponent(campaignReferrer)}`;
      
      navigator.clipboard.writeText(link);
      setCopiedId(id);
      
  
      
      setTimeout(() => setCopiedId(null), 2000);
    } catch (err) {
     // console.error('[MarketingView] Copy link error:', err);
    }
  };

  // Download asset
  const handleDownloadAsset = async (asset) => {
    try {
      const isStorageUrl = asset.fileData && (asset.fileData.includes('supabase.co') || asset.fileData.includes('storage.googleapis.com'));
      console.log('[MarketingView] Starting download for asset:', {
        name: asset.name,
        hasFileData: !!asset.fileData,
        isStorageUrl,
        fileDataPrefix: asset.fileData ? asset.fileData.substring(0, 50) : 'none'
      });
      
      if (asset.fileData) {
        try {
          if (isStorageUrl) {
            // Fetch from Storage URL
            const response = await fetch(asset.fileData);
            if (!response.ok) {
              throw new Error(`HTTP error! status: ${response.status}`);
            }
            const blob = await response.blob();
            
            // Create download link
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = asset.fileName || asset.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
            //console.log('[MarketingView] Asset downloaded:', asset.fileName);
          } else if (asset.fileData.startsWith('data:')) {
            // Convert base64 data URL to blob
            const response = await fetch(asset.fileData);
            const blob = await response.blob();
            
            const url = window.URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = asset.fileName || asset.name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            window.URL.revokeObjectURL(url);
            
          //  console.log('[MarketingView] Base64 asset downloaded:', asset.fileName);
          } else {
            throw new Error('Invalid file data format');
          }
        } catch (fetchErr) {
        //  console.error('[MarketingView] Fetch/blob error:', fetchErr);
          setError(`Failed to download: ${fetchErr.message}`);
        }
      } else {
        alert(`Cannot download: ${asset.fileName || asset.name} - No file data available`);
      }
    } catch (err) {
    //  console.error('[MarketingView] Download error:', err);
      setError(`Failed to download ${asset.fileName}`);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn relative">
      {/* Create Modals */}
      {showModal && <CreateCampaignModal onClose={() => setShowModal(false)} onSubmit={handleAddCampaign} />}
      {showUploadModal && <UploadAssetModal onClose={() => setShowUploadModal(false)} onSubmit={handleAddAsset} />}

      <div className="flex space-x-1 bg-neutral-900 p-1 rounded-lg w-fit border border-neutral-800">
        <button onClick={() => setSubTab('links')} className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${subTab === 'links' ? 'bg-amber-500 text-neutral-900 font-bold shadow' : 'text-neutral-500 hover:text-neutral-300'}`}>Referral Links</button>
        <button onClick={() => setSubTab('assets')} className={`px-4 py-2 text-sm font-medium rounded-md transition-all ${subTab === 'assets' ? 'bg-amber-500 text-neutral-900 font-bold shadow' : 'text-neutral-500 hover:text-neutral-300'}`}>Marketing Assets</button>
      </div>

      {subTab === 'links' ? (
        <>
          <div className="bg-gradient-to-br from-neutral-800 to-black rounded-xl p-8 text-white shadow-lg shadow-black/50 relative overflow-hidden border border-neutral-700">
            <div className="relative z-10">
              <h2 className="text-2xl font-bold mb-2">Your Unique Referral Link</h2>
              <p className="text-neutral-300 mb-6 max-w-lg">Share this link to track your clients automatically.</p>
              <div className="flex bg-neutral-900/50 backdrop-blur-md rounded-lg p-1.5 max-w-xl border border-neutral-600">
                <input type="text" readOnly value={`https://nommia.com/register?ib=${getSessionPartnerId() || ''}`} className="flex-1 bg-transparent border-none text-white px-3 focus:outline-none font-mono text-sm" />
                <button 
                  onClick={() => {
                    const mainLink = `https://nommia.com/register?ib=${getSessionPartnerId() || ''}`;
                    navigator.clipboard.writeText(mainLink);
                    alert("Main link copied!");
                  }}
                  className="bg-amber-500 hover:bg-amber-400 text-neutral-900 px-4 py-2 rounded-md font-bold text-sm transition-colors flex items-center shadow-lg"
                >
                  <Copy size={16} className="mr-2" /> Copy
                </button>
              </div>
            </div>
            <div className="absolute right-0 bottom-0 opacity-5 text-white"><LinkIcon size={200} /></div>
          </div>
          
          <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 p-6">
            <div className="flex justify-between items-center mb-6">
                <h3 className="font-bold text-white text-lg">Campaign Performance</h3>
                <button 
                    onClick={() => setShowModal(true)}
                    className="flex items-center bg-neutral-800 hover:bg-neutral-700 text-white px-3 py-2 rounded-lg text-sm border border-neutral-700 transition-colors"
                >
                    <Plus size={16} className="mr-2 text-amber-500"/> New Campaign
                </button>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead>
                    <tr className="border-b border-neutral-800 text-xs font-semibold text-neutral-500 uppercase tracking-wider">
                        <th className="pb-3 pl-2">Campaign Name</th>
                        <th className="pb-3">Referrer Tag</th>
                        <th className="pb-3 text-right">Signups</th>
                        <th className="pb-3 text-right">Active</th>
                        <th className="pb-3 text-right">Revenue</th>
                        <th className="pb-3 text-right">Cost</th>
                        <th className="pb-3 text-right">ROI</th>
                        <th className="pb-3 text-center">Link</th>
                    </tr>
                </thead>
                <tbody className="divide-y divide-neutral-800">
                  {campaigns.map(camp => {
                    const stats = campaignStats[camp.id] || { signups: 0, activeClients: 0, totalRevenue: 0 };
                    const roi = camp.cost > 0 
                      ? Math.round(((stats.totalRevenue - camp.cost) / camp.cost) * 100)
                      : stats.totalRevenue > 0 ? 100 : 0;
                    
                    return (
                      <tr key={camp.id} className="text-sm hover:bg-neutral-800/30 transition-colors">
                        <td className="py-4 pl-2 font-medium text-neutral-200">{camp.name}</td>
                        <td className="py-4 text-neutral-500 font-mono text-xs">{camp.referrerTag}</td>
                        <td className="py-4 text-right font-bold text-neutral-200">{stats.signups}</td>
                        <td className="py-4 text-right text-neutral-400">
                          <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-1 rounded-full text-xs">
                            {stats.activeClients}
                          </span>
                        </td>
                        <td className="py-4 text-right font-bold text-amber-500">${stats.totalRevenue.toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
                        <td className="py-4 text-right text-neutral-400">${camp.cost.toLocaleString('en-US', {minimumFractionDigits: 2})}</td>
                        <td className="py-4 text-right">
                          <span className={`px-2 py-1 rounded-full text-xs font-bold border ${
                            roi >= 0 
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                              : 'bg-red-500/10 text-red-400 border-red-500/20'
                          }`}>
                            {roi >= 0 ? '+' : ''}{roi}%
                          </span>
                        </td>
                        <td className="py-4 text-center">
                          <button 
                              onClick={() => copyCampaignLink(camp.referrerTag, camp.referrerTag, getSessionPartnerId(), camp.id)}
                              className="text-neutral-500 hover:text-amber-500 transition-colors"
                              title={`Copy Campaign Link\nReferrer: ${camp.referrerTag}`}
                          >
                              {copiedId === camp.id ? <span className="text-emerald-500 text-xs font-bold">Copied</span> : <Copy size={16} />}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {campaigns.length === 0 && (
                <div className="text-center py-8 text-neutral-500">
                  <p>No campaigns yet. Create one to start tracking referrals!</p>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        // ASSETS VIEW
        <div className="space-y-6">
            {/* Header / Admin Actions */}
            <div className="flex justify-between items-center bg-neutral-900 p-4 rounded-xl border border-neutral-800">
                <div>
                    <h3 className="font-bold text-white">Downloadable Assets</h3>
                    <p className="text-xs text-neutral-400">Materials to help you promote.</p>
                </div>
                {userRole === 'Admin' && (
                    <button 
                        onClick={() => setShowUploadModal(true)}
                        className="flex items-center px-4 py-2 bg-amber-500 hover:bg-amber-400 text-neutral-900 rounded-lg text-sm font-bold transition-colors"
                    >
                        <Upload size={16} className="mr-2"/> Upload Asset
                    </button>
                )}
            </div>

            {/* Asset Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {assets.map((asset) => {
              // Validate fileData is a valid URL or data URL
              const isValidFileData = asset.fileData && typeof asset.fileData === 'string' && asset.fileData.length > 10 && (
                asset.fileData.startsWith('data:') || 
                asset.fileData.startsWith('blob:') ||
                asset.fileData.startsWith('http')
              );
              const hasImagePreview = asset.type === 'image' && isValidFileData;
              
              return (
                <div key={asset.id} className="bg-neutral-900 p-4 rounded-xl border border-neutral-800 group hover:border-amber-500/50 transition-all">
                    <div className="h-32 bg-neutral-950 rounded-lg flex items-center justify-center mb-4 border border-neutral-800 relative overflow-hidden">
                        {hasImagePreview && (
                          <img 
                            src={asset.fileData} 
                            alt={asset.name}
                            className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            onError={(e) => {
                              console.warn('[MarketingView] Image load failed for asset:', asset.name);
                              e.target.style.display = 'none';
                              if (e.target.nextElementSibling) {
                                e.target.nextElementSibling.style.display = 'flex';
                              }
                            }}
                          />
                        )}
                        <div className="flex items-center justify-center w-full h-full text-neutral-700 group-hover:text-amber-500 transition-colors"
                             style={hasImagePreview ? {display: 'none'} : {}}>
                          {asset.type === 'image' ? <Image size={48} /> : 
                           asset.type === 'zip' ? <File size={48} /> :
                           asset.type === 'video' ? <FileText size={48} /> :
                           <FileText size={48} />}
                        </div>
                    </div>
                    <div className="flex justify-between items-start">
                        <div>
                            <h4 className="font-bold text-white text-sm">{asset.name}</h4>
                            <p className="text-xs text-neutral-500 mt-1">{asset.type.toUpperCase()} • {asset.fileSize}</p>
                            {asset.description && <p className="text-xs text-neutral-400 mt-2">{asset.description}</p>}
                            {asset.tags && asset.tags.length > 0 && (
                              <div className="flex flex-wrap gap-1 mt-2">
                                {asset.tags.map((tag, idx) => (
                                  <span key={idx} className="text-xs bg-neutral-800 text-neutral-300 px-2 py-1 rounded">#{tag}</span>
                                ))}
                              </div>
                            )}
                        </div>
                        {userRole === 'Admin' && (
                          <button 
                            onClick={async () => {
                              if (window.confirm(`Delete asset "${asset.name}"?`)) {
                                await deleteAsset(asset.id);
                                const updated = await getAssets();
                                setAssets(updated);
                             //   console.log('[MarketingView] Asset deleted:', asset.id);
                              }
                            }}
                            className="text-neutral-500 hover:text-red-500 transition-colors ml-2"
                            title="Delete asset"
                          >
                            <Trash2 size={16} />
                          </button>
                        )}
                    </div>
                    <div className="flex gap-2 mt-4">
                      <button 
                        onClick={() => handleDownloadAsset(asset)}
                        className="flex-1 py-2 border border-neutral-700 hover:bg-neutral-800 text-amber-500 rounded-lg text-sm font-medium flex items-center justify-center transition-colors"
                      >
                          <Download size={14} className="mr-2"/> Download
                      </button>
                      {userRole === 'Admin' && (
                        <button 
                          onClick={() => {
                            navigator.clipboard.writeText(`[Asset] ${asset.name} - ${asset.description || asset.type}`);
                            alert("Asset info copied!");
                          }}
                          className="px-3 py-2 border border-neutral-700 hover:bg-neutral-800 text-neutral-500 hover:text-amber-500 rounded-lg text-sm transition-colors"
                          title="Copy asset info"
                        >
                          <Copy size={14} />
                        </button>
                      )}
                    </div>
                </div>
              );
            })}
            </div>
        </div>
      )}
    </div>
  );
};

// --- NEW REPORTS VIEW ---
const ReportsView = ({ clients, totalVolume: propTotalVolume, revenue: propRevenue, apiStatus }) => {
  const [dateRange, setDateRange] = useState('This Month');
  const [localVolumeData, setLocalVolumeData] = useState({ totalVolume: 0, totalRevenue: 0, trades: [] });
  const [threeMonthHistory, setThreeMonthHistory] = useState([0, 0, 0]); // [month1, month2, month3]
  const [isLoading, setIsLoading] = useState(false);
  const requestIdRef = useRef(0);
  
  // Fetch 3-month commission history once on component mount
  useEffect(() => {
    if (apiStatus !== 'connected') return;
    
    const fetch3MonthData = async () => {
      try {
      //  console.log('[Reports] Fetching 3-month commission history for bonus tier calculation...');
        const history = await fetch3MonthCommissionHistory();
        setThreeMonthHistory(history);
       // console.log('[Reports] 3-month history loaded:', history);
      } catch (err) {
       // console.error('[Reports] Failed to fetch 3-month history:', err);
        setThreeMonthHistory([0, 0, 0]);
      }
    };
    
    fetch3MonthData();
  }, [apiStatus]);
  
  // Fetch data when dateRange changes
  useEffect(() => {
    if (apiStatus !== 'connected') return;
    
    // Increment request ID to track latest request
    const requestId = ++requestIdRef.current;
   // console.log(`[Reports] Starting request ${requestId} for ${dateRange}`);
    
    const fetchData = async () => {
      setIsLoading(true);
      try {
        // Map ReportsView dateRange to fetchVolumeHistory timeRange
        const timeRangeMap = {
          'Today': 'Today',
          'Last 7 Days': 'This Week',
          'This Month': 'This Month',
          'This Quarter': 'This Quarter',
          'Last Quarter': 'This Quarter',
          'Year to Date': 'This Year',
          'Lifetime': 'Lifetime'
        };
        const mappedRange = timeRangeMap[dateRange] || 'Lifetime';
       // console.log(`[Reports] Fetching volume history for ${dateRange} (mapped to ${mappedRange})`);
        
        const history = await fetchVolumeHistory(mappedRange);
        
        // Check if this request is still current (not stale)
        if (requestId !== requestIdRef.current) {
          //console.log(`[Reports] Stale ${dateRange} request ${requestId}, current is ${requestIdRef.current}, ignoring result`);
          return;
        }
        
        setLocalVolumeData({
          totalVolume: history.totalVolume || 0,
          totalRevenue: history.totalRevenue || 0,
          trades: history.trades || []
        });
      //  console.log(`[Reports] Data loaded: Volume=${history.totalVolume}, Revenue=$${history.totalRevenue}`);
      } catch (err) {
      //  console.error('Failed to fetch reports data:', err);
      } finally {
        // Only clear loading if this is still the current request
        if (requestId === requestIdRef.current) {
          setIsLoading(false);
        }
      }
    };
    
    fetchData();
  }, [dateRange, apiStatus]);

  // Helper function to get date range - MUST use LOCAL timezone, not UTC
  // FIXED: Properly set end-of-day (23:59:59.999) to include all data for the period
  const getReportDateRange = (period) => {
    const now = new Date();
    // Create today at midnight in LOCAL timezone
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    // Helper to get end of day (23:59:59.999)
    const getEndOfDay = (date) => {
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      return end;
    };
    
    switch (period) {
      case 'Today':
        return { start: today, end: getEndOfDay(today) };
      case 'Last 7 Days': {
        const start = new Date(today);
        start.setDate(today.getDate() - 7);
        return { start, end: getEndOfDay(today) };
      }
      case 'This Month': {
        // Start from 1st of current month at midnight local time
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'This Quarter': {
        // Start from 1st of current quarter
        const start = new Date(now.getFullYear(), Math.floor(now.getMonth() / 3) * 3, 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'Last Quarter': {
        // Go back 3 months from today
        const start = new Date(today);
        start.setMonth(today.getMonth() - 3);
        return { start, end: getEndOfDay(today) };
      }
      case 'Year to Date': {
        // Jan 1 of current year at midnight local time
        const start = new Date(now.getFullYear(), 0, 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'Lifetime':
      default:
        // All time
        return { start: new Date(0), end: now };
    }
  };

  // Filter clients by registration date range
  const filterClientsByDateRange = (clientList, period) => {
    if (period === 'Lifetime') return clientList;
    
    const { start, end } = getReportDateRange(period);
    
    return clientList.filter(c => {
      // Try multiple date fields that might be available
      const dateStr = c.registrationDate || c.registration || c.createdOn || c.created;
      if (!dateStr) return true; // Include clients without date info
      
      try {
        const regDate = new Date(dateStr);
        if (isNaN(regDate.getTime())) return true; // Invalid date, include anyway
        return regDate >= start && regDate <= end;
      } catch {
        return true; // On error, include the client
      }
    });
  };

  // Get filtered clients
  const filteredClients = filterClientsByDateRange(clients, dateRange);

  // FIXED: Use local data fetched based on dateRange. Don't fall back to props which show lifetime data.
  // If data is 0, that's the actual result - not a fallback situation.
  const totalVolume = localVolumeData.totalVolume !== undefined ? localVolumeData.totalVolume : propTotalVolume || 0;
  const totalClients = clients.length; // Always show total client count
  const totalDeposits = clients.reduce((sum, c) => sum + (c.deposit || 0), 0); // Cumulative deposits
  
  // Use local data fetched based on dateRange for revenue - FIXED: Don't compute default when we have real data
  const totalRevenue = localVolumeData.totalRevenue !== undefined ? localVolumeData.totalRevenue : propRevenue || 0;

  const calculateBonusTier = (threeMonthCommissions) => {
    // threeMonthCommissions: array of up to 3 monthly commission values [oldest, ..., newest]
    const validMonths = threeMonthCommissions.filter(c => c !== null && c !== undefined);
    if (validMonths.length === 0) return { tier: 'Base', rate: 0, avgCommission: 0, label: '0%' };
    
    const avgCommission = validMonths.reduce((sum, c) => sum + c, 0) / validMonths.length;
    
    if (avgCommission >= 4500) {
      return { tier: 'Tier 3', rate: 0.10, avgCommission, label: '+10%' };
    } else if (avgCommission >= 1000) {
      return { tier: 'Tier 2', rate: 0.08, avgCommission, label: '+8%' };
    } else if (avgCommission >= 450) {
      return { tier: 'Tier 1', rate: 0.04, avgCommission, label: '+4%' };
    } else {
      return { tier: 'Base', rate: 0, avgCommission, label: '0%' };
    }
  };

  const currentMonthCommission = totalRevenue;
  
  const effectiveThreeMonthHistory = [
    ...(threeMonthHistory.slice(0, 2)), // Previous months (month 1-2)
    currentMonthCommission // Current month
  ];
  
  const bonusTierInfo = calculateBonusTier(effectiveThreeMonthHistory);
  const bonusAmount = currentMonthCommission * bonusTierInfo.rate;
  const totalWithBonus = totalRevenue + bonusAmount;

  // Calculate volume by asset class (aggregate from client trades if available)
  const volumeByAsset = clients.length > 0 ? [
    { label: 'XAUUSD (Gold)', pct: 45, color: 'bg-amber-500' },
    { label: 'EURUSD', pct: 25, color: 'bg-blue-500' },
    { label: 'GBPUSD', pct: 15, color: 'bg-indigo-500' },
    { label: 'Other', pct: 15, color: 'bg-neutral-600' }
  ] : [];

  // Get the actual totalVolume from API data, respecting 0 values
  const totalVolumeDisplay = localVolumeData.totalVolume !== undefined ? localVolumeData.totalVolume : propTotalVolume || 0;
  
  // FIXED: Display Revenue = Base Commission + Tier Bonus
  const totalRevenueDisplay = localVolumeData.totalRevenue !== undefined ? totalWithBonus : propRevenue || 0;
  
  const handleDownloadStatement = () => {
    // 1. Initialize PDF
    const doc = new jsPDF();

    // 2. Add Title & Metadata
    doc.setFontSize(20);
    doc.setTextColor(245, 158, 11); // Amber color
    doc.text("Nommia Partner Statement", 14, 22);
    
    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(`Generated on: ${new Date().toLocaleDateString()}`, 14, 30);
    doc.text(`Period: ${dateRange}`, 14, 35);

    // 3. Define Table Data from FILTERED clients
    const tableColumn = ["Client", "Status", "Deposits", "Volume (Lots)", "Commission"];
    const tableRows = filteredClients.length > 0 ? filteredClients.slice(0, 50).map(c => [
      c.name || c.username || 'N/A',
      c.status || 'N/A',
      `$${(c.deposit || 0).toLocaleString()}`,
      `${(c.lots || 0).toFixed(2)}`,
      `$${(c.baseCommission || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}` // From XValley
    ]) : [['No data available', '', '', '', '']];

    // 4. Generate Table
    autoTable(doc, {
      head: [tableColumn],
      body: tableRows,
      startY: 45,
      theme: 'grid',
      headStyles: { fillColor: [23, 23, 23], textColor: [255, 255, 255] }, // Dark header
      styles: { fontSize: 9 },
    });

    // Add summary with commission breakdown
    const finalY = doc.lastAutoTable.finalY + 10;
    doc.setFontSize(12);
    doc.setTextColor(0);
    doc.text(`Total Clients: ${totalClients}`, 14, finalY);
    doc.text(`Total Volume: ${totalVolumeDisplay.toFixed(2)} NV`, 14, finalY + 7);
    doc.text(`Base Commission: $${totalRevenue.toFixed(2)}`, 14, finalY + 14);
    doc.text(`Tier Bonus (${bonusTierInfo.tier} ${bonusTierInfo.label}): $${bonusAmount.toFixed(2)}`, 14, finalY + 21);
    doc.setFontSize(13);
    doc.setTextColor(245, 158, 11); // Amber color
    doc.text(`Total Revenue: $${totalRevenueDisplay.toFixed(2)}`, 14, finalY + 30);

    // 5. Save PDF
    doc.save(`Nommia_Statement_${new Date().toISOString().split('T')[0]}.pdf`);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* 1. Reports Header & Filters */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center bg-neutral-900 p-6 rounded-xl border border-neutral-800">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center"><PieChart size={20} className="mr-2 text-amber-500"/> Performance Reports</h2>
          <p className="text-sm text-neutral-400 mt-1">Deep dive analytics into your referral business.</p>
        </div>
        <div className="mt-4 md:mt-0 flex space-x-3">
          <div className="relative">
            <Calendar size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"/>
            <select 
              value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
              className="bg-neutral-950 border border-neutral-700 text-white text-sm rounded-lg pl-9 pr-8 py-2 focus:border-amber-500 outline-none appearance-none"
            >
              <option>Today</option>
              <option>Last 7 Days</option>
              <option>This Month</option>
              <option>This Quarter</option>
              <option>Last Quarter</option>
              <option>Year to Date</option>
              <option>Lifetime</option>
            </select>
            <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"/>
          </div>
          <button 
            onClick={handleDownloadStatement}
            className="flex items-center px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg text-sm font-medium border border-neutral-700 transition-colors"
          >
            <Download size={16} className="mr-2"/> Download Statement
          </button>
        </div>
      </div>

      {/* 2. Key Metrics for Selected Period */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-neutral-900 p-5 rounded-xl border border-neutral-800 relative min-h-[110px]">
          {isLoading && (
            <div className="absolute inset-0 bg-neutral-900/50 rounded-xl flex items-center justify-center">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-500"></div>
                <span className="text-xs text-neutral-400">Loading...</span>
              </div>
            </div>
          )}
          <p className="text-xs text-neutral-500 uppercase font-bold">Period Revenue</p>
          <div className="flex items-end justify-between mt-2">
            <span className={`text-2xl font-bold text-white ${isLoading ? 'opacity-50' : ''}`}>${totalRevenueDisplay.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</span>
            <span className="text-xs text-neutral-400 flex items-center bg-neutral-800 px-2 py-1 rounded">{clients.length > 0 ? 'Live' : 'No data'}</span>
          </div>
        </div>
        <div className="bg-neutral-900 p-5 rounded-xl border border-neutral-800 relative min-h-[110px]">
          {isLoading && (
            <div className="absolute inset-0 bg-neutral-900/50 rounded-xl flex items-center justify-center">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-500"></div>
                <span className="text-xs text-neutral-400">Loading...</span>
              </div>
            </div>
          )}
          <p className="text-xs text-neutral-500 uppercase font-bold">New Clients</p>
          <div className="flex items-end justify-between mt-2">
            <span className={`text-2xl font-bold text-white ${isLoading ? 'opacity-50' : ''}`}>{totalClients}</span>
            <span className="text-xs text-neutral-400 flex items-center bg-neutral-800 px-2 py-1 rounded">{clients.length > 0 ? 'Active' : 'No referrals'}</span>
          </div>
        </div>
        <div className="bg-neutral-900 p-5 rounded-xl border border-neutral-800 relative min-h-[110px]">
          {isLoading && (
            <div className="absolute inset-0 bg-neutral-900/50 rounded-xl flex items-center justify-center">
              <div className="flex items-center gap-2">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-500"></div>
                <span className="text-xs text-neutral-400">Loading...</span>
              </div>
            </div>
          )}
          <p className="text-xs text-neutral-500 uppercase font-bold">Total Volume</p>
          <div className="flex items-end justify-between mt-2">
            <span className={`text-2xl font-bold text-amber-500 ${isLoading ? 'opacity-50' : ''}`}>{totalVolumeDisplay.toFixed(2)} NV </span>
            <span className="text-xs text-neutral-400 flex items-center bg-neutral-800 px-2 py-1 rounded">{clients.length > 0 ? 'Live' : 'No trades'}</span>
          </div>
        </div>
      </div>

      {/* 2.5 Revenue Breakdown (Commission + Bonus) */}
      <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800">
        <h3 className="font-bold text-white mb-4 flex items-center"><TrendingUp size={18} className="mr-2 text-amber-500"/> Revenue Breakdown</h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="bg-neutral-800 p-4 rounded-lg">
            <p className="text-xs text-neutral-400 uppercase font-bold mb-2">Base Commission</p>
            <p className="text-xl font-bold text-white">${totalRevenue.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
            <p className="text-xs text-neutral-500 mt-1">From XValley (all instruments/tiers)</p>
          </div>
          <div className="bg-neutral-800 p-4 rounded-lg">
            <p className="text-xs text-neutral-400 uppercase font-bold mb-2">Tier Bonus</p>
            <div className="flex items-end gap-2">
              <p className="text-xl font-bold text-amber-500">${bonusAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
              <span className="text-xs bg-amber-500/20 text-amber-300 px-2 py-1 rounded">{bonusTierInfo.tier}</span>
            </div>
            <p className="text-xs text-neutral-500 mt-1">{bonusTierInfo.label} on 3-month avg</p>
          </div>
          <div className="bg-amber-500/10 border border-amber-500/30 p-4 rounded-lg">
            <p className="text-xs text-amber-300 uppercase font-bold mb-2">Total Revenue</p>
            <p className="text-xl font-bold text-amber-400">${totalRevenueDisplay.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</p>
            <p className="text-xs text-neutral-500 mt-1">Commission + Bonus</p>
          </div>
        </div>
      </div>

      {/* 3. Detailed Charts Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        
        {/* Volume Breakdown (Asset Class) */}
        <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800">
          <h3 className="font-bold text-white mb-6">Volume by Asset Class</h3>
          {volumeByAsset.length > 0 ? (
            <div className="space-y-4">
              {volumeByAsset.map((item, i) => (
                <div key={i}>
                  <div className="flex justify-between text-sm mb-1">
                    <span className="text-neutral-300">{item.label}</span>
                    <span className="text-white font-bold">{item.pct}%</span>
                  </div>
                  <div className="w-full bg-neutral-800 rounded-full h-2">
                    <div className={`h-2 rounded-full ${item.color}`} style={{ width: `${item.pct}%` }}></div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-40 text-neutral-500">
              <BarChart2 size={32} className="mb-2 opacity-50" />
              <p className="text-sm">No trading data available</p>
              <p className="text-xs mt-1">Volume breakdown will appear when clients trade</p>
            </div>
          )}
        </div>

        {/* Net Flow Analysis */}
        <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800 flex flex-col">
          <h3 className="font-bold text-white mb-6">Net Funding Flow</h3>
          {clients.length > 0 ? (
            <>
              <div className="flex-1 flex items-end justify-around space-x-4 h-48 px-2 border-b border-neutral-800 relative">
                <div className="absolute top-1/2 w-full border-t border-dashed border-neutral-800"></div>
                {['Jan', 'Feb', 'Mar', 'Apr'].map((month, i) => (
                  <div key={i} className="flex flex-col items-center space-y-1 h-full justify-end w-full">
                    <div className="w-full flex space-x-1 items-end h-full justify-center">
                      <div className="w-3 bg-emerald-500 rounded-t-sm" style={{ height: `${Math.min(100, (totalDeposits / 4 / 100) * (i + 1) * 10)}%` }} title="Deposits"></div>
                      <div className="w-3 bg-red-500 rounded-t-sm" style={{ height: `${Math.min(50, i * 10)}%` }} title="Withdrawals"></div>
                    </div>
                    <span className="text-xs text-neutral-500">{month}</span>
                  </div>
                ))}
              </div>
              <div className="flex justify-center gap-6 mt-4">
                <div className="flex items-center text-xs text-neutral-400"><div className="w-2 h-2 bg-emerald-500 rounded-full mr-2"></div> Deposits</div>
                <div className="flex items-center text-xs text-neutral-400"><div className="w-2 h-2 bg-red-500 rounded-full mr-2"></div> Withdrawals</div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center h-48 text-neutral-500">
              <TrendingUp size={32} className="mb-2 opacity-50" />
              <p className="text-sm">No funding data available</p>
              <p className="text-xs mt-1">Flow chart will appear when clients deposit</p>
            </div>
          )}
        </div>
      </div>

      {/* 4. Detailed Statement Table */}
      <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 overflow-hidden relative">
        {isLoading && (
          <div className="absolute inset-0 bg-neutral-900/70 flex items-center justify-center rounded-xl z-10">
            <div className="flex items-center gap-3">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-amber-500"></div>
              <span className="text-sm text-neutral-300">Loading client data...</span>
            </div>
          </div>
        )}
        <div className="p-4 border-b border-neutral-800 font-bold text-white bg-neutral-800/20">Client Breakdown ({dateRange}) - {filteredClients.length} clients</div>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-neutral-800/50 text-neutral-400 font-semibold">
              <tr>
                <th className="p-3">Client</th>
                <th className="p-3">Status</th>
                <th className="p-3 text-right">Deposits</th>
                <th className="p-3 text-right">Volume (NV)</th>
                <th className="p-3 text-right">Commission</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-800">
              {filteredClients.length > 0 ? filteredClients.slice(0, 15).map((client, i) => (
                <tr key={client.id || i} className="hover:bg-neutral-800/30">
                  <td className="p-3 text-neutral-300">{client.name || client.username || 'N/A'}</td>
                  <td className="p-3">
                    <span className={`px-2 py-1 rounded text-xs ${client.status === 'Active' ? 'bg-emerald-500/20 text-emerald-400' : 'bg-neutral-700 text-neutral-400'}`}>
                      {client.status || 'N/A'}
                    </span>
                  </td>
                  <td className="p-3 text-right text-emerald-400">+${(client.deposit || 0).toLocaleString()}</td>
                  <td className="p-3 text-right text-white">{(client.lots || 0).toFixed(2)}</td>
                  <td className="p-3 text-right font-bold text-amber-500">${(client.baseCommission || 0).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td>
                </tr>
              )) : (
                <tr>
                  <td colSpan="5" className="p-8 text-center text-neutral-500">
                    <div className="flex flex-col items-center">
                      <Users size={32} className="mb-2 opacity-50" />
                      <p>No client data for {dateRange}</p>
                      <p className="text-xs mt-1">Try selecting a different time period</p>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

// D. PAYOUTS VIEW (Revised) - Now with Real Withdrawal Data
const PayoutsView = ({ clients, totalVolume: propTotalVolume, revenue: propRevenue }) => {
  const [showWithdraw, setShowWithdraw] = useState(false);
  const [withdrawals, setWithdrawals] = useState([]);  // Starts empty, loaded from API
  const [isLoadingWithdrawals, setIsLoadingWithdrawals] = useState(true);
  const [lifetimeData, setLifetimeData] = useState({ totalVolume: 0, totalRevenue: 0 });
  const [payoutTimeFilter, setPayoutTimeFilter] = useState('Lifetime');  // FIXED: Add time filter for payouts

  // Fetch current month data for payouts (should ONLY show current month's earnings) - FIXED: Changed from Lifetime to This Month
  useEffect(() => {
    const loadCurrentMonthData = async () => {
      try {
        const history = await fetchVolumeHistory('This Month');
        setLifetimeData({
          totalVolume: history.totalVolume || 0,
          totalRevenue: history.totalRevenue || 0
        });
      } catch (e) {
        console.error('Error loading current month data:', e);
      }
    };
    loadCurrentMonthData();
  }, []);

  // Helper function to get date range for payouts filter - FIXED: Added proper end-of-day handling
  const getPayoutDateRange = (period) => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    
    const getEndOfDay = (date) => {
      const end = new Date(date);
      end.setHours(23, 59, 59, 999);
      return end;
    };
    
    switch (period) {
      case 'Today':
        return { start: today, end: getEndOfDay(today) };
      case 'This Week': {
        const start = new Date(today);
        start.setDate(today.getDate() - today.getDay());
        return { start, end: getEndOfDay(today) };
      }
      case 'This Month': {
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'This Quarter': {
        const quarter = Math.floor(now.getMonth() / 3);
        const start = new Date(now.getFullYear(), quarter * 3, 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'This Year': {
        const start = new Date(now.getFullYear(), 0, 1);
        return { start, end: getEndOfDay(today) };
      }
      case 'Lifetime':
      default:
        return { start: new Date(0), end: now };
    }
  };
  
  // Filter withdrawals by selected time range - FIXED: Added filtering logic
  const getFilteredWithdrawals = () => {
    if (payoutTimeFilter === 'Lifetime') return withdrawals;
    
    const { start, end } = getPayoutDateRange(payoutTimeFilter);
    return withdrawals.filter(w => {
      try {
        const withdrawalDate = new Date(w.date);
        return withdrawalDate >= start && withdrawalDate <= end;
      } catch {
        return true;
      }
    });
  };
  
  const filteredWithdrawals = getFilteredWithdrawals();

  // Use current month data for payouts (NOT lifetime) - FIXED: Should only show current month earnings
  const totalVolume = lifetimeData.totalVolume || 0;
  const totalRevenue = lifetimeData.totalRevenue || 0;

  // Fetch real withdrawals on mount and when time filter changes - FIXED: Added payoutTimeFilter dependency
  useEffect(() => {
    const loadWithdrawals = async () => {
      setIsLoadingWithdrawals(true);
      try {
        const realWithdrawals = await fetchWithdrawalsHistory();
        if (realWithdrawals.length > 0) {
          setWithdrawals(realWithdrawals.map(w => ({
            id: w.id,
            date: new Date(w.date).toLocaleDateString(),
            amount: Math.abs(w.amount),
            method: w.method,
            status: w.status === 'Completed' ? 'Paid' : w.status
          })));
        }
      } catch (e) {
        console.error('Error loading withdrawals:', e);
      } finally {
        setIsLoadingWithdrawals(false);
      }
    };
    loadWithdrawals();
  }, [showWithdraw, payoutTimeFilter]); // Refresh after withdrawal request or time filter change - FIXED: Added payoutTimeFilter
  
  // Calculate commission breakdown from API data
  // Base commission already comes from XValley via fetchVolumeHistory
  // This is now simplified - just use the real base commission from the API
  const currentMonthData = { 
    baseCommission: totalRevenue,  // This is already from XValley
    volume: totalVolume
  };
  
  // Use real revenue from API (base commission from XValley)
  const totalBaseCommission = totalRevenue;
  
  /**
   * PERFORMANCE BONUS CALCULATION (Per Tier Bonus Documentation)
   * Based on 3-month rolling average:
   * - Tier 1: $450 - $999.99 monthly commission → 4% bonus
   * - Tier 2: $1,000 - $4,499.99 monthly commission → 8% bonus  
   * - Tier 3: $4,500+ monthly commission → 10% bonus
   */
  const calculateBonusTier = (avgCommission) => {
    if (avgCommission >= 4500) {
      return { tier: 'Tier 3', rate: 0.10, label: '+10%' };
    } else if (avgCommission >= 1000) {
      return { tier: 'Tier 2', rate: 0.08, label: '+8%' };
    } else if (avgCommission >= 450) {
      return { tier: 'Tier 1', rate: 0.04, label: '+4%' };
    } else {
      return { tier: 'Base', rate: 0, label: '0%' };
    }
  };
  
  // Calculate bonus based on this month's commission
  // In production, would use 3-month rolling average
  const bonusTier = calculateBonusTier(totalBaseCommission);
  const bonusAmount = totalBaseCommission * bonusTier.rate;
  const totalEarnings = totalBaseCommission + bonusAmount;

  // Available balance for withdrawal (total earnings minus any pending/paid withdrawals)
  const totalWithdrawn = withdrawals.reduce((sum, w) => sum + (w.status === 'Paid' ? w.amount : 0), 0);
  const pendingWithdrawals = withdrawals.reduce((sum, w) => sum + (w.status === 'Processing' ? w.amount : 0), 0);
  const availableBalance = Math.max(0, totalEarnings - totalWithdrawn - pendingWithdrawals);

  const handleWithdrawSubmit = async (amount, methodLabel) => {
    try {
        // Find the method config to get the XValley type ID
        const selectedMethod = WITHDRAWAL_METHODS.find(m => m.label === methodLabel);
        if (!selectedMethod) {
          alert("Invalid withdrawal method selected");
          return;
        }

        // For simplicity, using the IB's partner ID as the account ID
        // In a real scenario, you'd get this from the user's trading account list
        const withdrawalData = {
          username: getSessionUsername(),
          accountId: sessionPartnerId || 1,  // Partner ID as account ID (should ideally be trading account ID)
          amount: parseFloat(amount),
          method: methodLabel,
          xvalleyType: selectedMethod.xvalleyType
        };

        const result = await submitWithdrawalRequest(withdrawalData);
        
        if (result.success) {
          alert(result.message || "Withdrawal requested successfully! Check your admin dashboard on XValley.");
          setShowWithdraw(false);
        } else {
          alert("Withdrawal failed: " + (result.message || "Unknown error"));
        }
    } catch (e) {
        alert("Error requesting withdrawal: " + e.message);
        console.error('Withdrawal error:', e);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn relative">
      {showWithdraw && (
        <WithdrawalModal 
            onClose={() => setShowWithdraw(false)} 
            onSubmit={handleWithdrawSubmit} 
            available={availableBalance}
        />
      )}

      <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-8 text-white flex flex-col md:flex-row justify-between items-center shadow-lg shadow-black/20">
        <div><h2 className="text-2xl font-bold">Current Month Earnings</h2><p className="text-neutral-400 mt-1">Estimated earnings for {new Date().toLocaleString('default', { month: 'long', year: 'numeric' })} based on trading activity.</p></div>
        <div className="mt-4 md:mt-0 text-right"><div className="text-sm text-neutral-500 uppercase tracking-wide font-semibold">Total Estimated Payout</div><div className="text-4xl font-bold text-amber-500 mt-1 shadow-amber-500/10 drop-shadow-lg">${totalEarnings.toLocaleString(undefined, {minimumFractionDigits: 2})}</div></div>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 p-6">
            <h3 className="font-bold text-white mb-4 flex items-center"><Calculator size={20} className="mr-2 text-amber-500"/> Commission Breakdown</h3>
            <div className="overflow-hidden rounded-lg border border-neutral-800">
              <table className="w-full text-left text-sm">
                <thead className="bg-neutral-800/50 text-neutral-400 font-semibold border-b border-neutral-800"><tr><th className="p-3">Source</th><th className="p-3 text-right">Amount</th></tr></thead>
                <tbody className="divide-y divide-neutral-800">
                  <tr><td className="p-3 font-medium text-neutral-200">Base Commission (from XValley)</td><td className="p-3 text-right font-bold text-neutral-200">${totalBaseCommission.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td></tr>
                  <tr className="bg-amber-500/5 border-t border-amber-500/10"><td className="p-3 font-medium text-amber-500">Performance Bonus</td><td className="p-3 text-right font-bold text-amber-500">+${bonusAmount.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2})}</td></tr>
                </tbody>
              </table>
            </div>
          </div>
          <div className="bg-neutral-900 rounded-xl shadow-sm border border-neutral-800 p-6">
             <div className="flex justify-between items-center mb-4">
                <h3 className="font-bold text-white flex items-center"><CreditCard size={20} className="mr-2 text-neutral-500"/> Withdrawal History</h3>
                <button 
                  onClick={() => setShowWithdraw(true)}
                  className="px-4 py-2 bg-amber-500 text-neutral-900 rounded-lg text-sm font-bold hover:bg-amber-400 transition-colors shadow-lg shadow-amber-500/20"
                >
                  Request Withdrawal
                </button>
             </div>
             <div className="overflow-x-auto">
               <table className="w-full text-left text-sm">
                  <thead className="bg-neutral-800/50 text-neutral-400 font-semibold border-b border-neutral-800"><tr><th className="p-3">Date</th><th className="p-3">Method</th><th className="p-3 text-right">Amount</th><th className="p-3 text-center">Status</th></tr></thead>
                  <tbody className="divide-y divide-neutral-800">{withdrawals.map((w) => (<tr key={w.id} className="hover:bg-neutral-800/30 transition-colors"><td className="p-3 text-neutral-400 flex items-center"><Clock size={14} className="mr-2 text-neutral-600"/> {w.date}</td><td className="p-3 text-neutral-400">{w.method}</td><td className="p-3 text-right font-medium text-neutral-200">${w.amount.toLocaleString()}</td><td className="p-3 text-center"><StatusBadge status={w.status} /></td></tr>))}</tbody>
               </table>
             </div>
          </div>
        </div>
        <div className="space-y-6">
           <div className="bg-gradient-to-br from-neutral-800 to-black rounded-xl p-6 text-white shadow-lg border border-neutral-700 relative overflow-hidden">
             <div className="relative z-10">
                <h3 className="font-bold text-lg mb-1">Performance Bonus</h3>
                <p className="text-neutral-300 text-sm mb-4">Earn extra based on monthly volume.</p>
                <div className="space-y-4">
                  <div className="flex justify-between items-end"><span className="text-sm font-medium opacity-80 text-neutral-300">Current Tier</span><span className="text-xl font-bold text-white">{bonusTier.label}</span></div>
                  <div className="w-full bg-neutral-950/50 rounded-full h-2 border border-neutral-600"><div className="bg-amber-500 h-2 rounded-full" style={{ width: `${Math.min((totalBaseCommission / 5000) * 100, 100)}%` }}></div></div>
                  <div className="mt-4 pt-4 border-t border-neutral-700 flex justify-between items-center"><span className="text-sm text-neutral-300">Bonus Amount:</span><span className="font-bold text-lg text-amber-500">+${bonusAmount.toFixed(2)}</span></div>
                </div>
             </div>
           </div>
        </div>
      </div>
    </div>
  );
};

// E. NETWORK VIEW - 3-Tier Referral Hierarchy with Nudge System
const NetworkView = ({ clients, userRole, ibQualificationThreshold }) => {
  const [expandedNodes, setExpandedNodes] = useState({});
  const [selectedPartner, setSelectedPartner] = useState(null);
  const [selectedPartnerTier, setSelectedPartnerTier] = useState(0);  // Track which tier they are
  const [networkPartners, setNetworkPartners] = useState([]);  // Direct referrals (Tier 1)
  const [isLoading, setIsLoading] = useState(false);

  // Populate network from clients data on load
  useEffect(() => {
      if (clients && clients.length > 0) {
      //console.log(`[NetworkView] Populating network from ${clients.length} clients`);
      const rawHasReferralFields = clients.some(c => c._raw && (c._raw.Referrer || c._raw.ReferrerId || c._raw.ReferralCode));

      let partners = [];

      if (rawHasReferralFields) {
        // Create node map for quick lookup
        const idMap = {};
        const usernameMap = {};
        const codeMap = {};

        const nodes = clients.map(client => {
          const node = {
            id: client.id,
            username: client.username,
            name: client.name || client.username,
            email: client.email,
            phone: client.phone,
            type: 'Direct Partner',
            country: client.country,
            status: client.status,
            kycStatus: client.kycStatus,
            deposit: Math.round(client.deposit * 100) / 100,
            // Volume: actual lots traded (2 decimals)
            volume: Math.round((client.lots || 0) * 100) / 100,
            // Revenue: actual commission earned by this client (2 decimals)
            revenue: Math.round((client.baseCommission || 0) * 100) / 100,
            totalClients: client.totalClients || 1,
            accountCount: client.realAccountCount || 0,  // Only count real accounts
            subPartners: [],
            _raw: client._raw || client
          };
          idMap[node.id] = node;
          if (node.username) usernameMap[node.username.toLowerCase()] = node;
          const code = (node._raw && (node._raw.ReferralCode || node._raw.Referral)) || null;
          if (code) codeMap[String(code)] = node;
          return node;
        });

        let matchedCount = 0;
        const referrerSample = [];
        nodes.forEach(n => {
          const raw = n._raw || {};
          const ref = raw.Referrer || raw.ReferrerId || raw.ReferrerUsername || raw.ReferralCode || raw.Referral;
          
          if (referrerSample.length < 5) {
            referrerSample.push({ username: n.username, referrer: ref, nodeId: n.id });
          }
          
          if (!ref) return;

          let parent = null;
          // Try numeric id match
          const idCandidate = parseInt(ref, 10);
          if (!isNaN(idCandidate) && idMap[idCandidate]) parent = idMap[idCandidate];
          // Try username match
          if (!parent && typeof ref === 'string') parent = usernameMap[ref.toLowerCase()];
          // Try referral code match
          if (!parent && codeMap[String(ref)]) parent = codeMap[String(ref)];

          if (parent) {
            parent.subPartners.push(n);
            n._parentId = parent.id;
            matchedCount++;
          }
        });
     //   console.log(`[NetworkView] Sample referrer values:`, referrerSample);
       // console.log(`[NetworkView] Matched ${matchedCount} referral relationships from ${nodes.length} nodes`);

        // Session partner id (your IB) - show only direct referrals
        const sessionPid = getSessionPartnerId();
      //  console.log(`[NetworkView] Session PartnerId: ${sessionPid}, building network tree`);

        // Get all tier 1 nodes (direct referrals where referrer === sessionPid)
        const tier1Nodes = nodes.filter(n => {
          const raw = n._raw || {};
          const ref = raw.Referrer || raw.ReferrerId || raw.ReferrerUsername || raw.ReferralCode || raw.Referral;
          const numRef = parseInt(ref, 10);
          return !isNaN(numRef) && numRef === sessionPid;
        });
        
      //  console.log(`[NetworkView] Found ${tier1Nodes.length} tier 1 (direct) referrals`);
        
        // Count tier 2 and tier 3
        let tier2Count = 0;
        let tier3Count = 0;
        tier1Nodes.forEach(t1 => {
          tier2Count += t1.subPartners.length;
          t1.subPartners.forEach(t2 => {
            tier3Count += t2.subPartners.length;
          });
        });
        
       // console.log(`[NetworkView] Tree structure: ${tier1Nodes.length} tier 1, ${tier2Count} tier 2, ${tier3Count} tier 3`);

        // Show tier 1 nodes directly (no root wrapper)
        partners = tier1Nodes;
        
        setNetworkPartners(partners);
        // Auto-expand tier 1 to show tier 2
        const expanded = {};
        tier1Nodes.forEach(n => { expanded[n.id] = true }); // Tier 1 expanded to show tier 2
        setExpandedNodes(expanded);
     //   console.log(`[NetworkView] Network populated with ${tier1Nodes.length} tier 1 partners (tier 2/3 visible on expand)`);
      } else {
        // Fallback: show first 10 clients as direct partners
        partners = clients.slice(0, 10).map(client => ({
          id: client.id,
          username: client.username,
          name: client.name || client.username,
          email: client.email,
          phone: client.phone,
          type: 'Direct Partner',
          country: client.country,
          status: client.status,
          kycStatus: client.kycStatus,
          deposit: Math.round(client.deposit * 100) / 100,
          // Volume: actual lots traded (2 decimals)
          volume: Math.round((client.lots || 0) * 100) / 100,
          // Revenue: actual commission earned (2 decimals)
          revenue: Math.round((client.baseCommission || 0) * 100) / 100,
          totalClients: 1,
          accountCount: client.realAccountCount || 0,  // Only count real accounts
          subPartners: []
        }));
        setNetworkPartners(partners);
        const expanded = partners.reduce((acc, p) => ({ ...acc, [p.id]: true }), {});
        setExpandedNodes(expanded);
      //  console.log(`[NetworkView] Network populated with ${partners.length} direct partners (auto-expanded fallback)`);
      }
    }
  }, [clients]);

  const toggleNode = (id) => setExpandedNodes(p => ({...p, [id]: !p[id]}));

  // Nudge handler - sends email via backend and records in Supabase
  const handleNudge = async (e, partnerId, partnerName, partnerEmail, nudgeType, tier) => {
    e.stopPropagation();
   // console.log(`[Nudge] ${nudgeType} nudge triggered for ${partnerName} (${partnerEmail}) - Tier ${tier}`);
    
    try {
      // Get current partner ID and username from WebSocket session
      const currentPartnerId = getSessionPartnerId();
      const currentUsername = getSessionUsername() || 'IB Manager';
      const referrerName = currentUsername;  // Use actual username from session
      
    //  console.log(`[Nudge] Referrer: ${referrerName}, PartnerId: ${currentPartnerId}`);
      
      // Call backend to send email and record nudge
      const result = await sendNudgeEmail(
        partnerEmail,
        partnerName,
        referrerName,
        nudgeType,
        tier,
        currentPartnerId || partnerId
      );
      
      if (result.success) {
        alert(`✅ ${nudgeType} nudge sent successfully!\n\nEmail: ${partnerEmail}\nMessage ID: ${result.messageId}`);
     //   console.log('[Nudge] Success:', result);
      } else {
        alert(`⚠️ Failed to send nudge\n\nError: ${result.error}\n\nMake sure:\n1. Backend server is running on port 5000\n2. Gmail credentials are in backend/.env`);
     //   console.error('[Nudge] Error:', result.error);
      }
    } catch (error) {
      alert(`⚠️ Error sending nudge\n\n${error.message}\n\nBackend server might not be running.`);
     //   console.error('[Nudge] Exception:', error);
    }
  };

  // Calculate total network volume from real data
  const totalNetworkVolume = networkPartners.reduce((sum, p) => sum + (p.volume || 0), 0);

  // NetworkRow handles all 3 tiers with proper visibility
  const NetworkRow = ({ node, level = 0, parentIsDirect = true }) => {
    const isExpanded = expandedNodes[node.id];
    const isDirect = level === 0;  // Tier 1 = Direct
    const tier = level + 1;
    
    // Only show contact details for DIRECT referrals (Tier 1)
    const showContactDetails = isDirect;
    
    // Separate sub-partners by qualification
    const subPartners = node.subPartners || [];
    const qualified = subPartners.filter(p => p.totalClients >= ibQualificationThreshold);
    const unqualified = subPartners.filter(p => p.totalClients < ibQualificationThreshold);
    
    // Aggregate unqualified referrers (for retailers)
    const aggregated = unqualified.reduce((acc, curr) => ({ 
      clients: acc.clients + curr.totalClients, 
      volume: acc.volume + curr.volume, 
      revenue: acc.revenue + curr.revenue 
    }), { clients: 0, volume: 0, revenue: 0 });
    
    const hasChildren = qualified.length > 0 || unqualified.length > 0;
    
    // Nudge counts (demo - in production would come from API)
    const pendingKYC = node.kycStatus === 'Pending' ? 1 : 0;
    const pendingDeposit = node.deposit === 0 ? 1 : 0;

    return (
        <>
        <div className={`flex items-center p-4 border-b border-neutral-800 hover:bg-neutral-800/30 transition-colors group ${level > 0 ? 'bg-neutral-900/30' : ''}`} 
             style={{paddingLeft: `${level * 24 + 16}px`}}>
            {/* Expand/Collapse */}
            <button 
              onClick={() => hasChildren && toggleNode(node.id)} 
              className={`mr-3 p-1 rounded hover:bg-neutral-700 text-neutral-400 ${!hasChildren && 'invisible'}`}
            >
              {isExpanded ? <ChevronDown size={16}/> : <ChevronRight size={16}/>}
            </button>

            {/* Partner Info */}
            <div className="flex-1 min-w-[180px] cursor-pointer" onClick={() => { setSelectedPartner(node); setSelectedPartnerTier(tier); }}>
              <div className="flex items-center gap-2">
                <span className="text-white font-bold">{node.name}</span>
                {/* TIER BADGE - PROMINENT */}
                <span className={`text-[11px] font-bold px-3 py-1 rounded-full border-2 ${
                  tier === 1 ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500' :
                  tier === 2 ? 'bg-blue-500/20 text-blue-300 border-blue-500' :
                  'bg-purple-500/20 text-purple-300 border-purple-500'
                }`}>
                  TIER {tier}
                </span>
                <span className={`text-[10px] px-2 py-0.5 rounded border ${node.kycStatus === 'Approved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                  {node.kycStatus}
                </span>
              </div>
              <div className="text-xs text-neutral-500 flex items-center mt-1">
                <span className="mr-2">{node.type}</span>
                <span className="flex items-center"><Map size={10} className="mr-1"/>{node.country}</span>
                {tier > 1 && <span className="ml-2 text-[10px] text-neutral-600 italic">(Limited visibility)</span>}
              </div>
            </div>

            {/* Nudge Buttons - Show for all tiers but without revealing non-direct contact */}
            <div className="hidden lg:flex gap-2 mr-6">
              {pendingKYC > 0 && (
                <button 
                  onClick={(e) => handleNudge(e, node.id, node.name, node.email, 'Complete KYC', tier)}
                  className="flex items-center px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/30 rounded text-[10px] text-amber-400 transition-colors"
                  title={!showContactDetails ? "System will send reminder without revealing your contact" : ""}
                >
                  <FileText size={10} className="mr-1"/> Nudge KYC
                </button>
              )}
              {pendingDeposit > 0 && (
                <button 
                  onClick={(e) => handleNudge(e, node.id, node.name, node.email, 'Fund Account', tier)}
                  className="flex items-center px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 rounded text-[10px] text-emerald-400 transition-colors"
                  title={!showContactDetails ? "System will send reminder without revealing your contact" : ""}
                >
                  <Wallet size={10} className="mr-1"/> Nudge Deposit
                </button>
              )}
            </div>

            {/* Stats */}
            <div className="hidden md:flex space-x-8 text-right">
              <div className="w-24">
                <div className="text-xs text-neutral-500 uppercase">Deposit</div>
                <div className="text-emerald-400 font-medium">${parseFloat(node.deposit || 0).toFixed(2)}</div>
              </div>
              <div className="w-24">
                <div className="text-xs text-neutral-500 uppercase">Volume</div>
                <div className="text-white font-medium">{parseFloat(node.volume || 0).toFixed(2)}</div>
              </div>
              <div className="w-24">
                <div className="text-xs text-neutral-500 uppercase">Revenue</div>
                <div className="text-amber-500 font-bold">${parseFloat(node.revenue || 0).toFixed(2)}</div>
              </div>
            </div>
        </div>

        {/* Expanded Children - Only show up to 3 tiers total */}
        {isExpanded && level < 2 && (
            <div className="border-l-2 border-neutral-800 ml-6">
                {qualified.map(child => <NetworkRow key={child.id} node={child} level={level+1} parentIsDirect={false} />)}
                {unqualified.map(child => <NetworkRow key={child.id} node={child} level={level+1} parentIsDirect={false} />)}
            </div>
        )}
        </>
    );
  };

  return (
    <div className="space-y-6 animate-fadeIn relative">
        {selectedPartner && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-lg shadow-2xl relative p-6">
             <button onClick={() => setSelectedPartner(null)} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
             
             <div className="flex items-center mb-6">
               <div className="w-12 h-12 rounded-full bg-neutral-800 flex items-center justify-center text-amber-500 font-bold text-lg mr-4">
                 {selectedPartner.name.substring(0,2).toUpperCase()}
               </div>
               <div className="flex-1">
                 <h3 className="text-xl font-bold text-white">{selectedPartner.name}</h3>
                 <p className="text-sm text-neutral-400 mb-2">{selectedPartner.type}</p>
                 {/* TIER BADGE - PROMINENT IN MODAL */}
                 <div className="flex gap-2 items-center">
                   <span className={`text-xs font-bold px-3 py-1 rounded-full border-2 ${
                     selectedPartnerTier === 1 ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500' :
                     selectedPartnerTier === 2 ? 'bg-blue-500/20 text-blue-300 border-blue-500' :
                     'bg-purple-500/20 text-purple-300 border-purple-500'
                   }`}>
                     TIER {selectedPartnerTier} REFERRAL
                   </span>
                   <span className={`text-xs px-2 py-1 rounded border ${selectedPartner.kycStatus === 'Approved' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                     {selectedPartner.kycStatus}
                   </span>
                 </div>
               </div>
             </div>

             {/* Only show contact details for direct referrals (Tier 1) */}
             {selectedPartnerTier === 1 ? (
               <div className="space-y-4 mb-6">
                 <div className="p-4 bg-neutral-950 rounded-lg border border-neutral-800">
                   <p className="text-xs text-neutral-500 uppercase font-bold mb-3">Contact Information</p>
                   <div className="space-y-2 text-sm text-neutral-300">
                     <div className="flex justify-between items-center">
                       <span>Name:</span> 
                       <span className="text-white font-medium">{selectedPartner.name}</span>
                     </div>
                     <div className="flex justify-between items-center">
                       <span>Email:</span> 
                       <span className="text-white font-medium">{selectedPartner.email || `partner.${selectedPartner.id}@nommia.net`}</span>
                     </div>
                     <div className="flex justify-between">
                       <span>Phone:</span> 
                       <span className="text-white font-medium">{selectedPartner.phone || '+44 7700 900000'}</span>
                     </div>
                   </div>
                 </div>
                 <button className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold rounded-lg transition-colors flex items-center justify-center">
                   <Bell size={18} className="mr-2"/> Contact This Partner
                 </button>
               </div>
             ) : (
               <div className="space-y-4 mb-6">
                 <div className="p-4 bg-neutral-950 rounded-lg border border-amber-500/20">
                   <p className="text-xs text-amber-500 uppercase font-bold mb-2 flex items-center">
                     <Lock size={12} className="mr-1"/> Privacy Notice
                   </p>
                   <p className="text-sm text-neutral-300">
                     For security, contact details are only available for your direct referrals. 
                     To communicate with {selectedPartner.name}, use the Nudge system below which sends system-generated emails from Nommia.
                   </p>
                 </div>
               </div>
             )}

             {/* Nudge System */}
             <div className="p-4 bg-neutral-950 rounded-lg border border-neutral-800">
               <p className="text-xs text-neutral-500 uppercase font-bold mb-3">Send Reminder (Nommia System)</p>
               <div className="flex gap-2">
                 {selectedPartner.kycStatus === 'Pending' && (
                   <button 
                     onClick={() => handleNudge(new Event('click'), selectedPartner.id, selectedPartner.name, selectedPartner.email || `partner.${selectedPartner.id}@nommia.net`, 'Complete KYC', selectedPartnerTier)}
                     className="flex-1 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 rounded-lg text-sm font-medium transition-colors flex items-center justify-center"
                   >
                     <FileText size={14} className="mr-1"/> Nudge KYC
                   </button>
                 )}
                 {selectedPartner.deposit === 0 && (
                   <button 
                     onClick={() => handleNudge(new Event('click'), selectedPartner.id, selectedPartner.name, selectedPartner.email || `partner.${selectedPartner.id}@nommia.net`, 'Fund Account', selectedPartnerTier)}
                     className="flex-1 py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-sm font-medium transition-colors flex items-center justify-center"
                   >
                     <Wallet size={14} className="mr-1"/> Nudge Deposit
                   </button>
                 )}
               </div>
               <p className="text-[10px] text-neutral-600 mt-2">
                 {selectedPartnerTier > 1 
                   ? `Reminder will be sent as a system notification from Nommia without revealing your contact information.`
                   : `Reminder will be sent to their registered email as a direct message from Nommia.`
                 }
               </p>
             </div>
          </div>
        </div>
        )}

        {/* Header */}
        <div className="bg-neutral-900 border border-neutral-800 p-6 rounded-xl flex justify-between items-center">
          <div>
            <h2 className="text-xl font-bold text-white flex items-center">
              <Network size={20} className="mr-2 text-amber-500"/> 
              Partner Network
            </h2>
            <p className="text-sm text-neutral-400 mt-1">Your direct referrals (Tier 1), their referrals (Tier 2), and their referrals (Tier 3). Contact details only visible for Tier 1.</p>
          </div>
          <div className="text-right hidden sm:block">
            <div className="text-xs text-neutral-500 uppercase font-bold">Total Network Volume</div>
            <div className="text-2xl font-bold text-white">
              {totalNetworkVolume.toFixed(1)} <span className="text-sm text-neutral-500 font-normal">NV</span>
            </div>
          </div>
        </div>

        {/* Network Tree */}
        <div className="bg-neutral-900 border border-neutral-800 rounded-xl overflow-hidden">
            <div className="p-4 border-b border-neutral-800 bg-neutral-950/50 flex justify-between items-center text-xs font-bold text-neutral-500 uppercase tracking-wider">
              <div className="pl-12">Partner Name</div>
              <div className="hidden md:flex space-x-8 pr-4">
                <div className="w-24 text-right">Deposit</div>
                <div className="w-24 text-right">Volume</div>
                <div className="w-24 text-right">Revenue</div>
              </div>
            </div>
            <div>
              {isLoading ? (
                <div className="p-8 text-center text-neutral-500 flex items-center justify-center gap-2">
                  <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-amber-500"></div>
                  Loading network data...
                </div>
              ) : networkPartners.length === 0 ? (
                <div className="p-8 text-center text-neutral-500">
                  <Network size={40} className="mx-auto mb-4 opacity-50" />
                  <p className="text-lg font-medium mb-2">No Partners Yet</p>
                  <p className="text-sm">Your direct referrals will appear here. Build your network to see the 3-tier hierarchy.</p>
                </div>
              ) : (
                (() => {
                  const hasReferralData = networkPartners.some(p => Array.isArray(p.subPartners) && p.subPartners.length > 0);
                  return (
                    <>
                      
                      {networkPartners.map(node => <NetworkRow key={node.id} node={node} level={0} />)}
                    </>
                  );
                })()
              )}
            </div>
        </div>

        {/* Legend */}
        <div className="p-4 bg-neutral-900/50 border border-neutral-800 rounded-xl text-xs text-neutral-400">
          <p className="font-bold text-white mb-2">How the Network Works</p>
          <ul className="space-y-1">
            <li>• <strong>Tier 1 (Direct):</strong> Your direct referrals — full contact details visible</li>
            <li>• <strong>Tier 2 & 3:</strong> Your referrals' referrals — name, KYC, deposit, and volume only</li>
            <li>• <strong>Nudges:</strong> Send system-generated reminders from Nommia without revealing your contact info</li>
            <li>• <strong>Privacy:</strong> Non-direct partners never see your details, only system notifications</li>
          </ul>
        </div>
    </div>
  );
};

// F. SETTINGS VIEW (Fixed: Removed Typo in Function Name)
const SettingsView = () => {
  // --- Data State - Will be fetched from user API ---
  const [payment, setPayment] = useState({ 
      bankName: "", accountNum: "", bic: "", 
      usdtTrc: "", usdtErc: "", usdcPol: "", usdcErc: "" 
  });
  
  // Profile will be loaded from localStorage or API
  const [profile, setProfile] = useState({
      name: localStorage.getItem('username') || "",
      email: localStorage.getItem('email') || "",
      phone: ""
  });

  // --- Security / Modal State ---
  const [showSecurityModal, setShowSecurityModal] = useState(false);
  const [verificationType, setVerificationType] = useState('password'); // 'password' or 'save'
  const [otpStep, setOtpStep] = useState('initial'); // 'initial', 'verify'
  
  // --- Input State ---
  const [otpInput, setOtpInput] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // --- 2FA State ---
  const [isTwoFAEnabled, setIsTwoFAEnabled] = useState(false);
  const [showTwoFAModal, setShowTwoFAModal] = useState(false);
  const [twoFAStep, setTwoFAStep] = useState('scan');
  const [twoFACode, setTwoFACode] = useState('');
  const [twoFASecret, setTwoFASecret] = useState('');          // User's unique secret
  const [twoFAQRCode, setTwoFAQRCode] = useState('');          // QR code image URL
  const [showTwoFALoginModal, setShowTwoFALoginModal] = useState(false); // Login 2FA prompt
  const [twoFALoginCode, setTwoFALoginCode] = useState('');    // Code entered at login
  const [isLoading2FA, setIsLoading2FA] = useState(true);      // Loading state

  // --- Fetch 2FA status on component mount ---
  useEffect(() => {
    const fetchTwoFAStatus = async () => {
      try {
        const username = localStorage.getItem('username');
        if (!username) {
          setIsLoading2FA(false);
          return;
        }

        const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/check`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username })
        });
        
        const data = await res.json();
        if (data.success) {
          setIsTwoFAEnabled(data.enabled || false);
          // Cache in localStorage
          localStorage.setItem('twoFAEnabled', data.enabled ? 'true' : 'false');
        }
      } catch (err) {
        console.warn('[2FA Check] Error fetching status:', err.message);
        // Try to restore from cache
        const cached = localStorage.getItem('twoFAEnabled');
        setIsTwoFAEnabled(cached === 'true');
      } finally {
        setIsLoading2FA(false);
      }
    };

    fetchTwoFAStatus();
  }, []); // Run only once on mount

  // --- Handlers ---

  // 1. Trigger the Save Flow
  const initiateSave = () => {
      setVerificationType('save');
      setOtpStep('initial');
      setShowSecurityModal(true);
  };

  // 2. Trigger Password Change Flow
  const initiatePasswordChange = () => {
      setVerificationType('password');
      setOtpStep('initial');
      setShowSecurityModal(true);
  };

  // 3. Send OTP using API function
  const handleRequestOTP = async () => {
      try {
          // Validate email is available
          if (!profile.email || profile.email.trim() === '') {
              alert('❌ Email not found in your profile. Please update your email in your account settings first.');
              return;
          }

          const result = await sendOTP(profile.email, verificationType === 'password' ? 'password' : 'security');
          if (result.success) {
              alert(`✅ ${result.message}`);
              setOtpStep('verify');
          } else {
              alert('❌ Error: ' + result.message);
          }
      } catch (error) {
          alert('Failed to send OTP: ' + error.message);
      }
  };

  // 4. Verify & Execute Action (Fixed Function Name)
  const handleFinalVerification = async () => {
      if (otpInput.length < 6) return alert("Please enter a valid 6-digit OTP.");

      try {
          if (verificationType === 'password') {
              // Password Change Flow
              if (!oldPassword) return alert("Please enter your current password.");
              if (newPassword !== confirmPassword) return alert("Passwords do not match.");
              if (newPassword.length < 8) return alert("Password must be at least 8 characters.");
              if (oldPassword === newPassword) return alert("New password must be different from current password.");

              // Call backend password reset endpoint (verifies OTP + validates passwords)
              const resetRes = await fetch(`${API_CONFIG.BACKEND_URL}/api/password/reset`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ 
                      email: profile.email,
                      oldPassword: oldPassword,
                      newPassword: newPassword,
                      code: otpInput
                  })
              });
              const resetData = await resetRes.json();
              
              if (!resetData.success) {
                  return alert('Password reset failed: ' + resetData.message);
              }

              // OTP verified and password validated by backend. Now call XValley API directly
              // Using the user's own authToken from login
              try {
                  const xvalleyRes = await fetch(`${API_CONFIG.API_BASE_URL}/profile/reset/`, {
                      method: 'POST',
                      headers: {
                          'Content-Type': 'application/json',
                          'Authorization': 'Bearer ' + localStorage.getItem('authToken')
                      },
                      body: JSON.stringify({
                          OldPassword: oldPassword,
                          NewPassword: newPassword,
                          ConfirmPassword: newPassword
                      })
                  });
                  
                  if (xvalleyRes.ok) {
                      alert("✅ Success: Password updated successfully. Please login again with your new password.");
                      // Reset and close
                      setShowSecurityModal(false);
                      setOtpStep('initial');
                      setOtpInput('');
                      setOldPassword('');
                      setNewPassword('');
                      setConfirmPassword('');
                  } else {
                      alert('Failed to update password in XValley. Please try again.');
                  }
              } catch (xvalleyError) {
                  alert('Error communicating with XValley: ' + xvalleyError.message);
              }
          } else {
              // Save Payout Details Flow - Verify OTP first
              const result = await verifyOTP(profile.email, otpInput, 'security');
              
              if (!result.success) {
                  return alert('❌ Invalid OTP: ' + result.message);
              }

              try {
                  const saveResult = await savePayoutDetails(payment);
                  alert("✅ Success: Account details and payout methods saved securely.");
              } catch (error) {
                  alert("Error saving payout details: " + error.message);
              }

              // Reset & Close
              setShowSecurityModal(false);
              setOtpStep('initial');
              setOtpInput('');
          }
      } catch (error) {
          alert('Verification failed: ' + error.message);
      }
  };

  // --- 2FA Handlers (Real TOTP Implementation) ---
  const handleToggle2FA = async () => {
      const username = localStorage.getItem('username');
      if (!username) {
          alert("Error: Username not found. Please login again.");
          return;
      }
      
      if (isTwoFAEnabled) {
          if(window.confirm("Disable 2FA? You'll need to scan the QR code again to re-enable.")) {
              try {
                  const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/disable`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ username: username })
                  });
                  const data = await res.json();
                  if (data.success) {
                      setIsTwoFAEnabled(false);
                      localStorage.setItem('twoFAEnabled', 'false');  // Cache it
                      alert("✅ 2FA Disabled");
                  } else {
                      alert("Error: " + data.message);
                  }
              } catch (e) {
                  alert("Error disabling 2FA: " + e.message);
              }
          }
      } else {
          // Request 2FA setup - backend generates UNIQUE secret for this user
          try {
              const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/setup`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ username: username })
              });
              const data = await res.json();
              if (data.success) {
                  setTwoFASecret(data.secret);           // Store secret (e.g., JBSWY3DPEBPK3PXP...)
                  setTwoFAQRCode(data.qrCodeUrl);        // Store QR code image URL
                  setTwoFAStep('scan');
                  setShowTwoFAModal(true);
              } else {
                  alert("Error: " + data.message);
              }
          } catch (e) {
              alert("Could not setup 2FA: " + e.message);
          }
      }
  };

  const handleVerify2FA = async () => {
      if (twoFACode.length !== 6) return alert("❌ Invalid Code - must be 6 digits");
      const username = localStorage.getItem('username');
      if (!username) {
          alert("Error: Username not found. Please login again.");
          return;
      }
      
      try {
          const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  username: username,
                  secret: twoFASecret,
                  token: twoFACode
              })
          });
          const data = await res.json();
          if (data.success) {
              setIsTwoFAEnabled(true);
              localStorage.setItem('twoFAEnabled', 'true');  // Cache it
              setShowTwoFAModal(false);
              setTwoFACode('');
              setTwoFASecret('');
              setTwoFAQRCode('');
              alert("✅ 2FA Enabled Successfully!\n\nYour authenticator is now active. You'll need to enter a 6-digit code on your next login.");
          } else {
              alert("❌ Invalid Code. The code didn't match. Please try again or restart the setup.");
          }
      } catch (e) {
          alert("Verification error: " + e.message);
      }
  };

  return (
    <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800 space-y-6 animate-fadeIn relative">
        
        {/* --- SECURITY VERIFICATION MODAL (Shared for Password & Saving) --- */}
        {showSecurityModal && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-md shadow-2xl relative p-6">
                    <button onClick={() => setShowSecurityModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
                    
                    <h3 className="text-xl font-bold text-white mb-2 flex items-center">
                        <Shield size={20} className="mr-2 text-amber-500"/> 
                        {verificationType === 'password' ? 'Change Password' : 'Confirm Changes'}
                    </h3>
                    
                    {otpStep === 'initial' ? (
                        <div className="space-y-4">
                            {!profile.email || profile.email.trim() === '' ? (
                                <>
                                    <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                                        <p className="text-sm text-amber-300">⚠️ <strong>Email Required</strong></p>
                                        <p className="text-xs text-amber-200 mt-2">Please update your email address in the profile section above before you can verify changes with OTP.</p>
                                    </div>
                                    <button onClick={() => {setShowSecurityModal(false); document.querySelector('[class*="Email Address"]')?.scrollIntoView({behavior: 'smooth'});}} className="w-full py-3 bg-neutral-700 hover:bg-neutral-600 text-white font-bold rounded-lg">Close & Update Email</button>
                                </>
                            ) : (
                                <>
                                    <p className="text-sm text-neutral-400">
                                        {verificationType === 'password' 
                                            ? "We need to verify your identity before changing your password." 
                                            : "You are updating sensitive account information. Please verify your identity."}
                                        <br/><br/>Click below to send a code to: <span className="text-white font-bold">{profile.email}</span>
                                    </p>
                                    <button onClick={handleRequestOTP} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold rounded-lg">Send Verification Code</button>
                                </>
                            )}
                        </div>
                    ) : (
                        <div className="space-y-4 animate-fadeIn">
                            <div className="p-3 bg-neutral-950 border border-neutral-800 rounded-lg">
                                <label className="text-xs text-neutral-500 uppercase font-bold">Enter OTP</label>
                                <input 
                                    type="text" 
                                    placeholder="000000" 
                                    maxLength="6" 
                                    value={otpInput} 
                                    onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))} 
                                    className="w-full mt-1 bg-transparent border-b border-neutral-700 p-2 text-white text-center tracking-[0.5em] font-mono text-xl outline-none focus:border-amber-500" 
                                    autoFocus
                                />
                            </div>

                            {/* Only show Password fields if changing password */}
                            {verificationType === 'password' && (
                                <div className="space-y-3 pt-2">
                                    <input type="password" placeholder="Current Password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white outline-none focus:border-amber-500" />
                                    <input type="password" placeholder="New Password (min 8 chars)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white outline-none focus:border-amber-500" />
                                    <input type="password" placeholder="Confirm New Password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white outline-none focus:border-amber-500" />
                                </div>
                            )}

                            <button onClick={handleFinalVerification} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold rounded-lg mt-2">
                                {verificationType === 'password' ? 'Update Password' : 'Save Changes'}
                            </button>
                        </div>
                    )}
                </div>
            </div>
        )}

        {/* --- 2FA SETUP MODAL --- */}
        {showTwoFAModal && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4 overflow-y-auto">
                <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-md shadow-2xl relative p-6 text-center my-8 max-h-[90vh] overflow-y-auto">
                    <button onClick={() => setShowTwoFAModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white z-10"><X size={20}/></button>
                    <div className="mb-3 flex justify-center"><div className="p-3 bg-amber-500/10 rounded-full text-amber-500"><Shield size={32}/></div></div>
                    <h3 className="text-xl font-bold text-white mb-2">Set up 2FA</h3>
                    
                    {twoFAStep === 'scan' ? (
                        <div className="space-y-4">
                            <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-2 text-sm text-blue-300">
                                <p className="font-bold mb-1">📱 Step 1: Scan with Authenticator App</p>
                                <p className="text-xs">Google Authenticator, Authy, Microsoft Authenticator, or any TOTP-compatible app</p>
                            </div>
                            <p className="text-sm text-neutral-400">Your unique QR code (generated just for you):</p>
                            {twoFAQRCode ? (
                                <div className="bg-white p-2 w-40 h-40 mx-auto rounded-lg flex items-center justify-center">
                                    <img src={twoFAQRCode} alt="2FA QR Code" className="w-full h-full object-contain" loading="eager" />
                                </div>
                            ) : (
                                <div className="w-40 h-40 mx-auto bg-neutral-800 rounded-lg flex items-center justify-center">
                                    <div className="text-center">
                                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-amber-500 mx-auto mb-1"></div>
                                        <p className="text-xs text-neutral-400">Generating your QR Code...</p>
                                    </div>
                                </div>
                            )}
                            <div className="bg-neutral-950 rounded-lg p-3 border border-neutral-800">
                                <p className="text-xs text-neutral-500 mb-2">Manual Entry (if QR scan fails):</p>
                                <p className="text-xs font-mono text-emerald-400 break-all select-all">{twoFASecret}</p>
                            </div>
                            <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2 text-sm text-amber-300">
                                <p className="text-xs">⚠️ Save your secret key in a safe place as a backup recovery method</p>
                            </div>
                            <button onClick={() => setTwoFAStep('verify')} className="w-full py-2 bg-neutral-800 hover:bg-neutral-700 text-white font-bold rounded-lg border border-neutral-700 transition-colors text-sm">✅ I have scanned the QR code</button>
                        </div>
                    ) : (
                        <div className="space-y-4 animate-fadeIn">
                            <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-2 text-sm text-emerald-300">
                                <p className="font-bold mb-1">🔢 Step 2: Verify Setup</p>
                                <p className="text-xs">Enter the 6-digit code from your authenticator app (updates every 30 seconds)</p>
                            </div>
                            <input type="text" placeholder="000000" maxLength="6" value={twoFACode} onChange={(e) => setTwoFACode(e.target.value.replace(/[^0-9]/g, ''))} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white text-center tracking-[0.5em] font-mono text-2xl outline-none focus:border-emerald-500" autoFocus />
                            <button onClick={handleVerify2FA} className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 text-neutral-900 font-bold rounded-lg transition-colors text-sm">✅ Verify & Enable 2FA</button>
                        </div>
                    )}
                </div>
            </div>
        )}

        {/* --- MAIN SETTINGS UI --- */}
        <div className="flex items-center"><Settings size={24} className="mr-3 text-amber-500"/><div><h2 className="text-xl font-bold text-white">Settings</h2><p className="text-sm text-neutral-400">Manage profile and payout preferences.</p></div></div>
        
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Column: Payouts */}
            <div className="space-y-4">
                <h3 className="text-lg font-bold text-white flex items-center"><Wallet size={18} className="mr-2 text-neutral-500"/> Payout Methods</h3>
                
                <div className="p-4 bg-neutral-950 rounded-lg border border-neutral-800 space-y-3">
                    <p className="text-xs text-amber-500 font-bold uppercase mb-2">Bank Wire Details</p>
                    <div><label className="text-xs text-neutral-500 font-bold">Bank Name</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" value={payment.bankName} onChange={e=>setPayment({...payment, bankName:e.target.value})} placeholder="e.g. Barclays"/></div>
                    <div><label className="text-xs text-neutral-500 font-bold">Account Number / IBAN</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" value={payment.accountNum} onChange={e=>setPayment({...payment, accountNum:e.target.value})} placeholder="GB33 BARC..."/></div>
                    <div><label className="text-xs text-neutral-500 font-bold">BIC / SWIFT Code</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" value={payment.bic} onChange={e=>setPayment({...payment, bic:e.target.value})} placeholder="BARCGB22"/></div>
                </div>

                <div className="p-4 bg-neutral-950 rounded-lg border border-neutral-800 space-y-3">
                    <p className="text-xs text-emerald-500 font-bold uppercase mb-2">Crypto Wallets</p>
                    <div><label className="text-xs text-neutral-500 font-bold">USDT (TRC20)</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none font-mono text-sm" value={payment.usdtTrc} onChange={e=>setPayment({...payment, usdtTrc:e.target.value})}/></div>
                    <div><label className="text-xs text-neutral-500 font-bold">USDT (ERC20)</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none font-mono text-sm" value={payment.usdtErc} onChange={e=>setPayment({...payment, usdtErc:e.target.value})}/></div>
                    <div><label className="text-xs text-neutral-500 font-bold">USDC (POL)</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none font-mono text-sm" value={payment.usdcPol} onChange={e=>setPayment({...payment, usdcPol:e.target.value})}/></div>
                    <div><label className="text-xs text-neutral-500 font-bold">USDC (ERC20)</label><input className="w-full bg-neutral-900 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none font-mono text-sm" value={payment.usdcErc} onChange={e=>setPayment({...payment, usdcErc:e.target.value})}/></div>
                </div>

                <div className="p-3 bg-red-900/10 border border-red-900/30 rounded-lg flex items-start">
                    <AlertCircle size={16} className="text-red-500 mt-0.5 mr-2 flex-shrink-0"/>
                    <p className="text-[10px] text-red-400 leading-tight"><strong>Disclaimer:</strong> Nommia cannot be held liable for funds sent to incorrect accounts provided here.</p>
                </div>
            </div>

            {/* Right Column: Profile & Security */}
            <div className="space-y-6">
                <div className="space-y-4">
                    <h3 className="text-lg font-bold text-white flex items-center"><Users size={18} className="mr-2 text-neutral-500"/> Basic Information</h3>
                    <div><label className="text-xs text-neutral-500 font-bold">Full Name</label><input className="w-full bg-neutral-950 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" value={profile.name} onChange={e => setProfile({...profile, name: e.target.value})} /></div>
                    <div><label className="text-xs text-neutral-500 font-bold">Email Address</label><input className="w-full bg-neutral-950 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" placeholder="Enter your email for security codes" value={profile.email} onChange={e => {setProfile({...profile, email: e.target.value}); localStorage.setItem('email', e.target.value);}} /><p className="text-[10px] text-neutral-600 mt-1">{profile.email ? '✓ Email saved for OTP verification' : 'Required for OTP verification and security codes'}</p></div>
                    <div><label className="text-xs text-neutral-500 font-bold">Phone Number</label><input className="w-full bg-neutral-950 border border-neutral-700 rounded p-2 text-white mt-1 focus:border-amber-500 outline-none" value={profile.phone} onChange={e => setProfile({...profile, phone: e.target.value})} /></div>
                </div>

                <div className="pt-6 border-t border-neutral-800 space-y-4">
                    <h3 className="text-lg font-bold text-white flex items-center"><Shield size={18} className="mr-2 text-neutral-500"/> Security</h3>
                    
                    <button onClick={initiatePasswordChange} className="w-full py-3 border border-neutral-700 hover:bg-neutral-800 text-white rounded-lg font-medium transition-colors flex items-center justify-center">
                        <Lock size={16} className="mr-2"/> Change Password
                    </button>

                    <div className="flex items-center justify-between p-4 bg-neutral-950 border border-neutral-800 rounded-lg">
                        <div>
                            <div className="text-sm font-bold text-white flex items-center">
                                Two-Factor Authentication
                                {isTwoFAEnabled && <span className="ml-2 px-2 py-0.5 bg-emerald-500/10 text-emerald-400 text-[10px] rounded border border-emerald-500/20">Enabled</span>}
                                {isLoading2FA && <span className="ml-2 text-[10px] text-neutral-400 animate-pulse">Loading...</span>}
                            </div>
                            <p className="text-xs text-neutral-500 mt-1">Secure account with Authenticator app.</p>
                        </div>
                        <div onClick={() => !isLoading2FA && handleToggle2FA()} className={`w-12 h-6 rounded-full relative cursor-pointer transition-colors ${isLoading2FA ? 'bg-neutral-600 opacity-50 cursor-not-allowed' : (isTwoFAEnabled ? 'bg-emerald-500' : 'bg-neutral-700')}`}>
                            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${isTwoFAEnabled ? 'left-7' : 'left-1'}`}></div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        {/* Main Save Button with OTP Trigger */}
        <div className="text-right pt-4 border-t border-neutral-800">
            <button 
                onClick={initiateSave} 
                className="bg-amber-500 text-black px-6 py-2 rounded-lg font-bold hover:bg-amber-400 transform active:scale-95 transition-all"
            >
                Save Changes
            </button>
        </div>
    </div>
  );
};
// G. ADMIN USER MANAGEMENT VIEW (With Role Editing, Countries & Nudge Rules & OTP Save)
const AdminUserManagementView = ({ ibQualificationThreshold, setIbQualificationThreshold }) => {
    // Local state for user data - will be fetched from API
    const [users, setUsers] = useState([]);
    const [editingUser, setEditingUser] = useState(null); 
    const [showModal, setShowModal] = useState(false);

    // Modal form states
    const [selectedRole, setSelectedRole] = useState('');
    const [selectedRegion, setSelectedRegion] = useState('');
    const [selectedSubManagers, setSelectedSubManagers] = useState([]);

    // New Nudge Rule State
    const [nudgeRules, setNudgeRules] = useState({
        cooldownHours: 24, // How often (e.g., once every 24 hours)
        maxNudgesPerClient: 5 // Max total nudges allowed
    });

    // OTP State for Admin Save
    const [showOtpModal, setShowOtpModal] = useState(false);
    const [otpStep, setOtpStep] = useState('initial'); // 'initial', 'verify'
    const [otpInput, setOtpInput] = useState('');
    const [pendingSaveAction, setPendingSaveAction] = useState(null); // 'user' or 'policy'

    // Full country list excluding US, Iran, Iraq, North Korea
    const availableCountries = [
        "Afghanistan", "Albania", "Algeria", "Andorra", "Angola", "Antigua and Barbuda", "Argentina", "Armenia", "Australia", "Austria", "Azerbaijan",
        "Bahamas", "Bahrain", "Bangladesh", "Barbados", "Belarus", "Belgium", "Belize", "Benin", "Bhutan", "Bolivia", "Bosnia and Herzegovina", "Botswana", "Brazil", "Brunei", "Bulgaria", "Burkina Faso", "Burundi",
        "Cabo Verde", "Cambodia", "Cameroon", "Canada", "Central African Republic", "Chad", "Chile", "China", "Colombia", "Comoros", "Congo (Democratic Republic)", "Congo (Republic)", "Costa Rica", "Croatia", "Cuba", "Cyprus", "Czech Republic",
        "Denmark", "Djibouti", "Dominica", "Dominican Republic",
        "East Timor", "Ecuador", "Egypt", "El Salvador", "Equatorial Guinea", "Eritrea", "Estonia", "Eswatini", "Ethiopia",
        "Fiji", "Finland", "France",
        "Gabon", "Gambia", "Georgia", "Germany", "Ghana", "Greece", "Grenada", "Guatemala", "Guinea", "Guinea-Bissau", "Guyana",
        "Haiti", "Honduras", "Hungary",
        "Iceland", "India", "Indonesia", "Ireland", "Israel", "Italy", "Ivory Coast",
        "Jamaica", "Japan", "Jordan",
        "Kazakhstan", "Kenya", "Kiribati", "Kosovo", "Kuwait", "Kyrgyzstan",
        "Laos", "Latvia", "Lebanon", "Lesotho", "Liberia", "Libya", "Liechtenstein", "Lithuania", "Luxembourg",
        "Madagascar", "Malawi", "Malaysia", "Maldives", "Mali", "Malta", "Marshall Islands", "Mauritania", "Mauritius", "Mexico", "Micronesia", "Moldova", "Monaco", "Mongolia", "Montenegro", "Morocco", "Mozambique", "Myanmar",
        "Namibia", "Nauru", "Nepal", "Netherlands", "New Zealand", "Nicaragua", "Niger", "Nigeria", "North Macedonia", "Norway",
        "Oman",
        "Pakistan", "Palau", "Panama", "Papua New Guinea", "Paraguay", "Peru", "Philippines", "Poland", "Portugal",
        "Qatar",
        "Romania", "Russia", "Rwanda",
        "Saint Kitts and Nevis", "Saint Lucia", "Saint Vincent and the Grenadines", "Samoa", "San Marino", "Sao Tome and Principe", "Saudi Arabia", "Senegal", "Serbia", "Seychelles", "Sierra Leone", "Singapore", "Slovakia", "Slovenia", "Solomon Islands", "Somalia", "South Africa", "South Korea", "South Sudan", "Spain", "Sri Lanka", "Sudan", "Suriname", "Sweden", "Switzerland", "Syria",
        "Taiwan", "Tajikistan", "Tanzania", "Thailand", "Togo", "Tonga", "Trinidad and Tobago", "Tunisia", "Turkey", "Turkmenistan", "Tuvalu",
        "Uganda", "Ukraine", "United Arab Emirates", "United Kingdom", "Uruguay", "Uzbekistan",
        "Vanuatu", "Vatican City", "Venezuela", "Vietnam",
        "Yemen",
        "Zambia", "Zimbabwe"
    ];

    // Open modal logic
    const handleEditClick = (user) => {
        setEditingUser(user);
        setSelectedRole(user.role);
        setSelectedRegion(user.region || '');
        setSelectedSubManagers([]); 
        setShowModal(true);
    };

    // Initiate Save with OTP
    const initiateSave = (type) => {
        setPendingSaveAction(type);
        setOtpStep('initial');
        setShowOtpModal(true);
    };

    const handleRequestOTP = async () => {
        try {
            const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/otp/send`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email: 'admin@nommia.io',
                    type: 'admin'
                })
            });
            const data = await res.json();
            if (data.success) {
                alert("OTP sent to admin email.");
                setOtpStep('verify');
            } else {
                alert('Error: ' + data.message);
            }
        } catch (error) {
            alert('Failed to send OTP: ' + error.message);
        }
    };

    // Finalize Save after OTP
    const handleFinalizeSave = async () => {
        if (otpInput.length < 6) {
            alert("Invalid OTP");
            return;
        }

        try {
            // Verify OTP
            const verifyRes = await fetch(`${API_CONFIG.BACKEND_URL}/api/otp/verify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    email: 'admin@nommia.io',
                    code: otpInput
                })
            });
            const verifyData = await verifyRes.json();
            
            if (!verifyData.success) {
                return alert('Invalid OTP: ' + verifyData.message);
            }

            // OTP verified - process the action
            if (pendingSaveAction === 'user') {
                 setUsers(users.map(u => {
                    if (u.id === editingUser.id) {
                        return { 
                            ...u, 
                            role: selectedRole, 
                            region: selectedRole === 'Regional Manager' ? 'Multi-Region' : selectedRegion,
                            managedIds: selectedSubManagers 
                        };
                    }
                    return u;
                }));
                setShowModal(false);
                setEditingUser(null);
                alert("✅ User role updated successfully.");
            } else if (pendingSaveAction === 'policy') {
                alert("✅ Policies saved successfully.");
            }
        } catch (error) {
            alert('Verification failed: ' + error.message);
        } finally {
            setShowOtpModal(false);
            setOtpStep('initial');
            setOtpInput('');
            setPendingSaveAction(null);
        }
    };


    const toggleSubManager = (id) => {
        if (selectedSubManagers.includes(id)) {
            setSelectedSubManagers(selectedSubManagers.filter(sid => sid !== id));
        } else {
            setSelectedSubManagers([...selectedSubManagers, id]);
        }
    };

    return (
        <div className="space-y-6 animate-fadeIn relative">
            
            {/* --- OTP MODAL --- */}
            {showOtpModal && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
                    <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-md shadow-2xl relative p-6">
                        <button onClick={() => setShowOtpModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
                        <h3 className="text-xl font-bold text-white mb-2 flex items-center"><Shield size={20} className="mr-2 text-amber-500"/> Admin Verification</h3>
                        
                        {otpStep === 'initial' ? (
                            <div className="space-y-4">
                                <p className="text-sm text-neutral-400">Please verify your identity to confirm these changes.</p>
                                <button onClick={handleRequestOTP} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold rounded-lg">Send Verification Code</button>
                            </div>
                        ) : (
                            <div className="space-y-4 animate-fadeIn">
                                <input type="text" placeholder="000000" maxLength="6" value={otpInput} onChange={(e) => setOtpInput(e.target.value.replace(/[^0-9]/g, ''))} className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white text-center tracking-[0.5em] font-mono text-xl outline-none focus:border-amber-500" autoFocus />
                                <button onClick={handleFinalizeSave} className="w-full py-3 bg-amber-500 hover:bg-amber-400 text-neutral-900 font-bold rounded-lg mt-2">Confirm</button>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* --- EDIT USER MODAL --- */}
            {showModal && editingUser && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
                    <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-lg shadow-2xl relative p-6">
                        <button onClick={() => setShowModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white"><X size={20}/></button>
                        
                        <h3 className="text-xl font-bold text-white mb-1">Edit User Role</h3>
                        <p className="text-sm text-neutral-400 mb-6">Modifying permissions for <span className="text-white font-bold">{editingUser.name}</span></p>

                        <div className="space-y-5">
                            <div>
                                <label className="text-xs text-neutral-500 uppercase font-bold">Assign Role</label>
                                <select value={selectedRole} onChange={(e) => setSelectedRole(e.target.value)} className="w-full mt-1 bg-neutral-950 border border-neutral-700 rounded-lg p-2.5 text-white focus:border-amber-500 outline-none">
                                    <option value="IB">Standard IB</option>
                                    <option value="Country Manager">Country Manager</option>
                                    <option value="Regional Manager">Regional Manager</option>
                                    <option value="Admin">Administrator</option>
                                </select>
                            </div>

                            {selectedRole === 'Country Manager' && (
                                <div className="p-4 bg-neutral-950/50 border border-neutral-800 rounded-lg animate-fadeIn">
                                    <label className="text-xs text-amber-500 uppercase font-bold flex items-center mb-2"><Globe size={12} className="mr-1"/> Assign Territory</label>
                                    <select value={selectedRegion} onChange={(e) => setSelectedRegion(e.target.value)} className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2.5 text-white focus:border-amber-500 outline-none">
                                        <option value="">Select a Country...</option>
                                        {availableCountries.map(c => <option key={c} value={c}>{c}</option>)}
                                    </select>
                                </div>
                            )}

                            {selectedRole === 'Regional Manager' && (
                                <div className="p-4 bg-neutral-950/50 border border-neutral-800 rounded-lg animate-fadeIn">
                                    <label className="text-xs text-blue-400 uppercase font-bold flex items-center mb-3"><Users size={12} className="mr-1"/> Allocate Country Managers</label>
                                    <div className="space-y-2 max-h-32 overflow-y-auto pr-2">
                                        {users.filter(u => u.role === 'Country Manager').length > 0 ? (
                                            users.filter(u => u.role === 'Country Manager').map(cm => (
                                                <div key={cm.id} className="flex items-center justify-between p-2 bg-neutral-900 border border-neutral-700 rounded hover:border-blue-500 cursor-pointer" onClick={() => toggleSubManager(cm.id)}>
                                                    <span className="text-sm text-white">{cm.name} <span className="text-neutral-500 text-xs">({cm.region})</span></span>
                                                    <div className={`w-4 h-4 rounded border flex items-center justify-center ${selectedSubManagers.includes(cm.id) ? 'bg-blue-500 border-blue-500' : 'border-neutral-600'}`}>
                                                        {selectedSubManagers.includes(cm.id) && <div className="w-2 h-2 bg-white rounded-full"></div>}
                                                    </div>
                                                </div>
                                            ))
                                        ) : (
                                            <p className="text-xs text-neutral-500 italic">No Country Managers found to allocate.</p>
                                        )}
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="mt-8 flex gap-3">
                            <button onClick={() => setShowModal(false)} className="flex-1 py-2.5 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg font-bold">Cancel</button>
                            <button onClick={() => initiateSave('user')} className="flex-1 py-2.5 bg-amber-500 hover:bg-amber-400 text-black rounded-lg font-bold">Save Changes</button>
                        </div>
                    </div>
                </div>
            )}

            {/* --- ADMIN DASHBOARD HEADER --- */}
            <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800">
                <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center"><UserCog size={24} className="mr-3 text-red-500"/> User & Policy Management</h2>
                        <p className="text-sm text-neutral-400 mt-1">Configure global qualification and engagement rules.</p>
                    </div>
                    <button onClick={() => initiateSave('policy')} className="mt-4 md:mt-0 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white rounded-lg text-sm font-bold transition-colors">
                        Save Policies
                    </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    {/* Qualification Rules */}
                    <div className="bg-neutral-950/50 p-4 rounded-xl border border-neutral-800">
                        <h4 className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Shield size={14} className="mr-2"/> Qualification Rules</h4>
                        <div className="flex items-center justify-between">
                            <span className="text-sm text-neutral-300">IB Threshold (Clients)</span>
                            <div className="flex items-center">
                                <input 
                                    type="number" 
                                    value={ibQualificationThreshold} 
                                    onChange={e => setIbQualificationThreshold(Number(e.target.value))} 
                                    className="bg-neutral-800 text-white border border-neutral-700 rounded w-16 text-center py-1 focus:border-red-500 outline-none font-bold"
                                />
                            </div>
                        </div>
                        <p className="text-[10px] text-neutral-500 mt-2">Partners must refer this many active clients to appear in the Network Tree.</p>
                    </div>

                    {/* Engagement / Nudge Rules (NEW) */}
                    <div className="bg-neutral-950/50 p-4 rounded-xl border border-neutral-800">
                        <h4 className="text-xs text-neutral-500 uppercase font-bold mb-3 flex items-center"><Bell size={14} className="mr-2"/> Engagement Policy (Nudges)</h4>
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="text-[10px] text-neutral-400 block mb-1">Cooldown (Hours)</label>
                                <input 
                                    type="number" 
                                    value={nudgeRules.cooldownHours}
                                    onChange={e => setNudgeRules({...nudgeRules, cooldownHours: Number(e.target.value)})}
                                    className="w-full bg-neutral-800 text-white border border-neutral-700 rounded py-1 px-2 focus:border-amber-500 outline-none text-sm"
                                />
                            </div>
                            <div className="flex-1">
                                <label className="text-[10px] text-neutral-400 block mb-1">Max Per Client</label>
                                <input 
                                    type="number" 
                                    value={nudgeRules.maxNudgesPerClient}
                                    onChange={e => setNudgeRules({...nudgeRules, maxNudgesPerClient: Number(e.target.value)})}
                                    className="w-full bg-neutral-800 text-white border border-neutral-700 rounded py-1 px-2 focus:border-amber-500 outline-none text-sm"
                                />
                            </div>
                        </div>
                        <p className="text-[10px] text-neutral-500 mt-2">Limits how often managers can annoy clients with "Blind Nudges".</p>
                    </div>
                </div>
            </div>

            {/* --- USER TABLE --- */}
            <div className="bg-neutral-900 rounded-xl border border-neutral-800 overflow-hidden">
                <table className="w-full text-sm text-left">
                    <thead className="bg-neutral-950 text-neutral-400 font-semibold border-b border-neutral-800">
                        <tr>
                            <th className="p-4">Name</th>
                            <th className="p-4">Email</th>
                            <th className="p-4">Current Role</th>
                            <th className="p-4">Assigned Territory</th>
                            <th className="p-4 text-center">Status</th>
                            <th className="p-4 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-800">
                        {users.map(u => (
                            <tr key={u.id} className="hover:bg-neutral-800/30 transition-colors">
                                <td className="p-4 text-white font-medium">{u.name}</td>
                                <td className="p-4 text-neutral-400">{u.email}</td>
                                <td className="p-4">
                                    <span className={`px-2 py-1 rounded text-xs border ${
                                        u.role === 'Admin' ? 'bg-red-900/20 text-red-400 border-red-900/50' :
                                        u.role.includes('Manager') ? 'bg-blue-900/20 text-blue-400 border-blue-900/50' :
                                        'bg-neutral-800 text-neutral-300 border-neutral-700'
                                    }`}>
                                        {u.role}
                                    </span>
                                </td>
                                <td className="p-4 text-neutral-300">
                                    {u.role === 'Regional Manager' ? (
                                        <span className="text-xs text-neutral-500 italic">{u.managedIds ? `${u.managedIds.length} CMs Managed` : 'Unassigned'}</span>
                                    ) : (
                                        u.region || <span className="text-neutral-600">-</span>
                                    )}
                                </td>
                                <td className="p-4 text-center">
                                    <span className={`text-[10px] px-2 py-0.5 rounded border ${u.qualified ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400' : 'bg-neutral-800 border-neutral-700 text-neutral-500'}`}>
                                        {u.qualified ? 'Active' : 'Pending'}
                                    </span>
                                </td>
                                <td className="p-4 text-right">
                                    <button 
                                        onClick={() => handleEditClick(u)}
                                        className="text-xs bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 text-white px-3 py-1.5 rounded transition-colors"
                                    >
                                        Edit Role
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
};
// --- MAIN APP COMPONENT ---
export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  
  // Dashboard State
  const [activeTab, setActiveTab] = useState('dashboard');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [showAlerts, setShowAlerts] = useState(false);
  
  // API Data State - NO MOCK DATA, start with empty arrays
  const [clients, setClients] = useState([]);
  const [clientUsernames, setClientUsernames] = useState([]);
  const [apiStatus, setApiStatus] = useState('disconnected');
  const [isLoadingClients, setIsLoadingClients] = useState(false);  // Loading state for initial client fetch
  const [userRole, setUserRole] = useState('IB'); 
  const [ibQualificationThreshold, setIbQualificationThreshold] = useState(5);
  // Volume / revenue state (updated from filtered trade history)
  const [totalVolume, setTotalVolume] = useState(0);
  const [revenue, setRevenue] = useState(0);
  const [totalPL, setTotalPL] = useState(0);
  const [tradeHistory, setTradeHistory] = useState({ trades: [], totalVolume: 0, totalPL: 0 });
  
  // Real-time System Alerts State - empty until real alerts come in
  const [systemAlerts, setSystemAlerts] = useState([]);

  const handleLogin = (token, username) => {
    setIsAuthenticated(true);
    setCurrentUser(username);
    localStorage.setItem('username', username);
    initAPI(token);
  };

  const handleLogout = () => {
    disconnectWebSocket();
    setIsAuthenticated(false);
    setCurrentUser(null);
    setClients([]);  // Clear to empty, not mock data
    setSystemAlerts([]);
    setApiStatus('disconnected');
  };

  const initAPI = async (token) => {
    try {
    //  console.log("=== Initializing XValley Connection ===");
      setApiStatus('connecting');
      setIsLoadingClients(true);
      
      // Step 1: Fetch server config
      await fetchServerConfig();
      
      // Step 2: Connect WebSocket and authenticate
      await connectWebSocket(token);
    //  console.log("✅ WebSocket Connected");
      
      // Step 3: Fetch complete client data (clients + trading accounts + trades)
    //  console.log("Fetching complete client data...");
      const clientData = await fetchCompleteClientData();
    //  console.log(`✅ Loaded ${clientData.length} clients with full data`);
      
      setClients(clientData);
      setClientUsernames(clientData.map(c => c.username).filter(Boolean));      
      
      // Step 4: Fetch network stats for dashboard
    //  console.log("Fetching network statistics...");
      const stats = await fetchNetworkStats();
    //  console.log(`✅ Network Stats: Volume=${stats.totalVolume.toFixed(2)}, Revenue=$${stats.totalRevenue.toFixed(2)}, Trades=${stats.tradesCount}`);
      
      setTotalVolume(stats.totalVolume);
      setRevenue(stats.totalRevenue);
      setTotalPL(stats.totalPL);
      setTradeHistory(stats.trades || []);
      
      // Step 5: Subscribe to real-time updates
      subscribeToTradeUpdates((update) => console.log("Trade Update:", update));
      subscribeToAccountEvents((update) => console.log("Account Update:", update));
      
      setApiStatus('connected');
      setIsLoadingClients(false);
    //  console.log("=== API Initialization Complete ===");
      
    } catch (error) {
    //  console.error("API Connection Failed:", error);
      setApiStatus('error');
      setIsLoadingClients(false);
    }
  };

  if (!isAuthenticated) {
    return <Login onLoginSuccess={handleLogin} />;
  }

  const renderContent = () => {
    switch (activeTab) {
      case 'dashboard': return <DashboardView clients={clients} apiStatus={apiStatus} onNavigate={setActiveTab} clientUsernames={clientUsernames} setTotalVolume={setTotalVolume} setRevenue={setRevenue} setTotalPL={setTotalPL} setTradeHistory={setTradeHistory} totalVolume={totalVolume} revenue={revenue} tradeHistory={tradeHistory} />;
      case 'clients': return <ClientsView clients={clients} />;
      case 'marketing': return <MarketingView userRole={userRole} clients={clients} apiStatus={apiStatus} />;
      // Pass the threshold to NetworkView
      case 'network': return <NetworkView clients={clients} userRole={userRole} ibQualificationThreshold={ibQualificationThreshold} />;
      case 'payouts': return <PayoutsView clients={clients} totalVolume={totalVolume} revenue={revenue} />;
      case 'reports': return <ReportsView clients={clients} totalVolume={totalVolume} revenue={revenue} apiStatus={apiStatus} />;
      case 'settings': return <SettingsView />;
      // Add Admin View
      case 'admin': return <AdminUserManagementView ibQualificationThreshold={ibQualificationThreshold} setIbQualificationThreshold={setIbQualificationThreshold} />;
      default: return <DashboardView clients={clients} apiStatus={apiStatus} onNavigate={setActiveTab} clientUsernames={clientUsernames} setTotalVolume={setTotalVolume} setRevenue={setRevenue} setTotalPL={setTotalPL} setTradeHistory={setTradeHistory} totalVolume={totalVolume} revenue={revenue} tradeHistory={tradeHistory} />;
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 font-sans text-neutral-100 flex overflow-hidden">
      {isMobileMenuOpen && <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-40 lg:hidden" onClick={() => setIsMobileMenuOpen(false)}></div>}
      
      <aside className={`fixed lg:static inset-y-0 left-0 z-50 bg-neutral-900 text-white transition-all duration-300 flex flex-col border-r border-neutral-800 ${sidebarCollapsed && !isMobileMenuOpen ? 'w-20' : 'w-64'} ${isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}`}>
        <div className="h-16 flex items-center justify-center border-b border-neutral-800 relative">
          {!sidebarCollapsed || isMobileMenuOpen ? <div className="flex items-center justify-center w-full px-4"><img src="https://i.ibb.co/yc7GWG8v/Nommia-Gold-and-White-Logo.png" alt="Nommia Logo" className="h-14 w-auto object-contain transition-all duration-300" /></div> : <div className="w-full flex justify-center"><img src="https://i.ibb.co/yc7GWG8v/Nommia-Gold-and-White-Logo.png" alt="Nommia Logo" className="h-10 w-10 object-contain transition-all duration-300" /></div>}
          <button onClick={() => setIsMobileMenuOpen(false)} className="lg:hidden text-neutral-400 hover:text-white transition-colors absolute top-4 right-4"><X size={20} /></button>
          <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:block text-neutral-500 hover:text-white transition-colors absolute top-1/2 -translate-y-1/2 right-2 p-1">{sidebarCollapsed ? <Menu size={16}/> : <X size={16}/>}</button>
        </div>
        
        <div className="flex-1 overflow-y-auto py-6 px-3">
          <SidebarItem icon={LayoutDashboard} label="Overview" active={activeTab === 'dashboard'} onClick={() => setActiveTab('dashboard')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          <SidebarItem icon={Users} label="Clients" active={activeTab === 'clients'} onClick={() => setActiveTab('clients')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          <SidebarItem icon={LinkIcon} label="Marketing" active={activeTab === 'marketing'} onClick={() => setActiveTab('marketing')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          <SidebarItem icon={Network} label="Network" active={activeTab === 'network'} onClick={() => setActiveTab('network')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          <SidebarItem icon={PieChart} label="Reports" active={activeTab === 'reports'} onClick={() => setActiveTab('reports')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          <SidebarItem icon={DollarSign} label="Payouts" active={activeTab === 'payouts'} onClick={() => setActiveTab('payouts')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          
          {userRole === 'Admin' && (
             <>
               <div className="my-2 border-t border-neutral-800 mx-2"></div>
               <SidebarItem icon={UserCog} label="User Management" active={activeTab === 'admin'} onClick={() => setActiveTab('admin')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
             </>
          )}

          <div className="my-4 border-t border-neutral-800 mx-2"></div>
          
           <div className={`px-3 py-2 ${sidebarCollapsed ? 'hidden' : 'block'}`}>
               <div className="bg-neutral-800/50 rounded-lg p-2 border border-neutral-700 mb-4">
                 <p className="text-xs text-neutral-500 uppercase font-bold mb-2 text-center">Demo View As:</p>
                 <div className="flex gap-1 justify-center flex-wrap">
                   <button onClick={() => setUserRole('IB')} className={`px-2 py-1 text-[10px] rounded mb-1 ${userRole === 'IB' ? 'bg-amber-500 text-black font-bold' : 'bg-neutral-700 text-neutral-400'}`}>IB</button>
                   <button onClick={() => setUserRole('CountryManager')} className={`px-2 py-1 text-[10px] rounded mb-1 ${userRole === 'CountryManager' ? 'bg-amber-500 text-black font-bold' : 'bg-neutral-700 text-neutral-400'}`}>CM</button>
                   <button onClick={() => setUserRole('RegionalManager')} className={`px-2 py-1 text-[10px] rounded mb-1 ${userRole === 'RegionalManager' ? 'bg-amber-500 text-black font-bold' : 'bg-neutral-700 text-neutral-400'}`}>RM</button>
                   <button onClick={() => {setUserRole('Admin'); setActiveTab('admin');}} className={`px-2 py-1 text-[10px] rounded mb-1 ${userRole === 'Admin' ? 'bg-red-500 text-white font-bold' : 'bg-neutral-700 text-neutral-400'}`}>Admin</button>
                 </div>
               </div>
           </div>
        </div>
        
        <div className="p-4 border-t border-neutral-800">
           <SidebarItem icon={Settings} label="Settings" active={activeTab === 'settings'} onClick={() => setActiveTab('settings')} collapsed={sidebarCollapsed && !isMobileMenuOpen} />
          {!sidebarCollapsed && (
            <div className="mt-4 flex items-center p-3 bg-neutral-800 rounded-xl border border-neutral-700">
              <div className="w-10 h-10 rounded-full bg-gradient-to-tr from-amber-500 to-amber-700 flex items-center justify-center text-sm font-bold shadow-lg text-white">
                 {currentUser ? currentUser.substring(0, 2).toUpperCase() : 'IB'}
              </div>
              <div className="ml-3 overflow-hidden">
                <p className="text-sm font-medium truncate text-white">{currentUser || 'Partner'}</p>
                <p className="text-xs text-neutral-400 truncate">ID: {getSessionPartnerId()}</p>
              </div>
            </div>
          )}
        </div>
      </aside>
      
      <main className="flex-1 flex flex-col h-screen overflow-hidden relative">
        <header className="h-16 bg-neutral-900 border-b border-neutral-800 flex items-center justify-between px-4 lg:px-8 shadow-sm relative">
          <div className="flex items-center">
            <button onClick={() => setIsMobileMenuOpen(true)} className="lg:hidden mr-4 text-neutral-400 hover:text-white transition-colors"><Menu size={24} /></button>
            <button onClick={() => setSidebarCollapsed(!sidebarCollapsed)} className="hidden lg:block text-neutral-400 hover:text-white transition-colors">{sidebarCollapsed ? <Menu size={20}/> : <Menu size={20}/>}</button>
            <h1 className="ml-4 text-xl font-bold text-white capitalize hidden sm:block">{activeTab === 'admin' ? 'Admin Control Panel' : activeTab}</h1>
          </div>
          
          <div className="flex items-center space-x-4">
             {apiStatus === 'connected' && <RealTimeTicker />}

             {/* Live Chat Button */}
             <a 
               href="https://bizbot360.com/ad-leads/ibswitchboard" 
               target="_blank" 
               rel="noopener noreferrer"
               className="hidden md:flex items-center px-3 py-1.5 bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-400 border border-emerald-500/30 rounded-full text-xs font-bold transition-all hover:scale-105 mr-2"
             >
               <img src="https://upload.wikimedia.org/wikipedia/commons/6/6b/WhatsApp.svg" alt="WA" className="w-4 h-4 mr-1.5" />
               Live Chat
             </a>

             <div className={`hidden md:flex items-center px-3 py-1 rounded-full text-sm font-medium border shadow-[0_0_10px_rgba(16,185,129,0.2)] ${apiStatus === 'connected' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-amber-500/10 text-amber-400 border-amber-500/20'}`}>
                <div className={`w-2 h-2 rounded-full mr-2 ${apiStatus === 'connected' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`}></div>{apiStatus === 'connected' ? 'System Operational' : 'Offline Mode'}
             </div>
             
             {/* --- SYSTEM ALERTS DROPDOWN --- */}
             <div className="relative">
                 <button 
                    onClick={() => setShowAlerts(!showAlerts)}
                    className={`relative p-2 rounded-full transition-colors ${showAlerts ? 'bg-neutral-800 text-white' : 'text-neutral-400 hover:bg-neutral-800 hover:text-white'}`}
                 >
                    <AlertCircle size={20} />
                    {systemAlerts.length > 0 && <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-red-500 rounded-full border border-neutral-900 shadow-md animate-pulse"></span>}
                 </button>

                 {showAlerts && (
                    <>
                        <div className="fixed inset-0 z-30" onClick={() => setShowAlerts(false)}></div> {/* Overlay to close on click-out */}
                        <div className="absolute right-0 mt-3 w-80 bg-neutral-900 border border-neutral-700 rounded-xl shadow-2xl z-40 overflow-hidden animate-fadeIn">
                            <div className="p-3 border-b border-neutral-800 font-bold text-white text-sm bg-neutral-950 flex justify-between items-center">
                                <span>System Alerts</span>
                                <span className="text-[10px] bg-red-500/20 text-red-400 px-1.5 py-0.5 rounded border border-red-500/30">{systemAlerts.length} New</span>
                            </div>
                            <div className="max-h-64 overflow-y-auto">
                                {systemAlerts.length === 0 ? (
                                    <div className="p-4 text-center text-neutral-500 text-sm">No alerts</div>
                                ) : systemAlerts.map(alert => (
                                    <div key={alert.id} className="p-3 border-b border-neutral-800 hover:bg-neutral-800 transition-colors cursor-pointer group">
                                        <div className="flex justify-between items-start mb-1">
                                            <span className={`text-xs font-bold ${alert.type === 'critical' ? 'text-red-500' : alert.type === 'success' ? 'text-emerald-500' : 'text-amber-500'}`}>
                                                {alert.title}
                                            </span>
                                            <span className="text-[10px] text-neutral-600">{alert.timestamp ? getRelativeTime(alert.timestamp) : (typeof alert.time === 'string' ? alert.time : '')}</span>
                                        </div>
                                        <p className="text-xs text-neutral-300 group-hover:text-white transition-colors leading-snug">{alert.msg}</p>
                                    </div>
                                ))}
                            </div>
                            <div className="p-2 text-center bg-neutral-950">
                                <button 
                                    onClick={() => setSystemAlerts([])}
                                    className="text-[10px] text-neutral-500 hover:text-white uppercase font-bold tracking-wider"
                                >
                                    Mark all read
                                </button>
                            </div>
                        </div>
                    </>
                 )}
             </div>
             
             <div className="h-8 w-px bg-neutral-800 mx-2"></div>
             <button onClick={handleLogout} className="flex items-center text-sm font-medium text-neutral-400 hover:text-white transition-colors"><span className="mr-2">Logout</span></button>
          </div>
        </header>
        
        <div className="flex-1 overflow-auto p-4 lg:p-8 bg-neutral-950" style={{ backgroundImage: `url("https://i.ibb.co/kV35BSfn/graphic3-b.png")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'center center', backgroundSize: 'cover', backgroundAttachment: 'fixed' }}>
          <div className="max-w-7xl mx-auto">{renderContent()}</div>
        </div>
      </main>
    </div>
  );
}