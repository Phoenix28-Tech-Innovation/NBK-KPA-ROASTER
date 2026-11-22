# Notification and recovery setup

The app delivers in-app notifications and optional email. For weekly roster
reminders, the open app checks the configured Africa/Nairobi day and time for
each verified, approved non-admin user, then shows a personalized modal and
plays a short chime when browser audio is available. If the app is closed at
that time, the reminder can appear when the user opens the app later that day.
This foreground reminder does not require Cloud Scheduler or billing; it
cannot notify users while the app is closed. Background browser notifications
require a separate Firebase Cloud Messaging web setup and a VAPID key.

## Deploy

1. Select the Firebase project that owns the `nbk-roter` web app:

   ```powershell
   firebase use nbk-roter
   ```

2. Install the Cloud Functions dependencies and deploy Firestore rules and
   Functions:

   ```powershell
   npm --prefix functions ci
   firebase deploy --only firestore:rules,functions --project nbk-roter
   ```

3. Enable billing for the Firebase project. Cloud Scheduler and second
   generation Cloud Functions require a billing-enabled project.

The scheduled backup function, if deployed, runs Sundays at 02:00
Africa/Nairobi time and retains the 12 latest snapshots in
`scheduledRosterBackups`. The weekly roster reminder is configurable in
Account management and defaults to Sundays at 14:00 Africa/Nairobi time.
Reminder times can be set to any hour and minute. The admin-only Published
weeks view remains the user-facing restore action for previously published
rosters.

## Configure email delivery

Install the Firebase Trigger Email extension and configure its SMTP provider.
The functions enqueue email documents in the extension's `mail` collection.
Email notifications are disabled by default; the admin can enable them and set
recipient addresses in Account management. In-app notifications are enabled by
default.

## Notification collections

- `notificationSettings/admin`: private event/channel choices and administrator
  email recipients.
- `userNotifications/{uid}/items/{notificationId}`: user-visible inbox items.
- `rosterPublishes/{publishId}`: admin-created publish events used to notify
  approved users.
- `rosterReminderRuns/{yyyy-mm-dd}`: server-written deduplication records for
  weekly roster reminders.
- `scheduledRosterBackups/{yyyy-mm-dd}`: server-written weekly snapshots. These
  records are readable only by the roster admin.

Do not grant public access to these collections or put administrator email
recipients in `systemSettings/current`, which is readable by signed-in users.
