# Learning & Implementation Guide

## Broker Authentication Services

This project supports multiple broker integrations with OAuth-based authentication. Each broker has its own service class:

- **ANT** - Alice Blue's Advanced Nest Technology (OAuth with checksum)
- **Zerodha** - Zerodha's Kite API (request_token exchange)

## ANT (Alice Blue) Authentication

### Overview
Alice Blue's ANT (Advanced Nest Technology) uses direct API-based authentication (not OAuth). This implementation provides a clean, singleton-based service for handling the ANT authentication flow.

**Important:** Alice Blue ANT does NOT use OAuth redirects. Instead, it uses an encKey/checksum-based session flow.

### Architecture

**Service Class:** `src/ant/ANT.ts`
- Singleton pattern for centralized ANT configuration
- Handles OAuth authorization URL generation
- Manages authorization code to access token exchange

**Integration:** `src/server.ts` (endpoints only)
- `/auth/ant-login` - Initiates OAuth flow
- `/auth/ant-callback` - Handles OAuth callback

### Configuration

Edit `src/ant/ANT.ts` (lines 11-12) with your Alice Blue credentials:

```typescript
private userId = 'your_user_id';     // Alice Blue user ID
private apiKey = 'your_api_key';     // Alice Blue API key
```

**How to get credentials:**
- **userId**: Your Alice Blue account user ID
- **apiKey**: Your Alice Blue API key from developer console

### Authentication Flow (OAuth with Checksum)

1. **User initiates login**
   ```
   GET /auth/ant-login
   ```
   - Redirects to Alice Blue OAuth authorization page

2. **User authenticates with Alice Blue**
   - User enters credentials on Alice Blue's login page
   - Grants permission to application

3. **Alice Blue redirects back** (transparent to user)
   ```
   GET /auth/ant-callback?authCode=AUTH_CODE&userId=USER_ID
   ```
   - Server receives authorization code and user ID
   - **Step 1:** Compute checksum = SHA256(userId + authCode + apiSecret)
   - **Step 2:** POST checksum to `https://a3.aliceblueonline.com/open-api/od/v1/vendor/getUserDetails`
   - **Step 3:** Receive userSession token in response
   - Store token in memory and HTTP-only cookie
   - Redirect to `/app` (no query params - implementation transparent)

4. **Token available for API calls**
   - Stored in secure HTTP-only cookie `ant_session`
   - Can retrieve via `GET /auth/ant-token` if needed
   - Used as Bearer token for Alice Blue ANT API calls

### API Endpoints

#### GET /auth/ant-login
Initiates Alice Blue ANT OAuth login flow.

**Response (302 Redirect):**
- Redirects to Alice Blue OAuth authorization page
- No body/JSON response needed

**Usage:**
```javascript
// Simple redirect - no API call needed
window.location.href = '/auth/ant-login';

// Or in a link
<a href="/auth/ant-login">Login with Alice Blue</a>
```

#### GET /auth/ant-callback
Handles OAuth callback from Alice Blue. Called automatically by Alice Blue after user authorization.

**Query Parameters (from Alice Blue):**
- `authCode` - Authorization code from Alice Blue
- `userId` - User ID from Alice Blue

**Response (302 Redirect):**
- Success: Redirects to `/app` (transparent to user)
- Failure: Returns 500 error with details

**Side effects:**
- User session token stored in memory
- Cookie set: `ant_session` - Signed HTTP-only cookie containing user session
- User is now authenticated

#### GET /auth/ant-token
Retrieves the stored ANT access token for frontend use.

**Response (200):**
```json
{
  "access_token": "session_id_value"
}
```

**Response (401):**
```json
{
  "error": "No ANT access token available. Please login first."
}
```

**Usage in Frontend:**
```javascript
const response = await fetch('/auth/ant-token');
const { access_token } = await response.json();
localStorage.setItem('ant_token', access_token);
```

### Important: No Redirect URL Needed

Unlike OAuth, ANT authentication does NOT require registering a redirect URL. It's a direct API-based flow using SHA256 checksum authentication.

### Usage Example

**Client-side flow:**

```javascript
// Step 1: Get authorization URL
const loginRes = await fetch('/auth/ant-login');
const { url } = await loginRes.json();

// Step 2: Redirect user to Alice Blue
window.location.href = url;

// Step 3: Handle callback
// Alice Blue redirects to /auth/ant-callback with code
// Backend automatically exchanges code for token
// Token is returned in response and stored in cookie
```

