document.addEventListener('DOMContentLoaded', () => {
    // --- 1. Authentication & Session Guard ---
    const authToken = localStorage.getItem('admin_token');
    if (!authToken) {
        window.location.href = '/login.html';
        return;
    }

    // --- 2. DOM Elements Mapping ---
    // Stat Cards
    const statTotalDownloads = document.getElementById('stat-total-downloads');
    const statBandwidth = document.getElementById('stat-bandwidth');
    const statYtdlpVersion = document.getElementById('stat-ytdlp-version');
    const statAdViews = document.getElementById('stat-ad-views');

    // Controls & Buttons
    const btnUpdateYtdlp = document.getElementById('btn-update-ytdlp');
    const cookieFileInput = document.getElementById('cookie-file');
    const btnApplyCookies = cookieFileInput ? cookieFileInput.nextElementSibling : null;
    const proxyToggle = document.querySelector('#engine-settings input[type="checkbox"]');

    // Ad Settings
    const adTimerRange = document.getElementById('ad-timer-range');
    const adTimerValue = document.getElementById('ad-timer-value');
    const adSaveBtn = document.querySelector('#ad-controls button');
    const adCheckboxes = document.querySelectorAll('#ad-controls input[type="checkbox"]');

    // Logs Section
    const logsTbody = document.querySelector('#logs-section tbody');
    const logFilterInput = document.querySelector('#logs-section input[type="text"]');
    const btnClearLogs = document.querySelector('#logs-section button');

    // Header & Logout
    const btnLogout = document.getElementById('btn-logout');

    // Global log cache for local filtering
    let localLogsCache = [];

    // --- 3. API Fetch Helper ---
    async function apiRequest(endpoint, options = {}) {
        const headers = {
            'Authorization': `Bearer ${authToken}`,
            ...(options.headers || {})
        };

        // Don't override Content-Type if sending FormData
        if (!(options.body instanceof FormData) && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }

        try {
            const response = await fetch(endpoint, { ...options, headers });
            
            if (response.status === 401 || response.status === 403) {
                localStorage.removeItem('admin_token');
                window.location.href = '/login.html';
                return null;
            }

            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Server error encountered');
            return data;
        } catch (err) {
            console.error(`API Error [${endpoint}]:`, err);
            throw err;
        }
    }

    // --- 4. Live Stats Synchronization ---
    async function loadStats() {
        try {
            const data = await apiRequest('/api/admin/stats');
            if (!data) return;

            if (statTotalDownloads) statTotalDownloads.textContent = Number(data.totalDownloads || 0).toLocaleString();
            if (statBandwidth) statBandwidth.textContent = `${data.bandwidthTB || '0.00'} TB`;
            if (statYtdlpVersion) statYtdlpVersion.textContent = data.ytDlpVersion || 'Unknown';
            if (statAdViews) statAdViews.textContent = Number(data.adImpressions || 0).toLocaleString();

            if (proxyToggle && typeof data.proxyActive === 'boolean') {
                proxyToggle.checked = data.proxyActive;
            }
        } catch (err) {
            // Silently swallow background sync errors to avoid spamming alerts
        }
    }

    // --- 5. Downloader Engine Controls ---
    // One-Click yt-dlp Update
    if (btnUpdateYtdlp) {
        btnUpdateYtdlp.addEventListener('click', async () => {
            const originalText = btnUpdateYtdlp.innerHTML;
            btnUpdateYtdlp.disabled = true;
            btnUpdateYtdlp.innerHTML = `
                <svg class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg> Updating Engine...
            `;

            try {
                const result = await apiRequest('/api/admin/update-engine', { method: 'POST' });
                alert(result.message || 'yt-dlp core updated successfully!');
                if (result.newVersion && statYtdlpVersion) {
                    statYtdlpVersion.textContent = result.newVersion;
                }
            } catch (err) {
                alert(`Update failed: ${err.message}`);
            } finally {
                btnUpdateYtdlp.disabled = false;
                btnUpdateYtdlp.innerHTML = originalText;
            }
        });
    }

    // Cookie File Upload
    if (btnApplyCookies && cookieFileInput) {
        btnApplyCookies.addEventListener('click', async () => {
            const file = cookieFileInput.files[0];
            if (!file) {
                alert('Please select a cookies.txt file first.');
                return;
            }

            const formData = new FormData();
            formData.append('cookies', file);

            btnApplyCookies.disabled = true;
            btnApplyCookies.textContent = 'Uploading...';

            try {
                const res = await apiRequest('/api/admin/upload-cookies', {
                    method: 'POST',
                    body: formData
                });
                alert(res.message || 'Cookies file successfully deployed to yt-dlp!');
                cookieFileInput.value = '';
            } catch (err) {
                alert(`Cookie upload error: ${err.message}`);
            } finally {
                btnApplyCookies.disabled = false;
                btnApplyCookies.textContent = 'Apply';
            }
        });
    }

    // Proxy Toggle Switch
    if (proxyToggle) {
        proxyToggle.addEventListener('change', async () => {
            try {
                await apiRequest('/api/admin/toggle-proxy', {
                    method: 'POST',
                    body: JSON.stringify({ enabled: proxyToggle.checked })
                });
            } catch (err) {
                proxyToggle.checked = !proxyToggle.checked; // Rollback state on error
                alert(`Failed to update proxy status: ${err.message}`);
            }
        });
    }

    // --- 6. Ad Engine Settings Persistence ---
    if (adSaveBtn) {
        adSaveBtn.addEventListener('click', async () => {
            const originalText = adSaveBtn.textContent;
            adSaveBtn.disabled = true;
            adSaveBtn.textContent = 'Saving...';

            const payload = {
                timerDuration: parseInt(adTimerRange ? adTimerRange.value : 10, 10),
                preDownloadModal: adCheckboxes[0] ? adCheckboxes[0].checked : true,
                headerBanner: adCheckboxes[1] ? adCheckboxes[1].checked : true
            };

            try {
                await apiRequest('/api/admin/ad-settings', {
                    method: 'POST',
                    body: JSON.stringify(payload)
                });
                alert('Ad settings updated successfully!');
            } catch (err) {
                alert(`Failed to save ad settings: ${err.message}`);
            } finally {
                adSaveBtn.disabled = false;
                adSaveBtn.textContent = originalText;
            }
        });
    }

    // Live Range Slider Visual Update
    if (adTimerRange && adTimerValue) {
        adTimerRange.addEventListener('input', (e) => {
            adTimerValue.textContent = `${e.target.value} Seconds`;
        });
    }

    // --- 7. System Logs Rendering & Filtering ---
    async function loadLogs() {
        if (!logsTbody) return;

        try {
            const logs = await apiRequest('/api/admin/logs');
            if (!Array.isArray(logs)) return;

            localLogsCache = logs;
            renderLogs(localLogsCache);
        } catch (err) {
            logsTbody.innerHTML = `
                <tr>
                    <td colspan="5" class="px-4 py-4 text-center text-red-400 font-sans">
                        Failed to fetch system diagnostic logs.
                    </td>
                </tr>
            `;
        }
    }

    function renderLogs(logsList) {
        if (!logsTbody) return;

        if (logsList.length === 0) {
            logsTbody.innerHTML = `
                <tr>
                    <td colspan="5" class="px-4 py-4 text-center text-slate-500 font-sans">
                        No extraction failures recorded.
                    </td>
                </tr>
            `;
            return;
        }

        logsTbody.innerHTML = logsList.map(log => {
            const platformBadgeColor = getPlatformBadgeClass(log.platform);
            const statusColorClass = log.statusCode >= 400 ? 'text-red-400' : 'text-emerald-400';

            return `
                <tr class="hover:bg-slate-800/30 transition-colors">
                    <td class="px-4 py-3 whitespace-nowrap text-slate-500">${log.timestamp || 'N/A'}</td>
                    <td class="px-4 py-3 text-slate-300 max-w-xs truncate" title="${log.targetUrl}">${log.targetUrl}</td>
                    <td class="px-4 py-3">
                        <span class="px-2 py-0.5 rounded text-[10px] font-sans font-bold ${platformBadgeColor}">
                            ${log.platform}
                        </span>
                    </td>
                    <td class="px-4 py-3 ${statusColorClass}">${log.statusCode}</td>
                    <td class="px-4 py-3 text-slate-400">${log.message}</td>
                </tr>
            `;
        }).join('');
    }

    function getPlatformBadgeClass(platform = '') {
        const lower = platform.toLowerCase();
        if (lower.includes('youtube')) return 'bg-red-500/10 text-red-400 border border-red-500/20';
        if (lower.includes('instagram')) return 'bg-pink-500/10 text-pink-400 border border-pink-500/20';
        if (lower.includes('tiktok')) return 'bg-slate-700 text-slate-200';
        return 'bg-brand-500/10 text-brand-400 border border-brand-500/20';
    }

    // Client-side Filter Input
    if (logFilterInput) {
        logFilterInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            const filtered = localLogsCache.filter(log => 
                (log.targetUrl && log.targetUrl.toLowerCase().includes(query)) ||
                (log.platform && log.platform.toLowerCase().includes(query)) ||
                (log.message && log.message.toLowerCase().includes(query))
            );
            renderLogs(filtered);
        });
    }

    // Clear Logs Action
    if (btnClearLogs) {
        btnClearLogs.addEventListener('click', async () => {
            if (!confirm('Are you sure you want to clear all error diagnostic logs?')) return;

            try {
                await apiRequest('/api/admin/clear-logs', { method: 'DELETE' });
                localLogsCache = [];
                renderLogs([]);
            } catch (err) {
                alert(`Could not clear logs: ${err.message}`);
            }
        });
    }

    // --- 8. Session Termination ---
    if (btnLogout) {
        btnLogout.addEventListener('click', () => {
            localStorage.removeItem('admin_token');
            window.location.href = '/login.html';
        });
    }

    // --- 9. Initialization & Automatic Refresh ---
    loadStats();
    loadLogs();

    // Poll stats every 10 seconds, logs every 30 seconds
    setInterval(loadStats, 10000);
    setInterval(loadLogs, 30000);
});