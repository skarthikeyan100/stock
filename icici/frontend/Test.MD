# Manual Test Plan — User Management with Real Shoonya Server

## Prerequisites
- Shoonya broker is accessible and OTP login works
- MongoDB running on localhost:27017
- Google OAuth Client ID configured (authorized origins include localhost:3000)
- Backend: `cd icici && npm run server`
- Frontend: `cd icici/frontend && npm run dev`

---

## 1. Auth Flow

### 1.1 Login
- Open `http://localhost:5173/app`
- Verify Google Sign-In button is displayed
- Click Sign In, complete Google auth
- Verify redirect to `/app/rules`
- Check backend console: `POST /auth/login` received with email, name, picture
- Check MongoDB `stocks.users` collection has the user entry

### 1.2 Session Persistence
- After login, refresh the page
- Verify user remains logged in (not redirected to login page)
- Check browser cookies: `session` cookie exists (signed, httpOnly)

### 1.3 Logout
- Click Logout button on trading page header
- Verify redirect to `/app` (login page)
- Refresh page — should stay on login, not auto-login

### 1.4 Protected Routes
- Without logging in, navigate directly to `/app/trade` — should redirect to `/app`
- Without logging in, navigate to `/app/admin` — should redirect to `/app`
- Without logging in, navigate to `/app/rules` — should redirect to `/app`

---

## 2. Trading — User Identity

### 2.1 Login and Place Order via Trend Button
- Login with User A
- Navigate to Rules -> Accept -> Trading page
- Verify header shows User A's name and Google profile picture
- Click Up or Down trend button
- Check backend console: `/order` received with `user = <User A email>`
- Verify trade appears in Active Positions

### 2.2 Verify Position Stream is Per-User
- Open a second browser (or incognito) and login as User B
- User A places an order
- Verify User B does NOT see User A's trade in their position list
- Verify User A sees only their own trade

### 2.3 Place Order via Contract Search
- Type a symbol in the search box (e.g., "24000 C")
- Select from dropdown, click Buy
- Check backend console: `/order` with `contract=<selected symbol>` and correct user
- Verify trade appears for this user only

### 2.4 Square Off
- With an active trade, click Square Off
- Check backend console: `/squareoff` received with correct user
- Verify trade moves to Closed Trades for this user
- Verify the other user's view is unaffected

### 2.5 /trades Endpoint Filtering
- User A has an active trade, User B has none
- `curl http://localhost:3000/trades -H "X-User-Id: <User A email>"` — should return User A's trade
- `curl http://localhost:3000/trades -H "X-User-Id: <User B email>"` — should return empty array

---

## 3. Per-User Loss Limit

### 3.1 Default Loss Limit
- Login as a new user (first time)
- Check MongoDB: user has `lossLimit: 15000`
- On trading page, verify warning appears at 80% of 15000 (i.e., when loss >= 12000)

### 3.2 Custom Loss Limit via Admin
- Login as admin, go to `/app/admin`
- Change User A's loss limit to 5000
- Login as User A, place a trade
- Verify warning threshold is now 80% of 5000 (loss >= 4000)
- Verify order is rejected when loss reaches 5000

### 3.3 Loss Limit Enforcement on Backend
- Set a user's loss limit to a small value (e.g., 100) via admin
- Simulate losses exceeding that limit
- Attempt to place a new order — backend should return 403 with reason message
- Frontend should display the rejection error

---

## 4. Admin Dashboard

### 4.1 Access Control
- Login as a regular user (role = 'user')
- Navigate to `/app/admin` — should redirect to `/app`
- In MongoDB, manually set user's role to 'admin': `db.users.updateOne({email: "..."}, {$set: {role: "admin"}})`
- Refresh — `/app/admin` should now be accessible

### 4.2 User List
- With multiple users logged in and trading, open admin dashboard
- Verify all registered users appear in the table
- Verify each user shows: name, email, profile picture, lossLimit, lotSize, session P&L, active trade status

### 4.3 Edit User Settings
- Click Edit on a user row
- Change lossLimit to 10000 and lotSize to 2
- Click Save
- Verify the table updates
- Check MongoDB: user document has updated values
- Check backend: `Monitor.userSettingsCache` has the new lossLimit

### 4.4 Session P&L Display
- User A places a trade that gains/loses value
- Admin dashboard should show User A's current session P&L (updates every 5 seconds)
- After User A squares off, P&L should reflect the realized amount

---

## 5. Backward Compatibility — Flutter App

### 5.1 X-User-Id Header Still Works
- From Flutter app (or curl), send request with `X-User-Id` header (no cookie)
- `curl "http://localhost:3000/order?index=NIFTY&right=call&action=Buy" -H "X-User-Id: FlutterUser"`
- Verify order is placed with user = 'FlutterUser'
- Verify positionstream and /trades filter by 'FlutterUser' when using header

### 5.2 Cookie Takes Priority Over Header
- Login via web (sets cookie), then send a request with a different `X-User-Id` header
- Verify the cookie email is used, not the header value

---

## 6. Edge Cases

### 6.1 Multiple Tabs Same User
- Login as User A in two tabs
- Place order in Tab 1 — verify Tab 2 also shows the trade via SSE
- Square off in Tab 2 — verify Tab 1 reflects the closure

### 6.2 Expired/Invalid Cookie
- Manually delete or corrupt the session cookie in browser
- Refresh page — should redirect to login
- `/auth/me` should return 401

### 6.3 Simultaneous Users Trading
- User A and User B both logged in
- Both place orders at roughly the same time
- Verify each user sees only their own trades
- Verify admin dashboard shows both users' trades correctly
