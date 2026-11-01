# Mobile notifications

## T3 Dulli on Android

Pair your own server, then enable **Settings → Notifications → Background phone notifications**.
This is off by default. Allow Android notification permission and, when offered, exempt Dulli
from battery optimization for more timely delivery with the screen off. Your phone must remain
connected to your tailnet and your server must be running. No Google Play services, Firebase,
T3 Connect, or third-party push server is needed.

Dulli keeps a background connection and shows a low-priority **Dulli connected** notification
with connection status. It alerts for pending approvals and questions (including Pi extension
dialogs) and finished turns. Tap an alert to open its thread. Alerts for the thread currently
visible in Dulli are suppressed; answering a request on another device clears its alert when
the server connection is available again. Reconnecting does not repeat alerts.

Turn the switch off to stop the service and remove its notifications. Android may still delay
or stop delivery in Doze or under manufacturer battery restrictions, even with the exemption.
Swiping away the app normally leaves the service running; force-stopping it in Android Settings
stops delivery until you reopen it. When enabled, it restarts after boot and unlock. While offline,
only the latest finished turn per thread can be recovered from the server's current state.

## T3 Code with T3 Connect

Sign in to T3 Connect, link your environments, and enable **Device Notifications** in **Settings → Notifications** to receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification to open its thread. Your environment must have agent activity publishing enabled.

Enable **Ongoing Agent Activity** on Android or **Live Activity Updates** on iOS to follow work without opening the app. Finished results remain visible for up to 15 minutes. You can dismiss an Android activity card without disabling alerts; turn off ongoing activity in Settings to stop future cards.

Ordinary alerts stay quiet while the mobile app is in the foreground. Ongoing activity continues to update. Viewing a thread on another device does not silence your phone's alerts.

Android notifications require Android 7.0 or newer and Google Play services. Android 16 and newer can promote ongoing activity to a Live Update, subject to system settings and device support. Other devices show a regular ongoing notification. Android 7's battery-saving modes can delay removal of expired cards.

Notification permission and Android notification channels are controlled in system Settings. Background delivery requires T3 Connect; a direct or Tailscale connection alone does not enable push notifications. The mobile app does not need to maintain a connection to your environment. Force-stopping the Android app in system Settings prevents push delivery until you open it again.
