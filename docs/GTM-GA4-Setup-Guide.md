# Google Tag Manager & GA4 Configuration Guide for DR.WEEE

This guide will walk you through configuring Google Tag Manager (GTM) to properly send all custom events to Google Analytics 4 (GA4).

---

## Prerequisites

- **GTM Container ID:** `GTM-TM738SMJ`
- **GA4 Measurement ID:** `G-LJ3HG6ELPZ`
- Access to [Google Tag Manager](https://tagmanager.google.com/)
- Access to [Google Analytics 4](https://analytics.google.com/)

---

## Part 1: GA4 Configuration Tag (Base Setup)

### Step 1.1: Create GA4 Configuration Tag

1. Log in to [Google Tag Manager](https://tagmanager.google.com/)
2. Select your container: **GTM-TM738SMJ**
3. Click **Tags** in the left sidebar
4. Click **New** button (top right)
5. Click **Tag Configuration** box
6. Select **Google Analytics: GA4 Configuration**
7. Configure:
   - **Measurement ID:** `G-LJ3HG6ELPZ`
   - **Send a page view event when this configuration loads:** ✅ Checked
8. Click **Triggering** box below
9. Select **All Pages**
10. Name the tag: `GA4 - Configuration`
11. Click **Save**

---

## Part 2: Create Data Layer Variables

These variables capture event parameters from the dataLayer.

### Step 2.1: Navigate to Variables

1. Click **Variables** in the left sidebar
2. Scroll down to **User-Defined Variables**
3. Click **New**

### Step 2.2: Create Each Variable

Create the following variables one by one:

#### Variable 1: `dlv - method`
1. Click **Variable Configuration**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `method`
4. **Data Layer Version:** Version 2
5. Name it: `dlv - method`
6. Click **Save**

#### Variable 2: `dlv - user_id`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `user_id`
4. Name it: `dlv - user_id`
5. Click **Save**

#### Variable 3: `dlv - value`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `value`
4. Name it: `dlv - value`
5. Click **Save**

#### Variable 4: `dlv - currency`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `currency`
4. Name it: `dlv - currency`
5. Click **Save**

#### Variable 5: `dlv - items`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `items`
4. Name it: `dlv - items`
5. Click **Save**

#### Variable 6: `dlv - content_type`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `content_type`
4. Name it: `dlv - content_type`
5. Click **Save**

#### Variable 7: `dlv - lead_type`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `lead_type`
4. Name it: `dlv - lead_type`
5. Click **Save**

#### Variable 8: `dlv - items_count`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `items_count`
4. Name it: `dlv - items_count`
5. Click **Save**

#### Variable 9: `dlv - subject`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `subject`
4. Name it: `dlv - subject`
5. Click **Save**

#### Variable 10: `dlv - item_id`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `item_id`
4. Name it: `dlv - item_id`
5. Click **Save**

#### Variable 11: `dlv - item_name`
1. Click **New**
2. Select **Data Layer Variable**
3. **Data Layer Variable Name:** `item_name`
4. Name it: `dlv - item_name`
5. Click **Save**

---

## Part 3: Create Custom Event Triggers

### Step 3.1: Navigate to Triggers

1. Click **Triggers** in the left sidebar
2. Click **New**

### Step 3.2: Create Each Trigger

#### Trigger 1: `CE - login`
1. Click **Trigger Configuration**
2. Select **Custom Event**
3. **Event name:** `login`
4. **This trigger fires on:** All Custom Events
5. Name it: `CE - login`
6. Click **Save**

#### Trigger 2: `CE - sign_up`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `sign_up`
4. Name it: `CE - sign_up`
5. Click **Save**

#### Trigger 3: `CE - add_to_cart`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `add_to_cart`
4. Name it: `CE - add_to_cart`
5. Click **Save**

#### Trigger 4: `CE - view_item`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `view_item`
4. Name it: `CE - view_item`
5. Click **Save**

#### Trigger 5: `CE - generate_lead`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `generate_lead`
4. Name it: `CE - generate_lead`
5. Click **Save**

#### Trigger 6: `CE - share`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `share`
4. Name it: `CE - share`
5. Click **Save**

#### Trigger 7: `CE - contact_form_submit`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `contact_form_submit`
4. Name it: `CE - contact_form_submit`
5. Click **Save**

#### Trigger 8: `CE - logout`
1. Click **New**
2. Select **Custom Event**
3. **Event name:** `logout`
4. Name it: `CE - logout`
5. Click **Save**

---

## Part 4: Create GA4 Event Tags

### Step 4.1: Navigate to Tags

1. Click **Tags** in the left sidebar
2. Click **New**

### Step 4.2: Create Each Event Tag

#### Tag 1: `GA4 Event - login`

1. Click **Tag Configuration**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `login`
5. Expand **Event Parameters**
6. Click **Add Row** and add:
   | Parameter Name | Value |
   |----------------|-------|
   | `method` | `{{dlv - method}}` |
   | `user_id` | `{{dlv - user_id}}` |
7. Click **Triggering**
8. Select `CE - login`
9. Name the tag: `GA4 Event - login`
10. Click **Save**

#### Tag 2: `GA4 Event - sign_up`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `sign_up`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `method` | `{{dlv - method}}` |
   | `user_id` | `{{dlv - user_id}}` |
6. Click **Triggering** → Select `CE - sign_up`
7. Name: `GA4 Event - sign_up`
8. Click **Save**

#### Tag 3: `GA4 Event - add_to_cart`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `add_to_cart`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `currency` | `{{dlv - currency}}` |
   | `value` | `{{dlv - value}}` |
   | `items` | `{{dlv - items}}` |
6. Click **Triggering** → Select `CE - add_to_cart`
7. Name: `GA4 Event - add_to_cart`
8. Click **Save**

#### Tag 4: `GA4 Event - view_item`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `view_item`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `currency` | `{{dlv - currency}}` |
   | `value` | `{{dlv - value}}` |
   | `items` | `{{dlv - items}}` |
6. Click **Triggering** → Select `CE - view_item`
7. Name: `GA4 Event - view_item`
8. Click **Save**

#### Tag 5: `GA4 Event - generate_lead`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `generate_lead`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `currency` | `{{dlv - currency}}` |
   | `value` | `{{dlv - value}}` |
   | `lead_type` | `{{dlv - lead_type}}` |
   | `items_count` | `{{dlv - items_count}}` |
6. Click **Triggering** → Select `CE - generate_lead`
7. Name: `GA4 Event - generate_lead`
8. Click **Save**

#### Tag 6: `GA4 Event - share`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `share`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `method` | `{{dlv - method}}` |
   | `content_type` | `{{dlv - content_type}}` |
6. Click **Triggering** → Select `CE - share`
7. Name: `GA4 Event - share`
8. Click **Save**

#### Tag 7: `GA4 Event - contact_form_submit`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `contact_form_submit`
5. Add Event Parameters:
   | Parameter Name | Value |
   |----------------|-------|
   | `subject` | `{{dlv - subject}}` |
6. Click **Triggering** → Select `CE - contact_form_submit`
7. Name: `GA4 Event - contact_form_submit`
8. Click **Save**

#### Tag 8: `GA4 Event - logout`

1. Click **New**
2. Select **Google Analytics: GA4 Event**
3. **Configuration Tag:** Select `GA4 - Configuration`
4. **Event Name:** `logout`
5. No additional parameters needed
6. Click **Triggering** → Select `CE - logout`
7. Name: `GA4 Event - logout`
8. Click **Save**

---

## Part 5: Preview and Test

### Step 5.1: Enable Preview Mode

1. Click **Preview** button (top right of GTM)
2. Enter your website URL: `https://www.drweee.com`
3. Click **Connect**
4. A new browser tab will open with your website
5. The Tag Assistant panel will appear at the bottom

### Step 5.2: Test Each Event

Test the following actions and verify events fire in Tag Assistant:

| Action to Test | Expected Event | Where to Test |
|----------------|----------------|---------------|
| Login with phone/password | `login` | Login page |
| Create new account | `sign_up` | Login page → Register |
| Click on a product | `view_item` | Store page |
| Add product to cart | `add_to_cart` | Store page |
| Submit pickup request | `generate_lead` | WEEE Rewards page |
| Share certificate on LinkedIn | `share` | Environmental Impact page |
| Share certificate on Twitter | `share` | Environmental Impact page |
| Share certificate on Facebook | `share` | Environmental Impact page |
| Share certificate on WhatsApp | `share` | Environmental Impact page |
| Copy certificate link | `share` | Environmental Impact page |
| Submit contact form | `contact_form_submit` | Contact page |
| Logout | `logout` | Any page (header) |

### Step 5.3: Verify in Tag Assistant

For each action:
1. Perform the action on the website
2. Check the Tag Assistant panel
3. You should see:
   - The custom event trigger firing
   - The corresponding GA4 Event tag firing
4. Click on the tag to verify parameters are captured correctly

---

## Part 6: Publish Changes

### Step 6.1: Submit for Publishing

1. Click **Submit** button (top right)
2. Enter a version name: `GA4 Event Tracking Implementation`
3. Add description:
   ```
   Added GA4 event tracking for:
   - Login/Sign up events
   - E-commerce events (view_item, add_to_cart)
   - Lead generation (pickup requests, contact form)
   - Social sharing events
   - Logout events
   ```
4. Click **Publish**

---

## Part 7: Verify in GA4 (Real-Time)

### Step 7.1: Check Real-Time Reports

1. Go to [Google Analytics](https://analytics.google.com/)
2. Select your GA4 property
3. Navigate to **Reports** → **Realtime**
4. Perform actions on your website
5. You should see events appearing in real-time

### Step 7.2: Check DebugView

1. In GA4, go to **Admin** (gear icon)
2. Under **Data Display**, click **DebugView**
3. Enable debug mode in your browser:
   - Install [Google Analytics Debugger](https://chrome.google.com/webstore/detail/google-analytics-debugger/jnkmfdileelhofjcijamephohjechhna) Chrome extension
   - Or add `?debug_mode=true` to your URL
4. Perform actions and watch events appear with full parameter details

---

## Part 8: Configure Custom Dimensions (Optional but Recommended)

To see event parameters in GA4 reports, you need to register them as custom dimensions.

### Step 8.1: Create Custom Dimensions

1. In GA4, go to **Admin** → **Custom definitions**
2. Click **Create custom dimension**
3. Create the following:

| Dimension Name | Scope | Event Parameter |
|----------------|-------|-----------------|
| Lead Type | Event | `lead_type` |
| Items Count | Event | `items_count` |
| Subject | Event | `subject` |
| Content Type | Event | `content_type` |

4. Click **Save** for each

> Note: `method`, `user_id`, `currency`, `value`, and `items` are automatically recognized by GA4 for standard events.

---

## Part 9: Create Key Events (Conversions)

Mark important events as conversions to track them prominently.

### Step 9.1: Mark Events as Conversions

1. In GA4, go to **Admin** → **Events**
2. Wait for events to appear (may take 24-48 hours)
3. Find these events and toggle **Mark as key event**:
   - `sign_up`
   - `generate_lead`
   - `add_to_cart`
   - `contact_form_submit`

---

## Summary Checklist

### GTM Components Created:

- [ ] 1 GA4 Configuration Tag
- [ ] 11 Data Layer Variables
- [ ] 8 Custom Event Triggers
- [ ] 8 GA4 Event Tags

### Events Being Tracked:

| Event | Description | Key Parameters |
|-------|-------------|----------------|
| `login` | User logs in | method, user_id |
| `sign_up` | New user registers | method, user_id |
| `view_item` | Product viewed | items, value, currency |
| `add_to_cart` | Product added to cart | items, value, currency |
| `generate_lead` | Pickup request or contact | lead_type, items_count, value |
| `share` | Certificate shared | method, content_type |
| `contact_form_submit` | Contact form submitted | subject |
| `logout` | User logs out | - |

---

## Troubleshooting

### Events not appearing in GA4?

1. **Check GTM Preview:** Ensure tags are firing
2. **Check browser console:** Look for dataLayer pushes
   ```javascript
   // Type this in browser console to see dataLayer
   console.log(dataLayer);
   ```
3. **Wait time:** GA4 reports can take 24-48 hours to populate
4. **Use DebugView:** Real-time debugging in GA4

### Parameters showing as (not set)?

1. Verify Data Layer Variable names match exactly
2. Check that the event is pushing the parameter correctly
3. Custom dimensions need to be created in GA4 for non-standard parameters

### Need Help?

- [GTM Documentation](https://support.google.com/tagmanager)
- [GA4 Documentation](https://support.google.com/analytics)
- [GTM Community](https://www.googletagmanagercommunity.com/)

---

*Document created for DR.WEEE - Smart Green IT Solutions*
*Last updated: December 2024*
