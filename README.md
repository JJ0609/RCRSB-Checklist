# Power Design Commissioning

A field tool for commissioning systems across multiple projects. Technicians work through each location's devices, record Power / Network / Function checks, and log punch items. Everyone sees the same live data, on a phone, tablet or laptop.

## At a glance

- **Many projects, two sides each:**  projects can have an **AV** side and an **LC** side, with separate devices, locations, checks and punch items.
- **Fast on site:** one tap per check, instant on-screen feedback, and nothing waits on the network.
- **Works offline:** install it like an app, save your projects, and keep working with no signal. Changes sync by themselves.
- **Team visibility:** shared progress, an activity email, and Excel exports of the current state.
- **Admin tools:** create and maintain projects straight from an Info Sheet, with no code changes.

## For the field

### Signing in and finding a project

- Sign in with your email and choose the **AV** or **LC** side. The app remembers your last email.
- The project list can be filtered by **region** and split into **Active** and **Archived**. It only shows projects that have devices on your side.
- **Switch to AV / LC** moves between the two sides of the same project. It's hidden when the other side is empty or you haven't been given access to it.

### Locations

- Every location is a card with a progress bar, a tested count, and a badge: **N open** punch items, **N failed** checks, or **done**.
- The header shows overall **devices tested**, **open punch items** and **failed checks**. Tap the last two to jump straight to those lists.
- **Search** covers locations, devices and models (and Cresnet IDs and controllers on the LC side).
- Add a **new location** at any time.

### Devices and checks

- Each device card shows its model, IP and IP ID, zone, amp channel, switch port, and (on the LC side) Cresnet ID, controller, DIN rail and connection.
- Tap **Power**, **Network** and **Function** to cycle *Untested → Pass → Fail → Untested*. Every change records who made it and when.
- Add or edit a **note** on any device, and add a **new device** (only the name is required).
- The **Failed Checks** view lists every device with a failed check, across all locations.

### Punch items

- Log an item against a **device**, a **location**, or the **whole project** (shown as *General*).
- Each has a **severity** (minor, major, critical) and an **ownership** (Field Tech/Install, Programming, Configuration).
- Items for a location appear on that location's page, just like device items appear under their device.
- **Resolve**, **edit** or **delete** items from the Punch List tab. Deleting asks for confirmation, and the deletion is recorded with who and when.
- Filter by open, resolved or all, and by location, and **export the list to CSV**.
- A half-written punch item is kept if the app closes, and comes back when you return to the project.

### Excel export

- Export a styled **Info Sheet** for any project: the device list with every check result, who last updated it and when (Eastern time), notes, and a **Punch List** sheet.
- The export can be edited and imported back through the admin panel.

### Typing rules

Add Location and Add Device accept letters, numbers, spaces and basic symbols. Emojis and unusual characters are removed as you type, and phone-keyboard characters are converted to plain ones (curly quotes, long dashes, accented letters).

## Works offline

- **Install it:** add it to your Home Screen (iPad/iPhone) or install it as an app in Chrome.
- **Save for offline use:** one tap on the project list stores every active project on the device.
- **Nothing is lost:** check taps, punch items, resolves, edits, deletions and notes made with no signal are saved on the device and sent automatically when you're back online. A banner always shows what's waiting.
- **Safe to retry:** each kind of change can be sent twice without duplicating anything.

## Admin panel

A separate, password-protected page for managing the platform.

| Area | What it does |
| --- | --- |
| **Create a project** | Upload an Info Sheet and set the name and region. |
| **Update devices** | Add new devices and update existing ones from a newer file. Nothing is deleted. |
| **Sync devices** | Make the project match the file exactly. Devices missing from the file are removed, but punch history is kept. |
| **Import results** | Bring an edited Excel export back in to update device details, checks and punch items. |
| **Access** | Grant people access per project and per side, one at a time or in bulk from a spreadsheet. A side with no grants is open to everyone. |
| **Archive / delete** | Move a finished project to Archived, or remove it completely. |
| **Notification emails** | Manage who receives the activity email, and send a test. |

## Supported source files

- **Standard Info Sheets**, including switch port maps.
- **LC sheets**, including controllers and their Cresnet devices.
- **Tables extracted from drawings.** The two extracted lists are combined into one device list. Rack equipment gets its rack's location, and non-network items such as surge protectors are left out. The admin sees a short report of what was combined, skipped or flagged. (Work In Progress).

## Activity emails

When someone finishes a session, and again as a daily catch-up, the team receives a summary of what changed, grouped by project and side:

- checks updated
- new and resolved punch items
- **punch items deleted**, with who deleted them and when
- new locations and devices
- device notes
- projects archived or restored

If nothing changed, nothing is sent.

## Good to know

- **Connection needed for:** adding locations or devices, and everything on the admin page.
- **Updates arrive on refresh,** every few seconds while the app is open, not instantly. Phones can't send in the background, so the app has to be open for waiting changes to go.
- **Two people editing the same item:** the last change wins.
- **Everyone with access** to a project can edit and delete its punch items.
- **Deleting a punch item** hides it everywhere but keeps a record in the database.
- **Times** in exports and emails are US Eastern.
- **Appearance:** light and dark themes, using the Power Design brand colors and fonts.

## Current version

**Last updated: October 2026**
Recent additions:

- Installable app with full offline use and automatic sync
- AV and LC sides on every project, with per-side access
- Punch items can be edited and deleted (deletions are recorded and emailed)
- Location punch items appear on their location page
- Import of device lists extracted from drawings
- Notification recipients managed from the admin panel
- Plain-text rules on Add Location and Add Device

## Built with

Static pages (HTML, CSS and JavaScript, no build step) on GitHub Pages, talking to a private serverless API and a hosted SQLite database.
