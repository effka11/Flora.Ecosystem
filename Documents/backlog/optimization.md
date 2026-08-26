# optimization — perf на будущее

Не [`Documents/known/`](../known/README.md): это не открытая дыра и не допущение продукта. Задачи ниже — следующие проходы после уже смерженного среза. Новый проход начинается с замера на устройстве (release-like, без Metro), не с угадывания по dev-логам. Методика Android: [`Apps/Mobile/AGENTS.md`](../../Apps/Mobile/AGENTS.md), [`Apps/Mobile/docs/android-swipe-performance.md`](../../Apps/Mobile/docs/android-swipe-performance.md).

Статусы: `отложено` · `в работе` · `снято`.

---

## Mobile / Messages

| ID | Суть | Зачем / рычаги | Источник | Статус |
| --- | --- | --- | --- | --- |
| `mobile-chat-open-close-warm` | Следующий проход открытия, закрытия и прогрева чатов на Android после среза «тихий push + таб-бар на возврате» | Срез уже даёт заезд/выезд на `chatPushProgress`, окно первого кадра, press-in prefetch, decrypt/measure warm, persist замеров, clip таб-бара. Дальше не раздувать ту же ветку. Имеет смысл только по трассе (`dumpsys gfxinfo` / atrace). Кандидаты, не чеклист: (1) держать доклейку FlashList после reveal до конца слайда 450 ms; (2) цена tap→первый кадр движения — дерево навигатора, не ещё один LRU; (3) гейт reveal по замерам текста не снимать вслепую (вернёт прыжок пузырей); (4) `MaskedView` software на таб-баре во всех вкладках — только если просели переключения feed/music; (5) холодные треды ниже топа и медиа на первом кадре — политика prefetch/FRC, не путь `router.push`. Не рычаги: больше LRU, `messagesKey`, длина анимации, нативный stack вместо Reanimated | `Apps/Mobile` (`chatPushTransition`, `chatThreadsPrefetch`, `chatOpenLayoutWarm`, `ChatPushTabBar`); PR открытия/возврата чата | отложено |

Не трогать в этом пункте: отложенный mount FlashList, press-in first page, persist замеров, hold волн на exit, `transparentModal` / `beforeRemove` — это уже текущий контракт открытия, не backlog.
