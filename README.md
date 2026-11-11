# Pickle Time 🏓

A LINE web app (LIFF) that helps a group of friends find a common free time to play pickleball.

- **Log in with LINE** (LIFF + LINE Login, ID token verified on the server).
- **Create a group** and get a **4-character join code** (e.g. `K7QM`). Friends enter the code, or tap the invite link, to join.
- **Invite** sends the code and link straight into a LINE chat (share target picker).
- **My free time**: tap or drag across a weekly grid (06:00–22:00, next 4 weeks) to mark the hours you're free. Saves automatically.
- **Best times**: a heat map of how many friends are free each hour, plus the top 5 time blocks with the most people free and who they are.

Stack: Node.js 20+ + Express, [Turso](https://turso.tech) (hosted SQLite, free tier) for data, plain HTML/CSS/JS. Runs on Render's free plan. Locally it uses a SQLite file, so no account is needed to try it.

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
| `TURSO_DATABASE_URL` | in production | e.g. `libsql://pickle-time-yourname.turso.io`. If unset, a local file is used. |
| `TURSO_AUTH_TOKEN` | in production | Turso database token |
| `DB_PATH` | no | Local SQLite file when Turso isn't set. Default `./data.sqlite`. |
| `DEV_LOGIN` | no | `1` turns on the name-only test login. **Never enable in production.** |

## Deploy for free (Render + Turso)

**1. Database (Turso, free)**
1. Sign up at [turso.tech](https://turso.tech) (you can use your GitHub account).
2. Create a database, e.g. `pickle-time`, in a region near you (Singapore for Thailand).
3. Copy its **URL** (`libsql://…turso.io`) and create a **token** for it.

The app creates its tables on first start.

**2. Web app (Render, free)**
1. On [Render](https://render.com), choose **New → Blueprint** and pick this repo. It reads `render.yaml` (free plan).
2. Fill in `LIFF_ID`, `LINE_CHANNEL_ID`, `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` when asked.
3. Put the Render URL (e.g. `https://pickle-time.onrender.com/`) into the LIFF Endpoint URL.

Render's free plan sleeps after ~15 minutes without visitors; the first open after that takes 30–60 seconds. Data is safe in Turso.

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
