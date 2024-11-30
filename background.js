const BLOCKED_SITES = [
    'youtube.com',
    'facebook.com',
    'twitter.com',
    'linkedin.com',
    'instagram.com',
    'reddit.com'
];

// Initialize IndexedDB
const dbName = "StudyFocusDB";
const dbVersion = 1;

function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, dbVersion);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            
            // Store for analyzed pages
            if (!db.objectStoreNames.contains('analyzedPages')) {
                const pagesStore = db.createObjectStore('analyzedPages', { keyPath: 'url' });
                pagesStore.createIndex('timestamp', 'timestamp', { unique: false });
                pagesStore.createIndex('isRelevant', 'isRelevant', { unique: false });
            }
            
            // Store for navigation history
            if (!db.objectStoreNames.contains('navigationHistory')) {
                const historyStore = db.createObjectStore('navigationHistory', { keyPath: 'id', autoIncrement: true });
                historyStore.createIndex('url', 'url', { unique: false });
                historyStore.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

// Track navigation events
chrome.webNavigation.onCompleted.addListener(async (details) => {
    if (details.frameId === 0) { // Main frame only
        const db = await initDB();
        const transaction = db.transaction(['navigationHistory'], 'readwrite');
        const store = transaction.objectStore('navigationHistory');
        
        store.add({
            url: details.url,
            timestamp: Date.now(),
            tabId: details.tabId
        });
    }
});

// Listen for content analysis results
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'contentAnalysis') {
        // Show analyzing popup first
        chrome.tabs.sendMessage(sender.tab.id, {
            type: 'showPopup',
            message: 'Analyzing page content...',
            duration: 3000
        });

        (async () => {
            try {
                const aiAnalysis = await analyzeWithGemini(message.content);
                const db = await initDB();
                
                // Store analysis results
                const transaction = db.transaction(['analyzedPages'], 'readwrite');
                const store = transaction.objectStore('analyzedPages');
                
                store.add({
                    url: sender.tab.url,
                    timestamp: Date.now(),
                    analysis: aiAnalysis,
                    isRelevant: aiAnalysis.isRelevant,
                    summary: aiAnalysis.summary
                });

                if (!aiAnalysis.isRelevant) {
                    await chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'showWarning',
                        message: `This page appears to be irrelevant.\nReason: ${aiAnalysis.reason}\nClosing tab in 5 seconds...`,
                        duration: 5000
                    });
                    
                    setTimeout(() => {
                        chrome.tabs.remove(sender.tab.id).catch(err => 
                            console.error('Failed to close tab:', err)
                        );
                    }, 5000);
                } else {
                    await chrome.tabs.sendMessage(sender.tab.id, {
                        type: 'showPopup',
                        message: 'Page is relevant to your studies!',
                        duration: 2000
                    });
                }
            } catch (error) {
                console.error('Error in content analysis:', error);
                chrome.tabs.sendMessage(sender.tab.id, {
                    type: 'showPopup',
                    message: 'Error analyzing page content',
                    duration: 3000
                });
            }
        })();
        
        return true;
    }
});

async function analyzeWithGemini(content) {
    const API_KEY = 'Enter your Gemini key'; 
    const API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';

    try {
        const response = await fetch(`${API_URL}?key=${API_KEY}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{
                        text: `Analyze this webpage content and determine if it's relevant to the study topic "${content.studyTopic}".
                               Return the response in the following JSON format:
                               {
                                   "relevanceScore": (number between 0 and 1),
                                   "summary": "brief summary of the content",
                                   "explanation": "explanation of relevance score"
                               }
                               
                               Webpage content: ${content.text}`
                    }]
                }],
                generationConfig: {
                    temperature: 0.7,
                    topK: 40,
                    topP: 0.95,
                }
            })
        });

        const result = await response.json();
        let analysisResult;
        
        try {
            // Parse the JSON from the response text
            analysisResult = JSON.parse(result.candidates[0].content.parts[0].text);
        } catch (parseError) {
            console.error('Failed to parse Gemini response:', parseError);
            throw new Error('Invalid response format');
        }

        return {
            isRelevant: analysisResult.relevanceScore >= 0.6,
            summary: analysisResult.summary,
            reason: analysisResult.explanation,
            confidence: analysisResult.relevanceScore
        };
    } catch (error) {
        console.error('Gemini Analysis failed:', error);
        return {
            isRelevant: true, // Fail open to avoid blocking legitimate content
            summary: "Analysis failed",
            reason: "Could not perform AI analysis",
            confidence: 0
        };
    }
}
