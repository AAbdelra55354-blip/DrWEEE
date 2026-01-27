/**
 * Offline Detection and UI Manager
 * Handles connection status and provides user feedback
 */

class OfflineManager {
    constructor() {
        this.banner = document.getElementById('offlineBanner');
        this.isOnline = navigator.onLine;
        this.wasOffline = false;

        this.init();
    }

    init() {
        // Listen for online/offline events
        window.addEventListener('online', () => this.handleOnline());
        window.addEventListener('offline', () => this.handleOffline());

        // Listen for PWA-specific offline events
        window.addEventListener('pwa:offline', () => this.handleOffline());
        window.addEventListener('pwa:online', () => this.handleOnline());

        // Check initial state
        if (!navigator.onLine) {
            this.handleOffline();
        }

        // Periodic connection check (every 30 seconds)
        setInterval(() => this.checkConnection(), 30000);

        console.log('[Offline Manager] Initialized, online:', this.isOnline);
    }

    /**
     * Handle online event
     */
    handleOnline() {
        console.log('[Offline Manager] Connection restored');

        this.isOnline = true;
        this.hideBanner();

        // If we were offline, show a brief "reconnected" message
        if (this.wasOffline) {
            this.showReconnectedMessage();
            this.wasOffline = false;

            // Notify PWA Bridge to potentially refresh content
            if (window.pwaBridge?.isLoaded) {
                window.pwaBridge.sendToDynamics({
                    type: 'pwa:connectionRestored'
                });
            }
        }
    }

    /**
     * Handle offline event
     */
    handleOffline() {
        console.log('[Offline Manager] Connection lost');

        this.isOnline = false;
        this.wasOffline = true;
        this.showBanner();

        // Haptic feedback to alert user
        if (navigator.vibrate) {
            navigator.vibrate([100, 50, 100]);
        }
    }

    /**
     * Show offline banner
     */
    showBanner() {
        this.banner?.classList.remove('hidden');
    }

    /**
     * Hide offline banner
     */
    hideBanner() {
        this.banner?.classList.add('hidden');
    }

    /**
     * Show "reconnected" toast message
     */
    showReconnectedMessage() {
        // Create a temporary toast
        const toast = document.createElement('div');
        toast.className = 'reconnected-toast';
        toast.innerHTML = `
            <span class="reconnected-icon">&#10004;</span>
            <span class="reconnected-text">
                <span data-lang="ar">تم استعادة الاتصال</span>
                <span data-lang="en" style="display:none">Connection restored</span>
            </span>
        `;

        // Style the toast
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: #4caf50;
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 14px;
            font-weight: 500;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 9999;
            animation: slideDown 0.3s ease;
        `;

        // Apply correct language visibility
        const lang = document.documentElement.lang || 'ar';
        toast.querySelectorAll('[data-lang]').forEach(el => {
            el.style.display = el.dataset.lang === lang ? '' : 'none';
        });

        // Add animation keyframes
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideDown {
                from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
                to { opacity: 1; transform: translateX(-50%) translateY(0); }
            }
        `;
        document.head.appendChild(style);

        // Add to DOM
        document.body.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.animation = 'slideDown 0.3s ease reverse';
            setTimeout(() => {
                toast.remove();
                style.remove();
            }, 300);
        }, 3000);
    }

    /**
     * Periodic connection check
     */
    async checkConnection() {
        try {
            // Try to fetch a small resource
            const response = await fetch('/pwa/manifest.json', {
                method: 'HEAD',
                cache: 'no-store'
            });

            if (response.ok && !this.isOnline) {
                this.handleOnline();
            }
        } catch (e) {
            if (this.isOnline) {
                this.handleOffline();
            }
        }
    }

    /**
     * Get current connection status
     */
    getStatus() {
        return {
            online: this.isOnline,
            wasOffline: this.wasOffline
        };
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.offlineManager = new OfflineManager();
});
