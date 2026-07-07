# Adobe Express Bulk Image Generator — Desktop Setup

This tool runs a Tampermonkey userscript in Chrome that logs into a queue of Adobe Express accounts, generates one image per account using a fixed prompt, saves it to your Downloads folder, and signs out. Accounts are pulled from a shared Supabase queue, so multiple people on different computers can process the same list at the same time without stepping on each other.

Read the whole page once before starting. The first-time setup is ~10 minutes; after that, running it is one click.

---

## 1. Requirements

- **Google Chrome** (or a Chromium-based browser: Edge, Brave). Firefox works but Chrome is what everything below assumes.
- **Windows, macOS, or Linux** — any desktop OS.
- A **Supabase worker account** (email + password) — get from your admin.
- A **stable internet connection**.
- **Free disk space** for the images (~1 MB per generated image).

---

## 2. One-time setup (do this once per computer)

### 2.1 Install Tampermonkey

1. Open the [Chrome Web Store — Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) page.
2. Click **Add to Chrome** → **Add extension**.
3. Pin the Tampermonkey icon: click the puzzle-piece icon in Chrome's toolbar → pin Tampermonkey.

### 2.2 Install the userscript

1. Open this URL in Chrome:
   ```
   https://raw.githubusercontent.com/0ttforall/kati-patang/main/automator.user.js
   ```
2. Tampermonkey will show an install prompt.
3. Click **Install**. That's it — the script now auto-runs on Adobe Express, Microsoft Login, and related Adobe auth pages.

Verify: Click the Tampermonkey icon → *Dashboard*. You should see "Adobe Express Automator" listed and enabled.

### 2.3 Allow automatic downloads on Adobe Express

By default Chrome asks for permission before the second and subsequent downloads from a site. This will block the automation. Whitelist Adobe Express once:

1. Open [https://new.express.adobe.com/](https://new.express.adobe.com/) in Chrome.
2. Click the **tune/lock icon** to the left of the URL in the address bar.
3. Click **Site settings**.
4. Scroll to **Automatic downloads** and change from *Ask* (default) to **Allow**.
5. Close the settings tab. That's it — Chrome will save every image silently.

Alternative: Chrome ⋮ menu → *Settings* → *Privacy and security* → *Site settings* → *Additional content settings* → *Automatic downloads* → *Add* → `https://new.express.adobe.com` → *Allow*.

### 2.4 Sign in to the Supabase worker account

1. Reload `https://new.express.adobe.com/` in Chrome.
2. A small dark panel titled **"Adobe Automator"** appears in the bottom-left corner. If you don't see it, re-check step 2.2.
3. Enter your Supabase worker email + password (given by admin) and click *Sign in*.
4. The panel should now show `Hi <your email>` at the top.

---

## 3. Running the automation

1. Open `https://new.express.adobe.com/` in Chrome (any full window).
2. Confirm the **Adobe Automator** panel is visible (bottom-left) and shows your worker email.
3. Click **Start**.
4. Leave the tab alone. It will cycle through accounts one at a time, generating and downloading one image per account.

Each account takes roughly **60–120 seconds** end-to-end (login, generate, download, logout).

Downloaded images land in your default Chrome Downloads folder with names like `Peacock and Peahen (1).png`, `Peacock and Peahen (2).png`, etc.

To stop: click **Pause** in the panel. It stops cleanly after the current account.

---

## 4. Best practices while it's running

- **Keep the browser open and the tab visible.** Chrome throttles background timers — if the tab is buried behind other windows, the script may stall.
- **Don't interact with the tab.** Every click or keystroke risks confusing the UI-detection selectors. Use a different window/browser for anything else.
- **Plug the laptop in.** Long runs are CPU/network-heavy and drain battery fast.
- **Don't close Chrome mid-run.** In-flight downloads get cancelled.
- **Empty the Downloads folder periodically** so it doesn't bloat.
- **Don't run two instances on the same computer.** They'd fight for the same tab.
- **You can run instances on multiple computers.** Each worker will claim different rows from the shared queue automatically.

---

## 5. What a normal log looks like

The bottom-left panel shows a rolling log. A healthy account run looks like:

```
Claiming next account…
Claimed abc@nv.aeedu.in (id 123)
Not signed in — skipping logout
Loaded on new.express.adobe.com
Not on prompt/editor URL (@/) — navigating to target prompt
Loaded on auth.services.adobe.com
Login loop on Adobe auth
Filling email
Filling password
Loaded on login.microsoftonline.com
Login loop on Microsoft
Filling password
Clicking No on "Stay signed in"
Loaded on auth.services.adobe.com
Loaded on new.express.adobe.com
Editor flow @ /new?prompt=…
Clicking "Open in editor" (enabled)
Clicking download button (sp-button)
Clicking final Download (sp-button)
Download click detected (a.click, blob:https://…)
Marking done (78.4s)
Logging out after download
Attempting Adobe UI logout
Clicking profile (div)
Clicking Sign out
Sign-out confirmed
```

Between accounts you'll briefly see `Claiming next account…` and the cycle repeats.

---

## 6. Troubleshooting

| Symptom | What it means | What to do |
|---|---|---|
| No `Adobe Automator` panel on Express | Userscript not running | Check Tampermonkey → Dashboard → script is *enabled*. Reload the tab. |
| `No pending accounts — sleeping` | Queue is empty (or all pending have been claimed) | Nothing to do. Sleep waits 30s and re-checks. |
| `Watchdog: idle 300s — restarting from prompt URL` | Adobe silently stalled; the script auto-restarted | Normal recovery. If it repeats > 3 times in a row, close Chrome fully and reopen. |
| `Warning: download interception did not confirm save` | The final Download click didn't hit the expected anchor | Usually a one-off. Row is marked done and retried later if needed. Check `chrome://downloads` — if entries are landing anyway, ignore. |
| `UI logout failed — aborting claim` | Adobe sign-out UI didn't confirm | Row is returned to the queue as `failed` and will be retried on the next pass by any worker. |
| Image not appearing in Downloads folder | Automatic downloads not allowed for Adobe Express | Re-do step 2.3. Verify by checking `chrome://downloads` — if the entry says "Blocked", it's the site setting. |
| Chrome shows "Multiple downloads?" prompt | Same as above | Click *Allow* now (one-off), and complete step 2.3 to avoid the prompt in future runs. |
| Tab keeps redirecting between adobe.com / microsoftonline.com / auth.services.adobe.com | Adobe's normal login/redirect chain | Wait it out — this is expected during login. |
| A run has been on the same account > 5 minutes | Probably stalled | The watchdog will restart at 5 min. If it doesn't recover after two restarts, pause and reload. |

---

## 7. Where to look when something's wrong

1. **Tampermonkey panel** (bottom-left of Express tab) — live log of what the script is doing.
2. **Chrome downloads page** (`chrome://downloads`) — shows every attempted download and whether it succeeded, was blocked, or failed.
3. **Supabase dashboard** — check the `accounts` table for status counts (`pending`, `claimed`, `done`, `failed`) and `worker_stats` view for per-worker totals.

---

## 8. Stopping and pausing

- **Pause** button — stops after the current account completes cleanly.
- **Sign out** button — logs out of the Supabase worker account (does NOT sign out of Adobe). Use if you're handing the computer to someone else.

If Chrome crashes or you have to hard-close, the currently-claimed row will time out after 5 minutes and be re-claimed by another worker automatically.

---

## 9. Support

- Issues with a specific account (login fails, no image generated): mark it in the shared tracker — admin can inspect.
- Bugs in the script itself: report to the repo owner with a screenshot of the panel log and the account email.
