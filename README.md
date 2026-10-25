# Nexus Store

This is the Nexus Store Express application.

## Run locally

1. Install Node.js.
2. Open a terminal in this folder.
3. Run `npm install`.
4. Create a `.env` file with at least:

```env
ADMIN_PASSWORD=your-first-admin-password
ADMIN_SECOND_PASSWORD=your-second-admin-password
STORE_CURRENCY=USD
```

5. Run `npm start`.
6. Open `http://localhost:3000`.

## Deploy

This project must be deployed as a **Node.js Web Service**, not GitHub Pages, because
`server.js` provides the `/api/*` routes used by the website.

A service such as Render can connect to the GitHub repository. Use:

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`

Add the environment variables in the hosting dashboard. Never commit `.env`.

For this version, the second admin code is read from `ADMIN_SECOND_PASSWORD`, so the
server can start on a cloud host without an interactive terminal.
