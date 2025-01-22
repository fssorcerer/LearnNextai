pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Get DOM elements
const pdfInput = document.getElementById('pdfInput');
const summarizeButton = document.getElementById('summarizeButton');
const summaryOutput = document.getElementById('summaryOutput');
const progress = document.getElementById('progress');
const progressBar = document.getElementById('progressBar');
const progressBarFill = document.getElementById('progressBarFill');
const selectedFile = document.getElementById('selectedFile');
const fileName = document.getElementById('fileName');

const GEMINI_API_KEY = config.API_KEY;

// Theme toggle functionality
const themeToggle = document.getElementById('themeToggle');
const sunIcon = document.getElementById('sunIcon');
const moonIcon = document.getElementById('moonIcon');
const html = document.documentElement;

// Check for saved theme preference, default to dark if none saved
const savedTheme = localStorage.getItem('theme') || 'dark';
html.setAttribute('data-theme', savedTheme);
updateIcons(savedTheme);

// Add theme toggle click handler
themeToggle.addEventListener('click', () => {
    const currentTheme = html.getAttribute('data-theme');
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    html.setAttribute('data-theme', newTheme);
    localStorage.setItem('theme', newTheme);
    updateIcons(newTheme);
});

function updateIcons(theme) {
    if (theme === 'light') {
        sunIcon.classList.add('hidden');
        moonIcon.classList.remove('hidden');
    } else {
        sunIcon.classList.remove('hidden');
        moonIcon.classList.add('hidden');
    }
}

// Rate limiter implementation
class RateLimiter {
    constructor(maxRequests, timeWindow) {
        this.maxRequests = maxRequests;      // Maximum requests allowed
        this.timeWindow = timeWindow;        // Time window in milliseconds
        this.requests = [];                  // Queue to track request timestamps
    }

    async acquireToken() {
        const now = Date.now();
        
        // Remove timestamps older than our time window
        this.requests = this.requests.filter(timestamp => 
            now - timestamp < this.timeWindow
        );

        // If we've reached the limit, wait until the oldest request expires
        if (this.requests.length >= this.maxRequests) {
            const oldestRequest = this.requests[0];
            const waitTime = (oldestRequest + this.timeWindow) - now;
            await new Promise(resolve => setTimeout(resolve, waitTime));
            return this.acquireToken(); // Try again after waiting
        }

        // Add current request timestamp
        this.requests.push(now);
        return true;
    }
}

// Create rate limiter instance (60 requests per minute)
const rateLimiter = new RateLimiter(60, 60 * 1000);

// Handle file selection
pdfInput.addEventListener('change', () => {
    const file = pdfInput.files[0];
    summarizeButton.disabled = !file;
    
    if (file) {
        fileName.textContent = file.name;
        selectedFile.style.display = 'block';
    } else {
        selectedFile.style.display = 'none';
    }
});

// Update progress bar
function updateProgress(percent) {
    if (progressBar && progressBarFill) {
        progressBar.style.display = 'block';
        progressBarFill.style.width = `${percent}%`;
    }
}

// Update progress text
function updateProgressText(text) {
    if (progress) {
        progress.textContent = text;
    }
}

async function extractTextFromPDF(pdfFile) {
    try {
        const arrayBuffer = await pdfFile.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        const numPages = pdf.numPages;
        let text = '';

        updateProgressText('Extracting text from PDF...');
        updateProgress(10);

        for (let i = 1; i <= numPages; i++) {
            updateProgressText(`Extracting text from page ${i} of ${numPages}...`);
            const page = await pdf.getPage(i);
            const content = await page.getTextContent();
            const pageText = content.items.map(item => item.str).join(' ');
            text += pageText + '\n';
            
            // Update progress based on page extraction
            updateProgress(10 + (40 * (i / numPages)));
        }

        return text;
    } catch (error) {
        throw new Error('Failed to extract text from PDF: ' + error.message);
    }
}

async function summarizeText(text) {
    updateProgressText('Generating summary...');
    updateProgress(50);
    
    try {
        const maxChunkSize = 30000;
        const chunks = [];
        
        for (let i = 0; i < text.length; i += maxChunkSize) {
            chunks.push(text.slice(i, i + maxChunkSize));
        }

        let fullSummary = '';
        
        for (let i = 0; i < chunks.length; i++) {
            updateProgressText(`Summarizing part ${i + 1} of ${chunks.length}...`);
            updateProgress(50 + (40 * ((i + 1) / chunks.length)));
            
            // Wait for rate limiter before making API call
            await rateLimiter.acquireToken();
            
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `Please provide a concise but comprehensive summary of the following text. Focus on the main points and key details : ${chunks[i]}`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.7,
                            topK: 40,
                            topP: 0.8,
                            maxOutputTokens: 1024
                        }
                    })
                }
            );

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error?.message || `Error: ${response.status}`);
            }

            const data = await response.json();
            fullSummary += data.candidates[0].content.parts[0].text + '\n\n';
        }

        if (chunks.length > 1) {
            updateProgressText('Generating final summary...');
            updateProgress(90);
            
            // Wait for rate limiter before final summary
            await rateLimiter.acquireToken();
            
            const response = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        contents: [{
                            parts: [{
                                text: `Please provide a unified, coherent summary of these summaries: ${fullSummary}`
                            }]
                        }],
                        generationConfig: {
                            temperature: 0.7,
                            maxOutputTokens: 1024
                        }
                    })
                }
            );

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error?.message || `Error: ${response.status}`);
            }

            const data = await response.json();
            return data.candidates[0].content.parts[0].text;
        }

        return fullSummary;
    } catch (error) {
        throw new Error('Failed to generate summary: ' + error.message);
    }
}

summarizeButton.addEventListener('click', async () => {
    const file = pdfInput.files[0];
    if (!file) {
        alert('Please select a PDF file first.');
        return;
    }

    summarizeButton.disabled = true;
    summaryOutput.value = '';
    updateProgress(0);
    updateProgressText('');

    try {
        const text = await extractTextFromPDF(file);
        const summary = await summarizeText(text);
        updateProgressText('Summary generated!');
        updateProgress(100);
        summaryOutput.value = summary;
    } catch (error) {
        updateProgressText('An error occurred');
        summaryOutput.value = `Error: ${error.message}`;
        console.error('Error:', error);
    } finally {
        summarizeButton.disabled = false;
        setTimeout(() => {
            if (progressBar) {
                progressBar.style.display = 'none';
                progressBarFill.style.width = '0%';
            }
            updateProgressText('');
        }, 2000);
    }
});