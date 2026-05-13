# DrWEEE PWA & Website

Progressive Web App and full-stack website for Dr. WEEE Business Suite. Provides customer-facing e-waste services, POS, CRM, and installable mobile experience.

## Tech Stack
- **Backend**: Node.js + Express.js 5.1.0
- **Frontend**: Vanilla HTML/CSS/JavaScript (multi-page)
- **PWA**: Service Worker v3, Web App Manifest, offline support
- **Database**: MySQL (via mysql2)
- **Auth**: Session-based with OTP (Cequens SMS API)
- **i18n**: Arabic (primary, RTL), English, Italian
- **Deployment**: Railway.com (auto-deploy on push)
- **Repo**: GitHub — mohanadelsayed/drweee-website

## Commands
```bash
npm run dev      # Dev server (port 3000)
npm start        # Production server
npm run prod     # Explicit production mode
```

## Project Structure (parent: C:\xampp\htdocs\drweee-website)
- `js/server.js` — Express server (main entry, 250KB+)
- `js/i18n.js` — Internationalization
- `js/middleware.js` — Session, auth, security
- `js/analytics.js` — GA4 & GTM
- `html files` — index, login, services, about, contact, store, redeem-points, etc.
- `includes/` — Reusable header/footer
- `css/main.css` — Styles with RTL support
- `locales/` — Translation JSON files
- `pwa/` — PWA shell, service worker, manifests, icons

## PWA Details
- `pwa/app-shell.html` — Main PWA shell (750+ lines)
- `pwa/sw.js` — Service Worker (cache: `drweee-pwa-v3`, network-first strategy)
- `pwa/manifest.json` — Production manifest (standalone, teal theme, Arabic)
- `pwa/d365-manifest.json` — D365 web resource manifest
- `pwa/offline.html` — Bilingual offline fallback
- App shortcuts: POS, E-Waste, Finance, CRM

## Integrations
- Microsoft Dynamics 365 Dataverse (via Power Automate webhooks)
- Azure AD (authentication)
- Azure Maps (location services)
- Cequens SMS API (OTP)
- Google Analytics 4 & GTM
- Web Push notifications

## Environment Variables (see .env.example)
- `NODE_ENV`, `PORT`, `SESSION_SECRET`
- `DATAVERSE_URL*`, `POWER_AUTOMATE_GET_URL*`
- Azure credentials (Tenant ID, Client ID, Secret)
- Cequens API keys, Azure Maps/Translator keys

## Important Notes
- RTL layout support throughout — test Arabic rendering carefully
- Server.js is very large — read specific functions, not entire file
- Three manifest files for different environments (prod, test, D365)
- No test suite exists — consider Playwright for E2E testing
