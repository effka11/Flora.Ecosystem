# CODECS-IMAGE — Flora photo pipeline (FRC-I)

**Status:** Released  
**Version:** 1.0  
**Date:** 2026-07-16

Нормативный playbook для фото в Flora.Social поверх замороженного FRC-I v7
([`FRC-I.md`](./FRC-I.md) §12). Политика семейства — [`CODECS.md`](./CODECS.md).

---

## Ownership

| Поверхность | Owner module | Storage |
| --- | --- | --- |
| Post images | `flora-content` | `flora_core.post_images` |
| Community avatars | `flora-content` | `flora_core.community_avatars` |
| Video posters | `flora-content` | `flora_core.post_videos.poster_*` |
| User avatars | `flora-users` | `flora_core.user_avatars` |
| Message images | `flora-messaging` | opaque `user_message_image_assets` |

Users — единственный reader своей avatar-таблицы; Content получает blob через
read-only порт `UserAvatarMedia` (`flora-users-contracts`).

---

## Public contour

1. Upload accept: `image/jpeg`, `image/png`, `image/webp`.
2. Ingest через `frc-i-integration::ingest_with_fallback` при
   `Media:FrcI:WriteDual=true` → MIME
   `application/vnd.flora.frc-i-image-set`.
3. GET `/api/auth/posts/images/{uuid}` и `/api/auth/avatar/{uuid}`:
   - parse image-set;
   - если `ServeEnabled` и `Accept` явно содержит `image/x-flora-frc-i` с `q>0`
     → FRI;
   - иначе WebP fallback;
   - legacy rows (`image/webp` / `image/jpeg` / `image/avif`) отдаются as-is;
   - `Vary: Accept`, `Cache-Control: public, max-age=31536000, immutable`.

### Config (`Backend/appsettings.json`)

```json
"Media": {
  "FrcI": {
    "WriteDual": true,
    "ServeEnabled": true,
    "BackfillEnabled": false
  }
}
```

Rollout: ship clients → dual-write + WebP default serve → enable FRI Accept →
optional `BackfillEnabled` для legacy rows. Messaging history не backfill-ится
(нет plaintext на сервере).

---

## E2E contour

1. Client готовит browser-native fallback и FRI v7.
2. Каждый вариант AES-GCM с отдельным key/nonce.
3. Оба UUID уходят в `imageAssetUuids`; FSCP block держит fallback в legacy
   полях и optional `frcVariant` для FRI.
4. Receiver предпочитает FRI; на любой ошибке — fallback. Старый клиент
   игнорирует `frcVariant`.

---

## Client adapters

| Platform | Package | Role |
| --- | --- | --- |
| Web | `@flora/frc-i` + Worker | decode FRI → PNG blob; encode for E2E |
| Mobile | `flora-frc-i` Expo module | native file encode/decode via `frc-i-mobile-ffi` |
| Shared | `@flora/client-core/frc-i` | re-export |

WASM artifact: `Apps/Web/public/frc/frc_i_wasm.wasm` (build via
`Apps/Web/scripts/build-frc-i-wasm.ts`).
