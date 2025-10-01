# 🚀 Railway.com Deployment Quick Checklist

## Before You Deploy

### 1. Push Your Code to GitHub
```bash
git add .
git commit -m "Production-ready deployment with optimizations"
git push origin main
```

### 2. Prepare Environment Variables
Copy these from your `.env.example` and fill in your production values:

```plaintext
NODE_ENV=production
SESSION_SECRET=[Generate using: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"]
CEQUENS_API_KEY=[Your Cequens API Key]
CEQUENS_USERNAME=[Your Cequens Username]
CEQUENS_SENDER_NAME=DR.WEEE
DATAVERSE_URL=[Your Dataverse URL]
AZURE_TENANT_ID=[Your Azure Tenant ID]
AZURE_CLIENT_ID=[Your Azure Client ID]
AZURE_CLIENT_SECRET=[Your Azure Client Secret]
POWER_AUTOMATE_GET_URL=[Your Power Automate Webhook URL]
AZURE_MAPS_KEY=[Your Azure Maps Key]
```

---

## Deploy to Railway (3 Steps)

### ✅ Step 1: Create Railway Project
1. Go to [railway.app/new](https://railway.app/new)
2. Click **"Deploy from GitHub repo"**
3. Select **`drweee-website`** repository
4. Click **"Deploy Now"**

### ✅ Step 2: Add Environment Variables
1. In Railway Dashboard, go to **Variables** tab
2. Click **"New Variable"**
3. Paste all environment variables from above (one by one or use "Raw Editor")
4. Click **"Save"**

### ✅ Step 3: Wait for Deployment
1. Go to **Deployments** tab
2. Wait for build to complete (~2-3 minutes)
3. Click on the generated URL to open your site
4. Test: Visit `https://your-url.railway.app/api/health`

---

## Post-Deployment Tests

### Test These Features:
- [ ] Homepage loads
- [ ] All navigation links work
- [ ] User registration (OTP flow)
- [ ] User login
- [ ] E-waste collection request
- [ ] Store browsing and cart
- [ ] Contact form submission
- [ ] All images load correctly
- [ ] Mobile responsiveness

### Check Performance:
- [ ] Health endpoint responds: `/api/health`
- [ ] Check Railway logs for errors
- [ ] Verify no console errors in browser
- [ ] Test page load speed (<2 seconds)

---

## Optional: Add Custom Domain

### 1. In Railway Dashboard:
- Go to **Settings** → **Domains**
- Click **"Add Custom Domain"**
- Enter: `drweee.com` (or your domain)

### 2. Update Your DNS:
Add CNAME record:
```
Type: CNAME
Name: @ (or www)
Value: [your-project].up.railway.app
TTL: 3600
```

### 3. Wait for SSL:
Railway automatically provisions SSL (5-10 minutes)

---

## 🆘 Troubleshooting

### Application Not Starting?
1. Check Railway logs for errors
2. Verify all environment variables are set
3. Ensure `NODE_ENV=production` is set

### "Module not found" Error?
Run locally first:
```bash
npm ci
npm start
```

### Session Issues?
- Memory sessions reset on deployment
- For persistent sessions, consider adding Redis

---

## 🎉 Success!

Your application is now live at: `https://[your-project].up.railway.app`

**Pro Tips:**
- Railway auto-deploys on every `git push`
- Monitor logs in Dashboard → Logs
- Scale resources in Settings → Resources
- View metrics in Dashboard → Metrics

---

Need help? Check [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed guide.
