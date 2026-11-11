# Pickle Time 🏓

A LINE web app (LIFF) that helps a group of friends find a common free time to play pickleball.

- **Log in with LINE** (LIFF + LINE Login, ID token verified on the server).
- **Create a group** and get a **4-character join code** (e.g. `K7QM`). Friends enter the code, or tap the invite link, to join.
- **Invite** sends the code and link straight into a LINE chat (share target picker).
- **My free time**: tap or drag across a weekly grid (06:00–22:00, next 4 weeks) to mark the hours you're free. Saves automatically.
- **Best times**: a heat map of how many friends are free each hour, plus the top 5 time blocks with the most people free and who they are.

Stack: Node.js 22 + Express, built-in SQLite (`node:sqlite`), plain HTML/CSS/JS. One dependency.

## Try it locally (no LINE needed)

```bash
npm install
npm run dev        # DEV_LOGIN=1 enables a "type your name" test login
# open http://localhost:3000 in two browsers (e.g. normal + private window)
```

## Set up LINE

1. Go to the [LINE Developers Console](https://developers.line.biz/console/), create a **Provider**, then a **LINE Login** channel.
2. Note the **Channel ID** (Basic settings tab).
3. In the channel's **LIFF** tab, click **Add**:
   - Size: **Full**
   - Endpoint URL: your HTTPS URL, e.g. `https://pickle-time.onrender.com/`
   - Scopes: **openid** and **profile**
   - Turn on **Share target picker** (so the Invite button can send to chats).
4. Note the **LIFF ID** (looks like `1234567890-AbCdEfGh`).
5. Publish the channel (switch it from *Developing* to *Published*) so friends who aren't channel testers can log in.

Your app link to share is `https://liff.line.me/<LIFF ID>`. Invite links add `?code=XXXX` and auto-join the group.

## Configuration

| Variable | Required | Meaning |
|---|---|---|
| `LIFF_ID` | yes | LIFF app ID from the LINE console |
| `LINE_CHANNEL_ID` | yes | Channel ID of the LINE Login channel (used to verify ID tokens) |
| `PORT` | no | Default `3000` |
| `DB_PATH` | no | SQLite file path. Default `./data.sqlite`. Put it on a persistent disk in production. |
| `DEV_LOGIN` | no | `1` turns on the name-only test login. **Never enable in production.** |

## Deploy

Any host that runs Node 22+ over HTTPS with a persistent disk works. For example on **Render**:

1. Push this folder to a GitHub repo. It includes a `render.yaml` Blueprint, so you can use New → Blueprint and skip steps 2–3.
2. New → Web Service → pick the repo. Build: `npm install`. Start: `npm start`.
3. Add a Disk mounted at `/data` and set `DB_PATH=/data/pickle.sqlite`.
4. Set `LIFF_ID` and `LINE_CHANNEL_ID`.
5. Put the service URL into the LIFF Endpoint URL.

Fly.io or Railway (with a volume) work the same way. A plain VPS behind HTTPS (Caddy/nginx) works too.

## API (for reference)

All routes except config/login need `Authorization: Bearer <session token>`.

- `GET /api/config`: LIFF ID and whether dev login is on
- `POST /api/login` `{ idToken }`: verify LINE ID token, returns a session token
- `GET /api/groups`: my groups
- `POST /api/groups` `{ name }`: create a group, returns its 4-character code
- `POST /api/join` `{ code }`: join a group by code
- `GET /api/groups/:id`: group, members, everyone's free slots
- `PUT /api/groups/:id/availability` `{ dates, slots }`: replace my free slots on those dates (slot = `YYYY-MM-DDTHH`, local time)
- `DELETE /api/groups/:id/membership`: leave group (an empty group is deleted)

Times are stored as the phone's local time, so everyone in the group should be in the same time zone (fine for a group of friends in Thailand).
