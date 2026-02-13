import React, { useState } from 'react';
import { User, Lock, Loader2, ArrowRight, Shield, X } from 'lucide-react';
import { loginAndGetToken } from './api_integration_v2';

const API_CONFIG = {
  BACKEND_URL: import.meta.env.VITE_BACKEND_URL || 'https://nommia-ib-backend.onrender.com'
};

const Login = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  
  // 2FA State
  const [show2FAModal, setShow2FAModal] = useState(false);
  const [twoFACode, setTwoFACode] = useState('');
  const [is2FAVerifying, setIs2FAVerifying] = useState(false);
  const [pendingToken, setPendingToken] = useState(null);
  const [pendingUsername, setPendingUsername] = useState('');

  const check2FAEnabled = async (user) => {
    try {
      console.log('[Login] Checking 2FA status for user:', user);
      const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user })
      });
      const data = await res.json();
      console.log('[Login] 2FA check response:', data);
      const is2FAEnabled = data.success && data.enabled === true;
      console.log('[Login] 2FA enabled for user:', is2FAEnabled);
      return is2FAEnabled;
    } catch (err) {
      console.warn('[Login 2FA Check] Error:', err.message);
      return false;
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      console.log('[Login] Attempting login with username:', username);
      // Call the API integration layer
      const token = await loginAndGetToken(username, password);
      
      // If successful, check if 2FA is enabled
      if (token) {
        console.log('[Login] Login successful, token received. Checking 2FA...');
        const is2FAEnabled = await check2FAEnabled(username);
        
        if (is2FAEnabled) {
          console.log('[Login] 2FA is enabled, showing modal');
          // 2FA is enabled - show modal instead of logging in
          setPendingToken(token);
          setPendingUsername(username);
          setShow2FAModal(true);
          setTwoFACode('');
        } else {
          console.log('[Login] 2FA is disabled, proceeding with normal login');
          // 2FA is disabled - proceed with login
          onLoginSuccess(token, username);
        }
      }
    } catch (err) {
      console.error('[Login] Login error:', err);
      setError('Invalid credentials. Please check your username and password.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerify2FA = async () => {
    if (twoFACode.length !== 6) {
      setError('Please enter a 6-digit code');
      return;
    }

    setIs2FAVerifying(true);
    setError('');

    try {
      console.log('[Login 2FA] Verifying code for user:', pendingUsername);
      const res = await fetch(`${API_CONFIG.BACKEND_URL}/api/2fa/verify-login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: pendingUsername,
          token: twoFACode
        })
      });

      const data = await res.json();
      console.log('[Login 2FA] Verify response:', data);

      if (data.success) {
        console.log('[Login 2FA] Code verified, completing login');
        // 2FA verified - complete login
        setShow2FAModal(false);
        setTwoFACode('');
        onLoginSuccess(pendingToken, pendingUsername);
      } else {
        setError('Invalid authenticator code. Please try again.');
      }
    } catch (err) {
      console.error('[Login 2FA] Verification error:', err);
      setError('Error verifying 2FA code: ' + err.message);
    } finally {
      setIs2FAVerifying(false);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 flex items-center justify-center p-4 relative overflow-hidden">
      {/* Background Graphic */}
      <div 
        className="absolute inset-0 z-0 opacity-20 pointer-events-none"
        style={{
          backgroundImage: `url("https://i.ibb.co/kV35BSfn/graphic3-b.png")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center center',
          backgroundSize: 'cover',
        }}
      ></div>

      {/* 2FA Modal */}
      {show2FAModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-sm shadow-2xl relative p-6 text-center">
            <button 
              onClick={() => {
                setShow2FAModal(false);
                setPendingToken(null);
                setPendingUsername('');
                setTwoFACode('');
                setError('');  // Clear error when closing modal
              }} 
              className="absolute top-4 right-4 text-neutral-500 hover:text-white"
            >
              <X size={20}/>
            </button>
            
            <div className="mb-4 flex justify-center">
              <div className="p-3 bg-amber-500/10 rounded-full text-amber-500">
                <Shield size={32}/>
              </div>
            </div>
            
            <h3 className="text-xl font-bold text-white mb-2">Verify Your Identity</h3>
            <p className="text-sm text-neutral-400 mb-6">
              Two-factor authentication is enabled for your account. Enter the 6-digit code from your authenticator app.
            </p>

            {error && show2FAModal && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm mb-4">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <input 
                type="text" 
                placeholder="000000" 
                maxLength="6" 
                value={twoFACode} 
                onChange={(e) => setTwoFACode(e.target.value.replace(/[^0-9]/g, ''))}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-4 text-white text-center tracking-[0.5em] font-mono text-2xl outline-none focus:border-amber-500"
                autoFocus
              />
              
              <button
                onClick={handleVerify2FA}
                disabled={is2FAVerifying || twoFACode.length !== 6}
                className="w-full py-3 bg-amber-500 hover:bg-amber-400 disabled:opacity-50 disabled:cursor-not-allowed text-neutral-900 font-bold rounded-lg transition-colors flex items-center justify-center"
              >
                {is2FAVerifying ? (
                  <>
                    <Loader2 size={18} className="animate-spin mr-2" />
                    Verifying...
                  </>
                ) : (
                  '✅ Verify & Login'
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="w-full max-w-md bg-neutral-900 border border-neutral-800 rounded-2xl shadow-2xl shadow-black/50 relative z-10 p-8">
        <div className="flex flex-col items-center mb-8">
          <img 
            src="https://i.ibb.co/yc7GWG8v/Nommia-Gold-and-White-Logo.png" 
            alt="Nommia Logo" 
            className="h-16 w-auto object-contain mb-4" 
          />
          <h2 className="text-2xl font-bold text-white tracking-tight">Partner Portal</h2>
          <p className="text-neutral-400 text-sm mt-2">Sign in to access your IB dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && !show2FAModal && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-red-400 text-sm text-center">
              {error}
            </div>
          )}

          <div className="space-y-2">
            <label className="text-xs font-medium text-neutral-300 uppercase tracking-wider ml-1">Username</label>
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User size={18} className="text-neutral-500 group-focus-within:text-amber-500 transition-colors" />
              </div>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
                placeholder="Enter your ID"
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-neutral-300 uppercase tracking-wider ml-1">Password</label>
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock size={18} className="text-neutral-500 group-focus-within:text-amber-500 transition-colors" />
              </div>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="block w-full pl-10 pr-3 py-3 bg-neutral-950 border border-neutral-800 rounded-xl text-white placeholder-neutral-600 focus:outline-none focus:border-amber-500 focus:ring-1 focus:ring-amber-500 transition-all"
                placeholder="••••••••"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full flex items-center justify-center py-3 px-4 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-neutral-900 font-bold rounded-xl shadow-lg shadow-amber-500/20 transition-all transform active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <>
                Sign In <ArrowRight size={18} className="ml-2" />
              </>
            )}
          </button>
        </form>

        <div className="mt-8 text-center">
          <a href="#" className="text-xs text-neutral-500 hover:text-amber-500 transition-colors">
            Forgot your password?
          </a>
        </div>
      </div>
      
      <div className="absolute bottom-4 text-neutral-600 text-xs">
        &copy; 2025 Nommia. All rights reserved.
      </div>
    </div>
  );
};

export default Login;