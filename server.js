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
        return res.json(cachedSearch); 
    }
    
    // REMOVED: escaped quotes and { shell: true }
    const searchProcess = spawn(ytDlpBinary, [
        '--flat-playlist',
        '--dump-json',
        `ytsearch5:${sanitizedQuery}`
    ]);

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
            searchCache.set(cacheKey, finalResponse);
            res.json(finalResponse);
        } catch (err) {
            res.status(500).json({ error: 'Failed to complete search query layout.' });
        }
    });
});


// 2. FETCH DETAILED FORMAT OPTIONS (WITH STREAM TOKEN CACHE INTERCEPTION)
// 2. FETCH DETAILED FORMAT OPTIONS (WITH STREAM TOKEN CACHE INTERCEPTION)
// 2. VIDEO INFO/FORMATS EXTRACTION PATHWAY
app.post('/api/info', (req, res) => {
    let { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL target is missing.' });

    url = url.trim().replace(/[;&|`$\n\r<>]/g, '');

    // Build arguments to dump JSON profiles
    let ytDlpArgs = [
        '--dump-json',
        '--no-playlist',
        '--extractor-args', 'youtube:player_client=default,-android_sdkless'
    ];

    // ✨ CRITICAL: Look for cookies on the server to bypass datacenter block
    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', localCookiesPath);
    }

    ytDlpArgs.push(url);

    const infoProcess = spawn(ytDlpBinary, ytDlpArgs);
    let stdoutData = '';
    let stderrData = '';

    infoProcess.stdout.on('data', (data) => { stdoutData += data; });
    infoProcess.stderr.on('data', (data) => { stderrData += data; });

    infoProcess.on('close', (code) => {
        if (code !== 0) {
            console.error('yt-dlp info error:', stderrData);
            
            // ✨ DIAGNOSTIC CHANGE: Return the REAL system error to your frontend screen
            return res.status(500).json({ 
                error: `System Error (${code}): ${stderrData.slice(0, 150)}...` 
            });
        }

        try {
            const parsedData = JSON.parse(stdoutData);
            
            // Your format mapping logic...
            const formattedResponse = {
                title: parsedData.title,
                thumbnail: parsedData.thumbnail,
                duration: parsedData.duration_string || '00:00',
                url: parsedData.webpage_url,
                formats: parsedData.formats.map(f => ({
                    formatId: f.format_id,
                    resolution: f.resolution || `${f.width || '?'}x${f.height || '?'}`,
                    ext: f.ext,
                    filesize: f.filesize ? `${(f.filesize / (1024 * 1024)).toFixed(1)} MB` : 'Unknown Size',
                    isAudio: !f.video_ext || f.video_ext === 'none'
                }))
            };

            res.json(formattedResponse);
        } catch (parseErr) {
            res.status(500).json({ error: 'Failed to process media configuration schema.' });
        }
    }); // <-- Make sure this closing parenthesis and brace match your app.post route!
});

// 3. STITCHING AND CONVERSION DOWNLOAD PATHWAY
// 3. STITCHING AND CONVERSION DOWNLOAD PATHWAY
// 3. STITCHING AND CONVERSION DOWNLOAD PATHWAY
app.get('/api/download', (req, res) => {
    let { url, formatId, title, isAudio } = req.query;
    url = url.trim().replace(/[;&|`$\n\r<>]/g, '');
    
    // 1. Clean the original video title (remove weird characters)
    const cleanTitle = (title || 'video').replace(/[^a-z0-9]/gi, '_').toLowerCase();
    
    // 2. Append your custom branding suffix to the filename
    const brandedFilename = `${cleanTitle}_from_savetubenow_downloader`;
    
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

    ytDlpArgs.push('--extractor-args', 'youtube:player_client=default,-android_sdkless');

    const localCookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(localCookiesPath)) {
        ytDlpArgs.push('--cookies', localCookiesPath);
    }

    ytDlpArgs.push(url);

    const downloadProcess = spawn(ytDlpBinary, ytDlpArgs);

    downloadProcess.on('close', (code) => {
        if (code !== 0) return res.status(500).send('Download stream failed.');
        
        // 3. Pass the branded filename here so the browser saves it correctly
        res.download(tempFilePath, `${brandedFilename}.${ext}`, () => {
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