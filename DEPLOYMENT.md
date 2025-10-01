# DR.WEEE Website - Production Deployment Guide for Railway.com

This guide will walk you through deploying the DR.WEEE website to Railway.com with production-ready optimizations.

## 📋 Prerequisites

Before deploying, ensure you have:

1. **Railway Account**: Sign up at [railway.app](https://railway.app)
2. **GitHub Repository**: Your code should be pushed to GitHub
3. **Environment Variables**: All credentials ready (see `.env.example`)
4. **Domain (Optional)**: Custom domain for production use

## 🚀 Quick Deployment Steps

### Step 1: Install Railway CLI (Optional but Recommended)

```bash
npm install -g @railway/cli
railway login
```

### Step 2: Create New Railway Project

**Option A: Using Railway Dashboard (Recommended)**
1. Go to [railway.app/new](https://railway.app/new)
2. Click "Deploy from GitHub repo"
3. Select your `drweee-website` repository
4. Railway will auto-detect the configuration from `railway.json`

**Option B: Using Railway CLI**
```bash
cd c:\xampp\htdocs\drweee-website
railway init
railway up
```

### Step 3: Configure Environment Variables

In Railway Dashboard:
1. Go to your project → Variables tab
2. Add the following environment variables:

#### Required Variables:
```plaintext
NODE_ENV=production
PORT=3000
SESSION_SECRET=your-strong-random-secret-min-32-chars
CEQUENS_API_KEY=your-cequens-api-key
CEQUENS_USERNAME=your-cequens-username
CEQUENS_SENDER_NAME=DR.WEEE
DATAVERSE_URL=https://your-org.crm.dynamics.com
AZURE_TENANT_ID=your-tenant-id
AZURE_CLIENT_ID=your-client-id
AZURE_CLIENT_SECRET=your-client-secret
POWER_AUTOMATE_GET_URL=your-power-automate-webhook-url
AZURE_MAPS_KEY=your-azure-maps-api-key
```

#### Optional Variables:
```plaintext
FRONTEND_URL=https://your-domain.com
```

**🔐 Security Note:** Generate a strong SESSION_SECRET using:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Step 4: Install Production Dependencies

Railway will automatically run:
```bash
npm ci --production=false  # Installs all dependencies including helmet, compression
```

### Step 5: Deploy

Railway will automatically deploy on every push to your main branch.

To manually trigger a deployment:
```bash
railway up
```

### Step 6: Verify Deployment

1. Check the deployment logs in Railway Dashboard
2. Visit your Railway-provided URL (e.g., `https://drweee-production.up.railway.app`)
3. Test the health check endpoint: `https://your-url.railway.app/api/health`

Expected response:
```json
{
  "uptime": 123.45,
  "status": "OK",
  "timestamp": 1234567890,
  "environment": "production",
  "memoryUsage": {
    "heapUsed": "45MB",
    "heapTotal": "60MB"
  }
}
```

## 🔧 Configuration Files

### Railway Configuration (`railway.json`)
Configures build and deployment settings for Railway platform.

### Process File (`Procfile`)
Defines the command to start your application.

### Nixpacks Configuration (`nixpacks.toml`)
Specifies Node.js version and build commands.

## 🎯 Performance Optimizations Included

✅ **Compression**: Reduces response size by ~70% using gzip/brotli
✅ **Security Headers**: Helmet.js with CSP, HSTS, and XSS protection
✅ **Rate Limiting**: Prevents abuse with tiered rate limits
✅ **Cache Control**: Aggressive caching for static assets, no-cache for HTML
✅ **Request Logging**: Monitors and logs slow requests (>1s)
✅ **Health Checks**: Railway monitors `/api/health` endpoint
✅ **Error Handling**: Production-safe error responses

### Rate Limits:
- **General API**: 100 requests/15min per IP
- **Authentication**: 10 requests/15min per IP
- **OTP Requests**: 5 requests/15min per IP

## 🌐 Custom Domain Setup

### Step 1: Add Domain in Railway
1. Go to Settings → Domains
2. Click "Add Custom Domain"
3. Enter your domain (e.g., `drweee.com`)

### Step 2: Update DNS Records
Add CNAME record pointing to Railway:
```
Type: CNAME
Name: @ (or www)
Value: [your-railway-domain].up.railway.app
```

### Step 3: Update CORS Settings
In Railway environment variables, add:
```plaintext
FRONTEND_URL=https://your-domain.com
```

## 🔍 Monitoring & Debugging

### View Logs
**Dashboard**: Railway Dashboard → Deployments → View Logs

**CLI**:
```bash
railway logs
```

### Common Issues

#### Issue: "Application failed to respond"
- **Solution**: Check if PORT environment variable is set correctly
- Railway automatically provides PORT, no need to set it manually

#### Issue: "Module not found" errors
- **Solution**: Ensure all dependencies are in `package.json` dependencies (not devDependencies)
- Run `npm install` locally to verify

#### Issue: Session not persisting
- **Solution**: Currently using MemoryStore. For multi-instance deployments, consider Redis:
  1. Add Redis plugin in Railway
  2. Install `connect-redis`: `npm install connect-redis redis`
  3. Update session configuration in `server.js`

#### Issue: CORS errors
- **Solution**: Add your domain to `FRONTEND_URL` environment variable
- Update `corsOptionsProduction()` in `js/middleware.js`

## 🔄 Continuous Deployment

Railway automatically deploys on every push to your main branch.

### Disable Auto-Deploy:
1. Go to Settings → Deployments
2. Toggle off "Auto Deploy"

### Manual Deployment:
```bash
git push origin main
railway up  # Manual trigger
```

## 📊 Performance Monitoring

### Railway Metrics
Railway provides:
- CPU usage
- Memory usage
- Network bandwidth
- Request count

Access via: Dashboard → Metrics tab

### Application-Level Monitoring
Consider adding:
- **New Relic**: Application performance monitoring
- **Sentry**: Error tracking
- **LogRocket**: Session replay and logging

## 🛡️ Security Best Practices

✅ **Environment Variables**: Never commit `.env` to git
✅ **HTTPS Only**: Railway provides SSL certificates automatically
✅ **Helmet.js**: Security headers enabled in production
✅ **Rate Limiting**: Protects against brute force and DDoS
✅ **Input Validation**: All user inputs validated and sanitized
✅ **Session Security**: Secure cookies with httpOnly and sameSite

## 📝 Post-Deployment Checklist

- [ ] All environment variables configured
- [ ] Health check endpoint responding (`/api/health`)
- [ ] Test user registration flow
- [ ] Test login/logout functionality
- [ ] Test OTP sending (verify SMS delivery)
- [ ] Test e-waste collection request
- [ ] Test store order submission
- [ ] Test contact form
- [ ] Verify all pages load correctly
- [ ] Check browser console for errors
- [ ] Test on mobile devices
- [ ] Verify SSL certificate is active
- [ ] Check response times (<500ms for static, <2s for API)
- [ ] Monitor error logs for 24 hours

## 🔄 Rollback Procedure

If deployment fails or issues occur:

1. **Via Dashboard**:
   - Go to Deployments → Select previous deployment → "Redeploy"

2. **Via CLI**:
   ```bash
   railway rollback
   ```

3. **Via Git**:
   ```bash
   git revert HEAD
   git push origin main
   ```

## 💾 Backup Strategy

### Database (Dataverse)
- Microsoft Dataverse handles backups automatically
- Verify backup policy with your Microsoft admin

### Session Data
- Currently using MemoryStore (sessions lost on restart)
- For persistent sessions, migrate to Redis (see Session Persistence section)

## 🚀 Scaling

Railway supports automatic scaling:

1. Go to Settings → Resources
2. Adjust:
   - **CPU**: Increase for better performance
   - **Memory**: Increase if seeing memory errors
   - **Instances**: Add replicas for high traffic (requires Redis for sessions)

### Recommended Resources:
- **Development**: 0.5 CPU, 512MB RAM
- **Production (Low Traffic)**: 1 CPU, 1GB RAM
- **Production (High Traffic)**: 2 CPU, 2GB RAM, Multiple instances

## 📞 Support

### Railway Support
- Documentation: [docs.railway.app](https://docs.railway.app)
- Discord: [discord.gg/railway](https://discord.gg/railway)
- Status: [status.railway.app](https://status.railway.app)

### Application Issues
- GitHub Issues: [Your repo issues page]
- Contact: [Your support email]

## 🎉 Congratulations!

Your DR.WEEE website is now live on Railway with production-grade optimizations!

### Next Steps:
1. Monitor application logs for the first 24 hours
2. Set up uptime monitoring (e.g., UptimeRobot, Pingdom)
3. Configure DNS and custom domain
4. Share the URL with stakeholders
5. Celebrate! 🎊

---

**Last Updated**: 2025-10-01
**Version**: 1.0.0
