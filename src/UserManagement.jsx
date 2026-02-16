import React, { useState, useEffect } from 'react';
import { X, Plus, Trash2, Edit2, Globe, Users, Bell, Save } from 'lucide-react';
import { 
  upgradeUserRole, 
  fetchAllUsers, 
  getUserDetails, 
  saveNudgeSettings, 
  getNudgeSettings 
} from './api_integration_v2.js';

export const UserManagement = ({ adminUsername, currentUserRole }) => {
  const [activeTab, setActiveTab] = useState('roles'); // 'roles' or 'nudges'
  
  // --- TAB 1: USER ROLES STATE ---
  const [users, setUsers] = useState([]);
  const [selectedUser, setSelectedUser] = useState(null);
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [selectedRole, setSelectedRole] = useState('IB');
  const [selectedCountry, setSelectedCountry] = useState('');
  const [selectedRegions, setSelectedRegions] = useState([]);
  const [isLoadingUsers, setIsLoadingUsers] = useState(true);

  // --- TAB 2: NUDGE SETTINGS STATE ---
  const [nudgeSettings, setNudgeSettings] = useState([]);
  const [showNudgeModal, setShowNudgeModal] = useState(false);
  const [nudgeType, setNudgeType] = useState('Complete KYC');
  const [cooldownHours, setCooldownHours] = useState(24);
  const [maxNudgesPerWeek, setMaxNudgesPerWeek] = useState(5);
  const [isLoadingSettings, setIsLoadingSettings] = useState(true);

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

  const nudgeTypes = ['Complete KYC', 'Fund Account', 'Increase Volume', 'Trading Inactive'];

  // --- FETCH USERS ---
  useEffect(() => {
    const loadUsers = async () => {
      try {
        setIsLoadingUsers(true);
        const data = await fetchAllUsers(adminUsername);
        setUsers(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Failed to load users:', error);
        setUsers([]);
      } finally {
        setIsLoadingUsers(false);
      }
    };
    loadUsers();
  }, [adminUsername]);

  // --- FETCH NUDGE SETTINGS ---
  useEffect(() => {
    const loadSettings = async () => {
      try {
        setIsLoadingSettings(true);
        const data = await getNudgeSettings(adminUsername);
        setNudgeSettings(Array.isArray(data) ? data : []);
      } catch (error) {
        console.error('Failed to load nudge settings:', error);
        setNudgeSettings([]);
      } finally {
        setIsLoadingSettings(false);
      }
    };
    loadSettings();
  }, [adminUsername]);

  // --- HANDLE ROLE UPGRADE ---
  const handleUpgradeUser = async () => {
    if (!selectedUser) return;

    try {
      await upgradeUserRole(
        selectedUser.username,
        selectedUser.email,
        selectedRole,
        selectedRole === 'Country Manager' ? selectedCountry : null,
        selectedRole === 'Regional Manager' ? selectedRegions : [],
        adminUsername
      );
      alert('✅ User role updated successfully');
      setShowRoleModal(false);
      setSelectedUser(null);
      
      // Reload users
      const data = await fetchAllUsers(adminUsername);
      setUsers(Array.isArray(data) ? data : []);
    } catch (error) {
      alert('❌ Error: ' + error.message);
    }
  };

  // --- HANDLE SAVE NUDGE SETTINGS ---
  const handleSaveNudgeSetting = async () => {
    try {
      await saveNudgeSettings(adminUsername, nudgeType, cooldownHours, maxNudgesPerWeek);
      alert('✅ Nudge settings saved successfully');
      setShowNudgeModal(false);
      setCooldownHours(24);
      setMaxNudgesPerWeek(5);
      
      // Reload settings
      const data = await getNudgeSettings(adminUsername);
      setNudgeSettings(Array.isArray(data) ? data : []);
    } catch (error) {
      alert('❌ Error: ' + error.message);
    }
  };

  // --- OPEN ROLE MODAL ---
  const openRoleModal = (user) => {
    setSelectedUser(user);
    setSelectedRole(user.role || 'IB');
    setSelectedCountry(user.country || '');
    setSelectedRegions(user.regions || []);
    setShowRoleModal(true);
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* --- TAB SWITCHER --- */}
      <div className="flex gap-2 border-b border-neutral-800">
        <button
          onClick={() => setActiveTab('roles')}
          className={`px-4 py-3 font-bold text-sm transition-colors ${
            activeTab === 'roles'
              ? 'text-amber-500 border-b-2 border-amber-500'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          User Roles
        </button>
        <button
          onClick={() => setActiveTab('nudges')}
          className={`px-4 py-3 font-bold text-sm transition-colors ${
            activeTab === 'nudges'
              ? 'text-amber-500 border-b-2 border-amber-500'
              : 'text-neutral-400 hover:text-white'
          }`}
        >
          Nudge Settings
        </button>
      </div>

      {/* --- TAB 1: USER ROLES --- */}
      {activeTab === 'roles' && (
        <div className="space-y-4">
          <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center">
                  <Users size={20} className="mr-2 text-blue-500" />
                  User Roles & Territories
                </h3>
                <p className="text-sm text-neutral-400 mt-1">Manage user roles and assign territories</p>
              </div>
            </div>

            {isLoadingUsers ? (
              <div className="text-center py-8 text-neutral-500">
                <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-amber-500 mb-2"></div>
                <p>Loading users...</p>
              </div>
            ) : users.length === 0 ? (
              <div className="text-center py-8 text-neutral-500">
                <Users size={40} className="mx-auto mb-2 opacity-50" />
                <p>No users found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm text-left">
                  <thead className="bg-neutral-950 text-neutral-400 border-b border-neutral-800">
                    <tr>
                      <th className="p-3">Name</th>
                      <th className="p-3">Email</th>
                      <th className="p-3">Current Role</th>
                      <th className="p-3">Territory</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {users.map((user) => (
                      <tr key={user.id} className="hover:bg-neutral-800/30 transition-colors">
                        <td className="p-3 text-white">{user.name || user.username}</td>
                        <td className="p-3 text-neutral-400 text-xs">{user.email}</td>
                        <td className="p-3">
                          <span className={`px-2 py-1 rounded text-xs border ${
                            user.role === 'Admin' ? 'bg-red-900/20 text-red-400 border-red-900/50' :
                            user.role === 'Regional Manager' ? 'bg-purple-900/20 text-purple-400 border-purple-900/50' :
                            user.role === 'Country Manager' ? 'bg-blue-900/20 text-blue-400 border-blue-900/50' :
                            'bg-neutral-800 text-neutral-300 border-neutral-700'
                          }`}>
                            {user.role || 'IB'}
                          </span>
                        </td>
                        <td className="p-3 text-neutral-400 text-xs">
                          {user.role === 'Country Manager' ? user.country : 
                           user.role === 'Regional Manager' ? `${user.regions?.length || 0} Regions` :
                           '-'}
                        </td>
                        <td className="p-3 text-right">
                          <button
                            onClick={() => openRoleModal(user)}
                            className="px-3 py-1 bg-neutral-800 hover:bg-neutral-700 text-white rounded text-xs font-medium transition-colors flex items-center justify-end gap-1"
                          >
                            <Edit2 size={12} /> Edit
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- TAB 2: NUDGE SETTINGS --- */}
      {activeTab === 'nudges' && (
        <div className="space-y-4">
          <div className="bg-neutral-900 p-6 rounded-xl border border-neutral-800">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center">
                  <Bell size={20} className="mr-2 text-amber-500" />
                  Nudge Engagement Settings
                </h3>
                <p className="text-sm text-neutral-400 mt-1">Configure cooldowns and limits for engagement nudges</p>
              </div>
              <button
                onClick={() => setShowNudgeModal(true)}
                className="px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-lg text-sm font-bold transition-colors flex items-center gap-2"
              >
                <Plus size={16} /> Add Setting
              </button>
            </div>

            {isLoadingSettings ? (
              <div className="text-center py-8 text-neutral-500">
                <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-amber-500 mb-2"></div>
                <p>Loading settings...</p>
              </div>
            ) : nudgeSettings.length === 0 ? (
              <div className="text-center py-8 text-neutral-500">
                <Bell size={40} className="mx-auto mb-2 opacity-50" />
                <p>No nudge settings configured</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {nudgeSettings.map((setting) => (
                  <div key={setting.id} className="p-4 bg-neutral-950 border border-neutral-800 rounded-lg hover:border-neutral-700 transition-colors">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <h4 className="text-sm font-bold text-white">{setting.nudge_type}</h4>
                        <p className="text-xs text-neutral-500">By {setting.admin_username}</p>
                      </div>
                      <Bell size={16} className="text-amber-500" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-neutral-400">Cooldown:</span>
                        <span className="text-sm font-bold text-white">{setting.cooldown_hours}h</span>
                      </div>
                      <div className="flex justify-between items-center">
                        <span className="text-xs text-neutral-400">Max per week:</span>
                        <span className="text-sm font-bold text-white">{setting.max_nudges_per_week}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* --- ROLE UPGRADE MODAL --- */}
      {showRoleModal && selectedUser && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-md shadow-2xl relative p-6">
            <button onClick={() => setShowRoleModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white">
              <X size={20} />
            </button>

            <h3 className="text-xl font-bold text-white mb-2">Upgrade User Role</h3>
            <p className="text-sm text-neutral-400 mb-6">Modifying permissions for <span className="text-white font-bold">{selectedUser.name || selectedUser.username}</span></p>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-neutral-500 uppercase font-bold mb-2 block">Select Role</label>
                <select
                  value={selectedRole}
                  onChange={(e) => setSelectedRole(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white focus:border-amber-500 outline-none"
                >
                  <option value="IB">Standard IB</option>
                  <option value="Country Manager">Country Manager</option>
                  <option value="Regional Manager">Regional Manager</option>
                  <option value="Admin">Administrator</option>
                </select>
              </div>

              {selectedRole === 'Country Manager' && (
                <div className="p-4 bg-neutral-950/50 border border-neutral-800 rounded-lg">
                  <label className="text-xs text-blue-500 uppercase font-bold mb-2 block flex items-center">
                    <Globe size={12} className="mr-1" /> Assign Country
                  </label>
                  <select
                    value={selectedCountry}
                    onChange={(e) => setSelectedCountry(e.target.value)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg p-2 text-white focus:border-amber-500 outline-none"
                  >
                    <option value="">Select a country...</option>
                    {availableCountries.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
              )}

              {selectedRole === 'Regional Manager' && (
                <div className="p-4 bg-neutral-950/50 border border-neutral-800 rounded-lg">
                  <label className="text-xs text-purple-500 uppercase font-bold mb-2 block flex items-center">
                    <Users size={12} className="mr-1" /> Assign Regions
                  </label>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {availableCountries.map((country) => (
                      <label key={country} className="flex items-center gap-2 cursor-pointer hover:bg-neutral-800 p-1 rounded">
                        <input
                          type="checkbox"
                          checked={selectedRegions.includes(country)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedRegions([...selectedRegions, country]);
                            } else {
                              setSelectedRegions(selectedRegions.filter((r) => r !== country));
                            }
                          }}
                          className="w-4 h-4 accent-amber-500"
                        />
                        <span className="text-sm text-white">{country}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="mt-6 flex gap-3">
              <button onClick={() => setShowRoleModal(false)} className="flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg font-bold">
                Cancel
              </button>
              <button onClick={handleUpgradeUser} className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-lg font-bold flex items-center justify-center gap-2">
                <Save size={16} /> Save Role
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- NUDGE SETTINGS MODAL --- */}
      {showNudgeModal && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-xl w-full max-w-md shadow-2xl relative p-6">
            <button onClick={() => setShowNudgeModal(false)} className="absolute top-4 right-4 text-neutral-500 hover:text-white">
              <X size={20} />
            </button>

            <h3 className="text-xl font-bold text-white mb-2">Add Nudge Setting</h3>
            <p className="text-sm text-neutral-400 mb-6">Configure engagement policy for a nudge type</p>

            <div className="space-y-4">
              <div>
                <label className="text-xs text-neutral-500 uppercase font-bold mb-2 block">Nudge Type</label>
                <select
                  value={nudgeType}
                  onChange={(e) => setNudgeType(e.target.value)}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white focus:border-amber-500 outline-none"
                >
                  {nudgeTypes.map((type) => (
                    <option key={type} value={type}>{type}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-xs text-neutral-500 uppercase font-bold mb-2 block">Cooldown Period (Hours)</label>
                <input
                  type="number"
                  min="1"
                  max="720"
                  value={cooldownHours}
                  onChange={(e) => setCooldownHours(parseInt(e.target.value))}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white focus:border-amber-500 outline-none"
                />
                <p className="text-xs text-neutral-500 mt-1">How many hours before same nudge can be sent again</p>
              </div>

              <div>
                <label className="text-xs text-neutral-500 uppercase font-bold mb-2 block">Max Nudges Per Week</label>
                <input
                  type="number"
                  min="1"
                  max="50"
                  value={maxNudgesPerWeek}
                  onChange={(e) => setMaxNudgesPerWeek(parseInt(e.target.value))}
                  className="w-full bg-neutral-950 border border-neutral-700 rounded-lg p-3 text-white focus:border-amber-500 outline-none"
                />
                <p className="text-xs text-neutral-500 mt-1">Maximum times this nudge can be sent per 7 days</p>
              </div>
            </div>

            <div className="mt-6 flex gap-3">
              <button onClick={() => setShowNudgeModal(false)} className="flex-1 py-2 bg-neutral-800 hover:bg-neutral-700 text-white rounded-lg font-bold">
                Cancel
              </button>
              <button onClick={handleSaveNudgeSetting} className="flex-1 py-2 bg-amber-500 hover:bg-amber-400 text-black rounded-lg font-bold flex items-center justify-center gap-2">
                <Save size={16} /> Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