### ANT Service Methods

**ANT.getInstance()** - Get singleton instance
```typescript
const ant = ANT.getInstance();
```

**getAuthorizationUrl()** - Get OAuth authorization URL
```typescript
const url = ant.getAuthorizationUrl();
```

**exchangeCodeForToken(code)** - Exchange code for access token
```typescript
const tokenData = await ant.exchangeCodeForToken(code);
// Returns: { access_token, token_type, expires_in }
```

**Configuration setters**
```typescript
ant.setAppKey('new_app_key');
ant.setAppSecret('new_app_secret');
ant.setRedirectUri('http://localhost:3000/auth/ant-callback');
```

### Error Handling

The service throws descriptive errors if:
- Authorization code is invalid
- Token exchange fails
- Alice Blue API is unreachable

All errors are caught and returned as JSON responses with details.

### Security Notes

- Access tokens are stored in HTTP-only, signed cookies (cannot be accessed via JavaScript)
- Tokens are not exposed in URLs
- HTTPS recommended for production use
- App Secret should never be exposed to client-side code

## Code Organization Best Practices

### Service Class Placement

**Rule:** Feature-specific logic should be in dedicated service classes, not in server.ts

**Why:** Keeps server.ts clean and focused on routing. Services are reusable, testable, and maintainable.

**How to apply:**
- Create a new folder for the feature: `src/[feature]/`
- Implement the business logic in a service class: `src/[feature]/[Feature].ts`
- Use singleton pattern for services that need single instances
- Import and use the service in server.ts endpoints

**Example (ANT Service):**
```
✅ GOOD:
- Business logic in: src/ant/ANT.ts (singleton service)
- Integration in: src/server.ts (endpoints only)

❌ BAD:
- Hardcoded constants in: src/server.ts
- All logic mixed with route handlers
```

### Configuration Management

**Rule:** Never hardcode configuration in server.ts

**Why:** Makes the codebase harder to modify and audit

**How to apply:**
- Define configuration in service class with setter methods
- Keep credentials and endpoints in one place
- Allow configuration to be overridden programmatically

### Code Changes Policy

**Rule:** Only owner's service class should contain the business logic

**Why:** Maintains separation of concerns and makes debugging easier

**What this means:**
- Endpoints in server.ts should be thin wrappers
- Real logic lives in the service class
- Changes to a feature should only touch its service class and learning.md

## Documentation Updates

Whenever a correction or improvement is suggested:
1. Implement the fix in the appropriate service class
2. Update learning.md with the reasoning and best practice
3. Reference the change in CLAUDE.md if it affects the main architecture

## Verification Protocol

**ALWAYS verify implementations before claiming they work:**
1. Check TypeScript compilation for errors
2. Add comprehensive logging to trace execution
3. Test actual API calls with real responses
4. Don't assume external API behavior - verify or research it
5. If integration with external service, check their documentation/SDKs

**Never claim "this will work" without:**
- ✓ Compilation verification
- ✓ Testing the actual endpoint
- ✓ Seeing real API responses
- ✓ Checking error cases

## Corrections & Improvements

### MAJOR: ANT Does NOT Use OAuth - Uses encKey/Checksum Flow

**Issue:** Initial implementation attempted to use OAuth redirects with Alice Blue ANT.

**Root Cause:** Alice Blue ANT does not support OAuth redirect flow. It uses a direct API-based authentication with encKey and SHA256 checksum.

**Correction:** Completely rewrote authentication to use correct flow:
1. Get encKey from API
2. Compute SHA256(userId + apiKey + encKey)
3. Get session ID using checksum

**Files Updated:**
- `src/ant/ANT.ts` - Replaced OAuth methods with `.login()` using encKey/checksum flow
- `src/server.ts` - Changed from GET `/auth/ant-login` (redirect) to POST `/auth/ant-login` (direct API call)
- `learning.md` - Completely updated documentation

**Why This Matters:**
- No redirect URL configuration needed
- Direct API authentication (more reliable)
- Uses SHA256 checksum for security
- No browser redirects required

**New Usage:**
```javascript
// Instead of redirecting, send credentials directly
const response = await fetch('/auth/ant-login', {
  method: 'POST',
  body: JSON.stringify({ userId, apiKey })
});
const { accessToken } = await response.json();
```

