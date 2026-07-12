document.addEventListener('DOMContentLoaded', () => {
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

    // FRONTEND CACHE POOLS
    const localSearchCache = new Map();
    const localInfoCache = new Map();

    // DYNAMIC PROGRESS HOVER BOX INJECTION
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

    // DYNAMIC SUGGESTION BOX INJECTION
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

    let debounceTimer;

    themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        document.documentElement.setAttribute('data-theme', currentTheme === 'dark' ? 'light' : 'dark');
    });

    if (urlInput && suggestionsBox) {
        urlInput.addEventListener('input', () => {
            clearTimeout(debounceTimer);
            const query = urlInput.value.trim();

            if (query.length < 2) {
                suggestionsBox.innerHTML = '';
                return;
            }

            debounceTimer = setTimeout(async () => {
                try {
                    const response = await fetch(`/api/suggestions?q=${encodeURIComponent(query)}`);
                    if (!response.ok) return;
                    const suggestions = await response.json();
                    
                    suggestionsBox.innerHTML = '';
                    if (suggestions.length === 0) return;

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
                    console.error('Autocomplete retrieval failure:', err);
                }
            }, 250);
        });

        document.addEventListener('click', (e) => {
            if (e.target !== urlInput && e.target !== suggestionsBox) {
                suggestionsBox.innerHTML = '';
            }
        });
    }

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const targetQuery = urlInput.value.trim();
        
        if (suggestionsBox) suggestionsBox.innerHTML = ''; 
        hideError();
        showLoading();
        downloadView.classList.add('hidden');
        searchResultsView.classList.add('hidden');

        if (localSearchCache.has(targetQuery.toLowerCase())) {
            const cachedData = localSearchCache.get(targetQuery.toLowerCase());
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

            if (!response.ok) throw new Error(data.error || 'Processing error.');

            localSearchCache.set(targetQuery.toLowerCase(), data);

            if (data.isDirectLink) {
                fetchVideoFormats(data.url);
            } else {
                renderSearchResults(data.results);
                hideLoading();
            }
        } catch (err) {
            showError(err.message);
            hideLoading();
        }
    });

    function renderSearchResults(results) {
        searchResultsGrid.innerHTML = '';
        if (results.length === 0) {
            showError("No matches found for that query.");
            return;
        }

        results.forEach(video => {
            const card = document.createElement('div');
            card.className = 'video-square-card';
            const channelAvatarUrl = video.channelAvatar || `https://api.dicebear.com/7.x/initials/svg?seed=${encodeURIComponent(video.author || 'Video')}`;

            card.innerHTML = `
                <div class="card-thumb-wrap">
                    <img src="${video.thumbnail}" alt="Video Thumbnail" class="card-video-img">
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

            card.querySelector('.btn-card-action').addEventListener('click', (e) => {
                e.stopPropagation(); 
                initiateFormatFetch(video.url);
            });
            card.addEventListener('click', () => {
                initiateFormatFetch(video.url);
            });

            searchResultsGrid.appendChild(card);
        });
        searchResultsView.classList.remove('hidden');
    }

    function initiateFormatFetch(url) {
        showLoading();
        searchResultsView.classList.add('hidden');
        fetchVideoFormats(url);
    }

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
            if (!response.ok) throw new Error(data.error);

            localInfoCache.set(targetUrl, data);
            renderVideoMetadata(data);
        } catch (err) {
            showError(err.message);
        } finally {
            hideLoading();
        }
    }

    // UPGRADED: RENDERS MEDIA META WITH VIDEO/AUDIO NAVIGATION CHIPS
    function renderVideoMetadata(data) {
        metaThumb.src = data.thumbnail || 'https://via.placeholder.com/240x135?text=No+Image';
        metaTitle.textContent = data.title;
        metaDuration.textContent = data.duration;
        
        // Setup dynamic switch tabs inside table header area container dynamically
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
            const filtered = data.formats.filter(f => f.isAudio === showAudioType);

            if (filtered.length === 0) {
                formatTableBody.innerHTML = `<tr><td colspan="3" style="text-align:center; padding: 20px;">No compatible streams detected for this category.</td></tr>`;
                return;
            }

            filtered.forEach(format => {
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td><span class="badge">${format.isAudio ? '🎵 AUDIO' : '📺 VIDEO'}</span> <strong>${format.ext.toUpperCase()}</strong> - ${format.resolution}</td>
                    <td>${format.filesize}</td>
                    <td><button class="btn-download" data-id="${format.formatId}" data-audio="${format.isAudio}" data-title="${encodeURIComponent(data.title)}" data-url="${encodeURIComponent(data.url)}" data-ext="${format.ext}">Download</button></td>
                `;
                formatTableBody.appendChild(row);
            });

            // ATTACH REAL-TIME PROGRESS STREAM TRACKER TO NEWLY RENDERED BUTTONS
            document.querySelectorAll('.btn-download').forEach(button => {
                button.addEventListener('click', (e) => {
                    handleStreamedDownload(e.target);
                });
            });
        };

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

        // Initialize display list presenting regular MP4 choices first
        filterAndRenderTable(false);
        downloadView.classList.remove('hidden');
    }

    // NEW ENGINE: STREAM DOWNLOAD HANDLER WITH REAL-TIME HOVER PERCENTAGE CALCULATOR
    async function handleStreamedDownload(buttonElement) {
        const targetUrl = decodeURIComponent(buttonElement.getAttribute('data-url'));
        const formatId = buttonElement.getAttribute('data-id');
        const fileTitle = decodeURIComponent(buttonElement.getAttribute('data-title'));
        const isAudio = buttonElement.getAttribute('data-audio');
        const fileExtension = buttonElement.getAttribute('data-ext') || 'mp4';

        const statusText = document.getElementById('progress-status-text');
        const barFill = document.getElementById('progress-bar-fill');
        const percentText = document.getElementById('progress-percentage');

        // Reset and display overlay panel view
        statusText.textContent = "Server is converting media assets...";
        barFill.style.width = '0%';
        percentText.textContent = '0%';
        progressOverlay.classList.remove('hidden');

        try {
            const queryPath = `/api/download?url=${encodeURIComponent(targetUrl)}&formatId=${formatId}&title=${encodeURIComponent(fileTitle)}&isAudio=${isAudio}`;
            const response = await fetch(queryPath);

            if (!response.ok) throw new Error("Download stream rejected from host infrastructure.");

            statusText.textContent = "Downloading asset pipeline...";
            
            const reader = response.body.getReader();
            const totalBytes = parseInt(response.headers.get('content-length'), 10);
            
            let receivedBytes = 0;
            const chunksArray = [];

            while (true) {
                const { done, value } = await reader.read();
                
                if (done) break;

                chunksArray.push(value);
                receivedBytes += value.length;

                if (totalBytes) {
                    const currentPercentage = Math.round((receivedBytes / totalBytes) * 100);
                    barFill.style.width = `${currentPercentage}%`;
                    percentText.textContent = `${currentPercentage}%`;
                } else {
                    // Fallback animation string if remote engine strips out length dimensions profiles
                    statusText.textContent = `Streaming chunk data: ${(receivedBytes / (1024 * 1024)).toFixed(1)} MB parsed...`;
                }
            }

            statusText.textContent = "Saving download file...";
            barFill.style.width = '100%';
            percentText.textContent = '100%';

            // Compile complete byte array into local file link
            const blobObj = new Blob(chunksArray, { type: response.headers.get('content-type') });
            const localDownloadUrl = URL.createObjectURL(blobObj);
            
            const anchorLink = document.createElement('a');
            anchorLink.href = localDownloadUrl;
            
            const cleanTitle = fileTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            anchorLink.download = `${cleanTitle}.${fileExtension}`;
            
            document.body.appendChild(anchorLink);
            anchorLink.click();
            
            // Cleanup application instances
            document.body.removeChild(anchorLink);
            URL.revokeObjectURL(localDownloadUrl);

            // Close layout view on completion delay
            setTimeout(() => {
                progressOverlay.classList.add('hidden');
            }, 1000);

        } catch (error) {
            console.error(error);
            alert("Streaming conversion failed or timed out during server file transfer.");
            progressOverlay.classList.add('hidden');
        }
    }

    function showError(msg) { errorBox.textContent = msg; errorBox.classList.remove('hidden'); }
    function hideError() { errorBox.classList.add('hidden'); }
    function showLoading() { loadingSpinner.classList.remove('hidden'); }
    function hideLoading() { loadingSpinner.classList.add('hidden'); }
});