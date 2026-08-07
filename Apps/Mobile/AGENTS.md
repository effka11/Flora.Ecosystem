# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v56.0.0/ before writing any code.

## Social push dismiss

Tray dismiss for aggregated social notifications uses `@flora/client-core` `isSocialTrayPushData` / tags:

- Canonical FCM tags: `like`, `repost`, `follow` (one slot per recipient + activity kind).
- Legacy tags still dismissed: `like:{postUuid}`, `repost:{postUuid}`.
- Helpers: `dismissSocialPushNotifications`, `dismissPresentedSocialPushNotifications` in `lib/pushNotifications.ts`.
