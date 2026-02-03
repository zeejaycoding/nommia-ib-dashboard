import React, { useState, useEffect } from 'react';

export default function Diagnostics() {
  const [logs, setLogs] = useState([]);

  const addLog = (msg, type = 'info') => {
    setLogs(prev => [...prev, { msg, type, time: new Date().toLocaleTimeString() }]);
    console.log(`[Diag] ${msg}`);
  };

  const runTests = async () => {
    addLog("Starting Diagnostics...", 'info');

    // TEST 1: Check for Global Object
    if (window.autobahn) {
      addLog("✅ TEST 1: window.autobahn exists", 'success');
    } else {
      addLog("❌ TEST 1: window.autobahn is MISSING. Check index.html", 'error');
      return;
    }

    // TEST 2: Check for Connection Class
    if (window.autobahn.Connection) {
      addLog("✅ TEST 2: autobahn.Connection class found", 'success');
    } else {
      addLog("❌ TEST 2: autobahn.Connection is undefined", 'error');
      return;
    }

    // TEST 3: Attempt Instantiation (No Connection yet)
    try {
      const connection = new window.autobahn.Connection({
        url: 'ws://localhost:9000', // Dummy URL
        realm: 'realm1'
      });
      addLog("✅ TEST 3: Connection object created successfully", 'success');
    } catch (e) {
      addLog(`❌ TEST 3: Failed to create connection object: ${e.message}`, 'error');
      return;
    }

    // TEST 4: Real Connection Test (using the Proxy URL)
    addLog("⏳ TEST 4: Attempting actual connection...", 'warning');
    
    try {
        const connection = new window.autobahn.Connection({
            url: 'ws://localhost:5173/ws-admin', // Our local proxy
            realm: 'fxplayer',
            max_retries: 1
        });

        connection.onopen = () => {
            addLog("✅ TEST 4: WebSocket Connected via Proxy!", 'success');
            connection.close();
        };

        connection.onclose = (reason, details) => {
            addLog(`⚠️ TEST 4 Result: Closed. Reason: ${reason}`, 'warning');
            if (reason === 'unreachable') {
                addLog("❌ The Proxy isn't reaching the server. Check vite.config.js", 'error');
            }
        };

        connection.open();
    } catch (e) {
        addLog(`❌ TEST 4 Crash: ${e.message}`, 'error');
    }
  };

  return (
    <div className="p-8 bg-neutral-900 min-h-screen text-white font-mono">
      <h1 className="text-2xl font-bold mb-4 text-amber-500">System Diagnostics</h1>
      <button 
        onClick={runTests}
        className="px-4 py-2 bg-blue-600 rounded hover:bg-blue-500 mb-6 font-bold"
      >
        Run Tests
      </button>

      <div className="space-y-2 border border-neutral-800 p-4 rounded bg-black">
        {logs.length === 0 && <div className="text-neutral-500">Ready to test...</div>}
        {logs.map((log, i) => (
          <div key={i} className={`flex gap-4 ${
            log.type === 'error' ? 'text-red-500 font-bold' : 
            log.type === 'success' ? 'text-emerald-500' : 
            log.type === 'warning' ? 'text-amber-400' : 'text-neutral-300'
          }`}>
            <span className="text-neutral-600">[{log.time}]</span>
            <span>{log.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}