# 🖤 DERMIS
### Digital Enhanced Reminder & Management Intelligence System
*Your tattoo studio AI assistant — powered by Twilio & Google Calendar*

DERMIS automatically sends WhatsApp reminders to your clients (and yourself) based on your Google Calendar sessions — powered by Twilio.

---

## What it does

| Time | Action |
|------|--------|
| **09:00 daily** | Sends 24h reminder to tomorrow's clients + copy to you |
| **18:00 daily** | Sends aftercare instructions to today's clients |
| **09:00 daily** | Sends day-3 healing check-in to clients from 3 days ago |
| **09:00 daily** | Sends 7-day healing check-in to clients from 7 days ago |

---

## Google Calendar format

**Event title:**
```
session_Firstname_Lastname
```
Examples: `session_Noa_Cohen`, `session_Maya_Levi`

**Event description (only line needed):**
```
Phone: 0501234567
```

## Web app

DERMIS includes a password-protected web app with:

- **🔐 Login** at `/login` — protects all pages except the Twilio webhook
- **📥 Inbox** at `/inbox` — view all client replies, mark as read
- **✏️ Templates** at `/templates` — edit all WhatsApp message templates live
- **🚪 Logout** at `/logout` — destroys your session

The password is set via `ARTIST_PASSWORD` in `.env`. Sessions last 30 days.

---

## Setup

### Step 1 — Install dependencies
```bash
npm install
```

### Step 2 — Create your .env file
```bash
cp .env.example .env
```
Then fill in your values:
- `TWILIO_ACCOUNT_SID` — from twilio.com/console
- `TWILIO_AUTH_TOKEN` — from twilio.com/console
- `TWILIO_WHATSAPP_NUMBER` — your WhatsApp Business number, format: `whatsapp:+972XXXXXXXXX`
- `YOUR_WHATSAPP_NUMBER` — your personal number for reminder copies
- `GOOGLE_CALENDAR_ID` — found in Google Calendar → Settings → Integrate calendar

### Step 3 — Set up Google Calendar API

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. "Tattoo Bot")
3. Enable the **Google Calendar API**
4. Go to **IAM & Admin → Service Accounts** → Create service account
5. Download the JSON key → save as `google-credentials.json` in this folder
6. In Google Calendar → Settings → Share with specific people → add the service account email with **"See all event details"** permission

### Step 4 — Run the bot
```bash
node index.js
```

---

## Deploy to Railway (free hosting)

1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Add all your `.env` variables in Railway's environment settings
4. Upload `google-credentials.json` as a secret file
5. Done — Railway keeps it running 24/7 for free

---

## Customise messages

Edit `messages.js` to change any of the WhatsApp templates. Each function receives the client's first name and returns the message string.

---

## File structure

```
tattoo-bot/
├── index.js          ← Main bot — all scheduled jobs
├── calendar.js       ← Reads sessions from Google Calendar
├── whatsapp.js       ← Sends messages via Twilio
├── messages.js       ← All WhatsApp message templates
├── .env.example      ← Copy to .env and fill in your credentials
└── README.md
```
