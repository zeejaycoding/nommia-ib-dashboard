import React, { useState } from 'react';
import { User, Lock, Loader2, ArrowRight } from 'lucide-react';
import { loginAndGetToken } from './api_integration_v2';

const Login = ({ onLoginSuccess }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      // Call the API integration layer
      const token = await loginAndGetToken(username, password);
      
      // If successful, pass the token up to the main App
      if (token) {
        onLoginSuccess(token, username);
      }
    } catch (err) {
      setError('Invalid credentials. Please check your username and password.');
    } finally {
      setIsLoading(false);
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
          {error && (
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