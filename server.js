const express = require('express');
const path = require('path');
const { spawn } = require('child_process');
const helmet = require('helmet');
const cors = require('cors');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const NodeCache = require('node-cache'); // High-speed in-memory caching engine

const app = express();
const PORT = process.env.PORT || 3000;

// Dynamic execution engine routing (Render Linux vs Local Windows Development)
const localBinPath = path.join(__dirname, 'bin', 'yt-dlp');
const ytDlpBinary = fs.existsSync(localBinPath) ? localBinPath : 'yt-dlp';

// Setup optimized cache instances with safety expiration thresholds (TTL)
const searchCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });    // Cache searches for 10 minutes
const infoCache = new NodeCache({ stdTTL: 900, checkperiod: 180 });      // Cache format data for 15 minutes (links eventually expire)
const suggestCache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });  // Cache autocomplete strings for 1 hour

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function isValidUrl(string) {
    try {
        const url = new URL(string);
        const allowedDomains = ['youtube.com', 'youtu.be', 'facebook.com', 'instagram.com', 'tiktok.com', 'twitter.com', 'x.com'];
        return allowedDomains.some(domain => url.hostname.includes(domain));
    } catch (_) {
        return false;
    }
}

// 1. LIGHTNING FAST INITIAL QUERY (WITH CACHE LOOKUP)
app.post('/api/search', (req, res) => {
    let { url } = req.body;
    if (!url || url.trim() === "") {
        return res.status(400).json({ error: 'Please enter a link or search keywords.' });
    }
    

    url = url.trim();

    if (isValidUrl(url)) {
        return res.json({ isDirectLink: true, url: url });
    }

    const sanitizedQuery = url.replace(/[;&|`$\n\r<>]/g, '');
    const cacheKey = `search_${sanitizedQuery.toLowerCase()}`;

    // Memory cache hit check
    const cachedSearch = searchCache.get(cacheKey);
    if (cachedSearch) {
        return res.json(cachedSearch); // Sub-millisecond response time
    }
    
 // CHANGE THIS LINE:
const searchProcess = spawn(ytDlpBinary, [
    '--flat-playlist',
    '--dump-json',
    `ytsearch5:\"${sanitizedQuery}\"`
], { shell: true });

    let stdoutData = '';
    searchProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });

    searchProcess.on('close', (code) => {
        try {
            const lines = stdoutData.trim().split('\n').filter(line => line.trim() !== '');
            const results = lines.map(line => {
                const parsed = JSON.parse(line);
                return {
                    title: parsed.title,
                    id: parsed.id,
                    url: parsed.url || `https://www.youtube.com/watch?v=${parsed.id}`,
                    duration: parsed.duration ? new Date(parsed.duration * 1000).toISOString().substr(11, 8).replace(/^00:/, '') : 'Live/Unknown',
                    thumbnail: parsed.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${parsed.id}/mqdefault.jpg`
                };
            });

            const finalResponse = { isDirectLink: false, results: results };
            
            // Save payload to memory before returning response
            searchCache.set(cacheKey, finalResponse);
            res.json(finalResponse);
        } catch (err) {
            res.status(500).json({ error: 'Failed to complete search query layout.' });
        }
    });
});


// 2. FETCH DETAILED FORMAT OPTIONS (WITH STREAM TOKEN CACHE INTERCEPTION)
app.post('/api/info', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL target parameter missing' });

    const targetUrl = url.trim();
    const cacheKey = `info_${crypto.createHash('md5').update(targetUrl).digest('hex')}`;

    // Memory cache hit check 
    const cachedInfo = infoCache.get(cacheKey);
    if (cachedInfo) {
        return res.json(cachedInfo); // Skips yt-dlp binary extraction entirely
    }

    const ytDlpArgs = [
        '--dump-json', 
        '--no-playlist', 
        '--no-check-certificate',
        '--user-agent', '\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36\"'
    ];

    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', `\"${localCookiesPath}\"`);
    }

    ytDlpArgs.push(`\"${targetUrl}\"`); 

    // CHANGE THIS LINE:
const ytDlp = spawn(ytDlpBinary, ytDlpArgs, { shell: true });
    let stdoutData = '';
    let stderrData = '';

    ytDlp.stdout.on('data', (data) => { stdoutData += data.toString(); });
    ytDlp.stderr.on('data', (data) => { stderrData += data.toString(); });

    ytDlp.on('close', (code) => {
        if (code !== 0) {
            console.error("Platform Scraper Error Output:\n", stderrData);
            return res.status(500).json({ error: 'Could not extract media assets from this platform link.' });
        }

        try {
            let parsedData = null;
            const lines = stdoutData.trim().split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('{')) {
                    try {
                        parsedData = JSON.parse(line);
                        break;
                    } catch (e) {}
                }
            }

            if (!parsedData) {
                return res.status(500).json({ error: 'No valid data structure found in platform reply.' });
            }

            const cleanFormats = [];

            // Always provide a definitive Video option at the top of the list
            cleanFormats.push({
                formatId: 'best',
                ext: 'mp4',
                resolution: 'Best Available Video Quality (MP4)',
                filesize: 'Variable Size',
                isAudio: false
            });

            // Always provide a definitive Audio option second
            cleanFormats.push({
                formatId: 'bestaudio',
                ext: 'mp3',
                resolution: 'Extract Audio Only (High Quality MP3)',
                filesize: 'Approx. 5-12 MB',
                isAudio: true
            });

            // Process any additional specific sub-formats returned by the platform
            if (parsedData.formats && Array.isArray(parsedData.formats)) {
                parsedData.formats.forEach(f => {
                    if (!f) return;
                    
                    const isAudioOnly = f.vcodec === 'none' && f.acodec !== 'none';
                    if (isAudioOnly) return; 

                    let resolutionLabel = 'Standard Resolution';
                    if (f.resolution) {
                        resolutionLabel = f.resolution;
                    } else if (f.width && f.height) {
                        resolutionLabel = `${f.width}x${f.height}`;
                    } else if (f.format_note) {
                        resolutionLabel = f.format_note;
                    }

                    let calculatedSize = 'Variable Size';
                    if (f.filesize) {
                        calculatedSize = `${(f.filesize / (1024 * 1024)).toFixed(1)} MB`;
                    } else if (f.filesize_approx) {
                        calculatedSize = `${(f.filesize_approx / (1024 * 1024)).toFixed(1)} MB (Est.)`;
                    }

                    cleanFormats.push({
                        formatId: f.format_id || 'best',
                        ext: f.ext || 'mp4',
                        resolution: `Video Quality (${resolutionLabel})`,
                        filesize: calculatedSize,
                        isAudio: false
                    });
                });
            }

            let durationLabel = 'Short Content/Reel';
            if (parsedData.duration && !isNaN(parsedData.duration)) {
                try {
                    durationLabel = new Date(parsedData.duration * 1000).toISOString().substr(11, 8).replace(/^00:/, '');
                } catch (_) {}
            }

            const payloadResult = {
                title: parsedData.title || 'Social Media Video',
                thumbnail: parsedData.thumbnail || 'https://via.placeholder.com/240x135?text=Video+Loaded',
                duration: durationLabel,
                url: targetUrl,
                formats: cleanFormats.slice(0, 25)
            };

            // Keep configuration payload saved in cache
            infoCache.set(cacheKey, payloadResult);
            res.json(payloadResult);
        } catch (e) {
            console.error("JSON Error Mapping:", e);
            res.status(500).json({ error: 'Error processing format payload definitions.' });
        }
    });
});

// 3. STITCHING AND CONVERSION DOWNLOAD PATHWAY
app.get('/api/download', (req, res) => {
    let { url, formatId, title, isAudio } = req.query;
    url = url.trim().replace(/[;&|`$\n\r<>]/g, '');
    const cleanTitle = (title || 'download').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const uniqueId = crypto.randomBytes(4).toString('hex');
    const ext = isAudio === 'true' ? 'mp3' : 'mp4';
    
    const tempFilePath = path.join(os.tmpdir(), `savetube_${uniqueId}.${ext}`);
    let ytDlpArgs = [];

    if (isAudio === 'true') {
        ytDlpArgs = ['-f', 'bestaudio', '-x', '--audio-format', 'mp3', '-o', tempFilePath, '--no-playlist'];
    } else {
        const formatSelection = formatId === 'best' ? 'bestvideo+bestaudio/best' : `${formatId}+bestaudio/best`;
        ytDlpArgs = ['-f', formatSelection, '--merge-output-format', 'mp4', '-o', tempFilePath, '--no-playlist'];
    }

    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', `\"${localCookiesPath}\"`);
    }

    ytDlpArgs.push(`\"${url}\"`);

    // CHANGE THIS LINE:
const downloadProcess = spawn(ytDlpBinary, ytDlpArgs, { shell: true });

    downloadProcess.on('close', (code) => {
        if (code !== 0) return res.status(500).send('Download stream failed.');
        res.download(tempFilePath, `${cleanTitle}.${ext}`, () => {
            fs.unlink(tempFilePath, () => {});
        });
    });
});

// 4. LIVE SEARCH SUGGESTIONS PROXY (OPTIMIZED AUTOCOMPLETE ALGORITHM WITH DEBOUNCE PROTECTION)
app.get('/api/suggestions', async (req, res) => {
    const query = req.query.q;
    if (!query || query.trim() === "") {
        return res.json([]);
    }

    const cleanQuery = query.trim().toLowerCase();
    const cacheKey = `suggest_${cleanQuery}`;

    // Intercept with an immediate check on long-duration query cache
    const cachedSuggestions = suggestCache.get(cacheKey);
    if (cachedSuggestions) {
        return res.json(cachedSuggestions);
    }

    try {
        const targetUrl = `https://suggestqueries.google.com/complete/search?client=firefox&ds=yt&q=${encodeURIComponent(cleanQuery)}`;
        const response = await fetch(targetUrl);
        const data = await response.json();
        
        const suggestions = data[1] || [];
        
        // Save to suggestions cache pool
        suggestCache.set(cacheKey, suggestions);
        res.json(suggestions);
    } catch (error) {
        console.error("Autocomplete Engine Error:", error);
        res.json([]); 
    }
});

app.listen(PORT, () => { console.log(`SaveTubeNow running on port ${PORT}`); });