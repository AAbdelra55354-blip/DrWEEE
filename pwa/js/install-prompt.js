/**
 * Smart Install Prompt Manager
 * Shows install prompt at optimal times with proper UX
 */

class InstallPromptManager {
    constructor() {
        this.deferredPrompt = null;

        // DOM elements
        this.promptElement = document.getElementById('installPrompt');
        this.iosPromptElement = document.getElementById('iosInstallPrompt');
        this.installBtn = document.getElementById('installBtn');
        this.installLaterBtn = document.getElementById('installLater');
        this.closeBtn = document.getElementById('installClose');
        this.iosCloseBtn = document.getElementById('iosInstallClose');
        this.iosGotItBtn = document.getElementById('iosGotIt');

        // Storage keys
        this.STORAGE_KEYS = {
            dismissed: 'drweee_install_dismissed',
            lastShown: 'drweee_install_shown_date',
            installed: 'drweee_app_installed'
        };

        // Timing configuration
        this.CONFIG = {
            showDelay: 30000,           // 30 seconds after load
            dismissCooldown: 7 * 24 * 60 * 60 * 1000,  // 7 days
            showCooldown: 24 * 60 * 60 * 1000          // 24 hours
        };

        this.init();
    }

    init() {
        // Check if already installed
        if (this.isInStandaloneMode()) {
            console.log('[Install] App is running in standalone mode');
            localStorage.setItem(this.STORAGE_KEYS.installed, 'true');
            return;
        }

        // Capture the beforeinstallprompt event (Chrome/Edge/Samsung)
        window.addEventListener('beforeinstallprompt', (e) => {
            console.log('[Install] beforeinstallprompt event fired');
            e.preventDefault();
            this.deferredPrompt = e;
            this.schedulePrompt();
        });

        // Handle iOS (no beforeinstallprompt)
        if (this.isIOS() && !this.isInStandaloneMode()) {
            console.log('[Install] iOS device detected');
            this.scheduleIOSPrompt();
        }

        // Button handlers
        this.installBtn?.addEventListener('click', () => this.triggerInstall());
        this.installLaterBtn?.addEventListener('click', () => this.dismissPrompt());
        this.closeBtn?.addEventListener('click', () => this.dismissPrompt());
        this.iosCloseBtn?.addEventListener('click', () => this.dismissIOSPrompt());
        this.iosGotItBtn?.addEventListener('click', () => this.dismissIOSPrompt());

        // Track successful install
        window.addEventListener('appinstalled', () => {
            console.log('[Install] App installed successfully');
            this.hidePrompt();
            localStorage.setItem(this.STORAGE_KEYS.installed, 'true');
            localStorage.removeItem(this.STORAGE_KEYS.dismissed);

            // Send analytics event if available
            if (typeof gtag === 'function') {
                gtag('event', 'app_install', {
                    'event_category': 'PWA',
                    'event_label': 'DrWEEE App Installed'
                });
            }
        });

        // Show prompt when user engages (e.g., returns to the app)
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' && this.deferredPrompt) {
                this.maybeShowPrompt();
            }
        });
    }

    /**
     * Schedule prompt to show after delay
     */
    schedulePrompt() {
        if (this.shouldShowPrompt()) {
            setTimeout(() => {
                this.maybeShowPrompt();
            }, this.CONFIG.showDelay);
        }
    }

    /**
     * Schedule iOS prompt
     */
    scheduleIOSPrompt() {
        if (this.shouldShowPrompt()) {
            setTimeout(() => {
                this.showIOSPrompt();
            }, this.CONFIG.showDelay);
        }
    }

    /**
     * Check if prompt should be shown
     */
    shouldShowPrompt() {
        // Don't show if already installed
        if (this.isInStandaloneMode()) return false;

        // Don't show if dismissed recently
        const dismissedTime = localStorage.getItem(this.STORAGE_KEYS.dismissed);
        if (dismissedTime) {
            const elapsed = Date.now() - parseInt(dismissedTime, 10);
            if (elapsed < this.CONFIG.dismissCooldown) {
                console.log('[Install] Recently dismissed, skipping prompt');
                return false;
            }
        }

        // Don't show too frequently
        const lastShown = localStorage.getItem(this.STORAGE_KEYS.lastShown);
        if (lastShown) {
            const elapsed = Date.now() - parseInt(lastShown, 10);
            if (elapsed < this.CONFIG.showCooldown) {
                console.log('[Install] Recently shown, skipping prompt');
                return false;
            }
        }

        return true;
    }

    /**
     * Maybe show the prompt (final check)
     */
    maybeShowPrompt() {
        if (!this.deferredPrompt) {
            console.log('[Install] No deferred prompt available');
            return;
        }

        if (!this.shouldShowPrompt()) return;

        this.showPrompt();
    }

    /**
     * Show the install prompt
     */
    showPrompt() {
        console.log('[Install] Showing install prompt');
        this.promptElement?.classList.remove('hidden');
        localStorage.setItem(this.STORAGE_KEYS.lastShown, Date.now().toString());

        // Haptic feedback
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    }

    /**
     * Show iOS-specific install instructions
     */
    showIOSPrompt() {
        if (!this.shouldShowPrompt()) return;

        console.log('[Install] Showing iOS install prompt');
        this.iosPromptElement?.classList.remove('hidden');
        localStorage.setItem(this.STORAGE_KEYS.lastShown, Date.now().toString());

        // Haptic feedback
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    }

    /**
     * Hide the prompt
     */
    hidePrompt() {
        this.promptElement?.classList.add('hidden');
        this.iosPromptElement?.classList.add('hidden');
    }

    /**
     * Dismiss the prompt (user clicked Later/Close)
     */
    dismissPrompt() {
        console.log('[Install] User dismissed prompt');
        this.hidePrompt();
        localStorage.setItem(this.STORAGE_KEYS.dismissed, Date.now().toString());
    }

    /**
     * Dismiss iOS prompt
     */
    dismissIOSPrompt() {
        console.log('[Install] User dismissed iOS prompt');
        this.hidePrompt();
        localStorage.setItem(this.STORAGE_KEYS.dismissed, Date.now().toString());
    }

    /**
     * Trigger the native install prompt
     */
    async triggerInstall() {
        if (!this.deferredPrompt) {
            console.log('[Install] No deferred prompt to trigger');
            return;
        }

        console.log('[Install] Triggering install prompt');

        // Show the install prompt
        this.deferredPrompt.prompt();

        // Wait for user response
        const result = await this.deferredPrompt.userChoice;
        console.log('[Install] User choice:', result.outcome);

        // Clear the deferred prompt
        this.deferredPrompt = null;

        // Hide our custom prompt
        this.hidePrompt();

        // Track the result
        if (typeof gtag === 'function') {
            gtag('event', 'install_prompt_response', {
                'event_category': 'PWA',
                'event_label': result.outcome
            });
        }
    }

    /**
     * Check if running in standalone mode (installed)
     */
    isInStandaloneMode() {
        return (
            window.matchMedia('(display-mode: standalone)').matches ||
            window.navigator.standalone === true ||
            document.referrer.includes('android-app://')
        );
    }

    /**
     * Check if device is iOS
     */
    isIOS() {
        return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    }

    /**
     * Check if device is Android
     */
    isAndroid() {
        return /Android/.test(navigator.userAgent);
    }
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    window.installManager = new InstallPromptManager();
});
