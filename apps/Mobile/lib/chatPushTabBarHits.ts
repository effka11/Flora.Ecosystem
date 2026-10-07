import { CHAT_PUSH_OFF_EDGE } from "./chatListEnterMount";

export type ChatPushTabBarPointerEvents = "none" | "box-none";

/**
 * Хиты нижнего дока. Пропуск только пока док закрыт: создание поста его
 * накрыло, или стиль маршрута просит `none` и чат ещё на экране
 * (`progress > CHAT_PUSH_OFF_EDGE`). За краем хост и стиль BottomTabBar
 * оба `box-none`: `none` на стиле панели хост сам не перекрывает.
 */
export function chatPushTabBarHits(args: {
  styleBlocksHits: boolean;
  chatProgress: number;
  composeCoversDock: boolean;
}): { host: ChatPushTabBarPointerEvents; tabBar: ChatPushTabBarPointerEvents } {
  const chatCoversDock = args.chatProgress > CHAT_PUSH_OFF_EDGE;
  const skip = args.composeCoversDock || (args.styleBlocksHits && chatCoversDock);
  const pointerEvents: ChatPushTabBarPointerEvents = skip ? "none" : "box-none";
  return { host: pointerEvents, tabBar: pointerEvents };
}
