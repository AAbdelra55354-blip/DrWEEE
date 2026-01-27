/**
 * PWA Bridge - Communication between PWA shell and Dynamics 365 iframe
 * Handles loading states, navigation sync, theme updates, and language sync
 */

class PWABridge {
    constructor() {
        this.dynamicsFrame = document.getElementById('dynamicsFrame');
        this.loadingSplash = document.getElementById('loadingSplash');
        this.authOverlay = document.getElementById('authOverlay');
        this.errorOverlay = document.getElementById('errorOverlay');
        this.retryBtn = document.getElementById('retryBtn');
        this.errorRetryBtn = document.getElementById('errorRetryBtn');
        this.authBtn = document.getElementById('authBtn');

        this.isLoaded = false;
        this.loadAttempts = 0;
        this.maxLoadAttempts = 3;
        this.authCheckTimeout = null;
        this.loadTimeout = null;

        // Get saved language or default to Arabic
        this.language = localStorage.getItem('drweee_lang') || 'ar';

        // Dynamics 365 base URL
        this.dynamicsBaseUrl = 'https://org1cbcc5c9.crm3.dynamics.com/WebResources/crd33_home';

        this.init();
    }

    init() {
        // Apply initial language
        this.applyLanguage(this.language);

        // Set up iframe event handlers
        this.dynamicsFrame.addEventListener('load', () => this.handleFrameLoad());

        // Listen for messages from Dynamics 365
        window.addEventListener('message', (e) => this.handleMessage(e));

        // Set up retry buttons
        this.retryBtn?.addEventListener('click', () => this.retryLoad());
        this.errorRetryBtn?.addEventListener('click', () => this.retryLoad());

        // Auth button should open in same window for proper redirect
        this.authBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            // Navigate the iframe to Dynamics login
            this.dynamicsFrame.src = this.authBtn.href;
            this.showLoading();
        });

        // Start loading Dynamics
        this.loadDynamics();

        // Listen for service worker notifications
        navigator.serviceWorker?.addEventListener('message', (e) => {
            if (e.data?.type === 'notification:clicked' && e.data.url) {
                this.navigateToHash(e.data.url);
            }
        });
    }

    /**
     * Load Dynamics 365 with current hash
     */
    loadDynamics() {
        const hash = window.location.hash || '';
        const dynamicsUrl = this.dynamicsBaseUrl + hash;

        console.log('[PWA Bridge] Loading Dynamics:', dynamicsUrl);

        // Show loading state
        this.showLoading();

        // Start load timeout (15 seconds for initial load)
        this.loadTimeout = setTimeout(() => {
            if (!this.isLoaded) {
                console.log('[PWA Bridge] Load timeout - checking auth');
                this.checkAuthState();
            }
        }, 15000);

        // Load the iframe
        this.dynamicsFrame.src = dynamicsUrl;
    }

    /**
     * Handle iframe load event
     */
    handleFrameLoad() {
        console.log('[PWA Bridge] Iframe load event fired');
        this.loadAttempts++;

        // Clear load timeout
        clearTimeout(this.loadTimeout);

        // Start auth check timeout (wait for shell:ready message)
        this.authCheckTimeout = setTimeout(() => {
            if (!this.isLoaded) {
                console.log('[PWA Bridge] No shell:ready received - might need auth');
                this.checkAuthState();
            }
        }, 5000);
    }

    /**
     * Check authentication state
     */
    checkAuthState() {
        // Try to detect if we're on a login page
        try {
            // We can't access cross-origin iframe content
            // So we rely on the shell:ready message from home.html
            // If we don't get it, assume auth is needed
            if (!this.isLoaded) {
                if (this.loadAttempts >= this.maxLoadAttempts) {
                    this.showError();
                } else {
                    this.showAuthRequired();
                }
            }
        } catch (e) {
            console.log('[PWA Bridge] Cross-origin access denied (expected)');
            this.showAuthRequired();
        }
    }

    /**
     * Handle postMessage from Dynamics 365
     */
    handleMessage(event) {
        // Accept messages from Dynamics 365 domains
        const allowedOrigins = [
            'dynamics.com',
            'crm3.dynamics.com',
            'crm.dynamics.com'
        ];

        const isAllowed = allowedOrigins.some(domain =>
            event.origin.includes(domain)
        );

        if (!isAllowed && event.origin !== window.location.origin) {
            return;
        }

        const data = event.data;
        if (!data || typeof data !== 'object') return;

        console.log('[PWA Bridge] Message received:', data.type);

        switch (data.type) {
            case 'shell:ready':
            case 'module:ready':
                // Dynamics shell/module is ready
                this.handleReady(data);
                break;

            case 'module:navigate':
            case 'shell:navigate':
                // Update URL for deep linking
                this.handleNavigate(data);
                break;

            case 'shell:themeChange':
                // Update PWA theme color
                this.handleThemeChange(data);
                break;

            case 'shell:languageChange':
                // Sync language with Dynamics
                this.handleLanguageChange(data);
                break;

            case 'shell:title':
                // Update document title
                if (data.title) {
                    document.title = data.title;
                }
                break;

            case 'shell:error':
                // Handle error from Dynamics
                console.error('[PWA Bridge] Error from Dynamics:', data.error);
                break;
        }
    }

    /**
     * Handle ready message - hide splash
     */
    handleReady(data) {
        clearTimeout(this.authCheckTimeout);
        clearTimeout(this.loadTimeout);

        this.isLoaded = true;
        this.hideSplash();

        // Apply theme if provided
        if (data.theme?.color) {
            this.updateThemeColor(data.theme.color);
        }

        // Sync language if provided
        if (data.language) {
            this.applyLanguage(data.language);
        }

        console.log('[PWA Bridge] App ready');
    }

    /**
     * Handle navigation - update URL hash
     */
    handleNavigate(data) {
        let newHash = '';

        if (data.moduleId) {
            newHash = data.hash
                ? `#${data.moduleId}/${data.hash}`
                : `#${data.moduleId}`;
        } else if (data.action === 'back' || data.action === 'home') {
            newHash = '';
        }

        const newUrl = '/app' + newHash;
        if (window.location.pathname + window.location.hash !== newUrl) {
            history.replaceState({ module: data.moduleId }, '', newUrl);
        }
    }

    /**
     * Handle theme color change
     */
    handleThemeChange(data) {
        if (data.color) {
            this.updateThemeColor(data.color);
        }
    }

    /**
     * Update theme-color meta tag
     */
    updateThemeColor(color) {
        const metaTheme = document.querySelector('meta[name="theme-color"]');
        if (metaTheme) {
            metaTheme.setAttribute('content', color);
        }
    }

    /**
     * Handle language change from Dynamics
     */
    handleLanguageChange(data) {
        if (data.language) {
            this.applyLanguage(data.language);
            localStorage.setItem('drweee_lang', data.language);
        }
    }

    /**
     * Apply language to PWA shell
     */
    applyLanguage(lang) {
        this.language = lang;

        // Update HTML lang and dir attributes
        document.documentElement.lang = lang;
        document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';

        // Toggle visibility of language-specific text
        document.querySelectorAll('[data-lang]').forEach(el => {
            el.style.display = el.dataset.lang === lang ? '' : 'none';
        });
    }

    /**
     * Send message to Dynamics iframe
     */
    sendToDynamics(message) {
        if (this.dynamicsFrame?.contentWindow) {
            this.dynamicsFrame.contentWindow.postMessage(message, '*');
        }
    }

    /**
     * Navigate to a specific hash/module
     */
    navigateToHash(hash) {
        if (this.isLoaded) {
            // Send navigation command to Dynamics
            const cleanHash = hash.replace(/^#/, '');
            const [moduleId, section] = cleanHash.split('/');

            this.sendToDynamics({
                type: 'pwa:navigate',
                moduleId: moduleId,
                section: section
            });
        } else {
            // Reload with new hash
            window.location.hash = hash;
            this.retryLoad();
        }
    }

    /**
     * Show loading splash
     */
    showLoading() {
        this.loadingSplash?.classList.remove('hidden', 'fade-out');
        this.authOverlay?.classList.add('hidden');
        this.errorOverlay?.classList.add('hidden');
    }

    /**
     * Hide loading splash with animation
     */
    hideSplash() {
        this.loadingSplash?.classList.add('fade-out');
        setTimeout(() => {
            this.loadingSplash?.classList.add('hidden');
        }, 300);

        this.authOverlay?.classList.add('hidden');
        this.errorOverlay?.classList.add('hidden');
    }

    /**
     * Show auth required overlay
     */
    showAuthRequired() {
        this.loadingSplash?.classList.add('hidden');
        this.errorOverlay?.classList.add('hidden');
        this.authOverlay?.classList.remove('hidden');
    }

    /**
     * Show error overlay
     */
    showError() {
        this.loadingSplash?.classList.add('hidden');
        this.authOverlay?.classList.add('hidden');
        this.errorOverlay?.classList.remove('hidden');
    }

    /**
     * Retry loading
     */
    retryLoad() {
        this.loadAttempts = 0;
        this.isLoaded = false;
        this.loadDynamics();
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.pwaBridge = new PWABridge();
});

// Handle browser back/forward
window.addEventListener('popstate', (e) => {
    if (window.pwaBridge?.isLoaded) {
        const hash = window.location.hash;
        window.pwaBridge.navigateToHash(hash);
    }
});