### ANT OAuth Endpoint URL Correction (DEPRECATED)

**Issue:** Initial implementation used `https://www.aliceblueonline.com/oauth2/` for OAuth endpoints.

**Correction:** Updated to use `https://ant.aliceblueonline.com/oauth2/` (matching the base API URL used in AntBroker).

**Why:** Alice Blue ANT API uses `ant.aliceblueonline.com` as the primary endpoint for all API operations. OAuth endpoints are located here too.

**Files updated:**
- `src/ant/ANT.ts` - Added `private baseUrl = 'https://ant.aliceblueonline.com'`
- Authorization and token endpoints now use this base URL

### ANT Login Endpoint: JSON Response to 302 Redirect

**Issue:** `/auth/ant-login` returned JSON with URL, requiring manual copy-paste to browser.

**Correction:** Updated to use HTTP 302 redirect, automatically sending user to Alice Blue OAuth page.

**Why:** Better user experience - the endpoint now initiates the OAuth flow directly instead of requiring manual steps.

**Files updated:**
- `src/server.ts` - Changed `res.json()` to `res.redirect(302, authorizationUrl)`
- Removed need for manual URL handling on client

**How to use:**
```javascript
// Client: Simply navigate to the endpoint
window.location.href = '/auth/ant-login';
// Browser automatically redirects to Alice Blue OAuth page
```

### ANT Callback: Automatic Token Retrieval for Frontend

**Issue:** After OAuth callback, user saw JSON response but frontend had no automatic way to get the token.

**Correction:** 
1. `/auth/ant-callback` now automatically redirects to app dashboard
2. Added `/auth/ant-token` endpoint to retrieve stored token programmatically
3. Token stored in memory and HTTP-only cookie for security

**Why:** The program handles everything automatically - frontend calls `/auth/ant-token` to get the token after redirect.

**Files updated:**
- `src/server.ts`:
  - Callback now redirects to `/app?ant_auth=success` (or with error if failed)
  - Added `antAccessToken` in-memory storage
  - Added `/auth/ant-token` endpoint for frontend token retrieval

**How it works:**
```javascript
// 1. User clicks login
window.location.href = '/auth/ant-login';

// 2. Auto-redirected through Alice Blue OAuth
// 3. Auto-redirected back to /app?ant_auth=success

// 4. Frontend detects success and retrieves token
const response = await fetch('/auth/ant-token');
const { access_token } = await response.json();

// 5. Store and use token for API calls
localStorage.setItem('ant_token', access_token);
```

## Zerodha (Kite API) Authentication

### Overview
Zerodha uses request_token-based authentication. Users login to Zerodha, which returns a request_token that's exchanged for an access_token using the API secret.

### Service Location
`src/zerodha/Zerodha.ts` - Singleton service wrapping KiteConnect library

### Configuration

Update credentials in `src/zerodha/Zerodha.ts` (lines 11-12):

```typescript
private apiKey = '8ugdwlq4fz81o218';
private apiSecret = '914b3mcaxlx94jfmleikmexysueqohmn';
```

Same pattern as ANT - credentials hardcoded in the service class, no .env dependency.

### Authentication Flow

1. **User initiates login** → `GET /auth/zerodha-login`
   - Redirects to Zerodha login page

2. **User authenticates with Zerodha**
   - Enters credentials on Zerodha's page

3. **Zerodha redirects back** (transparent)
   - URL: `GET /auth/zerodha-callback?request_token=TOKEN&status=success`
   - Server calls `kc.generateSession(requestToken, apiSecret)`
   - Receives access_token
   - Stores in memory and HTTP-only cookie
   - Redirects to `/app`

4. **Token available for API calls**
   - Cookie: `zerodha_session`
   - Endpoint: `GET /auth/zerodha-token`
   - Use for Kite API operations

### API Endpoints

**GET /auth/zerodha-login**
- Redirects to Zerodha login page

**GET /auth/zerodha-callback**  
- Handles callback from Zerodha (automatic)
- Stores access_token
- Redirects to `/app`

**GET /auth/zerodha-token**
- Returns stored access token
- Response: `{ "access_token": "..." }`

### Broker Comparison

| Feature | ANT | Zerodha |
|---------|-----|---------|
| Type | OAuth with checksum | Request token |
| Endpoint | A3 API | Kite API |
| Library | Custom axios | KiteConnect SDK |
| Session Storage | Cookie + memory | Cookie + memory + file |
