document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Elements ---
    const form = document.getElementById('downloader-form');
    const urlInput = document.getElementById('video-url');
    const errorBox = document.getElementById('error-message');
    const loadingSpinner = document.getElementById('loading-spinner');
    const downloadView = document.getElementById('download-view');
    const searchResultsView = document.getElementById('search-results-view');
    const searchResultsGrid = document.getElementById('search-results-grid');

    const metaThumb = document.getElementById('meta-thumb');
    const metaTitle = document.getElementById('meta-title');
    const metaDuration = document.getElementById('meta-duration');
    const formatTableBody = document.getElementById('format-table-body');
    const themeToggle = document.getElementById('theme-toggle');

    // Ad Modal Interstitial Elements
    const rewardModal = document.getElementById('reward-modal');
    const adVideoAsset = document.getElementById('adVideoAsset');
    const countdownTimer = document.getElementById('countdown-timer');
    const skipAdBtn = document.getElementById('skipAdBtn');
    const adProgressBarFill = rewardModal ? rewardModal.querySelector('#progress-bar-fill') : null;

    // --- State & Frontend Caching ---
    const localSearchCache = new Map();
    const localInfoCache = new Map();

    let pendingDownloadTarget = null;
    let adCountdownTicker = null;
    let debounceTimer = null;
    let suggestionAbortController = null;

    // --- Theme Initialization & Persistence ---
    if (themeToggle) {
        const savedTheme = localStorage.getItem('theme') || 'dark';
        document.documentElement.setAttribute('data-theme', savedTheme);

        themeToggle.addEventListener('click', () => {
            const currentTheme = document.documentElement.getAttribute('data-theme');
            const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', nextTheme);
            localStorage.setItem('theme', nextTheme);
        });
    }

    // --- Dynamic Progress Overlay Injection ---
    let progressOverlay = document.getElementById('download-progress-overlay');
    if (!progressOverlay) {
        progressOverlay = document.createElement('div');
        progressOverlay.id = 'download-progress-overlay';
        progressOverlay.className = 'progress-overlay hidden';
        progressOverlay.innerHTML = `
            <div class="progress-card">
                <h4 id="progress-status-text">Processing server streams...</h4>
                <div class="progress-bar-container">
                    <div id="progress-bar-fill" class="progress-bar-fill"></div>
                </div>
                <span id="progress-percentage">0%</span>
            </div>
        `;
        document.body.appendChild(progressOverlay);
    }

    // --- Dynamic Suggestion Box Injection ---
    let suggestionsBox = document.getElementById('suggestionsBox');
    if (!suggestionsBox && urlInput) {
        suggestionsBox = document.createElement('div');
        suggestionsBox.id = 'suggestionsBox';
        suggestionsBox.className = 'suggestions-dropdown';
        if (urlInput.parentNode) {
            urlInput.parentNode.style.position = 'relative';
            urlInput.parentNode.appendChild(suggestionsBox);
        }
    }

    // --- Autocomplete Input Handler ---
    if (urlInput && suggestionsBox) {
        urlInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            if (suggestionAbortController) {
                suggestionAbortController.abort();
            }

            const query = urlInput.value.trim();
            if (query.length < 2) {
                suggestionsBox.innerHTML = '';
                return;
            }

            debounceTimer = setTimeout(async () => {
                suggestionAbortController = new AbortController();
                try {
                    const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`, {
                        signal: suggestionAbortController.signal
                    });
                    if (!response.ok) return;
                    const suggestions = await response.json();

                    suggestionsBox.innerHTML = '';
                    if (!Array.isArray(suggestions) || suggestions.length === 0) return;

                    suggestions.forEach(keyword => {
                        const row = document.createElement('div');
                        row.classList.add('suggestion-item');
                        row.textContent = keyword;

                        row.addEventListener('click', () => {
                            urlInput.value = keyword;
                            suggestionsBox.innerHTML = '';
                            if (form) {
                                if (typeof form.requestSubmit === 'function') {
                                    form.requestSubmit();
                                } else {
                                    form.dispatchEvent(new Event('submit', { cancelable: true }));
                                }
                            }
                        });
                        suggestionsBox.appendChild(row);
                    });
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('Autocomplete retrieval failure:', err);
                    }
                }
            }, 250);
        });

        document.addEventListener('click', (e) => {
            if (e.target !== urlInput && e.target !== suggestionsBox) {
                suggestionsBox.innerHTML = '';
            }
        });
    }

    // --- Form Submit Handler ---
    if (form) {
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const targetQuery = urlInput.value.trim();

            if (!targetQuery) return;

            if (suggestionsBox) suggestionsBox.innerHTML = '';
            hideError();
            showLoading();
            if (downloadView) downloadView.classList.add('hidden');
            if (searchResultsView) searchResultsView.classList.add('hidden');

            const cacheKey = targetQuery.toLowerCase();
            if (localSearchCache.has(cacheKey)) {
                const cachedData = localSearchCache.get(cacheKey);
                if (cachedData.isDirectLink) {
                    fetchVideoFormats(cachedData.url);
                } else {
                    renderSearchResults(cachedData.results);
                    hideLoading();
                }
                return;
            }

            try {
                const response = await fetch('/api/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: targetQuery })
                });
                const data = await response.json();

                if (!response.ok) throw new Error(data.error || 'Processing error occurred.');

                localSearchCache.set(cacheKey, data);

                if (data.isDirectLink) {
                    fetchVideoFormats(data.url);
                } else {
                    renderSearchResults(data.results || []);
                    hideLoading();
                }
            } catch (err) {
                showError(err.message);
                hideLoading();
            }
        });
    }

    // --- Render Search Results ---
    function renderSearchResults(results) {
        if (!searchResultsGrid || !searchResultsView) return;
        searchResultsGrid.innerHTML = '';

        if (!results || results.length === 0) {
            showError("No matches found for that query.");
            return;
        }

        results.forEach(video => {
            const card = document.createElement('div');
            card.className = 'video-square-card';
            const channelAvatarUrl = video.channelAvatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(video.author || 'Video')}`;

            card.innerHTML = `
                <div class="card-thumb-wrap">
                    <img src="${video.thumbnail}" alt="Video Thumbnail" class="card-video-img" loading="lazy">
                    <span class="card-duration-badge">${video.duration || '00:00'}</span>
                </div>
                <div class="card-body-content">
                    <img src="${channelAvatarUrl}" alt="Creator Profile" class="card-channel-img">
                    <div class="card-text-details">
                        <h4 class="card-video-title" title="${video.title}">${video.title}</h4>
                        <p class="card-video-author">${video.author || 'Verified Creator'}</p>
                    </div>
                </div>
                <button class="btn-card-action" type="button">Download Video</button>
            `;

            const actionBtn = card.querySelector('.btn-card-action');
            if (actionBtn) {
                actionBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    initiateFormatFetch(video.url);
                });
            }

            card.addEventListener('click', () => {
                initiateFormatFetch(video.url);
            });

            searchResultsGrid.appendChild(card);
        });
        searchResultsView.classList.remove('hidden');
    }

    function initiateFormatFetch(url) {
        showLoading();
        if (searchResultsView) searchResultsView.classList.add('hidden');
        fetchVideoFormats(url);
    }

    // --- Fetch & Render Video Formats ---
    async function fetchVideoFormats(url) {
        const targetUrl = url.trim();

        if (localInfoCache.has(targetUrl)) {
            renderVideoMetadata(localInfoCache.get(targetUrl));
            hideLoading();
            return;
        }

        try {
            const response = await fetch('/api/info', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: targetUrl })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Failed to fetch video information.');

            localInfoCache.set(targetUrl, data);
            renderVideoMetadata(data);
        } catch (err) {
            showError(err.message);
        } finally {
            hideLoading();
        }
    }

    function renderVideoMetadata(data) {
        if (metaThumb) metaThumb.src = data.thumbnail || 'https://via.placeholder.com/240x135?text=No+Image';
        if (metaTitle) metaTitle.textContent = data.title;
        if (metaDuration) metaDuration.textContent = data.duration;

        if (!formatTableBody) return;

        let formatTabWrapper = document.getElementById('format-tab-type-switcher');
        if (!formatTabWrapper) {
            formatTabWrapper = document.createElement('div');
            formatTabWrapper.id = 'format-tab-type-switcher';
            formatTabWrapper.className = 'format-tab-container';
            formatTableBody.parentNode.insertBefore(formatTabWrapper, formatTableBody);
        }

        formatTabWrapper.innerHTML = `
            <button type="button" class="tab-toggle-btn active" id="tab-show-video">📺 Video Formats (MP4)</button>
            <button type="button" class="tab-toggle-btn" id="tab-show-audio">🎵 Audio Formats (MP3)</button>
        `;

        const videoBtn = document.getElementById('tab-show-video');
        const audioBtn = document.getElementById('tab-show-audio');

        const filterAndRenderTable = (showAudioType) => {
            formatTableBody.innerHTML = '';
            const filtered = (data.formats || []).filter(f => Boolean(f.isAudio) === showAudioType);

            if (filtered.length === 0) {
                formatTableBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding: 20px;">No compatible streams detected for this category.</td></tr>`;
                return;
            }

            filtered.forEach(format => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><span class="badge">${format.isAudio ? '🎵 AUDIO' : '📺 VIDEO'}</span> <strong>${(format.ext || 'MP4').toUpperCase()}</strong> - ${format.resolution || 'N/A'}</td>
                    <td>${format.filesize || 'Unknown'}</td>
                    <td><button class="btn-download" data-id="${format.formatId}" data-audio="${format.isAudio}" data-title="${encodeURIComponent(data.title)}" data-url="${encodeURIComponent(data.url)}" data-ext="${format.ext || 'mp4'}">Download</button></td>
                `;
                formatTableBody.appendChild(row);
            });

            document.querySelectorAll('.btn-download').forEach(button => {
                button.addEventListener('click', (e) => {
                    initiateAdInterstitial(e.target);
                });
            });
        };

        if (videoBtn && audioBtn) {
            videoBtn.addEventListener('click', () => {
                videoBtn.classList.add('active');
                audioBtn.classList.remove('active');
                filterAndRenderTable(false);
            });

            audioBtn.addEventListener('click', () => {
                audioBtn.classList.add('active');
                videoBtn.classList.remove('active');
                filterAndRenderTable(true);
            });

            videoBtn.classList.add('active');
            audioBtn.classList.remove('active');
        }

        filterAndRenderTable(false);

        if (downloadView) downloadView.classList.remove('hidden');
    }

    // --- Ad Interstitial Modal Management ---
    function initiateAdInterstitial(buttonElement) {
        if (!rewardModal || !adVideoAsset || !skipAdBtn) {
            handleStreamedDownload(buttonElement);
            return;
        }

        pendingDownloadTarget = buttonElement;

        let timeLeft = 10;
        if (countdownTimer) countdownTimer.textContent = timeLeft;
        if (adProgressBarFill) adProgressBarFill.style.width = '0%';

        skipAdBtn.disabled = true;
        skipAdBtn.textContent = "Please Wait...";
        skipAdBtn.className = "btn-skip disabled";

        rewardModal.classList.remove('hidden');

        adVideoAsset.currentTime = 0;
        adVideoAsset.muted = false;
        adVideoAsset.play().catch(err => {
            console.warn("Autoplay restriction caught by browser policy:", err);
        });

        clearInterval(adCountdownTicker);
        adCountdownTicker = setInterval(() => {
            timeLeft--;
            if (countdownTimer) countdownTimer.textContent = timeLeft;

            if (adProgressBarFill) {
                const percentageRatio = ((10 - timeLeft) / 10) * 100;
                adProgressBarFill.style.width = `${Math.min(100, Math.max(0, percentageRatio))}%`;
            }

            if (timeLeft <= 0) {
                clearInterval(adCountdownTicker);
                skipAdBtn.disabled = false;
                skipAdBtn.textContent = "Get File Link";
                skipAdBtn.className = "btn-skip active-unlocked";
            }
        }, 1000);
    }

    if (skipAdBtn) {
        skipAdBtn.addEventListener('click', () => {
            clearInterval(adCountdownTicker);
            if (adVideoAsset) adVideoAsset.pause();
            if (rewardModal) rewardModal.classList.add('hidden');

            if (pendingDownloadTarget) {
                handleStreamedDownload(pendingDownloadTarget);
                pendingDownloadTarget = null;
            }
        });
    }

    // --- Streamed Download Handler ---
    async function handleStreamedDownload(buttonElement) {
        const targetUrl = decodeURIComponent(buttonElement.getAttribute('data-url'));
        const formatId = buttonElement.getAttribute('data-id');
        const fileTitle = decodeURIComponent(buttonElement.getAttribute('data-title'));
        const isAudio = buttonElement.getAttribute('data-audio');
        const fileExtension = buttonElement.getAttribute('data-ext') || 'mp4';

        const statusText = document.getElementById('progress-status-text');
        const streamBarFill = progressOverlay ? progressOverlay.querySelector('#progress-bar-fill') : null;
        const percentText = document.getElementById('progress-percentage');

        if (statusText) statusText.textContent = "Server is converting media assets...";
        if (streamBarFill) streamBarFill.style.width = '0%';
        if (percentText) percentText.textContent = '0%';
        if (progressOverlay) progressOverlay.classList.remove('hidden');

        try {
            const queryPath = `/api/download?url=${encodeURIComponent(targetUrl)}&formatId=${formatId}&title=${encodeURIComponent(fileTitle)}&isAudio=${isAudio}`;
            const response = await fetch(queryPath);

            if (!response.ok) throw new Error("Download stream rejected from host infrastructure.");

            if (statusText) statusText.textContent = "Downloading asset pipeline...";

            const reader = response.body.getReader();
            const contentLengthHeader = response.headers.get('content-length');
            const totalBytes = contentLengthHeader ? parseInt(contentLengthHeader, 10) : 0;

            let receivedBytes = 0;
            const chunksArray = [];

            while (true) {
                const { done, value } = await reader.read();

                if (done) break;

                chunksArray.push(value);
                receivedBytes += value.length;

                if (totalBytes > 0) {
                    const currentPercentage = Math.min(100, Math.round((receivedBytes / totalBytes) * 100));
                    if (streamBarFill) streamBarFill.style.width = `${currentPercentage}%`;
                    if (percentText) percentText.textContent = `${currentPercentage}%`;
                } else if (statusText) {
                    statusText.textContent = `Streaming chunk data: ${(receivedBytes / (1024 * 1024)).toFixed(1)} MB parsed...`;
                }
            }

            if (statusText) statusText.textContent = "Saving download file...";
            if (streamBarFill) streamBarFill.style.width = '100%';
            if (percentText) percentText.textContent = '100%';

            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            const blobObj = new Blob(chunksArray, { type: contentType });
            const localDownloadUrl = URL.createObjectURL(blobObj);

            const anchorLink = document.createElement('a');
            anchorLink.href = localDownloadUrl;

            const cleanTitle = fileTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            anchorLink.download = `${cleanTitle}.${fileExtension}`;

            document.body.appendChild(anchorLink);
            anchorLink.click();

            document.body.removeChild(anchorLink);
            URL.revokeObjectURL(localDownloadUrl);

        } catch (error) {
            console.error('Download stream error:', error);
            alert("Streaming conversion failed or timed out during server file transfer.");
        } finally {
            setTimeout(() => {
                if (progressOverlay) progressOverlay.classList.add('hidden');
            }, 1000);
        }
    }

    // --- Helper Utilities ---
    function showError(msg) {
        if (errorBox) {
            errorBox.textContent = msg;
            errorBox.classList.remove('hidden');
        }
    }

    function hideError() {
        if (errorBox) errorBox.classList.add('hidden');
    }

    function showLoading() {
        if (loadingSpinner) loadingSpinner.classList.remove('hidden');
    }

    function hideLoading() {
        if (loadingSpinner) loadingSpinner.classList.add('hidden');
    }
});