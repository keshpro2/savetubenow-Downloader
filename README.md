# SaveTubeNow 🚀

SaveTubeNow is a high-performance, full-stack video and audio downloader web application. It allows users to query video URLs, browse available media streams via a categorized tabbed interface, and download assets directly with a custom **0% to 100% real-time streaming progress overlay**.

The platform is designed with memory efficiency in mind, leveraging modern JavaScript **Streams API** to pipe file data directly from the backend utility to the client browser without overloading server disk space.

---

## 🌟 Key Features

* **Categorized Format Switching:** Modern tabbed interface separating 📺 **Video Formats (MP4)** and 🎵 **Audio Formats (MP3)** dynamically based on server availability profiles.
* **Real-Time Progress Tracking:** Custom floating hover box that tracks the exact chunk-by-chunk download percentage using a frontend stream reader.
* **Smart Query Suggestions:** Debounced autocomplete search input field that predicts user search terms using a low-latency suggestion API.
* **Dual-Layer Caching:** Implements internal frontend Map structures to cache media search results and format lookups, eliminating redundant API round-trips.
* **Responsive Dark/Light UI:** Modern UI framework equipped with dynamic cards layout grid and global CSS variables variable theme switcher toggles.

---

## 🏗️ Technology Stack

* **Frontend:** Vanilla HTML5, CSS3 (Custom Variables, Flexbox/Grid layouts), JavaScript (ES6+, Fetch Streams API)
* **Backend:** Node.js, Express.js framework
* **Core Parser Engine:** `youtube-dl-exec` (utilizing standalone compiled binaries of `yt-dlp`)

---

## 📁 Project Architecture

```text
SaveTubeNow/
├── backend/
│   ├── controllers/
│   │   └── videoController.js   # Media parsing & download streaming pipeline
│   └── routes/
│       └── video.js             # API route handlers (/api/search, /api/info, /api/download)
├── frontend/                     # Static client files root
│   ├── index.html               # Layout canvas template
│   ├── main.js                  # Frontend interface control & Stream handling
│   └── style.css                # Adaptive layout styles & progress overlay mechanics
├── package.json                 # Project dependencies configuration
└── server.js                    # Core Express server bootstrap initialization