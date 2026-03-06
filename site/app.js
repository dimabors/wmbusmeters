(function() {
    'use strict';

    // DOM elements
    const telegramEl = document.getElementById('telegram');
    const driverEl = document.getElementById('driver');
    const keyEl = document.getElementById('key');
    const formatEl = document.getElementById('format');
    const analyzeBtn = document.getElementById('analyze-btn');
    const btnText = analyzeBtn.querySelector('.btn-text');
    const btnLoading = analyzeBtn.querySelector('.btn-loading');
    const statusBar = document.getElementById('status-bar');
    const statusText = document.getElementById('status-text');
    const statusIcon = document.getElementById('status-icon');
    const resultsEl = document.getElementById('results');
    const outputEl = document.getElementById('output');
    const errorEl = document.getElementById('error');
    const errorOutputEl = document.getElementById('error-output');
    const copyBtn = document.getElementById('copy-btn');

    let wasmReady = false;
    let createModule = null;

    // Load driver list
    function loadDrivers() {
        fetch('drivers/drivers.json')
            .then(r => r.json())
            .then(drivers => {
                drivers.sort();
                drivers.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    driverEl.appendChild(opt);
                });
            })
            .catch(() => {
                // drivers.json not available, that's ok
            });
    }

    // Load WASM module
    function loadWasm() {
        const script = document.createElement('script');
        script.src = 'wmbusmeters.js';
        script.onload = function() {
            if (typeof createWmbusmeters === 'function') {
                createModule = createWmbusmeters;
                setStatus('ready', 'Engine ready');
                wasmReady = true;
                analyzeBtn.disabled = false;
            } else {
                setStatus('error', 'Failed to load engine: module function not found');
            }
        };
        script.onerror = function() {
            setStatus('error', 'Could not load WebAssembly engine. Analysis unavailable.');
        };
        document.head.appendChild(script);
    }

    function setStatus(state, text) {
        statusText.textContent = text;
        statusBar.className = 'status-bar ' + state;
        if (state === 'ready' || state === 'error') {
            statusIcon.style.display = 'none';
        } else {
            statusIcon.style.display = 'inline-block';
        }
    }

    // Strip ANSI escape codes for plain/JSON output
    function stripAnsi(str) {
        return str.replace(/\x1b\[[0-9;]*m/g, '');
    }

    // Convert ANSI escape codes to HTML spans
    function ansiToHtml(str) {
        const colorMap = {
            '31': 'ansi-red',
            '32': 'ansi-green',
            '33': 'ansi-yellow',
            '34': 'ansi-blue',
            '35': 'ansi-magenta',
            '36': 'ansi-cyan',
            '1': 'ansi-bold',
        };
        let html = '';
        let openTags = 0;
        const parts = str.split(/(\x1b\[[0-9;]*m)/);
        for (const part of parts) {
            const match = part.match(/^\x1b\[([0-9;]*)m$/);
            if (match) {
                const code = match[1];
                if (code === '0' || code === '') {
                    // Reset
                    while (openTags > 0) { html += '</span>'; openTags--; }
                } else {
                    const cls = colorMap[code];
                    if (cls) {
                        html += '<span class="' + cls + '">';
                        openTags++;
                    }
                }
            } else {
                html += escapeHtml(part);
            }
        }
        while (openTags > 0) { html += '</span>'; openTags--; }
        return html;
    }

    function escapeHtml(str) {
        return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    async function runAnalysis() {
        const telegram = telegramEl.value.trim().replace(/[\s\n\r]/g, '');
        if (!telegram) {
            showError('Please enter a telegram hex string.');
            return;
        }

        if (!/^[0-9a-fA-F_]+$/.test(telegram)) {
            showError('Invalid telegram: must contain only hex characters (0-9, a-f, A-F) and optional underscores.');
            return;
        }

        if (!wasmReady || !createModule) {
            showError('WebAssembly engine not loaded yet. Please wait or reload the page.');
            return;
        }

        const driver = driverEl.value;
        const key = keyEl.value.trim();
        const format = formatEl.value;

        if (key && !/^[0-9a-fA-F]{32}$/.test(key)) {
            showError('Invalid key: must be exactly 32 hex characters (AES-128).');
            return;
        }

        // Build --analyze argument
        let analyzeArg = '--analyze=';
        const parts = [format];
        if (driver) parts.push(driver);
        if (key) parts.push(key);
        analyzeArg += parts.join(':');

        // Show loading state
        analyzeBtn.disabled = true;
        btnText.hidden = true;
        btnLoading.hidden = false;
        resultsEl.hidden = true;
        errorEl.hidden = true;
        setStatus('loading', 'Analyzing telegram...');

        try {
            const stdout = [];
            const stderr = [];

            await createModule({
                arguments: [analyzeArg, telegram],
                print: function(text) { stdout.push(text); },
                printErr: function(text) { stderr.push(text); },
                noInitialRun: false,
            });

            const output = stdout.join('\n');
            const errors = stderr.join('\n');

            if (output) {
                if (format === 'terminal') {
                    outputEl.innerHTML = ansiToHtml(output);
                } else {
                    outputEl.textContent = stripAnsi(output);
                }
                resultsEl.hidden = false;
                errorEl.hidden = true;
                setStatus('ready', 'Analysis complete');
            } else if (errors) {
                showError(stripAnsi(errors));
                setStatus('error', 'Analysis failed');
            } else {
                showError('No output produced. The telegram may be invalid.');
                setStatus('error', 'No output');
            }
        } catch (e) {
            // Emscripten may throw on exit() — check if we got output anyway
            const existingOutput = outputEl.textContent || outputEl.innerHTML;
            if (resultsEl.hidden && !existingOutput) {
                showError('Engine error: ' + (e.message || e));
                setStatus('error', 'Engine error');
            } else {
                setStatus('ready', 'Analysis complete');
            }
        } finally {
            analyzeBtn.disabled = false;
            btnText.hidden = false;
            btnLoading.hidden = true;
        }
    }

    function showError(msg) {
        errorOutputEl.textContent = msg;
        errorEl.hidden = false;
        resultsEl.hidden = true;
    }

    // Event listeners
    analyzeBtn.addEventListener('click', runAnalysis);

    telegramEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            if (!analyzeBtn.disabled) runAnalysis();
        }
    });

    copyBtn.addEventListener('click', function() {
        const text = outputEl.textContent || outputEl.innerText;
        navigator.clipboard.writeText(text).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
    });

    // Initialize
    loadDrivers();
    loadWasm();
})();
